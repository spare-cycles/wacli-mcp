/**
 * What is and is not exercised here.
 *
 * **The debounce is tested through injected time, never by waiting.** `schedule` is a seam whose
 * fake records what was asked for and fires it on demand, so "the grace has not elapsed" and "the
 * cadence came round again" are assertions about a scheduled callback rather than about the wall
 * clock. Nothing in this file sleeps.
 *
 * **The unref requirement is tested behaviourally.** `process.getActiveResourcesInfo()` lists only
 * the timers that are keeping the event loop alive, so a ref'd timer would change the count and an
 * unref'd one does not. That is the closest a test can get to the real property — "this never holds
 * the process open" — without monkeypatching `setTimeout`.
 *
 * **The network is a stub, and that is the whole point.** ntfy is one POST; what matters is that the
 * body carries the right title and priority, that the token travels in a header and appears in no
 * log line, and that a failing publish is a warn rather than an exception climbing back into the
 * connection's state-change callback.
 */

import { strict as assert } from "node:assert";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import type { Logger } from "pino";
import { makeAlerter, type Schedule } from "./alerts.js";
import { loadConfig, type Config, type NtfyConfig } from "./config.js";

const GRACE_MS = 60_000;
const REALERT_MS = 300_000;
const NTFY: NtfyConfig = { baseUrl: "https://ntfy.example/", topic: "alerts", token: "ntfy-secret" };

function configWith(ntfy: NtfyConfig | undefined): Config {
  return { ...loadConfig({}), ntfy };
}

type Entry = { level: string; obj: Record<string, unknown>; msg: string };

/** A logger that records instead of printing, so a test can assert what was reported and with what. */
function captureLogger(): { logger: Logger; entries: Entry[] } {
  const entries: Entry[] = [];
  // pino takes either `(msg)` or `(obj, msg)`; both spellings have to land in the same shape here.
  const record =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      if (typeof obj === "string") entries.push({ level, obj: {}, msg: obj });
      else entries.push({ level, obj: (obj ?? {}) as Record<string, unknown>, msg: msg ?? "" });
    };
  const logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  } as unknown as Logger;
  return { logger, entries };
}

type Publish = { url: string; headers: Headers; body: Record<string, unknown> };

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A `fetch` that never touches the network, recording every publish it was asked to make. */
function stubFetch(handler: () => Promise<Response> = () => Promise.resolve(new Response("", { status: 200 }))): {
  impl: typeof fetch;
  calls: Publish[];
} {
  const calls: Publish[] = [];
  const impl: typeof fetch = (input, init) => {
    const raw = init?.body;
    calls.push({
      url: urlOf(input),
      headers: new Headers(init?.headers),
      body: typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    return handler();
  };
  return { impl, calls };
}

type Timer = { fn: () => void; ms: number };

/** The timer seam: records what was scheduled and fires it on demand. No test waits for real time. */
function fakeClock(): { schedule: Schedule; pending: Timer[]; delays: () => number[]; fire: () => void } {
  const pending: Timer[] = [];
  const schedule: Schedule = (fn, ms) => {
    const timer: Timer = { fn, ms };
    pending.push(timer);
    return () => {
      const i = pending.indexOf(timer);
      if (i >= 0) pending.splice(i, 1);
    };
  };
  function fire(): void {
    for (const timer of pending.splice(0, pending.length)) timer.fn();
  }
  return { schedule, pending, delays: () => pending.map((t) => t.ms), fire };
}

/** `null` means "ntfy unconfigured" — an explicit `undefined` would silently take the default. */
function alerterUnder(
  clock: ReturnType<typeof fakeClock>,
  fetchImpl: typeof fetch,
  logger: Logger,
  ntfy: NtfyConfig | null = NTFY,
): ReturnType<typeof makeAlerter> {
  return makeAlerter({
    config: configWith(ntfy ?? undefined),
    logger,
    fetchImpl,
    schedule: clock.schedule,
    graceMs: GRACE_MS,
    realertMs: REALERT_MS,
  });
}

function titleOf(call: Publish | undefined): string {
  return typeof call?.body["title"] === "string" ? call.body["title"] : "";
}

function messageOf(call: Publish | undefined): string {
  return typeof call?.body["message"] === "string" ? call.body["message"] : "";
}

function activeTimeouts(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

// --- the debounce -------------------------------------------------------------------------------

void test("no alert before the grace period elapses", () => {
  const clock = fakeClock();
  const { impl, calls } = stubFetch();
  const { logger } = captureLogger();
  const alerter = alerterUnder(clock, impl, logger);

  alerter.onState("disconnected");

  assert.equal(calls.length, 0, "a single disconnect must not publish anything on its own");
  assert.deepEqual(clock.delays(), [GRACE_MS], "it must arm exactly one timer, for the grace period");

  alerter.stop();
  assert.deepEqual(clock.delays(), [], "stop() cancels the pending grace");

  alerter.onState("disconnected");
  assert.deepEqual(clock.delays(), [GRACE_MS], "and forgets the episode, so a restarted alerter still alerts");
});

void test("a down alert fires once, then re-alerts on the configured cadence", () => {
  const clock = fakeClock();
  const { impl, calls } = stubFetch();
  const { logger } = captureLogger();
  const alerter = alerterUnder(clock, impl, logger);

  alerter.onState("disconnected");
  alerter.onState("connecting");
  alerter.onState("disconnected");
  assert.deepEqual(clock.delays(), [GRACE_MS], "reconnect churn must not restart or duplicate the grace");
  assert.equal(calls.length, 0);

  clock.fire();
  assert.equal(calls.length, 1, "the grace expiring publishes exactly one down alert");
  assert.match(titleOf(calls[0]), /disconnected/i);
  assert.equal(calls[0]?.body["priority"], 5);
  assert.deepEqual(clock.delays(), [REALERT_MS], "and arms the re-alert cadence");

  alerter.onState("disconnected");
  alerter.onState("connecting");
  assert.equal(calls.length, 1, "further down states while already alerting publish nothing");
  assert.deepEqual(clock.delays(), [REALERT_MS]);

  clock.fire();
  assert.equal(calls.length, 2, "the cadence re-publishes");
  assert.match(titleOf(calls[1]), /disconnected/i);
  assert.deepEqual(clock.delays(), [REALERT_MS], "and keeps re-arming");

  alerter.stop();
});

void test("recovery sends exactly one notice and resets the state", () => {
  const clock = fakeClock();
  const { impl, calls } = stubFetch();
  const { logger } = captureLogger();
  const alerter = alerterUnder(clock, impl, logger);

  alerter.onState("disconnected");
  clock.fire();
  assert.equal(calls.length, 1);

  alerter.onState("connected");
  assert.equal(calls.length, 2, "recovering after an alert publishes a notice");
  assert.match(titleOf(calls[1]), /reconnected/i);
  assert.deepEqual(clock.delays(), [], "and disarms the cadence");

  alerter.onState("connected");
  assert.equal(calls.length, 2, "a repeated connected state is not a second recovery");

  alerter.onState("disconnected");
  assert.deepEqual(clock.delays(), [GRACE_MS], "the next episode starts from a clean grace");
  clock.fire();
  assert.equal(calls.length, 3, "and alerts again");

  alerter.stop();
});

void test("a recovery inside the grace period is silent", () => {
  const clock = fakeClock();
  const { impl, calls } = stubFetch();
  const { logger } = captureLogger();
  const alerter = alerterUnder(clock, impl, logger);

  alerter.onState("disconnected");
  alerter.onState("connected");

  assert.equal(calls.length, 0, "nothing was ever alerted, so there is nothing to recover from");
  assert.deepEqual(clock.delays(), [], "and the grace is cancelled");
});

void test("logged_out alerts immediately, without waiting for the grace", () => {
  const clock = fakeClock();
  const { impl, calls } = stubFetch();
  const { logger } = captureLogger();
  const alerter = alerterUnder(clock, impl, logger);

  alerter.onState("logged_out");

  assert.equal(calls.length, 1, "a logout needs a human now, not after a grace period");
  assert.match(titleOf(calls[0]), /logged out/i);
  assert.equal(calls[0]?.body["priority"], 5);
  assert.deepEqual(clock.delays(), [REALERT_MS], "and it repeats on the cadence until someone acts");

  alerter.onState("logged_out");
  assert.equal(calls.length, 1, "a repeated logged_out state does not re-publish immediately");

  clock.fire();
  assert.equal(calls.length, 2);

  alerter.onState("connected");
  assert.equal(calls.length, 3, "re-pairing recovers the episode");
  assert.match(titleOf(calls[2]), /reconnected/i);

  alerter.stop();
});

void test("a pairing episode is paged as unpaired, not as a disconnection", () => {
  const clock = fakeClock();
  const { impl, calls } = stubFetch();
  const { logger } = captureLogger();
  const alerter = alerterUnder(clock, impl, logger);

  // The first-boot sequence, exactly as `whatsapp/connection.ts` produces it: `createSocket` sets
  // `connecting`, then the first QR sets `pairing`. So the state that *opens* the episode is the
  // uninformative one, and a notice built from it alone would say "disconnected" about a server
  // that has simply never been linked.
  alerter.onState("connecting");
  alerter.onState("pairing");
  assert.deepEqual(clock.delays(), [GRACE_MS], "still one episode, still one grace timer");

  clock.fire();

  assert.equal(calls.length, 1);
  assert.match(titleOf(calls[0]), /pair/i);
  assert.doesNotMatch(titleOf(calls[0]), /disconnected/i);
  assert.match(messageOf(calls[0]), /WHATSAPP_PHONE_NUMBER/, "and it names what unblocks it");
  assert.match(messageOf(calls[0]), /pairing code/i);

  // A real disconnection still reads as one — the two notices are not interchangeable.
  const other = fakeClock();
  const second = stubFetch();
  const { logger: otherLogger } = captureLogger();
  const dropped = alerterUnder(other, second.impl, otherLogger);
  dropped.onState("disconnected");
  other.fire();

  assert.match(titleOf(second.calls[0]), /disconnected/i);
  assert.notEqual(titleOf(second.calls[0]), titleOf(calls[0]));
  assert.doesNotMatch(messageOf(second.calls[0]), /WHATSAPP_PHONE_NUMBER/);

  alerter.stop();
  dropped.stop();
});

// --- configuration and secrets ------------------------------------------------------------------

void test("alerts are a no-op when ntfy is unconfigured", async () => {
  const clock = fakeClock();
  const { impl, calls } = stubFetch();
  const { logger, entries } = captureLogger();
  const alerter = alerterUnder(clock, impl, logger, null);

  alerter.onState("disconnected");
  clock.fire();
  alerter.onState("logged_out");
  alerter.onState("connected");
  await alerter.selfTest();
  await tick();

  assert.equal(calls.length, 0, "no ntfy config means no request, ever");
  assert.deepEqual(clock.delays(), [], "and no timer is armed at all");
  assert.deepEqual(
    entries.filter((e) => e.level === "warn" || e.level === "error"),
    [],
    "an unconfigured alerter is a deliberate state, not a fault to shout about",
  );

  alerter.stop();
});

void test("the ntfy token is sent as a Bearer header and never logged", async () => {
  const clock = fakeClock();
  const { impl, calls } = stubFetch();
  const { logger, entries } = captureLogger();
  const alerter = alerterUnder(clock, impl, logger);

  alerter.onState("logged_out");
  await alerter.selfTest();
  await tick();

  const first = calls[0];
  assert.ok(first);
  assert.equal(first.url, NTFY.baseUrl);
  assert.equal(first.headers.get("authorization"), `Bearer ${NTFY.token}`);
  assert.equal(first.headers.get("content-type"), "application/json");
  assert.equal(first.body["topic"], NTFY.topic);
  assert.doesNotMatch(JSON.stringify(entries), /ntfy-secret/, "Global Constraint 8: no secret in any log line");

  const bare = fakeClock();
  const second = stubFetch();
  const { logger: bareLogger } = captureLogger();
  const noToken = alerterUnder(bare, second.impl, bareLogger, { ...NTFY, token: "" });
  noToken.onState("logged_out");
  assert.equal(second.calls[0]?.headers.get("authorization"), null, "an empty token sends no header at all");

  alerter.stop();
  noToken.stop();
});

void test("a publish failure is logged at warn and never propagates", async () => {
  const clock = fakeClock();
  const rejecting = stubFetch(() => Promise.reject(new Error("ntfy unreachable")));
  const { logger, entries } = captureLogger();
  const alerter = alerterUnder(clock, rejecting.impl, logger);

  assert.doesNotThrow(() => {
    alerter.onState("logged_out");
  });
  await tick();

  const warned = entries.filter((e) => e.level === "warn");
  assert.equal(warned.length, 1, "a failed publish is a warning, not a crash");
  assert.doesNotMatch(JSON.stringify(warned), /ntfy-secret/);

  const failing = stubFetch(() => Promise.resolve(new Response("nope", { status: 503 })));
  const { logger: statusLogger, entries: statusEntries } = captureLogger();
  const onStatus = alerterUnder(fakeClock(), failing.impl, statusLogger);
  onStatus.onState("logged_out");
  await tick();
  assert.equal(statusEntries.filter((e) => e.level === "warn").length, 1, "a non-2xx response is a warning too");
  assert.match(JSON.stringify(statusEntries), /503/);

  alerter.stop();
  onStatus.stop();
});

void test("selfTest publishes a startup notice and never rejects", async () => {
  const clock = fakeClock();
  const { impl, calls } = stubFetch();
  const { logger } = captureLogger();
  const alerter = alerterUnder(clock, impl, logger);

  await alerter.selfTest();

  assert.equal(calls.length, 1, "the startup notice is what proves the token and the egress work");
  assert.equal(calls[0]?.body["topic"], NTFY.topic);
  assert.deepEqual(clock.delays(), [], "and it arms nothing");

  const rejecting = stubFetch(() => Promise.reject(new Error("ntfy unreachable")));
  const { logger: failLogger } = captureLogger();
  const failing = alerterUnder(fakeClock(), rejecting.impl, failLogger);
  await assert.doesNotReject(() => failing.selfTest());

  alerter.stop();
  failing.stop();
});

// --- the real timer -----------------------------------------------------------------------------

void test("the default schedule never holds the process open", (t) => {
  const { impl } = stubFetch();
  const { logger } = captureLogger();
  const alerter = makeAlerter({ config: configWith(NTFY), logger, fetchImpl: impl });
  // Registered before the assertion, not after it: this is the one test that arms a *real* six-minute
  // timer, so a failure here must still cancel it rather than hold the runner open until it fires.
  t.after(() => {
    alerter.stop();
  });

  const before = activeTimeouts();
  alerter.onState("disconnected");

  assert.equal(activeTimeouts(), before, "the grace timer must be unref'd, so it keeps nothing alive");
});
