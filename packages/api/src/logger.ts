import { pino, type Logger } from "pino";

/** Field names that must never reach a log line, whatever object they appear on. */
const REDACT = ["token", "mcpToken", "ntfy.token", "*.token", "authorization", "req.headers.authorization"];

export function makeLogger(level = process.env["LOG_LEVEL"] || "info"): Logger {
  return pino({ level, redact: { paths: REDACT, censor: "[redacted]" } });
}

export const logger: Logger = makeLogger();

/**
 * Absolute `http(s)` URLs, so a message carrying one can be reduced to the fact that it did.
 * Stops at whitespace, quotes and the brackets a message is likely to wrap a URL in.
 */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;

/** Replace every absolute URL in `text` with a placeholder naming its host. */
/**
 * A logger that writes nothing, for tests.
 *
 * Lives here rather than in each suite because there are now several that need one, and a per-file
 * copy is how a test ends up writing every `logger.info` to the runner's stdout: the pino default
 * is not silent, and the mistake is invisible until the output is unreadable.
 */
export function silentLogger(): Logger {
  const noop = (): void => undefined;
  const self = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, level: "silent" };
  return { ...self, child: () => self } as unknown as Logger;
}

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
 * it. That is not hypothetical here: body-parser attaches the entire raw request body (which is why
 * `src/http.ts` has its own `errorType`/`errorDetail` split), and an undici- or axios-shaped failure
 * from `downloadMediaMessage` carries the **WhatsApp CDN media URL** — a capability URL that grants
 * whoever holds it the attachment's encrypted bytes. Picking the two fields explicitly keeps that
 * true no matter what an error grows later.
 *
 * Picking fields is not enough on its own, because a thrower can put the same secret in the
 * message: baileys raises ``new Boom(`Failed to fetch stream from ${url}`, …)``
 * (`lib/Utils/messages-media.js`) on exactly the common failure — an expired media URL answering
 * non-2xx. So the message is scrubbed of absolute URLs as well; the host survives, which is the
 * part with diagnostic value, and the signed path and query — the capability — do not.
 */
export function errorFields(err: unknown): { errorType: string; errorMessage: string } {
  if (err instanceof Error) return { errorType: err.name, errorMessage: scrubUrls(err.message) };
  return { errorType: typeof err, errorMessage: "a non-Error value was thrown" };
}
