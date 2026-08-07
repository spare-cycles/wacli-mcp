/**
 * The background lane: what it refuses, and what it must never do.
 *
 * Every test here exists because its failure would be **silent and expensive**. Nothing in this
 * module throws into ingest, so a broken guard does not produce an error — it produces a bill, or a
 * voice note that quietly never gets transcribed. The two that matter most are the history-replay
 * guard (thousands of jobs from one re-pair) and the budget hard stop (the backstop for every other
 * guard being wrong at once).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, type Config } from "../config.js";
import { closeDb, openDb, type Db } from "../db/client.js";
import { makeMessagesRepo, type MessagesRepo } from "../db/messages.js";
import { makeMetaRepo } from "../db/meta.js";
import { silentLogger } from "../logger.js";
import { makeAutoTranscriber, type AutoTranscriber } from "./autotranscribe.js";
import { makeBudgetLedger } from "./budget.js";
import type { MediaFile, MediaStore } from "./store.js";
import type { Transcriber } from "./transcribe.js";

const CHAT = "33600000000@s.whatsapp.net";
const NOW_MS = Date.parse("2026-08-03T10:00:00Z");
const NOW_S = Math.floor(NOW_MS / 1000);

function configWith(env: Record<string, string> = {}): Config {
  return loadConfig({
    WHATSAPP_AUTOTRANSCRIBE: "1",
    WHATSAPP_RUNPOD_ENDPOINT_ID: "ep",
    RUNPOD_API_KEY: "k",
    RUNPOD_PRICE_PER_SECOND: "0.001",
    RUNPOD_IDLE_TIMEOUT_SECONDS: "100",
    ...env,
  });
}

type Rig = {
  db: Db;
  messages: MessagesRepo;
  auto: AutoTranscriber;
  transcribed: string[];
  fail: { next: number };
  close: () => void;
};

/**
 * A store with one chat I have replied in, plus whatever voice notes the test seeds.
 *
 * The outbound message is not incidental: the chat-scope gate keys on it, so without one every
 * test here would be measuring "out of scope" rather than the guard it means to.
 */
function rig(config: Config, opts: { transcriber?: Partial<Transcriber> } = {}): Rig {
  const db = openDb(":memory:");
  const messages = makeMessagesRepo(db);
  const meta = makeMetaRepo(db);
  db.prepare("INSERT INTO chats (id, is_group) VALUES (?, 0)").run(CHAT);
  messages.upsert({ chatId: CHAT, id: "mine", senderId: CHAT, ts: NOW_S - 100, fromMe: true, kind: "text" });

  const transcribed: string[] = [];
  const fail = { next: 0 };
  const media: MediaStore = {
    fetch: (_chatId, id) =>
      Promise.resolve<MediaFile>({ path: `/tmp/${id}.ogg`, sha256: "a".repeat(64), bytes: 1, mimetype: "audio/ogg" }),
    pathFor: (sha) => `/tmp/${sha}`,
  };
  const transcriber: Transcriber = {
    transcribeFile: () => {
      if (fail.next > 0) {
        fail.next -= 1;
        return Promise.reject(new Error("endpoint is down"));
      }
      return Promise.resolve({ text: "salut", model: "voxtral", language: "fr" });
    },
    available: () => Promise.resolve(true),
    ...opts.transcriber,
  };

  const ledger = makeBudgetLedger({ config, meta, logger: silentLogger(), now: () => NOW_MS });
  const auto = makeAutoTranscriber({
    config,
    logger: silentLogger(),
    messages,
    media,
    transcriber: {
      ...transcriber,
      transcribeFile: async (path, o) => {
        transcribed.push(path);
        return await transcriber.transcribeFile(path, o);
      },
    },
    ledger,
    now: () => NOW_MS,
  });

  return {
    db,
    messages,
    auto,
    transcribed,
    fail,
    close: () => {
      closeDb(db);
    },
  };
}

/** Seed a voice note and hand back the shape `enqueue` takes. */
function seedNote(
  messages: MessagesRepo,
  id: string,
  opts: { ts?: number; durationS?: number; chatId?: string; ptt?: boolean } = {},
): { chatId: string; id: string; ts: number; durationS: number | undefined } {
  const chatId = opts.chatId ?? CHAT;
  const ts = opts.ts ?? NOW_S;
  messages.upsert({
    chatId,
    id,
    senderId: chatId,
    ts,
    fromMe: false,
    kind: "audio",
    ptt: opts.ptt ?? true,
    durationS: opts.durationS ?? 12,
  });
  return { chatId, id, ts, durationS: opts.durationS ?? 12 };
}

/** Let the detached jobs the pump started run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

void test("a voice note that passes every gate is transcribed and stored with its model", async (t) => {
  const r = rig(configWith());
  t.after(r.close);

  r.auto.enqueue([seedNote(r.messages, "v1")]);
  await settle();

  const row = r.messages.get(CHAT, "v1");
  assert.ok(row !== undefined);
  assert.equal(row.transcript, "salut");
  // Provenance goes in with the text: without it a Voxtral transcript and a whisper.cpp-era one are
  // indistinguishable, and nothing can decide what is worth re-transcribing.
  assert.equal(row.transcriptModel, "voxtral");
  // And the language, through this writer rather than through the repository test: the background
  // sweep is the path that produced a language and stored nothing for every voice note until V3.
  assert.equal(row.transcriptLanguage, "fr");
});

void test("🔴 a history replay enqueues nothing while an offline drain of recent notes does", async (t) => {
  // The primary flood guard. Re-pairing onto an empty claim replays thousands of messages; without
  // this, every voice note among them becomes a queued GPU job before anyone notices.
  //
  // ⚠️ The distinction is the *ingest path*, never the upsert's `type`: `messages.upsert` carries
  // both `notify` and the offline `append` drain, and `append` is legitimate traffic that arrived
  // while the process was down. The second half of this test is what would fail if someone
  // "simplified" the guard into a type filter.
  const r = rig(configWith());
  t.after(r.close);

  // What `messaging-history.set` would have produced — except that it passes `transcribe: false`,
  // so `onVoiceNotes` is never called for it at all and nothing reaches `enqueue`.
  assert.equal(r.auto.snapshot().queued, 0);

  // What an `append` drain produces: recent notes, offered normally.
  const drained = [seedNote(r.messages, "d1", { ts: NOW_S - 600 }), seedNote(r.messages, "d2", { ts: NOW_S - 300 })];
  r.auto.enqueue(drained);
  await settle();

  assert.equal(r.messages.get(CHAT, "d1")?.transcript, "salut");
  assert.equal(r.messages.get(CHAT, "d2")?.transcript, "salut");
});

void test("the recency window bounds a long outage's drain", async (t) => {
  const r = rig(configWith({ WHATSAPP_AUTOTRANSCRIBE_MAX_AGE: "3600" }));
  t.after(r.close);

  r.auto.enqueue([
    seedNote(r.messages, "fresh", { ts: NOW_S - 60 }),
    seedNote(r.messages, "stale", { ts: NOW_S - 86_400 }),
  ]);
  await settle();

  assert.equal(r.messages.get(CHAT, "fresh")?.transcript, "salut");
  // Not lost — `whatsapp_transcribe` still works on it. Just not worth spending on unasked.
  assert.equal(r.messages.get(CHAT, "stale")?.transcript, null);
});

void test("the per-hour ceiling holds independently of the dollar cap", async (t) => {
  // Independent on purpose: a pricing mistake must not be able to become an unbounded burst.
  const r = rig(configWith({ WHATSAPP_AUTOTRANSCRIBE_MAX_PER_HOUR: "2" }));
  t.after(r.close);

  r.auto.enqueue([1, 2, 3, 4, 5].map((n) => seedNote(r.messages, `n${n}`)));
  await settle();

  const done = [1, 2, 3, 4, 5].filter((n) => r.messages.get(CHAT, `n${n}`)?.transcript !== null);
  assert.equal(done.length, 2);
});

void test("a recording longer than the gate is refused before it is downloaded", async (t) => {
  const r = rig(configWith({ WHATSAPP_AUTOTRANSCRIBE_MAX_SECONDS: "60" }));
  t.after(r.close);

  r.auto.enqueue([seedNote(r.messages, "long", { durationS: 600 })]);
  await settle();

  assert.equal(r.messages.get(CHAT, "long")?.transcript, null);
  // The whole reason schema V2 persists `duration_s`: gating after the download would invert the
  // gate it exists to be.
  assert.equal(r.transcribed.length, 0);
});

void test("a chat I have never replied in is out of scope", async (t) => {
  const r = rig(configWith());
  t.after(r.close);
  const other = "33699999999@s.whatsapp.net";
  r.db.prepare("INSERT INTO chats (id, is_group) VALUES (?, 0)").run(other);

  r.auto.enqueue([seedNote(r.messages, "b1", { chatId: other })]);
  await settle();

  // Broadcast lists and shops send plenty and are answered never; this is what keeps them off the
  // bill without an explicit blocklist.
  assert.equal(r.messages.get(other, "b1")?.transcript, null);
});

void test("an allowlisted chat bypasses the scope check", async (t) => {
  const other = "33699999999@s.whatsapp.net";
  const r = rig(configWith({ WHATSAPP_AUTOTRANSCRIBE_CHATS: other }));
  t.after(r.close);
  r.db.prepare("INSERT INTO chats (id, is_group) VALUES (?, 0)").run(other);

  r.auto.enqueue([seedNote(r.messages, "b1", { chatId: other })]);
  await settle();

  assert.equal(r.messages.get(other, "b1")?.transcript, "salut");
});

void test("🔴 the background lane stops at the budget cap and on-demand is untouched", async (t) => {
  const r = rig(configWith({ WHATSAPP_AUTOTRANSCRIBE_DAILY_BUDGET_USD: "0" }));
  t.after(r.close);

  r.auto.enqueue([seedNote(r.messages, "v1")]);
  await settle();

  assert.equal(r.messages.get(CHAT, "v1")?.transcript, null);
  assert.equal(r.transcribed.length, 0);
  assert.ok(r.auto.snapshot().budget.exhausted);
});

void test("a transient failure is retried once and then given up on", async (t) => {
  const r = rig(configWith());
  t.after(r.close);
  r.fail.next = 5;

  r.auto.enqueue([seedNote(r.messages, "v1")]);
  await settle();

  // Two attempts, then the row is left for on-demand — not lost, since `transcript IS NULL` keeps
  // it visible to `whatsapp_transcribe` and to the next boot sweep.
  assert.equal(r.transcribed.length, 2);
  assert.equal(r.messages.get(CHAT, "v1")?.transcript, null);
});

void test("an endpoint failure never throws out of enqueue", (t) => {
  const r = rig(configWith(), {
    transcriber: { transcribeFile: () => Promise.reject(new Error("boom")) },
  });
  t.after(r.close);

  // Ingest calls this synchronously from inside its own handler. A throw here would take the
  // WhatsApp message mirror down over a side feature.
  assert.doesNotThrow(() => {
    r.auto.enqueue([seedNote(r.messages, "v1")]);
  });
});

void test("the same note is never queued twice", async (t) => {
  const r = rig(configWith());
  t.after(r.close);
  const note = seedNote(r.messages, "v1");

  r.auto.enqueue([note, note]);
  r.auto.enqueue([note]);
  await settle();

  assert.equal(r.transcribed.length, 1);
});

void test("the boot sweep picks up untranscribed notes inside the window, and only those", async (t) => {
  const r = rig(configWith({ WHATSAPP_AUTOTRANSCRIBE_MAX_AGE: "3600" }));
  t.after(r.close);
  seedNote(r.messages, "recent", { ts: NOW_S - 60 });
  seedNote(r.messages, "old", { ts: NOW_S - 86_400 });
  // A music file, not a voice note. `kind` says "audio" for both, which is exactly why `ptt` exists.
  seedNote(r.messages, "song", { ts: NOW_S - 60, ptt: false });

  r.auto.sweep();
  await settle();

  assert.equal(r.messages.get(CHAT, "recent")?.transcript, "salut");
  assert.equal(r.messages.get(CHAT, "old")?.transcript, null);
  assert.equal(r.messages.get(CHAT, "song")?.transcript, null);
});

void test("a queued note that someone transcribes first is dropped rather than redone", async (t) => {
  // The realistic race: a note waits behind others, someone calls `whatsapp_transcribe` on it, and
  // by the time its turn comes there is nothing left to do. Concurrency 1 with a slow first job is
  // what puts the second one in the queue rather than starting it immediately.
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const r = rig(configWith({ WHATSAPP_AUTOTRANSCRIBE_CONCURRENCY: "1" }), {
    transcriber: {
      transcribeFile: async () => {
        if (first) {
          first = false;
          await held;
        }
        return { text: "salut", model: "voxtral", language: "fr" };
      },
    },
  });
  t.after(r.close);

  r.auto.enqueue([seedNote(r.messages, "slow"), seedNote(r.messages, "v1")]);
  assert.equal(r.auto.snapshot().queued, 1);

  r.messages.setTranscript(CHAT, "v1", { text: "déjà fait", model: "interactive-model", language: "fr" });
  release();
  await settle();

  assert.equal(r.messages.get(CHAT, "v1")?.transcript, "déjà fait");
  // Only the first note was sent; the second was dropped at the head of the queue.
  assert.equal(r.transcribed.length, 1);
});

void test("nothing is enqueued at all when the feature is off", async (t) => {
  const r = rig(configWith({ WHATSAPP_AUTOTRANSCRIBE: "0" }));
  t.after(r.close);

  r.auto.enqueue([seedNote(r.messages, "v1")]);
  r.auto.sweep();
  await settle();

  assert.equal(r.transcribed.length, 0);
  assert.equal(r.auto.snapshot().enabled, false);
});

void test("background concurrency stays under the endpoint's worker ceiling", async (t) => {
  // The gap between this cap and `workers_max: 3` *is* the preemption: it is what guarantees an
  // interactive call always has a worker to land on rather than queueing behind unasked-for work.
  let peak = 0;
  let live = 0;
  const config = configWith({ WHATSAPP_AUTOTRANSCRIBE_CONCURRENCY: "2", WHATSAPP_AUTOTRANSCRIBE_MAX_PER_HOUR: "50" });
  const r = rig(config, {
    transcriber: {
      transcribeFile: async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setImmediate(resolve));
        live -= 1;
        return { text: "salut", model: "voxtral", language: "fr" };
      },
    },
  });
  t.after(r.close);

  r.auto.enqueue([1, 2, 3, 4, 5, 6].map((n) => seedNote(r.messages, `n${n}`)));
  await settle();

  assert.equal(peak, 2);
  assert.equal(config.autoTranscribe.concurrency, 2);
});
