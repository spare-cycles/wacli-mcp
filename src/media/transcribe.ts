/**
 * Voice notes into text, on a GPU that is somewhere else.
 *
 * This file used to run whisper.cpp in-process against a 574 MB model downloaded onto the data
 * volume, on a VPS with no GPU — minutes of CPU per recording, which is why the tool that called it
 * warned against asking for more than one at a time. All of that is gone: the model, the download
 * hardening it needed, and the ~250 lines that existed because a 574 MB transfer over a link we did
 * not control failed in ways that were silent rather than loud.
 *
 * What replaces it is a **chain of remote backends**, tried in configured order:
 *
 * 1. `runpod` — the self-hosted endpoint. Voxtral Small 24B, bf16, on an on-demand A100. The best
 *    French WER of anything self-hostable, and better than Mistral's own closed API model.
 * 2. `mistral` — the paid API, for when the endpoint is cold, saturated, or being redeployed.
 *
 * Three rules shape the chain.
 *
 * **The length gate runs first, before any bytes move.** It is the only refusal that costs nothing.
 *
 * **The lane decides which backends are eligible.** An interactive call — someone asked — may fall
 * back to a paid third party. A background call may not: paying a vendor to transcribe a recording
 * nobody asked about is not a trade worth making, and it is also the only path that would send
 * conversation audio to a model vendor without anyone deciding to.
 *
 * **Every attempt is recorded against the budget, whichever lane it came from.** The cap only stops
 * the background lane, but on-demand transcription costs the same dollars and a ledger that could
 * not see them would under-report exactly when someone was using the tool heavily.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Config, TranscribeBackend } from "../config.js";
import { makeMistralBackend } from "./backends/mistral.js";
import { MAX_PAYLOAD_BYTES, makeRunpodBackend } from "./backends/runpod.js";
import { BackendError, type Backend } from "./backends/types.js";
import type { BudgetLedger } from "./budget.js";
import { probeDuration, toOpus16k } from "./convert.js";

/** Which caller a transcription is for, and therefore what it is allowed to cost. */
export type Lane = "interactive" | "background";

export type TranscribeOptions = {
  /** The declared mimetype, which decides whether ffmpeg is needed at all. */
  mimetype?: string | undefined;
  /** Proper nouns worth spelling right. Sent to whichever backend answers; never required. */
  biasTerms?: readonly string[] | undefined;
  /** `null` or absent lets the model detect. See the language policy below. */
  language?: string | null | undefined;
  /** Defaults to `interactive`, the safe direction: only the background lane restricts backends. */
  lane?: Lane | undefined;
};

/** A transcript and the provenance that goes into `messages.transcript_model`. */
export type Transcript = { text: string; model: string; language: string | null };

export type Transcriber = {
  /**
   * Transcribe an audio or video file.
   *
   * Throws `TranscriptionError` for anything this module decides — too long, no backend configured,
   * every backend failed — with the individual backend failures folded into the message, because
   * "transcription failed" on its own tells an operator nothing about which half to look at.
   *
   * The length limit applies only to a file whose container declares a duration: when
   * `probeDuration` returns nothing the gate is skipped, and the recording is bounded instead by
   * the payload cap and the request timeout.
   */
  transcribeFile: (path: string, opts?: TranscribeOptions) => Promise<Transcript>;
  /**
   * Whether a transcript could be produced at all right now. Never throws.
   *
   * No longer forks a process — there is no binary. It is a configuration check plus a TTL-cached
   * probe of the endpoint, so `whatsapp_health` and the container's own healthcheck can poll it
   * freely.
   */
  available: () => Promise<boolean>;
};

export type TranscriberDeps = {
  config: Config;
  logger: Logger;
  /** Charged on every completed attempt. Optional so a test can run without a database. */
  ledger?: BudgetLedger | undefined;
  /** Injectable so tests can drive the whole chain without a network. */
  fetchImpl?: typeof fetch | undefined;
};

/** Transcription could not be produced: no backend, an over-long recording, or nothing said. */
export class TranscriptionError extends Error {
  override name = "TranscriptionError";
}

/**
 * Which backends a lane may use.
 *
 * `background` is `runpod` only, and not by omission — see the file header. Expressed as a filter
 * over the configured chain rather than a second list, so a deployment that reorders or disables a
 * backend does not have to remember to do it twice.
 */
const LANE_BACKENDS: Record<Lane, ReadonlySet<TranscribeBackend>> = {
  interactive: new Set<TranscribeBackend>(["runpod", "mistral"]),
  background: new Set<TranscribeBackend>(["runpod"]),
};

/**
 * Audio this size or smaller is sent exactly as WhatsApp delivered it.
 *
 * **A voice note needs no ffmpeg at all.** WhatsApp already sends 16 kbps mono Ogg/Opus, which is
 * both smaller and higher fidelity than anything a re-encode would produce, and the worker
 * normalises to 16 kHz mono on arrival regardless. Transcoding it would spend a process to make it
 * slightly worse. Only a video, or an audio file large enough to threaten the payload cap, is
 * converted.
 */
function needsTranscode(mimetype: string | undefined, bytes: number): boolean {
  if (bytes > MAX_PAYLOAD_BYTES * 0.7) return true;
  return !mimetype?.startsWith("audio/");
}

export function makeTranscriber(deps: TranscriberDeps): Transcriber {
  const { config, logger } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const byName: Record<TranscribeBackend, Backend> = {
    runpod: makeRunpodBackend(config, logger, fetchImpl),
    mistral: makeMistralBackend(config, logger, fetchImpl),
  };
  /** The configured chain, in order, minus anything that has no credentials to be tried with. */
  const chain = config.transcribeBackends.map((name) => byName[name]);
  const tmpDir = join(config.dataDir, "tmp");

  if (chain.every((backend) => !backend.configured())) {
    logger.warn(
      { backends: config.transcribeBackends },
      "transcribe: no backend is configured; whatsapp_transcribe will fail until one is",
    );
  }

  /** The bytes to send, transcoding into the scratch directory only when there is a reason to. */
  async function payloadOf(path: string, mimetype: string | undefined): Promise<{ data: Uint8Array; name: string }> {
    const info = await stat(path).catch(() => undefined);
    const bytes = info?.size ?? 0;
    if (!needsTranscode(mimetype, bytes)) {
      return { data: await readFile(path), name: "note.ogg" };
    }
    await mkdir(tmpDir, { recursive: true }).catch((err: unknown) => {
      throw new TranscriptionError(`could not create the transcription scratch directory ${tmpDir}: ${String(err)}`);
    });
    const out = join(tmpDir, `transcribe-${randomUUID()}.ogg`);
    try {
      await toOpus16k(path, out);
      return { data: await readFile(out), name: "note.ogg" };
    } finally {
      // The data volume is not a scratch disk: a leftover file on every failure fills it up.
      await unlink(out).catch(() => undefined);
    }
  }

  async function transcribeFile(path: string, opts: TranscribeOptions = {}): Promise<Transcript> {
    const duration = await probeDuration(path).catch(() => undefined);
    if (duration !== undefined && duration > config.transcribeMaxSeconds) {
      throw new TranscriptionError(
        `this recording is ${duration.toFixed(1)}s long, over the ${config.transcribeMaxSeconds}s ` +
          "transcription limit; raise WHATSAPP_TRANSCRIBE_MAX_SECONDS to transcribe recordings this long",
      );
    }

    const lane = opts.lane ?? "interactive";
    const allowed = LANE_BACKENDS[lane];
    const eligible = chain.filter((backend) => allowed.has(backend.name) && backend.configured());
    if (eligible.length === 0) {
      throw new TranscriptionError(
        `no transcription backend is available for the ${lane} lane. Configured: ` +
          `${config.transcribeBackends.join(", ")}; the ${lane} lane may use ${[...allowed].join(", ")}.`,
      );
    }

    const { data, name } = await payloadOf(path, opts.mimetype);
    const input = {
      data,
      filename: name,
      language: opts.language ?? null,
      biasTerms: opts.biasTerms ?? [],
    };

    const failures: string[] = [];
    for (const backend of eligible) {
      try {
        const result = await backend.transcribe(input);
        // Charged whichever backend answered and whichever lane asked. Only RunPod's wall time is
        // really billed by the second, but the ledger's own cold-burst rule is what turns that into
        // a number — see `budget.ts`.
        if (backend.name === "runpod") {
          deps.ledger?.record({ submittedAtMs: result.submittedAtMs, completedAtMs: result.completedAtMs });
        }
        logger.info(
          { backend: backend.name, model: result.model, chars: result.text.length, lane },
          "transcribe: finished",
        );
        return { text: result.text, model: result.model, language: result.language };
      } catch (err) {
        if (!(err instanceof BackendError)) throw err;
        failures.push(`${err.backend}: ${err.message}`);
        logger.warn({ backend: err.backend, retryable: err.retryable, lane }, "transcribe: a backend failed");
      }
    }

    // Every failure, not just the last: with a chain, the last one is usually the least informative
    // — "MISTRAL_API_KEY is not set" tells an operator nothing about why the endpoint refused.
    throw new TranscriptionError(`every transcription backend failed. ${failures.join(" | ")}`);
  }

  async function available(): Promise<boolean> {
    for (const backend of chain) {
      if (backend.configured() && (await backend.healthy())) return true;
    }
    return false;
  }

  return { transcribeFile, available };
}
