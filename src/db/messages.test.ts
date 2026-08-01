import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeChatsRepo } from "./chats.js";
import { openDb } from "./client.js";
import { makeContactsRepo } from "./contacts.js";
import { makeMessagesRepo, type MessageInput } from "./messages.js";

const dir = mkdtempSync(join(tmpdir(), "wa-msg-"));
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
  r.upsert(msg());
  r.upsert(msg({ text: "hello again", status: "delivered" }));
  assert.equal(r.count(), 1);
  assert.equal(r.get("c", "M1")?.text, "hello again");
  assert.equal(r.get("c", "M1")?.status, "delivered");
});

void test("the same message id in two chats is two rows", () => {
  const r = repo();
  r.upsert(msg({ chatId: "c" }));
  r.upsert(msg({ chatId: "c2" }));
  assert.equal(r.count(), 2);
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

void test("search finds transcripts and flags them", () => {
  const r = repo();
  r.upsert(msg({ id: "V1", kind: "audio", text: undefined }));
  r.setTranscript("c", "V1", "on se retrouve demain");
  const hits = r.search("demain", {}, 10, 0);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.matchedTranscript, true);
  assert.equal(hits[0].id, "V1");
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

void test("upsertMany is atomic", () => {
  const r = repo();
  r.upsertMany([msg({ id: "A" }), msg({ id: "B" }), msg({ id: "C" })]);
  assert.equal(r.count(), 3);
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
