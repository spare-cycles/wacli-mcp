/**
 * The paid fallback: Mistral's hosted `voxtral-mini-latest`.
 *
 * Present so that a cold, saturated or mid-redeploy endpoint does not mean "no transcript". It is
 * the *worse* option on quality — the self-hosted Voxtral Small takes 4.03 FLEURS-fr against the
 * closed transcribe model's 4.32 — and it is the only path in this server that sends conversation
 * audio to a model vendor. Both facts are why it is second in the chain and never first, and why
 * the background lane refuses it outright: paying a third party to transcribe a note nobody asked
 * about is not a trade worth making.
 *
 * Two API quirks are recorded here rather than rediscovered:
 *
 * 1. **`context_bias` is documented as optimized for English**, on a workload that is 98 % French.
 *    The terms are still sent — they cost nothing and proper nouns are where casual-speech WER
 *    accumulates — but nothing in this design assumes they help. The bench measures it.
 * 2. **`timestamp_granularities` is incompatible with `language`.** Nothing here wants timestamps,
 *    so the conflict is inert; it is written down because the obvious future request ("can we get
 *    word timings?") runs straight into it.
 */

import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { BackendError, type Backend, type TranscribeInput, type Transcribed } from "./types.js";

const URL = "https://api.mistral.ai/v1/audio/transcriptions";

/** The hosted transcription model. `-latest` on purpose: Mistral improves it and we want that. */
const MODEL = "voxtral-mini-latest";

/** Mistral's own cap on the biasing list. Enforced here so a longer list is truncated, not rejected. */
const MAX_BIAS_TERMS = 100;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function makeMistralBackend(config: Config, logger: Logger, fetchImpl: typeof fetch = fetch): Backend {
  const apiKey = config.mistralApiKey;

  function configured(): boolean {
    return apiKey !== undefined;
  }

  function fail(message: string, retryable: boolean): BackendError {
    return new BackendError(message, "mistral", retryable);
  }

  async function transcribe(input: TranscribeInput): Promise<Transcribed> {
    if (apiKey === undefined) throw fail("MISTRAL_API_KEY is not set", false);

    const form = new FormData();
    // `Blob` with the original filename: the extension is the only format hint the API gets, and
    // WhatsApp's Ogg/Opus is not something it should have to sniff.
    form.append("file", new Blob([input.data]), input.filename);
    form.append("model", MODEL);
    if (input.language !== null) form.append("language", input.language);
    if (input.biasTerms.length > 0) {
      form.append("context_bias", JSON.stringify(input.biasTerms.slice(0, MAX_BIAS_TERMS)));
    }

    const submittedAtMs = Date.now();
    let res: Response;
    try {
      res = await fetchImpl(URL, {
        method: "POST",
        // No `content-type`: `fetch` sets it from the FormData, boundary and all. Setting it by
        // hand produces a multipart body the server cannot parse, which surfaces as a bare 400.
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(config.transcribeTimeoutMs),
      });
    } catch (err) {
      throw fail(`could not reach the Mistral API: ${messageOf(err)}`, true);
    }

    if (!res.ok) {
      // 429 and 5xx are worth a second attempt; a 401 or a 413 has already been decided.
      const retryable = res.status === 429 || res.status >= 500;
      throw fail(`the Mistral API returned HTTP ${res.status}`, retryable);
    }

    let body: { text?: string; language?: string | null };
    try {
      body = (await res.json()) as { text?: string; language?: string | null };
    } catch (err) {
      throw fail(`the Mistral API returned a body that is not JSON: ${messageOf(err)}`, false);
    }

    const text = (body.text ?? "").trim();
    if (text === "") throw fail("the Mistral API found no speech in this recording", false);
    logger.debug({ chars: text.length }, "transcribe: the Mistral fallback answered");
    return {
      text,
      model: MODEL,
      language: body.language ?? input.language,
      submittedAtMs,
      completedAtMs: Date.now(),
    };
  }

  function healthy(): Promise<boolean> {
    // No probe. Mistral publishes no free health endpoint, and the cheapest real request is a paid
    // transcription — so "the key is set" is the only honest answer this backend can give without
    // spending money to say it.
    return Promise.resolve(configured());
  }

  return { name: "mistral", configured, healthy, transcribe };
}
