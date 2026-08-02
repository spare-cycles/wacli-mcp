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

  /**
   * Reset the live creds object in place, to a brand-new identity.
   *
   * **In place, on the same object**, because `whatsapp/connection.ts` hands `state.creds` straight to
   * `makeSocket` and Baileys goes on mutating whatever it was given: rebinding here would leave the
   * socket writing into an orphan while this module read a different object.
   *
   * `initAuthCreds()` defines only what a *fresh* session has. Everything a paired one accumulates —
   * `me`, `account`, `signalIdentities`, `myAppStateKeyId`, `platform` — is absent from it, so a bare
   * `Object.assign` would leave the logged-out account's identity sitting on top of brand-new keys.
   * Those fields are therefore cleared first: set to `undefined` rather than `delete`d, which is what
   * every reader of them already tests for, is what `JSON.stringify` drops on the way to the row
   * anyway, and needs no dynamic delete.
   */
  function resetCreds(): void {
    const fresh = initAuthCreds();
    const mutable = creds as unknown as Record<string, unknown>;
    for (const key of Object.keys(creds)) {
      if (!(key in fresh)) mutable[key] = undefined;
    }
    Object.assign(creds, fresh);
  }

  /**
   * Wipe the stored session *and* the live one, together.
   *
   * The two halves are one operation, which is why they share a transaction. `state.creds` is the
   * object the socket was built from, so deleting the rows and leaving it untouched would leave a
   * `start()` after `logged_out` — a transition `whatsapp/connection.ts` documents and allows — trying to
   * re-authenticate with precisely the credentials WhatsApp has just rejected. And because
   * `attachListeners` never detaches, one late `creds.update` from the dead socket would call
   * `saveCreds()` and write that identity straight back over the wipe. Regenerating in place closes
   * both: a late save now persists the fresh identity, which is a no-op rather than a resurrection.
   *
   * `resetCreds()` sits last inside the transaction so a throw from either DELETE leaves the live
   * object untouched, matching the rolled-back rows.
   */
  function clear(): void {
    db.exec("BEGIN");
    try {
      clearCredsStmt.run();
      clearKeysStmt.run();
      resetCreds();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return {
    state: { creds, keys: { get, set } },
    saveCreds,
    clear,
  };
}
