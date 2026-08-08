import { pino, type Logger } from "pino";

/**
 * Field names that must never reach a log line, whatever object they appear on.
 *
 * Both of this process's secrets are named explicitly rather than trusting the wildcard: `apiToken`
 * is what it presents to the API and `mcpToken` is what a client presents to it, and either one on
 * a log line is the whole credential (Global Constraint 8).
 */
const REDACT = ["token", "apiToken", "mcpToken", "*.token", "authorization", "req.headers.authorization"];

export function makeLogger(level = process.env["LOG_LEVEL"] || "info"): Logger {
  return pino({ level, redact: { paths: REDACT, censor: "[redacted]" } });
}

export const logger: Logger = makeLogger();

/**
 * Absolute `http(s)` URLs, so a message carrying one can be reduced to the fact that it did.
 * Stops at whitespace, quotes and the brackets a message is likely to wrap a URL in.
 */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;

/**
 * A logger that writes nothing, for tests.
 *
 * Lives here rather than in each suite because a per-file copy is how a test ends up writing every
 * `logger.info` to the runner's stdout: the pino default is not silent, and the mistake is invisible
 * until the output is unreadable.
 */
export function silentLogger(): Logger {
  const noop = (): void => undefined;
  const self = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, level: "silent" };
  return { ...self, child: () => self } as unknown as Logger;
}

/** Replace every absolute URL in `text` with a placeholder naming its host. */
export function scrubUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    try {
      return `<url ${new URL(match).host}>`;
    } catch {
      return "<url>";
    }
  });
}

/**
 * The two fields an error contributes to a log line — and the reason a log line is never handed the
 * error itself.
 *
 * pino's standard error serializer copies `message`, `stack` **and every own enumerable key**
 * (`pino-std-serializers/lib/err.js`), so `{ err }` writes whatever the thrower happened to hang off
 * it. In this process that is not hypothetical either: an `ApiError` carries a `details` record
 * straight off the wire, and an `undici` failure carries the request it was making. Picking two
 * fields explicitly keeps the line bounded no matter what an error grows later.
 *
 * The message is scrubbed of absolute URLs for a reason specific to this side of the split: the
 * signed download link `fetchMediaLink` mints **is** a capability — whoever holds it can fetch the
 * attachment without a token (Global Constraint 5) — and it travels through this process as an
 * ordinary string that any thrower may quote. The host survives, which is the part with diagnostic
 * value; the signed path and query do not.
 */
export function errorFields(err: unknown): { errorType: string; errorMessage: string } {
  if (err instanceof Error) return { errorType: err.name, errorMessage: scrubUrls(err.message) };
  return { errorType: typeof err, errorMessage: "a non-Error value was thrown" };
}
