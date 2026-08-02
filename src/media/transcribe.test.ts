/**
 * What is and is not exercised here.
 *
 * **whisper.cpp itself is the one gap.** The real binary is not present in this environment and the
 * model it wants is 574 MB, so `config.whisperBin` points at a shell stub that records its argv and
 * prints a canned transcript. That still covers everything this module owns — the duration gate, the
 * wav conversion, the argv it assembles, the cleaning of stdout, the temp-file cleanup — and leaves
 * only whisper's own transcription quality to the manual smoke script in Task 15.
 *
 * **The model download is covered in full.** `fetchImpl` exists precisely so the network can be a
 * few bytes in memory, so every rule the download has to obey is a test below: a stale `.part` is
 * discarded rather than resumed, a non-2xx names the knob, a stall fails while a merely slow
 * transfer does not, a body that dies mid-transfer says so and says how far it got, a truncated body
 * is caught by `Content-Length` — which the request keeps armed by asking for `identity` — a write
 * error keeps its errno, a failure does not poison the next call, and concurrent callers download
 * once.
 *
 * One rule is implemented but not observable from here: the write loop that tolerates a short
 * `write(2)`. A regular file cannot be made to accept less than it was given on demand, and the only
 * way to force it would be to inject the file handle — a production seam that exists for no other
 * reason. It is stated rather than silently missing.
 *
 * The single exception is ENOSPC *end to end*: a unit test cannot fill a volume. Its message is
 * asserted through `modelWriteError`, and an EACCES download proves that mapper is really wired into
 * the download path rather than sitting unused beside it.
 *
 * ffmpeg and ffprobe run for real, as in `convert.test.ts`.
 */

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { loadConfig, type Config } from "../config.js";
import { cleanTranscript, makeTranscriber, modelWriteError, TranscriptionError } from "./transcribe.js";

const run = promisify(execFile);

const root = mkdtempSync(join(tmpdir(), "wa-transcribe-"));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const stubDir = join(root, "stubs");
const wav = join(root, "two-seconds.wav");

const MODEL = "tiny-test";
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL}.bin`;
const MODEL_BYTES = Buffer.from("ggml fake model bytes, not really 574 MB");

before(async () => {
  mkdirSync(stubDir, { recursive: true });
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", wav]);
});

// --- harness ----------------------------------------------------------------------------------

let seq = 0;

/** A fresh, empty data directory per test, so no test can see another's models or temp files. */
function freshDataDir(): string {
  seq += 1;
  const dir = join(root, `data-${seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function configFor(dataDir: string, extra: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({ WA_DATA_DIR: dataDir, WA_WHISPER_MODEL: MODEL, ...extra });
}

type Entry = { level: string; obj: Record<string, unknown>; msg: string };

/** A logger that records instead of printing, so a test can assert what was reported and with what. */
function captureLogger(): { logger: Logger; entries: Entry[] } {
  const entries: Entry[] = [];
  const record =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      entries.push({ level, obj: (obj ?? {}) as Record<string, unknown>, msg: msg ?? "" });
    };
  const logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  } as unknown as Logger;
  return { logger, entries };
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A `fetch` that never touches the network, recording the calls it was asked to make. */
function stubFetch(handler: (url: string) => Response): {
  impl: typeof fetch;
  urls: string[];
  headers: Headers[];
} {
  const urls: string[] = [];
  const headers: Headers[] = [];
  const impl: typeof fetch = (input, init) => {
    urls.push(urlOf(input));
    headers.push(new Headers(init?.headers));
    return Promise.resolve(handler(urlOf(input)));
  };
  return { impl, urls, headers };
}

/** A body that emits `chunks` one at a time, optionally pausing `gapMs` before each. */
function streamOf(chunks: readonly Uint8Array[], gapMs = 0): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = chunks[next];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      next += 1;
      if (gapMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, gapMs));
      controller.enqueue(chunk);
    },
  });
}

/**
 * A body that delivers `chunks` and then dies, the way a dropped connection does mid-transfer.
 *
 * This is the failure a 574 MB download actually has, and until this helper existed no test could
 * produce it: `streamOf` only ever ends cleanly, so an error escaping the read loop was invisible.
 * With no chunks it errors on the very first read; with some, after they have been written.
 */
function streamThenError(chunks: readonly Uint8Array[], err: Error): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next];
      if (chunk === undefined) {
        controller.error(err);
        return;
      }
      next += 1;
      controller.enqueue(chunk);
    },
  });
}

/** Whatever the `Response` constructor accepts as a body; `BodyInit` is not a Node global. */
type ResponseBody = ConstructorParameters<typeof Response>[0];

/** A body that accepts the connection and then never delivers a single byte. */
function stalledStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      // Deliberately empty: no enqueue, no close. Every read stays pending forever.
    },
  });
}

function okResponse(body: ResponseBody, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers });
}

function modelPathIn(dataDir: string): string {
  return join(dataDir, "models", `ggml-${MODEL}.bin`);
}

function writeStub(name: string, script: string): string {
  const path = join(stubDir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return path;
}

function tmpEntries(dataDir: string): string[] {
  const dir = join(dataDir, "tmp");
  return existsSync(dir) ? readdirSync(dir) : [];
}

/**
 * The two tests below deny themselves write access with mode `0555`, which does not constrain uid 0:
 * root writes into a read-only directory happily, so they would report a failure that says nothing
 * about the code. Nothing here runs as root today, but a root container running `pnpm test` would.
 * Skipped rather than deleted — the coverage is real under every uid that the permission bits apply
 * to, which is every uid this deploys under.
 */
const rootSkip: { skip?: string } = {
  ...(process.getuid?.() === 0 ? { skip: "mode 0555 does not deny writes to uid 0" } : {}),
};

/** The error `p` rejects with. Fails the test if it resolves instead. */
async function rejectionOf(p: Promise<unknown>): Promise<Error> {
  const outcome: unknown = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  assert.ok(outcome instanceof Error, `expected a rejection, got ${String(outcome)}`);
  return outcome;
}

// --- cleanTranscript --------------------------------------------------------------------------

void test("cleanTranscript strips timestamps and joins lines", () => {
  const raw = [
    "[00:00:00.000 --> 00:00:03.000]   Bonjour, comment ça va ?",
    "[00:00:03.000 --> 00:00:05.500]   Très bien merci.",
  ].join("\n");
  assert.equal(cleanTranscript(raw), "Bonjour, comment ça va ? Très bien merci.");
});

void test("cleanTranscript drops whisper's non-speech annotations and blank lines", () => {
  const raw = "[00:00:00.000 --> 00:00:02.000]   [MUSIQUE]\n\n[00:00:02.000 --> 00:00:04.000]   Salut.";
  assert.equal(cleanTranscript(raw), "Salut.");
});

void test("cleanTranscript is a no-op on already-clean text", () => {
  assert.equal(cleanTranscript("Juste du texte."), "Juste du texte.");
});

void test("cleanTranscript collapses runs of whitespace", () => {
  assert.equal(cleanTranscript("a\n\n   b\t\tc"), "a b c");
});

void test("cleanTranscript keeps an unbalanced bracket from swallowing the rest of the transcript", () => {
  // A stray "[" with no closing bracket must cost at most its own line, never every word after it.
  assert.equal(cleanTranscript("Le prix est de 3 [euros\nEt la suite."), "Le prix est de 3 [euros Et la suite.");
});

// --- ensureModel: the happy path and the cache -------------------------------------------------

void test("ensureModel downloads the model once, logs both ends with byte counts, and then caches it", async () => {
  const dataDir = freshDataDir();
  const { logger, entries } = captureLogger();
  // Hugging Face does send a Content-Length, so the matching case is the realistic one to pin.
  const fetcher = stubFetch(() => okResponse(MODEL_BYTES, { "content-length": String(MODEL_BYTES.byteLength) }));
  const t = makeTranscriber({ config: configFor(dataDir), logger, fetchImpl: fetcher.impl });

  const path = await t.ensureModel();
  assert.equal(path, modelPathIn(dataDir));
  assert.deepEqual(readFileSync(path), MODEL_BYTES);
  assert.deepEqual(fetcher.urls, [MODEL_URL]);

  const started = entries.find((e) => e.msg.includes("downloading"));
  const finished = entries.find((e) => e.msg.includes("ready"));
  assert.ok(started !== undefined, "the start of a 574 MB download must be visible in the log");
  assert.equal(started.level, "info");
  assert.equal(started.obj["bytes"], MODEL_BYTES.byteLength);
  assert.ok(finished !== undefined, "completion must be logged too");
  assert.equal(finished.level, "info");
  assert.equal(finished.obj["bytes"], MODEL_BYTES.byteLength);

  // Second call: the file is on disk, so nothing is fetched again.
  assert.equal(await t.ensureModel(), path);
  assert.equal(fetcher.urls.length, 1);
});

void test("ensureModel returns a model already on disk without fetching anything", async () => {
  const dataDir = freshDataDir();
  mkdirSync(join(dataDir, "models"), { recursive: true });
  writeFileSync(modelPathIn(dataDir), MODEL_BYTES);

  const fetcher = stubFetch(() => okResponse(MODEL_BYTES));
  const t = makeTranscriber({ config: configFor(dataDir), logger: captureLogger().logger, fetchImpl: fetcher.impl });

  assert.equal(await t.ensureModel(), modelPathIn(dataDir));
  assert.deepEqual(fetcher.urls, []);
});

void test("ensureModel discards a stale .part rather than appending to it", async () => {
  const dataDir = freshDataDir();
  mkdirSync(join(dataDir, "models"), { recursive: true });
  const part = `${modelPathIn(dataDir)}.part`;
  writeFileSync(part, "half of a previous, crashed download");

  const fetcher = stubFetch(() => okResponse(MODEL_BYTES));
  const t = makeTranscriber({ config: configFor(dataDir), logger: captureLogger().logger, fetchImpl: fetcher.impl });

  const path = await t.ensureModel();
  assert.deepEqual(readFileSync(path), MODEL_BYTES, "the leftover bytes must not survive into the model");
  assert.equal(existsSync(part), false);
});

// --- ensureModel: the failure rules ------------------------------------------------------------

void test("a non-2xx download names the status, the URL and the env var that fixes it", async () => {
  const dataDir = freshDataDir();
  const fetcher = stubFetch(() => new Response("not found", { status: 404 }));
  const t = makeTranscriber({ config: configFor(dataDir), logger: captureLogger().logger, fetchImpl: fetcher.impl });

  const err = await rejectionOf(t.ensureModel());
  assert.ok(err instanceof TranscriptionError, `expected TranscriptionError, got ${err.name}`);
  assert.ok(err.message.includes("404"), `status missing from: ${err.message}`);
  assert.ok(err.message.includes(MODEL_URL), `URL missing from: ${err.message}`);
  assert.ok(err.message.includes("WA_WHISPER_MODEL"), `the knob to turn is missing from: ${err.message}`);
  assert.equal(existsSync(modelPathIn(dataDir)), false);
});

void test("a download that stalls fails on the stall budget and leaves no .part behind", async () => {
  const dataDir = freshDataDir();
  const fetcher = stubFetch(() => okResponse(stalledStream()));
  const t = makeTranscriber({
    config: configFor(dataDir),
    logger: captureLogger().logger,
    fetchImpl: fetcher.impl,
    stallTimeoutMs: 60,
  });

  const started = Date.now();
  await assert.rejects(() => t.ensureModel(), /stall/i);
  assert.ok(Date.now() - started < 5_000, "the stall budget must fire rather than wait for the transfer");
  assert.equal(existsSync(`${modelPathIn(dataDir)}.part`), false);
  assert.equal(existsSync(modelPathIn(dataDir)), false);
});

void test("a slow but progressing download is not cut off: the budget is per chunk, not total", async () => {
  const dataDir = freshDataDir();
  const chunks = [MODEL_BYTES.subarray(0, 10), MODEL_BYTES.subarray(10, 25), MODEL_BYTES.subarray(25)];
  const fetcher = stubFetch(() => okResponse(streamOf(chunks, 200)));
  const t = makeTranscriber({
    config: configFor(dataDir),
    logger: captureLogger().logger,
    fetchImpl: fetcher.impl,
    // Under the ~600 ms this transfer takes in total, so a total-duration cap would reject it — and
    // 2.25× the 200 ms gap, so the 250 ms of slack absorbs a scheduling hiccup on a suite that runs
    // ffmpeg concurrently across files. The ratio, not the absolute numbers, is what discriminates.
    stallTimeoutMs: 450,
  });

  assert.deepEqual(readFileSync(await t.ensureModel()), MODEL_BYTES);
});

void test("a connection dropped before the first byte is reported as an interrupted transfer", async () => {
  const dataDir = freshDataDir();
  // `TypeError: terminated` is verbatim what undici throws when the peer goes away mid-body. On its
  // own it reaches the operator as one unintelligible word, and it is not a `TranscriptionError`.
  const fetcher = stubFetch(() => okResponse(streamThenError([], new TypeError("terminated"))));
  const t = makeTranscriber({ config: configFor(dataDir), logger: captureLogger().logger, fetchImpl: fetcher.impl });

  const err = await rejectionOf(t.ensureModel());
  assert.ok(err instanceof TranscriptionError, `expected TranscriptionError, got ${err.name}: ${err.message}`);
  assert.match(err.message, /interrupted/i);
  assert.ok(err.message.includes("terminated"), `the underlying cause must survive: ${err.message}`);
  assert.ok(err.message.includes(MODEL_URL), `the URL must be named: ${err.message}`);
  assert.equal(existsSync(`${modelPathIn(dataDir)}.part`), false);
  assert.equal(existsSync(modelPathIn(dataDir)), false);
});

void test("a connection dropped mid-body names the bytes received, discards the .part, and retries clean", async () => {
  const dataDir = freshDataDir();
  const delivered = MODEL_BYTES.subarray(0, 17);
  let attempt = 0;
  const fetcher = stubFetch(() => {
    attempt += 1;
    return attempt === 1
      ? okResponse(streamThenError([delivered], new Error("aborted")))
      : okResponse(MODEL_BYTES, { "content-length": String(MODEL_BYTES.byteLength) });
  });
  const t = makeTranscriber({ config: configFor(dataDir), logger: captureLogger().logger, fetchImpl: fetcher.impl });

  const err = await rejectionOf(t.ensureModel());
  assert.ok(err instanceof TranscriptionError, `expected TranscriptionError, got ${err.name}: ${err.message}`);
  assert.ok(err.message.includes(String(delivered.byteLength)), `how far it got must be named: ${err.message}`);
  // The rule is never-resume, so the operator has to be told the next attempt starts over.
  assert.match(err.message, /restart|from zero|from the beginning/i);
  assert.equal(existsSync(`${modelPathIn(dataDir)}.part`), false, "the partial bytes must not survive the failure");

  // And the retry is clean: a fresh download, not an append to what the dropped one left behind.
  assert.deepEqual(readFileSync(await t.ensureModel()), MODEL_BYTES);
  assert.equal(fetcher.urls.length, 2);
});

void test("a truncated body is caught by the Content-Length check instead of being installed", async () => {
  const dataDir = freshDataDir();
  const fetcher = stubFetch(() => okResponse(MODEL_BYTES, { "content-length": String(MODEL_BYTES.byteLength + 500) }));
  const t = makeTranscriber({ config: configFor(dataDir), logger: captureLogger().logger, fetchImpl: fetcher.impl });

  await assert.rejects(() => t.ensureModel(), /truncated/i);
  assert.equal(existsSync(modelPathIn(dataDir)), false, "a short model must never be renamed into place");
  assert.equal(existsSync(`${modelPathIn(dataDir)}.part`), false);
});

void test("the request asks for an identity encoding, so the length check is not surrendered", async () => {
  const dataDir = freshDataDir();
  const fetcher = stubFetch(() => okResponse(MODEL_BYTES, { "content-length": String(MODEL_BYTES.byteLength) }));
  const t = makeTranscriber({ config: configFor(dataDir), logger: captureLogger().logger, fetchImpl: fetcher.impl });

  await t.ensureModel();
  // Undici defaults to `gzip, deflate`; any encoding at all disarms rule 4, and the skip below is
  // meant to be the fallback for a proxy that ignores this header, not the normal case.
  assert.equal(fetcher.headers[0]?.get("accept-encoding"), "identity");
});

void test("a compressed response is not judged against its Content-Length", async () => {
  const dataDir = freshDataDir();
  // Content-Length describes the *encoded* body, so comparing it to the decoded byte count would
  // reject a perfectly good download behind a gzipping proxy, forever.
  const fetcher = stubFetch(() => okResponse(MODEL_BYTES, { "content-length": "7", "content-encoding": "gzip" }));
  const t = makeTranscriber({ config: configFor(dataDir), logger: captureLogger().logger, fetchImpl: fetcher.impl });

  assert.deepEqual(readFileSync(await t.ensureModel()), MODEL_BYTES);
});

void test("a models directory that cannot be created says so, rather than blaming the download", rootSkip, async () => {
  const dataDir = freshDataDir();
  await chmod(dataDir, 0o555);
  try {
    const fetcher = stubFetch(() => okResponse(MODEL_BYTES));
    const t = makeTranscriber({ config: configFor(dataDir), logger: captureLogger().logger, fetchImpl: fetcher.impl });

    const err = await rejectionOf(t.ensureModel());
    assert.ok(err instanceof TranscriptionError, `expected TranscriptionError, got ${err.name}`);
    // "writing the whisper model to <dir> failed" would send the reader after a transfer that never
    // started; the directory is the thing that failed.
    assert.match(err.message, /could not create the whisper model directory/);
    assert.ok(err.message.includes(join(dataDir, "models")), `the path must be named: ${err.message}`);
    assert.ok(err.message.includes("EACCES"), `the errno must survive: ${err.message}`);
    assert.deepEqual(fetcher.urls, [], "nothing is fetched when there is nowhere to put it");
  } finally {
    await chmod(dataDir, 0o755);
  }
});

void test("a write failure keeps its errno rather than becoming a generic download failure", rootSkip, async () => {
  const dataDir = freshDataDir();
  const models = join(dataDir, "models");
  mkdirSync(models, { recursive: true });
  await chmod(models, 0o555);
  try {
    const fetcher = stubFetch(() => okResponse(MODEL_BYTES));
    const t = makeTranscriber({ config: configFor(dataDir), logger: captureLogger().logger, fetchImpl: fetcher.impl });

    const err = await rejectionOf(t.ensureModel());
    // A `TranscriptionError` rather than the raw fs error is what proves `modelWriteError` ran:
    // it is the same mapper the untestable ENOSPC case goes through.
    assert.ok(err instanceof TranscriptionError, `expected TranscriptionError, got ${err.name}`);
    assert.ok(err.message.includes("EACCES"), `the errno must survive: ${err.message}`);
    assert.ok(err.message.includes(`${modelPathIn(dataDir)}.part`), `the path must be named: ${err.message}`);
  } finally {
    await chmod(models, 0o755);
  }
});

void test("modelWriteError reports ENOSPC as itself", () => {
  const err = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  const mapped = modelWriteError(err, "/data/wa/models/ggml-x.bin.part");
  assert.ok(mapped instanceof TranscriptionError);
  assert.ok(mapped.message.includes("ENOSPC"), `the errno must survive: ${mapped.message}`);
  assert.ok(/full/i.test(mapped.message), `and be explained: ${mapped.message}`);
  assert.ok(mapped.message.includes("/data/wa/models/ggml-x.bin.part"));
});

void test("a failed download does not poison the next call", async () => {
  const dataDir = freshDataDir();
  let attempt = 0;
  const fetcher = stubFetch(() => {
    attempt += 1;
    return attempt === 1 ? new Response("boom", { status: 500 }) : okResponse(MODEL_BYTES);
  });
  const t = makeTranscriber({ config: configFor(dataDir), logger: captureLogger().logger, fetchImpl: fetcher.impl });

  await assert.rejects(() => t.ensureModel(), /500/);
  // A cached rejected promise would make this reject with the 500 forever.
  assert.deepEqual(readFileSync(await t.ensureModel()), MODEL_BYTES);
  assert.equal(fetcher.urls.length, 2);
});

void test("concurrent ensureModel calls share one download", async () => {
  const dataDir = freshDataDir();
  const fetcher = stubFetch(() => okResponse(streamOf([MODEL_BYTES], 30)));
  const t = makeTranscriber({ config: configFor(dataDir), logger: captureLogger().logger, fetchImpl: fetcher.impl });

  const [a, b] = await Promise.all([t.ensureModel(), t.ensureModel()]);
  assert.equal(a, modelPathIn(dataDir));
  assert.equal(b, a);
  assert.equal(fetcher.urls.length, 1, "two callers must not each pull 574 MB");
});

// --- transcribeFile ----------------------------------------------------------------------------

void test("a recording over the limit is refused, naming the limit, the duration and the knob", async () => {
  const dataDir = freshDataDir();
  const fetcher = stubFetch(() => okResponse(MODEL_BYTES));
  const t = makeTranscriber({
    config: configFor(dataDir, { WA_WHISPER_MAX_SECONDS: "1" }),
    logger: captureLogger().logger,
    fetchImpl: fetcher.impl,
  });

  const err = await rejectionOf(t.transcribeFile(wav));
  assert.ok(err instanceof TranscriptionError, `expected TranscriptionError, got ${err.name}`);
  assert.match(err.message, /^this recording is \d+(\.\d)?s long/);
  assert.ok(/\b1s\b/.test(err.message), `the limit must be named: ${err.message}`);
  assert.ok(err.message.includes("WA_WHISPER_MAX_SECONDS"), `the knob must be named: ${err.message}`);
  assert.deepEqual(fetcher.urls, [], "a rejected recording must not trigger a 574 MB download");
});

void test("transcribeFile runs whisper with the expected argv and returns cleaned text", async () => {
  const dataDir = freshDataDir();
  const args = join(root, "argv-ok.txt");
  const bin = writeStub(
    "whisper-ok",
    // The redirection target is quoted: a TMPDIR with a space in it must break no stub here.
    `printf '%s\\n' "$@" > "${args}"\nprintf '[00:00:00.000 --> 00:00:02.000]   Bonjour le monde.\\n'`,
  );
  const config = configFor(dataDir, { WA_WHISPER_BIN: bin });
  const fetcher = stubFetch(() => okResponse(MODEL_BYTES));
  const t = makeTranscriber({ config, logger: captureLogger().logger, fetchImpl: fetcher.impl });

  assert.equal(await t.transcribeFile(wav), "Bonjour le monde.");

  const argv = readFileSync(args, "utf8").trim().split("\n");
  const flag = (name: string): string | undefined => argv[argv.indexOf(name) + 1];
  assert.equal(flag("-m"), modelPathIn(dataDir), "whisper must be pointed at the provisioned model");
  assert.equal(flag("-t"), String(config.whisperThreads));
  assert.equal(flag("-l"), "auto");
  assert.ok(argv.includes("-nt"), "timestamps must be suppressed at the source too");

  const input = flag("-f");
  assert.ok(input !== undefined, "whisper must be given an input file");
  assert.ok(input.startsWith(join(dataDir, "tmp")), `the temp wav belongs under the data dir, got ${input}`);
  assert.ok(input.endsWith(".wav"), "whisper only accepts a wav");
  assert.deepEqual(tmpEntries(dataDir), [], "the temp wav must be gone after a success");
});

void test("the temp wav is removed even when whisper fails", async () => {
  const dataDir = freshDataDir();
  const bin = writeStub("whisper-fail", `echo "failed to load model" >&2\nexit 1`);
  const fetcher = stubFetch(() => okResponse(MODEL_BYTES));
  const t = makeTranscriber({
    config: configFor(dataDir, { WA_WHISPER_BIN: bin }),
    logger: captureLogger().logger,
    fetchImpl: fetcher.impl,
  });

  await assert.rejects(() => t.transcribeFile(wav));
  assert.deepEqual(tmpEntries(dataDir), [], "a failed run must not leak a wav into the data volume");
});

void test("whisper output with no speech in it raises TranscriptionError", async () => {
  const dataDir = freshDataDir();
  const bin = writeStub("whisper-silent", `printf '[00:00:00.000 --> 00:00:02.000]   [BLANK_AUDIO]\\n'`);
  const fetcher = stubFetch(() => okResponse(MODEL_BYTES));
  const t = makeTranscriber({
    config: configFor(dataDir, { WA_WHISPER_BIN: bin }),
    logger: captureLogger().logger,
    fetchImpl: fetcher.impl,
  });

  await assert.rejects(() => t.transcribeFile(wav), /no speech/i);
  assert.deepEqual(tmpEntries(dataDir), []);
});

void test("a missing whisper binary fails loudly instead of hanging", async () => {
  const dataDir = freshDataDir();
  const fetcher = stubFetch(() => okResponse(MODEL_BYTES));
  const t = makeTranscriber({
    config: configFor(dataDir, { WA_WHISPER_BIN: "wa-mcp-no-such-whisper" }),
    logger: captureLogger().logger,
    fetchImpl: fetcher.impl,
  });

  await assert.rejects(() => t.transcribeFile(wav), /wa-mcp-no-such-whisper/);
  assert.deepEqual(tmpEntries(dataDir), []);
});

// --- available ---------------------------------------------------------------------------------

void test("available() probes with --help and nothing else, and is true when that exits cleanly", async () => {
  const args = join(root, "argv-help.txt");
  const bin = writeStub("whisper-help", `printf '%s\\n' "$@" > "${args}"\nexit 0`);
  const t = makeTranscriber({
    config: configFor(freshDataDir(), { WA_WHISPER_BIN: bin }),
    logger: captureLogger().logger,
  });
  assert.equal(await t.available(), true);
  // Asserted rather than assumed: an `exit 0` stub that ignores its argv passes just as happily
  // against a probe that runs the binary with no arguments at all — or with `-h`, or a transcription.
  assert.deepEqual(readFileSync(args, "utf8").trim().split("\n"), ["--help"]);
});

void test("available() is false — never a throw — when the binary is missing", async () => {
  const t = makeTranscriber({
    config: configFor(freshDataDir(), { WA_WHISPER_BIN: "wa-mcp-no-such-whisper" }),
    logger: captureLogger().logger,
  });
  assert.equal(await t.available(), false);
});

void test("available() is false when the binary is present but broken", async () => {
  const bin = writeStub("whisper-broken", `echo "libggml.so.0: cannot open shared object file" >&2\nexit 127`);
  const t = makeTranscriber({
    config: configFor(freshDataDir(), { WA_WHISPER_BIN: bin }),
    logger: captureLogger().logger,
  });
  assert.equal(await t.available(), false);
});

void test("available() forks once per TTL, however often it is asked", async () => {
  // `wa_health` is a tool a model may poll, and Task 14's `/health` is a container healthcheck that
  // runs on a timer — an unmemoized probe forks whisper on every one of those calls.
  const log = join(root, "help-calls.txt");
  const bin = writeStub("whisper-counted", `echo run >> "${log}"\nexit 0`);
  const t = makeTranscriber({
    config: configFor(freshDataDir(), { WA_WHISPER_BIN: bin }),
    logger: captureLogger().logger,
    availabilityTtlMs: 10_000,
  });

  assert.equal(await t.available(), true);
  assert.equal(await t.available(), true);
  // Concurrent callers too: the promise is cached, not just its settled value.
  assert.deepEqual(await Promise.all([t.available(), t.available()]), [true, true]);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1, "one probe covers the whole TTL");
});

void test("the availability memo expires, so a repaired install is picked up without a restart", async () => {
  const log = join(root, "help-calls-expiry.txt");
  const bin = writeStub("whisper-counted-expiry", `echo run >> "${log}"\nexit 0`);
  const t = makeTranscriber({
    config: configFor(freshDataDir(), { WA_WHISPER_BIN: bin }),
    logger: captureLogger().logger,
    availabilityTtlMs: 1,
  });

  assert.equal(await t.available(), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await t.available(), true);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2, "past the TTL the binary is probed again");
});
