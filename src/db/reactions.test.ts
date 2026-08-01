import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openDb } from "./client.js";
import { makeReactionsRepo } from "./reactions.js";

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

void test("count reflects the number of stored reactions", () => {
  const r = repo();
  assert.equal(r.count(), 0);
  r.set({ chatId: "c", messageId: "M1", senderId: "s1", emoji: "👍", ts: 1 });
  r.set({ chatId: "c", messageId: "M2", senderId: "s1", emoji: "👍", ts: 2 });
  assert.equal(r.count(), 2);
});
