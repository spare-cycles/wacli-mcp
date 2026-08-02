import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./schema.js";

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function closeDb(db: Db): void {
  db.close();
}

/**
 * Escape LIKE metacharacters (`\`, `%`, `_`) so a query is matched literally.
 *
 * Lives here, once, because both `chats.list` and `contacts.search` take a caller-supplied substring:
 * two identical copies is two places for the escape character to stop matching the `ESCAPE '\\'`
 * clause in the SQL, and the half that drifts turns a user searching for `100_%` into a wildcard scan
 * with no error anywhere.
 */
export function escapeLike(query: string): string {
  return query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
