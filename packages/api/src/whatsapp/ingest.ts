/**
 * The only place Baileys events become rows.
 *
 * Two rules shape everything here. Every write goes through a repository — this module owns no SQL
 * beyond the chunk transactions it wraps batch work in. And every raw JID goes through `jid.ts`
 * (Global Constraint 11): there is no `@`-splitting, no server matching and no suffix stripping in
 * this file, only calls into the chokepoint.
 */

import {
  getContentType,
  normalizeMessageContent,
  proto,
  toNumber,
  WAMessageStatus,
  WAMessageStubType,
  type BaileysEventMap,
  type Chat,
  type Contact,
  type LIDMapping,
  type WAMessage,
  type WAMessageContent,
  type WAMessageKey,
  type WASocket,
} from "baileys";
import type { Logger } from "pino";
import type { ChatPatch, ChatsRepo } from "../db/chats.js";
import type { Db } from "../db/client.js";
import type { ContactInput, ContactsRepo } from "../db/contacts.js";
import type { MessageKind, MessagesRepo } from "../db/messages.js";
import type { ReactionsRepo } from "../db/reactions.js";
import { canonicalId, isGroupJid, isStatusBroadcastJid, lidFromJid, phoneFromJid, userJid } from "./jid.js";

export type IngestDeps = {
  /**
   * Used for one thing only: wrapping a batch chunk in a transaction. The repositories own every
   * statement; a history sync of several thousand messages autocommitting once per row is the one
   * thing they cannot express, and Risk 7 makes that cost real.
   */
  db: Db;
  chats: ChatsRepo;
  contacts: ContactsRepo;
  messages: MessagesRepo;
  reactions: ReactionsRepo;
  logger: Logger;
  /** The account's own canonical id, for from_me and self-name resolution. */
  selfId: () => string | null;
  /**
   * Newly-stored voice notes, handed over **after** their transaction has committed.
   *
   * Called once per batch rather than once per message, and never from inside `inTransaction`: a
   * queue that had been fed from inside a chunk would keep entries whose rows a later rollback threw
   * away, and would then spend GPU time transcribing a recording the store does not have.
   *
   * Optional, because a deployment with auto-transcription off wires nothing here at all.
   */
  onVoiceNotes?: ((notes: readonly VoiceNote[]) => void) | undefined;
};

/** A voice note that has just been stored, and the little that deciding what to do with it needs. */
export type VoiceNote = { chatId: string; id: string; ts: number; durationS: number | undefined };

/** Per-batch ingest policy. */
export type IngestOptions = {
  /**
   * Whether a newly-inserted inbound message bumps its chat's unread count. Defaults to true, which
   * is what the live `messages.upsert` path wants: it carries both `notify` and the offline
   * `append` drain, and both really are unread.
   *
   * `messaging-history.set` passes false. That payload carries the server-authoritative
   * `Chat.unreadCount`, which the chat half of the same batch has already written; bumping once per
   * inbound message on top of it would leave a chat WhatsApp reports as fully read showing an
   * unread count equal to its inbound history depth.
   */
  bumpUnread?: boolean | undefined;
  /**
   * Whether newly-stored voice notes in this batch are offered to `onVoiceNotes`. Defaults to true.
   *
   * 🔴 **`messaging-history.set` passes false, and that is the primary flood guard.** Re-pairing
   * onto an empty claim replays thousands of messages through that handler, and enqueuing a
   * transcription for every voice note among them would spend hundreds of dollars of GPU on
   * conversations from months ago before anyone noticed.
   *
   * ⚠️ **Do not try to make this decision from the upsert's `type` instead.** `messages.upsert`
   * carries both `notify` *and* the offline `append` drain — see the note on `bumpUnread` above —
   * and `append` is legitimate recent traffic that arrived while the process was down. Filtering it
   * out would silently skip real voice notes, which is a failure nothing reports. The distinction
   * that matters is *which handler the batch came from*, and that is what this flag records.
   */
  transcribe?: boolean | undefined;
};

export type Ingest = {
  /** Wire every listener onto a freshly created socket. */
  attach: (sock: WASocket) => void;
  /** Ingest one message. Exported so send.ts can re-ingest what it produced. */
  ingestMessage: (m: WAMessage) => void;
  ingestMessages: (ms: readonly WAMessage[], opts?: IngestOptions) => void;
};

/**
 * A history sync arrives as one event carrying everything. Committing per row is too slow and
 * committing the whole payload at once means one malformed message loses a sync that never comes
 * again (Risk 7). Chunking bounds both.
 */
const CHUNK_SIZE = 500;

/**
 * Above this, a value can only be milliseconds: 1e11 seconds is the year 5138, while 1e11
 * milliseconds was 1973. WhatsApp's app-state mute stamps and reaction timestamps are milliseconds;
 * everything this module stores is seconds (Global Constraint 17).
 */
const MILLISECOND_THRESHOLD = 1e11;

/**
 * Content wrapper → stored kind, for everything that is a message.
 *
 * No member of `CONTROL_CONTENT` belongs here: `ingestMessage` returns on those before `kindOf` is
 * ever reached, so an entry for one would be dead code that reads like a decision. `protocolMessage`
 * mapped to `"system"` here until it was removed for exactly that reason.
 */
const KIND_BY_CONTENT: Partial<Record<keyof proto.IMessage, MessageKind>> = {
  conversation: "text",
  extendedTextMessage: "text",
  imageMessage: "image",
  videoMessage: "video",
  ptvMessage: "video",
  audioMessage: "audio",
  documentMessage: "document",
  stickerMessage: "sticker",
  lottieStickerMessage: "sticker",
  locationMessage: "location",
  liveLocationMessage: "location",
  contactMessage: "contact",
  contactsArrayMessage: "contact",
};

const STATUS_NAMES: Record<number, string> = {
  [WAMessageStatus.ERROR]: "error",
  [WAMessageStatus.PENDING]: "pending",
  [WAMessageStatus.SERVER_ACK]: "sent",
  [WAMessageStatus.DELIVERY_ACK]: "delivered",
  [WAMessageStatus.READ]: "read",
  [WAMessageStatus.PLAYED]: "played",
};

/** The lowest rung: a message nothing has acknowledged yet. Named because `advanceStatus` keys on it. */
const PENDING_RANK = 1;

/**
 * Delivery states only ever move forwards. `"error"` is deliberately absent: it is not a rung on
 * this ladder, and `advanceStatus` governs it by a separate rule.
 */
const STATUS_RANK: Record<string, number> = { pending: PENDING_RANK, sent: 2, delivered: 3, read: 4, played: 5 };

/**
 * Wire control, never conversation. Baileys routes a revoke, an edit and a reaction through
 * `messages.update` / `messages.delete` / `messages.reaction` — *and* delivers the carrying stanza
 * on `messages.upsert` like any other message (`Socket/chats.js:917` emits every one). Storing
 * those would add a textless row per revoke and, since they arrive inbound, a phantom unread on
 * top of the effect we already applied.
 *
 * The last three are here for the second half of that reason alone. A pin, a keep-in-chat marker
 * and a poll vote carry no conversation, and *nothing* consumes them: Baileys' `process-message.js`
 * has no branch for a pin or a keep — and its poll-vote block is commented out — so no
 * `messages.update` follows, and none of the three is in `KIND_BY_CONTENT` either. Left out of this
 * set, each would land as a textless `kind: "other"` row that bumps the chat's unread count, which
 * is exactly the class of row this set exists to keep out. Baileys agrees about the vote:
 * `isRealMessage` excludes `pollUpdateMessage` alongside `protocolMessage` and `reactionMessage`.
 */
const CONTROL_CONTENT: ReadonlySet<keyof proto.IMessage> = new Set<keyof proto.IMessage>([
  "protocolMessage",
  "reactionMessage",
  "encReactionMessage",
  "pinInChatMessage",
  "keepInChatMessage",
  "pollUpdateMessage",
]);

type NumberLike = Parameters<typeof toNumber>[0];

/** The fields this module reads off whichever content wrapper `getContentType` names. */
type ContentBody = { caption?: string | null; contextInfo?: proto.IContextInfo | null };

/**
 * What an `audioMessage` says about itself beyond being audio.
 *
 * Both fields exist because `kind` cannot answer either question. `"audio"` covers a voice note and
 * a forwarded song identically, so `ptt` is the only thing that distinguishes the recording worth
 * spending a GPU on — and `seconds` is the only way a length gate can run *before* the file is
 * downloaded, which is the whole reason to have one.
 */
type AudioFacts = { ptt: boolean; durationS: number | undefined };

function audioFactsOf(content: WAMessageContent | undefined): AudioFacts | undefined {
  const audio = content?.audioMessage;
  if (audio == null) return undefined;
  const seconds = toNumber(audio.seconds);
  return {
    // `ptt` absent means "not a voice note": WhatsApp sets it on push-to-talk recordings and omits
    // it for an attached audio file, so treating absence as false matches the wire.
    ptt: audio.ptt === true,
    durationS: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : undefined,
  };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Unix seconds, whether the source handed back seconds, milliseconds, a protobuf Long or nothing. */
function toEpochSeconds(value: NumberLike): number | undefined {
  const n = toNumber(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n >= MILLISECOND_THRESHOLD ? n / 1000 : n);
}

function contentBody(content: WAMessageContent, type: keyof proto.IMessage): ContentBody | undefined {
  const body: unknown = content[type];
  if (typeof body !== "object" || body === null) return undefined;
  return body;
}

function kindOf(content: WAMessageContent | undefined): MessageKind {
  const type = getContentType(content);
  if (type === undefined) return "other";
  return KIND_BY_CONTENT[type] ?? "other";
}

function textOf(content: WAMessageContent | undefined): string | undefined {
  if (content === undefined) return undefined;
  const conversation = content.conversation;
  if (typeof conversation === "string" && conversation !== "") return conversation;
  const type = getContentType(content);
  if (type === undefined) return undefined;
  // Read `text` only off extendedTextMessage: other wrappers carry an unrelated `text` (a
  // reactionMessage's is the emoji), which would end up indexed as the message body.
  if (type === "extendedTextMessage") return content.extendedTextMessage?.text ?? undefined;
  const caption = contentBody(content, type)?.caption;
  return caption == null || caption === "" ? undefined : caption;
}

/** The furthest delivery state a per-user receipt attests to. */
function receiptStatus(receipt: proto.IUserReceipt): string | undefined {
  if (toEpochSeconds(receipt.playedTimestamp) !== undefined) return "played";
  if (toEpochSeconds(receipt.readTimestamp) !== undefined) return "read";
  if (toEpochSeconds(receipt.receiptTimestamp) !== undefined) return "delivered";
  return undefined;
}

/**
 * The lid↔pn pair a contact reveals by carrying both identities, in the raw JID form
 * `contacts.linkIdentity` takes, or undefined when it names only one identity. A contact carrying
 * both *is* a mapping — the same fact `lid-mapping.update` and `messaging-history.set`'s
 * `lidPnMappings` deliver — and recording it is what folds a conversation already ingested under
 * the LID id.
 */
function lidPnPairOf(c: Partial<Contact>): LIDMapping | undefined {
  const rawId = c.id;
  if (rawId == null || rawId === "") return undefined;
  const lid = c.lid ?? rawId;
  const pn = c.phoneNumber ?? rawId;
  if (lidFromJid(lid) === undefined || phoneFromJid(pn) === undefined) return undefined;
  return { lid, pn };
}

function quotedIdOf(content: WAMessageContent | undefined): string | undefined {
  if (content === undefined) return undefined;
  const type = getContentType(content);
  if (type === undefined) return undefined;
  return contentBody(content, type)?.contextInfo?.stanzaId ?? undefined;
}

/**
 * Exported for tests only — `send.ts` imports neither this nor `extractText`, and nothing else does
 * either: classify a Baileys message into our MessageKind.
 *
 * `normalizeMessageContent` first, always. WhatsApp routinely wraps real content in
 * `ephemeralMessage` / `viewOnceMessage` / `viewOnceMessageV2` / `documentWithCaptionMessage`, and
 * classifying the wrapper turns a view-once photo into `other` with no text and no media kind.
 */
export function classify(m: WAMessage): MessageKind {
  return kindOf(normalizeMessageContent(m.message));
}

/** Exported for tests: the displayable text of a message, across every content wrapper. */
export function extractText(m: WAMessage): string | undefined {
  return textOf(normalizeMessageContent(m.message));
}

export function makeIngest(deps: IngestDeps): Ingest {
  const { db, chats, contacts, messages, reactions, logger, selfId } = deps;
  const lookup = { pnForLid: contacts.pnForLid };

  /**
   * Voice notes stored by the batch currently being applied, held until it commits.
   *
   * Module-scoped rather than threaded through `ingestMessage` because that function is called from
   * inside `runChunked`'s transaction and returns nothing; the alternative is a return type change
   * that every caller would have to thread onwards for one optional feature.
   */
  let staged: VoiceNote[] = [];

  /** Hand the staged batch over. Called only after the transaction that produced it has committed. */
  function flushVoiceNotes(): void {
    if (staged.length === 0) return;
    const batch = staged;
    staged = [];
    try {
      deps.onVoiceNotes?.(batch);
    } catch (err) {
      // Contained here for the same reason `guard` exists: auto-transcription is a side feature,
      // and nothing about it may be the reason the message mirror stops.
      logger.error({ err, notes: batch.length }, "ingest: handing over new voice notes failed");
    }
  }

  function canonical(jid: string): string {
    return canonicalId(jid, lookup);
  }

  /** Our own canonical id, or undefined while the socket has not told us who we are yet. */
  function self(): string | undefined {
    const id = selfId();
    return id === null ? undefined : canonical(id);
  }

  /**
   * The whole of this module's SQL, and the one invariant it imposes on everything reachable from
   * `fn`: **SQLite has no nested transactions.** A `BEGIN` issued while one is already open fails
   * with "cannot start a transaction within a transaction", so no repository call that opens its
   * own may be made from inside `fn` — today that means `contacts.upsertMany`
   * (`db/contacts.ts:150`) and `contacts.linkIdentity` (`db/contacts.ts:195`), neither of which may
   * ever be called from `applyChat`, `ingestMessage`, or anything they reach. Contact and identity
   * work therefore runs outside the chunk loop; see `applyHistory` and `upsertContacts`.
   */
  function inTransaction(fn: () => void): void {
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * One transaction per chunk: bounded rollback, bounded commit cost. `apply` runs inside that
   * transaction and must not open one of its own — see `inTransaction`.
   */
  function runChunked<T>(items: readonly T[], label: string, apply: (item: T) => void): void {
    if (items.length === 0) return;
    const chunks = Math.ceil(items.length / CHUNK_SIZE);
    // A large initial sync is otherwise indistinguishable from a hang.
    if (chunks > 1) logger.info({ total: items.length, chunks, chunkSize: CHUNK_SIZE }, `ingest: ${label} in chunks`);
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      inTransaction(() => {
        for (const item of items.slice(i, i + CHUNK_SIZE)) apply(item);
      });
    }
  }

  /** A throw inside a listener would surface deep in Baileys' emitter; contain it here. */
  function guard(label: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      logger.error({ err }, `ingest: the ${label} handler failed`);
    }
  }

  // --- messages ----------------------------------------------------------------------------

  /** The stored (chat, message) coordinates a key points at, or undefined if it names nothing we keep. */
  function targetOf(key: WAMessageKey): { chatId: string; id: string } | undefined {
    const remoteJid = key.remoteJid;
    const id = key.id;
    if (remoteJid == null || remoteJid === "" || id == null || id === "") return undefined;
    if (isStatusBroadcastJid(remoteJid)) return undefined;
    return { chatId: canonical(remoteJid), id };
  }

  function senderOf(key: WAMessageKey, chatId: string, isGroup: boolean, fromMe: boolean): string {
    if (isGroup) {
      const participant = key.participant;
      if (participant != null && participant !== "") return canonical(participant);
    }
    if (fromMe) {
      const me = self();
      if (me !== undefined) return me;
      // Unreachable in practice: messages only flow on an open socket, which has already told us
      // who we are. If it ever happens, from_me = 1 still carries the fact that this is ours, so
      // keeping the message beats dropping it over a field nothing keys on in a DM.
      logger.debug({ chatId }, "ingest: own identity unknown, attributing an outbound message to the chat");
    }
    return chatId;
  }

  /**
   * Write a delivery status only when it is news, never when it would undo what is stored.
   *
   * `message-receipt.update` must never create a row, and per-device receipts in a group arrive
   * interleaved — Bob's "delivered" lands after Alice's "read" and must not undo it. Ranked states
   * therefore only ever move forwards. `"error"` is not ranked: a single failed per-device delivery
   * must not demote a message the other recipients have already read, so it is written only while
   * nothing has acknowledged the message yet — no stored status, or one still at `pending`.
   */
  function advanceStatus(chatId: string, id: string, status: string): void {
    const row = messages.get(chatId, id);
    if (row === undefined) return;
    const currentRank = row.status === null ? 0 : (STATUS_RANK[row.status] ?? 0);
    const nextRank = STATUS_RANK[status];
    if (nextRank === undefined) {
      // Unranked — in practice only "error".
      if (currentRank > PENDING_RANK) return;
    } else if (nextRank <= currentRank) return;
    messages.setStatus(chatId, id, status);
  }

  function ingestMessage(m: WAMessage, opts: IngestOptions = {}): void {
    let messageId: string | undefined;
    try {
      const key = m.key;
      messageId = key.id ?? undefined;
      const remoteJid = key.remoteJid;
      if (remoteJid == null || remoteJid === "" || messageId === undefined || messageId === "") {
        logger.debug({ remoteJid }, "ingest: message without a remoteJid or id, skipped");
        return;
      }
      if (isStatusBroadcastJid(remoteJid)) return;

      const content = normalizeMessageContent(m.message);
      const type = getContentType(content);
      if (type !== undefined && CONTROL_CONTENT.has(type)) return;

      const chatId = canonical(remoteJid);
      const isGroup = isGroupJid(chatId);
      chats.ensure(chatId, isGroup);

      const fromMe = key.fromMe === true;
      const ts = toEpochSeconds(m.messageTimestamp) ?? nowSec();
      const audio = audioFactsOf(content);

      const inserted = messages.upsert({
        chatId,
        id: messageId,
        senderId: senderOf(key, chatId, isGroup, fromMe),
        ts,
        fromMe,
        kind: kindOf(content),
        text: textOf(content),
        quotedId: quotedIdOf(content),
        ptt: audio?.ptt,
        durationS: audio?.durationS,
        // `status` is deliberately not part of this payload: the upsert's ON CONFLICT does
        // `status = COALESCE(excluded.status, messages.status)` (`db/messages.ts`), so a
        // redelivery carrying PENDING would *replace* a stored `read`. It goes through
        // `advanceStatus` below instead — the same monotonic guard every other path uses.

        // The encoded envelope, byte-faithful, because the socket's getMessage contract is served
        // from it (Risk 3). Task 7 decodes it and unwraps `.message`; keep the two in step.
        raw: proto.WebMessageInfo.encode(m).finish(),
      });

      const status = m.status == null ? undefined : STATUS_NAMES[m.status];
      if (status !== undefined) advanceStatus(chatId, messageId, status);

      chats.touch(chatId, ts);
      if (fromMe) chats.clearUnread(chatId);
      // `bumpUnread` defaults to true and is suppressed only by the history path, which has
      // already written the server's own count for this chat. See `IngestOptions`.
      else if (inserted && (opts.bumpUnread ?? true)) chats.bumpUnread(chatId, 1);

      // Only on a genuinely new row: a redelivery of a note already stored would otherwise re-offer
      // it on every reconnect. Anything this misses — a row inserted while the queue was full, or
      // by a batch that later rolled back — is picked up by the boot sweep, which reads the store
      // rather than the event stream.
      if (inserted && audio?.ptt === true && (opts.transcribe ?? true)) {
        staged.push({ chatId, id: messageId, ts, durationS: audio.durationS });
      }
    } catch (err) {
      logger.warn({ err, messageId }, "ingest: failed to ingest message");
    }
  }

  function ingestMessages(ms: readonly WAMessage[], opts: IngestOptions = {}): void {
    try {
      runChunked(ms, "messages", (m) => {
        ingestMessage(m, opts);
      });
    } catch (err) {
      // A chunk rolled back. Whatever it staged names rows that no longer exist, and earlier
      // chunks' notes go with them rather than being handed over out of a failed batch — the boot
      // sweep reads the store and will find anything that really did commit.
      staged = [];
      throw err;
    }
    flushVoiceNotes();
  }

  /** The new content of an edit, or undefined when this update is not an edit. */
  function editedContentOf(message: WAMessageContent | null | undefined): WAMessageContent | undefined {
    if (message == null) return undefined;
    // Baileys re-emits an edit as `{ editedMessage: { message: <new content> } }`; the raw wire
    // form is a protocolMessage of type MESSAGE_EDIT. Both reach here, so both are handled.
    if (message.editedMessage != null) return normalizeMessageContent(message);
    const protocolMessage = normalizeMessageContent(message)?.protocolMessage;
    if (protocolMessage?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
      return normalizeMessageContent(protocolMessage.editedMessage);
    }
    return undefined;
  }

  function applyMessageUpdate({ key, update }: BaileysEventMap["messages.update"][number]): void {
    const target = targetOf(key);
    if (target === undefined) return;
    const { chatId, id } = target;

    if (update.messageStubType === WAMessageStubType.REVOKE) {
      messages.markDeleted(chatId, id, nowSec());
      return;
    }

    const edited = editedContentOf(update.message);
    if (edited !== undefined) {
      const text = textOf(edited);
      const editedTs = toEpochSeconds(update.messageTimestamp) ?? nowSec();
      if (text !== undefined) messages.markEdited(chatId, id, text, editedTs);
      return;
    }

    if (update.status != null) {
      const status = STATUS_NAMES[update.status];
      if (status !== undefined) advanceStatus(chatId, id, status);
    }
  }

  function applyMessageDelete(payload: BaileysEventMap["messages.delete"]): void {
    // The `{ jid, all: true }` form is deliberately ignored: this is a forward-only store and
    // "clear this chat on my phone" is not a reason to lose its history.
    if (!("keys" in payload)) return;
    const ts = nowSec();
    for (const key of payload.keys) {
      const target = targetOf(key);
      if (target !== undefined) messages.markDeleted(target.chatId, target.id, ts);
    }
  }

  /** Mirrors Baileys' own `getKeyAuthor`: who sent the message this key belongs to. */
  function authorOf(key: proto.IMessageKey | null | undefined): string | undefined {
    if (key == null) return undefined;
    if (key.fromMe === true) return self();
    const participant = key.participant;
    if (participant != null && participant !== "") return canonical(participant);
    const remoteJid = key.remoteJid;
    if (remoteJid != null && remoteJid !== "") return canonical(remoteJid);
    return undefined;
  }

  function applyReaction({ key, reaction }: BaileysEventMap["messages.reaction"][number]): void {
    const target = targetOf(key);
    if (target === undefined) return;
    // `key` names the message reacted to; `reaction.key` belongs to the reaction itself and is
    // what identifies the reactor.
    const senderId = authorOf(reaction.key);
    if (senderId === undefined) return;
    reactions.set({
      chatId: target.chatId,
      messageId: target.id,
      senderId,
      emoji: reaction.text ?? "", // an empty text is a removal, which the repository honours
      ts: toEpochSeconds(reaction.senderTimestampMs) ?? nowSec(),
    });
  }

  function applyReceipt({ key, receipt }: BaileysEventMap["message-receipt.update"][number]): void {
    const target = targetOf(key);
    if (target === undefined) return;
    const status = receiptStatus(receipt);
    if (status !== undefined) advanceStatus(target.chatId, target.id, status);
  }

  // --- chats and contacts ------------------------------------------------------------------

  function applyChat(c: Partial<Chat>): void {
    try {
      const rawId = c.id;
      if (rawId == null || rawId === "" || isStatusBroadcastJid(rawId)) return;
      const chatId = canonical(rawId);
      const isGroup = isGroupJid(chatId);
      chats.ensure(chatId, isGroup);

      const patch: ChatPatch = { isGroup };
      const name = c.name ?? c.displayName;
      if (name != null && name !== "") patch.name = name;
      if (typeof c.archived === "boolean") patch.archived = c.archived;
      // WhatsApp uses a negative unreadCount as a "mark as unread" flag, not a count.
      if (typeof c.unreadCount === "number" && c.unreadCount >= 0) patch.unreadCount = c.unreadCount;
      if (c.muteEndTime !== undefined) patch.mutedUntil = toEpochSeconds(c.muteEndTime) ?? null;
      if (c.participant != null) patch.participantCount = c.participant.length;
      chats.patch(chatId, patch);

      // Orders a chat whose messages this sync did not carry. `touch` only moves forwards, so it
      // can never rewind a chat that already has newer messages.
      const conversationTs = toEpochSeconds(c.conversationTimestamp);
      if (conversationTs !== undefined) chats.touch(chatId, conversationTs);
    } catch (err) {
      logger.warn({ err, chatId: c.id }, "ingest: failed to apply a chat update");
    }
  }

  function toContactInput(c: Partial<Contact>): ContactInput | undefined {
    const rawId = c.id;
    if (rawId == null || rawId === "") return undefined;
    // Baileys hands full JIDs; the repository stores bare local parts alongside a JID id. Key the
    // row by the phone identity whenever the contact reveals one, so `pnForLid` resolves rather
    // than reporting the LID as its own phone identity.
    const phoneNumber = phoneFromJid(c.phoneNumber ?? rawId);
    return {
      id: phoneNumber === undefined ? canonical(rawId) : userJid(phoneNumber),
      phoneNumber,
      lid: lidFromJid(c.lid ?? rawId),
      name: c.name,
      notify: c.notify ?? c.verifiedName,
    };
  }

  function upsertContacts(cs: readonly Partial<Contact>[]): void {
    const inputs: ContactInput[] = [];
    const pairs: LIDMapping[] = [];
    for (const c of cs) {
      const input = toContactInput(c);
      if (input === undefined) continue;
      const pair = lidPnPairOf(c);
      if (pair !== undefined) pairs.push(pair);
      inputs.push(input);
    }
    // Mappings first, as in `applyHistory`: folding the LID conversation before writing the
    // contact means a chat already ingested under the LID id is merged now rather than only when
    // some future message happens to resolve. Both loops open their own transactions, so this runs
    // outside any chunk — see `inTransaction`.
    for (const pair of pairs) applyLidMapping(pair);
    contacts.upsertMany(inputs);
  }

  function applyLidMapping({ lid, pn }: LIDMapping): void {
    // linkIdentity ignores a pair it cannot parse, and folds any conversation already ingested
    // under the LID id into the phone identity (Risk 1).
    contacts.linkIdentity(lid, pn);
  }

  function applyHistory(h: BaileysEventMap["messaging-history.set"]): void {
    logger.info(
      {
        chats: h.chats.length,
        contacts: h.contacts.length,
        messages: h.messages.length,
        isLatest: h.isLatest === true,
      },
      "ingest: history sync received",
    );
    // Mappings first: Baileys keeps these to itself (they feed its signal store, and no
    // `lid-mapping.update` is emitted for them), so without this the messages in this very payload
    // would land under LID ids that only fold later, if ever.
    for (const mapping of h.lidPnMappings ?? []) applyLidMapping(mapping);
    upsertContacts(h.contacts);
    runChunked(h.chats, "chats", applyChat);
    // No unread bump on this path: `applyChat` has just written the server's own `unreadCount` for
    // every chat in the batch, and bumping per inbound message on top of it would report a chat
    // WhatsApp calls read as having as many unreads as it has inbound history. See `IngestOptions`.
    //
    // 🔴 `transcribe: false` is the flood guard. This payload is a replay — re-pairing onto an empty
    // claim delivers thousands of messages through here — and every voice note in it would otherwise
    // become a queued GPU job. Old recordings are still transcribable on demand, and the boot
    // sweep's recency window covers anything genuinely recent that arrives this way.
    ingestMessages(h.messages, { bumpUnread: false, transcribe: false });
  }

  // --- wiring ------------------------------------------------------------------------------

  function attach(sock: WASocket): void {
    sock.ev.on("messages.upsert", ({ messages: ms }) => {
      guard("messages.upsert", () => {
        ingestMessages(ms);
      });
    });
    sock.ev.on("messages.update", (updates) => {
      guard("messages.update", () => {
        for (const u of updates) applyMessageUpdate(u);
      });
    });
    sock.ev.on("messages.delete", (payload) => {
      guard("messages.delete", () => {
        applyMessageDelete(payload);
      });
    });
    sock.ev.on("messages.reaction", (rs) => {
      guard("messages.reaction", () => {
        for (const r of rs) applyReaction(r);
      });
    });
    sock.ev.on("message-receipt.update", (us) => {
      guard("message-receipt.update", () => {
        for (const u of us) applyReceipt(u);
      });
    });
    sock.ev.on("chats.upsert", (cs) => {
      guard("chats.upsert", () => {
        runChunked(cs, "chats", applyChat);
      });
    });
    sock.ev.on("chats.update", (cs) => {
      guard("chats.update", () => {
        runChunked(cs, "chats", applyChat);
      });
    });
    // `chats.delete` is deliberately not wired: this is a forward-only store and keeps history.
    sock.ev.on("contacts.upsert", (cs) => {
      guard("contacts.upsert", () => {
        upsertContacts(cs);
      });
    });
    sock.ev.on("contacts.update", (cs) => {
      guard("contacts.update", () => {
        upsertContacts(cs);
      });
    });
    sock.ev.on("messaging-history.set", (h) => {
      guard("messaging-history.set", () => {
        applyHistory(h);
      });
    });
    sock.ev.on("lid-mapping.update", (mapping) => {
      guard("lid-mapping.update", () => {
        applyLidMapping(mapping);
      });
    });
  }

  /**
   * The single-message entry point `send.ts` re-ingests through.
   *
   * Wrapped rather than exported directly so that it flushes too: the inner function only *stages*
   * a voice note, and an unflushed staging list would sit there until some unrelated later batch
   * happened to hand it over — a message from one conversation arriving under another's flush.
   */
  function ingestOne(m: WAMessage, opts: IngestOptions = {}): void {
    ingestMessage(m, opts);
    flushVoiceNotes();
  }

  return { attach, ingestMessage: ingestOne, ingestMessages };
}
