#!/usr/bin/env node
/**
 * Bootstrap: the one place the real client is constructed and handed to everything else.
 *
 * It owns wiring and nothing else, and after the split there is remarkably little of it — a config,
 * a logger, one HTTP client and a listener. Every decision it looks like it is making belongs to
 * the module being wired: which tools a session advertises is `buildSession`'s, what `/health` says
 * is `buildProbe`'s, what a tool answers is the tool's.
 *
 * **Failure policy, matching the API's.** `uncaughtException` and `unhandledRejection` are logged
 * and the process keeps running. This server holds no WhatsApp socket, so it has less to protect
 * than the API does — but it serves every MCP client over one listener, and taking the process down
 * over one malformed request drops every other session with it. A crash loop is not a recovery
 * strategy.
 *
 * A boot failure is the opposite case and still exits non-zero: nothing is running yet, so there is
 * nothing to protect, and a container that stays up with no server in it is worse than one that
 * restarts. **A downed API is not a boot failure** — `createClient` opens no connection, so this
 * process starts, serves `/health` saying it cannot reach its backend, and answers the first
 * `initialize` after the API comes up. The alternative is a container whose start order matters.
 */

import { pathToFileURL } from "node:url";

import { createClient } from "whatsapp-api-sdk";

import { loadConfig } from "./config.js";
import type { ToolContext } from "./context.js";
import { buildProbe } from "./health.js";
import { startHttp, type HttpHandle } from "./http.js";
import { logger } from "./logger.js";
import { buildSession } from "./server.js";
import { VERSION } from "./version.js";

/** POSIX convention: 128 + the signal number. */
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

export type StopSignal = keyof typeof EXIT_CODES;

export type ShutdownDeps = {
  logger: typeof logger;
  http: HttpHandle;
  /** Seam: the real one is `process.exit`, which a test cannot call. */
  exit: (code: number) => void;
};

/**
 * The slice of `process` that `installProcessHandlers` touches, as a seam.
 *
 * Narrow on purpose: the point is to make the failure policy above assertable, and the only way to
 * assert "and it did not exit" is to hand the registration a fake and then fire the handlers.
 * `process` satisfies this structurally, so the production call passes the real one.
 */
export type ProcessEvents = {
  once: (event: StopSignal, listener: () => void) => void;
  on: (event: "uncaughtException" | "unhandledRejection", listener: (reason: unknown) => void) => void;
};

/**
 * Stop accepting requests, then exit.
 *
 * One step, where the API has five: this process owns no socket, no database and no background
 * lane. `startHttp`'s close is what ends the open sessions, and it is guarded because a hung
 * transport must not be the reason the exit code never arrives.
 */
export async function shutdown(deps: ShutdownDeps, signal: StopSignal): Promise<void> {
  deps.logger.info({ signal }, "main: shutting down");
  try {
    await deps.http.close();
  } catch (err) {
    // `errorFields`-shaped by hand rather than `{ err }`: no log line in this process is ever
    // handed a raw error object (Global Constraint 9).
    deps.logger.warn(
      { errorType: err instanceof Error ? err.name : typeof err, what: "http" },
      "main: a shutdown step failed",
    );
  }
  deps.exit(EXIT_CODES[signal]);
}

export function installProcessHandlers(deps: ShutdownDeps, proc: ProcessEvents = process): void {
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    proc.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void shutdown(deps, signal);
    });
  }
  // Logged, never fatal — see the failure policy at the top of this file. The error object itself
  // never reaches the line: pino's serializer would copy every own enumerable key, and an
  // `ApiError` carries a `details` record straight off the wire.
  proc.on("uncaughtException", (err) => {
    deps.logger.error(
      { errorType: err instanceof Error ? err.name : typeof err },
      "main: uncaught exception (the server stays up)",
    );
  });
  proc.on("unhandledRejection", (reason) => {
    deps.logger.error(
      { errorType: reason instanceof Error ? reason.name : typeof reason },
      "main: unhandled rejection (the server stays up)",
    );
  });
}

export async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);

  const client = createClient({
    baseUrl: config.apiUrl,
    token: config.apiToken,
    timeoutMs: config.requestTimeoutMs,
    // The one route that legitimately outlives the shared deadline: a GPU endpoint that scales to
    // zero takes minutes to answer the first call after a quiet period, and the API's own
    // transcription timeout is already larger than every other route's.
    timeoutMsByRoute: { transcribe: config.transcribeTimeoutMs },
  });

  const ctx: ToolContext = { config, logger, client };

  const http = await startHttp({
    config,
    logger,
    // Per session: the tool list depends on what the API says it can do, and the two builds are
    // checked against each other on the way. See `buildSession`.
    buildServer: () => buildSession(ctx),
    health: () => buildProbe(ctx),
  });

  installProcessHandlers({ logger, http, exit: (code) => process.exit(code) });

  logger.info({ version: VERSION, apiUrl: config.apiUrl, port: http.port, path: config.httpPath }, "main: started");
}

/** True only when this file is what node was told to run — so a test may import it safely. */
function isEntrypoint(): boolean {
  const argv = process.argv[1];
  return argv !== undefined && import.meta.url === pathToFileURL(argv).href;
}

if (isEntrypoint()) {
  try {
    await bootstrap();
  } catch (err) {
    logger.error({ errorType: err instanceof Error ? err.name : typeof err }, "main: failed to start");
    // The message, separately and last: a `ConfigError` says which variable is wrong, and a boot
    // failure with no reason on it is a support ticket. `loadConfig` is careful never to quote a
    // value, which is what makes printing this safe.
    if (err instanceof Error) logger.error(err.message);
    process.exit(1);
  }
}
