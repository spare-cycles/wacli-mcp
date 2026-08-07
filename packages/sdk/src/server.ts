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

import type { z } from "zod";

import { BadRequestError } from "./errors.js";
import { extendedFilenameValue, isUsableFilename } from "./filename.js";
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
 * Every issue in a `ZodError`, rendered as `path: shape` and joined — the failing fields, never the
 * values they carried.
 *
 * A body can carry base64 file bytes and a query can carry a search term, so Global Constraint 5
 * applies to a validation message as much as to a log line. Zod's own messages are shapes
 * ("Expected number, received nan") with exactly one exception: `invalid_enum_value` echoes the
 * received string back. That one is rewritten from the schema's own `options`, which makes the
 * guarantee real rather than merely observed — the next enum-typed field added to a request schema
 * inherits it instead of quietly breaking it.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const message =
        issue.code === "invalid_enum_value"
          ? `expected one of ${issue.options.map((option) => String(option)).join(" | ")}`
          : issue.message;
      return issue.path.length === 0 ? message : `${issue.path.join(".")}: ${message}`;
    })
    .join("; ");
}

/**
 * Parse one part of a request, or refuse it as `bad_request`.
 *
 * A `ZodError` escaping here would reach the API's error middleware as an unrecognised throw and be
 * reported as `internal`/500 — a server-fault status for an argument the caller got wrong, and the
 * wrong retry advice. `BadRequestError` carries the name `"Error"`, which is what every bare
 * validation throw in this codebase renders as today, so the model-visible text does not change.
 */
function parsePart(schema: z.ZodTypeAny, value: unknown, part: string): unknown {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new BadRequestError(`invalid ${part}: ${describeIssues(parsed.error)}`);
}

/** A JSON handler's result is whatever its schema infers; a binary one's is always this shape. */
function isBinary(result: unknown): result is BinaryPayload {
  return typeof result === "object" && result !== null && "bytes" in result;
}

/**
 * The `content-disposition` value for a binary payload.
 *
 * The plain `filename=` parameter is an HTTP quoted-string and the filename is chosen by the
 * WhatsApp sender, so every character that means something to the parser rather than to the reader
 * goes: a quote would end the string early, a backslash is a quoted-pair that escapes the next
 * character — or the closing quote, for a name ending in one — and a CR or LF would split the
 * header. So does `;`, and that one is not header injection but *parameter* injection: a name of
 * `a; filename*=UTF-8''%2E%2E%2F%2E%2E%2Fetc%2Fpasswd` is one filename to a spec-correct parser and
 * two parameters to a lenient one, and the second decodes back to `../../etc/passwd`. `/` and `:`
 * go too, because a name with either in it is a path rather than a name — a drive-relative one or
 * an alternate data stream, for the colon. Every non-printable and non-ASCII byte becomes `_`
 * rather than being escaped: this parameter is the fallback a client uses when it has nothing
 * better, and Node refuses to send a header value carrying them at all.
 *
 * That sanitising is lossy, so it is not the only thing written. When the real name differs and is
 * still a name a consumer can use, `filename*=` carries it percent-encoded (RFC 8187) — the
 * parameter that survives a `;`, a quote or an accent intact and inert, because a client decodes it
 * as a value and never re-parses it as parameters. `extendedFilenameValue` applies that rule itself
 * rather than trusting this call site to have applied it, which is what keeps the guard and the
 * encoder from disagreeing about which names are safe to encode.
 *
 * The two parameters are judged **separately**, and that is the fix to a bug rather than a nicety.
 * Gating the lossless parameter on the lossy one threw away 768 names the rule accepts: `nul;`
 * folds to `nul`, a Win32 device, and `;` and `. ;` fold to nothing at all, so a name the encoder
 * carries cleanly was answered with a bare `attachment` and no filename anywhere. `filename*=` on
 * its own is legal RFC 6266 — `filename-parm` is the plain form **or** the ext-value form, never
 * required to be both — and a parser that understands only the plain form is no worse off than it
 * was with no filename at all. So the header has four shapes: neither parameter, one, the other, or
 * both. The extended-only one is not a new way in: `extendedFilenameValue` emits nothing unless
 * `isUsableFilename` accepts the name, and what it does emit is `encodeURIComponent` plus an escape
 * of `!'()*`, whose entire output alphabet is `[A-Za-z0-9._~-]` and `%XX` — no `;`, no `=`, no
 * quote, no backslash, no CR or LF, nothing non-ASCII. There is no character left in it for a
 * lenient parser to read as a parameter boundary, which is exactly why this is the parameter the
 * unrepresentable name goes into. A name whose *fold* is a device name is safer here than it was
 * before, too: the plain `filename="nul"` that a Win32 client would have written to the null device
 * is not emitted at all.
 *
 * Plain first, extended second, per RFC 6266 Appendix D: a parser that understands only the
 * fallback reads the fallback, and one that understands both prefers the extended.
 */
function contentDisposition(disposition: string, filename: string | undefined): string {
  // Typed `string` rather than the payload's own `"inline" | "attachment"`, because the only thing
  // that can put anything else here is a handler that bypassed the types — a cast, or a value read
  // from a row — and that is exactly what this line is for. It is the last unchecked path into this
  // header now that the filename beside it is guarded, and `attachment\r\nX-Evil: 1` splits it.
  // `attachment` is the safe half of the pair: it cannot turn a download into a rendered document.
  const kind = disposition === "inline" ? "inline" : "attachment";
  if (filename === undefined) return kind;
  const plain = filename.replace(/[^ -~]/g, "_").replace(/["\\;/:]/g, "");
  // Computed before the fold is judged, because the fold's verdict is not the name's.
  const extended = plain === filename ? undefined : extendedFilenameValue(filename);
  if (!isUsableFilename(plain)) return extended === undefined ? kind : `${kind}; filename*=UTF-8''${extended}`;
  if (extended === undefined) return `${kind}; filename="${plain}"`;
  return `${kind}; filename="${plain}"; filename*=UTF-8''${extended}`;
}

/** The one thing about `implement()` that is a policy rather than a contract. */
export type ImplementOptions = {
  /**
   * Check each JSON handler's result against its route's response schema before writing it.
   *
   * Off by default, and the default is the decision, not an omission. The client `.parse`s every
   * JSON response on the way in, so a handler that answers a millisecond timestamp — a `number`,
   * therefore invisible to `tsc`, and refused by `epochSeconds`'s `lt(1e11)` — is already caught;
   * the only question is *where*. On, the failure is a 500 next to the handler that caused it. Off,
   * it is a `ZodError` in the MCP, one process away from the bug, with the API logging nothing.
   *
   * The reason it is not simply on: the API is a product surface with consumers other than this
   * SDK's client, and turning a response those consumers accept today into a 500 is a behaviour
   * change nobody asked for. As a development and test switch it costs them nothing.
   *
   * The validated value is discarded and the handler's own result is written, so a schema that
   * strips unknown keys cannot make the response differ between the two settings.
   */
  validateResponses?: boolean | undefined;
};

/**
 * Turn a fully typed handler map into bindings the API can mount.
 *
 * Iterating `routes` rather than `handlers` is deliberate: the table is the source of truth for what
 * exists, and the mapped type already guarantees the map has an entry for every key.
 */
export function implement(handlers: Handlers, options: ImplementOptions = {}): RouteBinding[] {
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
            res.header("content-disposition", contentDisposition(result.disposition ?? "attachment", result.filename));
          }
          res.status(route.successStatus ?? 200).send(result.bytes);
          return;
        }

        if (options.validateResponses === true) {
          const checked = route.response.schema.safeParse(result);
          if (!checked.success) {
            // A plain `Error`, so the API's middleware reports `internal`/500: the handler is at
            // fault, not the caller. The issues are rendered the same value-free way a refused
            // request is — a response carries message text, and this text is logged.
            throw new Error(
              `the handler for ${key} answered a result its route's schema refuses: ${describeIssues(checked.error)}`,
            );
          }
        }
        res.status(route.successStatus ?? 200).json(result);
      },
    };
  });
}
