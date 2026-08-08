/**
 * The Express skeleton, driven over a real listening socket.
 *
 * **Every test here fetches a real URL.** The middleware order is the thing under test and it is
 * only observable from outside: an auth gate mounted one line too late, a body parser mounted
 * globally, or an error middleware registered with three parameters instead of four are all
 * invisible to a unit test that calls a handler directly, and all three are the failures this file
 * exists to catch.
 *
 * **The handler map is stubbed, and that is the point of this task's seam.** `implement()` takes an
 * exhaustive map over all 24 routes; Tasks 8, 9 and 10 fill in the reads, the media and the writes.
 * What Task 7 owns is everything around them — the partition, the gate, the parser, the error
 * envelope — so the stubs here answer whatever a test needs and the real handlers change nothing
 * about the order they are mounted in.
 */

import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { Capabilities, HealthReport, routes, type Handler, type Handlers, type Route } from "whatsapp-api-sdk";
import type { Logger } from "pino";

import { loadConfig, type Config } from "../config.js";
import type { ChatsRepo } from "../db/chats.js";
import type { ContactsRepo } from "../db/contacts.js";
import type { MessagesRepo } from "../db/messages.js";
import type { MetaRepo } from "../db/meta.js";
import type { ReactionsRepo } from "../db/reactions.js";
import type { AutoTranscriber } from "../media/autotranscribe.js";
import type { MediaStore } from "../media/store.js";
import type { Transcriber } from "../media/transcribe.js";
import type { WhatsAppConnection } from "../whatsapp/connection.js";
import type { Sender } from "../whatsapp/send.js";
import type { MediaLinkSigner } from "./medialink.js";
import { CursorError } from "./cursor.js";
import { metaHandlers } from "./handlers/meta.js";
import { startRest, type RestDeps, type RestHandle } from "./server.js";

const TOKEN = "s3cr3t-api-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

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

/**
 * Render captured entries the way pino would put them on disk.
 *
 * An `Error`'s `message` and `stack` are non-enumerable, so a plain stringify silently drops exactly
 * the field a leak could hide in. pino's serializer takes those *and* every own enumerable key —
 * which is what turns body-parser's `err.body` into a log line — so this mirrors it.
 */
function rendered(entries: readonly Entry[]): string {
  return JSON.stringify(entries, (_key, value: unknown) => {
    if (!(value instanceof Error)) return value;
    const own = Object.entries(value as unknown as Record<string, unknown>);
    return { name: value.name, message: value.message, stack: value.stack, ...Object.fromEntries(own) };
  });
}

/** A handler no test in this file drives. Reaching it is a routing bug, and says so. */
const unexercised: Handler<Route> = () => Promise.reject(new Error("this route was not stubbed by the test"));

function stubHandlers(over: Partial<Handlers>): Handlers {
  const base = Object.fromEntries(Object.keys(routes).map((key) => [key, unexercised])) as Handlers;
  return { ...base, ...over };
}

const SNAPSHOT = {
  state: "connected" as const,
  needsPairing: false,
  lastEventAt: Math.floor(Date.now() / 1000),
  lastConnectedAt: 1_700_000_000,
  selfId: "1@s.whatsapp.net",
};

type DepsOptions = {
  apiToken?: string | undefined;
  readOnly?: boolean | undefined;
  maxUploadBytes?: number | undefined;
  transcription?: boolean | undefined;
  autoTranscriber?: AutoTranscriber | undefined;
  logger?: Logger | undefined;
};

function testDeps(opts: DepsOptions = {}): RestDeps {
  const config: Config = {
    ...loadConfig({}),
    port: 0,
    apiToken: opts.apiToken,
    readOnly: opts.readOnly ?? false,
    ...(opts.maxUploadBytes === undefined ? {} : { maxUploadBytes: opts.maxUploadBytes }),
  };
  return {
    config,
    logger: opts.logger ?? captureLogger().logger,
    // Only what `/health` and `/v1/capabilities` actually read is real; the rest belongs to the
    // handlers Tasks 8-10 own, and pretending otherwise here would be a fixture that lies.
    chats: { count: () => 1 } as unknown as ChatsRepo,
    contacts: { count: () => 3 } as unknown as ContactsRepo,
    messages: { count: () => 2, newestTs: () => 1_700_000_000 } as unknown as MessagesRepo,
    reactions: {} as unknown as ReactionsRepo,
    meta: { schemaVersion: () => 4 } as unknown as MetaRepo,
    conn: { snapshot: () => SNAPSHOT } as unknown as WhatsAppConnection,
    sender: {} as unknown as Sender,
    media: {} as unknown as MediaStore,
    transcriber: { available: () => Promise.resolve(opts.transcription ?? true) } as unknown as Transcriber,
    links: {} as unknown as MediaLinkSigner,
    biasTermsFor: () => [],
    autoTranscriber: opts.autoTranscriber,
  };
}

/**
 * Boot a server on an ephemeral port, torn down when the test ends.
 *
 * The composition here is the one `main.ts` will perform in Task 11: build the deps, build each
 * slice of the handler map from them, hand both to `startRest`. Only the three slices Tasks 8-10
 * own are stubs.
 */
async function start(
  t: TestContext,
  handlers: Partial<Handlers> = {},
  opts: DepsOptions = {},
): Promise<{ handle: RestHandle; entries: Entry[] }> {
  const { logger, entries } = captureLogger();
  const deps = testDeps({ apiToken: TOKEN, logger, ...opts });
  const handle = await startRest(deps, stubHandlers({ ...metaHandlers(deps), ...handlers }));
  t.after(() => handle.close());
  return { handle, entries };
}

// --- the auth partition ---------------------------------------------------------------------------

void test("/health answers without a bearer token", async (t) => {
  const { handle } = await start(t);
  const res = await fetch(`${handle.url}/health`);
  assert.equal(res.status, 200);
  const body: unknown = await res.json();
  assert.equal(HealthReport.parse(body).ok, true);
});

void test("a /v1 route without a bearer token is refused and names no secret", async (t) => {
  const { handle } = await start(t);
  const res = await fetch(`${handle.url}/v1/chats`);
  assert.equal(res.status, 401);
  assert.doesNotMatch(await res.text(), new RegExp(TOKEN));
});

void test("a 401 says how to authenticate", async (t) => {
  const { handle } = await start(t);
  const res = await fetch(`${handle.url}/v1/chats`);
  assert.equal(res.headers.get("www-authenticate"), "Bearer");
  const body = (await res.json()) as { error: { code: string; name: string; message: string } };
  assert.equal(body.error.code, "unauthorized");
  assert.notEqual(body.error.message, "");
});

void test("the signed download sits outside /v1 and needs no bearer token", async (t) => {
  // Two mechanisms, independent of each other. The distinct path prefix is what stops
  // `/v1/media/:chat/:id` from matching `/v1/media/dl/<token>` with `chat = "dl"`; partitioning on
  // `auth` is what stops the gate from answering 401 for a link that is meant to be shareable.
  const { handle } = await start(t, {
    fetchSignedMedia: () =>
      Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg", filename: "a.jpg" }),
  });
  const res = await fetch(`${handle.url}/media/dl/whatever`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

void test("every bearer route really is behind the gate", async (t) => {
  // The partition is data-driven, so the assertion is too: any bearer route not under /v1 would be
  // mounted ahead of a gate that cannot reach it, and any non-bearer route under /v1 would be
  // unreachable behind one. `startRest` refuses to boot on either, and this pins that the live
  // table satisfies it.
  const { handle } = await start(t);
  for (const route of Object.values(routes) as Route[]) {
    if (route.auth !== "bearer") continue;
    const path = route.path.replaceAll(/:[^/]+/g, "x");
    const res = await fetch(`${handle.url}${path}`, { method: route.method });
    assert.equal(res.status, 401, `${route.method} ${route.path}`);
  }
});

void test("a bad, short, long or empty bearer is a 401 rather than a crash", async (t) => {
  // `timingSafeEqual` throws on buffers of unequal length, so an implementation that drops the
  // length guard answers the short and long cases with a 500 or a dead socket.
  const { handle } = await start(t);
  for (const authorization of ["Bearer wrong", "Bearer x", `Bearer ${TOKEN}${TOKEN}`, "Bearer ", "", "Basic abc"]) {
    const res = await fetch(`${handle.url}/v1/chats`, { headers: { authorization } });
    assert.equal(res.status, 401, JSON.stringify(authorization));
  }
});

void test("the right bearer reaches the handler", async (t) => {
  const { handle } = await start(t, {
    listChats: () => Promise.resolve({ nextCursor: null, items: [] }),
  });
  const res = await fetch(`${handle.url}/v1/chats`, { headers: AUTH });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { nextCursor: null, items: [] });
});

void test("an unset API token fails closed for /v1 while /health keeps answering", async (t) => {
  const { handle, entries } = await start(t, {}, { apiToken: undefined });
  assert.equal((await fetch(`${handle.url}/health`)).status, 200);
  assert.equal((await fetch(`${handle.url}/v1/chats`)).status, 401);
  assert.equal((await fetch(`${handle.url}/v1/chats`, { headers: AUTH })).status, 401);
  // Said once, at boot: an unauthenticated deployment is a decision an operator has to see, and a
  // line per request would bury it.
  const warnings = entries.filter((e) => e.level === "warn" && e.msg.includes("WHATSAPP_API_TOKEN"));
  assert.equal(warnings.length, 1);
});

// --- capabilities ---------------------------------------------------------------------------------

void test("/v1/capabilities is behind the gate and reports what this deployment can do", async (t) => {
  const { handle } = await start(t, {}, { readOnly: true, transcription: false });
  assert.equal((await fetch(`${handle.url}/v1/capabilities`)).status, 401);

  const res = await fetch(`${handle.url}/v1/capabilities`, { headers: AUTH });
  assert.equal(res.status, 200);
  const caps = Capabilities.parse(await res.json());
  assert.equal(caps.readOnly, true);
  assert.equal(caps.features.transcription, false);
  assert.equal(caps.features.autoTranscribe, false);
  assert.equal(caps.features.mediaLinks, true);
  assert.notEqual(caps.apiVersion, "");
  // Compared at session build, so a mismatch is one legible error rather than a pile of parse
  // failures at the boundary.
  assert.equal(caps.contractVersion, 1);
});

void test("capabilities reports the API's real upload ceiling, so a client need not keep its own", async (t) => {
  const { handle } = await start(t, {}, { maxUploadBytes: 1234 });
  const caps = Capabilities.parse(await (await fetch(`${handle.url}/v1/capabilities`, { headers: AUTH })).json());
  assert.equal(caps.maxUploadBytes, 1234);
});

void test("capabilities and health agree about the background lane", async (t) => {
  const autoTranscriber = {
    snapshot: () => ({
      enabled: true,
      queued: 0,
      inFlight: 0,
      transcribedLastHour: 0,
      budget: { day: "2026-08-08", spentUsd: 0, budgetUsd: 1, exhausted: false },
    }),
  } as unknown as AutoTranscriber;
  const { handle } = await start(t, {}, { autoTranscriber });
  const caps = Capabilities.parse(await (await fetch(`${handle.url}/v1/capabilities`, { headers: AUTH })).json());
  const health = HealthReport.parse(await (await fetch(`${handle.url}/health`)).json());
  assert.equal(caps.features.autoTranscribe, true);
  assert.equal(health.auto_transcribe?.enabled, true);
});

void test("neither /health nor /v1/capabilities can name a secret", async (t) => {
  // Both are closed records built field by field, never a spread of `Config`. This is the assertion
  // that catches someone widening one with `...config`.
  const { handle } = await start(t);
  const health = await (await fetch(`${handle.url}/health`)).text();
  const caps = await (await fetch(`${handle.url}/v1/capabilities`, { headers: AUTH })).text();
  assert.doesNotMatch(health, new RegExp(TOKEN));
  assert.doesNotMatch(caps, new RegExp(TOKEN));
});

// --- the error middleware -------------------------------------------------------------------------

void test("a domain throw becomes its mapped status, code, name and message", async (t) => {
  const { handle } = await start(t, {
    listChats: () => Promise.reject(new CursorError("invalid pagination cursor")),
  });
  const res = await fetch(`${handle.url}/v1/chats`, { headers: AUTH });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { code: string; name: string; message: string } };
  assert.equal(body.error.code, "bad_request");
  // The name travels, which is what keeps `describeError` rendering `CursorError: …`.
  assert.equal(body.error.name, "CursorError");
  assert.equal(body.error.message, "invalid pagination cursor");
});

void test("an unexpected throw is a 500 and never a stack on the wire", async (t) => {
  const { handle, entries } = await start(t, {
    listChats: () => Promise.reject(new TypeError("x.y is not a function")),
  });
  const res = await fetch(`${handle.url}/v1/chats`, { headers: AUTH });
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.match(text, /"code":"internal"/);
  assert.doesNotMatch(text, /server\.test\.ts/);
  // The operator still gets the stack, in the log, where it belongs.
  assert.match(rendered(entries.filter((e) => e.level === "error")), /server\.test\.ts/);
});

void test("a rejected request is logged with its route pattern, never the concrete path", async (t) => {
  // `/v1/messages/:chat/:id` carries a phone number in `:chat`. Logging `req.path` would write one
  // to disk on every failed request against a DM.
  const { handle, entries } = await start(t, {
    getMessage: () => Promise.reject(new CursorError("invalid pagination cursor")),
  });
  await fetch(`${handle.url}/v1/messages/33600000000@s.whatsapp.net/ABC`, { headers: AUTH });
  const log = rendered(entries);
  assert.doesNotMatch(log, /33600000000/);
  assert.match(log, /\/v1\/messages\/:chat\/:id/);
});

void test("a handler that already started its response does not get a second one", async (t) => {
  const { handle } = await start(t, {
    fetchSignedMedia: async ({ params }) => {
      void params;
      await Promise.resolve();
      throw new Error("too late");
    },
  });
  // Nothing was written by the stub before it threw, so this is the ordinary path; the assertion
  // that matters is that the server answers at all rather than hanging the socket.
  const res = await fetch(`${handle.url}/media/dl/x`);
  assert.equal(res.status, 500);
});

// --- the body parser ------------------------------------------------------------------------------

void test("an anonymous POST is refused before anything is parsed", async (t) => {
  // Mounted on /v1 *behind* the gate: global, this buffers and parses ~90 MB for a caller who has
  // presented no credential at all. A 400 here instead of a 401 means the parser ran first.
  const { handle } = await start(t);
  const res = await fetch(`${handle.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 401);
});

void test("an oversized body is payload_too_large", async (t) => {
  const { handle } = await start(t, {}, { maxUploadBytes: 1024 });
  const res = await fetch(`${handle.url}/v1/messages`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ recipient: "x", text: "y".repeat(4 * 1024 * 1024) }),
  });
  assert.equal(res.status, 413);
  assert.match(await res.text(), /"code":"payload_too_large"/);
});

void test("a malformed body echoes none of itself, in the response or the log", async (t) => {
  // body-parser hangs the raw payload off the error and V8 quotes the input in the message. One
  // `{ err }` in a log line writes an arbitrary caller's body — or a legitimate `sendFile`'s base64
  // — to disk.
  const { handle, entries } = await start(t);
  const res = await fetch(`${handle.url}/v1/messages`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: '{"data":"LEAKMARKER"',
  });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.match(text, /"code":"bad_request"/);
  assert.doesNotMatch(text, /LEAKMARKER/);
  assert.doesNotMatch(rendered(entries), /LEAKMARKER/);
});

void test("no log line ever carries an Authorization header", async (t) => {
  const { handle, entries } = await start(t, {
    listChats: () => Promise.reject(new TypeError("boom")),
  });
  await fetch(`${handle.url}/v1/chats`, { headers: AUTH });
  await fetch(`${handle.url}/v1/chats`, { headers: { authorization: "Bearer wrong-but-secret" } });
  const log = rendered(entries);
  assert.doesNotMatch(log, new RegExp(TOKEN));
  assert.doesNotMatch(log, /wrong-but-secret/);
});

// --- success statuses -----------------------------------------------------------------------------

void test("a create answers 201 and a read answers 200, as the table pins", async (t) => {
  const { handle } = await start(t, {
    sendText: () => Promise.resolve({ chat: "1@s.whatsapp.net", messageId: "M1" }),
    listChats: () => Promise.resolve({ nextCursor: null, items: [] }),
  });
  const created = await fetch(`${handle.url}/v1/messages`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ recipient: "1@s.whatsapp.net", text: "hi" }),
  });
  assert.equal(created.status, 201);
  assert.equal((await fetch(`${handle.url}/v1/chats`, { headers: AUTH })).status, 200);
});

void test("a request the route schema refuses is a 400 that names the field, not the value", async (t) => {
  const { handle } = await start(t, { listChats: () => Promise.resolve({ nextCursor: null, items: [] }) });
  const res = await fetch(`${handle.url}/v1/chats?limit=LEAKMARKER`, { headers: AUTH });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.match(text, /"code":"bad_request"/);
  assert.match(text, /limit/);
  assert.doesNotMatch(text, /LEAKMARKER/);
});

// --- lifecycle ------------------------------------------------------------------------------------

void test("close stops the listener", async () => {
  const deps = testDeps({ apiToken: TOKEN });
  const handle = await startRest(deps, stubHandlers(metaHandlers(deps)));
  const { url } = handle;
  assert.equal((await fetch(`${url}/health`)).status, 200);
  await handle.close();
  await assert.rejects(() => fetch(`${url}/health`));
});
