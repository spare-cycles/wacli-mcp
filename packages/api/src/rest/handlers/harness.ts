/**
 * Test-only scaffolding for the three handler suites: a real SQLite store, a real media-link
 * signer, and a real Express listener on an ephemeral port.
 *
 * **Every suite drives a real socket rather than calling a handler directly.** Half of what these
 * tasks own is only observable from outside — a status code, a `content-disposition`, a header the
 * server sets rather than the handler, the JSON envelope `implement()` writes — and a unit test
 * against the handler function sees none of it.
 *
 * `validateResponses` is on, which is the split `ImplementOptions` argues for: a handler that
 * answered a millisecond timestamp is a 500 in the test that caused it rather than a `ZodError` in
 * another process later.
 *
 * Three collaborators are stubbed, and only three: the socket, the sender and the transcriber. Each
 * is a network at the far end. The repositories, the cursor, the presenters, the signer, the
 * conversions and the media cache are all real, because they are what the handlers are made of.
 *
 * Not a `*.test.ts` file, so it is named one by one in `tsconfig.build.json`'s `exclude` — see
 * `CLAUDE.md`'s note about scaffolding that would otherwise ship in the image as dead code.
 */

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Handlers } from "whatsapp-api-sdk";

import { loadConfig, type Config } from "../../config.js";
import { makeChatsRepo } from "../../db/chats.js";
import { closeDb, openDb } from "../../db/client.js";
import { makeContactsRepo } from "../../db/contacts.js";
import { makeMessagesRepo, type MessageKind, type MessagesRepo } from "../../db/messages.js";
import { makeMetaRepo } from "../../db/meta.js";
import { makeReactionsRepo } from "../../db/reactions.js";
import type { AutoTranscriber } from "../../media/autotranscribe.js";
import { MediaUnavailableError, type MediaFile, type MediaStore } from "../../media/store.js";
import type { Transcript, Transcriber } from "../../media/transcribe.js";
import {
  ConnectionUnavailableError,
  type ConnectionState,
  type WhatsAppConnection,
} from "../../whatsapp/connection.js";
import { FIXTURE_SELF } from "../../whatsapp/fixtures.js";
import type { ChatRef, SendRef, Sender } from "../../whatsapp/send.js";
import { makeMediaLinkSigner } from "../medialink.js";
import { startRest, type RestDeps, type RestHandle } from "../server.js";
import { mediaHandlers } from "./media.js";
import { readHandlers } from "./reads.js";
import { writeHandlers } from "./writes.js";

export const TOKEN = "s3cr3t-api-token";

/** One captured log line, with the object pino would have serialised beside it. */
export type LogEntry = { level: string; obj: Record<string, unknown>; msg: string };

/** What a stubbed `Sender` method was called with, so a test can assert on the arguments. */
export type SendCall = { method: string; args: readonly unknown[] };

export type HarnessOptions = {
  readOnly?: boolean | undefined;
  state?: ConnectionState | undefined;
  apiToken?: string | undefined;
  /** Epoch **seconds**. Only the media-link signer reads it, so a test can expire a token. */
  now?: (() => number) | undefined;
  /** Overrides on the loaded `Config`, for the ceilings the media routes bound against. */
  config?: Partial<Config> | undefined;
  /** What every `Sender` method resolves to. Absent means a plain accepted send. */
  sendResult?: SendRef | undefined;
  /** Thrown by every `Sender` method instead of resolving. */
  sendError?: (() => Error) | undefined;
  /** What the stub transcriber answers. Absent means a fixed French transcript. */
  transcript?: Transcript | undefined;
  transcribeError?: (() => Error) | undefined;
  autoTranscriber?: AutoTranscriber | undefined;
  /**
   * Wrap or replace a dependency **before** the handler groups are built.
   *
   * The factories close over what they are handed, so a test that swaps `h.deps.reactions`
   * afterwards instruments nothing. This is the seam for a counting repository.
   */
  instrument?: ((deps: RestDeps) => void) | undefined;
};

export type Harness = {
  deps: RestDeps;
  url: string;
  dir: string;
  entries: LogEntry[];
  /** Every `Sender` call, in order. `transcribeCalls` counts the transcriber the same way. */
  sendCalls: SendCall[];
  transcribeCalls: { n: number };
  /** Register an attachment for `(chatId, messageId)` and write its bytes into the media cache. */
  attach: (chatId: string, messageId: string, bytes: Buffer, mimetype: string) => MediaFile;
  /** Insert a chat and its messages. Chats first: `messages.chat_id` has a foreign key onto them. */
  seed: (chatId: string, isGroup: boolean, messages: readonly SeedMessage[]) => void;
  /** A bearer-authenticated request against a path on this server. */
  req: (path: string, init?: RequestInit) => Promise<Response>;
  /** The same, parsed as JSON. Asserts nothing: a test reads the status off `req` when it cares. */
  json: <T>(path: string, init?: RequestInit) => Promise<T>;
  /** A request with **no** `Authorization` header, for the signed download. */
  anon: (path: string) => Promise<Response>;
  close: () => Promise<void>;
};

/** `text: null` means the message carries none at all, which is what a voice note looks like. */
export type SeedMessage = {
  id: string;
  ts: number;
  text?: string | null;
  kind?: MessageKind;
  sender?: string | undefined;
  fromMe?: boolean;
  transcript?: Transcript | undefined;
};

/** A logger that records instead of printing, and keeps the object it was handed for inspection. */
function captureLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
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
    trace: record("trace"),
    fatal: record("fatal"),
  } as unknown as Logger;
  return { logger, entries };
}

/**
 * Everything captured, rendered the way pino would put it on disk.
 *
 * An `Error`'s `message` and `stack` are non-enumerable, so a plain stringify silently drops exactly
 * the field a leak could hide in; pino's serializer takes those *and* every own enumerable key.
 */
export function rendered(entries: readonly LogEntry[]): string {
  return JSON.stringify(entries, (_key, value: unknown) => {
    if (!(value instanceof Error)) return value;
    const own = Object.fromEntries(Object.entries(value as unknown as Record<string, unknown>));
    return { name: value.name, message: value.message, stack: value.stack, ...own };
  });
}

export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "whatsapp-rest-"));
  const mediaDir = join(dir, "media");
  mkdirSync(mediaDir, { recursive: true });
  const db = openDb(join(dir, "t.db"));
  const state: ConnectionState = opts.state ?? "connected";
  const { logger, entries } = captureLogger();
  const sendCalls: SendCall[] = [];
  const transcribeCalls = { n: 0 };

  // A real `Config`, not a hand-built partial: a stub would let a field this layer starts reading
  // tomorrow go missing with no compile error.
  const config: Config = {
    ...loadConfig({ WHATSAPP_DATA_DIR: dir }),
    port: 0,
    mediaDir,
    apiToken: "apiToken" in opts ? opts.apiToken : TOKEN,
    readOnly: opts.readOnly ?? false,
    ...opts.config,
  };

  const conn: WhatsAppConnection = {
    snapshot: () => ({
      state,
      lastEventAt: Math.floor(Date.now() / 1000),
      lastConnectedAt: state === "connected" ? Math.floor(Date.now() / 1000) : null,
      attempts: 0,
      needsPairing: state === "pairing" || state === "logged_out",
      selfId: FIXTURE_SELF,
    }),
    requireSocket: () => {
      throw new ConnectionUnavailableError(state);
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    onStateChange: () => undefined,
  };

  /**
   * The media cache, keyed the way the real store keys it.
   *
   * A hit answers from disk in every connection state, which is the property the real
   * `MediaStore.fetch` has and the reason a read never needs the socket. A miss reaches for the
   * socket first — so with the connection down it is `not_connected`, and with it up it is the
   * `media_unavailable` an expired WhatsApp URL produces. That is the real store's branching, and a
   * stub that resolved happily on a miss would make both untestable.
   */
  const attachments = new Map<string, MediaFile>();
  const key = (chatId: string, messageId: string): string => `${chatId}\u0000${messageId}`;
  const media: MediaStore = {
    fetch: (chatId, messageId) => {
      const file = attachments.get(key(chatId, messageId));
      if (file !== undefined) return Promise.resolve(file);
      conn.requireSocket();
      return Promise.reject(new MediaUnavailableError(`could not download the media for message ${messageId}`));
    },
    pathFor: (sha256) => join(mediaDir, sha256),
  };

  /**
   * Every method records its call and answers with a chat id that is **not** the one it was handed:
   * the real sender canonicalises what the caller passed, so a stub echoing the input would let a
   * handler that reports the caller's own string back to it pass.
   */
  const answer = <T>(method: string, args: readonly unknown[], value: T): Promise<T> => {
    sendCalls.push({ method, args });
    const fail = opts.sendError;
    return fail === undefined ? Promise.resolve(value) : Promise.reject(fail());
  };
  const sent: SendRef = opts.sendResult ?? { chatId: FIXTURE_SELF, messageId: "SENT1" };
  const acted: ChatRef = { chatId: sent.chatId };
  const sender: Sender = {
    sendText: (chat, text, o) => answer("sendText", [chat, text, o], sent),
    sendFile: (chat, src, o) => answer("sendFile", [chat, src, o], sent),
    react: (chat, id, emoji) => answer("react", [chat, id, emoji], acted),
    markRead: (chat, id) => answer("markRead", [chat, id], acted),
    editMessage: (chat, id, text) => answer("editMessage", [chat, id, text], acted),
    deleteMessage: (chat, id) => answer("deleteMessage", [chat, id], acted),
  };

  const transcriber: Transcriber = {
    transcribeFile: () => {
      transcribeCalls.n++;
      const fail = opts.transcribeError;
      if (fail !== undefined) return Promise.reject(fail());
      // A named model, not a placeholder: the handler writes it into `messages.transcript_model`,
      // and a test asserting on an empty string would pass just as happily if it were dropped.
      return Promise.resolve(opts.transcript ?? { text: "transcrit", model: "test-model", language: "fr" });
    },
    available: () => Promise.resolve(true),
  };

  const messages: MessagesRepo = makeMessagesRepo(db);
  const deps: RestDeps = {
    config,
    logger,
    chats: makeChatsRepo(db),
    contacts: makeContactsRepo(db),
    messages,
    reactions: makeReactionsRepo(db),
    meta: makeMetaRepo(db),
    conn,
    sender,
    media,
    transcriber,
    links: makeMediaLinkSigner({
      apiToken: config.apiToken,
      ttlSec: config.mediaLinkTtlSec,
      now: opts.now,
      logger,
    }),
    biasTermsFor: () => [],
    autoTranscriber: opts.autoTranscriber,
    validateResponses: true,
  };

  opts.instrument?.(deps);

  // The composition `main.ts` will perform in Task 11, minus the meta slice these suites never
  // reach. `stub` fills the two routes no handler group here owns, so `implement()`'s exhaustive
  // map is satisfied without pretending this file implements them.
  const stub = () => Promise.reject(new Error("this route is not part of the read/media/write slices"));
  const handlers = {
    getHealth: stub,
    capabilities: stub,
    ...readHandlers(deps),
    ...mediaHandlers(deps),
    ...writeHandlers(deps),
  } as unknown as Handlers;

  const handle: RestHandle = await startRest(deps, handlers);
  /** `Headers` rather than an object spread: `RequestInit.headers` may be a tuple array. */
  const authed = (init?: RequestInit): RequestInit => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${config.apiToken ?? ""}`);
    return { ...init, headers };
  };

  return {
    deps,
    url: handle.url,
    dir,
    entries,
    sendCalls,
    transcribeCalls,

    attach: (chatId, messageId, bytes, mimetype) => {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      writeFileSync(join(mediaDir, sha256), bytes);
      const file: MediaFile = { path: join(mediaDir, sha256), sha256, bytes: bytes.byteLength, mimetype };
      attachments.set(key(chatId, messageId), file);
      messages.setMedia(chatId, messageId, sha256, mimetype);
      return file;
    },

    seed: (chatId, isGroup, seedMessages) => {
      deps.chats.ensure(chatId, isGroup);
      for (const m of seedMessages) {
        messages.upsert({
          chatId,
          id: m.id,
          senderId: m.sender ?? chatId,
          ts: m.ts,
          fromMe: m.fromMe ?? false,
          kind: m.kind ?? "text",
          text: m.text === null ? undefined : (m.text ?? `message ${m.id}`),
        });
        deps.chats.touch(chatId, m.ts);
        if (m.transcript !== undefined) messages.setTranscript(chatId, m.id, m.transcript);
      }
    },

    req: (path, init) => fetch(`${handle.url}${path}`, authed(init)),
    json: async <T>(path: string, init?: RequestInit) => {
      const res = await fetch(`${handle.url}${path}`, authed(init));
      return (await res.json()) as T;
    },
    anon: (path) => fetch(`${handle.url}${path}`),

    close: async () => {
      await handle.close();
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A JSON body request, since three suites build the same object. */
export function jsonBody(body: unknown, method = "POST"): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * The element at `index`, asserted present.
 *
 * `noUncheckedIndexedAccess` types every index read as possibly `undefined`, and an optional chain
 * in its place turns a missing element into a passing assertion against `undefined`.
 */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `expected an entry at index ${String(index)}`);
  return item;
}

/** The `error` half of a refusal, as the wire carries it. */
export type WireErrorBody = {
  error: { code: string; name: string; message: string; details?: Record<string, unknown> | undefined };
};
