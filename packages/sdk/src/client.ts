/**
 * The client half of the contract: one typed method per route, generated from the same table the
 * API implements.
 *
 * Nothing here is hand-written per route, and that is the point — a route that changes shape changes
 * both sides at once, and a route that disappears takes its method with it.
 */

import type { z } from "zod";

import { ApiError, ApiUnreachableError, BadRequestError, errorFromWire } from "./errors.js";
import type { BinaryPayload, HandlerResult, Route } from "./routes.js";
import { routes, type Routes } from "./routes.js";

/**
 * The parts of a request a route actually declares.
 *
 * Each is **required exactly when the route declares it**. Making them all optional would let
 * `client.sendText({})` compile and fail only at runtime, which defeats the point of generating the
 * client from the table; making them all required would force `params: undefined` on every listing.
 * A route that declares none of the three intersects to `object`, which has no keys — which is what
 * `ClientMethod` tests to give it a zero-argument signature.
 */
type Declared<R extends Route> = (R["params"] extends z.ZodTypeAny ? { params: z.infer<R["params"]> } : object) &
  (R["query"] extends z.ZodTypeAny ? { query: z.infer<R["query"]> } : object) &
  (R["body"] extends z.ZodTypeAny ? { body: z.infer<R["body"]> } : object);

export type ClientMethod<R extends Route> = keyof Declared<R> extends never
  ? () => Promise<HandlerResult<R>>
  : (input: Declared<R>) => Promise<HandlerResult<R>>;

export type WhatsAppApiClient = { [K in keyof Routes]: ClientMethod<Routes[K]> };

/**
 * Every optional field is `?: T | undefined`, matching `ApiErrorOptions` in `errors.ts` and for the
 * same reason: under `exactOptionalPropertyTypes` a bare `?: T` refuses an explicit `undefined`, and
 * the MCP's config holds `apiToken: string | undefined`. Without the widening every caller would
 * have to build the options object through a conditional spread to pass a value it already has.
 */
export type ClientOptions = {
  baseUrl: string;
  token?: string | undefined;
  /** Injectable so tests drive the client without a listener. */
  fetch?: typeof globalThis.fetch | undefined;
  /** Per request, via `AbortSignal.timeout`. Omitted means no deadline of the client's own. */
  timeoutMs?: number | undefined;
};

/** What a client method is handed at runtime, once the types have been erased. */
type CallInput = { params?: unknown; query?: unknown; body?: unknown };

/**
 * `:param` segments, filled from the parsed params.
 *
 * Each value is percent-encoded: a chat id contains `@` and a signed token is base64url, and a
 * caller-supplied id that happened to contain `/` would otherwise silently address a different
 * route.
 */
function fillPath(path: string, params: unknown): string {
  if (params === undefined) return path;
  const values = params as Record<string, string>;
  return path.replaceAll(/:([A-Za-z]+)/g, (_match, name: string) => encodeURIComponent(values[name] ?? ""));
}

/**
 * The query string for a validated query object.
 *
 * `undefined` fields are dropped rather than sent empty — `?archived=` is a different request from
 * omitting the filter, and the schema would refuse the first.
 *
 * Only the three primitive kinds a query schema in this contract declares are serialised. Anything
 * else is refused rather than stringified: an object would go out as `[object Object]`, which the
 * server would then reject with a message about a shape nobody sent.
 */
function queryString(query: unknown): string {
  if (query === undefined) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new BadRequestError(`invalid query: ${key} is not a value a URL can carry`);
    }
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered === "" ? "" : `?${rendered}`;
}

/** `attachment; filename="x.pdf"` → the two fields `BinaryPayload` carries. */
function parseDisposition(header: string | null): { filename?: string; disposition?: "inline" | "attachment" } {
  if (header === null) return {};
  const kind = /^\s*(inline|attachment)/i.exec(header)?.[1]?.toLowerCase();
  const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header)?.[1];
  return {
    ...(filename === undefined ? {} : { filename: decodeURIComponent(filename) }),
    ...(kind === "inline" || kind === "attachment" ? { disposition: kind } : {}),
  };
}

/**
 * The error a non-2xx response describes.
 *
 * The body is read as text and then parsed, never `res.json()` directly: an HTML error page from a
 * reverse proxy would make `.json()` throw, and a `SyntaxError` about an unexpected `<` tells nobody
 * anything. `errorFromWire` is total over whatever comes out, including `undefined`.
 */
async function errorFromResponse(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    const text = await res.text();
    body = text === "" ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = undefined;
  }
  return errorFromWire(res.status, body);
}

/**
 * The base URL with any credentials stripped.
 *
 * It goes into the one message this client writes itself, and a `http://user:pass@host` base would
 * otherwise put a password in front of a language model and into two log streams (Global Constraint
 * 5). A base that is not a parseable URL is returned unchanged: it cannot carry a userinfo section,
 * and a `fetch` against it will fail with something more useful than this function guessing.
 */
function withoutCredentials(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

/**
 * A typed client for the route table.
 *
 * Requests are validated on the way out and JSON responses are `.parse`d on the way in, so a field
 * the API stops sending becomes a thrown parse error at the boundary rather than an `undefined`
 * discovered three layers away. Both directions throw a `ZodError` rather than an `ApiError`, and
 * that is deliberate: outbound, the caller's own process built the bad value and the stack points
 * at the bug; inbound, the peer broke the contract, and no error *code* honestly describes that —
 * `bad_request` would claim an HTTP refusal that never happened.
 *
 * Every request carries an `x-request-id`. The split turned one greppable log stream into two, and
 * without a shared id an MCP-side tool failure caused by an API-side 500 cannot be tied to its
 * cause. It costs a header and a UUID; recovering the correlation afterwards costs an afternoon.
 */
export function createClient(opts: ClientOptions): WhatsAppApiClient {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const shown = withoutCredentials(base);

  const call = async (route: Route, input: CallInput): Promise<unknown> => {
    // Annotated `unknown` rather than left inferred: `ZodTypeAny["parse"]` answers `any`, and an
    // `any` flowing into the URL and the body is the one place this module could silently send
    // something the table never described.
    const params: unknown = route.params === undefined ? undefined : route.params.parse(input.params);
    const query: unknown = route.query === undefined ? undefined : route.query.parse(input.query);
    const body: unknown = route.body === undefined ? undefined : route.body.parse(input.body);

    const headers: Record<string, string> = {
      "x-request-id": crypto.randomUUID(),
      // What this route actually answers. Asking for JSON on the raw download would let a strict
      // server answer 406 for a request the contract says is well formed.
      accept: route.response.kind === "binary" ? "*/*" : "application/json",
    };
    if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    const init: RequestInit = {
      method: route.method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(opts.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(opts.timeoutMs) }),
    };

    let res: Response;
    try {
      res = await doFetch(`${base}${fillPath(route.path, params)}${queryString(query)}`, init);
    } catch (err) {
      // DNS, ECONNREFUSED, TLS, an abort from `timeoutMs` — no HTTP exchange happened, so this is
      // `api_unreachable` and never `not_connected`. The two mean different things: one says the
      // backend is down, the other says WhatsApp is, and the MCP surfaces them differently.
      throw new ApiUnreachableError(
        err instanceof Error
          ? `could not reach the API at ${shown}: ${err.message}`
          : `could not reach the API at ${shown}`,
      );
    }

    if (!res.ok) throw await errorFromResponse(res);

    if (route.response.kind === "binary") {
      const payload: BinaryPayload = {
        bytes: new Uint8Array(await res.arrayBuffer()),
        mimeType: res.headers.get("content-type") ?? "application/octet-stream",
        ...parseDisposition(res.headers.get("content-disposition")),
      };
      return payload;
    }
    return route.response.schema.parse(await res.json());
  };

  // The one cast in this module, and the same one `implement()` makes for the same reason:
  // `Object.entries` erases the correlation between a key and its route, which is not expressible
  // over a heterogeneous record. Every method built here has the runtime shape
  // `(input?) => Promise<unknown>`; `WhatsAppApiClient` is what says which input and which result
  // belongs to which key, and it is checked at every call site.
  const methods = Object.fromEntries(
    Object.entries(routes).map(([key, route]) => [key, async (input: CallInput = {}) => await call(route, input)]),
  );
  return methods as unknown as WhatsAppApiClient;
}
