/**
 * The eight write routes, over a real socket.
 *
 * Three of the properties here are refusals rather than successes, and each is the kind that a
 * happy-path suite never reaches: a read-only deployment refuses a write it was asked for directly,
 * an ambiguous name is refused with numbered candidates rather than guessed, and a path-based send
 * with no directory configured is refused without echoing the path it was asked to read.
 *
 * The sender is stubbed, and only the sender: it is a websocket at the far end. Everything the
 * handlers actually decide — the gate, the candidate list, the source rule, the transcript cache —
 * is real.
 */

import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { RecipientResolution, SendResult, Transcript } from "whatsapp-api-sdk";

import { ConnectionUnavailableError } from "../../whatsapp/connection.js";
import { FIXTURE_DM, FIXTURE_GROUP, FIXTURE_SELF } from "../../whatsapp/fixtures.js";
import { AmbiguousRecipientError } from "../../whatsapp/recipient.js";
import { SendPathError } from "../../whatsapp/send.js";
import { at, harness, jsonBody, type Harness, type WireErrorBody } from "./harness.js";

const ALICE = FIXTURE_DM;
const GROUP = FIXTURE_GROUP;
const CHAT = encodeURIComponent(ALICE);

async function start(t: TestContext, opts: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = await harness(opts);
  t.after(() => h.close());
  return h;
}

/** Every route the read-only gate is meant to cover, as a request each. */
const GATED: readonly { name: string; path: string; init: RequestInit }[] = [
  { name: "sendText", path: "/v1/messages", init: jsonBody({ recipient: ALICE, text: "hi" }) },
  { name: "sendFile", path: "/v1/messages/file", init: jsonBody({ recipient: ALICE, data: "aGk=" }) },
  { name: "editMessage", path: `/v1/messages/${CHAT}/M1`, init: jsonBody({ text: "hi" }, "PATCH") },
  { name: "deleteMessage", path: `/v1/messages/${CHAT}/M1`, init: { method: "DELETE" } },
  { name: "react", path: `/v1/messages/${CHAT}/M1/reaction`, init: jsonBody({ emoji: "👍" }) },
  { name: "markRead", path: `/v1/chats/${CHAT}/read`, init: jsonBody({ messageId: "M1" }) },
];

// --- the happy paths --------------------------------------------------------------------------

void test("a send answers 201 with where the message landed, not with what the caller typed", async (t) => {
  const h = await start(t, { sendResult: { chatId: ALICE, messageId: "S1" } });

  const res = await h.req("/v1/messages", jsonBody({ recipient: "0033612345678", text: "bonjour" }));
  assert.equal(res.status, 201);
  const body = SendResult.parse(await res.json());
  // The chat the *sender* resolved to, which is the whole reason it answers with one.
  assert.deepEqual(body, { chat: ALICE, messageId: "S1" });
  assert.deepEqual(h.sendCalls[0]?.args.slice(0, 2), ["0033612345678", "bonjour"]);
});

void test("sendFile carries every option through and answers 201", async (t) => {
  const h = await start(t, { sendResult: { chatId: ALICE, messageId: "S2" } });

  const res = await h.req(
    "/v1/messages/file",
    jsonBody({ recipient: ALICE, data: "aGk=", filename: "a.pdf", mimetype: "application/pdf", caption: "voilà" }),
  );
  assert.equal(res.status, 201);
  assert.deepEqual(SendResult.parse(await res.json()), { chat: ALICE, messageId: "S2" });
  assert.deepEqual(at(h.sendCalls, 0).args[1], { kind: "data", base64: "aGk=" });
  const options = at(h.sendCalls, 0).args[2] as { filename?: string; caption?: string };
  assert.equal(options.filename, "a.pdf");
  assert.equal(options.caption, "voilà");
});

void test("the four message-scoped writes answer 200 naming the chat the sender acted on", async (t) => {
  const h = await start(t, { sendResult: { chatId: ALICE, messageId: "ignored" } });

  const cases: readonly { path: string; init: RequestInit; messageId: string }[] = [
    { path: `/v1/messages/${CHAT}/M1`, init: jsonBody({ text: "corrigé" }, "PATCH"), messageId: "M1" },
    { path: `/v1/messages/${CHAT}/M2`, init: { method: "DELETE" }, messageId: "M2" },
    { path: `/v1/messages/${CHAT}/M3/reaction`, init: jsonBody({ emoji: "🎉" }), messageId: "M3" },
    { path: `/v1/chats/${CHAT}/read`, init: jsonBody({ messageId: "M4" }), messageId: "M4" },
  ];
  for (const c of cases) {
    const res = await h.req(c.path, c.init);
    assert.equal(res.status, 200, c.path);
    assert.deepEqual(SendResult.parse(await res.json()), { chat: ALICE, messageId: c.messageId }, c.path);
  }
});

/**
 * An empty `emoji` is how WhatsApp models *removing* a reaction, so the wire schema takes no
 * `.min(1)` and neither does this layer. The obvious improvement deletes the removal path, and it
 * would look like a tightening rather than a regression.
 */
void test("an empty emoji is a removal, not a refusal", async (t) => {
  const h = await start(t);
  const res = await h.req(`/v1/messages/${CHAT}/M1/reaction`, jsonBody({ emoji: "" }));
  assert.equal(res.status, 200);
  assert.equal(h.sendCalls[0]?.args[2], "");
});

// --- the read-only gate -----------------------------------------------------------------------

void test("a read-only deployment refuses every write even when asked directly", async (t) => {
  const h = await start(t, { readOnly: true });

  for (const route of GATED) {
    const res = await h.req(route.path, route.init);
    assert.equal(res.status, 403, route.name);
    const body = (await res.json()) as WireErrorBody;
    assert.equal(body.error.code, "read_only", route.name);
  }
  // Refused before anything was resolved or sent, not after.
  assert.deepEqual(h.sendCalls, []);
});

/**
 * `whatsapp_transcribe` lives in `registerMediaTools`, which `config.readOnly` does not skip, so it
 * answers today in a read-only deployment. Gating it here would be a behaviour change smuggled in
 * under a refactor — and `resolveRecipient` sends nothing at all.
 */
void test("transcribe and resolveRecipient stay outside the gate, as they are today", async (t) => {
  const h = await start(t, { readOnly: true });
  h.seed(ALICE, false, [
    {
      id: "V1",
      ts: 1_700_000_001,
      kind: "audio",
      text: null,
      transcript: { text: "salut", model: "m", language: "fr" },
    },
  ]);

  assert.equal((await h.req(`/v1/messages/${CHAT}/V1/transcribe`, { method: "POST" })).status, 200);
  assert.equal((await h.req("/v1/recipients/resolve", jsonBody({ recipient: ALICE }))).status, 200);
});

// --- recipients -------------------------------------------------------------------------------

void test("an ambiguous recipient is refused with numbered candidates in the resolver's order", async (t) => {
  const h = await start(t, {
    // The real resolver raises this from inside the sender; the stub raises the same class so the
    // handler's job — attaching the details — is what is under test.
    sendError: () => new AmbiguousRecipientError('"Marie" matches 2 chats or contacts'),
  });
  h.deps.contacts.upsert({ id: ALICE, name: "Marie Dupont" });
  h.deps.contacts.upsert({ id: FIXTURE_SELF, name: "Marie Curie" });

  const res = await h.req("/v1/messages", jsonBody({ recipient: "Marie", text: "hi" }));
  assert.equal(res.status, 409);
  const body = (await res.json()) as WireErrorBody;
  assert.equal(body.error.code, "ambiguous_recipient");
  const candidates = RecipientResolution.parse(body.error.details).candidates;
  assert.deepEqual(
    candidates.map((c) => c.index),
    [1, 2],
  );
  // The resolver's own total order — exact first, then label, then id — not query order.
  assert.deepEqual(
    candidates.map((c) => c.label),
    ["Marie Curie", "Marie Dupont"],
  );
});

void test("resolveRecipient exposes the same list without sending anything", async (t) => {
  const h = await start(t);
  h.deps.contacts.upsert({ id: ALICE, name: "Marie Dupont" });
  h.deps.contacts.upsert({ id: FIXTURE_SELF, name: "Marie Curie" });

  const body = RecipientResolution.parse(await h.json("/v1/recipients/resolve", jsonBody({ recipient: "Marie" })));
  assert.deepEqual(
    body.candidates.map((c) => c.index),
    [1, 2],
  );
  assert.deepEqual(h.sendCalls, []);
});

void test("a JID resolves to the one candidate it is, folded to the id the store keys on", async (t) => {
  const h = await start(t);
  // The link first: it is what writes the phone number `pnForLid` keys the mapping on, and a bare
  // `upsert` of a name would leave that column NULL.
  h.deps.contacts.linkIdentity("999@lid", ALICE);
  h.deps.contacts.upsert({ id: ALICE, name: "Marie Dupont" });

  const body = RecipientResolution.parse(await h.json("/v1/recipients/resolve", jsonBody({ recipient: "999@lid" })));
  assert.deepEqual(body.candidates, [{ index: 1, id: ALICE, label: "Marie Dupont", exact: true }]);
});

void test("a group name resolves too, and an unmatched name answers an empty list rather than an error", async (t) => {
  const h = await start(t);
  h.deps.chats.ensure(GROUP, true);
  h.deps.chats.patch(GROUP, { name: "Les Amis" });

  const found = RecipientResolution.parse(await h.json("/v1/recipients/resolve", jsonBody({ recipient: "Amis" })));
  assert.deepEqual(found.candidates, [{ index: 1, id: GROUP, label: "Les Amis", exact: false }]);

  const none = RecipientResolution.parse(await h.json("/v1/recipients/resolve", jsonBody({ recipient: "Nobody" })));
  assert.deepEqual(none.candidates, []);
});

// --- sendFile's source rule -------------------------------------------------------------------

void test("path sending is refused when no directory is configured, without echoing the path", async (t) => {
  const h = await start(t, {
    // What `whatsapp/send.ts` raises when `WHATSAPP_SEND_FILE_DIR` is unset, which is the default.
    sendError: () =>
      new SendPathError(
        "sending a file by path is disabled; set WHATSAPP_SEND_FILE_DIR to the directory files may be read from",
      ),
  });

  const res = await h.req("/v1/messages/file", jsonBody({ recipient: ALICE, path: "/proc/self/environ" }));
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.doesNotMatch(text, /proc/);
  assert.equal((JSON.parse(text) as WireErrorBody).error.code, "send_path_refused");
  // Nor into the log, where the route pattern stands in for the concrete path.
  assert.doesNotMatch(JSON.stringify(h.entries), /proc/);
});

void test("both sources, or neither, are different mistakes and are named apart", async (t) => {
  const h = await start(t);

  const both = await h.req("/v1/messages/file", jsonBody({ recipient: ALICE, data: "aGk=", path: "/tmp/x" }));
  assert.equal(both.status, 400);
  assert.match(((await both.json()) as WireErrorBody).error.message, /not both/);

  const neither = await h.req("/v1/messages/file", jsonBody({ recipient: ALICE }));
  assert.equal(neither.status, 400);
  assert.match(((await neither.json()) as WireErrorBody).error.message, /exactly one/);

  assert.deepEqual(h.sendCalls, []);
});

// --- failures from below ------------------------------------------------------------------------

void test("a write with the socket down is not_connected, and says which state", async (t) => {
  const h = await start(t, { state: "disconnected", sendError: () => new ConnectionUnavailableError("disconnected") });

  const res = await h.req("/v1/messages", jsonBody({ recipient: ALICE, text: "hi" }));
  assert.equal(res.status, 503);
  const body = (await res.json()) as WireErrorBody;
  assert.equal(body.error.code, "not_connected");
  assert.equal(body.error.name, "ConnectionUnavailableError");
});

void test("a body the route schema refuses names the field, never its value", async (t) => {
  const h = await start(t);

  const res = await h.req("/v1/messages", jsonBody({ recipient: ALICE, text: "" }));
  assert.equal(res.status, 400);
  const body = (await res.json()) as WireErrorBody;
  assert.match(body.error.message, /text/);
});

// --- transcription ------------------------------------------------------------------------------

void test("transcribe answers from the cache without spending anything", async (t) => {
  const h = await start(t);
  h.seed(ALICE, false, [
    {
      id: "V1",
      ts: 1_700_000_001,
      kind: "audio",
      text: null,
      transcript: { text: "déjà transcrit", model: "voxtral", language: "fr" },
    },
  ]);

  const body = Transcript.parse(await h.json(`/v1/messages/${CHAT}/V1/transcribe`, { method: "POST" }));
  assert.deepEqual(body, { text: "déjà transcrit", model: "voxtral", language: "fr" });
  assert.equal(h.transcribeCalls.n, 0);
});

/**
 * The write-back is not a detail: the UPDATE fires the FTS trigger, and that is what puts the
 * speech into the search index. A handler that kept the result in memory would answer correctly
 * once and leave the message unfindable forever.
 */
void test("a first transcription runs, is stored with its provenance, and becomes searchable", async (t) => {
  const h = await start(t, { transcript: { text: "bonjour tout le monde", model: "voxtral", language: "fr" } });
  h.seed(ALICE, false, [{ id: "V1", ts: 1_700_000_001, kind: "audio", text: null }]);
  h.attach(ALICE, "V1", Buffer.from("fake audio"), "audio/ogg");

  const body = Transcript.parse(await h.json(`/v1/messages/${CHAT}/V1/transcribe`, { method: "POST" }));
  assert.deepEqual(body, { text: "bonjour tout le monde", model: "voxtral", language: "fr" });
  assert.equal(h.transcribeCalls.n, 1);

  const row = h.deps.messages.get(ALICE, "V1");
  assert.equal(row?.transcriptModel, "voxtral");
  const hits = h.deps.messages.search("bonjour", {}, 10, 0);
  assert.deepEqual(
    hits.map((hit) => hit.id),
    ["V1"],
  );

  // And the second call is free.
  await h.req(`/v1/messages/${CHAT}/V1/transcribe`, { method: "POST" });
  assert.equal(h.transcribeCalls.n, 1);
});

void test("an unknown message is message_not_found before anything is fetched or spent", async (t) => {
  const h = await start(t);
  const res = await h.req(`/v1/messages/${CHAT}/NOPE/transcribe`, { method: "POST" });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as WireErrorBody).error.code, "message_not_found");
  assert.equal(h.transcribeCalls.n, 0);
});
