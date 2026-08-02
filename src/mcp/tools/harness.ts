/**
 * Test-only scaffolding: a real SQLite store, a real `McpServer`, and a linked in-memory MCP client,
 * so a test exercises tools the way a model does — over the wire, through the SDK's schema
 * validation — rather than by calling a handler function directly.
 *
 * It is deliberately **not** a `.test.ts` file, so Task 13's tests can import it without running
 * Task 12's. That also means `tsconfig.build.json`'s `*.test.ts` exclusion glob does not cover it, so
 * its path is listed in that file's `exclude` array explicitly — otherwise this ships in `dist/`.
 *
 * Import paths verified against `@modelcontextprotocol/sdk@1.30.0`: its exports map ends in a `"./*"`
 * wildcard, which is what makes `server/mcp.js`, `client/index.js` and `inMemory.js` resolve.
 *
 * **The `build` seam.** Task 12 has no `src/mcp/server.ts` yet, so the default builder registers the
 * read tools onto a bare `McpServer`. Task 13 passes `build: buildMcpServer` and needs no change
 * here. The seam is the whole server factory rather than a "register these tools" callback on
 * purpose: `buildMcpServer` is what owns server construction *and* the read-only tool gating, so a
 * registration-only seam would force Task 13's tests to re-implement that gating and therefore stop
 * testing it.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../config.js";
import { makeChatsRepo } from "../../db/chats.js";
import { closeDb, openDb } from "../../db/client.js";
import { makeContactsRepo } from "../../db/contacts.js";
import { makeMessagesRepo } from "../../db/messages.js";
import { makeMetaRepo } from "../../db/meta.js";
import { makeReactionsRepo } from "../../db/reactions.js";
import type { MediaFile, MediaStore } from "../../media/store.js";
import type { Transcriber } from "../../media/transcribe.js";
import {
  ConnectionUnavailableError,
  type ConnectionState,
  type WhatsAppConnection,
} from "../../whatsapp/connection.js";
import { FIXTURE_SELF } from "../../whatsapp/fixtures.js";
import type { Sender } from "../../whatsapp/send.js";
import type { ToolContext } from "../context.js";
import { registerReadTools } from "./reads.js";

export type HarnessOptions = {
  readOnly?: boolean | undefined;
  state?: ConnectionState | undefined;
  /** Seconds since the connection last saw an event. Health reports it; 0 means "just now". */
  lastEventAgeSec?: number | undefined;
  transcriptionAvailable?: boolean | undefined;
  seed?: ((ctx: ToolContext) => void) | undefined;
  overrides?: Partial<ToolContext> | undefined;
  /** How the server under test is built. Defaults to the read tools alone; Task 13 passes `buildMcpServer`. */
  build?: ((ctx: ToolContext) => McpServer) | undefined;
};

export type Harness = {
  client: Client;
  server: McpServer;
  ctx: ToolContext;
  /** How many times the stub transcriber actually ran. Task 13's caching tests read this. */
  transcribeCalls: { n: number };
  dir: string;
  close: () => Promise<void>;
};

/**
 * Imported rather than spelled out here: Constraint 11's enforcing check excludes `*.test.ts`,
 * `src/whatsapp/jid.ts` and `src/whatsapp/fixtures.ts` and nothing else, so a JID literal in this file — which
 * is scaffolding, not a test — is a hit the check has no way to forgive. Keeping every test-data
 * JID in `fixtures.ts` keeps that command a clean signal instead of one with a known exception.
 */
const SELF_ID = FIXTURE_SELF;

/** Global Constraint 17: every timestamp is integer Unix seconds, never `Date.now()` milliseconds. */
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function defaultBuild(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "whatsapp-mcp-test", version: "0.0.0" });
  registerReadTools(server, ctx);
  return server;
}

/** Build a real store, a real `McpServer`, and a linked in-memory client. */
export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "whatsapp-mcp-"));
  const db = openDb(join(dir, "t.db"));
  const state: ConnectionState = opts.state ?? "connected";
  const transcribeCalls = { n: 0 };

  // A real Config, not a hand-built partial: a stub would let a field this layer starts reading
  // tomorrow go missing without a compile error.
  const config: Config = { ...loadConfig({ WHATSAPP_DATA_DIR: dir }), readOnly: opts.readOnly ?? false };

  const conn: WhatsAppConnection = {
    snapshot: () => ({
      state,
      lastEventAt: nowSec() - (opts.lastEventAgeSec ?? 0),
      lastConnectedAt: state === "connected" ? nowSec() : null,
      attempts: 0,
      needsPairing: state === "pairing" || state === "logged_out",
      selfId: SELF_ID,
    }),
    requireSocket: () => {
      throw new ConnectionUnavailableError(state);
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    onStateChange: () => undefined,
  };

  /**
   * The stub sender refuses whatever the real one refuses on connection grounds: `makeSender` calls
   * `conn.requireSocket()` as the first statement of every method, so a stub that resolved happily
   * while the socket is down would be a lie — and it would leave a write tool's mapping of that
   * failure into an `isError` result untestable through the harness.
   */
  const refuse = (): Promise<never> => Promise.reject(new ConnectionUnavailableError(state));
  const connected = state === "connected";
  // Every method answers with chat `"c"` and never with the id it was handed: the real sender
  // canonicalizes what the caller passed (a LID and its phone JID are one conversation), so a stub
  // echoing the input would let a tool that reports the caller's own string back to it pass.
  const sender: Sender = {
    sendText: () => (connected ? Promise.resolve({ chatId: "c", messageId: "S1" }) : refuse()),
    sendFile: () => (connected ? Promise.resolve({ chatId: "c", messageId: "S2" }) : refuse()),
    react: () => (connected ? Promise.resolve({ chatId: "c" }) : refuse()),
    markRead: () => (connected ? Promise.resolve({ chatId: "c" }) : refuse()),
    editMessage: () => (connected ? Promise.resolve({ chatId: "c" }) : refuse()),
    deleteMessage: () => (connected ? Promise.resolve({ chatId: "c" }) : refuse()),
  };

  const media: MediaStore = {
    fetch: () =>
      Promise.resolve<MediaFile>({ path: "/dev/null", sha256: "a".repeat(64), bytes: 1, mimetype: "image/jpeg" }),
    pathFor: (sha256: string) => join(dir, "media", sha256),
  };

  const transcriber: Transcriber = {
    ensureModel: () => Promise.resolve(join(dir, "models", "x.bin")),
    transcribeFile: () => {
      transcribeCalls.n++;
      return Promise.resolve("transcrit");
    },
    available: () => Promise.resolve(opts.transcriptionAvailable ?? true),
  };

  const ctx: ToolContext = {
    config,
    logger: silentLogger(),
    chats: makeChatsRepo(db),
    contacts: makeContactsRepo(db),
    messages: makeMessagesRepo(db),
    reactions: makeReactionsRepo(db),
    meta: makeMetaRepo(db),
    conn,
    sender,
    media,
    transcriber,
    ...opts.overrides,
  };

  opts.seed?.(ctx);

  const server = (opts.build ?? defaultBuild)(ctx);
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    server,
    ctx,
    transcribeCalls,
    dir,
    close: async () => {
      await client.close();
      await server.close();
      closeDb(db);
    },
  };
}

/**
 * A pino-shaped no-op. Tests assert on results, not on log lines, and a real pino instance would
 * write every `logger.info` to the test runner's stdout.
 */
function silentLogger(): ToolContext["logger"] {
  const noop = (): void => undefined;
  const self = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, level: "silent" };
  return { ...self, child: () => self } as unknown as ToolContext["logger"];
}

/**
 * Whatever `client.callTool` came back with.
 *
 * The index signature is load-bearing, not decoration: `callTool` is typed as a union with the
 * pre-2024-10 `{ toolResult }` shape, and a type whose properties are *all* optional is a "weak
 * type" that member cannot satisfy.
 */
export type RawToolResult = { content?: unknown; isError?: unknown; [key: string]: unknown };

/** The text of a tool result, for a test that wants to parse or match it. */
export function resultText(res: RawToolResult): string {
  const content = (res.content ?? []) as { type: string; text?: string }[];
  return content.map((b) => b.text ?? "").join("\n");
}

/** The JSON a read tool returned. Throws if the tool answered with an error instead. */
export function resultJson(res: RawToolResult): Record<string, unknown> {
  const text = resultText(res);
  if (res.isError === true) throw new Error(`expected a successful tool result, got: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/** The `{ items, next_cursor }` envelope every paginated read tool returns. */
export function resultPage(res: RawToolResult): { items: Record<string, unknown>[]; nextCursor: string | null } {
  const json = resultJson(res);
  return {
    items: json["items"] as Record<string, unknown>[],
    nextCursor: json["next_cursor"] as string | null,
  };
}
