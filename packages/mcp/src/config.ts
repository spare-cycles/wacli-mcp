/**
 * Everything this process is configured with — ten values, and not one of them describes WhatsApp.
 *
 * That is the shape of the split: the MCP holds a URL, two tokens, an HTTP surface and five bounds.
 * Where the account lives, which transcription backend to try, what a media link costs — all of it
 * is the API's, and none of it is readable from here (spec §9).
 *
 * **`WHATSAPP_API_URL`'s value never reaches an error message.** A base URL may carry a userinfo
 * section, and `http://mcp:hunter2@api:8080` put in front of an operator is a leaked password
 * (Global Constraint 8). So every refusal below names the variable and says what is wrong with it,
 * and never quotes what was set — which also means the credential check has to *refuse* rather than
 * strip: silently dropping the userinfo would leave a deployment believing it authenticates that
 * way, when `fetch` refuses such a URL outright and every request would fail.
 */

export type McpConfig = {
  /** WHATSAPP_API_URL — required, absolute http(s), no credentials, no trailing slash. */
  apiUrl: string;
  /** WHATSAPP_API_TOKEN — the bearer this process presents to the API. The same secret the API gates `/v1` with. */
  apiToken: string | undefined;
  /** WHATSAPP_MCP_TOKEN — the bearer a client presents to *this* process. Unset means the MCP path is open. */
  mcpToken: string | undefined;
  httpPath: string; // MCP_HTTP_PATH, default "/mcp"
  port: number; // PORT, default 8080, clamped [1, 65535]
  /** From WHATSAPP_MCP_SESSION_TTL, in **seconds**, default 1800 — the API's fixed 30 minutes, made settable. */
  sessionTtlMs: number;
  maxResultChars: number; // WHATSAPP_MCP_MAX_RESULT_CHARS, default 200_000
  /**
   * WHATSAPP_MAX_UPLOAD_BYTES, default 64 MiB, clamped [1, 256 MiB].
   *
   * **A deviation from spec §9's table, which lists this variable under `api` alone**, and the
   * reason is `http.ts`: the body limit on the MCP path is derived from it, because a
   * `whatsapp_send_file` argument is base64 and arrives as a JSON-RPC body here before it ever
   * reaches the API. Without the value the MCP would need a second, hard-coded ceiling that could
   * refuse an upload the API would have accepted.
   *
   * The two containers therefore want the *same* value: raising the API's limit without raising
   * this one moves the refusal from the API's 413 to the MCP's body parser, which is a worse
   * message for the same outcome. It is deliberately not fetched from `/v1/capabilities` — the
   * limit is fixed when the listener starts, and the MCP must start whether or not the API is up.
   */
  maxUploadBytes: number;
  /**
   * From WHATSAPP_MCP_REQUEST_TIMEOUT_MS, default 30 000, clamped [1000, 300 000]. Feeds
   * `createClient({ timeoutMs })`. Not in spec §9's table either — recorded as a deviation.
   */
  requestTimeoutMs: number;
  /**
   * From WHATSAPP_MCP_TRANSCRIBE_TIMEOUT_MS, default 960 000, clamped [60 000, 3 900 000].
   *
   * A separate knob, not a larger `requestTimeoutMs`, and the numbers force it: the API's own
   * `transcribeTimeoutMs` defaults to 900 000 and clamps to an hour, while `requestTimeoutMs`
   * clamps at 300 000. One shared timeout either gives up on a transcription five minutes into a
   * fifteen-minute job, or gives every ordinary read a fifteen-minute rope. The default sits just
   * above the API's so the SDK is never the component that quits first, and the ceiling sits just
   * above the API's own ceiling for the same reason.
   *
   * `createClient` takes it as a per-route override for `transcribe` only.
   */
  transcribeTimeoutMs: number;
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

/**
 * The API's base URL, validated at boot rather than discovered per request.
 *
 * Required with no default, and that is the safer of the two options. The value the shipped compose
 * file uses is `http://api:8080`, a hostname that exists only on that network — as a default it
 * would turn "you forgot to configure me" into a DNS failure on every tool call, reported by the
 * SDK as an unreachable API. One line at boot naming the variable is a better answer.
 *
 * Only `http:` and `https:` are accepted: the SDK reaches the API with `fetch`, and a `ws:` or
 * `file:` base is a configuration mistake that would otherwise surface as a `TypeError` from
 * inside a tool call.
 */
function parseApiUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigError("WHATSAPP_API_URL is required: it is the base URL of the whatsapp-api service");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError("WHATSAPP_API_URL must be an absolute URL, e.g. http://api:8080");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`WHATSAPP_API_URL must be http or https; got the ${url.protocol} scheme`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError(
      "WHATSAPP_API_URL must not contain credentials: fetch refuses such a URL outright, and a password " +
        "in a base URL reaches log lines. Use WHATSAPP_API_TOKEN instead",
    );
  }
  // Trailing slashes are trimmed here as well as in `createClient`, so the URL this config reports
  // and the URL the client requests are the same string.
  return raw.trim().replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv): McpConfig {
  return {
    apiUrl: parseApiUrl(env["WHATSAPP_API_URL"]),
    // `|| undefined`, so an empty string is absent: `WHATSAPP_API_TOKEN=` in a compose file is a
    // variable someone meant to fill in, and presenting the empty string as a bearer would be
    // rejected by the API with no hint that this is why. The API applies the same rule to the same
    // value.
    apiToken: env["WHATSAPP_API_TOKEN"] || undefined,
    // Read raw, unlike `apiToken`: `http.ts` compares `mcpToken ?? ""` against `""` to decide
    // whether the MCP path is gated at all, so the empty string and absence already mean the same
    // thing there and a second normalisation would only hide that.
    mcpToken: env["WHATSAPP_MCP_TOKEN"],
    httpPath: env["MCP_HTTP_PATH"] || "/mcp",
    port: envInt(env["PORT"], 8080, 1, 65535),
    // Seconds on the way in, milliseconds on the way out: only a `*Ms` name carries milliseconds.
    // The floor is a minute because a TTL shorter than a client's own poll interval evicts a live
    // session, and the ceiling is a day because an abandoned session holds an `McpServer` open.
    sessionTtlMs: envInt(env["WHATSAPP_MCP_SESSION_TTL"], 1800, 60, 86_400) * 1000,
    maxResultChars: envInt(env["WHATSAPP_MCP_MAX_RESULT_CHARS"], 200_000, 1_000, 50_000_000),
    maxUploadBytes: envInt(env["WHATSAPP_MAX_UPLOAD_BYTES"], 64 * 1024 * 1024, 1, 256 * 1024 * 1024),
    requestTimeoutMs: envInt(env["WHATSAPP_MCP_REQUEST_TIMEOUT_MS"], 30_000, 1_000, 300_000),
    transcribeTimeoutMs: envInt(env["WHATSAPP_MCP_TRANSCRIBE_TIMEOUT_MS"], 960_000, 60_000, 3_900_000),
  };
}
