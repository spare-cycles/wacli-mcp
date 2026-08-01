import type { Boom } from "@hapi/boom";
import {
  Browsers,
  makeCacheableSignalKeyStore,
  makeWASocket as defaultMakeSocket,
  proto,
  type ConnectionState as BaileysConnectionState,
  type WAMessageKey,
  type WASocket,
} from "baileys";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { AuthStore } from "../db/auth-state.js";

export type ConnectionState = "disconnected" | "connecting" | "pairing" | "connected" | "logged_out";

export type ConnectionSnapshot = {
  state: ConnectionState;
  lastEventAt: number;
  lastConnectedAt: number | null;
  attempts: number;
  needsPairing: boolean;
  selfId: string | null;
};

export type ConnectionDeps = {
  config: Config;
  logger: Logger;
  auth: AuthStore;
  /** Backs the socket's required getMessage contract. */
  loadMessage: (key: WAMessageKey) => Promise<Uint8Array | undefined>;
  /** Called with each freshly created socket so ingest can attach its listeners. */
  onSocket: (sock: WASocket) => void;
  /** Baileys factory, injectable so tests never open a websocket. */
  makeSocket?: typeof import("baileys").makeWASocket | undefined;
};

export type WaConnection = {
  snapshot: () => ConnectionSnapshot;
  /** The live socket, or throws a ConnectionUnavailableError naming the current state. */
  requireSocket: () => WASocket;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onStateChange: (cb: (s: ConnectionState) => void) => void;
};

export class ConnectionUnavailableError extends Error {
  readonly state: ConnectionState;

  constructor(state: ConnectionState) {
    super(`WhatsApp connection unavailable: current state is "${state}"`);
    this.name = "ConnectionUnavailableError";
    this.state = state;
  }
}

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 300_000;
const MIN_DELAY_MS = 500;

/** Exported for testing: the delay before retry N, capped and jittered. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  const jitter = 0.5 + random(); // [0.5, 1.5)
  return Math.max(MIN_DELAY_MS, Math.round(raw * jitter));
}

export function makeConnection(deps: ConnectionDeps): WaConnection {
  const { config, logger, auth, loadMessage, onSocket } = deps;
  const makeSocket = deps.makeSocket ?? defaultMakeSocket;

  let state: ConnectionState = "disconnected";
  let lastEventAt = Date.now();
  let lastConnectedAt: number | null = null;
  let attempts = 0;
  let selfId: string | null = null;

  let sock: WASocket | undefined;
  let stopped = false;
  let pairingRequestedForSocket = false;
  let retryTimer: NodeJS.Timeout | undefined;

  const stateChangeListeners: ((s: ConnectionState) => void)[] = [];

  function onStateChange(cb: (s: ConnectionState) => void): void {
    stateChangeListeners.push(cb);
  }

  function setState(next: ConnectionState): void {
    state = next;
    for (const cb of stateChangeListeners) cb(next);
  }

  function touch(): void {
    lastEventAt = Date.now();
  }

  function clearRetryTimer(): void {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  }

  function snapshot(): ConnectionSnapshot {
    return {
      state,
      lastEventAt,
      lastConnectedAt,
      attempts,
      needsPairing: state === "pairing" || state === "logged_out",
      selfId,
    };
  }

  function requireSocket(): WASocket {
    if (sock === undefined || state !== "connected") throw new ConnectionUnavailableError(state);
    return sock;
  }

  function scheduleRetry(): void {
    if (stopped) return;
    const delay = backoffMs(attempts);
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      createSocket();
    }, delay);
  }

  // Synchronous: makeSocket() itself is synchronous (it returns a WASocket, not a Promise), so
  // there is nothing in here to await. start() still needs to hand back a Promise for its public
  // contract, which it does via Promise.resolve() rather than the `async` keyword.
  function createSocket(): void {
    if (stopped) return;
    pairingRequestedForSocket = false;
    setState("connecting");
    try {
      const newSock = makeSocket({
        auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, logger) },
        logger,
        printQRInTerminal: false,
        markOnlineOnConnect: false, // ban-risk mitigation from the spec
        browser: Browsers.macOS("Desktop"), // a plausible browser identity, same reason
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: async (key: WAMessageKey) => {
          const bytes = await loadMessage(key);
          // We store the encoded WebMessageInfo (Task 8 step 6), but getMessage is typed
          // `(key) => Promise<proto.IMessage | undefined>` — the INNER message, not the envelope.
          // Decoding these bytes as proto.Message would silently produce garbage and break
          // every message retry and poll-vote decrypt. Unwrap the envelope:
          return bytes ? (proto.WebMessageInfo.decode(bytes).message ?? undefined) : undefined;
        },
      });

      sock = newSock;
      onSocket(newSock);
      attachListeners(newSock);
    } catch (err) {
      // makeSocket threw synchronously (bad auth blob, unusable config): treat as an ordinary
      // failed attempt. Must not reject start() and take the process down.
      logger.error({ err }, "wa: makeSocket threw synchronously");
      touch();
      setState("disconnected");
      attempts += 1;
      scheduleRetry();
    }
  }

  function attachListeners(newSock: WASocket): void {
    newSock.ev.on("creds.update", () => {
      auth.saveCreds();
    });

    newSock.ev.on("connection.update", (update: Partial<BaileysConnectionState>) => {
      touch();

      if (update.qr !== undefined) {
        handleQr(newSock, update.qr);
      }

      if (update.connection === "open") {
        handleOpen(newSock);
      } else if (update.connection === "close") {
        handleClose(update);
      }
    });
  }

  function handleOpen(openedSock: WASocket): void {
    attempts = 0;
    lastConnectedAt = Date.now();
    selfId = openedSock.user?.id ?? null;
    setState("connected");
  }

  function handleQr(activeSock: WASocket, qr: string): void {
    if (config.phoneNumber === undefined || pairingRequestedForSocket) {
      setState("pairing");
      return;
    }
    pairingRequestedForSocket = true;
    void requestPairingCode(activeSock, config.phoneNumber, qr);
    setState("pairing");
  }

  async function requestPairingCode(activeSock: WASocket, phoneNumber: string, qr: string): Promise<void> {
    try {
      const pairingCode = await activeSock.requestPairingCode(phoneNumber);
      logger.info({ pairingCode }, "wa: pairing code issued");
      // Deliberately unmissable in a Portainer log tail, on top of the structured log line above.
      console.log(`\n=== WhatsApp pairing code: ${pairingCode} ===\n`);
    } catch (err) {
      logger.error({ err, qr }, "wa: requestPairingCode failed");
    }
  }

  function handleClose(update: Partial<BaileysConnectionState>): void {
    // stop() itself calls sock.end(), which typically fires its own close event. Once stopped,
    // that (or any other straggler from the socket we just tore down) must be a pure no-op —
    // otherwise a stale 401 could clear live credentials or override the outcome stop() recorded.
    if (stopped) return;

    const statusCode = (update.lastDisconnect?.error as Boom | undefined)?.output.statusCode;

    if (statusCode === 401 /* DisconnectReason.loggedOut */) {
      setState("logged_out");
      auth.clear();
      return;
    }

    if (statusCode === 515 /* DisconnectReason.restartRequired */) {
      // Expected immediately after pairing, not a failure: recreate at once, don't count it.
      createSocket();
      return;
    }

    setState("disconnected");
    attempts += 1;
    scheduleRetry();
  }

  function start(): Promise<void> {
    // A second start() while a socket is already live or being established must not spin up a
    // competing one — that would leak the current socket's listeners and split events between
    // two. "disconnected" (idle, or mid-backoff) and "logged_out" (needs a fresh pairing) are the
    // only states a start() may act on; the latter is exactly how a logged-out session recovers.
    if (state === "connecting" || state === "pairing" || state === "connected") {
      return Promise.resolve();
    }
    stopped = false;
    clearRetryTimer(); // don't let an already-scheduled retry also fire and create a second socket
    createSocket();
    return Promise.resolve();
  }

  async function stop(): Promise<void> {
    stopped = true;
    clearRetryTimer();
    const current = sock;
    sock = undefined;
    if (current !== undefined) {
      try {
        await current.end(undefined);
      } catch (err) {
        logger.warn({ err }, "wa: error ending socket on stop");
      }
    }
    if (state !== "logged_out") setState("disconnected");
  }

  return { snapshot, requireSocket, start, stop, onStateChange };
}
