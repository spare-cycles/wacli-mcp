import { strict as assert } from "node:assert";
import { test } from "node:test";

/**
 * The import itself is the guard on declaration order: `MessageDetail` is built from `Reaction`, and
 * `const` bindings sit in the temporal dead zone until initialised. Move `Reaction` below it and
 * this module throws a `ReferenceError` on load, failing every test in the file rather than
 * surfacing as a mystery at the first `getMessage` call.
 */
import {
  CONNECTION_STATES,
  CONTRACT_VERSION,
  Capabilities,
  Chat,
  Contact,
  HealthReport,
  MESSAGE_KINDS,
  Message,
  MessageDetail,
  Reaction,
  SearchHit,
} from "./domain.js";
import { Page } from "./common.js";

const MESSAGE = {
  id: "3EB0",
  chat: "1@s.whatsapp.net",
  ts: 1_700_000_000,
  fromMe: false,
  sender: { id: "1@s.whatsapp.net", name: "Ada" },
  kind: "image",
  text: "look",
  transcript: null,
  quotedId: null,
  status: "delivered",
  edited: false,
  deleted: false,
  media: { type: "image/jpeg", cached: true },
  reactionCount: 2,
};

// --- Message --------------------------------------------------------------------------------------

void test("a denormalised row parses with its resolved sender and reaction count", () => {
  const parsed = Message.parse(MESSAGE);
  // §4.1: the name is resolved server-side. A client cannot issue one lookup per row.
  assert.equal(parsed.sender.name, "Ada");
  assert.equal(parsed.reactionCount, 2);
  assert.equal(parsed.media?.cached, true);
});

void test("a timestamp is integer Unix seconds, so a milliseconds value is refused", () => {
  // 1_700_000_000_000 is a perfectly good integer, so `.int()` alone accepted it and this test
  // asserted nothing it claimed. The refusal comes from `epochSeconds`' 1e11 bound instead. The bug
  // is real: a message dated 55 000 AD is only visible once a model reads it back.
  assert.ok(!Message.safeParse({ ...MESSAGE, ts: 1_700_000_000_000 }).success, "milliseconds");
  assert.ok(!Message.safeParse({ ...MESSAGE, ts: 1_700_000_000.5 }).success, "fractional");
  // Exclusive bound: 1e11 seconds is the year 5138, so the threshold itself is already milliseconds.
  assert.ok(!Message.safeParse({ ...MESSAGE, ts: 1e11 }).success, "the threshold itself");
  assert.ok(Message.safeParse({ ...MESSAGE, ts: 1e11 - 1 }).success, "just under the threshold");
  assert.ok(Message.safeParse({ ...MESSAGE, ts: 0 }).success);
});

void test("an unlisted kind is refused rather than passed through as a string", () => {
  assert.ok(!Message.safeParse({ ...MESSAGE, kind: "poll" }).success);
  for (const kind of MESSAGE_KINDS) assert.ok(Message.safeParse({ ...MESSAGE, kind }).success, kind);
});

void test("text, transcript, quotedId, status and media are nullable, not optional", () => {
  // Nullable and absent are different answers, and the presenter always emits the key. An optional
  // field would let a row omit `transcript` and read as "not transcribable" instead of "not yet".
  const bare = { ...MESSAGE, text: null, transcript: null, quotedId: null, status: null, media: null };
  assert.ok(Message.safeParse(bare).success);
  const { text: _text, ...withoutText } = MESSAGE;
  assert.ok(!Message.safeParse(withoutText).success);
});

void test("status is nullable, because a message WhatsApp sent no receipt for has none", () => {
  // `MessageRow.status` is `string | null` and `presentMessage` passes it through unchanged, so
  // `"status": null` is already in today's tool output. A non-nullable schema would reject it.
  assert.equal(Message.parse({ ...MESSAGE, status: null }).status, null);
});

// --- the two extensions ---------------------------------------------------------------------------

void test("SearchHit is a Message plus what made it a hit", () => {
  const hit = SearchHit.parse({ ...MESSAGE, snippet: "…look…", matchedTranscript: false });
  assert.equal(hit.snippet, "…look…");
  assert.deepEqual(
    Object.keys(SearchHit.shape).filter((k) => !(k in Message.shape)),
    ["snippet", "matchedTranscript"],
  );
});

void test("MessageDetail is a strict superset of Message and keeps the full per-reactor list", () => {
  // The reason it exists: `whatsapp_download_media`'s summary embeds every reactor, not the batched
  // count. A detail shape without `reactions` silently drops that array from the tool's output.
  for (const key of Object.keys(Message.shape)) assert.ok(key in MessageDetail.shape, key);
  const detail = MessageDetail.parse({
    ...MESSAGE,
    reactions: [{ emoji: "👍", from: { id: "2@s.whatsapp.net", name: "Grace" } }],
  });
  assert.equal(detail.reactions[0]?.from.name, "Grace");
  assert.equal(detail.reactionCount, 2, "the batched count stays, so the shape is a superset");
});

void test("MessageDetail validates its reactions with Reaction, not as loose objects", () => {
  assert.ok(!MessageDetail.safeParse({ ...MESSAGE, reactions: [{ emoji: "👍" }] }).success);
  assert.ok(!Reaction.safeParse({ emoji: "👍", from: { id: "2@s.whatsapp.net" } }).success);
});

// --- Chat and Contact -------------------------------------------------------------------------------

const CHAT = {
  id: "1@s.whatsapp.net",
  name: null,
  isGroup: false,
  lastMessageTs: null,
  unreadCount: 0,
  archived: false,
  mutedUntil: null,
  participantCount: null,
};

void test("a chat with no resolvable name reports null rather than echoing the JID", () => {
  const chat = Chat.parse(CHAT);
  assert.equal(chat.name, null);
  assert.notEqual(chat.name, chat.id);
});

void test("mutedUntil is the one timestamp the milliseconds bound is not applied to", () => {
  // `lastMessageTs` is an observation and takes the bound like every other stamp.
  assert.ok(!Chat.safeParse({ ...CHAT, lastMessageTs: 1_700_000_000_000 }).success);
  // `mutedUntil` does not, on purpose: WhatsApp's muted-forever is a Long that `toEpochSeconds`
  // divides by 1000 and still leaves far above 1e11 (`whatsapp/ingest.ts:212-215`, called at
  // `:600`). Bounding it would make one muted chat unparse a whole page. Pin the exemption so it is
  // a decision, not an oversight someone later "fixes" into an outage.
  assert.ok(Chat.safeParse({ ...CHAT, mutedUntil: 9_223_372_036_854 }).success);
});

void test("Contact keeps every identifier nullable, because most contacts have only some", () => {
  const contact = Contact.parse({ id: "1@s.whatsapp.net", name: null, notify: null, phoneNumber: null, lid: null });
  assert.equal(contact.name, null);
});

// --- Page -----------------------------------------------------------------------------------------

void test("a page carries an opaque cursor and rows of the item schema", () => {
  const page = Page(Chat).parse({ nextCursor: "eyJvIjo1MH0", items: [] });
  assert.equal(page.nextCursor, "eyJvIjo1MH0");
  // null, not absent: "this was the last page" is an answer, not a missing field.
  assert.equal(Page(Message).parse({ nextCursor: null, items: [MESSAGE] }).items.length, 1);
  assert.ok(!Page(Message).safeParse({ items: [] }).success);
  assert.ok(!Page(Message).safeParse({ nextCursor: null, items: [{ id: "x" }] }).success);
});

// --- HealthReport -----------------------------------------------------------------------------------

void test("/health stays snake_case verbatim, because whatsapp_health hands it to the model unchanged", () => {
  assert.deepEqual(Object.keys(HealthReport.shape), [
    "ok",
    "connection",
    "needs_pairing",
    "last_event_age_sec",
    "last_connected_at",
    "last_message_at",
    "self_id",
    "counts",
    "schema_version",
    "transcription_available",
    "auto_transcribe",
    "read_only",
  ]);
});

void test("a health report parses with the background lane both running and absent", () => {
  const base = {
    ok: true,
    connection: "connected",
    needs_pairing: false,
    last_event_age_sec: 3,
    last_connected_at: 1_700_000_000,
    last_message_at: 1_700_000_100,
    self_id: "1@s.whatsapp.net",
    counts: { chats: 4, messages: 900, contacts: 12 },
    schema_version: 3,
    transcription_available: true,
    auto_transcribe: null,
    read_only: false,
  };
  // null is not an all-zero object: "the feature is off" and "the queue is empty" differ.
  assert.equal(HealthReport.parse(base).auto_transcribe, null);
  const running = HealthReport.parse({
    ...base,
    auto_transcribe: {
      enabled: true,
      queued: 2,
      in_flight: 1,
      transcribed_last_hour: 7,
      budget_day: "2026-08-07",
      budget_spent_usd: 0.42,
      budget_usd: 5,
      budget_exhausted: false,
    },
  });
  assert.equal(running.auto_transcribe?.budget_spent_usd, 0.42);
  for (const connection of CONNECTION_STATES) assert.ok(HealthReport.safeParse({ ...base, connection }).success);
  assert.ok(!HealthReport.safeParse({ ...base, connection: "reconnecting" }).success);
});

// --- Capabilities -------------------------------------------------------------------------------------

void test("capabilities publish the two enforcement fields, not just feature flags", () => {
  const caps = Capabilities.parse({
    apiVersion: "1.0.0",
    contractVersion: CONTRACT_VERSION,
    readOnly: false,
    maxUploadBytes: 50 * 1024 * 1024,
    features: { transcription: true, autoTranscribe: false, mediaLinks: true },
  });
  // Compared at session build, not displayed: a skewed pair must be caught once, here, rather than
  // as a pile of Zod errors at every boundary.
  assert.equal(caps.contractVersion, CONTRACT_VERSION);
  // Published so the MCP's upload limit is derived from the API's rather than a second copy of it.
  assert.equal(caps.maxUploadBytes, 52_428_800);
});
