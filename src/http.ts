/**
 * The HTTP surface: Streamable-HTTP MCP on `config.httpPath`, a public `/health`, and nothing else.
 *
 * The session handling is the retired `server.ts`'s, which ran in production and was correct, with
 * three deliberate changes:
 *
 * 1. **Express 5.** Error middleware takes four parameters and is registered last, or Express reads
 *    it as an ordinary handler and every thrown request hangs. `wrap()` survives the upgrade even
 *    though Express 5 forwards a rejected promise on its own, because it is what keeps the 500 shape
 *    ours instead of Express's HTML error page.
 * 2. **Bearer auth in front of the MCP path only.** `/health` stays public: it is what the container
 *    healthcheck polls, and a healthcheck that needs the secret is a secret in the compose file.
 * 3. **No stateless mode.** One code path, sessions always (Global Constraint 15).
 *
 * Global Constraint 8 lives here more than anywhere: this module holds `WA_MCP_TOKEN`. It is never
 * logged, never echoed in a refusal, and no log line here carries request headers — which is where a
 * caller's credential would be found.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { Logger } from "pino";
import type { Config } from "./config.js";

export type HttpDeps = {
  config: Config;
  logger: Logger;
  /** A fresh `McpServer` per session. One instance per client, never a shared one. */
  buildServer: () => McpServer;
  /**
   * The `/health` payload. Async because transcription availability is a probe, not a field —
   * `buildHealth` awaits `Transcriber.available()`.
   */
  health: () => Promise<Record<string, unknown>>;
};

export type HttpHandle = {
  close: () => Promise<void>;
  /** The bound port, which is what a test listening on port 0 needs. */
  port: number;
};

type HttpSession = { transport: StreamableHTTPServerTransport; server: McpServer; lastSeen: number };

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

/** Adapt an async handler to Express while keeping every rejection contained and the 500 shape ours. */
function wrap(logger: Logger, fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void fn(req, res).catch((err: unknown) => {
      // Hand it to the error middleware when nothing has been written yet, so there is exactly one
      // place that decides what a failed request looks like.
      if (res.headersSent) {
        logger.error({ err, method: req.method }, "http: request failed after the response had started");
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
    logger.warn("http: WA_MCP_TOKEN is not set; the MCP endpoint accepts unauthenticated requests");
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

  // Base64 in a `wa_send_file` argument is 4 bytes per 3, plus room for the rest of the envelope.
  const bodyLimitBytes = Math.ceil((config.maxUploadBytes * 4) / 3) + 1024 * 1024;
  app.use(express.json({ limit: bodyLimitBytes }));

  // A client that stops polling never closes its stream, so `onclose` alone would leak its session
  // forever. Unref'd: a sweeper must not be the reason the process stays up.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastSeen > config.sessionTtlMs) {
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
      logger.warn({ err }, "http: error closing a session");
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
        existing.lastSeen = Date.now();
        await existing.transport.handleRequest(req, res, body);
        return;
      }
      // No session yet: only an initialize request may open one.
      if (!isInitializeRequest(body)) {
        res.status(400).json(jsonRpcError(RPC_NO_SESSION, "No valid session; send an initialize request first"));
        return;
      }
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, lastSeen: Date.now() });
        },
      });
      // Set before `connect`, which chains rather than replaces it (SDK `Protocol.connect`).
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id !== undefined) sessions.delete(id);
      };
      // Cast: the transport is a Transport at runtime; its accessor-typed `onclose`/`onerror` trip
      // `exactOptionalPropertyTypes` against the interface's optional members.
      await server.connect(transport as Transport);
      await transport.handleRequest(req, res, body);
      // An initialize the transport refuses — the common one is a client whose `Accept` header does
      // not list `text/event-stream`, answered 406 — never reaches `onsessioninitialized`, so this
      // pair is in no map and nothing else would ever close it. Without this, a misconfigured client
      // leaks one `McpServer` and one transport per retry.
      if (transport.sessionId === undefined) {
        await closeSession({ transport, server, lastSeen: Date.now() });
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
    existing.lastSeen = Date.now();
    await existing.transport.handleRequest(req, res);
  });
  app.get(config.httpPath, handleSessionRequest);
  app.delete(config.httpPath, handleSessionRequest);

  // Last, and with four parameters: Express identifies error middleware by arity alone.
  app.use(((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = statusOf(err);
    // `req.headers` is never logged: that is where a caller's bearer token is.
    if (status === 500) logger.error({ err, method: req.method, path: req.path }, "http: request failed");
    else logger.warn({ err, method: req.method, path: req.path, status }, "http: request rejected");
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
    const server: HttpServer = app.listen(config.port, "0.0.0.0", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : config.port;
      logger.info({ port, path: config.httpPath, authenticated: token !== "" }, "http: listening");
      resolve({ port, close: () => closeServer(server) });
    });
    server.on("error", reject);
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
