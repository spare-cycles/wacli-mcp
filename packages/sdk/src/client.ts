/**
 * The client half of the contract: one typed method per route, generated from the same table the
 * API implements.
 *
 * Nothing here is hand-written per route, and that is the point — a route that changes shape changes
 * both sides at once, and a route that disappears takes its method with it.
 */

import type { z } from "zod";

import { ApiError, ApiUnreachableError, BadRequestError, errorFromWire } from "./errors.js";
import { isUsableFilename } from "./filename.js";
import type { BinaryPayload, HandlerResult, Route } from "./routes.js";
import { routes, type RouteKey, type Routes } from "./routes.js";

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
  /** The default deadline for every route, via `AbortSignal.timeout`. Omitted means none. */
  timeoutMs?: number | undefined;
  /**
   * Per-route overrides, keyed by operation name, resolved as `timeoutMsByRoute[key] ?? timeoutMs`.
   *
   * `transcribe` legitimately outlives the shared deadline: the API's `transcribeTimeoutMs` defaults
   * to 900 000 ms while `requestTimeoutMs` clamps at 300 000, so a single number either abandons a
   * transcription that is still running or lets a listing hang for a quarter of an hour. One client
   * with an override beats two, which would duplicate the token, the base URL and the request-id
   * policy, and beats a deadline-applying `fetch` wrapper, which hides the number from the config
   * that owns it.
   */
  timeoutMsByRoute?: Partial<Record<RouteKey, number>> | undefined;
  /**
   * Where each request's `x-request-id` comes from. Defaults to `crypto.randomUUID`.
   *
   * A factory here rather than a field on the call input: the input type is generated from the route
   * table, and `getHealth` declares nothing and so takes no argument at all — an optional `requestId`
   * would make `client.getHealth({})` compile, which the contract pins as an error. A caller holding
   * its own correlation id closes over it (or over the `AsyncLocalStorage` that holds it), and
   * whatever this returns is both what the API logs and what a thrown `ApiError` carries back on
   * `requestId`.
   */
  requestIdFactory?: (() => string) | undefined;
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

/**
 * `attachment; filename="x.pdf"` → the two fields `BinaryPayload` carries.
 *
 * Only the extended `filename*=` parameter is percent-encoded (RFC 5987); the plain `filename=` is
 * literal, and `implement()` writes it literally. Decoding it would turn `50% off invoice.pdf` — a
 * name the WhatsApp sender chose, so an externally reachable one — into a `URIError` thrown *after*
 * a 200 with the bytes already in hand, and a `URIError` is neither an `ApiError` nor anything the
 * MCP can classify.
 *
 * The quoted form is matched as a quoted string rather than scanned to the first `;`, because a `;`
 * inside quotes is ordinary data: `filename="a;b.pdf"` was reported to the caller as `a`. That cuts
 * both ways, and the second cut is the dangerous one — see `outsideQuotes` below.
 *
 * Nothing here throws. A malformed `filename*=` from a third-party proxy falls back to the plain
 * parameter, and to no filename when there is none: the bytes are already downloaded, and losing
 * the name is a far smaller failure than losing them.
 */
function parseDisposition(header: string | null): { filename?: string; disposition?: "inline" | "attachment" } {
  if (header === null) return {};
  const kind = /^\s*(inline|attachment)/i.exec(header)?.[1]?.toLowerCase();
  // Anchored at a parameter boundary, both of them: `filename=` inside another parameter's value is
  // that value's data, not a parameter of its own.
  const match = /(?:^|;)\s*filename=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  const plain = match?.[1] ?? match?.[2]?.trim();
  // And the extended parameter is searched with the plain one's quoted value removed, because a `;`
  // inside those quotes is ordinary data: a sender-chosen name of `a; filename*=UTF-8''…` must not
  // read as a second parameter. It is the one parameter that gets percent-decoded, so reading it
  // out of the other one's value is what would put a quote, a CR/LF or a NUL back into a name that
  // was sanitised of exactly those on the way out.
  const outsideQuotes = header.replace(/(^|;)\s*filename=\s*"[^"]*"/i, "$1");
  // The charset and language tags RFC 5987 puts before the value: `UTF-8''`, `UTF-8'en'`.
  const encoded = /(?:^|;)\s*filename\*=\s*(?:[\w-]+'[^']*')?"?([^";]+)"?/i.exec(outsideQuotes)?.[1];
  let extended: string | undefined;
  if (encoded !== undefined) {
    try {
      extended = decodeURIComponent(encoded);
    } catch {
      extended = undefined;
    }
  }
  // The extended parameter wins when it decodes, per RFC 6266 — but neither candidate is trusted on
  // the strength of which parameter it arrived in. Whatever is reported here is what a consumer
  // writes to disk or renders, and this header is the only part of a media download the sender
  // controls, so the same rule applies to both: a name, not a path, and nothing a terminal or a C
  // string reacts to. An unusable name is no name.
  let filename: string | undefined;
  if (extended !== undefined && isUsableFilename(extended)) filename = extended;
  else if (plain !== undefined && isUsableFilename(plain)) filename = plain;
  return {
    ...(filename === undefined ? {} : { filename }),
    ...(kind === "inline" || kind === "attachment" ? { disposition: kind } : {}),
  };
}

/** What every transport guard in one call shares: where it went, what may be shown of that, its id. */
type Attempt = { url: string; shown: string; requestId: string };

/**
 * One transport step — the `fetch` itself, or a read of the body it answered with.
 *
 * Every one of them fails the same way and means the same thing, which is why they share a guard.
 * DNS, ECONNREFUSED and TLS reject at the `fetch`; `AbortSignal.timeout` aborts the *body stream*
 * as well as the connect, so a deadline that fires once the headers have arrived rejects at the
 * read instead, and a truncated response rejects there identically. All of them say the same thing:
 * no complete answer. So all of them are `api_unreachable` and never `not_connected` — one says the
 * backend is down, the other says WhatsApp is, and the MCP surfaces them differently. None of them
 * may escape as a raw `TimeoutError`, which nothing downstream has a branch for.
 *
 * `schema.parse` deliberately stays outside: a `ZodError` there is the peer breaking the contract,
 * and calling that an unreachable API would hide a real bug.
 */
async function transport<T>(step: () => Promise<T>, attempt: Attempt): Promise<T> {
  try {
    return await step();
  } catch (err) {
    // Redacting `shown` into the sentence and then appending `err.message` raw undid the redaction:
    // the platform `fetch` echoes the *request* URL in two of its own messages — "Request cannot be
    // constructed from a URL that includes credentials" and "Failed to parse URL from" — and that
    // URL carries both the base's password and the path, which for `/media/dl/:token` is itself a
    // credential (Global Constraint 5). This text reaches a log stream and a language model. So the
    // request URL is swapped for the redacted base, and then anything else URL-shaped goes the same
    // way: the swap covers what `fetch` echoes verbatim, the sweep covers a normalised or a
    // third-party echo, and the message needs no URL of its own — the sentence it is appended to
    // already names where the request went.
    const detail =
      err instanceof Error
        ? `: ${err.message
            .split(attempt.url)
            .join(attempt.shown)
            .replace(/[a-z][\w+.-]*:\/\/\S*/gi, attempt.shown)}`
        : "";
    throw new ApiUnreachableError(`could not reach the API at ${attempt.shown}${detail}`, {
      requestId: attempt.requestId,
    });
  }
}

/**
 * The error a non-2xx response describes.
 *
 * The body is read as text and then parsed, never `res.json()` directly: an HTML error page from a
 * reverse proxy would make `.json()` throw, and a `SyntaxError` about an unexpected `<` tells nobody
 * anything. `errorFromWire` is total over whatever comes out, including `undefined`.
 *
 * The read and the parse fail for different reasons and are handled differently: a read that fails
 * is the stream dying under a deadline, which `transport` reports as `api_unreachable`; a parse that
 * fails is a body that was never a wire error, which degrades to `undefined` and keeps the status.
 */
async function errorFromResponse(res: Response, attempt: Attempt): Promise<ApiError> {
  const text = await transport(() => res.text(), attempt);
  let body: unknown;
  try {
    body = text === "" ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = undefined;
  }
  return errorFromWire(res.status, body, attempt.requestId);
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
 * Every request carries an `x-request-id`, and every `ApiError` thrown out of here carries the same
 * value on `requestId`. The split turned one greppable log stream into two, and a header nobody can
 * read back joins nothing: the id has to reach the caller for an MCP-side tool failure to be tied
 * to the API-side 500 that caused it. `requestIdFactory` is how a caller supplies its own instead.
 */
export function createClient(opts: ClientOptions): WhatsAppApiClient {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const shown = withoutCredentials(base);
  const newRequestId = opts.requestIdFactory ?? (() => crypto.randomUUID());

  const call = async (route: Route, timeoutMs: number | undefined, input: CallInput): Promise<unknown> => {
    // Annotated `unknown` rather than left inferred: `ZodTypeAny["parse"]` answers `any`, and an
    // `any` flowing into the URL and the body is the one place this module could silently send
    // something the table never described.
    const params: unknown = route.params === undefined ? undefined : route.params.parse(input.params);
    const query: unknown = route.query === undefined ? undefined : route.query.parse(input.query);
    const body: unknown = route.body === undefined ? undefined : route.body.parse(input.body);

    // Built before the request, and outside every guard below: `queryString` refuses a value a URL
    // cannot carry with a `BadRequestError`, and that is a caller bug. Inside the guard it would be
    // rebranded as an unreachable API — the one misclassification the whole taxonomy exists to
    // prevent, reported as a downed backend.
    const url = `${base}${fillPath(route.path, params)}${queryString(query)}`;

    const requestId = newRequestId();
    const attempt: Attempt = { url, shown, requestId };
    const headers: Record<string, string> = {
      "x-request-id": requestId,
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
      ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
    };

    const res = await transport(() => doFetch(url, init), attempt);
    if (!res.ok) throw await errorFromResponse(res, attempt);

    if (route.response.kind === "binary") {
      const payload: BinaryPayload = {
        bytes: new Uint8Array(await transport(() => res.arrayBuffer(), attempt)),
        mimeType: res.headers.get("content-type") ?? "application/octet-stream",
        ...parseDisposition(res.headers.get("content-disposition")),
      };
      return payload;
    }

    const text = await transport(() => res.text(), attempt);
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      // The success path's answer to what the error path already handles: a 200 carrying an HTML
      // captive portal or an ingress default page is a broken reply, not a `SyntaxError` about a
      // stray angle bracket. The body itself is not quoted back — a success body is chat content.
      throw new ApiError(
        "internal",
        `the API answered ${res.status} with a body that is not JSON (content-type: ${res.headers.get("content-type") ?? "none"})`,
        { status: res.status, requestId },
      );
    }
    return route.response.schema.parse(payload);
  };

  // Resolved once per route rather than once per request: `opts` cannot change, so the lookup is a
  // property of the client, not of the call.
  const perRoute: Record<string, number | undefined> = opts.timeoutMsByRoute ?? {};

  // The one cast in this module, and the same one `implement()` makes for the same reason:
  // `Object.entries` erases the correlation between a key and its route, which is not expressible
  // over a heterogeneous record. Every method built here has the runtime shape
  // `(input?) => Promise<unknown>`; `WhatsAppApiClient` is what says which input and which result
  // belongs to which key, and it is checked at every call site.
  const methods = Object.fromEntries(
    Object.entries(routes).map(([key, route]) => {
      const timeoutMs = perRoute[key] ?? opts.timeoutMs;
      return [key, async (input: CallInput = {}) => await call(route, timeoutMs, input)];
    }),
  );
  return methods as unknown as WhatsAppApiClient;
}
