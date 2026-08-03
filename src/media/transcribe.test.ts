/**
 * The backend chain, driven entirely through a `fetch` mock.
 *
 * What used to be here tested a 574 MB download: resumed `.part` files, truncated bodies, stall
 * budgets, ENOSPC. None of that exists any more — the model lives on a GPU somewhere else — and the
 * failures worth testing moved with it. They are now about *which backend answers*, and the two
 * that matter most are the ones no type can catch: a background job silently reaching the paid API,
 * and a chain that reports only its last failure when the interesting one was the first.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { loadConfig, type Config } from "../config.js";
import { silentLogger } from "../logger.js";
import { MAX_PAYLOAD_BYTES } from "./backends/runpod.js";
import type { BudgetLedger, JobTiming } from "./budget.js";
import { makeTranscriber, TranscriptionError } from "./transcribe.js";

const run = promisify(execFile);

let dir = "";
/** A real two-second Ogg/Opus file — the container every WhatsApp voice note actually arrives in. */
let ogg = "";
/** Deliberately huge, to exercise the payload guard the way a transcoded video would. */
let big = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "transcribe-"));
  ogg = join(dir, "note.ogg");
  big = join(dir, "big.wav");
  await run("ffmpeg", [
    ...["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2"],
    ...["-ac", "1", "-c:a", "libopus", "-b:a", "16k", ogg],
  ]);
  await run("ffmpeg", [
    ...["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "60"],
    ...["-c:a", "pcm_s24le", big],
  ]);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function configWith(env: Record<string, string> = {}): Config {
  return loadConfig({
    WHATSAPP_DATA_DIR: dir,
    WHATSAPP_RUNPOD_ENDPOINT_ID: "ep123",
    RUNPOD_API_KEY: "rp-key",
    MISTRAL_API_KEY: "mi-key",
    ...env,
  });
}

type Call = { url: string; init: RequestInit | undefined };

/** A `fetch` that answers each URL from a table and records every call it received. */
function mockFetch(routes: Record<string, () => Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  // `Parameters<typeof fetch>` rather than `RequestInfo`: the DOM lib is not loaded here, so that
  // name does not exist — but `fetch` itself is in Node's globals and already carries the shape.
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // Every branch spelled out: `Request` has no useful `toString`, so a bare `String(input)` on
    // one yields "[object Request]" and every route lookup silently misses.
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const key = Object.keys(routes).find((route) => url.includes(route));
    if (key === undefined) return Promise.resolve(new Response("no route", { status: 599 }));
    return Promise.resolve(routes[key]?.() ?? new Response("", { status: 599 }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * The JSON body a recorded call carried.
 *
 * Narrowed to `string` rather than `String(...)`-ed: `RequestInit["body"]` is a union that includes
 * `FormData` and streams, and stringifying one of those yields `[object FormData]`, which
 * `JSON.parse` then rejects with an error about the *body* rather than about the assertion. Every
 * call this file inspects is a RunPod job, whose body is always serialised JSON.
 */
function bodyOf(call: Call | undefined): string {
  const body = call?.init?.body;
  assert.equal(typeof body, "string", "expected a JSON request body");
  return body as string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const COMPLETED = {
  status: "COMPLETED",
  output: { text: "bonjour ça va", model: "mistralai/Voxtral-Small-24B-2507", language: "fr" },
};

void test("a runsync that completes inline returns the transcript and its provenance", async () => {
  const { fetchImpl, calls } = mockFetch({ "/runsync": () => json(COMPLETED) });
  const t = makeTranscriber({ config: configWith(), logger: silentLogger(), fetchImpl });

  const result = await t.transcribeFile(ogg, { mimetype: "audio/ogg" });

  assert.equal(result.text, "bonjour ça va");
  // The model name is the whole reason `transcript_model` exists; losing it here would make every
  // stored transcript indistinguishable from a whisper.cpp-era one.
  assert.equal(result.model, "mistralai/Voxtral-Small-24B-2507");
  assert.equal(result.language, "fr");
  assert.equal(calls.length, 1);
  // Jobs go to api.runpod.**ai**. api.runpod.io is the management API and answers 401 — an hour of
  // debugging that reads exactly like a bad key.
  assert.ok(calls[0]?.url.startsWith("https://api.runpod.ai/v2/ep123/"), calls[0]?.url);
});

void test("a queued job is polled to completion", async () => {
  let polls = 0;
  const { fetchImpl } = mockFetch({
    "/runsync": () => json({ id: "job-1", status: "IN_QUEUE" }),
    "/status/": () => {
      polls += 1;
      return json(polls < 2 ? { id: "job-1", status: "IN_PROGRESS" } : COMPLETED);
    },
  });
  const t = makeTranscriber({ config: configWith(), logger: silentLogger(), fetchImpl });

  const result = await t.transcribeFile(ogg, { mimetype: "audio/ogg" });

  assert.equal(result.text, "bonjour ça va");
  // A cold endpoint loading 55 GB of weights *always* takes this path on the first request of a
  // quiet day, so it is the normal case rather than an edge one.
  assert.equal(polls, 2);
});

void test("the interactive lane falls back to Mistral when the endpoint fails", async () => {
  const { fetchImpl, calls } = mockFetch({
    "/runsync": () => json({ error: "no capacity" }, 503),
    "api.mistral.ai": () => json({ text: "depuis mistral", language: "fr" }),
  });
  const t = makeTranscriber({ config: configWith(), logger: silentLogger(), fetchImpl });

  const result = await t.transcribeFile(ogg, { mimetype: "audio/ogg", lane: "interactive" });

  assert.equal(result.text, "depuis mistral");
  assert.equal(result.model, "voxtral-mini-latest");
  assert.equal(calls.length, 2);
});

void test("🔴 the background lane never reaches Mistral, even with the endpoint down", async () => {
  // The one behaviour in this file that no type can enforce and that costs real money to get wrong:
  // paying a third party to transcribe a recording nobody asked about — and sending them
  // conversation audio without anyone deciding to.
  const { fetchImpl, calls } = mockFetch({
    "/runsync": () => json({ error: "no capacity" }, 503),
    "api.mistral.ai": () => json({ text: "SHOULD NEVER BE REACHED" }),
  });
  const t = makeTranscriber({ config: configWith(), logger: silentLogger(), fetchImpl });

  await assert.rejects(() => t.transcribeFile(ogg, { mimetype: "audio/ogg", lane: "background" }), TranscriptionError);
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((call) => call.url.includes("mistral")), "the background lane called Mistral");
});

void test("every backend's failure reaches the error, not just the last", async () => {
  const { fetchImpl } = mockFetch({
    "/runsync": () => json({}, 500),
    "api.mistral.ai": () => json({}, 401),
  });
  const t = makeTranscriber({ config: configWith(), logger: silentLogger(), fetchImpl });

  await assert.rejects(
    () => t.transcribeFile(ogg, { mimetype: "audio/ogg" }),
    (err: unknown) => {
      assert.ok(err instanceof TranscriptionError);
      // The last failure is usually the least informative — "MISTRAL_API_KEY is not set" says
      // nothing about why the endpoint refused.
      assert.match(err.message, /runpod:[^|]*500/);
      assert.match(err.message, /mistral:[^|]*401/);
      return true;
    },
  );
});

void test("a recording over the length limit is refused before anything is sent", async () => {
  const { fetchImpl, calls } = mockFetch({ "/runsync": () => json(COMPLETED) });
  const t = makeTranscriber({
    config: configWith({ WHATSAPP_TRANSCRIBE_MAX_SECONDS: "1" }),
    logger: silentLogger(),
    fetchImpl,
  });

  await assert.rejects(() => t.transcribeFile(ogg, { mimetype: "audio/ogg" }), TranscriptionError);
  // The gate is the only refusal that costs nothing; running it after the upload would defeat it.
  assert.equal(calls.length, 0);
});

void test("WHATSAPP_WHISPER_MAX_SECONDS still works as a deprecated alias", () => {
  // The one transcription variable a live deployment already sets. Dropping it during the rollout
  // would silently reset the limit to its default and start refusing recordings that used to work.
  assert.equal(configWith({ WHATSAPP_WHISPER_MAX_SECONDS: "42" }).transcribeMaxSeconds, 42);
  // The new name wins when both are present.
  const both = configWith({ WHATSAPP_WHISPER_MAX_SECONDS: "42", WHATSAPP_TRANSCRIBE_MAX_SECONDS: "77" });
  assert.equal(both.transcribeMaxSeconds, 77);
});

void test("a voice note is uploaded byte for byte, with no ffmpeg in the way", async () => {
  // WhatsApp already sends ~16 kbps mono Ogg/Opus, and the worker normalises on arrival regardless.
  // Re-encoding it would spend a process to make it very slightly worse.
  const { fetchImpl, calls } = mockFetch({ "/runsync": () => json(COMPLETED) });
  const t = makeTranscriber({ config: configWith(), logger: silentLogger(), fetchImpl });
  const original = (await readFile(ogg)).toString("base64");

  await t.transcribeFile(ogg, { mimetype: "audio/ogg" });

  const body = JSON.parse(bodyOf(calls[0])) as { input: { audio_base64: string } };
  assert.equal(body.input.audio_base64, original);
});

void test("a large or non-audio file is transcoded down instead of being refused", async () => {
  // 60 s of 24-bit stereo PCM is ~17 MB, which base64s to ~23 MB — far past RunPod's 10 MB request
  // limit. Refusing it would be the wrong answer when 24 kbps Opus fits the same audio in ~180 kB.
  const { fetchImpl, calls } = mockFetch({ "/runsync": () => json(COMPLETED) });
  const t = makeTranscriber({
    config: configWith({ WHATSAPP_TRANSCRIBE_BACKENDS: "runpod" }),
    logger: silentLogger(),
    fetchImpl,
  });

  const result = await t.transcribeFile(big, { mimetype: "audio/wav" });

  assert.equal(result.text, "bonjour ça va");
  const body = JSON.parse(bodyOf(calls[0])) as { input: { audio_base64: string } };
  const raw = (await readFile(big)).byteLength;
  assert.ok(body.input.audio_base64.length < raw / 10, `${body.input.audio_base64.length} vs ${raw}`);
});

void test("the payload guard is a backstop that the transcode threshold keeps out of reach", () => {
  // Arithmetic rather than a fixture, because reaching the guard for real needs about half an hour
  // of audio and the point is precisely that ordinary input cannot get there. Anything above
  // `MAX_PAYLOAD_BYTES * 0.7` is transcoded first, and 0.7 × 4/3 < 1 — so a file sent untranscoded
  // can never base64 past the cap. The guard therefore only ever fires on a *transcoded* recording
  // long enough to exceed it anyway, which is possible only once someone raises
  // WHATSAPP_TRANSCRIBE_MAX_SECONDS well past its default.
  assert.ok((MAX_PAYLOAD_BYTES * 0.7 * 4) / 3 < MAX_PAYLOAD_BYTES);
});

void test("a worker that refuses a recording is not retried against the same endpoint", async () => {
  let attempts = 0;
  const { fetchImpl } = mockFetch({
    "/runsync": () => {
      attempts += 1;
      return json({ status: "COMPLETED", output: { error: "no speech was found in this recording" } });
    },
  });
  const t = makeTranscriber({
    config: configWith({ WHATSAPP_TRANSCRIBE_BACKENDS: "runpod" }),
    logger: silentLogger(),
    fetchImpl,
  });

  await assert.rejects(() => t.transcribeFile(ogg, { mimetype: "audio/ogg" }), TranscriptionError);
  // The worker decided. Asking again spends the same GPU seconds to be told the same thing.
  assert.equal(attempts, 1);
});

void test("bias terms and language reach the endpoint as the contract says", async () => {
  const { fetchImpl, calls } = mockFetch({ "/runsync": () => json(COMPLETED) });
  const t = makeTranscriber({ config: configWith(), logger: silentLogger(), fetchImpl });

  await t.transcribeFile(ogg, { mimetype: "audio/ogg", language: "fr", biasTerms: ["Thibault", "Grenoble"] });

  const body = JSON.parse(bodyOf(calls[0])) as {
    input: { language: string; bias_terms: string[]; audio_base64: string };
  };
  assert.equal(body.input.language, "fr");
  assert.deepEqual(body.input.bias_terms, ["Thibault", "Grenoble"]);
  assert.ok(body.input.audio_base64.length > 100);
});

void test("no language means detect, not French", async () => {
  // 98 % French is not 100 %. Forcing `fr` would improve adherence for the majority and silently
  // mangle the rest, which is the failure nobody would notice.
  const { fetchImpl, calls } = mockFetch({ "/runsync": () => json(COMPLETED) });
  const t = makeTranscriber({ config: configWith(), logger: silentLogger(), fetchImpl });

  await t.transcribeFile(ogg, { mimetype: "audio/ogg" });

  const body = JSON.parse(bodyOf(calls[0])) as { input: { language: string | null } };
  assert.equal(body.input.language, null);
});

void test("a completed RunPod job is charged against the budget; a Mistral one is not", async () => {
  const charged: JobTiming[] = [];
  const ledger: BudgetLedger = {
    record: (timing) => charged.push(timing),
    exhausted: () => false,
    spentUsd: () => 0,
    snapshot: () => ({ day: "2026-08-03", spentUsd: 0, budgetUsd: 2, exhausted: false }),
  };
  const down = mockFetch({
    "/runsync": () => json({ error: "down" }, 503),
    "api.mistral.ai": () => json({ text: "depuis mistral" }),
  });
  const t = makeTranscriber({ config: configWith(), logger: silentLogger(), fetchImpl: down.fetchImpl, ledger });

  await t.transcribeFile(ogg, { mimetype: "audio/ogg" });
  // Only RunPod bills by the second. Charging the Mistral answer would inflate a ledger whose whole
  // job is to stay comparable against the RunPod console.
  assert.equal(charged.length, 0);

  const ok = mockFetch({ "/runsync": () => json(COMPLETED) });
  const t2 = makeTranscriber({ config: configWith(), logger: silentLogger(), fetchImpl: ok.fetchImpl, ledger });
  await t2.transcribeFile(ogg, { mimetype: "audio/ogg" });
  assert.equal(charged.length, 1);
  assert.ok(charged[0] !== undefined && charged[0].completedAtMs >= charged[0].submittedAtMs);
});

void test("available() reports the endpoint's health and caches the probe", async () => {
  let probes = 0;
  const { fetchImpl } = mockFetch({
    "/health": () => {
      probes += 1;
      return json({ workers: { ready: 0 } });
    },
  });
  const t = makeTranscriber({
    config: configWith({ WHATSAPP_TRANSCRIBE_BACKENDS: "runpod" }),
    logger: silentLogger(),
    fetchImpl,
  });

  assert.equal(await t.available(), true);
  assert.equal(await t.available(), true);
  // `whatsapp_health` and the container healthcheck both poll this; an unmemoized probe would fire
  // a request per call. It no longer forks a process either — there is no binary left to fork.
  assert.equal(probes, 1);
});

void test("available() is false when nothing is configured", async () => {
  const t = makeTranscriber({
    config: loadConfig({ WHATSAPP_DATA_DIR: dir }),
    logger: silentLogger(),
    fetchImpl: mockFetch({}).fetchImpl,
  });
  assert.equal(await t.available(), false);
});

void test("an unconfigured chain fails with a message naming the lane and its options", async () => {
  const t = makeTranscriber({
    config: loadConfig({ WHATSAPP_DATA_DIR: dir }),
    logger: silentLogger(),
    fetchImpl: mockFetch({}).fetchImpl,
  });
  await assert.rejects(
    () => t.transcribeFile(ogg, { mimetype: "audio/ogg", lane: "background" }),
    (err: unknown) => {
      assert.ok(err instanceof TranscriptionError);
      assert.match(err.message, /background lane/);
      return true;
    },
  );
});

void test("an unknown backend name is dropped rather than taking the whole server down", () => {
  // This variable is the documented emergency lever — "the endpoint is down, flip it to mistral" —
  // and a deployment that refuses to boot because someone typed `runpood` mid-incident is worse
  // than one that runs on the half it understood.
  assert.deepEqual(configWith({ WHATSAPP_TRANSCRIBE_BACKENDS: "runpood,mistral" }).transcribeBackends, ["mistral"]);
  assert.deepEqual(configWith({ WHATSAPP_TRANSCRIBE_BACKENDS: "nonsense" }).transcribeBackends, ["runpod", "mistral"]);
  assert.deepEqual(configWith({ WHATSAPP_TRANSCRIBE_BACKENDS: "mistral,runpod" }).transcribeBackends, [
    "mistral",
    "runpod",
  ]);
});
