import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeChatsRepo } from "./chats.js";
import { openDb } from "./client.js";
import { makeContactsRepo } from "./contacts.js";
import { makeMessagesRepo, type MessageInput } from "./messages.js";

const dir = mkdtempSync(join(tmpdir(), "whatsapp-msg-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});
let n = 0;
function repo() {
  const db = openDb(join(dir, `m${n++}.db`));
  const chats = makeChatsRepo(db);
  chats.ensure("c", false);
  chats.ensure("c2", false);
  return makeMessagesRepo(db);
}
const msg = (over: Partial<MessageInput> = {}): MessageInput => ({
  chatId: "c",
  id: "M1",
  senderId: "s@s.whatsapp.net",
  ts: 1000,
  fromMe: false,
  kind: "text",
  text: "hello",
  ...over,
});

void test("upsert then get round-trips", () => {
  const r = repo();
  r.upsert(msg());
  const m = r.get("c", "M1");
  assert.equal(m?.text, "hello");
  assert.equal(m.fromMe, false);
  assert.equal(m.kind, "text");
  assert.equal(m.deletedTs, null);
});

void test("upsert is idempotent on (chat, id) and updates in place", () => {
  const r = repo();
  const inserted = r.upsert(msg());
  const updated = r.upsert(msg({ text: "hello again", status: "delivered" }));
  assert.equal(r.count(), 1);
  assert.equal(r.get("c", "M1")?.text, "hello again");
  assert.equal(r.get("c", "M1")?.status, "delivered");
  assert.equal(inserted, true, "a fresh insert must report true");
  assert.equal(updated, false, "re-upserting the same (chat_id, id) must report false");
});

void test("upsert returns false on a partial update of an existing row", () => {
  const r = repo();
  r.upsert(msg());
  const updated = r.upsert(msg({ text: undefined, status: "read" }));
  assert.equal(updated, false);
  assert.equal(r.get("c", "M1")?.text, "hello", "COALESCE must keep the prior text");
  assert.equal(r.get("c", "M1")?.status, "read");
});

void test("the same message id in two chats is two rows", () => {
  const r = repo();
  const first = r.upsert(msg({ chatId: "c" }));
  const second = r.upsert(msg({ chatId: "c2" }));
  assert.equal(r.count(), 2);
  assert.equal(first, true, "a fresh insert into chat c must report true");
  assert.equal(second, true, "the same message id in a different chat is a different logical message");
});

void test("getRaw returns the exact bytes stored", () => {
  const r = repo();
  const raw = new Uint8Array([0x0a, 0x00, 0xff, 0x7f, 0x80]);
  r.upsert(msg({ raw }));
  assert.deepEqual(r.getRaw("c", "M1"), raw);
  assert.equal(r.getRaw("c", "nope"), undefined);
});

void test("markEdited sets text and edited_ts, keeping the row", () => {
  const r = repo();
  r.upsert(msg());
  r.markEdited("c", "M1", "corrected", 2000);
  const m = r.get("c", "M1");
  assert.equal(m?.text, "corrected");
  assert.equal(m.editedTs, 2000);
  assert.equal(r.search("corrected", {}, 10, 0).length, 1);
  assert.equal(r.search("hello", {}, 10, 0).length, 0, "the pre-edit text must leave the index");
});

void test("markDeleted tombstones: row kept, text cleared, dropped from search", () => {
  const r = repo();
  r.upsert(msg());
  r.markDeleted("c", "M1", 3000);
  const m = r.get("c", "M1");
  assert.ok(m, "the row must survive so threads stay coherent");
  assert.equal(m.text, null);
  assert.equal(m.deletedTs, 3000);
  assert.equal(r.search("hello", {}, 10, 0).length, 0);
});

void test("list excludes deleted by default and orders newest first", () => {
  const r = repo();
  r.upsert(msg({ id: "M1", ts: 100 }));
  r.upsert(msg({ id: "M2", ts: 300 }));
  r.upsert(msg({ id: "M3", ts: 200 }));
  r.markDeleted("c", "M3", 400);
  assert.deepEqual(
    r.list({ chatId: "c" }, 10, 0).map((m) => m.id),
    ["M2", "M1"],
  );
  assert.deepEqual(
    r.list({ chatId: "c", includeDeleted: true }, 10, 0).map((m) => m.id),
    ["M2", "M3", "M1"],
  );
});

void test("list filters compose", () => {
  const r = repo();
  r.upsert(msg({ id: "A", ts: 100, fromMe: true, senderId: "me" }));
  r.upsert(msg({ id: "B", ts: 200, fromMe: false, senderId: "other" }));
  r.upsert(msg({ id: "C", ts: 300, fromMe: false, senderId: "other" }));
  assert.deepEqual(
    r.list({ chatId: "c", fromMe: true }, 10, 0).map((m) => m.id),
    ["A"],
  );
  assert.deepEqual(
    r.list({ chatId: "c", senderId: "other" }, 10, 0).map((m) => m.id),
    ["C", "B"],
  );
  assert.deepEqual(
    r.list({ chatId: "c", after: 150, before: 250 }, 10, 0).map((m) => m.id),
    ["B"],
  );
});

void test("list orders oldest first under asc, tie-breaking the same way in both directions", () => {
  const r = repo();
  // Equal timestamps on purpose: `rowid` is the tie-break, and it has to flip with `ts` or an
  // ascending walk and a descending one disagree about the order of these two.
  r.upsert(msg({ id: "A", ts: 100 }));
  r.upsert(msg({ id: "B", ts: 100 }));
  r.upsert(msg({ id: "C", ts: 300 }));
  assert.deepEqual(
    r.list({ chatId: "c", asc: true }, 10, 0).map((m) => m.id),
    ["A", "B", "C"],
  );
  assert.deepEqual(
    r.list({ chatId: "c" }, 10, 0).map((m) => m.id),
    ["C", "B", "A"],
  );
});

void test("list narrows by kind and by hasMedia in both directions", () => {
  const r = repo();
  r.upsert(msg({ id: "T", kind: "text" }));
  r.upsert(msg({ id: "I", kind: "image", text: undefined, ts: 1100 }));
  r.upsert(msg({ id: "V", kind: "audio", text: undefined, ts: 1200 }));
  r.upsert(msg({ id: "L", kind: "location", text: undefined, ts: 1300 }));

  assert.deepEqual(
    r.list({ chatId: "c", kind: "image" }, 10, 0).map((m) => m.id),
    ["I"],
  );
  assert.deepEqual(
    r.list({ chatId: "c", hasMedia: true }, 10, 0).map((m) => m.id),
    ["V", "I"],
  );
  // The false branch is the one a `NOT IN` typo would break silently: a location is not media, and
  // must be *included* here rather than swept up with the attachments.
  assert.deepEqual(
    r.list({ chatId: "c", hasMedia: false }, 10, 0).map((m) => m.id),
    ["L", "T"],
  );
});

void test("search narrows by the same filters as list", () => {
  const r = repo();
  r.upsert(msg({ id: "A", ts: 100, senderId: "alice", text: "orange juice" }));
  r.upsert(msg({ id: "B", ts: 200, senderId: "bob", text: "orange juice" }));
  r.upsert(msg({ id: "P", ts: 300, senderId: "bob", kind: "image", text: "orange sunset" }));
  r.upsert(msg({ id: "M", ts: 400, senderId: "me", fromMe: true, text: "orange again" }));

  const ids = (hits: { id: string }[]) => hits.map((h) => h.id).sort();
  assert.deepEqual(ids(r.search("orange", { senderId: "bob" }, 10, 0)), ["B", "P"]);
  assert.deepEqual(ids(r.search("orange", { kind: "image" }, 10, 0)), ["P"]);
  assert.deepEqual(ids(r.search("orange", { hasMedia: true }, 10, 0)), ["P"]);
  assert.deepEqual(ids(r.search("orange", { fromMe: true }, 10, 0)), ["M"]);
  assert.deepEqual(ids(r.search("orange", { after: 150, before: 300 }, 10, 0)), ["B", "P"]);
  // And they compose, which is the point of sharing one predicate builder with `list`.
  assert.deepEqual(ids(r.search("orange", { senderId: "bob", after: 250 }, 10, 0)), ["P"]);
});

void test("search still excludes revoked rows once the tombstone clause moved into the filter", () => {
  const r = repo();
  r.upsert(msg({ id: "K", text: "orange" }));
  r.markDeleted("c", "K", 500);
  assert.equal(r.search("orange", {}, 10, 0).length, 0);
});

void test("search finds transcripts and flags them", () => {
  const r = repo();
  r.upsert(msg({ id: "V1", kind: "audio", text: undefined }));
  r.setTranscript("c", "V1", "on se retrouve demain");
  const hits = r.search("demain", {}, 10, 0);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.matchedTranscript, true);
  assert.equal(hits[0].id, "V1");
});

void test("a transcript hit on a message with an empty text is still a transcript hit", () => {
  // FTS5 answers `snippet()` with "" (not NULL) for a column that is an empty string, so reading
  // only for NULL would call this a text hit and return a blank snippet.
  const r = repo();
  r.upsert(msg({ id: "V1", kind: "audio", text: "" }));
  r.setTranscript("c", "V1", "on se retrouve demain");
  const hit = r.search("demain", {}, 10, 0)[0];
  assert.equal(hit?.matchedTranscript, true);
  assert.match(hit.snippet, /demain/);
});

void test("a caption that does not match leaves the transcript hit labelled as one", () => {
  // The case an "is the snippet empty?" rule cannot see: `snippet()` answers a column that did *not*
  // match with that column's leading text, unmarked — so a non-empty caption is indistinguishable
  // from a real text hit unless the markers themselves are read. A captioned video is the common
  // shape for this: real text of its own, and the words the caller searched for only in the speech.
  const r = repo();
  r.upsert(msg({ id: "V1", kind: "video", text: "voici la legende de ma video sans le mot" }));
  r.setTranscript("c", "V1", "on se retrouve demain");
  const hit = r.search("demain", {}, 10, 0)[0];
  assert.equal(hit?.matchedTranscript, true, "the words are in the speech, not in the caption");
  assert.match(hit.snippet, /demain/, "a snippet that does not contain the hit is worse than no snippet");
});

void test("a marker character typed by a sender cannot fake a text match", () => {
  // The markers are `char(1)`/`char(2)`, and a message body is sender-supplied UTF-8: nothing stops
  // someone sending a literal SOH. `snippet()` copies it into the snippet verbatim, so reading the
  // snippet alone reports "the text column matched" for a caption that contains none of the searched
  // words — the very mislabelling the marker rule replaced "is the snippet empty?" to prevent.
  const r = repo();
  r.upsert(msg({ id: "V1", kind: "video", text: "\u0001voici la legende de ma video sans le mot" }));
  r.setTranscript("c", "V1", "on se retrouve demain");
  const hit = r.search("demain", {}, 10, 0)[0];
  assert.equal(hit?.matchedTranscript, true, "the words are in the speech; the SOH in the caption is not a match");
  assert.match(hit.snippet, /demain/);
});

void test("a marker in the column that did match costs the label rather than mislabelling the hit", () => {
  // The price of the rule above, stated so it is a decision and not a surprise: when the column that
  // really matched is also the one carrying a marker of its own, its signal is unreadable, so the row
  // comes back as a hit with no snippet and no transcript label — rather than being attributed to a
  // text column the words are not in. `matched_transcript` is what tells a model the words were
  // spoken rather than typed, and unknown is worth more to it than confidently wrong.
  const r = repo();
  r.upsert(msg({ id: "V1", kind: "audio", text: undefined }));
  r.setTranscript("c", "V1", "\u0001on se retrouve demain");
  const hit = r.search("demain", {}, 10, 0)[0];
  assert.equal(hit?.id, "V1", "the row is still found — only the attribution is withheld");
  assert.equal(hit.matchedTranscript, false);
  assert.equal(hit.snippet, "");
});

void test("search can be scoped to one chat", () => {
  const r = repo();
  r.upsert(msg({ chatId: "c", id: "M1", text: "orange" }));
  r.upsert(msg({ chatId: "c2", id: "M2", text: "orange" }));
  assert.equal(r.search("orange", {}, 10, 0).length, 2);
  assert.equal(r.search("orange", { chatId: "c2" }, 10, 0).length, 1);
});

void test("search survives FTS5 operator characters in user input", () => {
  const r = repo();
  r.upsert(msg({ text: 'a quoted "thing" and a (paren)' }));
  for (const q of ['"', "(", "*", "NEAR", "AND OR", "^foo", "a OR"]) {
    assert.doesNotThrow(() => r.search(q, {}, 10, 0), `query ${JSON.stringify(q)} must not throw`);
  }
  assert.equal(r.search("quoted", {}, 10, 0).length, 1);
});

void test("unreadKeysUpTo returns non-from_me, non-deleted messages at or before ts, newest first", () => {
  const r = repo();
  r.upsert(msg({ id: "M1", ts: 100, fromMe: false, senderId: "s1" }));
  r.upsert(msg({ id: "M2", ts: 200, fromMe: true, senderId: "me" }));
  r.upsert(msg({ id: "M3", ts: 300, fromMe: false, senderId: "s2" }));
  r.upsert(msg({ id: "M4", ts: 400, fromMe: false, senderId: "s3" }));
  r.markDeleted("c", "M3", 500);
  const keys = r.unreadKeysUpTo("c", 400, 10);
  assert.deepEqual(
    keys.map((k) => k.id),
    ["M4", "M1"],
  );
  assert.equal(keys[0]?.senderId, "s3");
});

void test("unreadKeysUpTo respects the limit", () => {
  const r = repo();
  r.upsert(msg({ id: "M1", ts: 100 }));
  r.upsert(msg({ id: "M2", ts: 200 }));
  r.upsert(msg({ id: "M3", ts: 300 }));
  assert.equal(r.unreadKeysUpTo("c", 300, 2).length, 2);
});

void test("linkIdentity re-points an existing LID conversation onto the phone identity", () => {
  const db = openDb(join(dir, "merge.db"));
  const contacts = makeContactsRepo(db);
  const chats = makeChatsRepo(db);
  const messages = makeMessagesRepo(db);
  chats.ensure("888@lid", false);
  chats.touch("888@lid", 500);
  messages.upsert({
    chatId: "888@lid",
    id: "M1",
    senderId: "888@lid",
    ts: 500,
    fromMe: false,
    kind: "text",
    text: "avant",
  });

  contacts.linkIdentity("888@lid", "33612345678@s.whatsapp.net");

  assert.equal(chats.get("888@lid"), undefined, "the LID chat must not survive the merge");
  assert.equal(chats.get("33612345678@s.whatsapp.net")?.lastMessageTs, 500);
  assert.equal(messages.get("33612345678@s.whatsapp.net", "M1")?.text, "avant");
  assert.equal(messages.get("33612345678@s.whatsapp.net", "M1")?.senderId, "33612345678@s.whatsapp.net");
  assert.equal(messages.search("avant", {}, 10, 0)[0]?.chatId, "33612345678@s.whatsapp.net");
});
