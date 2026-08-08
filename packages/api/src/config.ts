export type NtfyConfig = { baseUrl: string; topic: string; infoTopic: string; token: string };

/**
 * Which transcription backends to try, in order.
 *
 * `runpod` is the self-hosted endpoint — Voxtral Small 24B on an on-demand A100, the best French
 * WER of anything self-hostable. `mistral` is the paid API, kept as a fallback for when the
 * endpoint is cold, out of capacity, or being redeployed.
 *
 * Order is the whole configuration: `runpod,mistral` is the normal setting, `mistral` alone is the
 * documented emergency lever when the endpoint is down, and `runpod` alone is what a deployment
 * that refuses to send audio to a model vendor at all would use.
 */
export const TRANSCRIBE_BACKENDS = ["runpod", "mistral"] as const;
export type TranscribeBackend = (typeof TRANSCRIBE_BACKENDS)[number];

/**
 * Everything that governs transcribing voice notes as they arrive rather than when asked.
 *
 * The point of the whole feature is that `whatsapp_transcribe` answers instantly from cache, so a
 * cold GPU is never in the user's way. The cost of it is that some recordings nobody ever reads get
 * transcribed anyway — which is why every field below is a bound on that waste, and why the feature
 * is off unless a deployment turns it on.
 */
export type AutoTranscribeConfig = {
  enabled: boolean;
  /** Older than this and it is history, not news. Bounds the offline drain after a long outage. */
  maxAgeSeconds: number;
  /** Independent of the dollar cap, so a pricing mistake cannot become an unbounded burst. */
  maxPerHour: number;
  /** Evaluated against the stored `duration_s`, before the file is downloaded. */
  maxSeconds: number;
  /** A chat counts as mine if I sent anything in it this recently. */
  chatWindowDays: number;
  /** Chat ids that bypass the window check entirely. Empty means the window is the only rule. */
  allowlist: readonly string[];
  /**
   * A hard stop, on deliberately over-counted spend. Breaching it stops the background lane for the
   * rest of the day; on-demand transcription keeps working.
   */
  dailyBudgetUsd: number;
  /**
   * How many background transcriptions may be in flight. Below the endpoint's worker ceiling on
   * purpose, so an interactive call always has a worker to land on.
   */
  concurrency: number;
};

export type Config = {
  dataDir: string; // WHATSAPP_DATA_DIR, default "/data/whatsapp"
  dbPath: string; // `${dataDir}/whatsapp.db`
  mediaDir: string; // WHATSAPP_MEDIA_DIR, default `${dataDir}/media`
  phoneNumber: string | undefined; // WHATSAPP_PHONE_NUMBER, digits only, 8..15
  port: number; // PORT, default 8080, clamped [1, 65535]
  httpPath: string; // MCP_HTTP_PATH, default "/mcp"
  mcpToken: string | undefined; // WHATSAPP_MCP_TOKEN
  readOnly: boolean; // WHATSAPP_MCP_READONLY, truthy = 1/true/yes/on
  /** WHATSAPP_TRANSCRIBE_BACKENDS, comma-separated, default "runpod,mistral". Order is try-order. */
  transcribeBackends: readonly TranscribeBackend[];
  /** WHATSAPP_TRANSCRIBE_MAX_SECONDS (alias: WHATSAPP_WHISPER_MAX_SECONDS), default 900. */
  transcribeMaxSeconds: number;
  /** WHATSAPP_TRANSCRIBE_TIMEOUT_MS, default 900_000 — matches the endpoint's execution timeout. */
  transcribeTimeoutMs: number;
  runpodEndpointId: string | undefined; // WHATSAPP_RUNPOD_ENDPOINT_ID
  runpodApiKey: string | undefined; // RUNPOD_API_KEY
  mistralApiKey: string | undefined; // MISTRAL_API_KEY
  /**
   * RUNPOD_PRICE_PER_SECOND, default 0.000756 — A100 80 GB flex at $2.72/hr.
   *
   * Used only by the budget ledger. It is an estimate by construction: the authoritative figure is
   * the RunPod console's, and the ledger deliberately over-counts against it.
   */
  runpodPricePerSecond: number;
  /**
   * RUNPOD_IDLE_TIMEOUT_SECONDS, default 120 — must match the endpoint's own `idle_timeout`.
   *
   * The ledger charges one of these per cold burst, because RunPod bills the idle tail and nothing
   * in a job's response can see it.
   */
  runpodIdleTimeoutSeconds: number;
  autoTranscribe: AutoTranscribeConfig;
  maxImageBytes: number; // WHATSAPP_MAX_IMAGE_BYTES, default 5 MiB
  maxUploadBytes: number; // WHATSAPP_MAX_UPLOAD_BYTES, default 64 MiB, clamped [1, 256 MiB]
  /**
   * WHATSAPP_SEND_FILE_DIR: the one directory `whatsapp_send_file`'s `path` argument may resolve inside.
   *
   * Unset by default, which disables path-based sending entirely. That is the right default because
   * the deployment is a container serving a *remote* client, for which a server-side path has no
   * legitimate caller: left open, `path` is an arbitrary-file-read primitive that would hand
   * `/proc/self/environ` — every secret in the process environment — to a WhatsApp conversation.
   */
  sendFileDir: string | undefined;
  videoKeyframes: number; // WHATSAPP_VIDEO_KEYFRAMES, default 4, clamped [1, 16]
  /**
   * WHATSAPP_MEDIA_LINK_TTL, default 900, clamped [60, 86_400] — how long a signed media download
   * link stays redeemable, in seconds.
   *
   * `GET /media/dl/:token` is unauthenticated by design, so this is the lifetime of an
   * unauthenticated capability for one attachment: the ceiling is a day because a link that
   * outlives one is a durable leak of conversation content, and the floor is a minute because a
   * link too short-lived to survive being clicked is not a link. The value is baked into each
   * token at mint, so lowering it never revokes one already handed out.
   */
  mediaLinkTtlSec: number;
  maxResultChars: number; // WHATSAPP_MCP_MAX_RESULT_CHARS, default 200_000
  sessionTtlMs: number; // fixed 30 * 60_000
  ntfy: NtfyConfig | undefined;
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Parse a positive-integer env var; fall back on invalid/≤0, then clamp into [min, max]. */
function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Truthy spellings: 1/true/yes/on, case-insensitive, trimmed. */
function envTruthy(raw: string | undefined): boolean {
  return raw !== undefined && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse a non-negative float env var; fall back on invalid/negative, then clamp into [min, max]. */
function envFloat(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * The backend chain, as an ordered list of known names.
 *
 * An unknown name is dropped with the rest kept rather than throwing. This variable is the
 * documented emergency lever — "the endpoint is down, flip it to `mistral`" — and a deployment
 * that refuses to boot because someone typed `runpood` during an incident is worse than one that
 * runs on the half it understood. An empty result falls back to the default for the same reason.
 */
function parseBackends(raw: string | undefined): readonly TranscribeBackend[] {
  const known = new Set<string>(TRANSCRIBE_BACKENDS);
  const names = (raw ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name): name is TranscribeBackend => known.has(name));
  // Deduplicated: a chain listing the same backend twice would retry a failure that has already
  // been decided, at the cost of a second timeout.
  const unique = [...new Set(names)];
  return unique.length > 0 ? unique : TRANSCRIBE_BACKENDS;
}

function parseAutoTranscribe(env: NodeJS.ProcessEnv): AutoTranscribeConfig {
  return {
    // Off in code, on in the deployment. This spends money on recordings nobody asked about, so a
    // fresh checkout must never start doing it by accident.
    enabled: envTruthy(env["WHATSAPP_AUTOTRANSCRIBE"]),
    maxAgeSeconds: envInt(env["WHATSAPP_AUTOTRANSCRIBE_MAX_AGE"], 86_400, 60, 30 * 86_400),
    maxPerHour: envInt(env["WHATSAPP_AUTOTRANSCRIBE_MAX_PER_HOUR"], 20, 1, 10_000),
    maxSeconds: envInt(env["WHATSAPP_AUTOTRANSCRIBE_MAX_SECONDS"], 300, 1, 14_400),
    chatWindowDays: envInt(env["WHATSAPP_AUTOTRANSCRIBE_CHAT_WINDOW_DAYS"], 30, 1, 3650),
    allowlist: (env["WHATSAPP_AUTOTRANSCRIBE_CHATS"] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== ""),
    dailyBudgetUsd: envFloat(env["WHATSAPP_AUTOTRANSCRIBE_DAILY_BUDGET_USD"], 2, 0, 1_000),
    // 2 against the endpoint's `workers_max: 3`. The gap is the point: an interactive call must
    // never queue behind a backlog of notes nobody asked for.
    concurrency: envInt(env["WHATSAPP_AUTOTRANSCRIBE_CONCURRENCY"], 2, 1, 16),
  };
}

const PHONE_RE = /^[1-9]\d{7,14}$/;

/** E.164 digits without a leading "+" (8-15 digits total, no leading zero). Empty/absent is fine. */
function parsePhoneNumber(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!PHONE_RE.test(raw)) {
    throw new ConfigError(
      `WHATSAPP_PHONE_NUMBER must be E.164 digits without a leading "+" (8-15 digits, no leading zero); got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * ntfy is all-or-nothing: both NTFY_BASE_URL and NTFY_TOPIC must be non-empty.
 *
 * `NTFY_TOPIC` is the *problem* channel and stays required — a deployment that sets only the base URL
 * gets no alerting at all rather than alerting nobody watches. `NTFY_TOPIC_INFO` is the routine one
 * and is optional: unset, informational notices fall back to `topic`, which is exactly the
 * single-topic behaviour that existed before the split. So adding the variable can only ever move
 * traffic *off* the alert channel, never silence it.
 */
function parseNtfy(env: NodeJS.ProcessEnv): NtfyConfig | undefined {
  const baseUrl = env["NTFY_BASE_URL"];
  const topic = env["NTFY_TOPIC"];
  if (!baseUrl || !topic) return undefined;
  return { baseUrl, topic, infoTopic: env["NTFY_TOPIC_INFO"] || topic, token: env["NTFY_TOKEN"] || "" };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const dataDir = env["WHATSAPP_DATA_DIR"] || "/data/whatsapp";

  return {
    dataDir,
    dbPath: `${dataDir}/whatsapp.db`,
    mediaDir: env["WHATSAPP_MEDIA_DIR"] || `${dataDir}/media`,
    phoneNumber: parsePhoneNumber(env["WHATSAPP_PHONE_NUMBER"]),
    port: envInt(env["PORT"], 8080, 1, 65535),
    httpPath: env["MCP_HTTP_PATH"] || "/mcp",
    mcpToken: env["WHATSAPP_MCP_TOKEN"],
    readOnly: envTruthy(env["WHATSAPP_MCP_READONLY"]),
    transcribeBackends: parseBackends(env["WHATSAPP_TRANSCRIBE_BACKENDS"]),
    // `WHATSAPP_WHISPER_MAX_SECONDS` is kept as a deprecated alias for one release: it is the only
    // transcription variable a live deployment already sets, and silently halving the limit back to
    // the default during a rollout would start refusing recordings that used to work.
    transcribeMaxSeconds: envInt(
      env["WHATSAPP_TRANSCRIBE_MAX_SECONDS"] ?? env["WHATSAPP_WHISPER_MAX_SECONDS"],
      900,
      1,
      14_400,
    ),
    transcribeTimeoutMs: envInt(env["WHATSAPP_TRANSCRIBE_TIMEOUT_MS"], 900_000, 1_000, 3_600_000),
    runpodEndpointId: env["WHATSAPP_RUNPOD_ENDPOINT_ID"] || undefined,
    runpodApiKey: env["RUNPOD_API_KEY"] || undefined,
    mistralApiKey: env["MISTRAL_API_KEY"] || undefined,
    runpodPricePerSecond: envFloat(env["RUNPOD_PRICE_PER_SECOND"], 0.000756, 0, 1),
    runpodIdleTimeoutSeconds: envInt(env["RUNPOD_IDLE_TIMEOUT_SECONDS"], 120, 0, 3_600),
    autoTranscribe: parseAutoTranscribe(env),
    maxImageBytes: envInt(env["WHATSAPP_MAX_IMAGE_BYTES"], 5 * 1024 * 1024, 1, 100 * 1024 * 1024),
    maxUploadBytes: envInt(env["WHATSAPP_MAX_UPLOAD_BYTES"], 64 * 1024 * 1024, 1, 256 * 1024 * 1024),
    sendFileDir: env["WHATSAPP_SEND_FILE_DIR"] || undefined,
    videoKeyframes: envInt(env["WHATSAPP_VIDEO_KEYFRAMES"], 4, 1, 16),
    mediaLinkTtlSec: envInt(env["WHATSAPP_MEDIA_LINK_TTL"], 900, 60, 86_400),
    maxResultChars: envInt(env["WHATSAPP_MCP_MAX_RESULT_CHARS"], 200_000, 1_000, 50_000_000),
    sessionTtlMs: 30 * 60_000,
    ntfy: parseNtfy(env),
  };
}
