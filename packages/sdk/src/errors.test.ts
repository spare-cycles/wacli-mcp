import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  API_ERROR_CODES,
  AmbiguousRecipientError,
  ApiError,
  ApiUnreachableError,
  BadRequestError,
  ConversionError,
  MediaUnavailableError,
  MessageNotFoundError,
  MessageRevokedError,
  NotConnectedError,
  NotFoundError,
  NotOwnMessageError,
  RecipientNotFoundError,
  SendPathError,
  TranscriptionError,
  UnsupportedMediaError,
  errorFromWire,
  errorToWire,
  wireError,
} from "./errors.js";

/**
 * `packages/mcp`'s `describeError`, copied byte for byte from `mcp/result.ts`.
 *
 * Copied rather than imported: the SDK may not depend on either sibling, and this test's whole
 * subject is that the string it produces survives a round trip through HTTP. A paraphrase would
 * test the paraphrase.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message === "" ? err.name : `${err.name}: ${err.message}`;
  if (typeof err === "string") return err === "" ? "unknown error" : err;
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") return String(err);
  return "unknown error";
}

// --- the constraint: model-visible text is unchanged by the split ---------------------------------

void test("a wire error round-trips to a class whose name matches the legacy in-process error", () => {
  const err = errorFromWire(503, {
    error: { code: "not_connected", message: 'WhatsApp connection unavailable: current state is "disconnected"' },
  });
  assert.equal(err.name, "ConnectionUnavailableError");
  assert.equal(
    `${err.name}: ${err.message}`,
    'ConnectionUnavailableError: WhatsApp connection unavailable: current state is "disconnected"',
  );
});

void test("an unknown code does not throw and degrades to a generic ApiError", () => {
  const err = errorFromWire(500, { error: { code: "nonsense", message: "x" } });
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, "internal");
});

/**
 * One row per live throw site, each `message` copied verbatim from the source that produces it.
 * `rendered` is what the model reads today, in-process; the test asserts the same bytes come back
 * out of a full throw → wire → client round trip.
 */
const LIVE_THROWS = [
  {
    site: "whatsapp/connection.ts:124",
    code: "not_connected",
    name: "ConnectionUnavailableError",
    message: 'WhatsApp connection unavailable: current state is "disconnected"',
    ctor: NotConnectedError,
  },
  {
    site: "whatsapp/recipient.ts:129",
    code: "recipient_not_found",
    name: "RecipientNotFoundError",
    message: 'no chat, group or contact is named "ada"',
    ctor: RecipientNotFoundError,
  },
  {
    site: "whatsapp/recipient.ts:137",
    code: "ambiguous_recipient",
    name: "AmbiguousRecipientError",
    message: '"ada" matches 3 chats or contacts; re-send with pick set to one of:\n  1. Ada Lovelace',
    ctor: AmbiguousRecipientError,
  },
  {
    site: "whatsapp/send.ts:287",
    code: "not_found",
    name: "NotFoundError",
    message: "no message ABC in chat 1@s.whatsapp.net",
    ctor: NotFoundError,
  },
  {
    site: "whatsapp/send.ts:288",
    code: "message_revoked",
    name: "MessageRevokedError",
    message: "message ABC in chat 1@s.whatsapp.net was revoked",
    ctor: MessageRevokedError,
  },
  {
    site: "whatsapp/send.ts:305",
    code: "not_own_message",
    name: "NotOwnMessageError",
    message: "message ABC in chat 1@s.whatsapp.net was not sent by this account",
    ctor: NotOwnMessageError,
  },
  {
    site: "whatsapp/send.ts:357",
    code: "send_path_refused",
    name: "SendPathError",
    message: "sending a file by path is disabled; set WHATSAPP_SEND_FILE_DIR to the directory files may be read from",
    ctor: SendPathError,
  },
  {
    site: "media/store.ts:112",
    code: "media_unavailable",
    name: "MediaUnavailableError",
    message: "a media id must be a lowercase sha256 hex digest",
    ctor: MediaUnavailableError,
  },
  {
    site: "media/store.ts:146",
    code: "message_not_found",
    name: "MessageNotFoundError",
    message: "no message ABC in chat 1@s.whatsapp.net",
    ctor: MessageNotFoundError,
  },
  {
    // Same class and same message template as `media/store.ts:146`, thrown a layer earlier so that
    // `whatsapp_transcribe` — which answers from `row.transcript` and fetches nothing — still
    // refuses an unknown id. Listed separately because Task 7 maps throw sites, not templates.
    site: "mcp/tools/media.ts:209",
    code: "message_not_found",
    name: "MessageNotFoundError",
    message: "no message ABC in chat 1@s.whatsapp.net",
    ctor: MessageNotFoundError,
  },
  {
    site: "media/convert.ts:155",
    code: "conversion_failed",
    name: "ConversionError",
    message: "the image data could not be decoded",
    ctor: ConversionError,
  },
  {
    site: "media/transcribe.ts:211",
    code: "transcription_unavailable",
    name: "TranscriptionError",
    message: "every transcription backend failed. mistral: MISTRAL_API_KEY is not set",
    ctor: TranscriptionError,
  },
  {
    // `bad_request`, not a code of its own: the envelope carries `name`, so the code does not have
    // to encode it. The assertion that matters is the rendered string below, which is identical
    // either way — and `ctor` is `BadRequestError` because that is genuinely what comes back.
    site: "rest/cursor.ts:35",
    code: "bad_request",
    name: "CursorError",
    message:
      "invalid pagination cursor: pass back the `next_cursor` from a previous page verbatim, or omit it to start over",
    ctor: BadRequestError,
  },
  {
    // The seven bare `new Error(...)` throws. Their name is the literal string "Error", and routing
    // them through a generic ApiError would silently turn `Error: …` into `ApiError: …`.
    site: "whatsapp/recipient.ts:101",
    code: "bad_request",
    name: "Error",
    message: "`pick` only applies when the recipient is named by name; it is not needed for a JID or number",
    ctor: BadRequestError,
  },
  {
    site: "whatsapp/send.ts:261",
    code: "bad_request",
    name: "Error",
    message: 'cannot @mention "ada": a mention must be a phone number or a user JID, not a name',
    ctor: BadRequestError,
  },
  {
    site: "whatsapp/send.ts:337",
    code: "bad_request",
    name: "Error",
    message: "file exceeds the maximum upload size (99 > 50 bytes)",
    ctor: BadRequestError,
  },
  {
    site: "whatsapp/send.ts:400",
    code: "bad_request",
    name: "Error",
    message: "WhatsApp accepted the send to 1@s.whatsapp.net but returned no message id",
    ctor: BadRequestError,
  },
  {
    site: "mcp/tools/reads.ts:173",
    code: "bad_request",
    name: "Error",
    message: 'has_media=true contradicts kind="text", which never carries an attachment — drop one of the two',
    ctor: BadRequestError,
  },
  {
    // Reached through `guarded("whatsapp_send_file", …)` (`writes.ts:126-132`, called at `:212`),
    // which routes to `failedResult` → `errorResult` → `describeError`: it renders as `Error: …` on
    // the model-visible path today, so it is a `bad_request`/400, not an `internal`/500.
    site: "mcp/tools/writes.ts:163",
    code: "bad_request",
    name: "Error",
    message: "give either `data` (base64 bytes) or `path` (a server-side file), not both",
    ctor: BadRequestError,
  },
  {
    site: "mcp/tools/writes.ts:167",
    code: "bad_request",
    name: "Error",
    message: "provide exactly one of `data` (base64 bytes) or `path` (a server-side file under WHATSAPP_SEND_FILE_DIR)",
    ctor: BadRequestError,
  },
] as const;

void test("every live throw site renders identically after a full round trip through the wire", () => {
  for (const row of LIVE_THROWS) {
    const thrown = new row.ctor(row.message, { name: row.name });
    assert.equal(describeError(thrown), `${row.name}: ${row.message}`, row.site);

    const { status, body } = errorToWire(thrown);
    // The envelope must carry the name; without it the client has only a code to guess from.
    assert.deepEqual(wireError.parse(body).error.name, row.name, row.site);

    const received = errorFromWire(status, JSON.parse(JSON.stringify(body)));
    assert.equal(describeError(received), `${row.name}: ${row.message}`, row.site);
    assert.equal(received.code, row.code, row.site);
    assert.ok(received instanceof row.ctor, row.site);
  }
});

/**
 * Two 404s that render the same words, kept as two codes on purpose.
 *
 * `NotFoundError` (`whatsapp/send.ts:287`) and `MessageNotFoundError` (`media/store.ts:146`,
 * `mcp/tools/media.ts:209`) share a message template *and* a status, so folding them onto one wire
 * code looks free. It is not. `errorFromWire` rebuilds the class from the code alone, so a merged
 * row would leave every byte a model reads unchanged while `instanceof NotFoundError` quietly
 * stopped matching in every client that narrows on it — a break with no symptom until something
 * downstream takes the wrong branch. This test is the alarm: merge the rows and it fails here,
 * where the reason is written down, instead of in whatever consumes the narrowing later.
 */
void test("not_found and message_not_found stay two codes, because two classes narrow on them", () => {
  const shared = "no message ABC in chat 1@s.whatsapp.net";
  const roundTrip = (err: ApiError): ApiError => {
    const { status, body } = errorToWire(err);
    return errorFromWire(status, JSON.parse(JSON.stringify(body)) as unknown);
  };
  const plain = roundTrip(new NotFoundError(shared));
  const media = roundTrip(new MessageNotFoundError(shared));

  assert.equal(plain.code, "not_found");
  assert.equal(media.code, "message_not_found");
  assert.notEqual(plain.code, media.code);
  // What makes the merge tempting: same status, same message.
  assert.equal(plain.status, media.status);
  assert.equal(plain.message, media.message);
  // What it would cost: neither narrowing can stand in for the other.
  assert.ok(plain instanceof NotFoundError);
  assert.ok(!(plain instanceof MessageNotFoundError));
  assert.ok(media instanceof MessageNotFoundError);
  assert.ok(!(media instanceof NotFoundError));
  // And the one thing that does differ on the wire is the name the model reads.
  assert.equal(describeError(plain), `NotFoundError: ${shared}`);
  assert.equal(describeError(media), `MessageNotFoundError: ${shared}`);
});

void test("each class carries its code's canonical status and legacy name with no help from the wire", () => {
  const expected: [ApiError, string, number][] = [
    [new BadRequestError("m"), "Error", 400],
    [new SendPathError("m"), "SendPathError", 400],
    [new NotFoundError("m"), "NotFoundError", 404],
    [new MessageNotFoundError("m"), "MessageNotFoundError", 404],
    [new RecipientNotFoundError("m"), "RecipientNotFoundError", 404],
    [new AmbiguousRecipientError("m"), "AmbiguousRecipientError", 409],
    [new MessageRevokedError("m"), "MessageRevokedError", 409],
    [new NotOwnMessageError("m"), "NotOwnMessageError", 409],
    [new ConversionError("m"), "ConversionError", 502],
    // Same name, different code and status: `media/convert.ts` raises one class across four
    // outcomes and tags each with a `kind`, and `packages/api`'s `rest/errors.ts` splits that kind
    // across codes. The name is what the model reads and it must not move; the code is what a
    // consumer branches on, and "permanently unconvertible" is not "the machinery broke".
    [new UnsupportedMediaError("m"), "ConversionError", 415],
    [new NotConnectedError("m"), "ConnectionUnavailableError", 503],
    [new MediaUnavailableError("m"), "MediaUnavailableError", 503],
    [new TranscriptionError("m"), "TranscriptionError", 503],
  ];
  for (const [err, name, status] of expected) {
    assert.equal(err.name, name);
    assert.equal(err.status, status);
    assert.ok(err instanceof ApiError);
    assert.ok(err instanceof Error, "must stay an Error, or describeError's instanceof check skips it");
  }
});

/**
 * One code, many names — the reason there is no `invalid_cursor` code and no `CursorError` class.
 *
 * A cursor refusal is a `bad_request` that happens to be called `CursorError`, and the *only* thing
 * that has to survive is the string the model reads. This test is what makes dropping the code
 * safe: the byte-for-byte rendering below is asserted independently of how the code is spelled, so
 * `bad_request` carrying two different names cannot blur them together.
 */
void test("bad_request carries whatever name the throw had, so a cursor refusal still reads as CursorError", () => {
  const cursor =
    "invalid pagination cursor: pass back the `next_cursor` from a previous page verbatim, or omit it to start over";
  const contradiction =
    'has_media=true contradicts kind="text", which never carries an attachment — drop one of the two';
  const roundTrip = (err: ApiError): ApiError => {
    const { status, body } = errorToWire(err);
    return errorFromWire(status, JSON.parse(JSON.stringify(body)) as unknown);
  };
  const named = roundTrip(new BadRequestError(cursor, { name: "CursorError" }));
  const bare = roundTrip(new BadRequestError(contradiction));

  // Same code and status: a client branching on `code` treats both as the argument error they are.
  assert.equal(named.code, "bad_request");
  assert.equal(bare.code, "bad_request");
  assert.equal(named.status, 400);
  assert.equal(bare.status, 400);
  // Different names, and the rendering is what the model reads. Neither degrades to `ApiError: …`.
  assert.equal(describeError(named), `CursorError: ${cursor}`);
  assert.equal(describeError(bare), `Error: ${contradiction}`);
  // The code carries no name of its own to leak: `bad_request`'s fallback only applies when the
  // wire sent none, which is the case `bare` covers.
  assert.notEqual(named.name, bare.name);
});

void test("invalid_cursor is not a wire code, so nothing can send one the client would not understand", () => {
  assert.ok(!(API_ERROR_CODES as readonly string[]).includes("invalid_cursor"));
  assert.throws(() => wireError.parse({ error: { code: "invalid_cursor", name: "CursorError", message: "m" } }));
  // And an API that sent it anyway degrades to internal rather than throwing at the client.
  assert.equal(errorFromWire(400, { error: { code: "invalid_cursor", message: "m" } }).code, "internal");
});

// --- errorFromWire ------------------------------------------------------------------------------

void test("a wire body with no name falls back to the code's legacy name", () => {
  // The API always sends `name`; this is the fallback for a body that predates the field or came
  // from a proxy. Every code must still name something, so nothing renders as ": message".
  for (const code of API_ERROR_CODES) {
    const err = errorFromWire(500, { error: { code, message: "m" } });
    assert.equal(err.code, code);
    assert.notEqual(err.name, "", code);
    assert.equal(describeError(err), `${err.name}: m`, code);
  }
});

void test("an empty name on the wire is treated as absent rather than rendered as a bare colon", () => {
  const err = errorFromWire(503, { error: { code: "not_connected", name: "", message: "down" } });
  assert.equal(describeError(err), "ConnectionUnavailableError: down");
});

void test("the wire's name wins over the code's default, so a bare Error stays a bare Error", () => {
  const err = errorFromWire(400, { error: { code: "bad_request", name: "Error", message: "nope" } });
  assert.equal(describeError(err), "Error: nope");
  const zodish = errorFromWire(400, { error: { code: "bad_request", name: "ZodError", message: "nope" } });
  assert.equal(describeError(zodish), "ZodError: nope");
});

void test("the response's own status is reported, not the code's canonical one", () => {
  // A proxy or gateway can answer for the API. Reporting 503 for a body a 504 carried describes a
  // reply that never happened.
  const err = errorFromWire(504, { error: { code: "not_connected", name: "X", message: "m" } });
  assert.equal(err.status, 504);
});

void test("details survive the round trip, which is what makes an ambiguity refusal actionable", () => {
  const details = { candidates: [{ index: 1, id: "1@s.whatsapp.net", label: "Ada", exact: true }] };
  const { status, body } = errorToWire(new AmbiguousRecipientError('2 contacts are named "ada"', { details }));
  const err = errorFromWire(status, JSON.parse(JSON.stringify(body)));
  assert.deepEqual(err.details, details);
});

void test("a body that is not a wire error at all still yields an ApiError", () => {
  const bodies: unknown[] = [undefined, null, "gateway timeout", 42, {}, { error: null }, { error: {} }, []];
  for (const [i, body] of bodies.entries()) {
    const err = errorFromWire(502, body);
    assert.ok(err instanceof ApiError, `body ${i}`);
    assert.equal(err.code, "internal");
    assert.notEqual(err.message, "");
  }
});

// --- errorToWire --------------------------------------------------------------------------------

void test("a non-ApiError throw degrades to internal/500 keeping its own name and message", () => {
  const { status, body } = errorToWire(new TypeError("x is not a function"));
  assert.equal(status, 500);
  assert.deepEqual(body.error, {
    code: "internal",
    name: "TypeError",
    message: "x is not a function",
    details: undefined,
  });
  assert.equal(describeError(errorFromWire(status, body)), "TypeError: x is not a function");
});

void test("a thrown non-Error is reported without leaking its shape", () => {
  for (const thrown of ["boom", 7, null, undefined, { secret: "token" }]) {
    const { status, body } = errorToWire(thrown);
    assert.equal(status, 500);
    assert.equal(body.error.code, "internal");
    assert.equal(body.error.name, "Error");
    assert.doesNotMatch(body.error.message, /secret|token/);
  }
});

void test("every produced envelope satisfies the strict wire schema", () => {
  for (const err of [new NotConnectedError("m"), new BadRequestError("m"), new Error("m"), "not an error"]) {
    assert.doesNotThrow(() => wireError.parse(errorToWire(err).body));
  }
});

// --- ApiUnreachableError ------------------------------------------------------------------------

void test("ApiUnreachableError is distinct from NotConnectedError: a dead backend is not a dead socket", () => {
  const unreachable = new ApiUnreachableError("connect ECONNREFUSED 127.0.0.1:8080");
  assert.ok(unreachable instanceof ApiError);
  assert.ok(!(unreachable instanceof NotConnectedError));
  assert.equal(unreachable.code, "api_unreachable");
  // No HTTP exchange happened, so there is no status to report.
  assert.equal(unreachable.status, 0);
});

void test("api_unreachable is not a wire code, so the API cannot claim its own client's failure", () => {
  assert.ok(!(API_ERROR_CODES as readonly string[]).includes("api_unreachable"));
  assert.throws(() =>
    wireError.parse({ error: { code: "api_unreachable", name: "ApiUnreachableError", message: "m" } }),
  );
  // Still total: if one is ever handed to the serialiser it degrades rather than emitting a code
  // the schema rejects.
  const { status, body } = errorToWire(new ApiUnreachableError("m"));
  assert.equal(body.error.code, "internal");
  assert.equal(status, 500);
});
