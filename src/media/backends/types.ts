/**
 * What a transcription backend has to provide, and what it hands back.
 *
 * Deliberately narrow. A backend takes bytes and returns text plus provenance; it does not read the
 * database, decide whether a recording is worth transcribing, or know that anything else exists.
 * The chain in `transcribe.ts` owns ordering and failover, and `budget.ts` owns cost — which is why
 * `Transcribed` carries timing rather than a price.
 */

import type { TranscribeBackend } from "../../config.js";

export type TranscribeInput = {
  /** The audio itself. Read once by the caller so a retry against a second backend costs no I/O. */
  data: Uint8Array;
  /** Used only for its extension, which is the format hint every backend passes to its decoder. */
  filename: string;
  /** `null` means let the model detect. See the language policy in `transcribe.ts`. */
  language: string | null;
  /** Biasing candidates. Honoured, ignored or truncated per backend; never required. */
  biasTerms: readonly string[];
};

export type Transcribed = {
  text: string;
  /** Exactly what produced this text, for `messages.transcript_model`. */
  model: string;
  language: string | null;
  /**
   * When the request left and when it came back, for the budget ledger.
   *
   * Wall time rather than the worker's own `infer_s`, because wall time is what RunPod bills
   * against — see `budget.ts`. Present on every backend so the chain does not have to special-case
   * which one answered.
   */
  submittedAtMs: number;
  completedAtMs: number;
};

/** A backend could not produce a transcript. `retryable` decides whether the chain waits or moves on. */
export class BackendError extends Error {
  override name = "BackendError";
  constructor(
    message: string,
    readonly backend: TranscribeBackend,
    /**
     * True for a timeout, a 5xx, or a cold endpoint — anything a second attempt might survive.
     * False for a rejected payload or a bad credential, where retrying only wastes the budget.
     */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export type Backend = {
  name: TranscribeBackend;
  /** Whether this backend has everything it needs to be tried at all. Never throws. */
  configured: () => boolean;
  /** A cheap liveness probe, for `whatsapp_health`. Never throws. */
  healthy: () => Promise<boolean>;
  transcribe: (input: TranscribeInput) => Promise<Transcribed>;
};
