import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openDb } from "./client.js";
import { makeContactsRepo } from "./contacts.js";

const dir = mkdtempSync(join(tmpdir(), "whatsapp-contacts-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});
let n = 0;
const repo = () => makeContactsRepo(openDb(join(dir, `c${n++}.db`)));
/** Like `repo()`, but also hands back the raw `Db` for direct SQL — `makeReactionsRepo` doesn't exist yet. */
const repoWithDb = () => {
  const db = openDb(join(dir, `c${n++}.db`));
  return { db, r: makeContactsRepo(db) };
};

void test("upsert merges rather than overwriting with nulls", () => {
  const r = repo();
  r.upsert({ id: "33612345678@s.whatsapp.net", phoneNumber: "33612345678", name: "Alice" });
  r.upsert({ id: "33612345678@s.whatsapp.net", notify: "alice-notify" });
  const c = r.get("33612345678@s.whatsapp.net");
  assert.equal(c?.name, "Alice", "an update without a name must not erase it");
  assert.equal(c.notify, "alice-notify");
});

void test("displayName falls back name -> notify -> phone -> id", () => {
  const r = repo();
  r.upsert({ id: "a@s.whatsapp.net", phoneNumber: "331", name: "Alice", notify: "al" });
  assert.equal(r.displayName("a@s.whatsapp.net"), "Alice");
  r.upsert({ id: "b@s.whatsapp.net", phoneNumber: "332", notify: "bob" });
  assert.equal(r.displayName("b@s.whatsapp.net"), "bob");
  r.upsert({ id: "c@s.whatsapp.net", phoneNumber: "333" });
  assert.equal(r.displayName("c@s.whatsapp.net"), "333");
  assert.equal(r.displayName("unknown@s.whatsapp.net"), "unknown@s.whatsapp.net");
});

void test("linkIdentity makes pnForLid resolve, and is idempotent", () => {
  const r = repo();
  r.linkIdentity("999@lid", "33612345678@s.whatsapp.net");
  r.linkIdentity("999@lid", "33612345678@s.whatsapp.net");
  assert.equal(r.pnForLid("999"), "33612345678@s.whatsapp.net");
  assert.equal(r.pnForLid("998"), undefined);
});

void test("linkIdentity folds a LID-only contact into the phone contact", () => {
  const r = repo();
  r.upsert({ id: "999@lid", lid: "999", notify: "Mystery" });
  r.upsert({ id: "33612345678@s.whatsapp.net", phoneNumber: "33612345678" });
  r.linkIdentity("999@lid", "33612345678@s.whatsapp.net");
  const merged = r.get("33612345678@s.whatsapp.net");
  assert.equal(merged?.lid, "999");
  assert.equal(merged.notify, "Mystery", "the LID row's name must survive the merge");
  assert.equal(r.get("999@lid"), undefined, "the LID row is folded away, not left as a duplicate");
  assert.equal(r.count(), 1);
});

void test("linkIdentity re-points reactions.sender_id, folding a same-message double reaction", () => {
  const { db, r } = repoWithDb();
  const lidJid = "888@lid";
  const phoneJid = "33612345678@s.whatsapp.net";
  const insertReaction = db.prepare(
    "INSERT INTO reactions (chat_id, message_id, sender_id, emoji, ts) VALUES (?, ?, ?, ?, ?)",
  );

  // Plain case: only a LID-side reaction exists for this message.
  insertReaction.run("group@g.us", "m1", lidJid, "\u{1F44D}", 100);
  // Collision case: the same person reacted to the same message under both identities (LID
  // before the mapping resolved, phone number after) -- same (chat_id, message_id) pair, so
  // re-pointing the LID row's sender_id collides with the phone row already on that PK.
  insertReaction.run("group@g.us", "m2", lidJid, "\u{1F602}", 150);
  insertReaction.run("group@g.us", "m2", phoneJid, "❤", 200);

  r.linkIdentity(lidJid, phoneJid);

  type ReactionRow = { chat_id: string; message_id: string; sender_id: string; emoji: string };
  const rows = db
    .prepare("SELECT chat_id, message_id, sender_id, emoji FROM reactions ORDER BY message_id")
    .all() as ReactionRow[];

  assert.equal(
    rows.some((row) => row.sender_id === lidJid),
    false,
    "no reaction may still point at the deleted LID identity",
  );
  assert.deepEqual(
    rows.map((row) => ({ messageId: row.message_id, senderId: row.sender_id, emoji: row.emoji })),
    [
      { messageId: "m1", senderId: phoneJid, emoji: "\u{1F44D}" },
      { messageId: "m2", senderId: phoneJid, emoji: "❤" },
    ],
    "m1's reaction moves to the phone id; m2's collision keeps the row already on the phone id",
  );

  // A second call must be a clean no-op: nothing left under the LID id to move or drop.
  r.linkIdentity(lidJid, phoneJid);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM reactions").get() as { n: number }).n,
    2,
    "re-running linkIdentity must not duplicate or further mutate reactions",
  );
});

void test("search matches name, notify and phone, case-insensitively", () => {
  const r = repo();
  r.upsert({ id: "a@s.whatsapp.net", phoneNumber: "33611111111", name: "Alice Martin" });
  r.upsert({ id: "b@s.whatsapp.net", phoneNumber: "33622222222", notify: "Bob" });
  assert.equal(r.search("alice", 10, 0).length, 1);
  assert.equal(r.search("MARTIN", 10, 0).length, 1);
  assert.equal(r.search("3362", 10, 0).length, 1);
  assert.equal(r.search("zzz", 10, 0).length, 0);
});

void test("search escapes LIKE wildcards in the query", () => {
  const r = repo();
  r.upsert({ id: "a@s.whatsapp.net", name: "Alice" });
  assert.equal(r.search("%", 10, 0).length, 0, "a bare % must not match everything");
  assert.equal(r.search("_", 10, 0).length, 0);
});
