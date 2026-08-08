/**
 * What this file defends, and why it compares strings rather than objects.
 *
 * The `present*` functions are the last hop before a model reads a row, and the split changed their
 * input from a database row plus a contacts repo to an SDK domain object. Nothing about the *output*
 * was supposed to change — so every shape below is pinned against JSON captured by running the
 * in-process server's own `mcp/result.ts` over the equivalent row, and pasted here verbatim.
 *
 * The comparison is `JSON.stringify(...) === golden`, and that is deliberate: a `deepEqual` against a
 * golden object is blind to key order, and key order is part of what the model sees. It is also what
 * makes `{ next_cursor, items }` work at all, since `jsonResult` truncates from the end.
 *
 * Each fixture is `.parse`d by its SDK schema first, so it cannot drift into a shape the API could
 * never send — a golden built from an invented wire value proves nothing.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Logger } from "pino";
import { Chat, Contact, Message, NotConnectedError, Reaction, SearchHit } from "whatsapp-api-sdk";

import { loadConfig } from "./config.js";
import type { ToolContext } from "./context.js";
import { silentLogger } from "./logger.js";
import {
  describeError,
  errorResult,
  failedResult,
  jsonResult,
  page,
  presentChat,
  presentContact,
  presentMessage,
  presentReactions,
  presentSearchHit,
  textResult,
  type ToolResult,
} from "./result.js";

const ALICE = "33611111111@s.whatsapp.net";
const BOB = "33622222222@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";

/** A context carrying only what `page` and `failedResult` reach for. */
function ctxWith(over: { maxResultChars?: number; logger?: Logger } = {}): ToolContext {
  const config = loadConfig({ WHATSAPP_API_URL: "http://api:8080" });
  if (over.maxResultChars !== undefined) config.maxResultChars = over.maxResultChars;
  // The client is never touched by anything under test here; a tool that needs one gets it from the
  // Task 15 harness, which implements the whole interface.
  const client = {} as ToolContext["client"];
  return { config, logger: over.logger ?? silentLogger(), client };
}

/**
 * The text of a result's single block, narrowed rather than asserted.
 *
 * `Block` is a discriminated union, so a cast to `{ text: string }` would read `undefined.text` as a
 * string on an image block or an empty result. The assertion makes the mismatch a named failure.
 */
function onlyText(result: ToolResult): string {
  assert.equal(result.content.length, 1, "expected exactly one content block");
  const block = result.content[0];
  assert.ok(block?.type === "text", `expected a text block, got ${JSON.stringify(block)}`);
  return block.text;
}

// ── the goldens ───────────────────────────────────────────────────────────
//
// Captured by calling `packages/api/src/mcp/result.ts` — which is still in the tree — over the
// database rows these SDK values correspond to. Do not reformat them: they are the bytes.

const MESSAGE_GOLDEN =
  '{"id":"M1","chat":"120363000000000000@g.us","ts":1700000000,"from_me":false,"sender":{"id":"33611111111@s.whatsapp.net","name":"Alice Martin"},"kind":"audio","text":"hello","transcript":"bonjour","quoted_id":"M0","status":"delivered","edited":true,"deleted":false,"media":{"type":"audio/ogg; codecs=opus","cached":true},"reaction_count":2}';

const BARE_GOLDEN =
  '{"id":"M2","chat":"120363000000000000@g.us","ts":1700000000,"from_me":false,"sender":{"id":"33622222222@s.whatsapp.net","name":"33622222222@s.whatsapp.net"},"kind":"text","text":null,"transcript":null,"quoted_id":null,"status":null,"edited":false,"deleted":false,"media":null,"reaction_count":0}';

const SEARCH_HIT_GOLDEN =
  '{"id":"M1","chat":"120363000000000000@g.us","ts":1700000000,"from_me":false,"sender":{"id":"33611111111@s.whatsapp.net","name":"Alice Martin"},"kind":"audio","text":"hello","transcript":"bonjour","quoted_id":"M0","status":"delivered","edited":true,"deleted":false,"media":{"type":"audio/ogg; codecs=opus","cached":true},"reaction_count":2,"snippet":"…hello…","matched_transcript":true}';

const CHAT_GOLDEN =
  '{"id":"120363000000000000@g.us","name":"Les copains","is_group":true,"last_message_ts":1700000000,"unread_count":3,"archived":false,"muted_until":1800000000,"participant_count":5}';

const DM_GOLDEN =
  '{"id":"33611111111@s.whatsapp.net","name":"Alice Martin","is_group":false,"last_message_ts":null,"unread_count":0,"archived":true,"muted_until":null,"participant_count":null}';

const CONTACT_GOLDEN =
  '{"id":"33611111111@s.whatsapp.net","name":"Alice Martin","notify":"Alice","phone_number":"33611111111","lid":null}';

const REACTIONS_GOLDEN =
  '[{"emoji":"👍","from":{"id":"33611111111@s.whatsapp.net","name":"Alice Martin"}},{"emoji":"❤️","from":{"id":"33622222222@s.whatsapp.net","name":"33622222222@s.whatsapp.net"}}]';

const PAGE_GOLDEN = `{"next_cursor":"b2Zmc2V0OjUw","items":[${MESSAGE_GOLDEN}]}`;

// ── the fixtures ──────────────────────────────────────────────────────────

const message = Message.parse({
  id: "M1",
  chat: GROUP,
  ts: 1_700_000_000,
  fromMe: false,
  sender: { id: ALICE, name: "Alice Martin" },
  kind: "audio",
  text: "hello",
  transcript: "bonjour",
  quotedId: "M0",
  status: "delivered",
  edited: true,
  deleted: false,
  media: { type: "audio/ogg; codecs=opus", cached: true },
  reactionCount: 2,
});

/**
 * The same message with every nullable field null.
 *
 * `sender.name` is the JID, which is what the API sends for a contact it knows nothing about —
 * `displayName` answers with the id rather than inventing one, and that behaviour is upstream now.
 */
const bare = Message.parse({
  ...message,
  id: "M2",
  sender: { id: BOB, name: BOB },
  kind: "text",
  text: null,
  transcript: null,
  quotedId: null,
  status: null,
  edited: false,
  deleted: false,
  media: null,
  reactionCount: 0,
});

const hit = SearchHit.parse({ ...message, snippet: "…hello…", matchedTranscript: true });

const chat = Chat.parse({
  id: GROUP,
  name: "Les copains",
  isGroup: true,
  lastMessageTs: 1_700_000_000,
  unreadCount: 3,
  archived: false,
  mutedUntil: 1_800_000_000,
  participantCount: 5,
});

/**
 * A DM whose own chat row carried no name.
 *
 * `name` arrives already resolved to the contact behind it: the fallback used to sit beside
 * `presentChat` and is the API's now, because a client cannot resolve a name it was never sent. What
 * this fixture pins is that the MCP passes that resolved value through and adds no second rule.
 */
const dm = Chat.parse({
  id: ALICE,
  name: "Alice Martin",
  isGroup: false,
  lastMessageTs: null,
  unreadCount: 0,
  archived: true,
  mutedUntil: null,
  participantCount: null,
});

const contact = Contact.parse({
  id: ALICE,
  name: "Alice Martin",
  notify: "Alice",
  phoneNumber: "33611111111",
  lid: null,
});

const reactions = [
  Reaction.parse({ emoji: "👍", from: { id: ALICE, name: "Alice Martin" } }),
  Reaction.parse({ emoji: "❤️", from: { id: BOB, name: BOB } }),
];

// ── row shaping ───────────────────────────────────────────────────────────

void test("presentMessage reproduces the in-process shape, key for key and in order", () => {
  assert.equal(JSON.stringify(presentMessage(message)), MESSAGE_GOLDEN);
});

void test("presentMessage carries reaction_count, which the rename is most likely to drop", () => {
  // In the in-process server this key was not part of `presentMessage` at all — the list and search
  // paths spread it in after a batched count — so a faithful-looking port loses it silently. The
  // golden above already covers it; this is the assertion that *names* it, so a failure says why.
  assert.equal(presentMessage(message)["reaction_count"], 2);
  assert.equal(presentMessage(bare)["reaction_count"], 0, "and zero is a value, not an absence");
});

void test("presentMessage keeps every null a null, and never invents a media object", () => {
  assert.equal(JSON.stringify(presentMessage(bare)), BARE_GOLDEN);
});

void test("presentMessage reports nothing the SDK grows later", () => {
  // A field added to the `Message` schema must not appear in the model's output because someone
  // spread the wire value instead of naming its keys.
  const widened = { ...message, futureField: "surprise" } as unknown as Message;
  assert.equal(JSON.stringify(presentMessage(widened)), MESSAGE_GOLDEN);
});

void test("presentSearchHit puts snippet and matched_transcript after reaction_count", () => {
  assert.equal(JSON.stringify(presentSearchHit(hit)), SEARCH_HIT_GOLDEN);
});

void test("presentChat renames and nothing more", () => {
  assert.equal(JSON.stringify(presentChat(chat)), CHAT_GOLDEN);
  assert.equal(JSON.stringify(presentChat(dm)), DM_GOLDEN);
});

void test("presentContact renames and nothing more", () => {
  assert.equal(JSON.stringify(presentContact(contact)), CONTACT_GOLDEN);
});

void test("presentReactions names each reactor, in the order it was given", () => {
  assert.equal(JSON.stringify(presentReactions(reactions)), REACTIONS_GOLDEN);
  assert.deepEqual(presentReactions([]), []);
});

// ── the page envelope ─────────────────────────────────────────────────────

void test("a page serialises next_cursor before items", () => {
  const text = onlyText(page([presentMessage(message)], "b2Zmc2V0OjUw", ctxWith()));
  assert.equal(JSON.stringify(JSON.parse(text)), PAGE_GOLDEN);
  assert.ok(text.indexOf('"next_cursor"') < text.indexOf('"items"'), "the cursor comes first, or a cut page loses it");
});

void test("a truncated page still carries its next_cursor", () => {
  // The property a `deepEqual` cannot see. `jsonResult` truncates from the end, so with `items`
  // first the cursor is the one field an oversized page always loses — which breaks the pagination
  // round trip on exactly the pages that need it. Read back out of the serialized string, because
  // that is the only place the order exists.
  const items = Array.from({ length: 200 }, (_row, i) => presentMessage({ ...message, id: `M${i}` }));
  const text = onlyText(page(items, "b2Zmc2V0OjIwMA", ctxWith({ maxResultChars: 1_000 })));
  assert.match(text, /truncated/, "the fixture must actually be over the cap");
  assert.equal(/"next_cursor": "([^"]+)"/.exec(text)?.[1], "b2Zmc2V0OjIwMA");
});

void test("a page with no further rows says so with a null rather than an absent key", () => {
  const text = onlyText(page([], null, ctxWith()));
  assert.equal(JSON.stringify(JSON.parse(text)), '{"next_cursor":null,"items":[]}');
});

// ── blocks and caps ───────────────────────────────────────────────────────

void test("jsonResult pretty-prints", () => {
  assert.match(onlyText(jsonResult({ a: 1 }, 1000)), /"a": 1/);
});

void test("jsonResult truncates with a note naming the real size", () => {
  const text = onlyText(jsonResult({ big: "x".repeat(5000) }, 200));
  assert.ok(text.length < 600);
  assert.match(text, /truncated/i);
  assert.match(text, /5\d{3}/, "the note must state the true total length");
});

/** A UTF-16 half-character: half of a surrogate pair with nothing on its other side. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Everything `jsonResult` kept of the payload, without the note it appends. */
function truncatedBody(text: string): string {
  const note = text.indexOf("\n\n…[truncated");
  return note === -1 ? text : text.slice(0, note);
}

void test("jsonResult never cuts an emoji in half", () => {
  const payload = { s: "😀".repeat(40) };
  const full = JSON.stringify(payload, null, 2);
  // A cap derived from the payload, not guessed: one code unit past an emoji boundary, so the cut
  // lands *between* the halves of a pair. Asserting that a plain slice really is ill-formed there is
  // what stops this from quietly degrading into a test of an already-aligned cut.
  const maxChars = full.indexOf("😀") + 11;
  assert.match(full.slice(0, maxChars), LONE_SURROGATE, "the fixture must cut a surrogate pair in half");

  const body = truncatedBody(onlyText(jsonResult(payload, maxChars)));
  assert.doesNotMatch(body, LONE_SURROGATE, "a lone surrogate is not a character and does not re-encode");
  assert.equal(body.length, maxChars - 1, "exactly the orphaned half is dropped, and nothing more");
});

void test("jsonResult drops nothing extra when the cut already falls between characters", () => {
  const payload = { s: "😀".repeat(40) };
  const full = JSON.stringify(payload, null, 2);
  const maxChars = full.indexOf("😀") + 10;
  assert.doesNotMatch(full.slice(0, maxChars), LONE_SURROGATE, "this cut is aligned by construction");

  const body = truncatedBody(onlyText(jsonResult(payload, maxChars)));
  assert.equal(body.length, maxChars, "an aligned cut keeps the whole budget");
});

void test("jsonResult leaves a payload under the cap untouched", () => {
  const result = jsonResult({ a: 1 }, 1000);
  assert.equal(onlyText(result), JSON.stringify({ a: 1 }, null, 2));
  assert.equal(result.isError, undefined);
});

void test("jsonResult answers null for a tool that returned nothing", () => {
  // `JSON.stringify` is typed as returning a string and answers `undefined` here, which would be a
  // TypeError on `.length` and would kill the whole call rather than one field of it.
  assert.equal(onlyText(jsonResult(undefined, 1000)), "null");
});

void test("textResult passes text through", () => {
  assert.equal(onlyText(textResult("hi", 1000)), "hi");
});

void test("textResult is capped too, and its note counts what it really emitted", () => {
  // The payload transcripts and PDF text come back as. It used to be the one thing a tool could
  // return with no cap at all, which made "every payload is capped" false and let one voice note
  // outweigh a whole page of messages.
  const text = onlyText(textResult("x".repeat(5000), 200));
  assert.ok(text.length < 600, `a capped payload must be short, got ${text.length}`);
  assert.equal(truncatedBody(text), "x".repeat(200));
  assert.match(text, /5000 chars total, showing first 200/);
});

void test("a truncation note reports what was emitted, not what was asked for", () => {
  // The cut lands between the halves of a surrogate pair, so the codepoint-safe slice keeps one
  // character less than the cap — and the note has to say 199, not 200. A note built from `maxChars`
  // is off by one exactly on the payloads where the difference exists.
  const text = onlyText(textResult(`${"a".repeat(199)}😀tail`, 200));
  assert.equal(truncatedBody(text).length, 199);
  assert.match(text, /showing first 199\./);
  assert.doesNotMatch(text, /showing first 200\./);
});

// ── errors ────────────────────────────────────────────────────────────────

void test("errorResult marks isError and never leaks a stack", () => {
  const result = errorResult(new Error("boom"));
  assert.equal(result.isError, true);
  const text = onlyText(result);
  assert.match(text, /boom/);
  assert.doesNotMatch(text, /at .*\.ts:/, "a stack trace is noise in a model's context");
});

void test("errorResult keeps no trace of a multi-frame stack, however deep the cause", () => {
  const inner = new Error("inner");
  const text = onlyText(errorResult(new Error("outer", { cause: inner })));
  assert.doesNotMatch(text, /\n\s+at /, "no stack frame may survive, from the error or its cause");
  assert.ok(text.length < 200, `an error message must stay short, got ${text.length} chars`);
});

void test("errorResult handles non-Error throwables", () => {
  assert.match(onlyText(errorResult("plain string")), /plain string/);
  assert.ok(errorResult(undefined).isError);
});

void test("describeError renders an SDK error as its pinned name and message", () => {
  // The name is what the model has read since before the split, which is why the taxonomy pins one
  // per code rather than letting the class name show through: the class is `NotConnectedError`.
  assert.equal(
    describeError(new NotConnectedError("WhatsApp connection unavailable")),
    "ConnectionUnavailableError: WhatsApp connection unavailable",
  );
  assert.equal(describeError(new Error("")), "Error", "an empty message is the name alone, not a trailing colon");
  assert.equal(describeError(""), "unknown error");
  assert.equal(describeError(42), "42");
  assert.equal(describeError({ nope: true }), "unknown error");
});

void test("failedResult tells the model and the operator, and hands the logger no error object", () => {
  const lines: { obj: Record<string, unknown>; msg: string }[] = [];
  const logger = {
    warn: (obj: unknown, msg?: string) => {
      lines.push({ obj: obj as Record<string, unknown>, msg: msg ?? "" });
    },
  } as unknown as Logger;

  const result = failedResult("whatsapp_messages_list", new Error("boom"), ctxWith({ logger }));

  assert.equal(result.isError, true);
  assert.match(onlyText(result), /boom/);
  assert.equal(lines.length, 1);
  // Three fields and no `err`: pino's serializer would copy every own enumerable key off the error.
  assert.deepEqual(Object.keys(lines[0]?.obj ?? {}).sort(), ["errorMessage", "errorType", "tool"]);
  assert.equal(lines[0]?.obj["tool"], "whatsapp_messages_list");
});
