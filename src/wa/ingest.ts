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
};

export type Ingest = {
  /** Wire every listener onto a freshly created socket. */
  attach: (sock: WASocket) => void;
  /** Ingest one message. Exported so send.ts can re-ingest what it produced. */
  ingestMessage: (m: WAMessage) => void;
  ingestMessages: (ms: readonly WAMessage[]) => void;
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
  protocolMessage: "system",
};

const STATUS_NAMES: Record<number, string> = {
  [WAMessageStatus.ERROR]: "error",
  [WAMessageStatus.PENDING]: "pending",
  [WAMessageStatus.SERVER_ACK]: "sent",
  [WAMessageStatus.DELIVERY_ACK]: "delivered",
  [WAMessageStatus.READ]: "read",
  [WAMessageStatus.PLAYED]: "played",
};

/** Delivery states only ever move forwards; "error" is unranked and always worth surfacing. */
const STATUS_RANK: Record<string, number> = { pending: 1, sent: 2, delivered: 3, read: 4, played: 5 };

/**
 * Wire control, never conversation. Baileys routes a revoke, an edit and a reaction through
 * `messages.update` / `messages.delete` / `messages.reaction` — *and* delivers the carrying stanza
 * on `messages.upsert` like any other message (`Socket/chats.js:917` emits every one). Storing
 * those would add a textless row per revoke and, since they arrive inbound, a phantom unread on
 * top of the effect we already applied.
 */
const CONTROL_CONTENT: ReadonlySet<keyof proto.IMessage> = new Set<keyof proto.IMessage>([
  "protocolMessage",
  "reactionMessage",
  "encReactionMessage",
]);

type NumberLike = Parameters<typeof toNumber>[0];

/** The fields this module reads off whichever content wrapper `getContentType` names. */
type ContentBody = { caption?: string | null; contextInfo?: proto.IContextInfo | null };

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

function quotedIdOf(content: WAMessageContent | undefined): string | undefined {
  if (content === undefined) return undefined;
  const type = getContentType(content);
  if (type === undefined) return undefined;
  return contentBody(content, type)?.contextInfo?.stanzaId ?? undefined;
}

/**
 * Exported for tests and for send.ts: classify a Baileys message into our MessageKind.
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

  function canonical(jid: string): string {
    return canonicalId(jid, lookup);
  }

  /** Our own canonical id, or undefined while the socket has not told us who we are yet. */
  function self(): string | undefined {
    const id = selfId();
    return id === null ? undefined : canonical(id);
  }

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

  /** One transaction per chunk: bounded rollback, bounded commit cost. */
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

  function ingestMessage(m: WAMessage): void {
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

      const inserted = messages.upsert({
        chatId,
        id: messageId,
        senderId: senderOf(key, chatId, isGroup, fromMe),
        ts,
        fromMe,
        kind: kindOf(content),
        text: textOf(content),
        quotedId: quotedIdOf(content),
        status: m.status == null ? undefined : STATUS_NAMES[m.status],
        // The encoded envelope, byte-faithful, because the socket's getMessage contract is served
        // from it (Risk 3). Task 7 decodes it and unwraps `.message`; keep the two in step.
        raw: proto.WebMessageInfo.encode(m).finish(),
      });

      chats.touch(chatId, ts);
      if (fromMe) chats.clearUnread(chatId);
      else if (inserted) chats.bumpUnread(chatId, 1);
    } catch (err) {
      logger.warn({ err, messageId }, "ingest: failed to ingest message");
    }
  }

  function ingestMessages(ms: readonly WAMessage[]): void {
    runChunked(ms, "messages", ingestMessage);
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

  function advanceStatus(chatId: string, id: string, status: string): void {
    // `message-receipt.update` must never create a row, and per-device receipts in a group arrive
    // interleaved — Bob's "delivered" lands after Alice's "read" and must not undo it.
    const row = messages.get(chatId, id);
    if (row === undefined) return;
    const nextRank = STATUS_RANK[status] ?? 0;
    const currentRank = row.status === null ? 0 : (STATUS_RANK[row.status] ?? 0);
    if (nextRank !== 0 && nextRank <= currentRank) return;
    messages.setStatus(chatId, id, status);
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
    for (const c of cs) {
      const input = toContactInput(c);
      if (input !== undefined) inputs.push(input);
    }
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
    ingestMessages(h.messages);
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

  return { attach, ingestMessage, ingestMessages };
}
