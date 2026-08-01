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

/** Start a server on an ephemeral port, torn down when the test ends. */
async function start(
  t: TestContext,
  over: Partial<Config> = {},
  health: () => Promise<Record<string, unknown>> = () => Promise.resolve({ ...HEALTH }),
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
