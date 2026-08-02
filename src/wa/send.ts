/**
 * Every mutating WhatsApp operation: sending text and files, quoting, reacting, marking read,
 * editing and revoking.
 *
 * Two rules shape it. Every raw JID goes through `jid.ts` (Global Constraint 11) — there is no
 * `@`-splitting, no server matching and no suffix stripping here. And every call that produces a
 * message hands that message straight back to `ingest.ingestMessage` (Invariant 2), which is why a
 * sent message needs no separate mapping: it takes the same path an inbound one does.
 *
 * Baileys feeds its own copy of the same message through `messages.upsert` (`emitOwnEvents` defaults
 * to true). For `sendText` and `sendFile` the two writes are the same idempotent upsert, so the
 * duplication is deliberate rather than a hazard, and either one alone would leave the row correct.
 *
 * **That is not true of `react`, `editMessage` and `deleteMessage`,** and the symmetry here should
 * not be read as saying it is. Each of those three produces a *control stanza* — a `reactionMessage`
 * or a `protocolMessage` — which `ingest.ingestMessage` drops on sight (`ingest.ts`'s
 * `CONTROL_CONTENT`), so the re-ingest below is a no-op for them. What actually records the emoji,
 * the new text or the tombstone is Baileys' own `upsertMessage` → `processMessage`, which turns that
 * stanza into `messages.update` / `messages.reaction`. Turn `emitOwnEvents` off and those three stop
 * updating the store entirely; only the text and file sends would survive it.
 *
 * The three `reingest()` calls stay anyway, deliberately. What is storable is `ingest.ts`'s decision,
 * not this module's — that is why `CONTROL_CONTENT` lives there and why the drop happens there — and
 * omitting the call at three sites would quietly move that policy here, so a later change to what
 * counts as control would have to be made in two files instead of one. The cost is one dropped call
 * per control send.
 */

import { proto, type AnyMessageContent, type WAMessage, type WAMessageKey } from "baileys";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { ChatsRepo } from "../db/chats.js";
import type { ContactsRepo } from "../db/contacts.js";
import type { MessageRow, MessagesRepo } from "../db/messages.js";
import type { WaConnection } from "./connection.js";
import type { Ingest } from "./ingest.js";
import { canonicalId, isGroupJid, parseRecipient } from "./jid.js";
import { resolveRecipient } from "./recipient.js";

export type SendRef = { chatId: string; messageId: string };

/**
 * Where an operation that produces no new message landed.
 *
 * Returned rather than `void` so the tool layer can report the chat it really acted on instead of
 * echoing what the caller typed: a LID and its phone JID name one conversation, and only this module
 * — which owns the call into `jid.ts` — knows which id that is.
 */
export type ChatRef = { chatId: string };

export type FileSource = { kind: "path"; path: string } | { kind: "data"; base64: string };

export type SendFileOptions = {
  filename?: string | undefined;
  mimetype?: string | undefined;
  caption?: string | undefined;
  replyTo?: string | undefined;
  asVoiceNote?: boolean | undefined;
  /** Disambiguates a recipient named by name; see `wa/recipient.ts`. */
  pick?: number | undefined;
};

export type SendTextOptions = {
  replyTo?: string | undefined;
  /** JIDs or phone numbers to @mention. The text must also carry each one as `@<number>`. */
  mentions?: readonly string[] | undefined;
  /** Disambiguates a recipient named by name; see `wa/recipient.ts`. */
  pick?: number | undefined;
};

/**
 * Note for `react`, `editMessage` and `deleteMessage`: each resolves once WhatsApp has accepted the
 * operation, which is *before* the store reflects it — the row is written a tick later, off Baileys'
 * own event. Each method documents the mechanism where it is implemented.
 */
export type Sender = {
  sendText: (chat: string, text: string, opts?: SendTextOptions) => Promise<SendRef>;
  sendFile: (chat: string, src: FileSource, opts: SendFileOptions) => Promise<SendRef>;
  react: (chat: string, messageId: string, emoji: string) => Promise<ChatRef>;
  /** Marks the chat read *up to and including* `messageId`, not that message alone. */
  markRead: (chat: string, messageId: string) => Promise<ChatRef>;
  editMessage: (chat: string, messageId: string, text: string) => Promise<ChatRef>;
  deleteMessage: (chat: string, messageId: string) => Promise<ChatRef>;
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

/**
 * The caller named a message that has been revoked. Its row is a tombstone, not a message.
 *
 * A sibling of `NotFoundError` rather than a reuse of it, because the two ask the caller for
 * different corrections and `errorResult` puts the class name in front of the model
 * (`mcp/result.ts`'s `describeError` renders `name: message`). "Not found" says *try another id*;
 * this says *that id is right and the operation is refused for good*. Calling a row that is
 * demonstrably in the store "not found" would send a model looking for a typo it will not find.
 */
export class MessageRevokedError extends Error {
  override name = "MessageRevokedError";
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

/**
 * How many bytes a base64 string decodes to: three per four characters, less its padding.
 *
 * Exact for canonical base64, which is what the `data` argument is — and it is a *bound* on the
 * allocation either way, which is the point: it is read off the string that is already in memory,
 * before a second, decoded copy of it exists.
 */
function decodedSize(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
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

  /**
   * The chat id an operation acts on, from whatever the caller called it.
   *
   * Every method below goes through this, so a JID, a phone number and a name all reach the same
   * row. `pick` is only ever passed by the two sends — the four operations that also take a message
   * id already got their chat from a listing, so there is nothing there to disambiguate.
   *
   * Named `resolveChat` and not `resolve`: `node:path`'s `resolve` is imported at the top of this
   * file and used by `resolveSendPath`, and a same-arity shadow of it inside this closure would have
   * silently rerouted the path-containment check through a chat lookup — which type-checks, because
   * both are `(string) => string`.
   */
  function resolveChat(chat: string, pick?: number): string {
    return resolveRecipient(chat, pick, { chats, contacts });
  }

  /**
   * The JIDs to mark as mentioned.
   *
   * A name is refused rather than looked up: a mention has to name a *person*, and the name lookup
   * that serves the recipient argument can just as well answer with a group. Resolving "@Marie" to a
   * group JID would put a mention in the stanza that no participant matches, which WhatsApp renders
   * as a broken tag rather than as an error.
   */
  function mentionJids(mentions: readonly string[]): string[] {
    return mentions.map((mention) => {
      const form = parseRecipient(mention);
      if (form.kind === "name") {
        throw new Error(`cannot @mention "${mention}": a mention must be a phone number or a user JID, not a name`);
      }
      return canonicalId(form.jid, contacts);
    });
  }

  /**
   * The stored row a caller named — and the one place the revoke tombstone is enforced for sends.
   *
   * `markDeleted` (`db/messages.ts`) clears `text` and `transcript` but deliberately *keeps* `raw`,
   * because the socket's `getMessage` contract is served from those bytes and Baileys needs them for
   * its retry and decrypt path. That makes every read site here responsible for the tombstone: the
   * bytes are still there to be handed to WhatsApp by anything that does not check.
   *
   * `quotedFor` is the sharp edge — Baileys embeds the decoded envelope as
   * `contextInfo.quotedMessage` (`lib/Utils/messages.js`), so a reply quoting a revoked message
   * re-publishes to the chat exactly the content its sender took back. Reacting to one, editing it
   * or revoking it again are refused for the same reason it is not listed: the row is a record that
   * a message *was* there, not a message.
   *
   * `markRead` reaches this too, so marking a chat read *up to* a revoked message is refused as
   * well. That is deliberate uniformity, not an oversight: `messages.list` filters tombstoned rows,
   * so a caller is never handed such an id to aim at, and `unreadKeysUpTo` already skips them.
   */
  function requireRow(chatId: string, id: string): MessageRow {
    const row = messages.get(chatId, id);
    if (row === undefined) throw new NotFoundError(`no message ${id} in chat ${chatId}`);
    if (row.deletedTs !== null) throw new MessageRevokedError(`message ${id} in chat ${chatId} was revoked`);
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
    // First, so an unknown message is named as such rather than as an unquotable one — and so a
    // revoked one is refused before its retained envelope is ever decoded. See `requireRow`.
    requireRow(chatId, id);
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
      // The encoded length first, so an oversize payload is refused *before* it is materialized as a
      // second copy in memory — the same reason the path branch below stats before it reads. The
      // check is then repeated on the bytes actually decoded, which is the one the limit is about.
      assertWithinLimit(decodedSize(src.base64));
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

  async function sendText(chat: string, text: string, opts: SendTextOptions = {}): Promise<SendRef> {
    const jid = resolveChat(chat, opts.pick);
    const sock = conn.requireSocket();
    // Both are resolved before the socket sends anything: a bad mention is a refusal, and refusing
    // after the message is on its way is not a refusal at all.
    const mentions: { mentions?: string[] } =
      opts.mentions === undefined || opts.mentions.length === 0 ? {} : { mentions: mentionJids(opts.mentions) };
    const sent = await sock.sendMessage(jid, { text, ...mentions }, quoteOption(jid, opts.replyTo));
    return refFor(jid, sent);
  }

  async function sendFile(chat: string, src: FileSource, opts: SendFileOptions): Promise<SendRef> {
    const jid = resolveChat(chat, opts.pick);
    const sock = conn.requireSocket();
    // The quote is resolved before the bytes are, matching `sendText`: an unknown or revoked
    // `replyTo` is a refusal either way, and this way it costs no decode and no read of up to
    // `maxUploadBytes` first.
    const quote = quoteOption(jid, opts.replyTo);
    const data = await loadSource(src);
    const sent = await sock.sendMessage(jid, mediaContent(data, opts), quote);
    return refFor(jid, sent);
  }

  /**
   * React to a stored message, or remove this account's reaction from it.
   *
   * **Resolving does not mean the store has been updated.** A reaction travels as a control stanza,
   * which the `reingest` below drops (see this module's header); the row is written when Baileys'
   * own `emitOwnEvents` copy comes back round as `messages.reaction`, and it schedules that with
   * `process.nextTick` (`lib/Socket/messages-send.js:1135`). So a caller that reacts and immediately
   * reads is racing that tick and may not see the reaction yet. Nothing here can close the gap
   * without writing the row twice by two different rules.
   *
   * A revoked message is refused — see `requireRow`.
   */
  async function react(chat: string, messageId: string, emoji: string): Promise<ChatRef> {
    const jid = resolveChat(chat);
    const sock = conn.requireSocket();
    const row = requireRow(jid, messageId);
    // An empty string is not a missing emoji: it is how WhatsApp removes a reaction.
    const key = keyFor(jid, row.id, row.senderId, row.fromMe);
    reingest(await sock.sendMessage(jid, { react: { text: emoji, key } }));
    return { chatId: jid };
  }

  async function markRead(chat: string, messageId: string): Promise<ChatRef> {
    const jid = resolveChat(chat);
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
    return { chatId: jid };
  }

  /**
   * Replace the text of one of this account's own messages.
   *
   * Same lag as `react`, for the same reason: the edit goes out as a `protocolMessage`, `reingest`
   * drops it, and the stored `text`/`edited_ts` are written only when Baileys' `messages.update`
   * arrives on the next tick. A caller that edits and immediately lists can still read the old text.
   */
  async function editMessage(chat: string, messageId: string, text: string): Promise<ChatRef> {
    const jid = resolveChat(chat);
    const sock = conn.requireSocket();
    const edit = ownKey(jid, messageId);
    reingest(await sock.sendMessage(jid, { text, edit }));
    return { chatId: jid };
  }

  /**
   * Revoke one of this account's own messages, for everyone.
   *
   * Same lag as `react` and `editMessage`, and the most visible of the three: the revoke travels as
   * a `protocolMessage`, which `reingest` drops, so `deleted_ts` is set only when Baileys'
   * `messages.update` lands on the next tick. `wa_delete_message` followed straight away by
   * `wa_messages_list` can therefore still show the message, undeleted — it is a stale read, not a
   * failed revoke, and the next read has it.
   */
  async function deleteMessage(chat: string, messageId: string): Promise<ChatRef> {
    const jid = resolveChat(chat);
    const sock = conn.requireSocket();
    const key = ownKey(jid, messageId);
    reingest(await sock.sendMessage(jid, { delete: key }));
    return { chatId: jid };
  }

  return { sendText, sendFile, react, markRead, editMessage, deleteMessage };
}
