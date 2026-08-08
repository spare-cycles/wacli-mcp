/**
 * The in-process MCP surface: Streamable-HTTP on `config.httpPath`, registered on an app it does
 * not own.
 *
 * The session handling is the retired `server.ts`'s, which ran in production and was correct, with
 * three deliberate changes:
 *
 * 1. **Express 5.** `wrap()` survives the upgrade even though Express 5 forwards a rejected promise
 *    on its own, because it is what keeps the failure shape ours instead of Express's HTML page.
 * 2. **Bearer auth in front of the MCP path only.** `/health` is not this module's to serve, and
 *    the gate must not reach it: it is what the container healthcheck polls, and a healthcheck that
 *    needs the secret is a secret in the compose file.
 * 3. **No stateless mode.** One code path, sessions always (Global Constraint 15).
 *
 * **This module is a guest, and that is the whole shape of it.** It used to create the app, serve
 * `/health`, install a terminal error middleware and listen; Task 11 mounted the REST surface
 * beside it on one port, and there can be exactly one of each of those. So `mountMcp` registers
 * routes on a caller-supplied app and returns a handle that closes its sessions — no `express()`,
 * no `/health`, no `listen`, and **no error middleware**.
 *
 * Losing the error middleware changes nothing a client sees, because nothing on this path reaches
 * one any more: the only two failures the MCP path can produce are a body the parser refused and a
 * handler that rejected, and both are answered *in place* with the same JSON-RPC envelope the
 * terminal handler used to write. That is not merely equivalent, it is required — the host's
 * terminal middleware answers the REST wire envelope, and an MCP client handed one would be reading
 * a shape no version of this server has ever spoken.
 *
 * `packages/mcp` is a separate process and needs the listener, the `/health` and the error
 * middleware back. It ports them from this file's history (Task 12), not from what is left here.
 *
 * Global Constraint 8 lives here more than anywhere: this module holds `WHATSAPP_MCP_TOKEN`. It is
 * never logged, never echoed in a refusal, and no log line here carries request headers — which is
 * where a caller's credential would be found. Nor does one carry a request *body*: no log line in
 * this file is ever handed a raw error object, for the reason spelled out on `errorType`.
 *
 * The middleware order within the mount is load-bearing, and it is auth → `express.json` on the MCP
 * path → the MCP routes. The parser behind the gate — mounted on the path rather than globally — is
 * what stops an anonymous `POST /anything` from having ~90 MB buffered and parsed on its behalf.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import { REST_PATH_SEGMENTS } from "./rest/server.js";

export type McpMountDeps = {
  config: Config;
  logger: Logger;
  /** A fresh `McpServer` per session. One instance per client, never a shared one. */
  buildServer: () => McpServer;
};

export type McpMountHandle = {
  /**
   * Closes every live session and stops the sweeper. It does **not** stop the listener — the host
   * owns that, and a guest that closed it would take the REST surface down with it.
   */
  close: () => Promise<void>;
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

/**
 * How a failed MCP request is reported and answered, in the one place that decides it.
 *
 * This used to be a terminal error middleware. It is a function now because this module no longer
 * owns the terminal slot (see the header) and the envelope it writes must not change: an MCP client
 * handed the host's REST wire envelope would be reading a shape this server has never spoken.
 * Every failure the MCP path can produce is routed here — a refused body from the parser trap, a
 * rejected handler from `wrap` — and none of them is ever forwarded with `next(err)`.
 *
 * Neither `req.headers` (where a caller's bearer token is) nor the error object (where a caller's
 * *body* is — see `errorType`) ever reaches a log line here.
 */
function fail(logger: Logger, req: Request, res: Response, err: unknown): void {
  const status = statusOf(err);
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
}

/** Adapt an async handler to Express while keeping every rejection contained and the 500 shape ours. */
function wrap(logger: Logger, fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => {
    void fn(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        logger.error({ ...errorDetail(err), method: req.method }, "http: request failed after the response started");
        res.end();
        return;
      }
      fail(logger, req, res, err);
    });
  };
}

/** The first non-empty segment of a path, which is the granularity the host reserves paths at. */
const rootSegment = (path: string): string => path.split("/").find((segment) => segment !== "") ?? "";

/**
 * `MCP_HTTP_PATH` against the prefixes the REST surface owns, checked before a single route is
 * registered.
 *
 * Two of the three ways a guest can collide with its host are unfixable by ordering and so are
 * refusals. `MCP_HTTP_PATH=/health` puts the MCP behind a route registered ahead of it, so the MCP
 * is simply dead and the operator's next clue is a client that cannot initialize.
 * `MCP_HTTP_PATH=/v1` is worse: the MCP would sit behind the REST bearer gate and its bodies would
 * be parsed by the REST parser, so a valid `WHATSAPP_MCP_TOKEN` would answer 401 against a wire
 * envelope. Neither is a state worth booting into.
 *
 * The third — `MCP_HTTP_PATH=/`, the case Task 7's boot invariant admitted it did not cover — is
 * **allowed, because ordering already answers it.** The mount seam runs after every REST binding,
 * open and gated alike, so `/health` and every `/v1` route match a handler that has already
 * responded before the MCP's gate at `/` is ever reached. `assertGateReachesEveryBearerRoute` pins
 * the half of that ordering that lives in the host; the `mountMcp` seam's position pins this half,
 * and `http.test.ts` drives a real request at both under `MCP_HTTP_PATH=/`.
 */
export function assertMcpPathIsFree(httpPath: string): void {
  const segment = rootSegment(httpPath);
  if (segment === "") return;
  if (Object.hasOwn(REST_PATH_SEGMENTS, segment)) {
    throw new Error(`MCP_HTTP_PATH ${httpPath} collides with the REST surface, which answers on /${segment}`);
  }
}

export function mountMcp(app: Express, deps: McpMountDeps): McpMountHandle {
  const { config, logger, buildServer } = deps;
  assertMcpPathIsFree(config.httpPath);
  const token = config.mcpToken ?? "";
  const sessions = new Map<string, HttpSession>();

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
  const parseBody = express.json({ limit: bodyLimitBytes });
  // Mounted on the MCP path, never globally, and after the gate above so the ordering still puts
  // auth in front of parsing. Global, this buffers and parses that ~90 MB for `POST /anything` —
  // from a caller who has presented no credential at all — before falling through to a 404. The
  // only requests worth spending that on are the ones already through the gate.
  //
  // The refusal is caught here rather than forwarded, because a forwarded one would land in the
  // host's terminal middleware and come back as a REST wire envelope. `express.json` calls its
  // `next` with an error or with nothing, never with Express's `"route"`/`"router"` strings, so the
  // two branches below are the whole vocabulary.
  app.use(config.httpPath, ((req, res, next) => {
    parseBody(req, res, (err: unknown) => {
      if (err === undefined || err === null) {
        next();
        return;
      }
      fail(logger, req, res, err);
    });
  }) satisfies RequestHandler);

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
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, lastSeenMs: Date.now() });
        },
      });
      // Set before `connect`, which chains rather than replaces it (SDK `Protocol.connect`).
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id !== undefined) sessions.delete(id);
      };
      try {
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
        if (transport.sessionId === undefined) {
          await closeSession({ transport, server, lastSeenMs: Date.now() });
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

  logger.info({ path: config.httpPath, authenticated: token !== "" }, "http: mcp mounted");

  return {
    close: async () => {
      clearInterval(sweeper);
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map(closeSession));
    },
  };
}
