/**
 * Voice notes into text: whisper.cpp, plus the lazy provisioning of the model it needs.
 *
 * Two very different problems live here, and only the second is interesting.
 *
 * 1. **Running whisper** is a subprocess call. It goes through `runTool` from `convert.ts` — the
 *    single spawn point in this package — so it inherits that module's timeout, output cap and
 *    distinguished failures rather than growing a second, subtly different copy of them.
 * 2. **Getting the model** is a 574 MB download over a link we do not control, onto a NAS volume we
 *    do not control either, and it is by far the most failure-prone step in the whole server. Every
 *    rule it obeys exists because the alternative fails *silently*: a resumed `.part` is a corrupt
 *    model whose whisper error is unintelligible, a truncated body looks installed forever, and a
 *    cached rejected promise makes one bad minute of network permanent for the life of the process.
 *    The download therefore never resumes, verifies its own length, keeps its errno, and clears its
 *    in-flight promise on every outcome. It also refuses a content encoding, so the length check is
 *    never surrendered to a proxy, and it reports a connection that dies mid-transfer as exactly
 *    that, naming how far it got — the alternative there is the operator reading the single word
 *    `terminated` and having no idea whether the network, the disk or the model name was at fault.
 *
 * The stall budget is per read, not per transfer. A total-duration cap would be the wrong shape: a
 * slow link legitimately needs many minutes for this file, while a connection that has delivered
 * nothing for a minute is dead no matter how long it is given.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { probeDuration, runTool, toWav16k } from "./convert.js";

export type Transcriber = {
  /** Ensure the model file exists locally, downloading it once. Throws `TranscriptionError`. */
  ensureModel: () => Promise<string>;
  /**
   * Transcribe an audio or video file.
   *
   * Throws `TranscriptionError` for anything this module decides — too long, no speech, no model —
   * and lets `ConversionError` through unwrapped when ffmpeg or whisper itself is what failed, since
   * that error already names the binary and the reader needs to know which layer broke.
   *
   * The length limit only applies to a file whose container declares a duration: when `probeDuration`
   * returns nothing, the gate is skipped and the recording is bounded solely by whisper's own budget
   * (the 60 s floor, since ten times an unknown duration is nothing), so such a file dies on that
   * timeout rather than running unbounded.
   */
  transcribeFile: (path: string) => Promise<string>;
  /**
   * Whether the whisper binary can run at all. Never throws.
   *
   * Memoized for `availabilityTtlMs`: this is what `wa_health` and Task 14's `/health` report, both
   * of which a model or a container healthcheck may poll freely, and an unmemoized probe forks a
   * process on every one of those calls. The answer is near-constant in practice — the binary is
   * baked into the image — so the TTL exists only so a repaired install is picked up without a
   * restart, not because the value is expected to change.
   */
  available: () => Promise<boolean>;
};

export type TranscriberDeps = {
  config: Config;
  logger: Logger;
  /** Injectable so tests can serve a model from memory instead of pulling 574 MB. */
  fetchImpl?: typeof fetch | undefined;
  /** Injectable for the same reason: a test cannot afford to wait out the real budget. */
  stallTimeoutMs?: number | undefined;
  /** How long an `available()` answer is reused. Injectable so a test can watch the memo expire. */
  availabilityTtlMs?: number | undefined;
};

/** Transcription could not be produced: no model, an over-long recording, or nothing said. */
export class TranscriptionError extends Error {
  override name = "TranscriptionError";
}

const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/** No bytes for this long means the connection is dead, however slow the link is supposed to be. */
const DEFAULT_STALL_TIMEOUT_MS = 60_000;
/** `--help` either answers immediately or the binary is broken; there is no slow success here. */
const HELP_TIMEOUT_MS = 10_000;
/**
 * How long one `--help` probe stands for the next answer.
 *
 * A minute is long enough that a health endpoint polled every few seconds forks once rather than
 * every time, and short enough that an operator who installs the missing binary sees the server
 * agree within a minute instead of after a restart.
 */
const DEFAULT_AVAILABILITY_TTL_MS = 60_000;
/**
 * Whisper's budget: ten times the recording, never less than a minute. Deliberately generous — the
 * NAS this deploys to has no GPU, and `large-v3-turbo` on a cold CPU is far slower than real time.
 */
const WHISPER_TIMEOUT_FACTOR = 10;
const WHISPER_MIN_TIMEOUT_MS = 60_000;

/**
 * Anything whisper.cpp puts in square brackets: `[00:00:00.000 --> 00:00:02.000]` timestamps and
 * `[MUSIQUE]` / `[BLANK_AUDIO]` non-speech tags alike. `-nt` already suppresses the timestamps, but
 * whisper.cpp's flags have moved between versions and a regex is cheaper than a version check.
 *
 * Excluding newlines from the span is what bounds the damage: a stray `[` in real speech costs its
 * own line at worst, instead of swallowing every word up to the next bracket anywhere in the text.
 */
const ANNOTATION_RE = /\[[^\]\n]*\]/g;

/** Exported for tests: strip whisper.cpp's `[00:00:00.000 --> …]` timestamps and join lines. */
export function cleanTranscript(raw: string): string {
  return raw.replace(ANNOTATION_RE, " ").replace(/\s+/g, " ").trim();
}

function errnoOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code: unknown = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn a filesystem failure during the download into an error that says which one it was.
 *
 * Exported for tests. ENOSPC is the case that matters — 574 MB onto a NAS volume that is nearly
 * full is a realistic first run, and "download failed" would send the reader to the network — and it
 * is also the one case a unit test cannot reach, since it cannot fill a disk. The test asserts this
 * mapping directly and proves the wiring with an EACCES download, which is reachable.
 */
export function modelWriteError(err: unknown, path: string): TranscriptionError {
  const code = errnoOf(err);
  if (code === "ENOSPC") {
    return new TranscriptionError(
      `ENOSPC: the volume holding ${path} is full, and the whisper model needs several hundred megabytes free`,
    );
  }
  return new TranscriptionError(
    `writing the whisper model to ${path} failed${code === undefined ? "" : ` (${code})`}: ${messageOf(err)}`,
  );
}

/**
 * A directory that could not be created, said as that rather than as a write failure.
 *
 * Both directories this module creates go through here. Routing either into `modelWriteError` would
 * report "writing the whisper model to <dir> failed" for a `mkdir`, sending the reader after a
 * download problem that does not exist — and for the scratch directory, after a download entirely.
 */
function dirCreateError(err: unknown, path: string, what: string): TranscriptionError {
  const code = errnoOf(err);
  return new TranscriptionError(
    `could not create the ${what} directory ${path}${code === undefined ? "" : ` (${code})`}: ${messageOf(err)}`,
  );
}

/** Resolve `p`, or reject once `ms` pass with nothing having happened. */
async function withStallTimeout<T>(p: Promise<T>, ms: number, url: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TranscriptionError(`the whisper model download stalled: no data for ${ms}ms from ${url}`));
    }, ms);
  });
  try {
    // `race` attaches handlers to both, so a rejection from `p` after the stall fires is still
    // handled and cannot surface as an unhandled rejection.
    return await Promise.race([p, stalled]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sent so rule 4 stays armed. Undici's default is `gzip, deflate`, and any encoding at all makes the
 * `Content-Length` comparison below meaningless — so the length check, which is the only thing
 * standing between a truncated body and a model that looks installed forever, would be surrendered
 * to whatever a proxy felt like doing. Asking for `identity` keeps it. The model is already
 * compressed, so nothing is lost by refusing a second pass over it.
 */
const IDENTITY_ENCODING = { "accept-encoding": "identity" } as const;

/**
 * The body length the server promised, when the comparison is meaningful.
 *
 * `Content-Length` describes the *encoded* body. Behind a proxy that gzips the response anyway —
 * ignoring the `identity` we asked for — fetch hands us the decoded bytes and the two numbers
 * legitimately differ, so comparing them there would reject a perfectly good download every single
 * time and the model would never install. This is the fallback, not the plan.
 */
function declaredBytes(res: Response): number | undefined {
  if (res.headers.get("content-encoding") !== null) return undefined;
  const raw = res.headers.get("content-length");
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function makeTranscriber(deps: TranscriberDeps): Transcriber {
  const { config, logger } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const availabilityTtlMs = deps.availabilityTtlMs ?? DEFAULT_AVAILABILITY_TTL_MS;

  const modelsDir = join(config.dataDir, "models");
  const modelPath = join(modelsDir, `ggml-${config.whisperModel}.bin`);
  const partPath = `${modelPath}.part`;
  const modelUrl = `${MODEL_BASE_URL}/ggml-${config.whisperModel}.bin`;
  const tmpDir = join(config.dataDir, "tmp");

  let inFlight: Promise<string> | undefined;
  /** The last `--help` probe and when it was started. `undefined` until the first call. */
  let availability: { startedAtMs: number; probe: Promise<boolean> } | undefined;

  /** Run one filesystem step, labelling any failure with the errno it carried. */
  async function fsStep<T>(path: string, step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (err) {
      throw modelWriteError(err, path);
    }
  }

  /**
   * Write every byte of `chunk`, looping over a short write, and report how many really landed.
   *
   * `write(2)` on a regular file is allowed to accept less than it was handed — classically when the
   * volume fills mid-write. Adding the chunk's length instead of the returned count would over-count:
   * with a `Content-Length` that fails safe, since the size check then calls the download truncated,
   * but *without* one it silently installs a short model, which is the exact outcome rule 4 exists to
   * prevent.
   */
  async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<number> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
      // A write that accepts nothing has no progress to wait for, and retrying it forever would
      // turn a full volume into a wedged tool call. Fail instead; `modelWriteError` labels it.
      if (bytesWritten <= 0) {
        throw new Error(`the volume accepted 0 of the ${chunk.byteLength - offset} bytes still to write`);
      }
      offset += bytesWritten;
    }
    return offset;
  }

  /**
   * One read from the body, with a mid-transfer failure told as what it is.
   *
   * This is the likeliest real failure of a 574 MB download, and undici reports it as a bare
   * `TypeError: terminated` or `Error: aborted` — a single word, to an operator who then has no idea
   * whether the network, the disk or the model name was at fault. It is also not a
   * `TranscriptionError`, which is what `ensureModel` documents that it throws. The stall budget
   * already produces its own `TranscriptionError` and passes through untouched.
   *
   * Takes the read as a thunk rather than the reader itself so the chunk type comes from the call
   * site: `getReader`'s overloads make any hand-written reader type resolve to the BYOB one.
   */
  async function readChunk<T>(read: () => Promise<T>, soFar: number): Promise<T> {
    try {
      return await withStallTimeout(read(), stallTimeoutMs, modelUrl);
    } catch (err) {
      if (err instanceof TranscriptionError) throw err;
      throw new TranscriptionError(
        `the whisper model transfer from ${modelUrl} was interrupted after ${soFar} bytes: ${messageOf(err)}. ` +
          `Nothing is resumed: the partial file is discarded and the next attempt restarts from zero.`,
      );
    }
  }

  /** Stream a response body into the `.part` file, returning the number of bytes written. */
  async function streamToPart(res: Response): Promise<number> {
    // Annotated rather than inferred: `Response.body` is typed `ReadableStream<any>`, and letting
    // that `any` reach the write loop would silence every check on the chunks themselves.
    const body: ReadableStream<Uint8Array> | null = res.body;
    if (body === null) throw new TranscriptionError(`${modelUrl} answered with no body at all`);

    const reader = body.getReader();
    let written = 0;
    try {
      // "wx" rather than "w" on purpose: it makes the stale-`.part` removal above load-bearing
      // instead of decorative. A leftover file fails the open loudly rather than being silently
      // truncated, so the never-resume rule cannot be quietly lost in a later edit.
      const handle = await fsStep(partPath, () => open(partPath, "wx"));
      try {
        for (;;) {
          const chunk = await readChunk(() => reader.read(), written);
          if (chunk.done) break;
          // Streamed, never buffered: the whole point is not to hold 574 MB in memory on a NAS.
          written += await fsStep(partPath, () => writeAll(handle, chunk.value));
        }
        await fsStep(partPath, () => handle.sync());
      } finally {
        // Swallowed on purpose: the explicit `sync` above is what surfaces a deferred write error,
        // so a throw from `close` here could only replace the real failure with a worse one.
        await handle.close().catch(() => undefined);
      }
    } finally {
      // Releases the socket when the loop exited early; a no-op once the body is exhausted.
      await reader.cancel().catch(() => undefined);
    }
    return written;
  }

  async function downloadModel(): Promise<string> {
    try {
      await mkdir(modelsDir, { recursive: true });
    } catch (err) {
      throw dirCreateError(err, modelsDir, "whisper model");
    }
    // Never resume. A `.part` here is the debris of a crash, and appending to it produces a model
    // that is corrupt in a way whisper reports unintelligibly.
    await unlink(partPath).catch(() => undefined);

    let res: Response;
    try {
      res = await doFetch(modelUrl, { headers: IDENTITY_ENCODING });
    } catch (err) {
      throw new TranscriptionError(`could not reach ${modelUrl} to download the whisper model: ${messageOf(err)}`);
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new TranscriptionError(
        `${modelUrl} returned HTTP ${res.status}, so the whisper model could not be downloaded. ` +
          `A 404 means WA_WHISPER_MODEL names a model this repository does not publish ` +
          `(it is currently ${JSON.stringify(config.whisperModel)}).`,
      );
    }

    const declared = declaredBytes(res);
    logger.info(
      { model: config.whisperModel, url: modelUrl, bytes: declared },
      "transcribe: downloading the whisper model",
    );

    let written: number;
    try {
      written = await streamToPart(res);
      if (declared !== undefined && written !== declared) {
        throw new TranscriptionError(
          `the whisper model download is truncated: ${modelUrl} promised ${declared} bytes and delivered ${written}`,
        );
      }
      await fsStep(modelPath, () => rename(partPath, modelPath));
    } catch (err) {
      // Leaving the `.part` behind would poison the next attempt's exclusive open.
      await unlink(partPath).catch(() => undefined);
      throw err;
    }

    logger.info({ model: config.whisperModel, path: modelPath, bytes: written }, "transcribe: whisper model ready");
    return modelPath;
  }

  async function ensureModel(): Promise<string> {
    const existing = await stat(modelPath).catch(() => undefined);
    if (existing?.isFile() === true && existing.size > 0) return modelPath;

    // One download for however many callers arrive during it. `finally` clears the slot on failure
    // as well as on success: a cached rejected promise would make every later call re-reject with
    // the first failure forever, and the retry would never happen.
    const pending = (inFlight ??= downloadModel().finally(() => {
      inFlight = undefined;
    }));
    return await pending;
  }

  async function transcribeFile(path: string): Promise<string> {
    const duration = await probeDuration(path);
    if (duration !== undefined && duration > config.whisperMaxSeconds) {
      throw new TranscriptionError(
        `this recording is ${duration.toFixed(1)}s long, over the ${config.whisperMaxSeconds}s transcription ` +
          `limit; raise WA_WHISPER_MAX_SECONDS to transcribe recordings this long`,
      );
    }

    const model = await ensureModel();
    try {
      await mkdir(tmpDir, { recursive: true });
    } catch (err) {
      throw dirCreateError(err, tmpDir, "transcription scratch");
    }
    const wav = join(tmpDir, `whisper-${randomUUID()}.wav`);
    const timeoutMs = Math.max(WHISPER_MIN_TIMEOUT_MS, Math.ceil((duration ?? 0) * WHISPER_TIMEOUT_FACTOR) * 1000);

    try {
      await toWav16k(path, wav);
      logger.info({ path, seconds: duration, timeoutMs }, "transcribe: running whisper");
      const { stdout } = await runTool(
        config.whisperBin,
        ["-m", model, "-f", wav, "-t", String(config.whisperThreads), "-nt", "-l", "auto"],
        timeoutMs,
      );
      const text = cleanTranscript(stdout.toString("utf8"));
      if (text === "") throw new TranscriptionError("whisper found no speech in this recording");
      logger.info({ path, chars: text.length }, "transcribe: whisper finished");
      return text;
    } finally {
      // The data volume is not a scratch disk: a wav left here on every failure fills it up.
      await unlink(wav).catch(() => undefined);
    }
  }

  async function probeWhisper(): Promise<boolean> {
    try {
      await runTool(config.whisperBin, ["--help"], HELP_TIMEOUT_MS);
      return true;
    } catch {
      // Deliberately swallowed: this is the readiness probe `wa_health` calls, and a probe that
      // throws would turn "transcription is unavailable" into "health checks are broken".
      return false;
    }
  }

  function available(): Promise<boolean> {
    const startedAtMs = Date.now();
    // The *promise* is what is cached, not its value, so callers arriving while a probe is still
    // running share it instead of each forking their own. Unlike `ensureModel`'s `inFlight`, caching
    // it past settlement is safe here precisely because `probeWhisper` never rejects: there is no
    // failure to make permanent, only a `false` that expires with the TTL like any other answer.
    if (availability !== undefined && startedAtMs - availability.startedAtMs < availabilityTtlMs) {
      return availability.probe;
    }
    const probe = probeWhisper();
    availability = { startedAtMs, probe };
    return probe;
  }

  return { ensureModel, transcribeFile, available };
}
