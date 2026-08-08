/**
 * The pair, end to end: a real API, a real MCP **process**, and real tool calls over HTTP.
 *
 * **This is the only defence against stub drift, and it is why it exists.** `packages/mcp`'s suite
 * runs the fourteen tools against an in-memory `WhatsAppApiClient`; `packages/api`'s suite runs the
 * 24 routes against a real store. Both can be green while the pair is broken — a query parameter the
 * client spells one way and the API reads another, a response the client validates and the API never
 * sends, a relative media URL nobody resolves. Nothing but this file catches that.
 *
 * **What is real, precisely.**
 *
 * - The **MCP is a separate OS process**: `node --import tsx packages/mcp/src/main.ts`, booted from
 *   its own `loadConfig(process.env)`, listening on its own port. Every tool call below is an HTTP
 *   Streamable-HTTP request from a real `@modelcontextprotocol/sdk` client, through the bearer gate,
 *   into a session built off a real `GET /v1/capabilities`.
 * - The **API is the real composition** — `startRest` with the real repositories over a real SQLite
 *   file, the real ingest, the real `makeSender`, the real `makeMediaStore`, the real media-link
 *   signer, and all 24 handlers — but it runs **in this process**, because the only seam that keeps
 *   a test off WhatsApp's websocket is `ConnectionDeps.makeSocket`, and a spawned `packages/api`
 *   would open a real one. Everything between the MCP and SQLite is genuinely exercised; what is
 *   simulated is one process boundary and the socket itself.
 * - The **socket is `fake-socket.ts`**, the union of `packages/api`'s three existing partial fakes
 *   plus `updateMediaMessage`. Messages arrive through `ev.on("messages.upsert")` into the real
 *   ingest; sends leave through `sock.sendMessage` and come back through the real re-ingest.
 *
 * **What is therefore *not* covered, and cannot be in CI:** no WhatsApp account is paired, so
 * nothing here proves Baileys' own encoding, its media decryption, or that WhatsApp accepts what the
 * sender builds. `packages/api`'s `send.test.ts` and `ingest.test.ts` pin the shapes handed to
 * Baileys; beyond that boundary this suite is silent, deliberately. Transcription is likewise
 * unreachable — it needs a GPU endpoint — so `whatsapp_transcribe` is exercised only as far as the
 * API's refusal when no backend is configured.
 */

import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { WAMessageKey } from "baileys";

import { loadConfig as loadApiConfig, type Config } from "whatsapp-api/src/config.js";
import { makeChatsRepo } from "whatsapp-api/src/db/chats.js";
import { closeDb, openDb } from "whatsapp-api/src/db/client.js";
import { makeContactsRepo } from "whatsapp-api/src/db/contacts.js";
import { makeMessagesRepo } from "whatsapp-api/src/db/messages.js";
import { makeMetaRepo } from "whatsapp-api/src/db/meta.js";
import { makeReactionsRepo } from "whatsapp-api/src/db/reactions.js";
import { makeAuthStore } from "whatsapp-api/src/db/auth-state.js";
import { silentLogger } from "whatsapp-api/src/logger.js";
import { biasTermsFor } from "whatsapp-api/src/media/bias.js";
import { makeMediaStore } from "whatsapp-api/src/media/store.js";
import { makeTranscriber } from "whatsapp-api/src/media/transcribe.js";
import { mediaHandlers } from "whatsapp-api/src/rest/handlers/media.js";
import { metaHandlers } from "whatsapp-api/src/rest/handlers/meta.js";
import { readHandlers } from "whatsapp-api/src/rest/handlers/reads.js";
import { writeHandlers } from "whatsapp-api/src/rest/handlers/writes.js";
import { makeMediaLinkSigner } from "whatsapp-api/src/rest/medialink.js";
import { startRest, type RestDeps, type RestHandle } from "whatsapp-api/src/rest/server.js";
import { makeConnection, type WhatsAppConnection } from "whatsapp-api/src/whatsapp/connection.js";
import { documentMessage, textMessage, FIXTURE_DM } from "whatsapp-api/src/whatsapp/fixtures.js";
import { makeIngest } from "whatsapp-api/src/whatsapp/ingest.js";
import { canonicalId } from "whatsapp-api/src/whatsapp/jid.js";
import { makeSender } from "whatsapp-api/src/whatsapp/send.js";
import type { Handlers } from "whatsapp-api-sdk";
import { resultJson, resultPage, resultText } from "whatsapp-mcp/src/tools/harness.js";

import { fakeSocket, FAKE_MEDIA_BYTES, type FakeSocket } from "./fake-socket.js";

const API_TOKEN = "e2e-api-token";
const MCP_TOKEN = "e2e-mcp-token";
const ALICE = FIXTURE_DM;

/** Where `packages/mcp/src/main.ts` is, and where node has to run from for `--import tsx` to resolve. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MCP_MAIN = fileURLToPath(new URL("../../mcp/src/main.ts", import.meta.url));

type ApiHandle = { url: string; socket: FakeSocket; conn: WhatsAppConnection; close: () => Promise<void> };
type McpHandle = { url: string; client: Client; close: () => Promise<void> };

const cleanups: (() => Promise<void>)[] = [];

after(async () => {
  for (const close of cleanups.reverse()) await close();
});

/**
 * The whole API, wired the way `bootstrap()` wires it, with one fake at the bottom.
 *
 * The construction order is `main.ts`'s and has to be: `ingest` is built first with a `selfId`
 * closure over a connection that does not exist yet, then `makeConnection` is handed
 * `onSocket: ingest.attach`, and only then can the sender and the media store be built off the
 * same connection.
 */
async function bootApi(opts: { readOnly?: boolean; socket: FakeSocket }): Promise<ApiHandle> {
  const dir = mkdtempSync(join(tmpdir(), "whatsapp-e2e-"));
  const db = openDb(join(dir, "t.db"));
  const logger = silentLogger();
  const config: Config = {
    ...loadApiConfig({ WHATSAPP_DATA_DIR: dir }),
    port: 0,
    apiToken: API_TOKEN,
    readOnly: opts.readOnly ?? false,
  };

  const chats = makeChatsRepo(db);
  const contacts = makeContactsRepo(db);
  const messages = makeMessagesRepo(db);
  const reactions = makeReactionsRepo(db);
  const meta = makeMetaRepo(db);
  const auth = makeAuthStore(db);

  const loadMessage = (key: WAMessageKey): Promise<Uint8Array | undefined> => {
    const { remoteJid, id } = key;
    if (remoteJid == null || remoteJid === "" || id == null || id === "") return Promise.resolve(undefined);
    return Promise.resolve(messages.getRaw(canonicalId(remoteJid, { pnForLid: contacts.pnForLid }), id));
  };

  let live: WhatsAppConnection | undefined = undefined;
  const ingest = makeIngest({
    db,
    chats,
    contacts,
    messages,
    reactions,
    logger,
    selfId: () => live?.snapshot().selfId ?? null,
  });
  const conn = makeConnection({
    config,
    logger,
    auth,
    loadMessage,
    onSocket: ingest.attach,
    makeSocket: opts.socket.makeSocket,
  });
  live = conn;

  const sender = makeSender({
    conn,
    ingest,
    messages,
    chats,
    contacts,
    maxUploadBytes: config.maxUploadBytes,
    sendFileDir: config.sendFileDir,
  });
  const media = makeMediaStore({
    dir: config.mediaDir,
    messages,
    conn,
    logger,
    // The one injected seam below the socket: Baileys' real `downloadMediaMessage` decrypts against
    // keys no fixture can produce. It still goes through `reuploadRequest`, which is what puts
    // `updateMediaMessage` on the path — the expired-URL retry the union of the existing fakes
    // could not reach.
    download: async (message, ctx) => {
      await ctx.reuploadRequest(message);
      return FAKE_MEDIA_BYTES;
    },
  });

  const deps: RestDeps = {
    config,
    logger,
    chats,
    contacts,
    messages,
    reactions,
    meta,
    conn,
    sender,
    media,
    transcriber: makeTranscriber({ config, logger }),
    links: makeMediaLinkSigner({ apiToken: config.apiToken, ttlSec: config.mediaLinkTtlSec, logger }),
    biasTermsFor: (chatId: string) => biasTermsFor(chatId, { messages, contacts }),
    // On, as the handler suites run it: a response the contract cannot describe is a 500 here
    // rather than something the client silently fails to parse three layers away.
    validateResponses: true,
  };
  const handlers: Handlers = {
    ...metaHandlers(deps),
    ...readHandlers(deps),
    ...mediaHandlers(deps),
    ...writeHandlers(deps),
  };

  const rest: RestHandle = await startRest(deps, handlers);
  await conn.start();
  await opts.socket.open();

  const handle: ApiHandle = {
    url: rest.url,
    socket: opts.socket,
    conn,
    close: async () => {
      await rest.close();
      await conn.stop();
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    },
  };
  cleanups.push(handle.close);
  return handle;
}

/** A port nothing is listening on. The MCP's `PORT` cannot be 0 — `envInt` rejects it as invalid. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

/** Spawn the real MCP against `apiUrl` and connect a real MCP client to it. */
async function bootMcp(apiUrl: string): Promise<McpHandle> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", MCP_MAIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      WHATSAPP_API_URL: apiUrl,
      WHATSAPP_API_TOKEN: API_TOKEN,
      WHATSAPP_MCP_TOKEN: MCP_TOKEN,
      PORT: String(port),
      LOG_LEVEL: "silent",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  const base = `http://127.0.0.1:${String(port)}`;
  // `/health` is public and ahead of the bearer gate, which is exactly what a container healthcheck
  // polls — so waiting on it is both the readiness probe and a first assertion that it is reachable
  // without a credential.
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the MCP exited with ${String(child.exitCode)}: ${stderr}`);
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok || res.status === 500) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`the MCP never came up on ${base}: ${stderr}`);
    // A real delay, deliberately: what is being waited on is a *separate OS process* binding a
    // socket. There is no in-process clock to advance and no event to await, so polling the
    // readiness endpoint the container healthcheck uses is the honest signal.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }

  const client = new Client({ name: "e2e", version: "0" });
  // Cast for the reason `packages/mcp/src/http.ts` documents on the server half: the transport is a
  // `Transport` at runtime, and its accessor-typed members trip `exactOptionalPropertyTypes`.
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}` } },
  }) as unknown as Parameters<Client["connect"]>[0];
  await client.connect(transport);

  const handle: McpHandle = {
    url: base,
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => {
          resolve();
        });
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000).unref();
      });
    },
  };
  cleanups.push(handle.close);
  return handle;
}

/** The writable pair, booted once: two processes per test would be most of this suite's runtime. */
let writable: Promise<{ api: ApiHandle; mcp: McpHandle }> | undefined = undefined;

function pair(): Promise<{ api: ApiHandle; mcp: McpHandle }> {
  writable ??= (async () => {
    const api = await bootApi({
      socket: fakeSocket({
        contacts: [{ id: ALICE, name: "Alice" }],
        messages: [
          textMessage({ id: "M1", ts: 1_700_000_000, text: "bonjour" }),
          documentMessage({ id: "D1", ts: 1_700_000_100, fileName: "notes.pdf" }),
        ],
      }),
    });
    return { api, mcp: await bootMcp(api.url) };
  })();
  return writable;
}

// ── the read path ─────────────────────────────────────────────────────────

void test("the real MCP tools answer through the real SDK client against the real API", async () => {
  const { mcp } = await pair();
  const page = resultPage(
    await mcp.client.callTool({ name: "whatsapp_messages_list", arguments: { chat: ALICE, limit: 10 } }),
  );

  const first = page.items.find((i) => i["id"] === "M1");
  assert.ok(first, `M1 must be in the page: ${JSON.stringify(page.items)}`);
  assert.equal(first["chat"], ALICE);
  assert.equal(first["text"], "bonjour");
  // Denormalised by the API from the contact ingest wrote — a name this process never sent and the
  // MCP cannot resolve, so it can only have come across the wire.
  assert.deepEqual(first["sender"], { id: ALICE, name: "Alice" });
  // The field a rename is most likely to drop, over the real wire this time.
  assert.equal(first["reaction_count"], 0);
  assert.equal(first["from_me"], false);
  assert.equal(page.nextCursor, null);
});

void test("a page's next_cursor round-trips through the real API", async () => {
  const { mcp } = await pair();
  const first = resultPage(await mcp.client.callTool({ name: "whatsapp_messages_list", arguments: { limit: 1 } }));
  assert.equal(first.items.length, 1);
  assert.equal(typeof first.nextCursor, "string", "two messages were ingested, so page one is not the last");

  const second = resultPage(
    await mcp.client.callTool({ name: "whatsapp_messages_list", arguments: { limit: 1, cursor: first.nextCursor } }),
  );
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0]?.["id"], first.items[0]?.["id"], "the cursor advanced");
});

void test("whatsapp_health merges the API's report with this process's reachability", async () => {
  const { mcp } = await pair();
  const data = resultJson(await mcp.client.callTool({ name: "whatsapp_health", arguments: {} }));

  assert.equal(data["ok"], true, "the socket is open, so the API says ok — and the MCP does not redefine it");
  assert.equal(data["connection"], "connected");
  assert.equal(typeof data["schema_version"], "number");
  assert.deepEqual(data["counts"], { chats: 1, messages: 2, contacts: 1 });
  const api = data["api"] as Record<string, unknown>;
  assert.equal(api["reachable"], true);
  assert.equal(api["error"], null);
  assert.equal(typeof api["latencyMs"], "number");
  // Neither secret may appear anywhere in what a model reads.
  const text = resultText(await mcp.client.callTool({ name: "whatsapp_health", arguments: {} }));
  assert.doesNotMatch(text, new RegExp(API_TOKEN));
  assert.doesNotMatch(text, new RegExp(MCP_TOKEN));
});

// ── the write path ────────────────────────────────────────────────────────

void test("whatsapp_send_text reaches the socket and the sent message comes back out of a read", async () => {
  const { api, mcp } = await pair();
  const before = api.socket.sends.length;

  const res = await mcp.client.callTool({
    name: "whatsapp_send_text",
    arguments: { chat: ALICE, text: "coucou depuis le e2e" },
  });
  assert.notEqual(res.isError, true, resultText(res));
  const sent = JSON.parse(resultText(res)) as { chat: string; message_id: string };
  assert.equal(sent.chat, ALICE, "the canonical chat the API resolved, not the string that went in");
  assert.match(sent.message_id, /^SENT\d+$/);

  const call = api.socket.sends[before];
  assert.ok(call, "the send must have reached the socket");
  assert.equal(call.jid, ALICE);
  assert.deepEqual(call.content, { text: "coucou depuis le e2e" });

  // Re-ingested by the API, so a read finds it: this is the full loop, MCP → API → socket → ingest
  // → SQLite → API → MCP.
  const page = resultPage(
    await mcp.client.callTool({ name: "whatsapp_messages_list", arguments: { chat: ALICE, from_me: true } }),
  );
  const echo = page.items.find((i) => i["id"] === sent.message_id);
  assert.ok(echo, `the sent message must be readable back: ${JSON.stringify(page.items)}`);
  assert.equal(echo["text"], "coucou depuis le e2e");
  assert.equal(echo["from_me"], true);
});

void test("whatsapp_mark_read marks the chat through to sock.readMessages", async () => {
  const { api, mcp } = await pair();
  const before = api.socket.reads.length;
  const res = await mcp.client.callTool({
    name: "whatsapp_mark_read",
    arguments: { chat: ALICE, message_id: "M1" },
  });
  assert.notEqual(res.isError, true, resultText(res));
  assert.deepEqual(JSON.parse(resultText(res)), { status: "ok", chat: ALICE, message_id: "M1" });
  assert.ok(api.socket.reads.length > before, "the read receipt must have reached the socket");
});

/**
 * The refusal the MCP stopped authoring.
 *
 * `packages/mcp`'s own suite asserts that both shapes are *forwarded* rather than pre-checked; this
 * is the other half — that the API really does refuse them, with the two sentences a model has
 * always read, and that the refusal survives the trip back as an `isError` rather than a protocol
 * fault. Without this pair of assertions the split would have quietly deleted a refusal.
 */
void test("the API refuses a send carrying neither or both of data and path, and the model reads why", async () => {
  const { mcp } = await pair();

  const neither = await mcp.client.callTool({ name: "whatsapp_send_file", arguments: { chat: ALICE } });
  assert.equal(neither.isError, true);
  assert.match(resultText(neither), /data|path/);

  const both = await mcp.client.callTool({
    name: "whatsapp_send_file",
    arguments: { chat: ALICE, data: "aGk=", path: "/tmp/x" },
  });
  assert.equal(both.isError, true);
  assert.match(resultText(both), /data|path/);

  // And a path at all is refused, because WHATSAPP_SEND_FILE_DIR is unset on this deployment —
  // never echoing the offending path back.
  const byPath = await mcp.client.callTool({
    name: "whatsapp_send_file",
    arguments: { chat: ALICE, path: "/etc/passwd" },
  });
  assert.equal(byPath.isError, true);
  assert.match(resultText(byPath), /WHATSAPP_SEND_FILE_DIR/);
  assert.doesNotMatch(resultText(byPath), /etc\/passwd/);
});

// ── media, and the one sanctioned change to what a model reads ─────────────

/**
 * Spec §7.1's first exception, proved rather than asserted.
 *
 * `GET /v1/media/:chat/:id/link` answers a **relative** reference — the API cannot know its own
 * public origin, and building one from a `Host` header would let a caller choose the origin of a
 * capability URL. The MCP resolves it against `WHATSAPP_API_URL`. Nothing but an e2e can show that
 * the resolved URL is one that actually serves the bytes: a unit test can only check the string.
 */
void test("whatsapp_download_media reports a url that really downloads the document", async () => {
  const { api, mcp } = await pair();
  const reuploadsBefore = api.socket.reuploads.length;

  const res = await mcp.client.callTool({
    name: "whatsapp_download_media",
    arguments: { chat: ALICE, message_id: "D1" },
  });
  assert.notEqual(res.isError, true, resultText(res));

  const blocks = (res.content ?? []) as { type: string; text?: string }[];
  const summaryBlock = blocks.find((b) => b.type === "text" && b.text?.startsWith("{") === true)?.text;
  assert.ok(summaryBlock !== undefined, `expected a JSON summary: ${resultText(res)}`);
  const summary = JSON.parse(summaryBlock) as Record<string, unknown>;

  assert.equal(summary["chat"], ALICE);
  assert.equal(summary["message_id"], "D1");
  assert.equal(summary["kind"], "document");
  assert.equal(summary["bytes"], FAKE_MEDIA_BYTES.length);
  assert.equal(summary["path"], undefined, "the API's filesystem is not a fact anyone here has");

  const url = summary["url"];
  assert.ok(typeof url === "string", `the summary must carry a url: ${JSON.stringify(summary)}`);
  assert.ok(url.startsWith(api.url), `the relative link must be resolved against the API base: ${url}`);

  // Unauthenticated on purpose: that is what makes a link shareable. If the MCP had resolved it
  // against the wrong base, or the API had signed a token this route rejects, this is where it
  // shows — and nowhere else.
  const downloaded = await fetch(url);
  const body = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(downloaded.status, 200, `the minted link must serve the bytes: ${body.toString("utf8")}`);
  assert.deepEqual(body, FAKE_MEDIA_BYTES);

  // Minting the link resolved the attachment, which took the cache-miss path — and that is the path
  // `updateMediaMessage` sits on.
  assert.ok(api.socket.reuploads.length > reuploadsBefore, "the download must have gone through reuploadRequest");
});

void test("whatsapp_download_media refuses a message the API has never seen, by name", async () => {
  const { mcp } = await pair();
  const res = await mcp.client.callTool({
    name: "whatsapp_download_media",
    arguments: { chat: ALICE, message_id: "M404" },
  });
  assert.equal(res.isError, true);
  // The class travelled as a `name` on the wire and came back out of `errorFromWire` intact.
  assert.match(resultText(res), /^MessageNotFoundError: no message M404 in chat /);
});

void test("whatsapp_transcribe reports the API's refusal when no backend is configured", async () => {
  const { mcp } = await pair();
  const res = await mcp.client.callTool({ name: "whatsapp_transcribe", arguments: { chat: ALICE, message_id: "D1" } });
  assert.equal(res.isError, true);
  assert.ok(resultText(res).length > 0);
  assert.doesNotMatch(resultText(res), /\n\s+at /, "a stack trace never reaches the model");
});

// ── the read-only deployment ──────────────────────────────────────────────

void test("a read-only API makes the MCP advertise eight tools", async () => {
  const api = await bootApi({ readOnly: true, socket: fakeSocket() });
  const mcp = await bootMcp(api.url);

  const names = (await mcp.client.listTools()).tools.map((t) => t.name).sort();
  assert.equal(names.length, 8, `expected eight tools, got ${names.join(", ")}`);
  for (const write of [
    "whatsapp_send_text",
    "whatsapp_send_file",
    "whatsapp_react",
    "whatsapp_mark_read",
    "whatsapp_edit_message",
    "whatsapp_delete_message",
  ]) {
    assert.ok(!names.includes(write), `${write} must not be advertised against a read-only API`);
  }
  assert.ok(names.includes("whatsapp_download_media"), "read-only is not blind");

  // The flag came from `GET /v1/capabilities` per session, and the MCP process was configured
  // identically to the writable one — the only difference is the API's answer.
  assert.equal(resultJson(await mcp.client.callTool({ name: "whatsapp_health", arguments: {} }))["read_only"], true);
});

// ── the gate in front of it all ───────────────────────────────────────────

void test("the MCP endpoint refuses a client with no bearer, and /health does not", async () => {
  const { mcp } = await pair();

  const unauthorized = await fetch(`${mcp.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");
  const body = await unauthorized.text();
  assert.doesNotMatch(body, new RegExp(MCP_TOKEN), "a refusal never echoes either side of the credential");

  const health = await fetch(`${mcp.url}/health`);
  assert.equal(health.status, 200, "the container healthcheck must not need the secret");
  const report = (await health.json()) as Record<string, unknown>;
  assert.equal(report["ok"], true);
  assert.equal((report["api"] as Record<string, unknown>)["reachable"], true);
});
