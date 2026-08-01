/**
 * What is and is not exercised here.
 *
 * **Every test drives a real listening server with `fetch`.** The transport is the SDK's, the router
 * is Express 5's, and the only stubs are the two seams `startHttp` takes: the health payload and the
 * `McpServer` factory. So the session rules, the auth gate and the error envelopes are tested as a
 * client meets them, not as functions called directly.
 *
 * **The token tests are the reason this file exists.** A 401 for a missing, wrong, short, long or
 * empty bearer is one assertion each, and the short/long cases are not padding: `timingSafeEqual`
 * throws on a length mismatch, so an implementation that forgets the length guard answers those two
 * with a 500 (or a dead socket), not a 401.
 *
 * **What `/health never contains a token` can and cannot prove.** The payload comes from the
 * injected `health()`, so this test cannot fail unless `startHttp` itself widens the response with
 * something from `Config` — which is exactly the regression it is there to catch. That the *real*
 * payload is a closed record with no secret in it is `buildHealth`'s property, pinned in
 * `src/mcp/health.ts` and its own tests.
 *
 * **The idle sweeper is covered by shortening the TTL, not by waiting out the real one.** The sweep
 * period is derived from `config.sessionTtlMs`, so a 50 ms TTL sweeps every 13 ms and eviction is
 * observable in a fraction of a second. This is the one test here that sleeps, and the alternative
 * was leaving the only defence against unbounded session growth untested.
 */

import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "pino";
import { loadConfig, type Config } from "./config.js";
import { startHttp, type HttpHandle } from "./http.js";

const HEALTH: Record<string, unknown> = {
  ok: true,
  connection: "connected",
  counts: { chats: 1, messages: 2, contacts: 3 },
};

type Entry = { level: string; obj: Record<string, unknown>; msg: string };

/**
 * Render captured entries the way pino would put them on disk.
 *
 * `JSON.stringify` alone is not good enough for the body-leak assertions: an `Error`'s `message` and
 * `stack` are non-enumerable, so a plain stringify silently drops exactly the field a leak could hide
 * in. pino's standard error serializer takes `message`, `stack` **and every own enumerable key**
 * (`pino-std-serializers/lib/err.js`), which is what turns body-parser's `err.body` — the entire raw
 * request payload — into a log line. This mirrors that, so "the marker is not in the log" means it.
 */
function rendered(entries: Entry[]): string {
  return JSON.stringify(entries, (_key, value: unknown) => {
    if (!(value instanceof Error)) return value;
    const own = Object.entries(value as unknown as Record<string, unknown>);
    return { name: value.name, message: value.message, stack: value.stack, ...Object.fromEntries(own) };
  });
}

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

type Server = {
  handle: HttpHandle;
  base: string;
  entries: Entry[];
  /** How many `McpServer` instances were built, and how many of those were closed again. */
  builds: { n: number };
  closes: { n: number };
};

/**
 * Start a server on an ephemeral port, torn down when the test ends.
 *
 * `breakConnect` makes every built `McpServer` reject on `connect`, which is the only *deterministic*
 * way to drive a rejection through the initialize path from out here. `transport.handleRequest`
 * cannot be made to reject over the network at all: it delegates to `@hono/node-server`'s
 * `getRequestListener`, which catches request, fetch and response errors alike and turns each into a
 * status code. Both failures are covered by the same `finally`, and this is the half a test can pin.
 */
async function start(
  t: TestContext,
  over: Partial<Config> = {},
  health: () => Promise<Record<string, unknown>> = () => Promise.resolve({ ...HEALTH }),
  breakConnect = false,
): Promise<Server> {
  const { logger, entries } = captureLogger();
  const builds = { n: 0 };
  const closes = { n: 0 };
  const config: Config = { ...loadConfig({}), port: 0, ...over };
  const handle = await startHttp({
    config,
    logger,
    buildServer: () => {
      builds.n += 1;
      const server = new McpServer({ name: "wa-mcp-test", version: "0.0.0" });
      // One tool, so the server advertises the tools capability and `tools/list` is a real round
      // trip rather than a "method not found" that would pass an `ok` assertion just as well.
      server.registerTool("wa_test_ping", { description: "Test tool.", inputSchema: {} }, () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      const closeOriginal = server.close.bind(server);
      server.close = async (): Promise<void> => {
        closes.n += 1;
        await closeOriginal();
      };
      if (breakConnect) server.connect = () => Promise.reject(new Error("transport handshake failed"));
      return server;
    },
    health,
  });
  t.after(() => handle.close());
  return { handle, base: `http://127.0.0.1:${handle.port}`, entries, builds, closes };
}

type RpcHeaders = { authorization?: string; "mcp-session-id"?: string };

function mcpPost(s: Server, body: unknown, extra: RpcHeaders = {}): Promise<globalThis.Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (extra.authorization !== undefined) headers["authorization"] = extra.authorization;
  if (extra["mcp-session-id"] !== undefined) headers["mcp-session-id"] = extra["mcp-session-id"];
  return fetch(`${s.base}/mcp`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Read a JSON-RPC payload out of either a plain JSON response or an SSE stream. */
async function readRpc(res: globalThis.Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    assert.ok(line, `no SSE data frame in ${JSON.stringify(text)}`);
    return JSON.parse(line.slice("data:".length).trim()) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "http-test", version: "0.0.0" },
  },
};

// --- /health ------------------------------------------------------------------------------------

void test("/health is public and returns the snapshot", async (t) => {
  const s = await start(t, { mcpToken: "secret" });

  const res = await fetch(`${s.base}/health`);

  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.deepEqual(body, HEALTH, "the route returns the health payload verbatim and adds nothing of its own");
});

void test("/health stays public even when the MCP path is mounted at the root", async (t) => {
  const s = await start(t, { mcpToken: "secret", httpPath: "/" });

  const res = await fetch(`${s.base}/health`);

  assert.equal(res.status, 200, "the healthcheck has no credential, whatever MCP_HTTP_PATH is set to");
  const mcp = await fetch(`${s.base}/`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: "{}",
  });
  assert.equal(mcp.status, 401, "and the MCP path is still guarded");
});

void test("a failing health probe is a 500 envelope, not a hung request", async (t) => {
  const s = await start(t, { mcpToken: "secret" }, () => Promise.reject(new Error("whisper exploded")));

  const res = await fetch(`${s.base}/health`);

  assert.equal(res.status, 500);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal((body["error"] as { code: number } | undefined)?.code, -32603);
  assert.doesNotMatch(JSON.stringify(body), /whisper exploded/, "the envelope says nothing about internals");
});

void test("/health never contains a token", async (t) => {
  const s = await start(t, {
    mcpToken: "super-secret-value",
    ntfy: { baseUrl: "https://ntfy.example/", topic: "t", token: "ntfy-secret" },
  });

  const text = await (await fetch(`${s.base}/health`)).text();

  assert.doesNotMatch(text, /super-secret-value|ntfy-secret/);
  assert.doesNotMatch(JSON.stringify(s.entries), /super-secret-value|ntfy-secret/, "nor may a log line carry one");
});

// --- bearer auth --------------------------------------------------------------------------------

void test("/mcp without a bearer token is 401 when a token is configured", async (t) => {
  const s = await start(t, { mcpToken: "secret" });

  const res = await mcpPost(s, {});

  assert.equal(res.status, 401);
  const body = await readRpc(res);
  assert.equal((body["error"] as { code: number } | undefined)?.code, -32002);
  assert.doesNotMatch(JSON.stringify(body), /secret/, "the refusal must not echo the expected token");
});

void test("/mcp with the wrong bearer token is 401", async (t) => {
  const s = await start(t, { mcpToken: "secret" });

  const res = await mcpPost(s, {}, { authorization: "Bearer nope" });

  assert.equal(res.status, 401);
});

void test("token comparison is constant-time and length-safe", async (t) => {
  const s = await start(t, { mcpToken: "secret" });

  // `timingSafeEqual` throws on unequal lengths, so a naive comparison answers the short and the
  // long candidate with a 500 or a dropped socket instead of a 401.
  for (const candidate of ["", "s", "secret-plus-more"]) {
    const res = await mcpPost(s, {}, { authorization: `Bearer ${candidate}` });
    assert.equal(res.status, 401, `token ${JSON.stringify(candidate)}`);
  }

  const malformed = await mcpPost(s, {}, { authorization: "secret" });
  assert.equal(malformed.status, 401, "a bare token without the Bearer scheme is not a credential");
});

void test("with no token configured /mcp is open and a warning was logged at boot", async (t) => {
  const s = await start(t, { mcpToken: undefined });

  const warnings = s.entries.filter((e) => e.level === "warn" && e.msg.includes("WA_MCP_TOKEN"));
  assert.equal(warnings.length, 1, "an unauthenticated deployment must say so, once, at boot");

  // A non-initialize request reaching the session rules is what proves the gate let it through: an
  // authenticated server answers this with 401 and never gets as far as 400.
  //
  // The message is asserted, not just the status and the code: hand the same request to the SDK
  // without the initialize guard and it answers 400 / -32000 / "Server not initialized" — the same
  // shape from a code path that has already built a server and a transport for an anonymous caller.
  // `builds.n` is what pins the difference.
  for (const _ of [1, 2, 3]) {
    const res = await mcpPost(s, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal(res.status, 400);
    const body = await readRpc(res);
    const error = body["error"] as { code: number; message: string } | undefined;
    assert.ok(error);
    assert.equal(error.code, -32000);
    assert.match(error.message, /initialize request first/);
  }
  assert.equal(s.builds.n, 0, "only an initialize request may cause a server to be built");
  assert.equal(s.entries.filter((e) => e.level === "warn").length, 1, "and must not repeat it per request");
});

// --- sessions -----------------------------------------------------------------------------------

void test("an unknown session id is rejected with a JSON-RPC error, not a crash", async (t) => {
  const s = await start(t, { mcpToken: "secret" });

  const res = await mcpPost(
    s,
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    { authorization: "Bearer secret", "mcp-session-id": "00000000-0000-4000-8000-000000000000" },
  );

  assert.equal(res.status, 404);
  const body = await readRpc(res);
  assert.equal(body["jsonrpc"], "2.0");
  assert.equal(body["id"], null);
  assert.equal((body["error"] as { code: number } | undefined)?.code, -32001);

  const get = await fetch(`${s.base}/mcp`, {
    headers: { authorization: "Bearer secret", accept: "text/event-stream", "mcp-session-id": "nope" },
  });
  assert.equal(get.status, 404, "a stream request for a dead session is refused the same way");

  const still = await fetch(`${s.base}/health`);
  assert.equal(still.status, 200, "and the server is still serving afterwards");
});

void test("a full initialize handshake succeeds and returns a session id", async (t) => {
  const s = await start(t, { mcpToken: "secret" });
  const auth = { authorization: "Bearer secret" };

  const res = await mcpPost(s, INITIALIZE, auth);
  assert.equal(res.status, 200);
  const sessionId = res.headers.get("mcp-session-id");
  assert.ok(sessionId !== null && sessionId.length > 0, "an initialize response carries the new session id");
  const body = await readRpc(res);
  assert.equal(body["id"], 1);
  assert.ok(body["result"], `expected a result, got ${JSON.stringify(body)}`);
  assert.equal(s.builds.n, 1, "one server instance was built for the session");

  const ready = await mcpPost(
    s,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { ...auth, ...idOf(sessionId) },
  );
  assert.ok(ready.ok || ready.status === 202, `initialized notification rejected with ${ready.status}`);

  const listed = await mcpPost(
    s,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { ...auth, ...idOf(sessionId) },
  );
  assert.equal(listed.status, 200, "the session id opens the door for subsequent requests");
  const tools = await readRpc(listed);
  assert.equal(tools["id"], 2);
  assert.ok(tools["result"], `expected a tools/list result, got ${JSON.stringify(tools)}`);

  const deleted = await fetch(`${s.base}/mcp`, { method: "DELETE", headers: { ...auth, ...idOf(sessionId) } });
  assert.ok(deleted.ok, `DELETE returned ${deleted.status}`);

  const afterDelete = await mcpPost(
    s,
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    { ...auth, ...idOf(sessionId) },
  );
  assert.equal(afterDelete.status, 404, "a terminated session is gone");
});

function idOf(sessionId: string): { "mcp-session-id": string } {
  return { "mcp-session-id": sessionId };
}

void test("an initialize the transport refuses leaks nothing", async (t) => {
  const s = await start(t, { mcpToken: "secret" });

  // The SDK answers 406 when the client will not take an SSE stream, and never initializes the
  // session — so nothing would ever close the server built for it unless this path does.
  const res = await fetch(`${s.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer secret" },
    body: JSON.stringify(INITIALIZE),
  });

  assert.equal(res.status, 406);
  assert.equal(res.headers.get("mcp-session-id"), null);
  assert.equal(s.builds.n, 1);
  assert.equal(s.closes.n, 1, "a session that never opened is closed again rather than left behind");
});

void test("an initialize that throws leaks nothing either", async (t) => {
  const s = await start(t, { mcpToken: "secret" }, undefined, true);

  // The same leak, down the other path. A trailing `if` after the two awaits is skipped entirely
  // when one of them rejects — which is the case where a leak is least likely to be noticed — so
  // the cleanup only holds if it is in a `finally`.
  const res = await mcpPost(s, INITIALIZE, { authorization: "Bearer secret" });

  assert.equal(res.status, 500, "the failure is still answered with our envelope");
  assert.equal(s.builds.n, 1);
  assert.equal(s.closes.n, 1, "and the McpServer built for the doomed session is closed anyway");

  const still = await fetch(`${s.base}/health`);
  assert.equal(still.status, 200, "the server is still serving afterwards");
});

void test("an idle session is swept, and the sweeper holds nothing open", async (t) => {
  const timersBefore = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const s = await start(t, { sessionTtlMs: 50 });
  assert.equal(
    process.getActiveResourcesInfo().filter((r) => r === "Timeout").length,
    timersBefore,
    "the sweeper is unref'd, so it never keeps the process alive on its own",
  );

  const opened = await mcpPost(s, INITIALIZE);
  const sessionId = opened.headers.get("mcp-session-id");
  await readRpc(opened);
  assert.ok(sessionId !== null);

  await sleep(300);

  const after = await mcpPost(s, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, idOf(sessionId));
  assert.equal(after.status, 404, "a session idle past its TTL is evicted rather than kept forever");
});

// --- malformed input ----------------------------------------------------------------------------

void test("a malformed body is a 400, not a 500 and not a crash", async (t) => {
  const s = await start(t, { mcpToken: "secret" });

  const res = await mcpPost(s, "{not json", { authorization: "Bearer secret" });

  assert.equal(res.status, 400);
  const body = await readRpc(res);
  assert.equal(body["jsonrpc"], "2.0");
  assert.ok(body["error"]);

  const still = await fetch(`${s.base}/health`);
  assert.equal(still.status, 200);
});

/**
 * Ten characters, at offset 0 of the payload, because both leak paths have to be reachable for this
 * test to mean anything:
 *
 * - `err.body` — body-parser attaches the *entire* raw payload to a parse failure, so any marker
 *   anywhere in the body is enough for that one.
 * - `err.message` — V8's parse error quotes the input, but truncates to the first ten characters
 *   once the payload is longer than twenty. A marker further in would leave that path untested.
 */
const LEAK_MARKER = "LEAKMARKER";

void test("a rejected body never reaches a log line", async (t) => {
  const s = await start(t, { mcpToken: "secret" });

  const res = await mcpPost(s, `${LEAK_MARKER}{"jsonrpc":"2.0"}`, { authorization: "Bearer secret" });

  assert.equal(res.status, 400);
  // Logging the error object writes the caller's payload — up to the body limit, ~90 MB at the
  // default `WA_MAX_UPLOAD_BYTES` — to disk, once per malformed request. A `wa_send_file` base64
  // argument is the legitimate version of the same accident.
  assert.doesNotMatch(rendered(s.entries), /LEAKMARKER/, "the request body must not be logged, in any field");
  assert.ok(
    s.entries.some((e) => e.level === "warn" && e.obj["type"] === "entity.parse.failed"),
    "what is logged instead is the parser's own classification of the failure",
  );
});

void test("a body is only ever parsed behind the auth gate", async (t) => {
  const s = await start(t, { mcpToken: "secret" });
  const payload = `${LEAK_MARKER}{"jsonrpc":"2.0"}`;

  // A path the server has no route for. A globally-mounted parser buffers and parses this anyway —
  // up to the ~90 MB body limit — for a caller who has presented no credential at all, and only
  // then falls through to a 404.
  const stray = await fetch(`${s.base}/anything`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  assert.equal(stray.status, 404, "no route, and so no parse either");

  // And on the MCP path itself the gate still runs before the parser, so a wrong credential is
  // answered without the payload ever being read.
  const refused = await mcpPost(s, payload, { authorization: "Bearer wrong" });
  assert.equal(refused.status, 401);

  assert.equal(
    s.entries.filter((e) => e.obj["type"] === "entity.parse.failed").length,
    0,
    "neither request reached the parser, so neither could have leaked a body",
  );
  assert.doesNotMatch(rendered(s.entries), /LEAKMARKER/);
});
