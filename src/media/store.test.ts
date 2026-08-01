/**
 * The cache, exercised against a real SQLite store and a stubbed downloader.
 *
 * The downloader is the one thing stubbed here — it is the only piece that would otherwise need a
 * live WhatsApp connection — and every assertion below is about what the *store* does around it:
 * when it calls the downloader at all, when it refuses to, what reaches disk, and what the
 * connection is asked for. The repository, the protobuf envelope and the filesystem are all real.
 */

import { proto, type WAMessage, type WASocket } from "baileys";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Logger } from "pino";
import { makeChatsRepo } from "../db/chats.js";
import { closeDb, openDb, type Db } from "../db/client.js";
import { makeMessagesRepo, type MessageKind, type MessagesRepo } from "../db/messages.js";
import { ConnectionUnavailableError, type ConnectionSnapshot, type WaConnection } from "../wa/connection.js";
import * as fx from "../wa/fixtures.js";
import { makeMediaStore, MediaUnavailableError, type MediaDownloader } from "./store.js";

const dir = mkdtempSync(join(tmpdir(), "wa-store-"));
const opened: Db[] = [];
after(() => {
  for (const db of opened) closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

const silentLogger = {
  info() {
    /* no-op */
  },
  warn() {
    /* no-op */
  },
  error() {
    /* no-op */
  },
  debug() {
    /* no-op */
  },
} as unknown as Logger;

const PAYLOAD = Buffer.from("the media bytes, whatever they happen to be");
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

type SeedOptions = { id?: string; kind?: MessageKind; withEnvelope?: boolean; message?: WAMessage };

/** Put a row in the store the way ingest would: a media kind plus the encoded envelope. */
function seed(messages: MessagesRepo, o: SeedOptions = {}): string {
  const id = o.id ?? "M1";
  const kind = o.kind ?? "image";
  const message = o.message ?? fx.imageMessage({ id });
  messages.upsert({
    chatId: fx.FIXTURE_DM,
    id,
    senderId: fx.FIXTURE_DM,
    ts: fx.FIXTURE_TS,
    fromMe: false,
    kind,
    raw: o.withEnvelope === false ? undefined : proto.WebMessageInfo.encode(message).finish(),
  });
  return id;
}

type HarnessOptions = { download?: MediaDownloader | undefined };

let harnessCount = 0;

function harness(o: HarnessOptions = {}) {
  harnessCount += 1;
  const root = join(dir, `h${harnessCount}`);
  const db = openDb(join(root, "wa.db"));
  opened.push(db);
  const messages = makeMessagesRepo(db);
  makeChatsRepo(db).ensure(fx.FIXTURE_DM, false);
  const mediaDir = join(root, "media");

  let offline = false;
  const reuploads: WAMessage[] = [];
  const sock = {
    updateMediaMessage: (m: WAMessage): Promise<WAMessage> => {
      reuploads.push(m);
      return Promise.resolve(m);
    },
  } as unknown as WASocket;

  const conn: WaConnection = {
    snapshot: (): ConnectionSnapshot => ({
      state: offline ? "disconnected" : "connected",
      lastEventAt: 0,
      lastConnectedAt: null,
      attempts: 0,
      needsPairing: false,
      selfId: null,
    }),
    requireSocket: (): WASocket => {
      if (offline) throw new ConnectionUnavailableError("disconnected");
      return sock;
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    onStateChange: () => undefined,
  };

  const downloaded: WAMessage[] = [];
  const download: MediaDownloader =
    o.download ??
    ((message) => {
      downloaded.push(message);
      return Promise.resolve(PAYLOAD);
    });

  const store = makeMediaStore({ dir: mediaDir, messages, conn, logger: silentLogger, download });
  return {
    messages,
    store,
    mediaDir,
    downloaded,
    reuploads,
    setOffline: (v: boolean) => {
      offline = v;
    },
    files: (): string[] => {
      try {
        return readdirSync(mediaDir).sort();
      } catch {
        return [];
      }
    },
  };
}

// --- the happy path ---------------------------------------------------------------------------

void test("a first fetch downloads, hashes, writes and records the sha", async () => {
  const h = harness();
  const id = seed(h.messages);

  const file = await h.store.fetch(fx.FIXTURE_DM, id);

  assert.equal(file.sha256, PAYLOAD_SHA);
  assert.equal(file.path, join(h.mediaDir, PAYLOAD_SHA));
  assert.equal(file.bytes, PAYLOAD.byteLength);
  assert.equal(file.mimetype, "image/jpeg", "the mimetype comes off the stored envelope");
  assert.deepEqual(readFileSync(file.path), PAYLOAD);
  assert.equal(h.downloaded.length, 1);

  const row = h.messages.get(fx.FIXTURE_DM, id);
  assert.ok(row !== undefined);
  assert.equal(row.mediaSha, PAYLOAD_SHA);
  assert.equal(row.mediaType, "image/jpeg");
});

void test("a second fetch is served from disk without downloading again", async () => {
  const h = harness();
  const id = seed(h.messages);

  const first = await h.store.fetch(fx.FIXTURE_DM, id);
  const second = await h.store.fetch(fx.FIXTURE_DM, id);

  assert.deepEqual(second, first);
  assert.equal(h.downloaded.length, 1, "the second call must not touch the downloader");
});

void test("a successful fetch leaves no temporary file behind", async () => {
  const h = harness();
  await h.store.fetch(fx.FIXTURE_DM, seed(h.messages));
  assert.deepEqual(h.files(), [PAYLOAD_SHA], "only the content-addressed file may survive");
});

void test("two messages with identical bytes share one cached file", async () => {
  const h = harness();
  const a = seed(h.messages, { id: "MA" });
  const b = seed(h.messages, { id: "MB" });

  const first = await h.store.fetch(fx.FIXTURE_DM, a);
  const second = await h.store.fetch(fx.FIXTURE_DM, b);

  assert.equal(second.path, first.path);
  assert.deepEqual(h.files(), [PAYLOAD_SHA]);
});

void test("concurrent fetches of the same message settle on one intact file", async () => {
  const slow: MediaDownloader = async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return PAYLOAD;
  };
  const h = harness({ download: slow });
  const id = seed(h.messages);

  const [a, b] = await Promise.all([h.store.fetch(fx.FIXTURE_DM, id), h.store.fetch(fx.FIXTURE_DM, id)]);

  assert.equal(a.path, b.path);
  assert.deepEqual(h.files(), [PAYLOAD_SHA], "a per-attempt temp name is what keeps two writers apart");
  assert.deepEqual(readFileSync(a.path), PAYLOAD, "the cached bytes must not be an interleaved mess");
});

void test("the download context's reuploadRequest reaches the live socket", async () => {
  const asking: MediaDownloader = async (message, ctx) => {
    await ctx.reuploadRequest(message);
    return PAYLOAD;
  };
  const h = harness({ download: asking });
  const id = seed(h.messages);

  await h.store.fetch(fx.FIXTURE_DM, id);
  assert.equal(h.reuploads.length, 1, "a re-upload request must be wired to sock.updateMediaMessage");
  assert.equal(h.reuploads[0]?.key.id, id);
});

// --- connection state -------------------------------------------------------------------------

void test("a cache hit is served while the connection is down", async () => {
  const h = harness();
  const id = seed(h.messages);
  await h.store.fetch(fx.FIXTURE_DM, id);

  h.setOffline(true);
  const file = await h.store.fetch(fx.FIXTURE_DM, id);

  assert.equal(file.sha256, PAYLOAD_SHA);
  assert.equal(h.downloaded.length, 1);
});

void test("a cache miss with no socket propagates the connection error rather than masking it", async () => {
  const h = harness();
  const id = seed(h.messages);
  h.setOffline(true);

  await assert.rejects(
    () => h.store.fetch(fx.FIXTURE_DM, id),
    (err: unknown) => {
      assert.ok(err instanceof ConnectionUnavailableError, `expected ConnectionUnavailableError, got ${String(err)}`);
      assert.ok(
        !(err instanceof MediaUnavailableError),
        "'wait for the connection' and 'give up on this media' must stay distinguishable",
      );
      return true;
    },
  );
  assert.equal(h.downloaded.length, 0);
});

void test("a cached row whose file has been deleted downloads it again", async () => {
  const h = harness();
  const id = seed(h.messages);
  const first = await h.store.fetch(fx.FIXTURE_DM, id);
  unlinkSync(first.path);

  const again = await h.store.fetch(fx.FIXTURE_DM, id);
  assert.equal(again.path, first.path);
  assert.equal(h.downloaded.length, 2);
});

// --- refusals ---------------------------------------------------------------------------------

void test("an unknown message is refused", async () => {
  const h = harness();
  await assert.rejects(() => h.store.fetch(fx.FIXTURE_DM, "NOPE"), MediaUnavailableError);
});

void test("a message that carries no media is refused, naming its kind", async () => {
  const h = harness();
  const id = seed(h.messages, { kind: "text", message: fx.textMessage({ id: "MT" }) });
  await assert.rejects(() => h.store.fetch(fx.FIXTURE_DM, id), /text/);
  assert.equal(h.downloaded.length, 0);
});

void test("a media message stored without its envelope is refused", async () => {
  const h = harness();
  const id = seed(h.messages, { withEnvelope: false });
  await assert.rejects(() => h.store.fetch(fx.FIXTURE_DM, id), MediaUnavailableError);
  assert.equal(h.downloaded.length, 0);
});

void test("a download failure says the media has most likely expired and caches nothing", async () => {
  const h = harness({
    download: () => Promise.reject(new Error("404 from mmg.whatsapp.net")),
  });
  const id = seed(h.messages);

  await assert.rejects(() => h.store.fetch(fx.FIXTURE_DM, id), /expire/i);
  assert.deepEqual(h.files(), [], "a failed download must leave neither a temp file nor a content-addressed one");
  assert.equal(h.messages.get(fx.FIXTURE_DM, id)?.mediaSha, null);
});

void test("a download that yields no bytes is refused rather than cached as an empty file", async () => {
  const h = harness({ download: () => Promise.resolve(Buffer.alloc(0)) });
  const id = seed(h.messages);

  await assert.rejects(() => h.store.fetch(fx.FIXTURE_DM, id), MediaUnavailableError);
  assert.deepEqual(h.files(), []);
  assert.equal(h.messages.get(fx.FIXTURE_DM, id)?.mediaSha, null);
});

// --- addressing -------------------------------------------------------------------------------

void test("pathFor is the content address under the media directory", () => {
  const h = harness();
  assert.equal(h.store.pathFor(PAYLOAD_SHA), join(h.mediaDir, PAYLOAD_SHA));
});

void test("pathFor refuses anything that is not a sha256 digest", () => {
  const h = harness();
  for (const bad of ["../../etc/passwd", "", "ABCDEF", `${PAYLOAD_SHA}/x`, PAYLOAD_SHA.toUpperCase()]) {
    assert.throws(() => h.store.pathFor(bad), MediaUnavailableError, bad);
  }
});
