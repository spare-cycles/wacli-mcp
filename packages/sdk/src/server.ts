/**
 * The server half of the contract: a typed handler map in, a list of bindings out.
 *
 * `implement()` returns bindings rather than mounting them. `packages/api` keeps ownership of
 * Express, of the middleware order, and of the auth gate — all three are things this package has no
 * business deciding, and a `mount(app)` here would have to know about every one of them.
 *
 * `Handlers` is an exhaustive mapped type over `Routes`, and that is the whole point: a missing
 * handler, a handler that returns the wrong shape, and a handler that reads a query field the route
 * does not declare are all `tsc` errors rather than a 404 discovered in production. Do not weaken it
 * to `Partial`; `server.test.ts` pins the exhaustiveness with a compile-time negative.
 */

import { z } from "zod";

import { BadRequestError } from "./errors.js";
import type { BinaryPayload, HandlerResult, Route } from "./routes.js";
import { routes, type RouteKey, type Routes } from "./routes.js";

/**
 * One handler.
 *
 * The three inputs are always present as *properties* and are `undefined` on the routes that do not
 * declare them, rather than being absent. A handler destructures `{ params }` unconditionally, and a
 * route that later grows a `params` schema changes the type of the field it already reads instead of
 * introducing one, which is the difference between a compile error and a silent `undefined`.
 */
export type Handler<R extends Route> = (input: {
  params: R["params"] extends z.ZodTypeAny ? z.infer<R["params"]> : undefined;
  query: R["query"] extends z.ZodTypeAny ? z.infer<R["query"]> : undefined;
  body: R["body"] extends z.ZodTypeAny ? z.infer<R["body"]> : undefined;
}) => Promise<HandlerResult<R>>;

export type Handlers = { [K in keyof Routes]: Handler<Routes[K]> };

/** The request fields a binding reads. Structural, so Express's `Request` satisfies it as-is. */
export type RawRequest = {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
};

/** The response surface a binding writes to. Chainable, so Express's `Response` satisfies it as-is. */
export type RawResponse = {
  status: (code: number) => RawResponse;
  header: (name: string, value: string) => RawResponse;
  json: (body: unknown) => void;
  send: (body: Uint8Array) => void;
};

/** What `implement()` hands back for the API to mount however it likes. */
export type RouteBinding = {
  method: Route["method"];
  /** Express-style, `:param` segments preserved. */
  path: string;
  auth: Route["auth"];
  /** Parses params/query/body with the route's schemas, calls the handler, writes the response. */
  handle: (req: RawRequest, res: RawResponse) => Promise<void>;
};

/**
 * Parse one part of a request, or refuse it as `bad_request`.
 *
 * A `ZodError` escaping here would reach the API's error middleware as an unrecognised throw and be
 * reported as `internal`/500 — a server-fault status for an argument the caller got wrong, and the
 * wrong retry advice. `BadRequestError` carries the name `"Error"`, which is what every bare
 * validation throw in this codebase renders as today, so the model-visible text does not change.
 *
 * The message names the failing paths and never the values: a body can carry base64 file bytes, and
 * a query can carry a search term. Zod's own issue messages are shapes ("Expected number, received
 * nan"), not contents.
 */
function parsePart(schema: z.ZodTypeAny, value: unknown, part: string): unknown {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`))
    .join("; ");
  throw new BadRequestError(`invalid ${part}: ${detail}`);
}

/** A JSON handler's result is whatever its schema infers; a binary one's is always this shape. */
function isBinary(result: unknown): result is BinaryPayload {
  return typeof result === "object" && result !== null && "bytes" in result;
}

/**
 * A filename that is safe to quote inside a header value.
 *
 * Quotes would end the quoted-string early and a CR or LF would split the header, so both classes
 * go. Every non-printable and non-ASCII byte goes with them rather than being percent-encoded: this
 * is the `filename=` fallback, the parameter a client uses when it has nothing better, and mangling
 * an accented character in a download name is a far smaller cost than emitting a header value that
 * Node refuses to send at all.
 */
function headerSafe(filename: string): string {
  return filename.replace(/[^ -~]/g, "_").replaceAll('"', "");
}

/**
 * Turn a fully typed handler map into bindings the API can mount.
 *
 * Iterating `routes` rather than `handlers` is deliberate: the table is the source of truth for what
 * exists, and the mapped type already guarantees the map has an entry for every key.
 */
export function implement(handlers: Handlers): RouteBinding[] {
  // Widened from the table's 24 literal entry types to their common supertype. `routes` satisfies
  // this by construction, so it is an assignment and not an assertion — and without it every
  // `route.params` below would read a property off a union of which two thirds of the members do
  // not declare it. The precise types are what the *caller's* `Handlers` is built from; in here,
  // where everything is already erased, they buy nothing.
  const table: Record<RouteKey, Route> = routes;
  return Object.entries(table).map(([key, route]): RouteBinding => {
    // One cast, and it is the seam this module exists to provide. `Object.entries` erases the
    // correlation between `key` and `routes[key]`, which no amount of generics recovers — TypeScript
    // has no way to express "this element's handler matches this element's route" over a
    // heterogeneous record. The type safety lives in `Handlers`, which is checked at the call site
    // before anything here runs.
    const handler = handlers[key as keyof Routes] as (input: {
      params: unknown;
      query: unknown;
      body: unknown;
    }) => Promise<unknown>;

    return {
      method: route.method,
      path: route.path,
      auth: route.auth,
      handle: async (req, res) => {
        const result = await handler({
          params: route.params === undefined ? undefined : parsePart(route.params, req.params, "params"),
          query: route.query === undefined ? undefined : parsePart(route.query, req.query, "query"),
          body: route.body === undefined ? undefined : parsePart(route.body, req.body, "body"),
        });

        if (route.response.kind === "binary") {
          if (!isBinary(result)) {
            // Unreachable through the typed map — `HandlerResult` makes a binary route's handler
            // return `BinaryPayload` — so this only fires for a handler that bypassed the types.
            // Answering with a 500 beats sending a JSON object under an image content type.
            throw new Error(`the handler for ${key} answered a binary route with a non-binary result`);
          }
          res.header("content-type", result.mimeType);
          if (result.filename !== undefined || result.disposition !== undefined) {
            // `attachment` when only a filename was given: of the two, it is the one that cannot
            // turn an attachment into a rendered document.
            const disposition = result.disposition ?? "attachment";
            const filename = result.filename;
            res.header(
              "content-disposition",
              filename === undefined ? disposition : `${disposition}; filename="${headerSafe(filename)}"`,
            );
          }
          res.status(200).send(result.bytes);
          return;
        }
        res.status(200).json(result);
      },
    };
  });
}
