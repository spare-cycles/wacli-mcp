import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeDb, openDb } from "./client.js";
import { SCHEMA_VERSION } from "./schema.js";

const dir = mkdtempSync(join(tmpdir(), "whatsapp-db-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fresh(name: string) {
  return openDb(join(dir, `${name}.db`));
}

void test("opens in WAL and records the schema version", () => {
  const db = fresh("wal");
  assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
  assert.equal(Number(row.value), SCHEMA_VERSION);
  closeDb(db);
});

void test("migrations are idempotent across reopen", () => {
  const path = join(dir, "idem.db");
  closeDb(openDb(path));
  const db = openDb(path); // must not throw
  assert.equal(
    Number((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value),
    SCHEMA_VERSION,
  );
  closeDb(db);
});

void test("FTS indexes inserted message text", () => {
  const db = fresh("fts-insert");
  db.prepare("INSERT INTO chats (id, is_group) VALUES (?, 0)").run("a@s.whatsapp.net");
  db.prepare("INSERT INTO messages (chat_id, id, sender_id, ts, from_me, kind, text) VALUES (?,?,?,?,?,?,?)").run(
    "a@s.whatsapp.net",
    "M1",
    "a@s.whatsapp.net",
    1000,
    0,
    "text",
    "bonjour le monde",
  );
  const hits = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("monde");
  assert.equal(hits.length, 1);
  closeDb(db);
});

void test("FTS follows an edit and drops a delete", () => {
  const db = fresh("fts-edit");
  db.prepare("INSERT INTO chats (id, is_group) VALUES (?, 0)").run("c");
  db.prepare("INSERT INTO messages (chat_id, id, sender_id, ts, from_me, kind, text) VALUES (?,?,?,?,?,?,?)").run(
    "c",
    "M1",
    "s",
    1,
    0,
    "text",
    "premier texte",
  );

  db.prepare("UPDATE messages SET text = ? WHERE chat_id = ? AND id = ?").run("second texte", "c", "M1");
  assert.equal(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("premier").length, 0);
  assert.equal(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("second").length, 1);

  db.prepare("DELETE FROM messages WHERE chat_id = ? AND id = ?").run("c", "M1");
  assert.equal(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("second").length, 0);
  closeDb(db);
});

void test("transcripts are searchable alongside text", () => {
  const db = fresh("fts-transcript");
  db.prepare("INSERT INTO chats (id, is_group) VALUES (?, 0)").run("c");
  db.prepare("INSERT INTO messages (chat_id, id, sender_id, ts, from_me, kind) VALUES (?,?,?,?,?,?)").run(
    "c",
    "V1",
    "s",
    1,
    0,
    "audio",
  );
  assert.equal(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("rendez").length, 0);
  db.prepare("UPDATE messages SET transcript = ? WHERE chat_id = ? AND id = ?").run(
    "on se voit au rendez-vous",
    "c",
    "V1",
  );
  assert.equal(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("rendez").length, 1);
  closeDb(db);
});

void test("a message is unique per (chat_id, id)", () => {
  const db = fresh("unique");
  db.prepare("INSERT INTO chats (id, is_group) VALUES (?, 0)").run("c");
  const ins = db.prepare("INSERT INTO messages (chat_id, id, sender_id, ts, from_me, kind) VALUES (?,?,?,?,?,?)");
  ins.run("c", "M1", "s", 1, 0, "text");
  assert.throws(() => {
    ins.run("c", "M1", "s", 2, 0, "text");
  });
  closeDb(db);
});
