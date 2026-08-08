/**
 * The presenters, and the one performance property the wire types exist to protect.
 *
 * **`reactionCounts` is the test that matters.** In process, `presentMessage` reaching for a row's
 * reactions cost a function call; over HTTP a client cannot issue one request per row, so the count
 * is denormalised into the row — and a naive port that fetches it per row turns a fifty-row page
 * into fifty queries, which is the cost the denormalisation exists to avoid. The counting repo
 * below makes that observable rather than assumed.
 *
 * Every shaped row is parsed against the SDK schema it claims to be. `tsc` cannot catch a
 * millisecond timestamp — it is a `number` either way — and `epochSeconds` can, so the assertion is
 * the parse and not a `deepEqual` against a literal.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Chat, Contact, Message, SearchHit } from "whatsapp-api-sdk";

import type { ChatRow } from "../db/chats.js";
import type { ContactRow, ContactsRepo } from "../db/contacts.js";
import type { MessageRow, SearchHit as SearchHitRow } from "../db/messages.js";
import type { MessageKey, ReactionCount, ReactionsRepo } from "../db/reactions.js";
import { presentChat, presentContact, presentMessage, presentSearchHit, reactionCounts } from "./present.js";

/** Only `displayName` is ever reached; the rest would be a lie about what the presenters use. */
function contactsStub(names: Record<string, string> = {}): ContactsRepo {
  return {
    displayName: (id: string) => names[id] ?? id,
  } as unknown as ContactsRepo;
}

/** A reactions repo that records how many grouped queries a page cost. */
function countingReactions(counts: readonly ReactionCount[] = []): {
  reactions: ReactionsRepo;
  calls: { n: number; keys: number };
} {
  const calls = { n: 0, keys: 0 };
  const reactions = {
    countsFor: (keys: readonly MessageKey[]): ReactionCount[] => {
      calls.n += 1;
      calls.keys += keys.length;
      const wanted = new Set(keys.map((k) => `${k.chatId}\u0000${k.messageId}`));
      return counts.filter((c) => wanted.has(`${c.chatId}\u0000${c.messageId}`));
    },
  } as unknown as ReactionsRepo;
  return { reactions, calls };
}

function messageRow(over: Partial<MessageRow> = {}): MessageRow {
  return {
    rowid: 1,
    chatId: "1@s.whatsapp.net",
    id: "M1",
    senderId: "1@s.whatsapp.net",
    ts: 1_700_000_000,
    fromMe: false,
    kind: "text",
    text: "hello",
    quotedId: null,
    status: null,
    editedTs: null,
    deletedTs: null,
    mediaType: null,
    mediaSha: null,
    ptt: null,
    durationS: null,
    transcript: null,
    transcriptModel: null,
    transcriptLanguage: null,
    ...over,
  };
}

function chatRow(over: Partial<ChatRow> = {}): ChatRow {
  return {
    id: "1@s.whatsapp.net",
    name: null,
    isGroup: false,
    lastMessageTs: 1_700_000_000,
    unreadCount: 0,
    archived: false,
    mutedUntil: null,
    participantCount: null,
    ...over,
  };
}

// --- the batching property ------------------------------------------------------------------------

void test("a page of messages costs one reaction query, not one per row", () => {
  const rows = Array.from({ length: 50 }, (_unused, i) => messageRow({ id: `M${String(i)}` }));
  const { reactions, calls } = countingReactions();
  reactionCounts(reactions, rows);
  assert.equal(calls.n, 1);
  assert.equal(calls.keys, 50);
});

void test("a page spanning many chats still costs one query", () => {
  // The shape this replaced was fine for a list scoped to one chat and quietly awful for a search:
  // a 200-hit page spanning 200 chats issued 200 queries.
  const rows = Array.from({ length: 20 }, (_unused, i) => messageRow({ chatId: `${String(i)}@s.whatsapp.net` }));
  const { reactions, calls } = countingReactions();
  reactionCounts(reactions, rows);
  assert.equal(calls.n, 1);
});

void test("an empty page issues no query at all", () => {
  const { reactions, calls } = countingReactions();
  assert.equal(reactionCounts(reactions, []).size, 0);
  assert.equal(calls.n, 0);
});

void test("counts are keyed on (chat, message), because an id is unique only inside its chat", () => {
  // Two chats, the same message id. Keying on the id alone lands one chat's count on the other's
  // row — invisible in a single-chat listing and wrong in every search page.
  const rows = [messageRow({ chatId: "a@g.us", id: "SAME" }), messageRow({ chatId: "b@g.us", id: "SAME" })];
  const { reactions } = countingReactions([{ chatId: "b@g.us", messageId: "SAME", count: 7 }]);
  const counts = reactionCounts(reactions, rows);
  assert.equal(counts.get("a@g.us\u0000SAME"), undefined);
  assert.equal(counts.get("b@g.us\u0000SAME"), 7);
});

// --- presentMessage -------------------------------------------------------------------------------

void test("presentMessage answers a row the Message schema accepts", () => {
  const shaped = presentMessage(messageRow(), { contacts: contactsStub({ "1@s.whatsapp.net": "Ada" }) }, 3);
  const parsed = Message.parse(shaped);
  assert.equal(parsed.sender.name, "Ada");
  assert.equal(parsed.reactionCount, 3);
  assert.equal(parsed.media, null);
  assert.equal(parsed.edited, false);
  assert.equal(parsed.deleted, false);
});

void test("presentMessage resolves the sender's display name rather than shipping the JID", () => {
  // Denormalisation is the point: a client cannot issue one contact lookup per row.
  const shaped = presentMessage(messageRow({ senderId: "99@s.whatsapp.net" }), { contacts: contactsStub() }, 0);
  // `displayName` falls back to the id when it knows nothing, and that fallback is the contract.
  assert.equal(shaped.sender.id, "99@s.whatsapp.net");
  assert.equal(shaped.sender.name, "99@s.whatsapp.net");
});

void test("edited and deleted are booleans on the wire, not the timestamps behind them", () => {
  const shaped = presentMessage(
    messageRow({ editedTs: 1_700_000_001, deletedTs: 1_700_000_002 }),
    {
      contacts: contactsStub(),
    },
    0,
  );
  assert.equal(shaped.edited, true);
  assert.equal(shaped.deleted, true);
});

void test("media is null only when the row carries neither a type nor a cached blob", () => {
  const none = presentMessage(messageRow(), { contacts: contactsStub() }, 0);
  assert.equal(none.media, null);

  const declared = presentMessage(
    messageRow({ kind: "image", mediaType: "image/jpeg" }),
    {
      contacts: contactsStub(),
    },
    0,
  );
  assert.deepEqual(declared.media, { type: "image/jpeg", cached: false });

  // A row whose bytes are cached but whose declared type was lost still has media.
  const cached = presentMessage(
    messageRow({ kind: "image", mediaSha: "a".repeat(64) }),
    {
      contacts: contactsStub(),
    },
    0,
  );
  assert.deepEqual(cached.media, { type: null, cached: true });
});

void test("a status WhatsApp never sent a receipt for stays null rather than becoming a placeholder", () => {
  const shaped = presentMessage(messageRow({ status: null }), { contacts: contactsStub() }, 0);
  assert.equal(Message.parse(shaped).status, null);
});

void test("a millisecond timestamp is refused by the schema this shape claims to satisfy", () => {
  // The assertion `tsc` cannot make: `Date.now()` is an integer, so only `epochSeconds` catches a
  // stamp that never got divided — and it would surface as a message dated 55 000 AD.
  const shaped = presentMessage(messageRow({ ts: Date.now() }), { contacts: contactsStub() }, 0);
  assert.equal(Message.safeParse(shaped).success, false);
});

// --- presentSearchHit -----------------------------------------------------------------------------

void test("presentSearchHit is a Message plus what made it a hit", () => {
  const hit: SearchHitRow = { ...messageRow(), snippet: "…hello…", matchedTranscript: true };
  const shaped = presentSearchHit(hit, { contacts: contactsStub({ "1@s.whatsapp.net": "Ada" }) }, 1);
  const parsed = SearchHit.parse(shaped);
  assert.equal(parsed.snippet, "…hello…");
  assert.equal(parsed.matchedTranscript, true);
  assert.equal(parsed.sender.name, "Ada");
  assert.equal(parsed.reactionCount, 1);
});

// --- presentChat ----------------------------------------------------------------------------------

void test("presentChat answers a row the Chat schema accepts", () => {
  const shaped = presentChat(chatRow({ name: "Team", isGroup: true, participantCount: 4 }), {
    contacts: contactsStub(),
  });
  const parsed = Chat.parse(shaped);
  assert.equal(parsed.name, "Team");
  assert.equal(parsed.isGroup, true);
  assert.equal(parsed.participantCount, 4);
});

void test("an unnamed DM falls back to the contact's display name", () => {
  const shaped = presentChat(chatRow({ id: "1@s.whatsapp.net" }), {
    contacts: contactsStub({ "1@s.whatsapp.net": "Ada" }),
  });
  assert.equal(shaped.name, "Ada");
});

void test("an unnamed DM whose contact is unknown reports null, never its own JID", () => {
  // `displayName` answers with the id when it knows nothing, and the id is already the `id` field.
  // Echoing it as a name is how a model ends up addressing someone by their phone number.
  const shaped = presentChat(chatRow({ id: "1@s.whatsapp.net" }), { contacts: contactsStub() });
  assert.equal(shaped.name, null);
});

void test("an unnamed group reports null without consulting contacts", () => {
  const shaped = presentChat(chatRow({ id: "x@g.us", isGroup: true }), {
    contacts: contactsStub({ "x@g.us": "should not be used" }),
  });
  assert.equal(shaped.name, null);
});

void test("mutedUntil is not held to the epochSeconds bound", () => {
  // A "muted forever" sentinel divides to a value above the millisecond threshold, and refusing it
  // would fail a whole chat page over one row. `Chat.mutedUntil` is exempt; this pins that the
  // presenter passes it through rather than clamping or dropping it.
  const shaped = presentChat(chatRow({ mutedUntil: 9_223_372_036_854_776 }), { contacts: contactsStub() });
  assert.equal(Chat.safeParse(shaped).success, true);
  assert.equal(shaped.mutedUntil, 9_223_372_036_854_776);
});

// --- presentContact -------------------------------------------------------------------------------

void test("presentContact answers a row the Contact schema accepts", () => {
  const row: ContactRow = { id: "1@s.whatsapp.net", name: "Ada", notify: "ada", phoneNumber: "1", lid: null };
  assert.deepEqual(Contact.parse(presentContact(row)), {
    id: "1@s.whatsapp.net",
    name: "Ada",
    notify: "ada",
    phoneNumber: "1",
    lid: null,
  });
});
