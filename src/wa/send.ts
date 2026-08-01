/**
 * Every mutating WhatsApp operation: sending text and files, quoting, reacting, marking read,
 * editing and revoking.
 *
 * Two rules shape it. Every raw JID goes through `jid.ts` (Global Constraint 11) — there is no
 * `@`-splitting, no server matching and no suffix stripping here. And every call that produces a
 * message hands that message straight back to `ingest.ingestMessage` (Invariant 2), which is why a
 * sent message needs no separate mapping: it takes the same path an inbound one does. Baileys also
 * feeds its own copy through `messages.upsert` (`emitOwnEvents` defaults to true), and both writes
 * are the same idempotent upsert, so the duplication is deliberate rather than a hazard — it keeps
 * the store correct even if that event is ever turned off.
 */

import { proto, type AnyMessageContent, type WAMessage, type WAMessageKey } from "baileys";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { ChatsRepo } from "../db/chats.js";
import type { ContactsRepo } from "../db/contacts.js";
import type { MessageRow, MessagesRepo } from "../db/messages.js";
import type { WaConnection } from "./connection.js";
import type { Ingest } from "./ingest.js";
import { canonicalId, isGroupJid } from "./jid.js";

export type SendRef = { chatId: string; messageId: string };

export type FileSource = { kind: "path"; path: string } | { kind: "data"; base64: string };

export type SendFileOptions = {
  filename?: string | undefined;
  mimetype?: string | undefined;
  caption?: string | undefined;
  replyTo?: string | undefined;
  asVoiceNote?: boolean | undefined;
};

export type Sender = {
  sendText: (chat: string, text: string, replyTo?: string) => Promise<SendRef>;
  sendFile: (chat: string, src: FileSource, opts: SendFileOptions) => Promise<SendRef>;
  react: (chat: string, messageId: string, emoji: string) => Promise<void>;
  /** Marks the chat read *up to and including* `messageId`, not that message alone. */
  markRead: (chat: string, messageId: string) => Promise<void>;
  editMessage: (chat: string, messageId: string, text: string) => Promise<void>;
  deleteMessage: (chat: string, messageId: string) => Promise<void>;
};

export type SendDeps = {
  conn: WaConnection;
  ingest: Ingest;
  messages: MessagesRepo;
  /** `markRead` clears the local unread count once WhatsApp has been told. */
  chats: ChatsRepo;
  contacts: ContactsRepo;
  maxUploadBytes: number;
  /**
   * WA_SEND_FILE_DIR: the one directory a caller-named path may resolve inside. Unset disables
   * path-based sending entirely, which is the default — see `resolveSendPath`.
   */
  sendFileDir: string | undefined;
};

/** The caller named a message that is not in the store, or is not usable for what was asked. */
export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/** WhatsApp only lets an account edit or revoke its own messages. */
export class NotOwnMessageError extends Error {
  override name = "NotOwnMessageError";
}

/** A path-based send was refused: path sending is off, or the path escapes its directory. */
export class SendPathError extends Error {
  override name = "SendPathError";
}

/**
 * How many keys one `markRead` may send. A chat with a decade of backlog would otherwise build an
 * unbounded array — and WhatsApp only needs the recent tail for the read marker to land.
 */
const MARK_READ_LIMIT = 500;

const DEFAULT_MIMETYPE = "application/octet-stream";
const VOICE_NOTE_MIMETYPE = "audio/ogg; codecs=opus";

/** Enough to route the common attachments; anything unlisted lands as a document, which is safe. */
const MIMETYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  "3gp": "video/3gpp",
  mkv: "video/x-matroska",
  ogg: "audio/ogg",
  opus: "audio/ogg; codecs=opus",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * True when `candidate` sits strictly under `root`. Both must already be realpath-resolved.
 *
 * The trailing separator is the whole point: a bare `startsWith` accepts `/data/uploads-evil` as a
 * child of `/data/uploads`, and that sibling-prefix is exactly the bypass this check exists for.
 */
function isWithin(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

/** The mimetype to send under: what the caller said, else the filename's extension, else a default. */
function resolveMimetype(opts: SendFileOptions): string {
  const explicit = opts.mimetype?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;

  if (opts.filename !== undefined) {
    const extension = extname(opts.filename).slice(1).toLowerCase();
    const guessed = MIMETYPE_BY_EXTENSION[extension];
    if (guessed !== undefined) return guessed;
  }

  // A caller that asked for a voice note and gave nothing to infer a type from meant audio. Falling
  // through to octet-stream here would send it as a document and drop `ptt` on the floor, silently
  // ignoring the only thing that was asked for. An explicit mimetype still outranks this.
  return opts.asVoiceNote === true ? VOICE_NOTE_MIMETYPE : DEFAULT_MIMETYPE;
}

/**
 * The Baileys content for an attachment, keyed by mimetype family. `document` is the catch-all and
 * the only branch that carries a filename; `audio` has no caption field in the Baileys content type
 * (`lib/Types/Message.d.ts`), so a caption sent with one is dropped rather than mistyped.
 */
function mediaContent(data: Buffer, opts: SendFileOptions): AnyMessageContent {
  const mimetype = resolveMimetype(opts);
  const caption: { caption?: string } =
    opts.caption === undefined || opts.caption === "" ? {} : { caption: opts.caption };

  if (mimetype.startsWith("image/")) return { image: data, mimetype, ...caption };
  if (mimetype.startsWith("video/")) return { video: data, mimetype, ...caption };
  if (mimetype.startsWith("audio/")) {
    const ptt: { ptt?: boolean } = opts.asVoiceNote === true ? { ptt: true } : {};
    return { audio: data, mimetype, ...ptt };
  }
  return { document: data, mimetype, fileName: opts.filename ?? "file", ...caption };
}

export function makeSender(deps: SendDeps): Sender {
  const { conn, ingest, messages, chats, contacts, maxUploadBytes, sendFileDir } = deps;

  function canonical(chat: string): string {
    return canonicalId(chat, { pnForLid: contacts.pnForLid });
  }

  function requireRow(chatId: string, id: string): MessageRow {
    const row = messages.get(chatId, id);
    if (row === undefined) throw new NotFoundError(`no message ${id} in chat ${chatId}`);
    return row;
  }

  /**
   * The key WhatsApp addresses one stored message by. A group key must name the participant the
   * message belongs to; a DM key must not carry one at all.
   */
  function keyFor(chatId: string, id: string, senderId: string, fromMe: boolean): WAMessageKey {
    const key: WAMessageKey = { remoteJid: chatId, id, fromMe };
    if (isGroupJid(chatId)) key.participant = senderId;
    return key;
  }

  /** The key of a message this account sent — the only kind WhatsApp lets it edit or revoke. */
  function ownKey(chatId: string, id: string): WAMessageKey {
    const row = requireRow(chatId, id);
    if (!row.fromMe) throw new NotOwnMessageError(`message ${id} in chat ${chatId} was not sent by this account`);
    return keyFor(chatId, row.id, row.senderId, true);
  }

  /**
   * The stored envelope, decoded back into the full `WAMessage` the `quoted` option takes.
   *
   * Note what this is *not*: the socket's `getMessage` contract (Task 7) unwraps the same bytes to
   * `.message`, the inner content. `quoted` wants the whole envelope — Baileys reads `quoted.key`
   * for the stanza id and participant and `quoted.message` for the preview, and crashes on a
   * `quoted` carrying no `message` at all (`lib/Utils/messages.js`, `generateWAMessageFromContent`).
   * So a row stored without its raw bytes is refused rather than quoted half-way.
   */
  function quotedFor(chatId: string, id: string): WAMessage {
    requireRow(chatId, id); // so an unknown message is named as such, not as an unquotable one
    const bytes = messages.getRaw(chatId, id);
    const decoded = bytes === undefined ? undefined : (proto.WebMessageInfo.decode(bytes) as WAMessage);
    if (decoded?.key.id == null || decoded.message == null) {
      throw new NotFoundError(`message ${id} in chat ${chatId} has no stored envelope to quote`);
    }
    return decoded;
  }

  /** The `quoted` option for a reply, or nothing at all when the caller is not replying. */
  function quoteOption(chatId: string, replyTo: string | undefined): { quoted?: WAMessage } {
    return replyTo === undefined ? {} : { quoted: quotedFor(chatId, replyTo) };
  }

  function assertWithinLimit(bytes: number): void {
    if (bytes > maxUploadBytes) {
      throw new Error(`file exceeds the maximum upload size (${bytes} > ${maxUploadBytes} bytes)`);
    }
  }

  /**
   * Resolve a caller-named path inside the configured directory, or refuse.
   *
   * Without this, `wa_send_file`'s `path` is an arbitrary-file-read primitive: the caller names any
   * path inside the container and the server sends its contents to a WhatsApp conversation.
   * `/proc/self/environ` alone would exfiltrate every secret in the process environment. Bearer auth
   * does not help — this is the escalation from "can call tools" to "can read the filesystem".
   *
   * Both sides are realpath-resolved before they are compared, so a symlink pointing out of the
   * directory is refused along with a `..` traversal. Every failure — outside, symlinked out,
   * non-existent, or a directory that is not configured at all — raises the *same* message, and it
   * never echoes the path back: distinct answers would turn the refusal into a filesystem-existence
   * oracle, which is the question the caller was probing with in the first place.
   */
  async function resolveSendPath(candidate: string): Promise<string> {
    if (sendFileDir === undefined || sendFileDir === "") {
      throw new SendPathError(
        "sending a file by path is disabled; set WA_SEND_FILE_DIR to the directory files may be read from",
      );
    }
    const root = await realpath(sendFileDir).catch(() => undefined);
    const resolved = await realpath(resolve(candidate)).catch(() => undefined);
    if (root === undefined || resolved === undefined || !isWithin(root, resolved)) {
      throw new SendPathError("refusing to read that path: it resolves outside the directory WA_SEND_FILE_DIR names");
    }
    return resolved;
  }

  /** The bytes to upload. The size limit is enforced here, before anything is sent or even read. */
  async function loadSource(src: FileSource): Promise<Buffer> {
    if (src.kind === "data") {
      const data = Buffer.from(src.base64, "base64");
      assertWithinLimit(data.length);
      return data;
    }
    const file = await resolveSendPath(src.path);
    // Size first, so an oversize file is refused without ever being pulled into memory. The check
    // is repeated on the bytes actually read, which is the one the limit is really about.
    assertWithinLimit((await stat(file)).size);
    const data = await readFile(file);
    assertWithinLimit(data.length);
    return data;
  }

  /** Invariant 2: whatever a send produced goes straight back through the inbound path. */
  function reingest(sent: WAMessage | undefined): void {
    if (sent !== undefined) ingest.ingestMessage(sent);
  }

  function refFor(chatId: string, sent: WAMessage | undefined): SendRef {
    reingest(sent);
    const messageId = sent?.key.id;
    if (messageId == null || messageId === "") {
      throw new Error(`WhatsApp accepted the send to ${chatId} but returned no message id`);
    }
    return { chatId, messageId };
  }

  async function sendText(chat: string, text: string, replyTo?: string): Promise<SendRef> {
    const jid = canonical(chat);
    const sock = conn.requireSocket();
    const sent = await sock.sendMessage(jid, { text }, quoteOption(jid, replyTo));
    return refFor(jid, sent);
  }

  async function sendFile(chat: string, src: FileSource, opts: SendFileOptions): Promise<SendRef> {
    const jid = canonical(chat);
    const sock = conn.requireSocket();
    const data = await loadSource(src);
    const sent = await sock.sendMessage(jid, mediaContent(data, opts), quoteOption(jid, opts.replyTo));
    return refFor(jid, sent);
  }

  async function react(chat: string, messageId: string, emoji: string): Promise<void> {
    const jid = canonical(chat);
    const sock = conn.requireSocket();
    const row = requireRow(jid, messageId);
    // An empty string is not a missing emoji: it is how WhatsApp removes a reaction.
    const key = keyFor(jid, row.id, row.senderId, row.fromMe);
    reingest(await sock.sendMessage(jid, { react: { text: emoji, key } }));
  }

  async function markRead(chat: string, messageId: string): Promise<void> {
    const jid = canonical(chat);
    const sock = conn.requireSocket();
    const target = requireRow(jid, messageId);
    // `readMessages` marks exactly the keys it is given (baileys `lib/Socket/business.d.ts:37`);
    // there is no "mark everything older" primitive. The tool's contract is "read up to this
    // message", so the expansion happens here, newest first and capped.
    const keys = messages
      .unreadKeysUpTo(jid, target.ts, MARK_READ_LIMIT)
      .map((m) => keyFor(jid, m.id, m.senderId, false));
    if (keys.length > 0) await sock.readMessages(keys);
    chats.clearUnread(jid);
  }

  async function editMessage(chat: string, messageId: string, text: string): Promise<void> {
    const jid = canonical(chat);
    const sock = conn.requireSocket();
    const edit = ownKey(jid, messageId);
    reingest(await sock.sendMessage(jid, { text, edit }));
  }

  async function deleteMessage(chat: string, messageId: string): Promise<void> {
    const jid = canonical(chat);
    const sock = conn.requireSocket();
    const key = ownKey(jid, messageId);
    reingest(await sock.sendMessage(jid, { delete: key }));
  }

  return { sendText, sendFile, react, markRead, editMessage, deleteMessage };
}
