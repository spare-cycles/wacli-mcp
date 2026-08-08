/**
 * The REST surface: the 24 routes of the contract, mounted in the one order that is correct.
 *
 * **The order is data-driven.** It comes from partitioning the bindings `implement()` returns on
 * `binding.auth`, never from hand-mounting the two exceptions:
 *
 * 1. Bindings whose `auth` is not `bearer` — `getHealth` and `fetchSignedMedia`. Mounted first, so
 *    no gate applies. A healthcheck has no credential, and a signed link is shareable precisely
 *    because it needs none.
 * 2. The bearer gate on `/v1`, constant-time, `WWW-Authenticate: Bearer` on the 401.
 * 3. `express.json` on `/v1`, **behind** the gate. Global, this buffers and parses ~90 MB for an
 *    anonymous `POST /anything` before falling through to a 404; the only requests worth spending
 *    that on are the ones already through the gate.
 * 4. The other 22 bindings.
 * 5. The error middleware, last and with four parameters — arity is how Express identifies it, and
 *    a three-parameter version leaves every thrown request hanging.
 *
 * Hand-mounting the two public routes would give them a second source of truth beside the table,
 * and the day a third public route is added it would be mounted behind the gate by omission. The
 * partition cannot make that mistake, and `assertGateReachesEveryBearerRoute` refuses to boot if
 * the table and the gate's prefix ever disagree.
 *
 * **Be precise about which parts of that order are actually observable, because two of them are
 * not.** `app.use(V1, …)` is path-scoped, and `/health` and `/media/dl/:token` are outside `/v1`,
 * so moving step 1 after step 4 changes no behaviour at all — a mutation that swaps them passes
 * the whole suite, and pretending otherwise would be a comment that lies. What is genuinely load-
 * bearing, and is each pinned by a test: the gate sits ahead of the parser (an anonymous malformed
 * `POST /v1/…` is a 401, not a 400); the parser is *scoped* to `/v1` rather than merely mounted
 * after the gate (a malformed `POST /media/dl/x` is a 404, not a parse error); the error middleware
 * is last and four-argument; and every bearer route really is under the gate's prefix, which is the
 * boot invariant's job rather than the ordering's.
 *
 * ⚠️ **That changes in Task 11**, and whoever restructures this file needs to know it. `mountMcp`
 * mounts on `config.httpPath`, which is *configurable* — a deployment setting `MCP_HTTP_PATH=/`
 * puts the MCP's own gate over everything, `/health` included, and then the relative order of the
 * public routes and that gate is the only thing keeping a container healthcheck credential-free.
 * `http.ts` says the same thing about its own `/health`, and it is why the route is registered
 * first there. The order here is cheap insurance against exactly that; do not "simplify" it away
 * on the grounds that today's suite cannot tell the difference.
 *
 * **`GET /media/dl/:token` sits outside `/v1` by path, and that is a separate mechanism from its
 * `auth` value.** `GET /v1/media/:chat/:id` also matches `/v1/media/dl/<token>` with `chat = "dl"`,
 * so had the download stayed under `/v1` the two would shadow each other depending on registration
 * order. The distinct prefix removes that structurally; partitioning on `auth` then handles the
 * gate. Neither substitutes for the other.
 *
 * Global Constraint 8 lives here as much as in `http.ts`: this module holds `WHATSAPP_API_TOKEN`,
 * and it is never logged, never echoed in a refusal, and never reachable from a response. No log
 * line here carries request headers — which is where a caller's credential is — and none is ever
 * handed a raw error object; see `errorDetail` in `./errors.js` for why that second one is not
 * paranoia.
 */

import { timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { Logger } from "pino";
import { ApiError, errorToWire, implement, type Handlers, type RouteBinding } from "whatsapp-api-sdk";

import type { Config } from "../config.js";
import type { ChatsRepo } from "../db/chats.js";
import type { ContactsRepo } from "../db/contacts.js";
import type { MessagesRepo } from "../db/messages.js";
import type { MetaRepo } from "../db/meta.js";
import type { ReactionsRepo } from "../db/reactions.js";
import type { AutoTranscriber } from "../media/autotranscribe.js";
import type { MediaStore } from "../media/store.js";
import type { Transcriber } from "../media/transcribe.js";
import type { WhatsAppConnection } from "../whatsapp/connection.js";
import type { Sender } from "../whatsapp/send.js";
import { errorDetail, toApiError } from "./errors.js";
import type { MediaLinkSigner } from "./medialink.js";

/**
 * Everything a REST handler is allowed to reach.
 *
 * The same shape as the in-process MCP's `ToolContext` plus the media-link signer, and that is
 * deliberate rather than incidental: while both surfaces run side by side (Tasks 11 through 16)
 * they answer from the same objects, which is what makes comparing them meaningful. It is a plain
 * record — handlers receive it, `main.ts` constructs it, and a test builds the same shape with
 * whichever parts it needs stubbed.
 */
export type RestDeps = {
  config: Config;
  logger: Logger;
  chats: ChatsRepo;
  contacts: ContactsRepo;
  messages: MessagesRepo;
  reactions: ReactionsRepo;
  meta: MetaRepo;
  conn: WhatsAppConnection;
  sender: Sender;
  media: MediaStore;
  transcriber: Transcriber;
  links: MediaLinkSigner;
  /** Terms worth spelling correctly in this chat, for a transcription backend that can use them. */
  biasTermsFor: (chatId: string) => readonly string[];
  /** The background transcription lane, when the deployment runs one. */
  autoTranscriber?: AutoTranscriber | undefined;
  /**
   * Check each JSON handler's result against its route's response schema before writing it.
   *
   * Off in production and on in the handler suites, which is the split the SDK's `ImplementOptions`
   * argues for: on, a handler that answers a millisecond timestamp is a 500 next to the line that
   * caused it; off, it is a `ZodError` in the MCP one process away, with the API logging nothing.
   * It is not simply on because the API is a product surface with other consumers, and turning a
   * response they accept today into a 500 is a behaviour change nobody asked for.
   */
  validateResponses?: boolean | undefined;
};

export type RestHandle = {
  /** Where the server is actually listening, which is what a test binding port 0 needs. */
  url: string;
  close: () => Promise<void>;
};

/** The prefix the bearer gate covers. Every bearer route lives under it; nothing else may. */
const V1 = "/v1";

const BEARER = /^Bearer[ \t]+(\S.*)$/;

/**
 * Where the matched route's *pattern* is left for the error middleware to log.
 *
 * The pattern and not `req.path`, because `/v1/messages/:chat/:id` carries a phone number in
 * `:chat` and a log line built from the concrete path writes one to disk on every failed request
 * against a DM. `res.locals` is Express's documented per-request scratch space; the cast is because
 * its declared type is an index signature this codebase forbids reading through.
 */
type RouteLocals = { restRoutePattern?: string };

/**
 * Constant-time bearer comparison.
 *
 * The length check is not an optimisation and cannot be dropped: `timingSafeEqual` **throws** on
 * buffers of unequal length, so without it a one-character token is a 500 — or a dead socket —
 * rather than a 401. It leaks the configured token's length, which is not a secret worth the
 * alternative.
 *
 * The pattern is case-sensitive on `Bearer`, unlike `http.ts`'s: RFC 9110 makes the scheme
 * case-insensitive, so this is stricter than the spec requires. It is left strict deliberately —
 * every client of this API is generated from `packages/sdk`, which sends exactly this spelling, and
 * a gate that accepts fewer shapes than it must is a smaller surface than one that accepts more.
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

/**
 * The gate's prefix and the table's paths, checked against each other once, at boot.
 *
 * Both directions are failures nothing else would catch. A bearer route outside `/v1` is mounted in
 * front of a gate that cannot reach it — an unauthenticated write, discovered by whoever finds it
 * first. A non-bearer route under `/v1` is mounted behind a gate it was never meant to pass, so
 * `/health` starts answering 401 to a container healthcheck that has no token to give. Refusing to
 * start is the only honest response to either: both are contract bugs, and a server that boots into
 * one hides it.
 *
 * Exported only so it can be exercised directly: `implement()` reads the frozen route table, so
 * there is no way to drive a bad binding through `startRest` from outside, and a guard against a
 * future mistake that is never run is a guard nobody knows works.
 */
export function assertGateReachesEveryBearerRoute(bindings: readonly RouteBinding[]): void {
  for (const binding of bindings) {
    const underV1 = binding.path === V1 || binding.path.startsWith(`${V1}/`);
    if (binding.auth === "bearer" && !underV1) {
      throw new Error(`route ${binding.method} ${binding.path} is bearer-authenticated but sits outside ${V1}`);
    }
    if (binding.auth !== "bearer" && underV1) {
      throw new Error(`route ${binding.method} ${binding.path} is "${binding.auth}" but sits behind the ${V1} gate`);
    }
  }
}

/**
 * Adapt one binding to Express, keeping every rejection contained and the failure shape ours.
 *
 * Express 5 forwards a rejected promise on its own, but this wrapper still earns its place: it
 * records the route pattern for the log line, and it decides what happens when a handler fails
 * *after* the response has started, which Express answers by destroying the socket.
 */
function wrap(logger: Logger, binding: RouteBinding): RequestHandler {
  return (req, res, next) => {
    (res.locals as RouteLocals).restRoutePattern = binding.path;
    void binding.handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        logger.error(
          { ...errorDetail(err), method: req.method, route: binding.path },
          "rest: request failed after the response started",
        );
        res.end();
        return;
      }
      next(err);
    });
  };
}

function mount(app: Express, binding: RouteBinding, logger: Logger): void {
  const handler = wrap(logger, binding);
  switch (binding.method) {
    case "GET":
      app.get(binding.path, handler);
      return;
    case "POST":
      app.post(binding.path, handler);
      return;
    case "PATCH":
      app.patch(binding.path, handler);
      return;
    case "DELETE":
      app.delete(binding.path, handler);
      return;
  }
}

export function startRest(deps: RestDeps, handlers: Handlers): Promise<RestHandle> {
  const { config, logger } = deps;
  const app = express();

  const bindings = implement(handlers, { validateResponses: deps.validateResponses });
  assertGateReachesEveryBearerRoute(bindings);

  // Step 1. The partition, which *is* the mount order. Written as one pass rather than two filters
  // so the two halves cannot fall out of step with each other.
  const open: RouteBinding[] = [];
  const gated: RouteBinding[] = [];
  for (const binding of bindings) (binding.auth === "bearer" ? gated : open).push(binding);
  for (const binding of open) mount(app, binding, logger);

  // Step 2. The gate. An unset token refuses everything behind it rather than opening it: an API
  // that accepts unauthenticated writes to a WhatsApp account because a variable was missing is not
  // a defensible default. Said once, at boot — a line per request would bury it — and `/health` is
  // already mounted above, so a probe still answers.
  const token = config.apiToken;
  if (token === undefined) {
    logger.warn(`rest: WHATSAPP_API_TOKEN is not set; every ${V1} route will answer 401 until it is`);
  }
  app.use(V1, ((req, res, next) => {
    if (token !== undefined && bearerMatches(token, req.headers.authorization)) {
      next();
      return;
    }
    res.setHeader("WWW-Authenticate", "Bearer");
    // Never says what was wrong with the credential, and never echoes either side of it.
    const { status, body } = errorToWire(new ApiError("unauthorized", "a valid bearer token is required"));
    res.status(status).json(body);
  }) satisfies RequestHandler);

  // Step 3. The parser, behind the gate and mounted on the prefix rather than globally. Base64 in a
  // `sendFile` body is 4 bytes per 3, plus room for the rest of the envelope.
  const bodyLimitBytes = Math.ceil((config.maxUploadBytes * 4) / 3) + 1024 * 1024;
  app.use(V1, express.json({ limit: bodyLimitBytes }));

  // Step 4. Everything the gate protects.
  for (const binding of gated) mount(app, binding, logger);

  // Step 5. Last, and with four parameters: Express identifies error middleware by arity alone.
  app.use(((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // The first action, and not an `instanceof ApiError` test: every domain error in this package
    // extends plain `Error`, so a bare `instanceof` sends all of them as 500 and turns the 400 for
    // a bad cursor, the 403 for a read-only deployment and the 503 for a downed socket into
    // "internal server error".
    const apiErr = toApiError(err);
    const { status, body } = errorToWire(apiErr);
    // Neither `req.headers` — where a caller's bearer token is — nor the error object — where a
    // caller's body is — ever reaches a line here. `errorDetail` reports the *mapped* message,
    // which is the one the response is about to carry anyway.
    const line = {
      ...errorDetail(err),
      method: req.method,
      route: (res.locals as RouteLocals).restRoutePattern,
      status,
      code: apiErr.code,
    };
    if (status >= 500) logger.error(line, "rest: request failed");
    else logger.warn({ ...line, stack: undefined }, "rest: request rejected");
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json(body);
  }) satisfies express.ErrorRequestHandler);

  return new Promise<RestHandle>((resolve, reject) => {
    // Only ever a *listen* failure — EADDRINUSE, EACCES on a privileged port. It comes off again the
    // moment the promise settles: left on, every later server error would be handed to an
    // already-resolved `reject`, and the failure would disappear without a trace.
    const onListenError = (err: Error): void => {
      reject(err);
    };
    // **`app.listen` is called without a callback, and that is not a style choice.** Express 5.2.1
    // wraps a callback passed here in `once()` and *also* registers it as an `error` handler
    // (`lib/application.js:598`), so an EADDRINUSE runs the success path: the port is read off an
    // `address()` of null, falls back to the port that could not be bound, and this resolves a
    // handle onto a server that is not listening. `listening` fires only on success.
    const server: HttpServer = app.listen(config.port, "0.0.0.0");
    server.on("error", onListenError);
    server.once("listening", () => {
      server.off("error", onListenError);
      server.on("error", (err) => {
        logger.error(errorDetail(err), "rest: server error");
      });
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : config.port;
      logger.info({ port, authenticated: token !== undefined, routes: bindings.length }, "rest: listening");
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
            // Keep-alive connections have no reason to hang up on their own, and `close()` waits
            // for every one of them without this.
            server.closeAllConnections();
          }),
      });
    });
  });
}
