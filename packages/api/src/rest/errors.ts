/**
 * The bridge between the throws this codebase makes and the errors the wire carries.
 *
 * **Nothing about the REST surface works without it, and the reason is easy to miss.** Every domain
 * error in `packages/api` extends plain `Error` — `NotFoundError`, `MessageRevokedError`,
 * `CursorError`, `ConnectionUnavailableError`, `MediaUnavailableError`, `ConversionError`,
 * `TranscriptionError` — and **none of them extends the SDK's `ApiError`**. So an error middleware
 * built the obvious way, `err instanceof ApiError ? … : 500`, answers 500 for every single one:
 * the 400 for a malformed cursor, the 403 for a read-only deployment, the 409 for an ambiguous
 * recipient and the 503 for a downed socket all become "internal server error". That is why
 * `toApiError` runs *first* in the middleware, ahead of any `instanceof ApiError` test.
 *
 * Two properties it must have, and both are load-bearing:
 *
 * 1. **It is total.** Anything unrecognised becomes `internal`/500 with the throw's own `name` and
 *    `message`, so a mapping gap degrades to a truthful server error rather than throwing inside
 *    the error handler.
 * 2. **It carries the original `name` and `message` onto the wire.** `packages/mcp`'s
 *    `describeError` renders `` `${name}: ${message}` `` straight into the model's context, and the
 *    split must not change a byte of it. That is what the wire envelope's `name` field is for, and
 *    it is why one code legitimately carries several names: a malformed cursor is `bad_request`
 *    with `name: "CursorError"`.
 *
 * The one place rule 2 is deliberately broken is a body-parser failure, and that is Global
 * Constraint 5 overruling it: body-parser's message quotes the payload it choked on
 * (`Unexpected token 'L', "LEAKMARKER"… is not valid JSON`), so it is a body echo. Those get a
 * canned message. No caller loses anything — the parser's own classification travels as
 * `errorType` in the log line, which is a fixed vocabulary rather than caller input.
 */

import {
  AmbiguousRecipientError as WireAmbiguousRecipientError,
  ApiError,
  BadRequestError,
  ConversionError as WireConversionError,
  MediaUnavailableError as WireMediaUnavailableError,
  MessageNotFoundError as WireMessageNotFoundError,
  MessageRevokedError as WireMessageRevokedError,
  NotConnectedError,
  NotFoundError as WireNotFoundError,
  NotOwnMessageError as WireNotOwnMessageError,
  RecipientNotFoundError as WireRecipientNotFoundError,
  SendPathError as WireSendPathError,
  TranscriptionError as WireTranscriptionError,
  UnsupportedMediaError,
} from "whatsapp-api-sdk";
import { ZodError, type ZodIssue } from "zod";

import { scrubUrls } from "../logger.js";
import { ConversionError, type ConversionErrorKind } from "../media/convert.js";
import { MediaUnavailableError, MessageNotFoundError } from "../media/store.js";
import { TranscriptionError } from "../media/transcribe.js";
import { ConnectionUnavailableError } from "../whatsapp/connection.js";
import { AmbiguousRecipientError, RecipientNotFoundError } from "../whatsapp/recipient.js";
import { MessageRevokedError, NotFoundError, NotOwnMessageError, SendPathError } from "../whatsapp/send.js";
import { CursorError } from "./cursor.js";

/** What a caller sees for any body the parser refused. Fixed text, because the parser's is not. */
const PARSE_REFUSAL = "the request body could not be read as JSON";
const TOO_LARGE_REFUSAL = "the request body is larger than this server accepts";
/** The one message a throw that is not an `Error` at all can honestly produce. */
const UNDESCRIBED = "an unexpected error occurred";

/**
 * body-parser's own classification of a failure, when this is one of its errors.
 *
 * `type` is the discriminator rather than `status` or the class, because it is the only field that
 * says *body-parser produced this*: an `err.status` of 400 is something anything can set, and the
 * class is a `SyntaxError` indistinguishable from one thrown by a handler. It is also a closed
 * vocabulary (`entity.too.large`, `entity.parse.failed`, `encoding.unsupported`, …), which is what
 * makes it safe to log where the message is not.
 */
function parserType(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { type } = err as { type?: unknown };
  return typeof type === "string" && type !== "" ? type : undefined;
}

/**
 * Every issue in a `ZodError` as `path: code`, joined.
 *
 * The `code` and not the `message`, and that is the difference between a safe string and a leak:
 * zod's `invalid_type` message quotes what it received and `invalid_enum_value` echoes the string
 * back verbatim. A query carries a search term and a body carries base64 file bytes, so a message
 * built from either would put caller content into a log line and a response. The issue codes are a
 * closed vocabulary and the paths come from the schema, not from the request.
 *
 * A `ZodError` reaching here at all is the uncommon path — `implement()` converts its own parse
 * failures to `BadRequestError` before they escape — so this covers a schema parsed inside a
 * handler, where the alternative is a 500 for an argument the caller got wrong.
 */
function describeIssues(issues: readonly ZodIssue[]): string {
  const rendered = issues.map((issue) =>
    issue.path.length === 0 ? issue.code : `${issue.path.join(".")}: ${issue.code}`,
  );
  return rendered.length === 0 ? "the request could not be validated" : rendered.join("; ");
}

/**
 * Which wire code each conversion outcome answers with.
 *
 * `media/convert.ts` raises one `ConversionError` class across four genuinely different outcomes
 * and tags each with a `kind` precisely so this layer need not read its prose. Reading the prose is
 * the failure this table exists to prevent: a permanently unconvertible attachment answered as a
 * server fault is retried and alerted on forever, for a condition no retry and no parameter can
 * change.
 *
 * The names are all `ConversionError`, whatever the code — the class the model has been reading is
 * one class, and `describeError` renders the name.
 */
const CONVERSION_CODE: Record<ConversionErrorKind, (message: string, name: string) => ApiError> = {
  // The caller's arguments are wrong and only the caller can fix them.
  "invalid-argument": (message, name) => new BadRequestError(message, { name }),
  // The bytes are not there. Nobody's parameters are at fault and nothing helps until they return.
  "source-missing": (message, name) => new WireNotFoundError(message, { name }),
  // The file is there and can never become what was asked for. Permanent; a retry is wasted.
  "source-unsupported": (message, name) => new UnsupportedMediaError(message, { name }),
  // A tool is missing, timed out, or this machine broke one of its own invariants.
  internal: (message, name) => new WireConversionError(message, { name }),
};

/**
 * A throw, as the error the wire can carry.
 *
 * Ordered as it reads: the pass-through first, then the two families whose messages this layer owns
 * rather than forwards, then one line per domain class — which is the mapping table, written out.
 */
export function toApiError(err: unknown): ApiError {
  // Identity, not a rebuild. An `ApiError` already carries its code, its status and — for
  // `ambiguous_recipient` — the `details.candidates` a caller retries with; re-deriving any of that
  // from the class would drop the details and second-guess a decision the throw site already made.
  if (err instanceof ApiError) return err;

  const parser = parserType(err);
  if (parser !== undefined) {
    return parser === "entity.too.large"
      ? new ApiError("payload_too_large", TOO_LARGE_REFUSAL, { name: "PayloadTooLargeError" })
      : new BadRequestError(PARSE_REFUSAL, { name: err instanceof Error ? err.name : "Error" });
  }

  if (err instanceof ZodError) return new BadRequestError(`invalid request: ${describeIssues(err.issues)}`);

  if (err instanceof ConversionError) return CONVERSION_CODE[err.kind](err.message, err.name);

  // One line per row of the table. Each carries the throw's own `name` explicitly rather than
  // relying on the wire class's default: the two agree today, and passing it is what keeps them
  // agreeing if a domain class is ever subclassed with a name of its own.
  if (err instanceof CursorError) return new BadRequestError(err.message, { name: err.name });
  if (err instanceof SendPathError) return new WireSendPathError(err.message, { name: err.name });
  if (err instanceof RecipientNotFoundError) return new WireRecipientNotFoundError(err.message, { name: err.name });
  if (err instanceof NotFoundError) return new WireNotFoundError(err.message, { name: err.name });
  if (err instanceof MessageNotFoundError) return new WireMessageNotFoundError(err.message, { name: err.name });
  if (err instanceof AmbiguousRecipientError) return new WireAmbiguousRecipientError(err.message, { name: err.name });
  if (err instanceof MessageRevokedError) return new WireMessageRevokedError(err.message, { name: err.name });
  if (err instanceof NotOwnMessageError) return new WireNotOwnMessageError(err.message, { name: err.name });
  if (err instanceof ConnectionUnavailableError) return new NotConnectedError(err.message, { name: err.name });
  if (err instanceof MediaUnavailableError) return new WireMediaUnavailableError(err.message, { name: err.name });
  if (err instanceof TranscriptionError) return new WireTranscriptionError(err.message, { name: err.name });

  // Everything else, including a bare `new Error(...)`. A plain `Error` is a *fault* here and not a
  // refusal: the four argument-validation sites in `whatsapp/send.ts` and `whatsapp/recipient.ts`
  // that used to throw one now throw `BadRequestError`, whose `name` is the literal "Error" so
  // nothing a model reads changed. `implement()` depends on this branch — it throws a plain `Error`
  // for a handler that answered the wrong shape and documents that the API reports it as a 500.
  if (err instanceof Error) return new ApiError("internal", err.message, { name: err.name });
  return new ApiError("internal", UNDESCRIBED, { name: "Error" });
}

export type ErrorDetail = {
  /** body-parser's classification when it produced the failure, otherwise the throw's `name`. */
  errorType: string;
  /** The message the wire carries — canned for a parser failure, and scrubbed of absolute URLs. */
  errorMessage: string;
  /** Present only for a fault this server produced; see below. */
  stack: string | undefined;
};

/**
 * The fields a failed request contributes to a log line — and the reason a log line is never handed
 * the error itself.
 *
 * pino's standard error serializer copies `message`, `stack` **and every own enumerable key**
 * (`pino-std-serializers/lib/err.js`), so one `{ err }` writes whatever the thrower hung off it.
 * That is not hypothetical: body-parser attaches the entire raw request body to a parse failure
 * (`createError(400, err, { body: str })`), bounded only by the ~90 MB parser limit. Picking fields
 * explicitly keeps that true no matter what an error grows later.
 *
 * `errorMessage` is taken from the **mapped** error rather than the raw one, which is what makes it
 * safe by construction: `toApiError` has already replaced a parser failure's body-quoting message
 * with a canned one, and everything else here is a message the response is about to carry to the
 * caller anyway. It is scrubbed of absolute URLs on top of that, because baileys raises
 * `` `Failed to fetch stream from ${url}` `` on an expired media URL and that URL is a capability
 * granting the attachment's bytes to whoever reads the log.
 *
 * `stack` is omitted for a parser failure, and that is not tidiness: V8 builds a stack's first line
 * from `Name: message`, so the stack of a parse failure is a body echo too.
 */
export function errorDetail(err: unknown): ErrorDetail {
  const parser = parserType(err);
  const mapped = toApiError(err);
  return {
    errorType: parser ?? (err instanceof Error ? err.name : typeof err),
    errorMessage: scrubUrls(mapped.message),
    stack: parser === undefined && err instanceof Error ? err.stack : undefined,
  };
}
