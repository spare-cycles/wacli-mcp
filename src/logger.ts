import { pino, type Logger } from "pino";

/** Field names that must never reach a log line, whatever object they appear on. */
const REDACT = ["token", "mcpToken", "ntfy.token", "*.token", "authorization", "req.headers.authorization"];

export function makeLogger(level = process.env["LOG_LEVEL"] || "info"): Logger {
  return pino({ level, redact: { paths: REDACT, censor: "[redacted]" } });
}

export const logger: Logger = makeLogger();

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
 */
export function errorFields(err: unknown): { errorType: string; errorMessage: string } {
  if (err instanceof Error) return { errorType: err.name, errorMessage: err.message };
  return { errorType: typeof err, errorMessage: "a non-Error value was thrown" };
}
