import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { backoffMs, ConnectionUnavailableError, makeConnection, type ConnectionDeps } from "./connection.js";

function fakeSocket() {
  const ev = new EventEmitter();
  return {
    ev: { on: ev.on.bind(ev), off: ev.off.bind(ev) },
    emit: ev.emit.bind(ev),
    requestPairingCode: (n: string) => Promise.resolve(`CODE-${n.slice(-4)}`),
    logout: async () => {
      /* no-op */
    },
    end: () => {
      /* no-op */
    },
    user: { id: "33612345678:1@s.whatsapp.net" },
  };
}

/** Narrows `sockets[0]` from `T | undefined` and fails loudly if no socket was created. */
function firstSocket(sockets: ReturnType<typeof fakeSocket>[]): ReturnType<typeof fakeSocket> {
  const s = sockets[0];
  assert.ok(s, "expected a socket to have been created");
  return s;
}

function deps(over: Partial<ConnectionDeps> = {}) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const base = {
    config: { phoneNumber: "33612345678" },
    logger: {
      info() {
        /* no-op */
      },
      warn() {
        /* no-op */
      },
      error() {
        /* no-op */
      },
      debug() {
        /* no-op */
      },
    },
    auth: {
      state: { creds: {} },
      saveCreds() {
        /* no-op */
      },
      clear() {
        /* no-op */
      },
    },
    loadMessage: () => Promise.resolve(undefined),
    onSocket: () => {
      /* no-op */
    },
    makeSocket: () => {
      const s = fakeSocket();
      sockets.push(s);
      return s;
    },
  } as unknown as ConnectionDeps;
  return { deps: { ...base, ...over }, sockets };
}

void test("starts disconnected, moves to connecting on start", async () => {
  const { deps: d, sockets } = deps();
  const c = makeConnection(d);
  assert.equal(c.snapshot().state, "disconnected");
  await c.start();
  assert.equal(c.snapshot().state, "connecting");
  assert.equal(sockets.length, 1);
});

void test("reaches connected on connection.update open", async () => {
  const { deps: d, sockets } = deps();
  const c = makeConnection(d);
  await c.start();
  firstSocket(sockets).emit("connection.update", { connection: "open" });
  assert.equal(c.snapshot().state, "connected");
  assert.equal(c.snapshot().attempts, 0, "a successful connect resets the backoff counter");
});

void test("requireSocket throws with the state named when not connected", () => {
  const { deps: d } = deps();
  const c = makeConnection(d);
  assert.throws(
    () => c.requireSocket(),
    (e: unknown) => {
      assert.ok(e instanceof ConnectionUnavailableError);
      assert.equal(e.state, "disconnected");
      assert.match(e.message, /disconnected/);
      return true;
    },
  );
});

void test("a qr with no session requests a pairing code and enters pairing", async () => {
  const { deps: d, sockets } = deps();
  const c = makeConnection(d);
  const seen: string[] = [];
  c.onStateChange((s) => seen.push(s));
  await c.start();
  firstSocket(sockets).emit("connection.update", { qr: "some-qr-payload" });
  await new Promise((r) => setImmediate(r));
  assert.equal(c.snapshot().state, "pairing");
  assert.equal(c.snapshot().needsPairing, true);
  assert.ok(seen.includes("pairing"));
});

void test("a pairing code is requested exactly once per socket", async () => {
  const { deps: d, sockets } = deps();
  let calls = 0;
  const c = makeConnection({
    ...d,
    makeSocket: () => {
      const s = fakeSocket();
      s.requestPairingCode = () => {
        calls++;
        return Promise.resolve("ABCD1234");
      };
      sockets.push(s);
      return s;
    },
  } as unknown as ConnectionDeps);
  await c.start();
  firstSocket(sockets).emit("connection.update", { qr: "a" });
  firstSocket(sockets).emit("connection.update", { qr: "b" });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, "a rotating QR must not spam requestPairingCode");
});

void test("loggedOut is terminal: no reconnect, creds cleared", async () => {
  const { deps: d, sockets } = deps();
  let cleared = false;
  const c = makeConnection({
    ...d,
    auth: {
      ...d.auth,
      clear: () => {
        cleared = true;
      },
    },
  });
  await c.start();
  firstSocket(sockets).emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 } } },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(c.snapshot().state, "logged_out");
  assert.equal(cleared, true);
  assert.equal(sockets.length, 1, "a logged-out connection must not be retried");
});

void test("restartRequired recreates the socket immediately", async () => {
  const { deps: d, sockets } = deps();
  const c = makeConnection(d);
  await c.start();
  firstSocket(sockets).emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 515 } } },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(sockets.length, 2, "restartRequired is expected after pairing, not a failure");
  assert.equal(c.snapshot().state, "connecting");
});

void test("backoff grows, caps, and is jittered", () => {
  assert.ok(backoffMs(0, () => 0.5) >= 500);
  assert.ok(backoffMs(1, () => 0.5) > backoffMs(0, () => 0.5));
  assert.ok(backoffMs(50, () => 0.5) <= 300_000);
  assert.notEqual(
    backoffMs(3, () => 0),
    backoffMs(3, () => 0.99),
  );
});

void test("stop() prevents any further reconnect", async () => {
  const { deps: d, sockets } = deps();
  const c = makeConnection(d);
  await c.start();
  await c.stop();
  firstSocket(sockets).emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 500 } } },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(sockets.length, 1);
  assert.equal(c.snapshot().state, "disconnected");
});

void test("calling start() twice while already running does not create a second socket", async () => {
  const { deps: d, sockets } = deps();
  const c = makeConnection(d);
  await c.start();
  await c.start();
  assert.equal(sockets.length, 1, "a second start() while already connecting/connected must be a no-op");
});

void test("start() after logged_out is honored, so a fresh pairing can proceed", async () => {
  const { deps: d, sockets } = deps();
  const c = makeConnection(d);
  await c.start();
  firstSocket(sockets).emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 } } },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(c.snapshot().state, "logged_out");
  await c.start();
  assert.equal(sockets.length, 2, "logged_out must not permanently block a later start()");
});

void test("a close event arriving after stop() must not clear auth or resurrect logged_out", async () => {
  const { deps: d, sockets } = deps();
  let cleared = false;
  const c = makeConnection({
    ...d,
    auth: {
      ...d.auth,
      clear: () => {
        cleared = true;
      },
    },
  });
  await c.start();
  await c.stop();
  firstSocket(sockets).emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 } } },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(cleared, false, "a stale socket's close event must not wipe live credentials");
  assert.equal(
    c.snapshot().state,
    "disconnected",
    "stop() already recorded the outcome; a late event must not override it",
  );
});

void test("makeSocket throwing synchronously is an ordinary failed attempt, not a crash", async () => {
  const { deps: d } = deps();
  const c = makeConnection({
    ...d,
    makeSocket: () => {
      throw new Error("bad auth blob");
    },
  });
  await c.start(); // must resolve, never reject or throw
  assert.equal(c.snapshot().state, "disconnected");
  assert.equal(c.snapshot().attempts, 1, "a synchronous makeSocket throw still counts as a failed attempt");
  await c.stop(); // the failed attempt scheduled a backoff retry; stop() it so the process can exit
});
