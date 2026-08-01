import type { Db } from "./client.js";

export type MetaRepo = {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  schemaVersion(): number;
};

export function makeMetaRepo(db: Db): MetaRepo {
  return {
    get(key: string): string | undefined {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value;
    },

    set(key: string, value: string): void {
      db.prepare(
        "INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).run({ key, value });
    },

    schemaVersion(): number {
      const raw = this.get("schema_version");
      return raw === undefined ? 0 : Number(raw);
    },
  };
}
