import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { closeDb, type Db, openDb } from "./client.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

const dir = mkdtempSync(join(tmpdir(), "whatsapp-db-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fresh(name: string) {
  return openDb(join(dir, `${name}.db`));
}

/**
 * The version the store records for itself.
 *
 * `node:sqlite` hands back `unknown` per row, and `meta` is our own single-row write — so the shape
 * is ours to assert once, here, rather than at every call site below.
 */
function storedVersion(db: Db): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  assert.ok(row !== undefined, "an opened store always records its schema version");
  return Number(row.value);
}

void test("opens in WAL and records the schema version", () => {
  const db = fresh("wal");
  assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.equal(storedVersion(db), SCHEMA_VERSION);
  closeDb(db);
});

void test("migrations are idempotent across reopen", () => {
  const path = join(dir, "idem.db");
  closeDb(openDb(path));
  const db = openDb(path); // must not throw
  assert.equal(storedVersion(db), SCHEMA_VERSION);
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
 * A store frozen at `upTo`, built by running only the migrations up to that version — which is what
 * an already-deployed instance's database is. Everything below then upgrades it the way a rollout
 * does.
 */
function storeAt(name: string, upTo: number): string {
  const path = join(dir, `${name}.db`);
  const db = new DatabaseSync(path);
  const applied = MIGRATIONS.filter((m) => m.version <= upTo);
  // Guards the fixture itself: a store claiming to be V2 while having run one migration would make
  // every test below assert against a shape no deployment ever had.
  assert.equal(applied.length, upTo);
  for (const m of applied) db.exec(m.sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(upTo));
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

void test("V1 upgrades to the current schema without disturbing the rows already in it", () => {
  const db = openDb(storeAt("v1-upgrade", 1));

  assert.equal(storedVersion(db), SCHEMA_VERSION);
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
  const db = openDb(storeAt("v1-fts", 1));
  const hits = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("whisper");
  assert.equal(hits.length, 1);
  closeDb(db);
});

void test("every migration is applied once, however often the store is reopened", () => {
  const path = storeAt("v1-idem", 1);
  closeDb(openDb(path));
  // A second `ALTER TABLE … ADD COLUMN` would throw "duplicate column name"; this is what proves the
  // version check, and not luck, is what stops it running twice.
  const db = openDb(path);
  assert.equal(storedVersion(db), SCHEMA_VERSION);
  closeDb(db);
});

void test("V2 upgrades to V3 without losing a transcript already stored", () => {
  const db = openDb(storeAt("v2-to-v3", 2));

  assert.equal(storedVersion(db), SCHEMA_VERSION, "an old store is brought all the way forward, not one step");
  const row = db.prepare("SELECT transcript, transcript_language FROM messages WHERE id='OLD'").get() as {
    transcript: string;
    transcript_language: string | null;
  };
  assert.equal(row.transcript, "un vieux transcript whisper");
  // NULL rather than a guess, for the same reason V2 left `transcript_model` alone: nothing in the
  // store records what language a pre-V3 transcript was spoken in, and "unknown" is the truth.
  assert.equal(row.transcript_language, null);
  closeDb(db);
});

void test("V3 is applied once, however often a V2 store is reopened", () => {
  const path = storeAt("v3-idem", 2);
  closeDb(openDb(path));
  const db = openDb(path); // must not throw "duplicate column name: transcript_language"
  assert.equal(storedVersion(db), SCHEMA_VERSION);
  closeDb(db);
});

void test("a transcript written after the V3 migration still reaches the FTS index", () => {
  // The new column is added to the table three FTS triggers hang off. Had `ADD COLUMN` disturbed
  // them, the store would keep accepting transcripts and silently stop indexing them — no error,
  // ever, which is the one failure mode an external-content index makes unobservable.
  const db = openDb(storeAt("v3-fts", 2));
  db.prepare("UPDATE messages SET transcript = ?, transcript_language = ? WHERE id = 'OLD'").run(
    "on se retrouve demain",
    "fr",
  );
  assert.equal(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("demain").length, 1);
  // And the superseded text left the index rather than lingering as a phantom hit, which is the
  // half of the UPDATE trigger a plain "can I find the new words?" check would not notice losing.
  assert.equal(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("whisper").length, 0);
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
