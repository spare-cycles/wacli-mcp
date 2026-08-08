/**
 * The HTTP surface: Streamable-HTTP MCP on `config.httpPath`, a public `/health`, and nothing else.
 *
 * Ported from the API's own MCP listener, which ran in production and was correct. It is a separate
 * process now, so it owns its own `express()` app, its own listener and its own terminal error
 * middleware again — but every rule below is the one that shipped:
 *
 * 1. **Express 5.** Error middleware takes four parameters and is registered last, or Express reads
 *    it as an ordinary handler and every thrown request hangs. `wrap()` survives the upgrade even
 *    though Express 5 forwards a rejected promise on its own, because it is what keeps the 500 shape
 *    ours instead of Express's HTML error page.
 * 2. **Bearer auth in front of the MCP path only.** `/health` stays public: it is what the container
 *    healthcheck polls, and a healthcheck that needs the secret is a secret in the compose file.
 * 3. **No stateless mode.** One code path, sessions always (Global Constraint 15).
 *
 * Global Constraint 8 lives here more than anywhere: this module holds `WHATSAPP_MCP_TOKEN`. It is never
 * logged, never echoed in a refusal, and no log line here carries request headers — which is where a
 * caller's credential would be found. Nor does one carry a request *body*: no log line in this file
 * is ever handed a raw error object, for the reason spelled out on `errorType`.
 *
 * The middleware order is load-bearing, and it is `/health` → auth → `express.json` on the MCP path
 * → the MCP routes → the error middleware. Two of those placements are the whole point: `/health`
 * ahead of the gate keeps the container healthcheck credential-free even at `MCP_HTTP_PATH=/`, and
 * the parser behind the gate — mounted on the path rather than globally — is what stops an
 * anonymous `POST /anything` from having ~90 MB buffered and parsed on its behalf.
 *
 * **The one behavioural change the split forces is that `buildServer` is now async.** A session's
 * `McpServer` advertises the write tools only when the API says it is writable, and that answer
 * comes from `GET /v1/capabilities` — so building one is a round trip that can fail. Everything that
 * follows from that is in the initialize handler, and it is commented there rather than here.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { Logger } from "pino";
import type { McpConfig } from "./config.js";

export type HttpDeps = {
  config: McpConfig;
  logger: Logger;
  /**
   * A fresh `McpServer` per session. One instance per client, never a shared one.
   *
   * Async because a session's tool list depends on what the API says it can do, which is a request.
   * A rejection here is answered as a failed initialize and opens no session.
   */
  buildServer: () => Promise<McpServer>;
  /**
   * The `/health` payload. Async because it is the API's own report plus a reachability probe —
   * `buildProbe` awaits `client.getHealth()`.
   */
  health: () => Promise<Record<string, unknown>>;
};

export type HttpHandle = {
  close: () => Promise<void>;
  /** The bound port, which is what a test listening on port 0 needs. */
  port: number;
  /** How many sessions are open. A test's only window onto the session map. */
  sessionCount: () => number;
};

type HttpSession = { transport: StreamableHTTPServerTransport; server: McpServer; lastSeenMs: number };

/** The longest a sweep may be from the next, however long the session TTL is. */
const SWEEP_INTERVAL_CAP_MS = 60_000;

/**
 * How often idle sessions are swept: a quarter of the TTL, never more than a minute apart.
 *
 * Derived rather than fixed because a sweep period unrelated to the TTL is how "expired" comes to
 * mean "expired, plus up to a minute" — with the deployed 30-minute TTL this is exactly the 60 s of
 * the retired server, and it is what makes eviction observable in a test without a second seam.
 */
function sweepIntervalMs(sessionTtlMs: number): number {
  return Math.max(1, Math.min(SWEEP_INTERVAL_CAP_MS, Math.ceil(sessionTtlMs / 4)));
}

/** JSON-RPC error codes for the cases we answer ourselves, around the transport. */
const RPC_NO_SESSION = -32000;
const RPC_UNKNOWN_SESSION = -32001;
const RPC_UNAUTHORIZED = -32002;
const RPC_INVALID_REQUEST = -32600;
const RPC_INTERNAL = -32603;

type JsonRpcErrorBody = { jsonrpc: "2.0"; error: { code: number; message: string }; id: null };

function jsonRpcError(code: number, message: string): JsonRpcErrorBody {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function headerSessionId(req: Request): string | undefined {
  const h = req.headers["mcp-session-id"];
  return Array.isArray(h) ? h[0] : h;
}

const BEARER = /^Bearer[ \t]+(\S.*)$/i;

/**
 * Constant-time bearer comparison.
 *
 * The length check is not an optimization and cannot be dropped: `timingSafeEqual` **throws** on
 * buffers of unequal length, so without it a one-character token is a 500 (or a dead socket) rather
 * than a 401. It leaks the configured token's length, which is not a secret worth the alternative.
 */
function bearerMatches(expected: string, header: string | undefined): boolean {
  if (header === undefined) return false;
  const match = BEARER.exec(header);
  if (match === null) return false;
  const provided = Buffer.from(match[1] ?? "", "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (provided.length !== wanted.length) return false;
  return timingSafeEqual(provided, wanted);
}

/** A 4xx the body parser already decided (bad JSON, oversized body); anything else is ours, and a 500. */
function statusOf(err: unknown): number {
  if (typeof err !== "object" || err === null) return 500;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  const code = typeof status === "number" ? status : statusCode;
  return typeof code === "number" && code >= 400 && code <= 499 ? code : 500;
}

/**
 * How a failure is classified in a log line, and the only field a *rejected request* contributes.
 *
 * **No log line in this file may be handed a raw error object.** body-parser hangs the entire raw
 * payload off a parse failure (`createError(400, err, { body: str })`) and pino's standard error
 * serializer copies `message`, `stack` and *every own enumerable key* — so one `{ err }` writes an
 * arbitrary caller's body, bounded only by the ~90 MB parser limit, into the log. Two ways that
 * bites: a malformed POST from anyone at all, and a legitimate `whatsapp_send_file` whose base64 argument
 * lands on disk the one time the client gets the envelope wrong.
 *
 * `message` is left out of the rejected-request line for the same reason, and it is not paranoia:
 * V8 quotes the input it choked on (`Unexpected token 'L', "LEAKMARKER"... is not valid JSON`), so
 * the message is a body echo too — shorter than `body`, and still attacker-controlled. `type` is
 * body-parser's own classification (`entity.parse.failed`, `entity.too.large`), which is what
 * actually tells an operator what went wrong and is a fixed vocabulary rather than caller input.
 */
function errorType(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const { type } = err as { type?: unknown };
    if (typeof type === "string") return type;
    if (err instanceof Error) return err.name;
  }
  return "unknown";
}

/**
 * The whole error, field by field, for failures this server itself produced.
 *
 * Safe where `errorType` alone is not, because these are ours: `statusOf` sends every
 * parser-decided failure — every error that can carry a caller's body — down the 4xx branch, so
 * nothing that reaches a line built from this has ever seen the request payload. Picking the three
 * fields explicitly rather than passing `err` keeps that true no matter what an error grows later.
 */
function errorDetail(err: unknown): { type: string; message: string; stack: string | undefined } {
  const type = errorType(err);
  if (err instanceof Error) return { type, message: err.message, stack: err.stack };
  return { type, message: "a non-Error value was thrown", stack: undefined };
}

/** Adapt an async handler to Express while keeping every rejection contained and the 500 shape ours. */
function wrap(logger: Logger, fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void fn(req, res).catch((err: unknown) => {
      // Hand it to the error middleware when nothing has been written yet, so there is exactly one
      // place that decides what a failed request looks like.
      if (res.headersSent) {
        logger.error({ ...errorDetail(err), method: req.method }, "http: request failed after the response started");
        res.end();
        return;
      }
      next(err);
    });
  };
}

export function startHttp(deps: HttpDeps): Promise<HttpHandle> {
  const { config, logger, buildServer, health } = deps;
  const token = config.mcpToken ?? "";
  const sessions = new Map<string, HttpSession>();
  const app = express();

  // Registered before the auth middleware, and deliberately: `MCP_HTTP_PATH` is configurable, and a
  // deployment that set it to "/" would otherwise mount the bearer gate over `/health` too — which
  // is the endpoint the container healthcheck polls without a credential.
  app.get(
    "/health",
    wrap(logger, async (_req, res) => {
      res.json(await health());
    }),
  );

  if (token === "") {
    // Once, at boot — not per request, which would bury it. An unauthenticated MCP endpoint is a
    // deployment decision, so it is a warning rather than a refusal to start.
    logger.warn("http: WHATSAPP_MCP_TOKEN is not set; the MCP endpoint accepts unauthenticated requests");
  } else {
    app.use(config.httpPath, ((req, res, next) => {
      if (bearerMatches(token, req.headers.authorization)) {
        next();
        return;
      }
      res.setHeader("WWW-Authenticate", "Bearer");
      // Never says what was wrong with the credential, and never echoes either side of it.
      res.status(401).json(jsonRpcError(RPC_UNAUTHORIZED, "Unauthorized"));
    }) satisfies RequestHandler);
  }

  // Base64 in a `whatsapp_send_file` argument is 4 bytes per 3, plus room for the rest of the envelope.
  const bodyLimitBytes = Math.ceil((config.maxUploadBytes * 4) / 3) + 1024 * 1024;
  // Mounted on the MCP path, never globally, and after the gate above so the ordering still puts
  // auth in front of parsing. Global, this buffers and parses that ~90 MB for `POST /anything` —
  // from a caller who has presented no credential at all — before falling through to a 404. The
  // only requests worth spending that on are the ones already through the gate.
  app.use(config.httpPath, express.json({ limit: bodyLimitBytes }));

  // A client that stops polling never closes its stream, so `onclose` alone would leak its session
  // forever. Unref'd: a sweeper must not be the reason the process stays up.
  const sweeper = setInterval(() => {
    const nowMs = Date.now();
    for (const [id, session] of sessions) {
      if (nowMs - session.lastSeenMs > config.sessionTtlMs) {
        sessions.delete(id);
        void closeSession(session);
      }
    }
  }, sweepIntervalMs(config.sessionTtlMs));
  sweeper.unref();

  async function closeSession(session: HttpSession): Promise<void> {
    try {
      await session.transport.close();
      await session.server.close();
    } catch (err) {
      logger.warn(errorDetail(err), "http: error closing a session");
    }
  }

  app.post(
    config.httpPath,
    wrap(logger, async (req, res) => {
      const body = req.body as unknown;
      const sessionId = headerSessionId(req);
      if (sessionId !== undefined && sessionId !== "") {
        const existing = sessions.get(sessionId);
        if (existing === undefined) {
          res.status(404).json(jsonRpcError(RPC_UNKNOWN_SESSION, "Unknown or expired session"));
          return;
        }
        existing.lastSeenMs = Date.now();
        await existing.transport.handleRequest(req, res, body);
        return;
      }
      // No session yet: only an initialize request may open one.
      if (!isInitializeRequest(body)) {
        res.status(400).json(jsonRpcError(RPC_NO_SESSION, "No valid session; send an initialize request first"));
        return;
      }
      /**
       * What was built for this attempt, if anything.
       *
       * The whole reason it exists is that `buildServer()` is awaited: in the in-process server the
       * call was synchronous and could not reject, so both bindings were always in hand by the time
       * the `finally` ran. Now a capabilities round trip can fail before either exists, and reading
       * `transport.sessionId` unconditionally from the cleanup path would throw a second error over
       * the top of the real one — masking a downed API as a `TypeError`.
       */
      let built: HttpSession | undefined = undefined;
      try {
        const server = await buildServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server, lastSeenMs: Date.now() });
          },
        });
        built = { transport, server, lastSeenMs: Date.now() };
        // Set before `connect`, which chains rather than replaces it (SDK `Protocol.connect`).
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id !== undefined) sessions.delete(id);
        };
        // Cast: the transport is a Transport at runtime; its accessor-typed `onclose`/`onerror` trip
        // `exactOptionalPropertyTypes` against the interface's optional members.
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res, body);
      } finally {
        // An initialize that never opened a session — the transport refused it (a client whose
        // `Accept` header omits `text/event-stream` is answered 406), or `connect`/`handleRequest`
        // threw on the way — reaches `onsessioninitialized` never, so this pair is in no map and
        // nothing else would ever close it. `finally` and not a trailing `if`: the throwing path is
        // the one where a leak is least likely to be noticed, and it leaks the same `McpServer` and
        // transport per retry.
        //
        // `built` unbound means `buildServer()` itself rejected: nothing was constructed, so there
        // is nothing to close, and `wrap` turns the rejection into the error middleware's 500.
        if (built !== undefined && built.transport.sessionId === undefined) {
          await closeSession(built);
        }
      }
    }),
  );

  // GET = the server→client SSE stream; DELETE = explicit teardown. Both require a live session.
  const handleSessionRequest = wrap(logger, async (req, res) => {
    const sessionId = headerSessionId(req);
    const existing = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (existing === undefined) {
      res.status(404).json(jsonRpcError(RPC_UNKNOWN_SESSION, "Unknown or expired session"));
      return;
    }
    existing.lastSeenMs = Date.now();
    await existing.transport.handleRequest(req, res);
  });
  app.get(config.httpPath, handleSessionRequest);
  app.delete(config.httpPath, handleSessionRequest);

  // Last, and with four parameters: Express identifies error middleware by arity alone.
  app.use(((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = statusOf(err);
    // Neither `req.headers` (where a caller's bearer token is) nor the error object (where a
    // caller's *body* is — see `errorType`) ever reaches a log line here.
    if (status === 500) {
      logger.error({ ...errorDetail(err), method: req.method, path: req.path }, "http: request failed");
    } else {
      logger.warn({ type: errorType(err), method: req.method, path: req.path, status }, "http: request rejected");
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    res
      .status(status)
      .json(
        status === 500
          ? jsonRpcError(RPC_INTERNAL, "Internal server error")
          : jsonRpcError(RPC_INVALID_REQUEST, "Invalid request"),
      );
  }) satisfies express.ErrorRequestHandler);

  return new Promise<HttpHandle>((resolve, reject) => {
    // Only ever a *listen* failure — EADDRINUSE, EACCES on a privileged port. It has to come off
    // again the moment the promise settles: left on, every later server error would be handed to an
    // already-resolved `reject`, which is a no-op, and the failure would disappear without a trace.
    const onListenError = (err: Error): void => {
      reject(err);
    };
    // **`app.listen` is called without a callback, and that is not a style choice.** Express 5.2.1
    // wraps a callback passed here in `once()` and *also* registers it as an `error` handler
    // (`lib/application.js:598`), so an EADDRINUSE runs the success path: the port is read off an
    // `address()` of null, falls back to the port that could not be bound, and `startHttp` resolves a
    // handle onto a server that is not listening — while `reject` runs afterwards against an
    // already-settled promise and does nothing. Booting straight into "http: listening" on a port
    // owned by another process is the failure this shape prevents; `listening` fires only on success.
    const server: HttpServer = app.listen(config.port, "0.0.0.0");
    server.on("error", onListenError);
    server.once("listening", () => {
      server.off("error", onListenError);
      server.on("error", (err) => {
        logger.error(errorDetail(err), "http: server error");
      });
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : config.port;
      logger.info({ port, path: config.httpPath, authenticated: token !== "" }, "http: listening");
      resolve({ port, sessionCount: () => sessions.size, close: () => closeServer(server) });
    });
  });

  async function closeServer(server: HttpServer): Promise<void> {
    clearInterval(sweeper);
    const open = [...sessions.values()];
    sessions.clear();
    await Promise.all(open.map(closeSession));
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      // Streamable HTTP keeps connections alive; without this, close() waits for clients that have
      // no reason to hang up.
      server.closeAllConnections();
    });
  }
}
