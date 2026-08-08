/**
 * One case per row of the domain-throw → code → status table, asserting `code`, `status`, `name`
 * and `message` together.
 *
 * All four, because each catches a different regression and three of them pass while the fourth is
 * broken. `code` is what a client branches on; `status` is what a proxy, a retry policy and an
 * alerting rule read; `name` and `message` are what `packages/mcp`'s `describeError` renders
 * verbatim into the model's context. A mapping that gets the code right and the name wrong turns
 * `CursorError: …` into `Error: …` with every status assertion still green.
 *
 * The messages here are the ones `LIVE_THROWS` in `packages/sdk/src/errors.test.ts` pins against the
 * real throw sites. They are duplicated rather than imported: that file is a test, and a shared
 * fixture would let one edit move both sides at once, which is the one thing a pin must not permit.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  AmbiguousRecipientError as SdkAmbiguousRecipientError,
  ApiError,
  BadRequestError,
  ConversionError as SdkConversionError,
  MediaUnavailableError as SdkMediaUnavailableError,
  MessageNotFoundError as SdkMessageNotFoundError,
  MessageRevokedError as SdkMessageRevokedError,
  NotConnectedError,
  NotFoundError as SdkNotFoundError,
  NotOwnMessageError as SdkNotOwnMessageError,
  RecipientNotFoundError as SdkRecipientNotFoundError,
  SendPathError as SdkSendPathError,
  TranscriptionError as SdkTranscriptionError,
  UnsupportedMediaError,
  errorToWire,
} from "whatsapp-api-sdk";
import { z } from "zod";

import { ConversionError } from "../media/convert.js";
import { MediaUnavailableError, MessageNotFoundError } from "../media/store.js";
import { TranscriptionError } from "../media/transcribe.js";
import { ConnectionUnavailableError } from "../whatsapp/connection.js";
import { AmbiguousRecipientError, RecipientNotFoundError } from "../whatsapp/recipient.js";
import { MessageRevokedError, NotFoundError, NotOwnMessageError, SendPathError } from "../whatsapp/send.js";
import { CursorError } from "./cursor.js";
import { errorDetail, toApiError } from "./errors.js";

/** One row of the table: what was thrown, and the four things the wire must carry. */
type Row = {
  what: string;
  thrown: unknown;
  code: string;
  status: number;
  name: string;
  message: string;
  /** The SDK class `errorFromWire` will rebuild, so a client's `instanceof` still narrows. */
  ctor: new (message: string) => ApiError;
};

const CURSOR_MESSAGE =
  "invalid pagination cursor: pass back the `next_cursor` from a previous page verbatim, or omit it to start over";

const TABLE: readonly Row[] = [
  {
    what: "CursorError",
    thrown: new CursorError(CURSOR_MESSAGE),
    code: "bad_request",
    status: 400,
    // The whole reason the wire carries a `name`: one code, many names.
    name: "CursorError",
    message: CURSOR_MESSAGE,
    ctor: BadRequestError,
  },
  {
    what: "SendPathError",
    thrown: new SendPathError(
      "sending a file by path is disabled; set WHATSAPP_SEND_FILE_DIR to the directory files may be read from",
    ),
    code: "send_path_refused",
    status: 400,
    name: "SendPathError",
    message: "sending a file by path is disabled; set WHATSAPP_SEND_FILE_DIR to the directory files may be read from",
    ctor: SdkSendPathError,
  },
  {
    what: "RecipientNotFoundError",
    thrown: new RecipientNotFoundError('no chat, group or contact is named "ada"'),
    code: "recipient_not_found",
    status: 404,
    name: "RecipientNotFoundError",
    message: 'no chat, group or contact is named "ada"',
    ctor: SdkRecipientNotFoundError,
  },
  {
    what: "NotFoundError",
    thrown: new NotFoundError("no message ABC in chat 1@s.whatsapp.net"),
    code: "not_found",
    status: 404,
    name: "NotFoundError",
    message: "no message ABC in chat 1@s.whatsapp.net",
    ctor: SdkNotFoundError,
  },
  {
    what: "MessageNotFoundError",
    thrown: new MessageNotFoundError("no message ABC in chat 1@s.whatsapp.net"),
    code: "message_not_found",
    status: 404,
    name: "MessageNotFoundError",
    message: "no message ABC in chat 1@s.whatsapp.net",
    ctor: SdkMessageNotFoundError,
  },
  {
    what: "AmbiguousRecipientError",
    thrown: new AmbiguousRecipientError('"ada" matches 3 chats or contacts; re-send with pick set to one of:'),
    code: "ambiguous_recipient",
    status: 409,
    name: "AmbiguousRecipientError",
    message: '"ada" matches 3 chats or contacts; re-send with pick set to one of:',
    ctor: SdkAmbiguousRecipientError,
  },
  {
    what: "MessageRevokedError",
    thrown: new MessageRevokedError("message ABC in chat 1@s.whatsapp.net was revoked"),
    code: "message_revoked",
    status: 409,
    name: "MessageRevokedError",
    message: "message ABC in chat 1@s.whatsapp.net was revoked",
    ctor: SdkMessageRevokedError,
  },
  {
    what: "NotOwnMessageError",
    thrown: new NotOwnMessageError("message ABC in chat 1@s.whatsapp.net was not sent by this account"),
    code: "not_own_message",
    status: 409,
    name: "NotOwnMessageError",
    message: "message ABC in chat 1@s.whatsapp.net was not sent by this account",
    ctor: SdkNotOwnMessageError,
  },
  {
    what: "ConnectionUnavailableError",
    thrown: new ConnectionUnavailableError("disconnected"),
    code: "not_connected",
    status: 503,
    name: "ConnectionUnavailableError",
    message: 'WhatsApp connection unavailable: current state is "disconnected"',
    ctor: NotConnectedError,
  },
  {
    what: "MediaUnavailableError",
    thrown: new MediaUnavailableError("a media id must be a lowercase sha256 hex digest"),
    code: "media_unavailable",
    status: 503,
    name: "MediaUnavailableError",
    message: "a media id must be a lowercase sha256 hex digest",
    ctor: SdkMediaUnavailableError,
  },
  {
    what: "TranscriptionError",
    thrown: new TranscriptionError("every transcription backend failed. mistral: MISTRAL_API_KEY is not set"),
    code: "transcription_unavailable",
    status: 503,
    name: "TranscriptionError",
    message: "every transcription backend failed. mistral: MISTRAL_API_KEY is not set",
    ctor: SdkTranscriptionError,
  },
  // --- the four ConversionError kinds -----------------------------------------------------------
  {
    what: 'ConversionError kind "invalid-argument"',
    thrown: new ConversionError("invalid-argument", "maxEdge must be a positive integer"),
    code: "bad_request",
    status: 400,
    name: "ConversionError",
    message: "maxEdge must be a positive integer",
    ctor: BadRequestError,
  },
  {
    what: 'ConversionError kind "source-missing"',
    thrown: new ConversionError("source-missing", "the file to convert could not be read"),
    code: "not_found",
    status: 404,
    name: "ConversionError",
    message: "the file to convert could not be read",
    ctor: SdkNotFoundError,
  },
  {
    what: 'ConversionError kind "source-unsupported"',
    thrown: new ConversionError("source-unsupported", "the video declares no duration to sample from"),
    code: "unsupported_media",
    status: 415,
    name: "ConversionError",
    message: "the video declares no duration to sample from",
    ctor: UnsupportedMediaError,
  },
  {
    what: 'ConversionError kind "internal"',
    thrown: new ConversionError("internal", "the image data could not be decoded"),
    code: "conversion_failed",
    status: 502,
    name: "ConversionError",
    message: "the image data could not be decoded",
    ctor: SdkConversionError,
  },
  // --- refusals that are already `ApiError`s, and pass through untouched ------------------------
  {
    // Task 10's read-only gate. There is no in-process class behind it and the SDK deliberately
    // does not invent one, so the throw site builds the `ApiError` and this layer must not
    // re-derive it from anything.
    what: "a read-only refusal",
    thrown: new ApiError("read_only", "this deployment is read-only"),
    code: "read_only",
    status: 403,
    name: "Error",
    message: "this deployment is read-only",
    ctor: ApiError as unknown as new (message: string) => ApiError,
  },
  {
    // Reserved, mapped and untriggered: nothing throws it today, and adding a refusal under cover
    // of a refactor would be new behaviour. The row exists so the code stays reachable the day one
    // does, rather than being discovered to fall through to 500.
    what: "an exhausted budget",
    thrown: new ApiError("budget_exhausted", "the transcription budget for today is spent"),
    code: "budget_exhausted",
    status: 429,
    name: "Error",
    message: "the transcription budget for today is spent",
    ctor: ApiError as unknown as new (message: string) => ApiError,
  },
  {
    // The four converted bare-`Error` sites in `whatsapp/send.ts` and `whatsapp/recipient.ts` throw
    // this directly now. Its `name` is the literal "Error", which is what makes the conversion
    // invisible to a model — see the byte-identity test below.
    what: "a BadRequestError from a converted bare throw",
    thrown: new BadRequestError("file exceeds the maximum upload size (99 > 50 bytes)"),
    code: "bad_request",
    status: 400,
    name: "Error",
    message: "file exceeds the maximum upload size (99 > 50 bytes)",
    ctor: BadRequestError,
  },
];

void test("every row of the mapping table answers with its code, status, name and message", () => {
  for (const row of TABLE) {
    const mapped = toApiError(row.thrown);
    assert.equal(mapped.code, row.code, row.what);
    assert.equal(mapped.status, row.status, row.what);
    assert.equal(mapped.name, row.name, row.what);
    assert.equal(mapped.message, row.message, row.what);
    assert.ok(mapped instanceof row.ctor, `${row.what} rebuilds as ${row.ctor.name}`);
  }
});

void test("the table covers every domain error this package can throw at a route", () => {
  // A checklist rather than a count: the failure this guards against is a class added to
  // `whatsapp/` or `media/` and never mapped, which surfaces as a 500 for a refusal the caller
  // could have acted on. Adding a row here is cheap; discovering the gap in production is not.
  const covered = new Set(TABLE.map((row) => row.what.replace(/ kind .*/, "")));
  for (const expected of [
    "CursorError",
    "SendPathError",
    "RecipientNotFoundError",
    "NotFoundError",
    "MessageNotFoundError",
    "AmbiguousRecipientError",
    "MessageRevokedError",
    "NotOwnMessageError",
    "ConnectionUnavailableError",
    "MediaUnavailableError",
    "TranscriptionError",
    "ConversionError",
  ]) {
    assert.ok(covered.has(expected), `${expected} has no row`);
  }
});

// --- totality -----------------------------------------------------------------------------------

void test("an unrecognised throw degrades to internal/500 rather than leaking a stack", () => {
  const mapped = toApiError(new TypeError("x.y is not a function"));
  assert.equal(mapped.code, "internal");
  assert.equal(mapped.status, 500);
  assert.equal(mapped.name, "TypeError");
  assert.equal(mapped.message, "x.y is not a function");
  // What actually reaches the client is the wire envelope, so that is what is checked for a stack.
  assert.doesNotMatch(JSON.stringify(errorToWire(mapped).body), /errors\.test\.ts/);
});

void test("a bare Error is internal, not bad_request", () => {
  // The inverse of the conversion above, and the reason it was worth doing: a plain `new Error` is
  // now unambiguously a fault rather than a refusal, so nothing has to guess from its message.
  // `implement()` itself relies on this — it throws a plain `Error` for a handler that answered the
  // wrong shape, and documents that the API reports it as a 500.
  const mapped = toApiError(new Error("the handler for listChats answered a result its schema refuses"));
  assert.equal(mapped.code, "internal");
  assert.equal(mapped.status, 500);
});

void test("a non-Error throw yields an ApiError rather than propagating", () => {
  for (const thrown of ["boom", 42, null, undefined, { message: "nope" }]) {
    const mapped = toApiError(thrown);
    assert.ok(mapped instanceof ApiError, JSON.stringify(thrown));
    assert.equal(mapped.code, "internal");
    assert.equal(mapped.status, 500);
    assert.equal(mapped.name, "Error");
    assert.notEqual(mapped.message, "");
  }
});

void test("an ApiError passes through as the very same object", () => {
  // Identity, not equality: re-wrapping would drop `details`, which is how
  // `ambiguous_recipient` carries its numbered candidates.
  const original = new SdkAmbiguousRecipientError("two Maries", { details: { candidates: [{ index: 1 }] } });
  assert.equal(toApiError(original), original);
  assert.deepEqual(toApiError(original).details, { candidates: [{ index: 1 }] });
});

// --- the ZodError row ---------------------------------------------------------------------------

void test("a ZodError is bad_request and names the failing fields, never their values", () => {
  const schema = z.object({ limit: z.number(), kind: z.enum(["text", "image"]) });
  const parsed = schema.safeParse({ limit: "LEAKMARKER", kind: "LEAKMARKER" });
  assert.equal(parsed.success, false);
  const mapped = toApiError(parsed.error);
  assert.equal(mapped.code, "bad_request");
  assert.equal(mapped.status, 400);
  assert.match(mapped.message, /limit/);
  assert.match(mapped.message, /kind/);
  // Zod's own `invalid_type` message quotes what it received, and `invalid_enum_value` echoes the
  // string back verbatim. A query carries a search term and a body carries base64 file bytes, so
  // neither may reach a message that is logged and sent.
  assert.doesNotMatch(mapped.message, /LEAKMARKER/);
});

// --- the body-parser rows -----------------------------------------------------------------------

/** What `express.json()` hands the error middleware, reproduced field for field. */
function parserError(type: string, status: number, name: string, message: string, body?: string): Error {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, {
    type,
    status,
    statusCode: status,
    expose: status < 500,
    ...(body === undefined ? {} : { body }),
  });
  return err;
}

void test("an oversized body is payload_too_large/413", () => {
  const mapped = toApiError(parserError("entity.too.large", 413, "PayloadTooLargeError", "request entity too large"));
  assert.equal(mapped.code, "payload_too_large");
  assert.equal(mapped.status, 413);
  assert.equal(mapped.name, "PayloadTooLargeError");
});

void test("a malformed body is bad_request/400 and its message carries none of the body", () => {
  // body-parser hangs the entire raw payload off the error (`createError(400, err, { body: str })`)
  // and V8 quotes the input it choked on in the message — so both the object and its own message
  // are body echoes. The wire message is logged and sent to the caller, so it has to be ours.
  const mapped = toApiError(
    parserError(
      "entity.parse.failed",
      400,
      "SyntaxError",
      `Unexpected token 'L', "LEAKMARKER" is not valid JSON`,
      '{"data":"LEAKMARKER"}',
    ),
  );
  assert.equal(mapped.code, "bad_request");
  assert.equal(mapped.status, 400);
  assert.doesNotMatch(mapped.message, /LEAKMARKER/);
});

void test("every body-parser failure has a canned message, whatever the parser called it", () => {
  for (const type of ["entity.verify.failed", "encoding.unsupported", "charset.unsupported", "request.aborted"]) {
    const mapped = toApiError(parserError(type, 400, "BadRequestError", "LEAKMARKER"));
    assert.doesNotMatch(mapped.message, /LEAKMARKER/, type);
    assert.equal(mapped.code, "bad_request", type);
  }
});

// --- errorDetail --------------------------------------------------------------------------------

void test("errorDetail never carries a request body, on either parser path", () => {
  const parse = parserError("entity.parse.failed", 400, "SyntaxError", "…LEAKMARKER…", '{"a":"LEAKMARKER"}');
  const detail = errorDetail(parse);
  assert.equal(detail.errorType, "entity.parse.failed");
  assert.doesNotMatch(JSON.stringify(detail), /LEAKMARKER/);
  // A stack's first line is `Name: message`, so a parser failure's stack is a body echo too.
  assert.equal(detail.stack, undefined);
});

void test("errorDetail scrubs absolute URLs out of the message it reports", () => {
  // baileys raises `Failed to fetch stream from <url>` on an expired media URL, and that URL is a
  // capability granting the attachment's bytes to whoever reads the log.
  const detail = errorDetail(new Error("Failed to fetch stream from https://mmg.whatsapp.net/d?token=SECRETCAP"));
  assert.doesNotMatch(detail.errorMessage, /SECRETCAP/);
  assert.match(detail.errorMessage, /mmg\.whatsapp\.net/);
});

void test("errorDetail keeps the stack for a fault this server produced", () => {
  const detail = errorDetail(new TypeError("x.y is not a function"));
  assert.equal(detail.errorType, "TypeError");
  assert.match(detail.stack ?? "", /errors\.test\.ts/);
});

void test("errorDetail survives a non-Error throw", () => {
  const detail = errorDetail("boom");
  assert.equal(detail.errorType, "string");
  assert.equal(detail.stack, undefined);
});

// --- the conversion of the four bare throws -------------------------------------------------------

void test("the converted bare throws render exactly as a bare Error did", () => {
  // `whatsapp/send.ts` and `whatsapp/recipient.ts` used to throw `new Error(...)` at these four
  // sites, and `describeError` renders `${name}: ${message}` straight into the model's context.
  // `BadRequestError`'s `name` is the literal "Error" precisely so this stays true; demonstrating it
  // is the condition the change was made under.
  for (const message of [
    "`pick` only applies when the recipient is named by name; it is not needed for a JID or number",
    'cannot @mention "ada": a mention must be a phone number or a user JID, not a name',
    "file exceeds the maximum upload size (99 > 50 bytes)",
    "WhatsApp accepted the send to 1@s.whatsapp.net but returned no message id",
  ]) {
    const before = new Error(message);
    const after = new BadRequestError(message);
    assert.equal(`${after.name}: ${after.message}`, `${before.name}: ${before.message}`, message);
    assert.equal(toApiError(after).status, 400, message);
  }
});
