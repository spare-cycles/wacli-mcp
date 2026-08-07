import type { Db } from "./client.js";

export type Migration = { version: number; sql: string };

export const SCHEMA_VERSION = 2;

const V1_SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE chats (
  id                TEXT PRIMARY KEY,
  name              TEXT,
  is_group          INTEGER NOT NULL DEFAULT 0,
  last_message_ts   INTEGER,
  unread_count      INTEGER NOT NULL DEFAULT 0,
  archived          INTEGER NOT NULL DEFAULT 0,
  muted_until       INTEGER,
  participant_count INTEGER,
  raw               TEXT
) STRICT;
CREATE INDEX chats_last_message_ts ON chats (last_message_ts DESC);
CREATE INDEX chats_is_group ON chats (is_group, last_message_ts DESC);

CREATE TABLE messages (
  rowid       INTEGER PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  sender_id   TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  from_me     INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL,
  text        TEXT,
  transcript  TEXT,
  quoted_id   TEXT,
  status      TEXT,
  edited_ts   INTEGER,
  deleted_ts  INTEGER,
  media_type  TEXT,
  media_sha   TEXT,
  raw         BLOB
) STRICT;
CREATE UNIQUE INDEX messages_chat_id_id ON messages (chat_id, id);
CREATE INDEX messages_chat_ts ON messages (chat_id, ts DESC);
CREATE INDEX messages_ts ON messages (ts DESC);
CREATE INDEX messages_sender ON messages (sender_id, ts DESC);

CREATE VIRTUAL TABLE messages_fts USING fts5 (
  text, transcript, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text, transcript) VALUES (new.rowid, new.text, new.transcript);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text, transcript) VALUES ('delete', old.rowid, old.text, old.transcript);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text, transcript) VALUES ('delete', old.rowid, old.text, old.transcript);
  INSERT INTO messages_fts (rowid, text, transcript) VALUES (new.rowid, new.text, new.transcript);
END;

CREATE TABLE contacts (
  id           TEXT PRIMARY KEY,
  phone_number TEXT,
  lid          TEXT,
  name         TEXT,
  notify       TEXT,
  raw          TEXT
) STRICT;
CREATE INDEX contacts_phone ON contacts (phone_number);
CREATE INDEX contacts_lid ON contacts (lid);

CREATE TABLE reactions (
  chat_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_id  TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id, sender_id)
) STRICT;

CREATE TABLE auth_creds (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE auth_keys (type TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (type, id)) STRICT;
`;

/**
 * What moving transcription onto a GPU needs the store to know, and V1 had no way to say.
 *
 * Three columns, each of which an auto-transcribe gate is otherwise unimplementable without:
 *
 * 1. **`ptt`** — `kind` cannot identify a voice note. `audioMessage` maps to `"audio"`
 *    (`whatsapp/ingest.ts`), which covers a forwarded song and a podcast attachment equally, and
 *    transcribing those on arrival is exactly the waste the gates exist to prevent. Baileys'
 *    `ptt` boolean is the discriminator and was never persisted.
 * 2. **`duration_s`** — the length gate could otherwise only run *after* downloading the file and
 *    probing it, which inverts the gate it exists to be: the whole point is to refuse before
 *    spending anything. `audioMessage.seconds` is on the live message; this stores it.
 * 3. **`transcript_model`** — without it, a whisper.cpp-era transcript, a Voxtral one and whatever
 *    the bench picks next are indistinguishable in one bare `transcript` column, with no way to
 *    know what is worth re-transcribing. Every row already in the store is a whisper.cpp one, and
 *    this migration deliberately leaves those NULL rather than back-filling a guess.
 *
 * `ALTER TABLE … ADD COLUMN` is legal on a STRICT table, and adding a column does not disturb the
 * FTS triggers above: all three name `text` and `transcript` explicitly, so neither the shadow
 * table's shape nor the `INSERT … VALUES` in each trigger changes.
 *
 * The partial index is what the boot sweep reads. Partial rather than a plain index on `ptt`
 * because the sweep only ever asks for the untranscribed ones, and the store is overwhelmingly
 * text: indexing every row to find the handful that qualify would cost far more than it saves.
 */
const V2_SQL = `
ALTER TABLE messages ADD COLUMN ptt INTEGER;
ALTER TABLE messages ADD COLUMN duration_s INTEGER;
ALTER TABLE messages ADD COLUMN transcript_model TEXT;

CREATE INDEX messages_pending_transcript
    ON messages (ts DESC)
 WHERE ptt = 1 AND transcript IS NULL AND deleted_ts IS NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1_SQL },
  { version: 2, sql: V2_SQL },
];

/** The `meta` table itself is created by migration 1, so its absence means version 0. */
function currentVersion(db: Db): number {
  const metaExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (metaExists === undefined) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row === undefined ? 0 : Number(row.value);
}

/** Applies every migration with a higher version than what's recorded, each inside one transaction. Returns the final version. */
export function migrate(db: Db): number {
  let version = currentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).run(String(m.version));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    version = m.version;
  }
  return version;
}
