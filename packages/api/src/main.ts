#!/usr/bin/env node
/**
 * Bootstrap: the one place the real objects are constructed and handed to each other.
 *
 * It owns wiring and nothing else. Every decision it looks like it is making — what a handler may
 * reach, when a socket reconnects, what `/health` says — belongs to the module being wired, and the
 * two exceptions here (`loadMessage`, which adapts a Baileys key to a repository lookup, and
 * `shutdown`, which is process-level by nature) are named as such below.
 *
 * **Failure policy, inverted from the retired stdio server on purpose.** `uncaughtException` and
 * `unhandledRejection` are logged and the process keeps running. That server spoke to one client
 * over a pipe, so dying was honest; this one holds the only WhatsApp connection in the deployment
 * and serves every client over HTTP, so taking it down over one bad request drops the socket, the
 * ingest stream and every other session with it. A crash loop is not a recovery strategy when
 * reconnecting costs a fresh handshake with WhatsApp.
 *
 * A boot failure is the opposite case and still exits non-zero: nothing is running yet, so there is
 * nothing to protect, and a container that stays up with no server in it is worse than one that
 * restarts.
 */

import { pathToFileURL } from "node:url";
import type { WAMessageKey } from "baileys";
import type { Logger } from "pino";
import type { Handlers } from "whatsapp-api-sdk";
import { makeAlerter, type Alerter } from "./alerts.js";
import { loadConfig } from "./config.js";
import { makeAuthStore } from "./db/auth-state.js";
import { makeChatsRepo } from "./db/chats.js";
import { closeDb, openDb, type Db } from "./db/client.js";
import { makeContactsRepo } from "./db/contacts.js";
import { makeMessagesRepo } from "./db/messages.js";
import { makeMetaRepo } from "./db/meta.js";
import { makeReactionsRepo } from "./db/reactions.js";
import { logger } from "./logger.js";
import { makeAutoTranscriber, type AutoTranscriber } from "./media/autotranscribe.js";
import { biasTermsFor } from "./media/bias.js";
import { makeBudgetLedger } from "./media/budget.js";
import { makeMediaStore } from "./media/store.js";
import { makeTranscriber } from "./media/transcribe.js";
import { mediaHandlers } from "./rest/handlers/media.js";
import { metaHandlers } from "./rest/handlers/meta.js";
import { readHandlers } from "./rest/handlers/reads.js";
import { writeHandlers } from "./rest/handlers/writes.js";
import { makeMediaLinkSigner } from "./rest/medialink.js";
import { startRest, type RestDeps, type RestHandle } from "./rest/server.js";
import { makeConnection, type WhatsAppConnection } from "./whatsapp/connection.js";
import { makeIngest } from "./whatsapp/ingest.js";
import { canonicalId } from "./whatsapp/jid.js";
import { makeSender } from "./whatsapp/send.js";

export type ShutdownDeps = {
  logger: Logger;
  /** The one listener, and the socket every request is answered on. */
  server: RestHandle;
  conn: WhatsAppConnection;
  alerter: Alerter;
  db: Db;
  /** Absent when the deployment runs no background transcription. */
  autoTranscriber?: AutoTranscriber | undefined;
  /** Seam: the real one is `process.exit`, which a test cannot call. */
  exit: (code: number) => void;
};

/** POSIX convention: 128 + the signal number. */
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

export type StopSignal = keyof typeof EXIT_CODES;

/**
 * The slice of `process` that `installProcessHandlers` touches, as a seam.
 *
 * Narrow on purpose: the point is to make the *failure policy* — the inversion described at the top
 * of this file — assertable, and the only way to assert "and it did not exit" is to hand the
 * registration a fake and then fire the handlers. `process` satisfies this structurally, so the
 * production call passes the real one and nothing is adapted.
 */
export type ProcessEvents = {
  once: (event: StopSignal, listener: () => void) => void;
  on: (event: "uncaughtException" | "unhandledRejection", listener: (reason: unknown) => void) => void;
};

/**
 * Shut down in dependency order — stop accepting requests, stop the socket, stop alerting, close the
 * store — then exit.
 *
 * Every step is guarded on its own: a hung socket or an already-closed handle must not be the reason
 * the database never gets closed, and the exit code is the signal's whatever happened along the way.
 * A container is about to SIGKILL us regardless; the only real goal is a clean SQLite close.
 */
export async function shutdown(deps: ShutdownDeps, signal: StopSignal): Promise<void> {
  const { logger: log } = deps;
  log.info({ signal }, "main: shutting down");

  await step(log, "server", () => deps.server.close());
  // Before the connection, and before the database: a queued job that started after `closeDb` would
  // write a transcript into a closed handle. Dropping the queue is the right loss — every job in it
  // is still `transcript IS NULL` in the store, so the next boot's sweep picks it up.
  await step(log, "autotranscribe", () => {
    deps.autoTranscriber?.stop();
    return Promise.resolve();
  });
  await step(log, "connection", () => deps.conn.stop());
  await step(log, "alerts", () => {
    deps.alerter.stop();
    return Promise.resolve();
  });
  await step(log, "database", () => {
    closeDb(deps.db);
    return Promise.resolve();
  });

  deps.exit(EXIT_CODES[signal]);
}

async function step(log: Logger, what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    log.warn({ err, what }, "main: a shutdown step failed");
  }
}

export async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const db = openDb(config.dbPath);

  const chats = makeChatsRepo(db);
  const contacts = makeContactsRepo(db);
  const messages = makeMessagesRepo(db);
  const reactions = makeReactionsRepo(db);
  const meta = makeMetaRepo(db);
  const auth = makeAuthStore(db);

  /**
   * The socket's `getMessage` contract, backed by the store (Risk 3).
   *
   * The one adapter in this file: Baileys hands a raw key, the repository wants a canonical chat id,
   * and `canonicalId` is the only thing allowed to bridge the two (Global Constraint 11).
   */
  const loadMessage = (key: WAMessageKey): Promise<Uint8Array | undefined> => {
    const { remoteJid, id } = key;
    if (remoteJid == null || remoteJid === "" || id == null || id === "") return Promise.resolve(undefined);
    return Promise.resolve(messages.getRaw(canonicalId(remoteJid, { pnForLid: contacts.pnForLid }), id));
  };

  /**
   * The one cycle in the wiring. `ingest` needs the account's own id to decide `from_me`, and that
   * id does not exist until the connection has opened; `conn` needs `ingest.attach` to give every
   * new socket its listeners. A `let` plus a closure that reads the connection *at call time* is the
   * whole resolution — a container or a service locator would be a much larger machine for one edge.
   */
  let live: WhatsAppConnection | undefined = undefined;
  const selfId = (): string | null => live?.snapshot().selfId ?? null;

  /**
   * The second cycle in the wiring, and it has the same shape as the first.
   *
   * `ingest` hands newly-stored voice notes to the auto-transcriber, and the auto-transcriber needs
   * the media store and the transcriber — both of which need `conn`, which needs `ingest.attach`.
   * A `let` plus a closure that reads it at call time resolves it, exactly as `selfId` does above.
   */
  let autoTranscriber: AutoTranscriber | undefined = undefined;

  const ingest = makeIngest({
    db,
    chats,
    contacts,
    messages,
    reactions,
    logger,
    selfId,
    onVoiceNotes: (notes) => autoTranscriber?.enqueue(notes),
  });
  const conn = makeConnection({ config, logger, auth, loadMessage, onSocket: ingest.attach });
  live = conn;

  const sender = makeSender({
    conn,
    ingest,
    messages,
    chats,
    contacts,
    maxUploadBytes: config.maxUploadBytes,
    sendFileDir: config.sendFileDir,
  });
  const media = makeMediaStore({ dir: config.mediaDir, messages, conn, logger });

  const alerter = makeAlerter({ config, logger });
  conn.onStateChange(alerter.onState);

  // Constructed before the transcriber, which charges every completed job against it, and shared
  // with the auto-transcriber, which reads it as a gate. One ledger for both lanes: on-demand
  // transcription costs the same dollars, and a cap that could not see it would under-report
  // exactly when someone was using the tool heavily.
  const ledger = makeBudgetLedger({ config, meta, logger, notify: alerter.notify });
  const transcriber = makeTranscriber({ config, logger, ledger });
  const chatBiasTerms = (chatId: string): readonly string[] => biasTermsFor(chatId, { messages, contacts });

  if (config.autoTranscribe.enabled) {
    autoTranscriber = makeAutoTranscriber({
      config,
      logger,
      messages,
      media,
      transcriber,
      ledger,
      biasTermsFor: chatBiasTerms,
    });
  }

  /**
   * Everything a REST handler is allowed to reach, in the one place the real objects exist.
   *
   * `validateResponses` is left off. It is the handler suites' switch — on, a handler that answers
   * a millisecond timestamp is a 500 next to the line that caused it; in production it would turn
   * a response a consumer accepts today into a 500 nobody asked for.
   */
  const restDeps: RestDeps = {
    config,
    logger,
    chats,
    contacts,
    messages,
    reactions,
    meta,
    conn,
    sender,
    media,
    transcriber,
    biasTermsFor: chatBiasTerms,
    autoTranscriber,
    links: makeMediaLinkSigner({ apiToken: config.apiToken, ttlSec: config.mediaLinkTtlSec, logger }),
  };

  // The 24 routes of the contract, in four slices. `Handlers` is total over the route table, so a
  // slice that stopped covering one of its routes is a compile error here rather than a 404.
  const handlers: Handlers = {
    ...metaHandlers(restDeps),
    ...readHandlers(restDeps),
    ...mediaHandlers(restDeps),
    ...writeHandlers(restDeps),
  };

  const server = await startRest(restDeps, handlers);

  installProcessHandlers({ logger, server, conn, alerter, db, autoTranscriber, exit: (code) => process.exit(code) });

  // Fire and forget: it proves the ntfy token and the egress work before the first real incident,
  // and it must not delay the connection if ntfy is slow or down.
  void alerter.selfTest();

  // After the server is listening and before the socket opens: the sweep reads SQLite and enqueues,
  // so it needs nothing from WhatsApp, and doing it first means a restart mid-backlog resumes
  // rather than waiting for the next voice note to arrive.
  autoTranscriber?.sweep();

  await conn.start();
  logger.info(
    {
      readOnly: config.readOnly,
      dataDir: config.dataDir,
      transcribeBackends: config.transcribeBackends,
      autoTranscribe: config.autoTranscribe.enabled,
      port: config.port,
    },
    "main: started",
  );
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
  // Logged, never fatal — see the failure policy at the top of this file.
  proc.on("uncaughtException", (err) => {
    deps.logger.error({ err }, "main: uncaught exception (the server stays up)");
  });
  proc.on("unhandledRejection", (reason) => {
    deps.logger.error({ err: reason }, "main: unhandled rejection (the server stays up)");
  });
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
    logger.error({ err }, "main: failed to start");
    process.exit(1);
  }
}
