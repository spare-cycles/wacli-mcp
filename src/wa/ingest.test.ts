import { WAMessageStatus, type BaileysEventMap, type WAMessage, type WASocket } from "baileys";
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Logger } from "pino";
import { makeChatsRepo } from "../db/chats.js";
import { openDb } from "../db/client.js";
import { makeContactsRepo } from "../db/contacts.js";
import { makeMessagesRepo, type MessageInput, type MessagesRepo } from "../db/messages.js";
import { makeReactionsRepo } from "../db/reactions.js";
import * as fx from "./fixtures.js";
import { classify, extractText, makeIngest } from "./ingest.js";

const DM = "33612345678@s.whatsapp.net";
const GROUP = "120363@g.us";
const SELF = "33600000000@s.whatsapp.net";

const dir = mkdtempSync(join(tmpdir(), "wa-ingest-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function harness(selfId: () => string | null = () => SELF) {
  const db = openDb(join(dir, `i${n++}.db`));
  const repos = {
    chats: makeChatsRepo(db),
    contacts: makeContactsRepo(db),
    messages: makeMessagesRepo(db),
    reactions: makeReactionsRepo(db),
  };
  const logger = {
    info() {
      /* no-op */
    },
    warn() {
      /* no-op */
    },
    error() {
      /* no-op */
    },
    debug() {
      /* no-op */
    },
  } as unknown as Logger;
  const ingest = makeIngest({ db, ...repos, logger, selfId });
  return { db, ...repos, ingest };
}

/**
 * A harness whose `messages.upsert` throws on its `failOnCall`-th call, and whose `logger.warn`
 * rethrows what `ingestMessage`'s own catch hands it.
 *
 * That catch exists to skip one malformed *message*, and it contains every failure it can see — so
 * a failure has to escape it to reach the chunk boundary at all, and rethrowing from the logger is
 * how this harness produces one. What it stands in for is a store that is failing rather than a
 * payload that is malformed, which is the only thing the per-chunk transaction can protect
 * against, and the only way any assertion in this suite observes that transaction.
 */
function failingHarness(failOnCall: number) {
  const db = openDb(join(dir, `i${n++}.db`));
  const messages = makeMessagesRepo(db);
  let calls = 0;
  const failing: MessagesRepo = {
    ...messages,
    upsert: (m: MessageInput) => {
      calls += 1;
      if (calls === failOnCall) throw new Error("the store is failing");
      return messages.upsert(m);
    },
  };
  const logger = {
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
    warn: (fields: { err: Error }) => {
      throw fields.err;
    },
  } as unknown as Logger;
  const chats = makeChatsRepo(db);
  const ingest = makeIngest({
    db,
    chats,
    contacts: makeContactsRepo(db),
    messages: failing,
    reactions: makeReactionsRepo(db),
    logger,
    selfId: () => SELF,
  });
  return { chats, messages, ingest };
}

/** A socket stub carrying nothing but the event emitter `attach` subscribes to. */
function socket() {
  const ev = new EventEmitter();
  const sock = { ev: { on: ev.on.bind(ev) } } as unknown as WASocket;
  function emit<T extends keyof BaileysEventMap>(event: T, payload: BaileysEventMap[T]): void {
    ev.emit(event, payload);
  }
  return { sock, emit };
}

// --- ingestMessage -------------------------------------------------------------------------

void test("a text message creates the chat and the message", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.textMessage({ chat: DM, id: "M1", text: "salut", ts: 1700 }));
  assert.equal(h.chats.get(DM)?.lastMessageTs, 1700);
  const m = h.messages.get(DM, "M1");
  assert.equal(m?.text, "salut");
  assert.equal(m.kind, "text");
  assert.equal(m.fromMe, false);
});

void test("raw protobuf bytes are stored so getMessage can work", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.textMessage({ id: "M1" }));
  const raw = h.messages.getRaw(DM, "M1");
  assert.ok(raw && raw.byteLength > 0, "every ingested message must carry its encoded bytes");
});

void test("a group message records the participant as sender, not the group", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.groupMessage({ chat: GROUP, participant: DM, id: "G1" }));
  const m = h.messages.get(GROUP, "G1");
  assert.equal(m?.senderId, DM);
  assert.equal(h.chats.get(GROUP)?.isGroup, true);
});

void test("a DM records the chat itself as sender", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.textMessage({ chat: DM, id: "M1" }));
  assert.equal(h.messages.get(DM, "M1")?.senderId, DM);
});

void test("device suffixes are normalized away", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.textMessage({ chat: "33612345678:12@s.whatsapp.net", id: "M1" }));
  assert.ok(h.chats.get(DM), "the chat id must be normalized");
  assert.equal(h.chats.get("33612345678:12@s.whatsapp.net"), undefined);
});

void test("fromMe is derived from the key, and marks the chat read", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.textMessage({ id: "M1", fromMe: true }));
  assert.equal(h.messages.get(DM, "M1")?.fromMe, true);
  assert.equal(h.chats.get(DM)?.unreadCount, 0);
});

void test("an outbound message's sender is the account's own canonical id, device suffix stripped", () => {
  const h = harness(() => "33600000000:14@s.whatsapp.net");
  h.ingest.ingestMessage(fx.textMessage({ id: "M1", fromMe: true }));
  assert.equal(h.messages.get(DM, "M1")?.senderId, SELF, "selfId arrives with a device suffix and must be normalized");
});

void test("an outbound message is still stored when the account's own id is not known yet", () => {
  const h = harness(() => null);
  h.ingest.ingestMessage(fx.textMessage({ id: "M1", fromMe: true }));
  const m = h.messages.get(DM, "M1");
  assert.equal(m?.fromMe, true, "from_me carries the fact; an unknown self id must not drop the message");
});

void test("an inbound message bumps unread, an outbound one does not", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.textMessage({ id: "A", fromMe: false }));
  h.ingest.ingestMessage(fx.textMessage({ id: "B", fromMe: false }));
  assert.equal(h.chats.get(DM)?.unreadCount, 2);
  h.ingest.ingestMessage(fx.textMessage({ id: "C", fromMe: true }));
  assert.equal(h.chats.get(DM)?.unreadCount, 0);
});

void test("status@broadcast is never ingested", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.textMessage({ chat: "status@broadcast", id: "S1" }));
  assert.equal(h.messages.count(), 0);
  assert.equal(h.chats.count(), 0, "the status feed must not even create a chat row");
});

void test("control stanzas delivered on messages.upsert are not stored as messages", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  h.ingest.ingestMessage(fx.textMessage({ id: "M1" }));
  // Baileys hands every stanza to messages.upsert, including the ones whose *effect* it also
  // reports through messages.update / messages.delete / messages.reaction.
  s.emit("messages.upsert", {
    messages: [
      {
        key: { remoteJid: DM, id: "P1", fromMe: false },
        messageTimestamp: 1_700_000_100,
        message: { protocolMessage: { key: { remoteJid: DM, id: "M1" }, type: 0 } },
      },
      {
        key: { remoteJid: DM, id: "P2", fromMe: false },
        messageTimestamp: 1_700_000_100,
        message: { reactionMessage: { key: { remoteJid: DM, id: "M1" }, text: "\u{1F44D}" } },
      },
    ],
    type: "notify",
  });
  assert.equal(h.messages.count(), 1, "a revoke or reaction stanza must not become a textless message row");
  assert.equal(h.chats.get(DM)?.unreadCount, 1, "nor a phantom unread on top of the effect already applied");
});

void test("a message without a remoteJid or without an id is skipped", () => {
  const h = harness();
  const noChat = { ...fx.textMessage({ id: "M1" }), key: { id: "M1", fromMe: false } } as WAMessage;
  const noId = { ...fx.textMessage({}), key: { remoteJid: DM, fromMe: false } } as WAMessage;
  h.ingest.ingestMessage(noChat);
  h.ingest.ingestMessage(noId);
  assert.equal(h.messages.count(), 0);
  assert.equal(h.chats.count(), 0);
});

void test("timestamps are stored as integer Unix seconds even when protobuf hands back a Long", () => {
  const h = harness();
  // protobufjs returns a Long for 64-bit fields, which fails silently in arithmetic comparisons.
  const long = { low: 1_700_000_123, high: 0, unsigned: false, toNumber: () => 1_700_000_123 };
  const m = { ...fx.textMessage({ id: "M1" }), messageTimestamp: long } as unknown as WAMessage;
  h.ingest.ingestMessage(m);
  assert.equal(h.messages.get(DM, "M1")?.ts, 1_700_000_123, "a Long messageTimestamp must be converted, not coerced");
});

// --- classify / extractText ----------------------------------------------------------------

void test("classify covers every media wrapper", () => {
  assert.equal(classify(fx.textMessage({})), "text");
  assert.equal(classify(fx.imageMessage({})), "image");
  assert.equal(classify(fx.videoMessage({})), "video");
  assert.equal(classify(fx.audioMessage({})), "audio");
  assert.equal(classify(fx.documentMessage({})), "document");
  assert.equal(classify(fx.stickerMessage({})), "sticker");
  assert.equal(classify(fx.extendedTextReply({})), "text");
});

void test("classify and extractText see through view-once and ephemeral envelopes", () => {
  const viewOnce = fx.viewOnceImage({ caption: "gone in 60 seconds" });
  assert.equal(classify(viewOnce), "image", "a view-once photo must not be classified as `other`");
  assert.equal(extractText(viewOnce), "gone in 60 seconds");

  const ephemeral = fx.ephemeralText({ text: "disappearing" });
  assert.equal(classify(ephemeral), "text");
  assert.equal(extractText(ephemeral), "disappearing");
});

void test("extractText reads conversation, extendedText and media captions", () => {
  assert.equal(extractText(fx.textMessage({ text: "plain" })), "plain");
  assert.equal(extractText(fx.extendedTextReply({ text: "quoted reply" })), "quoted reply");
  assert.equal(extractText(fx.imageMessage({ caption: "a caption" })), "a caption");
  assert.equal(extractText(fx.audioMessage({})), undefined);
});

void test("a reply records the quoted message id", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.extendedTextReply({ id: "R1", quotedId: "M0", text: "re" }));
  assert.equal(h.messages.get(DM, "R1")?.quotedId, "M0");
});

void test("an ingested media message records its media type but downloads nothing", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.imageMessage({ id: "I1" }));
  const m = h.messages.get(DM, "I1");
  assert.equal(m?.kind, "image");
  assert.equal(m.mediaSha, null, "ingest must stay lazy — no download at ingest time");
});

// --- identity ------------------------------------------------------------------------------

void test("a LID-addressed message is canonicalized when the mapping is known", () => {
  const h = harness();
  h.contacts.linkIdentity("999@lid", DM);
  h.ingest.ingestMessage(fx.lidMessage({ chat: "999@lid", id: "L1" }));
  assert.ok(h.chats.get(DM), "a known LID must fold into the phone identity");
  assert.equal(h.chats.get("999@lid"), undefined);
});

void test("an unknown LID is kept as-is rather than dropped", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.lidMessage({ chat: "888@lid", id: "L2" }));
  assert.ok(h.chats.get("888@lid"));
});

// --- idempotency and batching --------------------------------------------------------------

void test("ingesting the same message twice is idempotent", () => {
  const h = harness();
  const m = fx.textMessage({ id: "M1" });
  h.ingest.ingestMessage(m);
  h.ingest.ingestMessage(m);
  assert.equal(h.messages.count(), 1);
  assert.equal(h.chats.get(DM)?.unreadCount, 1, "a redelivery must not double-count unread");
});

void test("a redelivery cannot walk a stored status backwards", () => {
  const h = harness();
  const read = { ...fx.textMessage({ id: "M1", fromMe: true }), status: WAMessageStatus.READ };
  h.ingest.ingestMessage(read);
  assert.equal(h.messages.get(DM, "M1")?.status, "read");

  h.ingest.ingestMessage({ ...read, status: WAMessageStatus.PENDING });
  assert.equal(h.messages.get(DM, "M1")?.status, "read", "a redelivered PENDING must not replace a stored `read`");
});

void test("ingestMessages writes every message of a batch", () => {
  const h = harness();
  h.ingest.ingestMessages([fx.textMessage({ id: "A", ts: 1 }), fx.textMessage({ id: "B", ts: 2 })]);
  assert.equal(h.messages.count(), 2);
});

void test("a chunk that fails rolls back whole, and the chunk before it survives", () => {
  // 502 messages: chunk 1 is H0..H499 and commits, chunk 2 is H500..H501 and fails on its *second*
  // row. Failing on its first would leave nothing to roll back, so the assertions below would hold
  // with or without the transaction.
  const h = failingHarness(502);
  const ms = Array.from({ length: 502 }, (_, i) => fx.textMessage({ id: `H${String(i)}`, ts: 1_700_000_000 + i }));
  assert.throws(
    () => {
      h.ingest.ingestMessages(ms);
    },
    /the store is failing/,
    "a failure the per-message guard cannot absorb must reach the caller, not be half-applied",
  );
  assert.equal(h.messages.count(), 500, "the failing chunk rolls back whole; the one before it is already committed");
  assert.equal(h.messages.get(DM, "H499")?.id, "H499", "a committed chunk survives the failure of the next");
  assert.equal(h.messages.get(DM, "H500"), undefined, "a row written before the failure must not outlive its chunk");
});

void test("a malformed message is logged and skipped, not thrown", () => {
  const h = harness();
  assert.doesNotThrow(() => {
    h.ingest.ingestMessage({ key: {} });
  });
  assert.equal(h.messages.count(), 0);
});

void test("one malformed message in a batch does not cost the rest of the chunk", () => {
  const h = harness();
  h.ingest.ingestMessages([
    fx.textMessage({ id: "A" }),
    { key: {} },
    fx.textMessage({ id: "B" }),
    undefined as never,
    fx.textMessage({ id: "C" }),
  ]);
  assert.equal(h.messages.count(), 3);
});

// --- attach: events ------------------------------------------------------------------------

void test("attach wires messages.upsert onto ingestMessages", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  s.emit("messages.upsert", { messages: [fx.textMessage({ id: "M1", text: "hi" })], type: "notify" });
  assert.equal(h.messages.get(DM, "M1")?.text, "hi");
});

void test("a revoke arriving on messages.update tombstones the message", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  h.ingest.ingestMessage(fx.textMessage({ id: "M1", text: "oops" }));
  s.emit("messages.update", [
    { key: { remoteJid: DM, id: "M1", fromMe: false }, update: { message: null, messageStubType: 1 } },
  ]);
  const m = h.messages.get(DM, "M1");
  assert.ok(m?.deletedTs, "a revoke on messages.update must tombstone");
  assert.equal(m.text, null, "the revoked text must not survive");
});

void test("a revoke arriving on messages.delete tombstones the message", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  h.ingest.ingestMessage(fx.textMessage({ id: "M1" }));
  s.emit("messages.delete", { keys: [{ remoteJid: DM, id: "M1", fromMe: false }] });
  assert.ok(h.messages.get(DM, "M1")?.deletedTs);
});

void test("the `all: true` form of messages.delete is deliberately ignored", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  h.ingest.ingestMessage(fx.textMessage({ id: "M1" }));
  s.emit("messages.delete", { jid: DM, all: true });
  assert.equal(h.messages.get(DM, "M1")?.deletedTs, null, "this is a forward-only store: history is kept");
});

void test("an edit arriving on messages.update rewrites the text and stamps edited_ts", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  h.ingest.ingestMessage(fx.textMessage({ id: "M1", text: "typo" }));
  s.emit("messages.update", [
    {
      key: { remoteJid: DM, id: "M1", fromMe: false },
      update: { message: { editedMessage: { message: { conversation: "fixed" } } }, messageTimestamp: 1_700_000_500 },
    },
  ]);
  const m = h.messages.get(DM, "M1");
  assert.equal(m?.text, "fixed");
  assert.equal(m.editedTs, 1_700_000_500);
});

void test("messages.update maps a status code to a name and never moves it backwards", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  h.ingest.ingestMessage(fx.textMessage({ id: "M1", fromMe: true }));
  s.emit("messages.update", [{ key: { remoteJid: DM, id: "M1", fromMe: true }, update: { status: 4 } }]);
  assert.equal(h.messages.get(DM, "M1")?.status, "read");
  s.emit("messages.update", [{ key: { remoteJid: DM, id: "M1", fromMe: true }, update: { status: 2 } }]);
  assert.equal(h.messages.get(DM, "M1")?.status, "read", "a late per-device ack must not un-read a message");
});

void test("an error is written only while nothing has acknowledged the message", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  const fail = (id: string) => {
    s.emit("messages.update", [
      { key: { remoteJid: DM, id, fromMe: true }, update: { status: WAMessageStatus.ERROR } },
    ]);
  };

  h.ingest.ingestMessage(fx.textMessage({ id: "M1", fromMe: true }));
  s.emit("messages.update", [
    { key: { remoteJid: DM, id: "M1", fromMe: true }, update: { status: WAMessageStatus.READ } },
  ]);
  fail("M1");
  assert.equal(h.messages.get(DM, "M1")?.status, "read", "one failed per-device delivery must not un-read a message");

  h.ingest.ingestMessage(fx.textMessage({ id: "M2", fromMe: true }));
  fail("M2");
  assert.equal(h.messages.get(DM, "M2")?.status, "error", "with nothing stored, the failure is the news");

  h.ingest.ingestMessage({ ...fx.textMessage({ id: "M3", fromMe: true }), status: WAMessageStatus.PENDING });
  fail("M3");
  assert.equal(h.messages.get(DM, "M3")?.status, "error", "a message still pending has acknowledged nothing either");
});

void test("message-receipt.update sets status and never creates a row", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  s.emit("message-receipt.update", [
    { key: { remoteJid: DM, id: "GHOST", fromMe: true }, receipt: { userJid: DM, readTimestamp: 1_700_000_400 } },
  ]);
  assert.equal(h.messages.count(), 0, "a receipt for an unknown message must not conjure one");

  h.ingest.ingestMessage(fx.textMessage({ id: "M1", fromMe: true }));
  s.emit("message-receipt.update", [
    { key: { remoteJid: DM, id: "M1", fromMe: true }, receipt: { userJid: DM, receiptTimestamp: 1_700_000_300 } },
  ]);
  assert.equal(h.messages.get(DM, "M1")?.status, "delivered");
  s.emit("message-receipt.update", [
    { key: { remoteJid: DM, id: "M1", fromMe: true }, receipt: { userJid: DM, readTimestamp: 1_700_000_400 } },
  ]);
  assert.equal(h.messages.get(DM, "M1")?.status, "read");
});

void test("messages.reaction records the reactor canonically, and an empty text removes it", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  const reactorKey = { remoteJid: GROUP, id: "R1", fromMe: false, participant: "33612345678:3@s.whatsapp.net" };
  s.emit("messages.reaction", [
    {
      key: { remoteJid: GROUP, id: "G1", fromMe: false },
      reaction: { key: reactorKey, text: "\u{1F44D}", senderTimestampMs: 1_700_000_600_000 },
    },
  ]);
  const [r] = h.reactions.forMessage(GROUP, "G1");
  assert.equal(r?.senderId, DM, "the reactor is the participant, device suffix stripped");
  assert.equal(r.emoji, "\u{1F44D}");
  assert.equal(r.ts, 1_700_000_600, "senderTimestampMs is milliseconds and must be stored as seconds");

  s.emit("messages.reaction", [
    { key: { remoteJid: GROUP, id: "G1", fromMe: false }, reaction: { key: reactorKey, text: "" } },
  ]);
  assert.equal(h.reactions.count(), 0, "an empty reaction text removes the reaction");
});

void test("chats.upsert and chats.update ensure the row and patch its fields", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  s.emit("chats.upsert", [{ id: GROUP, name: "Les copains", conversationTimestamp: 1_700_000_700, participant: [] }]);
  const created = h.chats.get(GROUP);
  assert.equal(created?.name, "Les copains");
  assert.equal(created.isGroup, true);
  assert.equal(created.lastMessageTs, 1_700_000_700, "conversationTimestamp orders a chat with no synced messages");

  s.emit("chats.update", [{ id: GROUP, archived: true, unreadCount: 3, muteEndTime: 1_800_000_000_000 }]);
  const updated = h.chats.get(GROUP);
  assert.equal(updated?.archived, true);
  assert.equal(updated.unreadCount, 3);
  assert.equal(updated.mutedUntil, 1_800_000_000, "muteEndTime is milliseconds and must be stored as seconds");
  assert.equal(updated.name, "Les copains", "an update without a name must not erase it");
});

void test("chats.update never writes WhatsApp's negative `mark unread` sentinel", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  h.ingest.ingestMessage(fx.textMessage({ chat: DM, id: "M1" }));
  s.emit("chats.update", [{ id: DM, unreadCount: -1 }]);
  assert.equal(h.chats.get(DM)?.unreadCount, 1, "-1 means `mark unread`, not a count");
});

void test("contacts.upsert keys the row by the phone identity and stores bare local parts", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  s.emit("contacts.upsert", [{ id: "999@lid", lid: "999@lid", phoneNumber: DM, name: "Alice", notify: "al" }]);
  const c = h.contacts.get(DM);
  assert.equal(c?.phoneNumber, "33612345678");
  assert.equal(c.lid, "999");
  assert.equal(c.name, "Alice");
  assert.equal(h.contacts.get("999@lid"), undefined, "a contact carrying both identities is keyed by the phone one");
  assert.equal(h.contacts.pnForLid("999"), DM, "and that makes canonicalId resolve the LID from then on");
});

void test("a contact carrying both identities folds a chat already ingested under the LID", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  h.ingest.ingestMessage(fx.lidMessage({ chat: "999@lid", id: "L1", text: "coucou" }));
  s.emit("contacts.upsert", [{ id: "999@lid", lid: "999@lid", phoneNumber: DM, name: "Alice" }]);
  assert.equal(
    h.chats.get("999@lid"),
    undefined,
    "the pair a contact reveals must fold the LID chat, as a mapping does",
  );
  assert.equal(h.messages.get(DM, "L1")?.text, "coucou", "and its messages come along");
  assert.equal(h.contacts.get(DM)?.name, "Alice");
});

void test("contacts.update keeps a LID-only contact under its LID id", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  s.emit("contacts.update", [{ id: "777@lid", notify: "Mystery" }]);
  assert.equal(h.contacts.get("777@lid")?.notify, "Mystery");
});

void test("lid-mapping.update links the identity and folds an already-ingested LID chat", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  h.ingest.ingestMessage(fx.lidMessage({ chat: "999@lid", id: "L1", text: "coucou" }));
  s.emit("lid-mapping.update", { lid: "999@lid", pn: DM });
  assert.equal(h.chats.get("999@lid"), undefined, "the LID chat must fold into the phone chat");
  assert.equal(h.messages.get(DM, "L1")?.text, "coucou", "and its messages come along");
});

void test("messaging-history.set ingests mappings, contacts, chats and messages", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  s.emit("messaging-history.set", {
    chats: [{ id: GROUP, name: "Les copains" }],
    contacts: [{ id: DM, name: "Alice" }],
    messages: [fx.groupMessage({ chat: GROUP, participant: "999@lid", id: "G1", ts: 1_700_000_800 })],
    lidPnMappings: [{ lid: "999@lid", pn: DM }],
    isLatest: true,
  });
  assert.equal(h.contacts.get(DM)?.name, "Alice");
  assert.equal(h.chats.get(GROUP)?.name, "Les copains");
  assert.equal(
    h.messages.get(GROUP, "G1")?.senderId,
    DM,
    "the mappings in the same payload must be applied before its messages",
  );
});

void test("a history sync leaves the server's unread count alone; the live path bumps it", () => {
  const inbound = () => [
    fx.textMessage({ id: "H1", ts: 1_700_000_001 }),
    fx.textMessage({ id: "H2", ts: 1_700_000_002 }),
    fx.textMessage({ id: "H3", ts: 1_700_000_003 }),
  ];

  const history = harness();
  const hs = socket();
  history.ingest.attach(hs.sock);
  hs.emit("messaging-history.set", { chats: [{ id: DM, unreadCount: 0 }], contacts: [], messages: inbound() });
  assert.equal(history.messages.count(), 3);
  assert.equal(
    history.chats.get(DM)?.unreadCount,
    0,
    "the chat half of the batch carries the server's own count; the messages must not bump it",
  );

  const live = harness();
  const ls = socket();
  live.ingest.attach(ls.sock);
  ls.emit("messages.upsert", { messages: inbound(), type: "notify" });
  assert.equal(live.chats.get(DM)?.unreadCount, 3, "the same messages arriving live really are unread");
});

void test("messaging-history.set ingests a payload larger than one chunk", () => {
  const h = harness();
  const s = socket();
  h.ingest.attach(s.sock);
  const messages = Array.from({ length: 501 }, (_, i) =>
    fx.textMessage({ id: `H${String(i)}`, ts: 1_700_000_000 + i }),
  );
  s.emit("messaging-history.set", { chats: [], contacts: [], messages });
  assert.equal(h.messages.count(), 501, "chunking at 500 must not drop the tail");
  assert.equal(h.chats.get(DM)?.lastMessageTs, 1_700_000_500);
});
