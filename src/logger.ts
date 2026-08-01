import { pino, type Logger } from "pino";

/** Field names that must never reach a log line, whatever object they appear on. */
const REDACT = ["token", "mcpToken", "ntfy.token", "*.token", "authorization", "req.headers.authorization"];

export function makeLogger(level = process.env["LOG_LEVEL"] || "info"): Logger {
  return pino({ level, redact: { paths: REDACT, censor: "[redacted]" } });
}

export const logger: Logger = makeLogger();
