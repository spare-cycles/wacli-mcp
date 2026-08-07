import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { closeDb, openDb } from "./client.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

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

/**
 * A V1 store, built by running only the first migration — which is what an already-deployed
 * instance's database is. Everything below then upgrades it the way a rollout does.
 */
function v1Store(name: string): string {
  const path = join(dir, `${name}.db`);
  const db = new DatabaseSync(path);
  const v1 = MIGRATIONS.find((m) => m.version === 1);
  assert.ok(v1 !== undefined);
  db.exec(v1.sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  db.prepare("INSERT INTO chats (id, is_group) VALUES (?, 0)").run("c");
  db.prepare("INSERT INTO messages (chat_id, id, sender_id, ts, from_me, kind, transcript) VALUES (?,?,?,?,?,?,?)").run(
    "c",
    "OLD",
    "s",
    1,
    0,
    "audio",
    "un vieux transcript whisper",
  );
  db.close();
  return path;
}

void test("V1 upgrades to V2 without disturbing the rows already in it", () => {
  const db = openDb(v1Store("v1-to-v2"));

  assert.equal(
    Number((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value),
    2,
  );
  const row = db.prepare("SELECT ptt, duration_s, transcript_model, transcript FROM messages WHERE id='OLD'").get() as {
    ptt: number | null;
    duration_s: number | null;
    transcript_model: string | null;
    transcript: string;
  };
  assert.equal(row.transcript, "un vieux transcript whisper");
  // Left NULL rather than back-filled with a guess. A pre-V2 row is "we never recorded this",
  // which is a different statement from "this is not a voice note" — and the auto-transcribe sweep
  // treats them differently, leaving the unknown ones alone instead of transcribing on a hunch.
  assert.equal(row.ptt, null);
  assert.equal(row.duration_s, null);
  assert.equal(row.transcript_model, null);
  closeDb(db);
});

void test("FTS still finds a pre-V2 transcript after the migration", () => {
  // Adding a column rewrites nothing, but the FTS shadow table is content-less and its triggers
  // name `text` and `transcript` explicitly — so this is the assertion that says the migration did
  // not quietly invalidate the search index for every message already stored.
  const db = openDb(v1Store("v1-fts"));
  const hits = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("whisper");
  assert.equal(hits.length, 1);
  closeDb(db);
});

void test("V2 is applied once, however often the store is reopened", () => {
  const path = v1Store("v2-idem");
  closeDb(openDb(path));
  // A second `ALTER TABLE ADD COLUMN` would throw "duplicate column name"; this is what proves the
  // version check, and not luck, is what stops it running twice.
  const db = openDb(path);
  assert.equal(
    Number((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value),
    SCHEMA_VERSION,
  );
  closeDb(db);
});

void test("the sweep's partial index covers exactly the untranscribed voice notes", () => {
  const db = fresh("pending-index");
  db.prepare("INSERT INTO chats (id, is_group) VALUES (?, 0)").run("c");
  const ins = db.prepare(
    "INSERT INTO messages (chat_id, id, sender_id, ts, from_me, kind, ptt, transcript) VALUES (?,?,?,?,?,?,?,?)",
  );
  ins.run("c", "NOTE", "s", 10, 0, "audio", 1, null);
  ins.run("c", "DONE", "s", 11, 0, "audio", 1, "déjà transcrit");
  // `kind` is "audio" for this too, which is the entire reason `ptt` had to be added.
  ins.run("c", "SONG", "s", 12, 0, "audio", 0, null);

  const pending = db
    .prepare("SELECT id FROM messages WHERE ptt = 1 AND transcript IS NULL AND deleted_ts IS NULL")
    .all() as { id: string }[];
  assert.deepEqual(
    pending.map((r) => r.id),
    ["NOTE"],
  );
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
