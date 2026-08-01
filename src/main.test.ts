/**
 * What is and is not exercised here.
 *
 * **`bootstrap()` is deliberately untested.** Its last line is `conn.start()`, which opens a real
 * WhatsApp websocket, and the only way to prevent that from a test is to add a socket-factory seam
 * to `bootstrap` that exists for no other reason. Everything it wires is already tested where it
 * lives — the repositories, the connection, ingest, the sender, the media pipeline, the tool server,
 * `startHttp` and `makeAlerter` all have their own suites — so a test here would assert that a list
 * of constructor calls happened in the order the file plainly shows.
 *
 * **The `ingest`/`conn` cycle is not tested either, and cannot usefully be.** The resolution is a
 * `let` and a closure that reads the connection when `selfId()` is called rather than when `ingest`
 * is built; observing it means observing `bootstrap`, which is the case above. What a test *can*
 * cover is that importing this module does not start anything — which is exactly what this file
 * does by existing: if the entrypoint guard were wrong, importing `main.ts` would run `bootstrap()`,
 * fail on `/data/wa`, and take the test process down with `process.exit(1)`.
 *
 * **`shutdown()` is tested, because it has a real failure mode.** It runs on the way out with things
 * already breaking, and the property that matters is that one broken step does not skip the ones
 * after it — above all the SQLite close, which is the only step whose omission leaves state behind.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Logger } from "pino";
import type { Alerter } from "./alerts.js";
import { openDb, type Db } from "./db/client.js";
import type { HttpHandle } from "./http.js";
import { shutdown, type ShutdownDeps } from "./main.js";
import type { WaConnection } from "./wa/connection.js";

const root = mkdtempSync(join(tmpdir(), "wa-main-"));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

type Entry = { level: string; obj: Record<string, unknown>; msg: string };

function captureLogger(): { logger: Logger; entries: Entry[] } {
  const entries: Entry[] = [];
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

type Rig = {
  deps: ShutdownDeps;
  order: string[];
  exits: number[];
  entries: Entry[];
  db: Db;
};

let seq = 0;

function rig(broken: { http?: boolean; conn?: boolean } = {}): Rig {
  const order: string[] = [];
  const exits: number[] = [];
  const { logger, entries } = captureLogger();
  seq += 1;
  const db = openDb(join(root, `shutdown-${seq}.db`));

  const http: HttpHandle = {
    port: 8080,
    close: () => {
      order.push("http");
      return broken.http === true ? Promise.reject(new Error("server would not close")) : Promise.resolve();
    },
  };
  const conn = {
    snapshot: () => ({
      state: "connected" as const,
      lastEventAt: 0,
      lastConnectedAt: null,
      attempts: 0,
      needsPairing: false,
      selfId: null,
    }),
    requireSocket: () => {
      throw new Error("the shutdown path never touches the socket");
    },
    start: () => Promise.resolve(),
    stop: () => {
      order.push("conn");
      return broken.conn === true ? Promise.reject(new Error("socket wedged")) : Promise.resolve();
    },
    onStateChange: () => undefined,
  } satisfies WaConnection;
  const alerter: Alerter = {
    onState: () => undefined,
    selfTest: () => Promise.resolve(),
    stop: () => {
      order.push("alerter");
    },
  };

  return {
    deps: { logger, http, conn, alerter, db, exit: (code) => exits.push(code) },
    order,
    exits,
    entries,
    db,
  };
}

function isClosed(db: Db): boolean {
  try {
    db.prepare("SELECT 1").get();
    return false;
  } catch {
    return true;
  }
}

void test("shutdown stops the server, the socket and the alerts, then closes the store", async () => {
  const r = rig();

  await shutdown(r.deps, "SIGTERM");

  assert.deepEqual(r.order, ["http", "conn", "alerter"], "requests stop first, the socket next");
  assert.ok(isClosed(r.db), "the store is closed last, and it is closed");
  assert.deepEqual(r.exits, [143], "SIGTERM exits 143");
  assert.deepEqual(
    r.entries.filter((e) => e.level === "warn" || e.level === "error"),
    [],
    "a clean shutdown reports nothing alarming",
  );
});

void test("SIGINT exits 130", async () => {
  const r = rig();

  await shutdown(r.deps, "SIGINT");

  assert.deepEqual(r.exits, [130]);
});

void test("a step that throws does not skip the ones after it", async () => {
  const r = rig({ http: true, conn: true });

  await shutdown(r.deps, "SIGTERM");

  assert.deepEqual(r.order, ["http", "conn", "alerter"], "every later step still ran");
  assert.ok(isClosed(r.db), "and the store was still closed — the one step that must not be skipped");
  assert.deepEqual(r.exits, [143], "the exit code is the signal's, whatever failed on the way");
  assert.equal(r.entries.filter((e) => e.level === "warn").length, 2, "each failure is reported");
});
