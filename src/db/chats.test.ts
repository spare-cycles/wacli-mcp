import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeChatsRepo } from "./chats.js";
import { openDb } from "./client.js";

const dir = mkdtempSync(join(tmpdir(), "wa-chats-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});
let n = 0;
const repo = () => makeChatsRepo(openDb(join(dir, `h${n++}.db`)));

void test("ensure is idempotent and does not clobber a known name", () => {
  const r = repo();
  r.ensure("c@s.whatsapp.net", false);
  r.patch("c@s.whatsapp.net", { name: "Alice" });
  r.ensure("c@s.whatsapp.net", false);
  assert.equal(r.get("c@s.whatsapp.net")?.name, "Alice");
  assert.equal(r.count(), 1);
});

void test("touch only moves last_message_ts forwards", () => {
  const r = repo();
  r.ensure("c", false);
  r.touch("c", 500);
  r.touch("c", 200);
  assert.equal(r.get("c")?.lastMessageTs, 500, "an older history message must not rewind the chat");
  r.touch("c", 900);
  assert.equal(r.get("c")?.lastMessageTs, 900);
});

void test("list orders by recency and honours filters", () => {
  const r = repo();
  r.ensure("dm", false);
  r.touch("dm", 100);
  r.patch("dm", { name: "Alice" });
  r.ensure("grp", true);
  r.touch("grp", 200);
  r.patch("grp", { name: "Team" });
  r.ensure("old", false);
  r.touch("old", 50);
  r.patch("old", { archived: true });

  assert.deepEqual(
    r.list({}, 10, 0).map((c) => c.id),
    ["grp", "dm", "old"],
  );
  assert.deepEqual(
    r.list({ isGroup: true }, 10, 0).map((c) => c.id),
    ["grp"],
  );
  assert.deepEqual(
    r.list({ archived: false }, 10, 0).map((c) => c.id),
    ["grp", "dm"],
  );
  assert.deepEqual(
    r.list({ query: "ali" }, 10, 0).map((c) => c.id),
    ["dm"],
  );
});

void test("unread counters", () => {
  const r = repo();
  r.ensure("c", false);
  r.bumpUnread("c", 1);
  r.bumpUnread("c", 2);
  assert.equal(r.get("c")?.unreadCount, 3);
  assert.deepEqual(
    r.list({ unreadOnly: true }, 10, 0).map((c) => c.id),
    ["c"],
  );
  r.clearUnread("c");
  assert.equal(r.get("c")?.unreadCount, 0);
  assert.equal(r.list({ unreadOnly: true }, 10, 0).length, 0);
});

void test("limit and offset paginate", () => {
  const r = repo();
  for (let i = 0; i < 5; i++) {
    r.ensure(`c${i}`, false);
    r.touch(`c${i}`, i * 10);
  }
  assert.deepEqual(
    r.list({}, 2, 0).map((c) => c.id),
    ["c4", "c3"],
  );
  assert.deepEqual(
    r.list({}, 2, 2).map((c) => c.id),
    ["c2", "c1"],
  );
});
