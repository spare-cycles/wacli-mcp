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
 *
 * Env:
 *   WACLI_BIN, WACLI_STORE_DIR            wacli binary + store dir (shared with wacli-mcp)
 *   SYNC_HEARTBEAT_FILE                   default <store>/.sync-heartbeat
 *   SYNC_STALE_SEC      (default 360)     down/stale grace before alerting + healthcheck threshold
 *   SYNC_REALERT_SEC    (default 1800)    re-alert cadence while still down
 *   SYNC_LOCK_WAIT      (default 30s)     --lock-wait so the sync wins the store lock at startup
 *   SYNC_DOWNLOAD_MEDIA, SYNC_REFRESH_GROUPS   optional wacli sync flags (truthy)
 *   NTFY_BASE_URL, NTFY_TOPIC, NTFY_TOKEN  ntfy publish (JSON to the root URL, Bearer auth)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";

function numEnv(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
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
const NTFY_BASE_URL = process.env["NTFY_BASE_URL"] || "";
const NTFY_TOPIC = process.env["NTFY_TOPIC"] || "alerts";
const NTFY_TOKEN = process.env["NTFY_TOKEN"] || "";
const LOCK_WAIT = process.env["SYNC_LOCK_WAIT"] || "30s";
const STALE_SEC = numEnv("SYNC_STALE_SEC", 360);
const REALERT_SEC = numEnv("SYNC_REALERT_SEC", 1800);
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
let alerted = false; // a down-alert was sent for the current episode
let lastAlertAt = 0; // epoch seconds of the last down-alert
const startTime = now();

function writeHeartbeat(): void {
  try {
    writeFileSync(HEARTBEAT_FILE, String(now()));
  } catch (e) {
    log("heartbeat write failed:", errMsg(e));
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

function goUp(): void {
  const recovered = state === "DOWN" && alerted;
  state = "UP";
  downSince = null;
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
    log(`down (${reason})`);
  }
}

// ── wacli child + NDJSON event stream ────────────────────────────────────────
let child: ChildProcess | null = null;

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
    log(`wacli child exited code=${code ?? "null"} signal=${signal ?? "none"}`);
    void ntfy(
      "🚨 wacli-sync process exited",
      `wacli sync exited (code=${code ?? "null"} signal=${signal ?? "none"}). The container will restart.`,
      5,
      ["rotating_light"],
    );
    setTimeout(() => process.exit(1), 1500); // let the alert flush; restart policy restarts us
  });
}

// ── Timer: refresh heartbeat while UP; drive down-alerts otherwise ────────────
function tick(): void {
  const t = now();
  if (state === "UP") {
    writeHeartbeat();
    return;
  }
  // Started but never connected within the grace → treat as a down-episode from start.
  if (state === "STARTING" && t - startTime >= STALE_SEC) {
    state = "DOWN";
    downSince = startTime;
  }
  if (downSince === null || t - downSince < STALE_SEC) return; // not down long enough (or STARTING)
  if (alerted && t - lastAlertAt < REALERT_SEC) return; // already alerted recently
  alerted = true;
  lastAlertAt = t;
  const mins = Math.floor((t - downSince) / 60);
  void ntfy(
    "🚨 wacli-sync DOWN",
    `WhatsApp sync disconnected for ~${mins} min (since ${new Date(downSince * 1000).toISOString()}). The store is going stale.`,
    5,
    ["rotating_light"],
  );
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
function shutdown(sig: string): void {
  log("received", sig, "— shutting down");
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
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

// Startup self-test: verifies the ntfy token + egress work BEFORE the first real incident.
void ntfy("wacli-sync started", `Supervisor up at ${new Date().toISOString()}; connecting…`, 2, ["information_source"]);
startChild();
setInterval(tick, TICK_MS);
