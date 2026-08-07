import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeDb, openDb } from "./client.js";
import { makeMetaRepo } from "./meta.js";
import { SCHEMA_VERSION } from "./schema.js";

const dir = mkdtempSync(join(tmpdir(), "whatsapp-meta-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fresh(name: string) {
  return openDb(join(dir, `${name}.db`));
}

void test("set then get round-trips a value", () => {
  const db = fresh("roundtrip");
  const meta = makeMetaRepo(db);
  meta.set("foo", "bar");
  assert.equal(meta.get("foo"), "bar");
  closeDb(db);
});

void test("get on an absent key returns undefined", () => {
  const db = fresh("absent");
  const meta = makeMetaRepo(db);
  assert.equal(meta.get("does-not-exist"), undefined);
  closeDb(db);
});

void test("set on an existing key overwrites rather than duplicating", () => {
  const db = fresh("overwrite");
  const meta = makeMetaRepo(db);
  meta.set("foo", "first");
  meta.set("foo", "second");
  assert.equal(meta.get("foo"), "second");
  const rows = db.prepare("SELECT value FROM meta WHERE key = ?").all("foo");
  assert.equal(rows.length, 1);
  closeDb(db);
});

void test("schemaVersion returns the migration version on a freshly opened database", () => {
  const db = fresh("fresh-version");
  const meta = makeMetaRepo(db);
  assert.equal(meta.schemaVersion(), SCHEMA_VERSION);
  closeDb(db);
});

void test("schemaVersion returns 0 when the schema_version key is absent", () => {
  const db = fresh("no-version");
  db.prepare("DELETE FROM meta WHERE key = 'schema_version'").run();
  const meta = makeMetaRepo(db);
  assert.equal(meta.schemaVersion(), 0);
  closeDb(db);
});

void test("values round-trip without mangling whitespace or non-ASCII characters", () => {
  const db = fresh("unicode");
  const meta = makeMetaRepo(db);
  meta.set("whitespace", "  leading and trailing  ");
  meta.set("accent", "café résumé");
  assert.equal(meta.get("whitespace"), "  leading and trailing  ");
  assert.equal(meta.get("accent"), "café résumé");
  closeDb(db);
});

void test("methods survive destructuring", () => {
  const { schemaVersion } = makeMetaRepo(openDb(join(dir, "destructured.db")));
  assert.equal(typeof schemaVersion(), "number");
});
