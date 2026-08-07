/**
 * The self-hosted endpoint: Voxtral Small 24B on an on-demand A100, through RunPod Serverless.
 *
 * ⚠️ **Two different hosts carry the same `/v2` prefix.** `api.runpod.ai` takes jobs — that is this
 * file — and `api.runpod.io` manages endpoints, which is the iac-platform reconciler's business.
 * Sending a job to the management host produces a 401 that reads exactly like a bad key, and the
 * hour that costs is why the constant below is named and commented rather than inlined.
 *
 * **`/runsync` first, then poll.** `runsync` returns the result inline when the job finishes inside
 * its window, which is the warm case and by far the common one. When it does not — a cold worker
 * loading 55 GB of weights takes long enough that this is guaranteed on the first request of a
 * quiet day — it answers `IN_QUEUE` or `IN_PROGRESS` with a job id, and the only thing to do is
 * poll `/status/<id>`. Both are the same request from a caller's point of view, which is why the
 * distinction lives entirely in here.
 *
 * The one distinction that *is* surfaced is **cold versus failed**. "The endpoint is spinning up,
 * try again in a minute" and "the endpoint is broken" call for opposite reactions from a caller,
 * and collapsing them into "transcription failed" is how an operator spends an afternoon debugging
 * a worker that was merely starting.
 */

import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { BackendError, type Backend, type TranscribeInput, type Transcribed } from "./types.js";

/** Jobs. **Not** `api.runpod.io`, which is the management API and rejects these with a 401. */
const JOBS_HOST = "https://api.runpod.ai/v2";

/** RunPod caps a request body at 10 MB; refusing a little early leaves room for the JSON envelope. */
export const MAX_PAYLOAD_BYTES = 7 * 1024 * 1024;

/** How long `/runsync` is given before falling back to polling. Well under RunPod's own window. */
const RUNSYNC_TIMEOUT_MS = 90_000;
const STATUS_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;

/** Poll backoff: quick at first because a warm job lands in seconds, then patient for a cold one. */
const POLL_MIN_MS = 1_000;
const POLL_MAX_MS = 8_000;

/** How long one `/health` answer stands in for the next. Keeps `whatsapp_health` polling cheap. */
const HEALTH_TTL_MS = 60_000;

type JobResponse = {
  id?: string;
  status?: string;
  output?: { text?: string; model?: string; language?: string | null; error?: string };
  error?: string;
};

/** RunPod's terminal states. Anything else is still running. */
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]);

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function makeRunpodBackend(config: Config, logger: Logger, fetchImpl: typeof fetch = fetch): Backend {
  const endpointId = config.runpodEndpointId;
  const apiKey = config.runpodApiKey;
  const base = `${JOBS_HOST}/${endpointId ?? ""}`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${apiKey ?? ""}` };

  let health: { at: number; probe: Promise<boolean> } | undefined;

  function configured(): boolean {
    return endpointId !== undefined && apiKey !== undefined;
  }

  function fail(message: string, retryable: boolean): BackendError {
    return new BackendError(message, "runpod", retryable);
  }

  async function post(path: string, body: unknown, timeoutMs: number): Promise<JobResponse> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // A timeout here is not a failure of the job — `runsync` simply did not finish inside its
      // window — but this function cannot tell that from a dead network, so it is retryable and the
      // caller decides.
      throw fail(`could not reach the RunPod endpoint: ${messageOf(err)}`, true);
    }
    if (res.status === 401 || res.status === 403) {
      // Not retryable, and worth naming: the overwhelmingly common cause is the wrong host, not a
      // wrong key. See the header comment.
      throw fail(
        `RunPod rejected the credentials (HTTP ${res.status}). Check that RUNPOD_API_KEY is a key ` +
          `for this endpoint — and that the request went to ${JOBS_HOST}, not api.runpod.io.`,
        false,
      );
    }
    if (!res.ok) {
      throw fail(`the RunPod endpoint returned HTTP ${res.status}`, res.status >= 500 || res.status === 429);
    }
    try {
      return (await res.json()) as JobResponse;
    } catch (err) {
      throw fail(`the RunPod endpoint returned a body that is not JSON: ${messageOf(err)}`, false);
    }
  }

  async function get(path: string, timeoutMs: number): Promise<JobResponse> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw fail(`could not reach the RunPod endpoint: ${messageOf(err)}`, true);
    }
    if (!res.ok) throw fail(`the RunPod endpoint returned HTTP ${res.status}`, res.status >= 500);
    return (await res.json()) as JobResponse;
  }

  /** Wait for a queued job, backing off, until it is terminal or the deadline passes. */
  async function poll(jobId: string, deadline: number): Promise<JobResponse> {
    let waitMs = POLL_MIN_MS;
    for (;;) {
      if (Date.now() >= deadline) {
        throw fail(
          `the RunPod job ${jobId} was still running after ${config.transcribeTimeoutMs}ms. A cold ` +
            "endpoint loading 55 GB of weights can take minutes; the job may still complete on its own.",
          true,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      waitMs = Math.min(POLL_MAX_MS, waitMs * 2);
      const body = await get(`/status/${jobId}`, STATUS_TIMEOUT_MS);
      if (body.status !== undefined && TERMINAL.has(body.status)) return body;
    }
  }

  /** Turn a terminal job into text, or into the most specific error its shape allows. */
  function readOutput(body: JobResponse): { text: string; model: string; language: string | null } {
    if (body.status !== "COMPLETED") {
      // A worker that was killed mid-job is retryable; one that reported an error decided something.
      const retryable = body.status === "TIMED_OUT" || body.status === "CANCELLED";
      throw fail(`the RunPod job ended ${body.status ?? "with no status"}: ${body.error ?? "no detail"}`, retryable);
    }
    const output = body.output;
    if (output === undefined) throw fail("the RunPod job completed with no output", false);
    if (output.error !== undefined) {
      // The worker's own refusal — a bad payload, an over-long recording, silence. Retrying it
      // would spend the same GPU seconds to be told the same thing.
      throw fail(`the transcription worker refused this recording: ${output.error}`, false);
    }
    const text = (output.text ?? "").trim();
    if (text === "") throw fail("the transcription worker found no speech in this recording", false);
    return { text, model: output.model ?? "runpod", language: output.language ?? null };
  }

  async function transcribe(input: TranscribeInput): Promise<Transcribed> {
    if (!configured()) {
      throw fail("WHATSAPP_RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY are not both set", false);
    }
    const audioBase64 = Buffer.from(input.data).toString("base64");
    if (audioBase64.length > MAX_PAYLOAD_BYTES) {
      throw fail(
        `this recording is ${Math.round(audioBase64.length / 1024 / 1024)} MB once encoded, over RunPod's ` +
          "10 MB request limit. A voice note never reaches that; a transcoded video does — lower " +
          "WHATSAPP_TRANSCRIBE_MAX_SECONDS or transcribe the audio track separately.",
        false,
      );
    }

    const payload = {
      input: {
        audio_base64: audioBase64,
        filename: input.filename,
        language: input.language,
        bias_terms: [...input.biasTerms],
      },
    };

    const submittedAtMs = Date.now();
    const deadline = submittedAtMs + config.transcribeTimeoutMs;

    // `runsync` timing out is the *expected* cold path rather than a failure — but it comes back
    // with no job id, so there is nothing to poll and nothing to do but let `post`'s retryable
    // error through. Deliberately not caught: the chain decides what a retryable failure means.
    let body = await post("/runsync", payload, Math.min(RUNSYNC_TIMEOUT_MS, config.transcribeTimeoutMs));

    if (body.status !== undefined && !TERMINAL.has(body.status)) {
      const jobId = body.id;
      if (jobId === undefined) throw fail(`the RunPod endpoint answered ${body.status} with no job id`, true);
      logger.info({ jobId, status: body.status }, "transcribe: the endpoint is cold; polling for the result");
      body = await poll(jobId, deadline);
    }

    const output = readOutput(body);
    return { ...output, submittedAtMs, completedAtMs: Date.now() };
  }

  async function probe(): Promise<boolean> {
    if (!configured()) return false;
    try {
      const res = await fetchImpl(`${base}/health`, { headers, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      return res.ok;
    } catch {
      // Swallowed on purpose: this is what `whatsapp_health` reports, and a probe that threw would
      // turn "transcription is unavailable" into "health checks are broken".
      return false;
    }
  }

  function healthy(): Promise<boolean> {
    const at = Date.now();
    // The promise is cached, not its value, so callers arriving mid-probe share one request. Safe
    // to keep past settlement because `probe` never rejects: there is no failure to make permanent.
    if (health !== undefined && at - health.at < HEALTH_TTL_MS) return health.probe;
    const started = probe();
    health = { at, probe: started };
    return started;
  }

  return { name: "runpod", configured, healthy, transcribe };
}
