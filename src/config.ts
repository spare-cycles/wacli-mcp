import os from "node:os";

export type NtfyConfig = { baseUrl: string; topic: string; token: string };

export type Config = {
  dataDir: string; // WA_DATA_DIR, default "/data/wa"
  dbPath: string; // `${dataDir}/wa.db`
  mediaDir: string; // WA_MEDIA_DIR, default `${dataDir}/media`
  phoneNumber: string | undefined; // WA_PHONE_NUMBER, digits only, 8..15
  port: number; // PORT, default 8080, clamped [1, 65535]
  httpPath: string; // MCP_HTTP_PATH, default "/mcp"
  mcpToken: string | undefined; // WA_MCP_TOKEN
  readOnly: boolean; // WA_MCP_READONLY, truthy = 1/true/yes/on
  whisperBin: string; // WA_WHISPER_BIN, default "whisper-cli"
  whisperModel: string; // WA_WHISPER_MODEL, default "large-v3-turbo-q5_0"
  whisperThreads: number; // WA_WHISPER_THREADS, default max(1, cpus-1)
  whisperMaxSeconds: number; // WA_WHISPER_MAX_SECONDS, default 900
  maxImageBytes: number; // WA_MAX_IMAGE_BYTES, default 5 MiB
  maxUploadBytes: number; // WA_MAX_UPLOAD_BYTES, default 64 MiB, clamped [1, 256 MiB]
  /**
   * WA_SEND_FILE_DIR: the one directory `wa_send_file`'s `path` argument may resolve inside.
   *
   * Unset by default, which disables path-based sending entirely. That is the right default because
   * the deployment is a container serving a *remote* client, for which a server-side path has no
   * legitimate caller: left open, `path` is an arbitrary-file-read primitive that would hand
   * `/proc/self/environ` — every secret in the process environment — to a WhatsApp conversation.
   */
  sendFileDir: string | undefined;
  videoKeyframes: number; // WA_VIDEO_KEYFRAMES, default 4, clamped [1, 16]
  maxResultChars: number; // WA_MCP_MAX_RESULT_CHARS, default 200_000
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

const PHONE_RE = /^[1-9]\d{7,14}$/;

/** E.164 digits without a leading "+" (8-15 digits total, no leading zero). Empty/absent is fine. */
function parsePhoneNumber(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!PHONE_RE.test(raw)) {
    throw new ConfigError(
      `WA_PHONE_NUMBER must be E.164 digits without a leading "+" (8-15 digits, no leading zero); got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/** ntfy is all-or-nothing: both NTFY_BASE_URL and NTFY_TOPIC must be non-empty. */
function parseNtfy(env: NodeJS.ProcessEnv): NtfyConfig | undefined {
  const baseUrl = env["NTFY_BASE_URL"];
  const topic = env["NTFY_TOPIC"];
  if (!baseUrl || !topic) return undefined;
  return { baseUrl, topic, token: env["NTFY_TOKEN"] || "" };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const dataDir = env["WA_DATA_DIR"] || "/data/wa";
  const whisperThreadsDefault = Math.max(1, os.cpus().length - 1);

  return {
    dataDir,
    dbPath: `${dataDir}/wa.db`,
    mediaDir: env["WA_MEDIA_DIR"] || `${dataDir}/media`,
    phoneNumber: parsePhoneNumber(env["WA_PHONE_NUMBER"]),
    port: envInt(env["PORT"], 8080, 1, 65535),
    httpPath: env["MCP_HTTP_PATH"] || "/mcp",
    mcpToken: env["WA_MCP_TOKEN"],
    readOnly: envTruthy(env["WA_MCP_READONLY"]),
    whisperBin: env["WA_WHISPER_BIN"] || "whisper-cli",
    whisperModel: env["WA_WHISPER_MODEL"] || "large-v3-turbo-q5_0",
    whisperThreads: envInt(
      env["WA_WHISPER_THREADS"],
      whisperThreadsDefault,
      1,
      Math.max(whisperThreadsDefault, os.cpus().length),
    ),
    whisperMaxSeconds: envInt(env["WA_WHISPER_MAX_SECONDS"], 900, 1, 14_400),
    maxImageBytes: envInt(env["WA_MAX_IMAGE_BYTES"], 5 * 1024 * 1024, 1, 100 * 1024 * 1024),
    maxUploadBytes: envInt(env["WA_MAX_UPLOAD_BYTES"], 64 * 1024 * 1024, 1, 256 * 1024 * 1024),
    sendFileDir: env["WA_SEND_FILE_DIR"] || undefined,
    videoKeyframes: envInt(env["WA_VIDEO_KEYFRAMES"], 4, 1, 16),
    maxResultChars: envInt(env["WA_MCP_MAX_RESULT_CHARS"], 200_000, 1_000, 50_000_000),
    sessionTtlMs: 30 * 60_000,
    ntfy: parseNtfy(env),
  };
}
