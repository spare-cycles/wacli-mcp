/**
 * Test-only scaffolding: an in-memory API, a real `McpServer`, and a linked in-memory MCP client, so
 * a test exercises the fourteen tools the way a model does — over the wire, through the MCP SDK's
 * own schema validation — rather than by calling a handler function directly.
 *
 * It is the successor to `packages/api/src/mcp/tools/harness.ts`, and it deliberately **keeps that
 * file's affordances**: tests reach it only through `h.client.callTool`, `h.client.listTools`,
 * `h.client.getServerVersion` and the three helpers `resultText`/`resultJson`/`resultPage`. The
 * ported suites' assertions therefore did not have to change to accommodate the harness itself —
 * which is the whole point, because an assertion that changed for a reason nobody can name is
 * exactly how a byte of tool output goes missing.
 *
 * **What replaced the SQLite store is `FakeApi`, and its type is the guarantee.** `FakeApi` extends
 * `WhatsAppApiClient`, which is `{ [K in keyof Routes]: ClientMethod<Routes[K]> }` — generated from
 * the same route table the real client is generated from. So a route whose params, query, body or
 * response shape drifts is a **compile error in this file**, not a suite that keeps passing against
 * a stale fake. Nothing here is hand-typed against a shape written out twice.
 *
 * **Three deliberate quirks are carried over from the retired harness**, because each of them
 * catches a class of bug that a friendlier fake would hide:
 *
 * 1. Every write answers with chat `"c"` and never with the id it was handed. The real API
 *    canonicalises what the caller passed — a LID and its phone JID are one conversation — so a
 *    fake that echoed the input would let a tool reporting the caller's own string back to it pass.
 * 2. The refusals are the API's real ones, word for word: the cursor message from
 *    `packages/api/src/rest/cursor.ts`, the `contradicts kind="…"` sentence from
 *    `rest/handlers/reads.ts`, `no message <id> in chat <chat>` from `rest/handlers/subject.ts`.
 *    What is under test is that the MCP renders them unchanged, so an approximation would test
 *    nothing.
 * 3. Filtering and paging are implemented, not stubbed away. They are the *API's* semantics and
 *    `packages/api`'s own suites are what pin them; what these reproductions buy is that the ported
 *    read tests can keep asserting on ids, which is what makes an argument this layer renames
 *    (`is_group` → `isGroup`, `unread_only` → `unread`, `query` → `q`) visible as a wrong answer
 *    rather than only as a recorded call nobody looked at. `h.api.calls` is there for the cases
 *    where the recorded call is the assertion.
 *
 * The fake is **not** a second implementation of the API and must never become one: it answers from
 * arrays. The only thing standing between it and the real API drifting apart is `packages/e2e`,
 * which drives the real pair; that test is not optional and this file is why.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BadRequestError,
  CONTRACT_VERSION,
  MessageNotFoundError,
  type BinaryPayload,
  type Capabilities,
  type Chat,
  type ConnectionState,
  type Contact,
  type HealthReport,
  type JpegDerivative,
  type KeyframeStrip,
  type MediaLink,
  type MediaMeta,
  type MediaTranscript,
  type Message,
  type MessageDetail,
  type PdfExtract,
  type RecipientResolution,
  type RouteKey,
  type SearchHit,
  type SendResult,
  type Transcript,
  type WhatsAppApiClient,
} from "whatsapp-api-sdk";

import { loadConfig, type McpConfig } from "../config.js";
import type { ToolContext } from "../context.js";
import { silentLogger } from "../logger.js";
import { buildMcpServer } from "../server.js";

/** The account under test. Mirrors `packages/api`'s `FIXTURE_SELF`, which this package cannot import. */
export const SELF_ID = "33600000000@s.whatsapp.net";

/** One call a tool made, in the order it made it. */
export type ApiCall = { route: RouteKey; input: unknown };

/**
 * The rows and canned responses the fake answers from.
 *
 * `chats` holds groups too — `listGroups` is `listChats` with `isGroup` forced, exactly as the API's
 * two routes are two views of one table — so a test cannot seed a group into one listing and not
 * the other.
 */
export type FakeData = {
  health: HealthReport;
  capabilities: Capabilities;
  chats: Chat[];
  contacts: Contact[];
  messages: Message[];
  /** Hits in relevance order. Seeded separately from `messages`: FTS ranking is not a filter. */
  hits: SearchHit[];
  /** Keyed by `chat\u0000id`. Use `putDetail` rather than writing the key by hand. */
  details: Map<string, MessageDetail>;
  jpeg: JpegDerivative;
  keyframes: KeyframeStrip;
  meta: MediaMeta;
  link: MediaLink;
  pdf: PdfExtract;
  transcript: MediaTranscript;
  /** What `POST …/transcribe` produces. `null` makes the route reject the way a failed run does. */
  transcribed: Transcript;
  binary: BinaryPayload;
  recipients: RecipientResolution;
};

export type FakeApi = WhatsAppApiClient & {
  data: FakeData;
  calls: ApiCall[];
  /** Register a single-message detail under the key `getMessage` will look for. */
  putDetail: (detail: MessageDetail) => void;
  /** How many times a route was called. The successor to the retired harness's `transcribeCalls`. */
  countCalls: (route: RouteKey) => number;
  /** The input of the nth call to a route, or `undefined`. */
  inputOf: (route: RouteKey, n?: number) => unknown;
};

export type HarnessOptions = {
  /** What `GET /v1/capabilities` reports. Eight tools when true, fourteen when false. */
  readOnly?: boolean | undefined;
  state?: ConnectionState | undefined;
  /** Seconds since the API's connection last saw an event. Its health report carries it. */
  lastEventAgeSec?: number | undefined;
  transcriptionAvailable?: boolean | undefined;
  /** Overrides `WHATSAPP_MCP_MAX_RESULT_CHARS`, which is what the truncation tests turn down. */
  maxResultChars?: number | undefined;
  /** Extra environment for `loadConfig`. `WHATSAPP_API_URL` is supplied unless overridden. */
  env?: NodeJS.ProcessEnv | undefined;
  seed?: ((fake: FakeApi) => void) | undefined;
  overrides?: Partial<FakeApi> | undefined;
};

export type Harness = {
  client: Client;
  server: McpServer;
  ctx: ToolContext;
  /** The fake the tools talked to: its rows, and every call they made. */
  api: FakeApi;
  config: McpConfig;
  close: () => Promise<void>;
};

/** The prefix that makes the fake's cursor recognisably opaque, and recognisably not the API's. */
const CURSOR_PREFIX = "fake-cursor:";

/**
 * The API's own cursor refusal, verbatim from `packages/api/src/rest/cursor.ts`.
 *
 * Copied rather than imported: `packages/mcp` may not depend on `packages/api` at all, and the
 * string is part of what a model reads, so a paraphrase here would let a paraphrase there pass.
 */
const CURSOR_MESSAGE =
  "invalid pagination cursor: pass back the `next_cursor` from a previous page verbatim, or omit it to start over";

/** Which kinds carry an attachment, mirroring `packages/api`'s `MEDIA_KINDS`. */
const MEDIA_KINDS: readonly string[] = ["image", "video", "audio", "document", "sticker"];

/**
 * The offset a cursor names — or the API's refusal, as a `BadRequestError` carrying `CursorError`.
 *
 * `bad_request` with `name: "CursorError"` is exactly what the wire carries for this failure, and
 * `describeError` renders the name, so the model reads `CursorError: invalid pagination cursor: …`
 * on both sides of the split. See the note in `packages/sdk/src/errors.ts` on why there is no
 * `CursorError` class to construct here.
 */
function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const rest = cursor.startsWith(CURSOR_PREFIX) ? cursor.slice(CURSOR_PREFIX.length) : undefined;
  const n = rest === undefined ? Number.NaN : Number(rest);
  if (!Number.isSafeInteger(n) || n < 0) throw new BadRequestError(CURSOR_MESSAGE, { name: "CursorError" });
  return n;
}

/** One page out of a filtered list, plus the cursor onto the next — `null` when this was the last. */
function paginate<T>(rows: readonly T[], limit: number | undefined, cursor: string | undefined) {
  const offset = offsetOf(cursor);
  const size = limit ?? 50;
  const items = rows.slice(offset, offset + size);
  const nextCursor = offset + size < rows.length ? `${CURSOR_PREFIX}${String(offset + size)}` : null;
  return { nextCursor, items };
}

/** The API's contradiction refusal, word for word — `rest/handlers/reads.ts`. */
function refuseContradiction(kind: string | undefined, hasMedia: boolean | undefined): void {
  if (kind === undefined || hasMedia === undefined) return;
  const carries = MEDIA_KINDS.includes(kind);
  if (carries === hasMedia) return;
  throw new BadRequestError(
    `hasMedia=${String(hasMedia)} contradicts kind="${kind}", which ` +
      `${carries ? "always carries" : "never carries"} an attachment — drop one of the two`,
  );
}

/** The narrowing both message routes accept, applied to a seeded row. */
type MessageFilter = {
  chat?: string | undefined;
  sender?: string | undefined;
  fromMe?: boolean | undefined;
  kind?: string | undefined;
  hasMedia?: boolean | undefined;
  after?: number | undefined;
  before?: number | undefined;
};

function matchesFilter(m: Message, f: MessageFilter): boolean {
  if (f.chat !== undefined && m.chat !== f.chat) return false;
  if (f.sender !== undefined && m.sender.id !== f.sender) return false;
  if (f.fromMe !== undefined && m.fromMe !== f.fromMe) return false;
  if (f.kind !== undefined && m.kind !== f.kind) return false;
  if (f.hasMedia !== undefined && (m.media !== null) !== f.hasMedia) return false;
  if (f.after !== undefined && m.ts < f.after) return false;
  if (f.before !== undefined && m.ts > f.before) return false;
  return true;
}

const contains = (haystack: string | null, needle: string): boolean =>
  haystack?.toLowerCase().includes(needle.toLowerCase()) ?? false;

const A_JPEG_BYTE_STRING = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]).toString("base64");

function defaultData(opts: HarnessOptions): FakeData {
  const state: ConnectionState = opts.state ?? "connected";
  // Global Constraint 17: integer Unix seconds, never `Date.now()` milliseconds.
  const now = Math.floor(Date.now() / 1000);
  return {
    health: {
      // The API's own rule, and the one `whatsapp_health` must not redefine: false only when the
      // account has been logged out. See `health.ts`.
      ok: state !== "logged_out",
      connection: state,
      needs_pairing: state === "pairing" || state === "logged_out",
      last_event_age_sec: opts.lastEventAgeSec ?? 0,
      last_connected_at: state === "connected" ? now : null,
      last_message_at: null,
      self_id: SELF_ID,
      counts: { chats: 0, messages: 0, contacts: 0 },
      schema_version: 7,
      transcription_available: opts.transcriptionAvailable ?? true,
      auto_transcribe: null,
      read_only: opts.readOnly ?? false,
    },
    capabilities: {
      apiVersion: "1.0.0",
      contractVersion: CONTRACT_VERSION,
      readOnly: opts.readOnly ?? false,
      maxUploadBytes: 64 * 1024 * 1024,
      features: {
        transcription: opts.transcriptionAvailable ?? true,
        autoTranscribe: false,
        mediaLinks: true,
      },
    },
    chats: [],
    contacts: [],
    messages: [],
    hits: [],
    details: new Map<string, MessageDetail>(),
    jpeg: {
      data: A_JPEG_BYTE_STRING,
      mimeType: "image/jpeg",
      width: 160,
      height: 120,
      source: { bytes: 4242, mimetype: "image/png" },
    },
    keyframes: {
      durationSec: 2.4,
      width: 320,
      height: 240,
      frames: [0, 1, 2, 3].map((index) => ({
        index,
        atSec: index * 0.5,
        mimeType: "image/jpeg",
        data: A_JPEG_BYTE_STRING,
      })),
      source: { bytes: 99_000, mimetype: "video/mp4" },
    },
    meta: {
      mimetype: "audio/ogg; codecs=opus",
      bytes: 7_000,
      width: null,
      height: null,
      durationSec: 2.4,
      hasTranscript: false,
      sha256: "b".repeat(64),
    },
    link: {
      // Relative on purpose: the API cannot know its own public origin, and resolving it against
      // `WHATSAPP_API_URL` is the MCP's job. A fake that answered an absolute URL would make the
      // one line under test — `new URL(link.url, ctx.config.apiUrl)` — a no-op.
      url: "/media/dl/tok3n",
      expiresAt: now + 900,
      mimeType: "application/octet-stream",
      bytes: 1024,
      filename: "notes.bin",
    },
    pdf: { text: "le contenu du document", truncated: false },
    transcript: null,
    transcribed: { text: "transcrit", model: "test-model", language: "fr" },
    binary: { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/octet-stream" },
    recipients: { candidates: [] },
  };
}

/**
 * The in-memory API.
 *
 * Declared `WhatsAppApiClient` — not a hand-written interface that resembles one — so every method
 * below is checked against the route table: a wrong input shape, a missing route or a response the
 * schema could never produce is a compile error here.
 */
export function makeFakeApi(opts: HarnessOptions = {}): FakeApi {
  const data = defaultData(opts);
  const calls: ApiCall[] = [];
  const record = <T>(route: RouteKey, input: unknown, answer: () => T): T => {
    calls.push({ route, input });
    return answer();
  };

  const detailFor = (chat: string, id: string): MessageDetail => {
    const found = data.details.get(`${chat}\u0000${id}`);
    // The API's own sentence, from `rest/handlers/subject.ts`.
    if (found === undefined) throw new MessageNotFoundError(`no message ${id} in chat ${chat}`);
    return found;
  };

  /** Every write answers `"c"`, never the caller's string. See quirk 1 in the file note. */
  const sent = (messageId: string): SendResult => ({ chat: "c", messageId });

  const api: FakeApi = {
    data,
    calls,
    putDetail: (detail) => {
      data.details.set(`${detail.chat}\u0000${detail.id}`, detail);
    },
    countCalls: (route) => calls.filter((c) => c.route === route).length,
    inputOf: (route, n = 0) => calls.filter((c) => c.route === route)[n]?.input,

    getHealth: () => record("getHealth", undefined, () => Promise.resolve(data.health)),
    capabilities: () => record("capabilities", undefined, () => Promise.resolve(data.capabilities)),

    listChats: (input) =>
      record("listChats", input, () => {
        const { query, isGroup, archived, unread, limit, cursor } = input.query;
        const rows = data.chats.filter(
          (c) =>
            (query === undefined || contains(c.name, query)) &&
            (isGroup === undefined || c.isGroup === isGroup) &&
            (archived === undefined || c.archived === archived) &&
            (unread === undefined || c.unreadCount > 0 === unread),
        );
        return Promise.resolve(paginate(rows, limit, cursor));
      }),

    listGroups: (input) =>
      record("listGroups", input, () => {
        const rows = data.chats.filter((c) => c.isGroup);
        return Promise.resolve(paginate(rows, input.query.limit, input.query.cursor));
      }),

    listContacts: (input) =>
      record("listContacts", input, () => {
        const { query, limit, cursor } = input.query;
        const rows = data.contacts.filter(
          (c) =>
            query === undefined ||
            contains(c.name, query) ||
            contains(c.notify, query) ||
            contains(c.phoneNumber, query),
        );
        return Promise.resolve(paginate(rows, limit, cursor));
      }),

    listMessages: (input) =>
      record("listMessages", input, () => {
        const { asc, limit, cursor, ...filter } = input.query;
        refuseContradiction(filter.kind, filter.hasMedia);
        const rows = data.messages.filter((m) => matchesFilter(m, filter));
        // Seeded oldest-first; the API answers newest-first unless `asc`.
        const ordered = asc === true ? rows : [...rows].reverse();
        return Promise.resolve(paginate(ordered, limit, cursor));
      }),

    searchMessages: (input) =>
      record("searchMessages", input, () => {
        const { q, limit, cursor, ...filter } = input.query;
        refuseContradiction(filter.kind, filter.hasMedia);
        const rows = data.hits.filter(
          (h) => matchesFilter(h, filter) && (contains(h.text, q) || contains(h.transcript, q)),
        );
        return Promise.resolve(paginate(rows, limit, cursor));
      }),

    getMessage: (input) =>
      record("getMessage", input, () => Promise.resolve(detailFor(input.params.chat, input.params.id))),

    fetchMedia: (input) => record("fetchMedia", input, () => Promise.resolve(data.binary)),
    fetchMediaJpeg: (input) => record("fetchMediaJpeg", input, () => Promise.resolve(data.jpeg)),
    fetchMediaLink: (input) => record("fetchMediaLink", input, () => Promise.resolve(data.link)),
    fetchMediaKeyframes: (input) => record("fetchMediaKeyframes", input, () => Promise.resolve(data.keyframes)),
    fetchMediaText: (input) => record("fetchMediaText", input, () => Promise.resolve(data.pdf)),
    fetchMediaTranscript: (input) => record("fetchMediaTranscript", input, () => Promise.resolve(data.transcript)),
    fetchMediaMeta: (input) => record("fetchMediaMeta", input, () => Promise.resolve(data.meta)),

    sendText: (input) => record("sendText", input, () => Promise.resolve(sent("S1"))),
    sendFile: (input) => record("sendFile", input, () => Promise.resolve(sent("S2"))),
    editMessage: (input) => record("editMessage", input, () => Promise.resolve(sent(input.params.id))),
    deleteMessage: (input) => record("deleteMessage", input, () => Promise.resolve(sent(input.params.id))),
    react: (input) => record("react", input, () => Promise.resolve(sent(input.params.id))),
    markRead: (input) => record("markRead", input, () => Promise.resolve(sent(input.body.messageId))),
    transcribe: (input) => record("transcribe", input, () => Promise.resolve(data.transcribed)),
    resolveRecipient: (input) => record("resolveRecipient", input, () => Promise.resolve(data.recipients)),

    fetchSignedMedia: (input) => record("fetchSignedMedia", input, () => Promise.resolve(data.binary)),

    ...opts.overrides,
  };
  return api;
}

/** Build a fake API, a real `McpServer` over it, and a linked in-memory client. */
export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const api = makeFakeApi(opts);
  opts.seed?.(api);

  // A real `McpConfig`, not a hand-built partial: a stub would let a field this layer starts
  // reading tomorrow go missing without a compile error.
  const config = loadConfig({ WHATSAPP_API_URL: "http://api:8080", ...opts.env });
  if (opts.maxResultChars !== undefined) config.maxResultChars = opts.maxResultChars;

  const ctx: ToolContext = { config, logger: silentLogger(), client: api };

  // The real builder, always: the read-only gate is a property of `buildMcpServer`, so a harness
  // that registered tools itself would stop testing the thing the gate is.
  const server = buildMcpServer(ctx, api.data.capabilities);
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    server,
    ctx,
    api,
    config,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
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

/** The `{ next_cursor, items }` envelope every paginated read tool returns. */
export function resultPage(res: RawToolResult): { items: Record<string, unknown>[]; nextCursor: string | null } {
  const json = resultJson(res);
  return {
    items: json["items"] as Record<string, unknown>[],
    nextCursor: json["next_cursor"] as string | null,
  };
}
