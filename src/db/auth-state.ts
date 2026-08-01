import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "baileys";
import type { Db } from "./client.js";

export type AuthStore = {
  state: AuthenticationState;
  saveCreds: () => void;
  /** Wipe credentials and signal keys — used on loggedOut so the next boot re-pairs cleanly. */
  clear: () => void;
};

const CREDS_KEY = "creds";

type ValueRow = { value: string };

export function makeAuthStore(db: Db): AuthStore {
  const getCredsStmt = db.prepare("SELECT value FROM auth_creds WHERE key = ?");
  const setCredsStmt = db.prepare(
    "INSERT INTO auth_creds (key, value) VALUES (:key, :value) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  const clearCredsStmt = db.prepare("DELETE FROM auth_creds");

  const getKeyStmt = db.prepare("SELECT value FROM auth_keys WHERE type = ? AND id = ?");
  const setKeyStmt = db.prepare(
    "INSERT INTO auth_keys (type, id, value) VALUES (:type, :id, :value) ON CONFLICT (type, id) DO UPDATE SET value = excluded.value",
  );
  const deleteKeyStmt = db.prepare("DELETE FROM auth_keys WHERE type = ? AND id = ?");
  const clearKeysStmt = db.prepare("DELETE FROM auth_keys");

  function loadCreds(): AuthenticationCreds {
    const row = getCredsStmt.get(CREDS_KEY) as ValueRow | undefined;
    if (row === undefined) return initAuthCreds();
    return JSON.parse(row.value, BufferJSON.reviver) as AuthenticationCreds;
  }

  const creds = loadCreds();

  function saveCreds(): void {
    setCredsStmt.run({ key: CREDS_KEY, value: JSON.stringify(creds, BufferJSON.replacer) });
  }

  // Must be async to satisfy Baileys' SignalKeyStore interface even though node:sqlite is synchronous.
  // eslint-disable-next-line @typescript-eslint/require-await -- see comment above
  async function get<T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[],
  ): Promise<Record<string, SignalDataTypeMap[T]>> {
    const data: Record<string, SignalDataTypeMap[T]> = {};
    for (const id of ids) {
      const row = getKeyStmt.get(type, id) as ValueRow | undefined;
      if (row === undefined) continue;
      let value = JSON.parse(row.value, BufferJSON.reviver) as SignalDataTypeMap[T];
      // Baileys expects app-state-sync-key values back as a proto message instance, not a plain
      // object — same precedent as useMultiFileAuthState (lib/Utils/use-multi-file-auth-state.js).
      if (type === "app-state-sync-key") {
        value = proto.Message.AppStateSyncKeyData.fromObject(
          value as unknown as Record<string, unknown>,
        ) as unknown as SignalDataTypeMap[T];
      }
      data[id] = value;
    }
    return data;
  }

  // Must be async to satisfy Baileys' SignalKeyStore interface even though node:sqlite is synchronous.
  // eslint-disable-next-line @typescript-eslint/require-await -- see comment above
  async function set(data: SignalDataSet): Promise<void> {
    db.exec("BEGIN");
    try {
      for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
        const category = data[type];
        if (category === undefined) continue;
        for (const id of Object.keys(category)) {
          const value = category[id];
          if (value === null || value === undefined) {
            deleteKeyStmt.run(type, id);
          } else {
            setKeyStmt.run({ type, id, value: JSON.stringify(value, BufferJSON.replacer) });
          }
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function clear(): void {
    clearCredsStmt.run();
    clearKeysStmt.run();
  }

  return {
    state: { creds, keys: { get, set } },
    saveCreds,
    clear,
  };
}
