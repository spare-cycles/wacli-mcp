import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openDb } from "./client.js";
import { makeReactionsRepo, type ReactionCount } from "./reactions.js";

const dir = mkdtempSync(join(tmpdir(), "wa-react-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});
let n = 0;
const repo = () => makeReactionsRepo(openDb(join(dir, `r${n++}.db`)));

void test("one reaction per sender per message, replaced on change", () => {
  const r = repo();
  r.set({ chatId: "c", messageId: "M1", senderId: "s1", emoji: "👍", ts: 1 });
  r.set({ chatId: "c", messageId: "M1", senderId: "s1", emoji: "❤️", ts: 2 });
  const all = r.forMessage("c", "M1");
  assert.equal(all.length, 1);
  assert.equal(all[0]?.emoji, "❤️");
});

void test("different senders accumulate", () => {
  const r = repo();
  r.set({ chatId: "c", messageId: "M1", senderId: "s1", emoji: "👍", ts: 1 });
  r.set({ chatId: "c", messageId: "M1", senderId: "s2", emoji: "👍", ts: 2 });
  assert.equal(r.forMessage("c", "M1").length, 2);
});

void test("an empty emoji removes the reaction", () => {
  const r = repo();
  r.set({ chatId: "c", messageId: "M1", senderId: "s1", emoji: "👍", ts: 1 });
  r.set({ chatId: "c", messageId: "M1", senderId: "s1", emoji: "", ts: 2 });
  assert.equal(r.forMessage("c", "M1").length, 0);
});

/** `countsFor` answers rows; a test reads them the way a caller does, by (chat, message). */
function countMap(counts: readonly ReactionCount[]): Map<string, number> {
  return new Map(counts.map((c) => [`${c.chatId}/${c.messageId}`, c.count]));
}

void test("countsFor groups a whole page of message ids in one query", () => {
  const r = repo();
  r.set({ chatId: "c", messageId: "M1", senderId: "s1", emoji: "👍", ts: 1 });
  r.set({ chatId: "c", messageId: "M1", senderId: "s2", emoji: "❤️", ts: 2 });
  r.set({ chatId: "c", messageId: "M2", senderId: "s1", emoji: "👍", ts: 3 });
  r.set({ chatId: "other", messageId: "M1", senderId: "s1", emoji: "👍", ts: 4 });

  const counts = countMap(r.countsFor(["M1", "M2", "M3"].map((messageId) => ({ chatId: "c", messageId }))));
  assert.equal(counts.get("c/M1"), 2);
  assert.equal(counts.get("c/M2"), 1);
  assert.equal(counts.get("c/M3"), undefined, "a message with no reactions is absent, not zero");
  assert.equal(counts.size, 2, "the other chat's identically-named message must not leak in");
});

void test("countsFor covers a page spanning several chats in the same one query", () => {
  // The shape a cross-chat search page has: message ids repeat across chats, and asking per chat
  // would cost one query per chat rather than one per page.
  const r = repo();
  r.set({ chatId: "c1", messageId: "M1", senderId: "s1", emoji: "👍", ts: 1 });
  r.set({ chatId: "c2", messageId: "M1", senderId: "s1", emoji: "👍", ts: 2 });
  r.set({ chatId: "c2", messageId: "M1", senderId: "s2", emoji: "❤️", ts: 3 });
  r.set({ chatId: "c3", messageId: "M1", senderId: "s1", emoji: "👍", ts: 4 });

  const counts = countMap(
    r.countsFor([
      { chatId: "c1", messageId: "M1" },
      { chatId: "c2", messageId: "M1" },
      { chatId: "c1", messageId: "M2" },
    ]),
  );
  assert.equal(counts.get("c1/M1"), 1);
  assert.equal(counts.get("c2/M1"), 2, "a same-named message in another chat keeps its own count");
  assert.equal(counts.size, 2, "c3 was not asked about and must not appear");
});

void test("countsFor with no keys asks nothing", () => {
  const r = repo();
  r.set({ chatId: "c", messageId: "M1", senderId: "s1", emoji: "👍", ts: 1 });
  assert.deepEqual(r.countsFor([]), []);
});

void test("count reflects the number of stored reactions", () => {
  const r = repo();
  assert.equal(r.count(), 0);
  r.set({ chatId: "c", messageId: "M1", senderId: "s1", emoji: "👍", ts: 1 });
  r.set({ chatId: "c", messageId: "M2", senderId: "s1", emoji: "👍", ts: 2 });
  assert.equal(r.count(), 2);
});
