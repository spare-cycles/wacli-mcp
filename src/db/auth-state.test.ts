import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeAuthStore } from "./auth-state.js";
import { openDb } from "./client.js";

const dir = mkdtempSync(join(tmpdir(), "wa-auth-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

void test("fresh creds are generated and survive a reopen", () => {
  const path = join(dir, "a.db");
  const first = makeAuthStore(openDb(path));
  const id = first.state.creds.me?.id;
  first.saveCreds();
  const second = makeAuthStore(openDb(path));
  assert.deepEqual(second.state.creds.registrationId, first.state.creds.registrationId);
  assert.equal(second.state.creds.me?.id, id);
});

void test("signal keys round-trip as Buffers, not as JSON-mangled objects", async () => {
  const store = makeAuthStore(openDb(join(dir, "b.db")));
  const key = Buffer.from([1, 2, 3, 250, 255]);
  await store.state.keys.set({ "pre-key": { "7": { public: key, private: key } } });
  const got = await store.state.keys.get("pre-key", ["7"]);
  assert.ok(Buffer.isBuffer(got["7"]?.public), "a Buffer must come back as a Buffer");
  assert.deepEqual(Buffer.from(got["7"].public), key);
});

void test("the v7 key types are storable", async () => {
  const store = makeAuthStore(openDb(join(dir, "c.db")));
  // Shapes taken verbatim from baileys' SignalDataTypeMap (lib/Types/Auth.d.ts:68-85):
  //   'lid-mapping': string        'device-list': string[]
  //   tctoken: { token: Buffer; timestamp?: string; senderTimestamp?: number }
  // Getting these wrong fails the strictTypeChecked gate rather than a runtime assertion.
  await store.state.keys.set({ "lid-mapping": { "999": "33612345678" } });
  await store.state.keys.set({ "device-list": { d1: ["33612345678:1", "33612345678:2"] } });
  await store.state.keys.set({ tctoken: { t1: { token: Buffer.from([9, 9]), timestamp: "1700" } } });
  assert.equal((await store.state.keys.get("lid-mapping", ["999"]))["999"], "33612345678");
  assert.deepEqual((await store.state.keys.get("device-list", ["d1"]))["d1"], ["33612345678:1", "33612345678:2"]);
  assert.ok(Buffer.isBuffer((await store.state.keys.get("tctoken", ["t1"]))["t1"]?.token));
});

void test("setting a key to null deletes it", async () => {
  const store = makeAuthStore(openDb(join(dir, "d.db")));
  // Shaped as KeyPair (baileys' SignalDataTypeMap['pre-key']), not a bare Buffer — the deletion
  // behavior under test doesn't depend on the value's shape, only on it being present then nulled.
  await store.state.keys.set({ "pre-key": { "1": { public: Buffer.from([1]), private: Buffer.from([1]) } } });
  await store.state.keys.set({ "pre-key": { "1": null } });
  assert.equal((await store.state.keys.get("pre-key", ["1"]))["1"], undefined);
});

void test("get tolerates unknown ids", async () => {
  const store = makeAuthStore(openDb(join(dir, "e.db")));
  assert.deepEqual(await store.state.keys.get("session", ["nope"]), {});
});

void test("clear wipes creds and keys", async () => {
  const path = join(dir, "f.db");
  const store = makeAuthStore(openDb(path));
  await store.state.keys.set({ "pre-key": { "1": { public: Buffer.from([1]), private: Buffer.from([1]) } } });
  store.saveCreds();
  store.clear();
  const reopened = makeAuthStore(openDb(path));
  assert.deepEqual(await reopened.state.keys.get("pre-key", ["1"]), {});
});

void test("clear also resets the live creds object, in place, to a fresh identity", () => {
  const store = makeAuthStore(openDb(join(dir, "g.db")));
  const held = store.state.creds; // the very object `makeSocket` is handed (wa/connection.ts)
  held.me = { id: "33612345678:1@s.whatsapp.net", name: "the logged-out account" };
  held.registered = true;
  const oldNoiseKey = Buffer.from(held.noiseKey.private).toString("base64");
  const oldSecret = held.advSecretKey;
  store.saveCreds();

  store.clear();

  assert.equal(store.state.creds, held, "the reset must be in place: Baileys already holds this reference");
  assert.notEqual(
    Buffer.from(store.state.creds.noiseKey.private).toString("base64"),
    oldNoiseKey,
    "the in-memory keys must be regenerated, not merely deleted from disk",
  );
  assert.notEqual(store.state.creds.advSecretKey, oldSecret);
  assert.equal(store.state.creds.registered, false);
  assert.equal(
    store.state.creds.me,
    undefined,
    "initAuthCreds() does not define `me`, so a plain Object.assign would leave the wiped account's identity behind",
  );
});

void test("a creds.update arriving after clear cannot resurrect the wiped credentials", () => {
  const path = join(dir, "h.db");
  const store = makeAuthStore(openDb(path));
  const oldSecret = store.state.creds.advSecretKey;
  store.saveCreds();

  store.clear();
  // `attachListeners` never detaches, so the dead socket's last `creds.update` still fires here.
  store.saveCreds();

  const reopened = makeAuthStore(openDb(path));
  assert.notEqual(
    reopened.state.creds.advSecretKey,
    oldSecret,
    "a late save must not write the logged-out session's credentials back over the wipe",
  );
  assert.equal(reopened.state.creds.advSecretKey, store.state.creds.advSecretKey);
  assert.equal(reopened.state.creds.registered, false);
});
