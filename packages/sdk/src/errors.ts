/**
 * The error taxonomy the API and the MCP share.
 *
 * The whole file exists to serve one constraint: `packages/mcp`'s `describeError` renders
 * `` `${err.name}: ${err.message}` `` straight into the model's context, and the split must not
 * change a byte of it. Before the split every failure was an in-process throw whose class the MCP
 * could see; after it, the same failure is an HTTP response. So the wire carries the original
 * `name` alongside the code, and `errorFromWire` rebuilds an error that renders identically.
 *
 * That is also why several classes here are named differently from the code they carry
 * (`NotConnectedError` sets `name = "ConnectionUnavailableError"`) and why plain `Error` is a
 * first-class outcome: four live throw sites are bare `new Error(...)`, and rendering those as
 * `ApiError: …` would be a silent regression with no failing test to catch it.
 */

import { z } from "zod";

/**
 * Every code that may appear on the wire.
 *
 * `api_unreachable` is deliberately absent: it is raised by the client when it could not reach the
 * API at all, so an API that sent it would be describing a state it cannot be in.
 */
export const API_ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "not_found",
  "message_not_found",
  "media_unavailable",
  "conversion_failed",
  "ambiguous_recipient",
  "recipient_not_found",
  "read_only",
  "not_connected",
  "transcription_unavailable",
  "budget_exhausted",
  "payload_too_large",
  "internal",
  "message_revoked",
  "not_own_message",
  "send_path_refused",
] as const;

/** A code valid on the wire. */
export type WireErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * Every code an `ApiError` can carry: the wire set plus the one client-side outcome.
 *
 * The union is wider than `API_ERROR_CODES` on purpose. `wireError` must stay closed over what the
 * API can actually send, but `ApiUnreachableError` is still an `ApiError` and still needs a code a
 * consumer can switch on — spec §3.2 asks for it by name so a model can tell "WhatsApp is down"
 * from "my backend is down".
 */
export type ApiErrorCode = WireErrorCode | "api_unreachable";

export const wireError = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    /**
     * The original error's `name`, so the client can reconstruct the exact string
     * `describeError` renders. Required, not optional: several live throw sites are bare
     * `new Error(...)` whose name is literally "Error", and losing that changes tool output.
     */
    name: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});

export type WireError = z.infer<typeof wireError>;

/**
 * Per code: the HTTP status it answers with, and the `name` to fall back on when the wire did not
 * carry one.
 *
 * The names are not decoration — each is the `name` of the in-process class this code replaces,
 * read off the throw site. The four codes that answer `"Error"` are the ones with no legacy class
 * behind them: either a bare `new Error(...)` throw (`bad_request`) or a refusal the split itself
 * introduces.
 */
const CODE_SPEC: Record<ApiErrorCode, { status: number; name: string }> = {
  // `whatsapp/recipient.ts:101`, `whatsapp/send.ts:261`, `:337`, `:400`, `mcp/tools/reads.ts:173`
  // and `mcp/tools/writes.ts:163`, `:167` all throw a bare `Error`, and `implement()`'s own
  // `ZodError` parse failure lands here too. "Error" is the name every one of those renders with
  // today. `mcp/cursor.ts:29`'s `CursorError` is here as well, keeping only its `name`; see the
  // note where its class used to be. The list is load-bearing, not documentation: Task 7's
  // `toApiError` maps off it, and a bare `Error` missing from it falls through to `internal`/500 —
  // a server-fault status for an argument-validation refusal. `LIVE_THROWS` in `errors.test.ts`
  // pins each one's message.
  bad_request: { status: 400, name: "Error" },
  send_path_refused: { status: 400, name: "SendPathError" },
  unauthorized: { status: 401, name: "Error" },
  read_only: { status: 403, name: "Error" },
  not_found: { status: 404, name: "NotFoundError" },
  message_not_found: { status: 404, name: "MessageNotFoundError" },
  recipient_not_found: { status: 404, name: "RecipientNotFoundError" },
  ambiguous_recipient: { status: 409, name: "AmbiguousRecipientError" },
  message_revoked: { status: 409, name: "MessageRevokedError" },
  not_own_message: { status: 409, name: "NotOwnMessageError" },
  payload_too_large: { status: 413, name: "PayloadTooLargeError" },
  // Reserved and mapped, but nothing throws it: today an exhausted budget is only *read*, for the
  // health report. Adding a refusal under cover of a refactor would be new behaviour.
  budget_exhausted: { status: 429, name: "Error" },
  internal: { status: 500, name: "Error" },
  conversion_failed: { status: 502, name: "ConversionError" },
  not_connected: { status: 503, name: "ConnectionUnavailableError" },
  media_unavailable: { status: 503, name: "MediaUnavailableError" },
  transcription_unavailable: { status: 503, name: "TranscriptionError" },
  // No HTTP exchange happened, so there is no status to report. 0 says that; 503 would claim the
  // API answered.
  api_unreachable: { status: 0, name: "ApiUnreachableError" },
};

export type ApiErrorOptions = {
  /** Overrides the code's canonical status with what the response actually carried. */
  status?: number | undefined;
  /** Overrides the code's fallback name with the original throw's `name`, straight off the wire. */
  name?: string | undefined;
  details?: Record<string, unknown> | undefined;
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ApiErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message);
    const spec = CODE_SPEC[code];
    this.code = code;
    this.status = options.status ?? spec.status;
    this.name = options.name ?? spec.name;
    this.details = options.details;
  }
}

/**
 * One subclass per code that has a legacy in-process class behind it, so a consumer can narrow with
 * `instanceof` exactly where it used to. The five codes without one (`unauthorized`, `read_only`,
 * `payload_too_large`, `budget_exhausted`, `internal`) are plain `ApiError`s — inventing a class
 * for a failure that has never had one would be a shape nobody can name.
 *
 * Each takes the same `(message, options)` pair as the base so `errorFromWire` can hand every one
 * of them the wire's `name` and `status` without a special case per class.
 */
export class BadRequestError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super("bad_request", message, options);
  }
}

// There is no `CursorError` class, and its absence is the design.
//
// A malformed cursor answers `bad_request`/400 with `name: "CursorError"`, so `describeError` still
// renders `CursorError: invalid pagination cursor: …` byte for byte — the name travels on the wire,
// which is what the field is for. One code, many names: the code is what a client branches on, the
// name is what the model reads.
//
// A class here would be worse than nothing. `errorFromWire` reconstructs from the code alone, so
// `bad_request` always comes back a `BadRequestError`; a `CursorError` would be a narrowing that
// compiles, reads correctly, and never matches anything that crossed the wire. That is the exact
// failure the `not_found`/`message_not_found` test guards against, and it is not worth inviting for
// a refusal whose only distinguishing feature is a string the envelope already carries.

export class SendPathError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super("send_path_refused", message, options);
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super("not_found", message, options);
  }
}

export class MessageNotFoundError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super("message_not_found", message, options);
  }
}

export class RecipientNotFoundError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super("recipient_not_found", message, options);
  }
}

/** Carries `details.candidates`: the numbered list the refusal asks the caller to `pick` from. */
export class AmbiguousRecipientError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super("ambiguous_recipient", message, options);
  }
}

export class MessageRevokedError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super("message_revoked", message, options);
  }
}

export class NotOwnMessageError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super("not_own_message", message, options);
  }
}

export class MediaUnavailableError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super("media_unavailable", message, options);
  }
}

export class ConversionError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super("conversion_failed", message, options);
  }
}

/**
 * The class name and the `name` field differ on purpose: the code is `not_connected`, but the
 * in-process class this replaces was `ConnectionUnavailableError` and the model has been reading
 * that word for as long as the tool has existed.
 */
export class NotConnectedError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super("not_connected", message, options);
  }
}

export class TranscriptionError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super("transcription_unavailable", message, options);
  }
}

/**
 * Client-side only, never on the wire: the MCP could not reach the API at all.
 *
 * Distinct from `NotConnectedError` because the two ask for different remedies — one says WhatsApp
 * is down, the other says this process cannot find its own backend.
 */
export class ApiUnreachableError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super("api_unreachable", message, options);
  }
}

/** Code → the class that carries it. Total over `ApiErrorCode`, so `errorFromWire` never branches. */
const CONSTRUCT: Record<ApiErrorCode, (message: string, options: ApiErrorOptions) => ApiError> = {
  bad_request: (m, o) => new BadRequestError(m, o),
  send_path_refused: (m, o) => new SendPathError(m, o),
  unauthorized: (m, o) => new ApiError("unauthorized", m, o),
  read_only: (m, o) => new ApiError("read_only", m, o),
  not_found: (m, o) => new NotFoundError(m, o),
  message_not_found: (m, o) => new MessageNotFoundError(m, o),
  recipient_not_found: (m, o) => new RecipientNotFoundError(m, o),
  ambiguous_recipient: (m, o) => new AmbiguousRecipientError(m, o),
  message_revoked: (m, o) => new MessageRevokedError(m, o),
  not_own_message: (m, o) => new NotOwnMessageError(m, o),
  payload_too_large: (m, o) => new ApiError("payload_too_large", m, o),
  budget_exhausted: (m, o) => new ApiError("budget_exhausted", m, o),
  internal: (m, o) => new ApiError("internal", m, o),
  conversion_failed: (m, o) => new ConversionError(m, o),
  not_connected: (m, o) => new NotConnectedError(m, o),
  media_unavailable: (m, o) => new MediaUnavailableError(m, o),
  transcription_unavailable: (m, o) => new TranscriptionError(m, o),
  api_unreachable: (m, o) => new ApiUnreachableError(m, o),
};

/**
 * The shape `errorFromWire` actually reads.
 *
 * Deliberately looser than `wireError`: an unknown `code` degrades to `internal` and an absent
 * `name` falls back to `CODE_SPEC`, because a client that throws while decoding an error report
 * replaces a legible failure with an illegible one. `wireError` stays strict — it is what the API
 * validates itself against, and what a contract test pins.
 */
const lenientWireError = z.object({
  error: z.object({
    code: z.string().optional(),
    name: z.string().optional(),
    message: z.string().optional(),
    details: z.record(z.unknown()).optional(),
  }),
});

/** The one message a body that carried none can honestly claim. */
const UNDESCRIBED = "the API reported an error with no message";

/**
 * An HTTP error response, back into the error it started as.
 *
 * Total: a body that is not a wire error at all still yields an `ApiError`, because the alternative
 * is a `ZodError` escaping the client and telling the model about a field it never asked for.
 */
export function errorFromWire(status: number, body: unknown): ApiError {
  const parsed = lenientWireError.safeParse(body);
  const wire = parsed.success ? parsed.data.error : undefined;
  const raw = wire?.code;
  const code: ApiErrorCode =
    raw !== undefined && (API_ERROR_CODES as readonly string[]).includes(raw) ? (raw as WireErrorCode) : "internal";
  return CONSTRUCT[code](wire?.message ?? UNDESCRIBED, {
    // The status the response actually carried wins over the code's canonical one: a proxy or a
    // gateway may answer for the API, and reporting the code's status would describe a reply that
    // never happened.
    status,
    // An empty name is treated as absent: it would render as ": message", which names nothing.
    name: wire?.name === "" ? undefined : wire?.name,
    details: wire?.details,
  });
}

/**
 * A throw, into the HTTP error response that reports it.
 *
 * Always carries the original `name` — that is the whole reason the field exists. Anything that is
 * not an `ApiError` degrades to `internal`/500 rather than leaking a stack.
 */
export function errorToWire(err: unknown): { status: number; body: WireError } {
  if (err instanceof ApiError) {
    // `api_unreachable` is client-side and has no status; were one ever serialised, it is an
    // internal fault by the only definition the wire has.
    const onWire: WireErrorCode = err.code === "api_unreachable" ? "internal" : err.code;
    return {
      status: err.status > 0 ? err.status : CODE_SPEC[onWire].status,
      body: { error: { code: onWire, name: err.name, message: err.message, details: err.details } },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "internal",
        name: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : UNDESCRIBED,
        details: undefined,
      },
    },
  };
}
