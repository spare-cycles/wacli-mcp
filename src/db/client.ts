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
