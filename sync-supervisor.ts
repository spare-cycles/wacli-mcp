#!/usr/bin/env node
/**
 * wacli-sync supervisor — keeps the wacli store continuously up to date and alerts on breakage.
 *
 * Runs `wacli sync --follow --events` (the only mode that holds the WhatsApp connection AND serves
 * the send-delegate socket, so the wacli-mcp server's reads stay lockless and its sends delegate),
 * consumes wacli's NDJSON lifecycle events on the child's stderr, and turns connection state into:
 *   (a) a heartbeat file (integer Unix SECONDS) the Docker healthcheck reads, refreshed on a timer
 *       ONLY while connected — so a stale heartbeat unambiguously means "not connected", and
 *   (b) debounced ntfy alerts (down after a grace, re-alert periodically, recovery notice).
 *
 * State machine: STARTING → UP ⇄ DOWN. Guarantee: alert within ~SYNC_STALE_SEC if the sync
 * connection is down or never establishes (connection-liveness, not per-message delivery latency).
 * Self-heal: if DOWN persists past SYNC_HARD_RESTART_SEC, the supervisor KILLS the wedged child and
 * exits so the container's restart policy brings up a FRESH connection — recovering a wedged-but-alive
 * wacli child that the reconnect loop can't fix and that the Docker healthcheck would otherwise only
 * flag, never restart. Rapid self-restarts back off (and pause after GIVE_UP_AFTER) so a logged-out /
 * banned account can't thrash or spam alerts; a sustained-healthy period clears the counter.
 *
 * Heartbeat contract — shared with wacli-mcp's server.ts AND the compose healthcheck, keep all three
 * in agreement: the file `<store>/.sync-heartbeat` holds an integer Unix-SECONDS timestamp, written
 * atomically, refreshed only while connected; "fresh" means age < SYNC_STALE_SEC.
 *
 * Env:
 *   WACLI_BIN, WACLI_STORE_DIR            wacli binary + store dir (shared with wacli-mcp)
 *   SYNC_HEARTBEAT_FILE                   default <store>/.sync-heartbeat
 *   SYNC_STALE_SEC      (default 360)     down/stale grace before alerting + healthcheck threshold
 *   SYNC_REALERT_SEC    (default 1800)    re-alert cadence while still down
 *   SYNC_HARD_RESTART_SEC (default 900)   kill+exit (→ container restart) after this long continuously DOWN; 0 disables
 *   SYNC_LOCK_WAIT      (default 30s)     --lock-wait so the sync wins the store lock at startup
 *   SYNC_DOWNLOAD_MEDIA, SYNC_REFRESH_GROUPS   optional wacli sync flags (truthy)
 *   NTFY_BASE_URL, NTFY_TOPIC, NTFY_TOKEN  ntfy publish (JSON to the root URL, Bearer auth)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** Parse a non-negative-integer env var. Empty/unset/invalid/negative → default. `0` → default
 *  unless `allowZero` (then 0 is a real value, e.g. "disabled"). */
function numEnv(name: string, def: number, opts: { allowZero?: boolean } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return def;
  if (n === 0) return opts.allowZero ? 0 : def;
  return n;
}
function truthy(v: string | undefined): boolean {
  return v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const WACLI_BIN = process.env["WACLI_BIN"] || "wacli";
const STORE_DIR = process.env["WACLI_STORE_DIR"] || "/data/wacli";
const HEARTBEAT_FILE = process.env["SYNC_HEARTBEAT_FILE"] || `${STORE_DIR}/.sync-heartbeat`;
const RESTART_STATE_FILE = `${STORE_DIR}/.sync-restart-state`;
const NTFY_BASE_URL = process.env["NTFY_BASE_URL"] || "";
const NTFY_TOPIC = process.env["NTFY_TOPIC"] || "alerts";
const NTFY_TOKEN = process.env["NTFY_TOKEN"] || "";
const LOCK_WAIT = process.env["SYNC_LOCK_WAIT"] || "30s";
const STALE_SEC = numEnv("SYNC_STALE_SEC", 360);
const REALERT_SEC = numEnv("SYNC_REALERT_SEC", 1800);
// Hard-restart ceiling: kill the child and exit (→ `restart: unless-stopped`) after being continuously
// DOWN this long, so a wedged-but-alive wacli (process up, never re-emits `connected`) self-heals via a
// fresh start instead of only tripping the healthcheck. 0 disables (alert-only). The valve cannot fire
// before the DOWN grace (SYNC_STALE_SEC), so a smaller value is effectively raised to it (warned at boot).
const HARD_RESTART_SEC = numEnv("SYNC_HARD_RESTART_SEC", 900, { allowZero: true });
// Rapid self-restart guard (only relevant when the valve is enabled): consecutive self-restarts closer
// together than RAPID_WINDOW_SEC are a thrash loop — back off (growing, capped) before reconnecting,
// then pause auto-restart after GIVE_UP_AFTER so a logged-out/banned account can't loop or spam alerts.
const RAPID_WINDOW_SEC = Math.max(STALE_SEC + HARD_RESTART_SEC, 1) * 2;
const BACKOFF_STEP_SEC = 60;
const BACKOFF_MAX_SEC = 900;
const GIVE_UP_AFTER = 10;
// Best-effort window to let an exit alert flush before exiting anyway (ntfy can be slow precisely when
// the network — the usual reason we're restarting — is the problem), so we never block teardown for long.
const EXIT_FLUSH_MAX_MS = 8000;
// Refresh the heartbeat well within the stale window so a healthy connection never looks stale.
const TICK_MS = Math.min(30, STALE_SEC / 4) * 1000;

const now = (): number => Math.floor(Date.now() / 1000);
const log = (...a: unknown[]): void => {
  console.error("[wacli-sync]", ...a);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── State machine ────────────────────────────────────────────────────────────
type State = "STARTING" | "UP" | "DOWN";
let state: State = "STARTING";
let downSince: number | null = null; // epoch seconds the current down-episode began
let upSince: number | null = null; // epoch seconds the current up-episode began (for thrash-counter reset)
let alerted = false; // a down-alert was sent for the current episode
let lastAlertAt = 0; // epoch seconds of the last down-alert
let stopping = false; // a deliberate exit (shutdown or self-restart) is underway — guards re-entry + the child-exit handler
let valveDisabled = false; // self-restart paused for this boot after too many rapid restarts
let priorRestarts = 0; // consecutive rapid self-restarts observed before this boot
const startTime = now();

/** Write the heartbeat atomically (temp + rename) so a concurrent reader never sees a torn/empty file. */
function writeHeartbeat(): void {
  try {
    const tmp = `${HEARTBEAT_FILE}.tmp`;
    writeFileSync(tmp, String(now()));
    renameSync(tmp, HEARTBEAT_FILE);
  } catch (e) {
    log("heartbeat write failed:", errMsg(e));
  }
}

/** Read the persisted rapid-restart count, resetting it if the last self-restart was long enough ago
 *  that this boot isn't part of a thrash loop. */
function loadPriorRestarts(): number {
  try {
    const parts = readFileSync(RESTART_STATE_FILE, "utf8").trim().split(/\s+/);
    const count = Number(parts[0]);
    const last = Number(parts[1]);
    if (!Number.isFinite(count) || !Number.isFinite(last)) return 0;
    return now() - last <= RAPID_WINDOW_SEC ? Math.max(0, Math.floor(count)) : 0;
  } catch {
    return 0; // no state file yet, or unreadable → treat as a fresh, non-thrashing boot
  }
}
/** Persist the rapid-restart count + the current time, atomically. */
function saveRestartCount(count: number): void {
  try {
    const tmp = `${RESTART_STATE_FILE}.tmp`;
    writeFileSync(tmp, `${count} ${now()}`);
    renameSync(tmp, RESTART_STATE_FILE);
  } catch (e) {
    log("restart-state write failed:", errMsg(e));
  }
}

/** POST a notification to ntfy. Never throws into the caller; bounded by a timeout; retried. */
async function ntfy(title: string, message: string, priority: number, tags: string[]): Promise<void> {
  if (!NTFY_BASE_URL || !NTFY_TOKEN) {
    log(`ntfy not configured; would send: ${title} — ${message}`);
    return;
  }
  const body = JSON.stringify({ topic: NTFY_TOPIC, title, message, priority, tags });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
    }, 10_000);
    try {
      const res = await fetch(NTFY_BASE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${NTFY_TOKEN}`, "Content-Type": "application/json" },
        body,
        signal: ctrl.signal,
      });
      if (res.ok) return;
      log(`ntfy POST HTTP ${res.status} (attempt ${attempt}/3)`);
    } catch (e) {
      log(`ntfy POST failed (attempt ${attempt}/3): ${errMsg(e)}`);
    } finally {
      clearTimeout(timer);
    }
    await sleep(attempt * 2000);
  }
  log(`ntfy POST gave up after retries: ${title}`);
}

/** Fire a best-effort alert, then exit — giving the alert a bounded chance to flush first so the
 *  notification isn't cut off, without ever blocking teardown longer than EXIT_FLUSH_MAX_MS. */
async function alertThenExit(title: string, message: string, code: number): Promise<void> {
  stopping = true;
  await Promise.race([ntfy(title, message, 5, ["rotating_light"]), sleep(EXIT_FLUSH_MAX_MS)]);
  process.exit(code);
}

function goUp(): void {
  const recovered = state === "DOWN" && alerted;
  state = "UP";
  downSince = null;
  upSince = now();
  alerted = false;
  writeHeartbeat();
  if (recovered) {
    void ntfy("✅ wacli-sync recovered", `WhatsApp sync reconnected at ${new Date().toISOString()}.`, 3, [
      "white_check_mark",
    ]);
  }
}

function goDown(reason: string): void {
  if (state !== "DOWN") {
    state = "DOWN";
    downSince = now();
    upSince = null;
    log(`down (${reason})`);
  }
}

// ── wacli child + NDJSON event stream ────────────────────────────────────────
let child: ChildProcess | null = null;

/** Terminate the wacli child so it releases the store lock + WhatsApp socket (a bare process.exit
 *  would orphan it). SIGTERM lets wacli close cleanly; container teardown SIGKILLs if it ignores it. */
function killChild(): void {
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/** Extract the lifecycle event name from a stderr line, or undefined for non-event/non-JSON lines. */
function eventName(line: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    log("wacli:", line); // human-readable / non-event stderr — surface, don't act
    return undefined;
  }
  if (typeof parsed === "object" && parsed !== null && "event" in parsed) {
    const ev = (parsed as { event?: unknown }).event;
    if (typeof ev === "string") return ev;
  }
  return undefined;
}

function handleLine(line: string): void {
  if (!line) return;
  const ev = eventName(line);
  if (ev === "connected") {
    log("event: connected");
    goUp();
  } else if (ev === "disconnected" || ev === "stream_replaced" || ev === "reconnecting") {
    goDown(ev);
  }
}

function startChild(): void {
  const args = ["--store", STORE_DIR, "--lock-wait", LOCK_WAIT, "sync", "--follow", "--events", "--max-reconnect", "0"];
  if (truthy(process.env["SYNC_DOWNLOAD_MEDIA"])) args.push("--download-media");
  if (truthy(process.env["SYNC_REFRESH_GROUPS"])) args.push("--refresh-groups");
  log("spawning:", WACLI_BIN, args.join(" "));
  const cp = spawn(WACLI_BIN, args, { stdio: ["ignore", "inherit", "pipe"] });
  child = cp;
  cp.stderr.setEncoding("utf8");
  let buf = "";
  cp.stderr.on("data", (d: string) => {
    buf += d;
    let i = buf.indexOf("\n");
    while (i >= 0) {
      handleLine(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  });
  cp.on("error", (e) => {
    log("failed to spawn wacli:", e.message);
  });
  cp.on("exit", (code, signal) => {
    // A deliberate stop/self-restart already kills the child and schedules its own exit + alert; don't
    // double-fire (this also silences the spurious "process exited" alert on a graceful container stop).
    if (stopping) {
      log(`wacli child exited during shutdown/restart (code=${code ?? "null"} signal=${signal ?? "none"})`);
      return;
    }
    log(`wacli child exited code=${code ?? "null"} signal=${signal ?? "none"}`);
    void alertThenExit(
      "🚨 wacli-sync process exited",
      `wacli sync exited (code=${code ?? "null"} signal=${signal ?? "none"}). The container will restart.`,
      1,
    );
  });
}

// ── Timer: refresh heartbeat while UP; drive down-alerts + the self-restart valve otherwise ──────────
function tick(): void {
  if (stopping) return; // teardown underway — do nothing (no heartbeat, no duplicate alerts)
  const t = now();
  if (state === "UP") {
    writeHeartbeat();
    // Sustained-healthy → clear the thrash counter so isolated, well-recovered drops don't accumulate.
    if (priorRestarts > 0 && upSince !== null && t - upSince >= RAPID_WINDOW_SEC) {
      priorRestarts = 0;
      saveRestartCount(0);
      log("sync healthy for a sustained period — cleared the rapid-restart counter");
    }
    return;
  }
  // Started but never connected within the grace → treat as a down-episode from start.
  if (state === "STARTING" && t - startTime >= STALE_SEC) {
    state = "DOWN";
    downSince = startTime;
  }
  if (downSince === null || t - downSince < STALE_SEC) return; // not down long enough (or STARTING)
  const downFor = t - downSince;
  // (1) Down-alert FIRST (debounced), so the valve below can never suppress it.
  if (!alerted || t - lastAlertAt >= REALERT_SEC) {
    alerted = true;
    lastAlertAt = t;
    const mins = Math.floor(downFor / 60);
    void ntfy(
      "🚨 wacli-sync DOWN",
      `WhatsApp sync disconnected for ~${mins} min (since ${new Date(downSince * 1000).toISOString()}). The store is going stale.`,
      5,
      ["rotating_light"],
    );
  }
  // (2) Hard-restart valve: kill the wedged child + exit so the restart policy reconnects fresh.
  if (HARD_RESTART_SEC > 0 && !valveDisabled && downFor >= HARD_RESTART_SEC) {
    stopping = true; // set before killChild so the child-exit handler doesn't double-fire
    const mins = Math.floor(downFor / 60);
    log(`down ~${mins} min ≥ hard-restart ceiling ${HARD_RESTART_SEC}s — killing child and restarting`);
    saveRestartCount(priorRestarts + 1); // the next boot sees this as a (possibly rapid) self-restart
    killChild();
    void alertThenExit(
      "🚨 wacli-sync self-restart",
      `WhatsApp sync down ~${mins} min (≥ ${HARD_RESTART_SEC}s); restarting with a fresh connection.`,
      1,
    );
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
function shutdown(sig: string): void {
  if (stopping) return;
  stopping = true;
  log("received", sig, "— shutting down");
  killChild();
  setTimeout(() => process.exit(0), 1000);
}
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
process.on("uncaughtException", (e) => {
  log("uncaughtException:", e);
  process.exit(1); // exit → restart policy restarts us
});
process.on("unhandledRejection", (e) => {
  log("unhandledRejection:", e);
});

/** Startup: self-test the ntfy path, apply rapid-restart backoff / give-up, then run the child + timer. */
async function boot(): Promise<void> {
  // Startup self-test: verifies the ntfy token + egress work BEFORE the first real incident.
  void ntfy("wacli-sync started", `Supervisor up at ${new Date().toISOString()}; connecting…`, 2, [
    "information_source",
  ]);

  if (HARD_RESTART_SEC > 0) {
    if (HARD_RESTART_SEC < STALE_SEC) {
      log(
        `SYNC_HARD_RESTART_SEC=${HARD_RESTART_SEC} < SYNC_STALE_SEC=${STALE_SEC}; the valve can't fire before the down-grace, so it is effectively ${STALE_SEC}s.`,
      );
    }
    priorRestarts = loadPriorRestarts();
    saveRestartCount(priorRestarts); // refresh `last` so a long-healthy run resets the counter next boot
    if (priorRestarts >= GIVE_UP_AFTER) {
      valveDisabled = true;
      void ntfy(
        "🚨 wacli-sync self-heal paused",
        `Self-restarted ${priorRestarts}× without recovering; pausing auto-restart. Fix the WhatsApp link/login, then restart the container.`,
        5,
        ["rotating_light", "no_entry"],
      );
    } else if (priorRestarts > 0) {
      const backoff = Math.min(priorRestarts * BACKOFF_STEP_SEC, BACKOFF_MAX_SEC);
      log(`rapid restart #${priorRestarts}; backing off ${backoff}s before reconnecting`);
      await sleep(backoff * 1000);
    }
  }

  startChild();
  setInterval(tick, TICK_MS);
}

void boot();
