/**
 * The six read routes, over a real socket against a real store.
 *
 * Three properties carry most of the weight, and each is invisible to a test that calls the handler
 * directly: a read answers in every connection state, a page's reactions cost one query however
 * many rows it has, and a malformed cursor is a refusal rather than a silent walk back to page 1.
 *
 * Every response body is parsed against the SDK schema it claims to be rather than deep-equalled
 * against a literal. `tsc` cannot catch a millisecond timestamp — it is a `number` either way — and
 * `epochSeconds` can.
 */

import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { Chat, Contact, Message, MessageDetail, Page, SearchHit } from "whatsapp-api-sdk";

import type { MessageKey, ReactionsRepo } from "../../db/reactions.js";
import { FIXTURE_DM, FIXTURE_GROUP, FIXTURE_SELF } from "../../whatsapp/fixtures.js";
import { decodeCursor } from "../cursor.js";
import { harness, type Harness, type SeedMessage, type WireErrorBody } from "./harness.js";

const ALICE = FIXTURE_DM;
const GROUP = FIXTURE_GROUP;

/** Boot a harness torn down when the test ends, so a failure cannot leak a listener or a temp dir. */
async function start(t: TestContext, opts: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = await harness(opts);
  t.after(() => h.close());
  return h;
}

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

/** A run of messages, newest last, so a listing has something to page through. */
function run(count: number, from = 1): SeedMessage[] {
  return Array.from({ length: count }, (_, i) => ({ id: `M${String(from + i)}`, ts: 1_700_000_000 + from + i }));
}

// --- listings ---------------------------------------------------------------------------------

void test("reads answer while the socket is down, because none of them touches it", async (t) => {
  const h = await start(t, { state: "disconnected" });
  h.seed(ALICE, false, run(2));

  for (const path of ["/v1/chats", "/v1/groups", "/v1/contacts", "/v1/messages", "/v1/messages/search?q=message"]) {
    assert.equal((await h.req(path)).status, 200, path);
  }
});

void test("a chat listing is a page of Chats, and the group route is the same query with the filter fixed", async (t) => {
  const h = await start(t);
  h.seed(ALICE, false, run(1));
  h.seed(GROUP, true, [{ id: "G1", ts: 1_700_000_100, sender: ALICE }]);

  const chats = Page(Chat).parse(await h.json("/v1/chats"));
  assert.deepEqual(ids(chats.items).toSorted(), [GROUP, ALICE].toSorted());

  const groups = Page(Chat).parse(await h.json("/v1/groups"));
  assert.deepEqual(ids(groups.items), [GROUP]);
  assert.equal(groups.items[0]?.isGroup, true);
});

void test("a contact listing answers unfiltered, and narrows on a query", async (t) => {
  const h = await start(t);
  h.deps.contacts.upsert({ id: ALICE, name: "Marie Dupont" });
  h.deps.contacts.upsert({ id: FIXTURE_SELF, name: "Moi" });

  const all = Page(Contact).parse(await h.json("/v1/contacts"));
  assert.equal(all.items.length, 2);

  const one = Page(Contact).parse(await h.json("/v1/contacts?query=marie"));
  assert.deepEqual(
    one.items.map((c) => c.name),
    ["Marie Dupont"],
  );
});

void test("a message listing carries the batched reaction count and a search hit carries its snippet", async (t) => {
  const h = await start(t);
  h.seed(ALICE, false, [{ id: "M1", ts: 1_700_000_001, text: "orange juice" }]);
  h.deps.reactions.set({ chatId: ALICE, messageId: "M1", senderId: FIXTURE_SELF, emoji: "👍", ts: 1_700_000_002 });

  const page = Page(Message).parse(await h.json("/v1/messages"));
  assert.equal(page.items[0]?.reactionCount, 1);

  const hits = Page(SearchHit).parse(await h.json("/v1/messages/search?q=orange"));
  assert.deepEqual(ids(hits.items), ["M1"]);
  assert.match(hits.items[0]?.snippet ?? "", /orange/);
  assert.equal(hits.items[0]?.matchedTranscript, false);
});

/**
 * The denormalisation's whole reason for existing. Over HTTP a client cannot issue one request per
 * row, so the count rides on the row — and a port that fetched it per row turns a fifty-row page
 * into fifty queries. The repository is wrapped before the handlers are built, because they close
 * over what they are handed.
 */
void test("a whole page of reactions costs one grouped query, not one per row", async (t) => {
  const calls = { countsFor: 0, forMessage: 0 };
  const h = await start(t, {
    instrument: (deps) => {
      const real: ReactionsRepo = deps.reactions;
      deps.reactions = {
        ...real,
        countsFor: (keys: readonly MessageKey[]) => {
          calls.countsFor++;
          return real.countsFor(keys);
        },
        forMessage: (chatId: string, messageId: string) => {
          calls.forMessage++;
          return real.forMessage(chatId, messageId);
        },
      };
    },
  });
  h.seed(ALICE, false, run(25));

  const page = Page(Message).parse(await h.json("/v1/messages?limit=25"));
  assert.equal(page.items.length, 25);
  assert.deepEqual(calls, { countsFor: 1, forMessage: 0 });
});

// --- pagination -------------------------------------------------------------------------------

void test("a page hands back a cursor only when there really is another page", async (t) => {
  const h = await start(t);
  h.seed(ALICE, false, run(4));

  const first = Page(Message).parse(await h.json("/v1/messages?limit=2"));
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor !== null);
  assert.equal(decodeCursor(first.nextCursor), 2);

  const second = Page(Message).parse(await h.json(`/v1/messages?limit=2&cursor=${first.nextCursor}`));
  assert.deepEqual(ids(second.items), ["M2", "M1"]);
  // The overfetch earning its keep: four rows at two per page is an exact multiple, and the naive
  // "full page means more" rule would hand out a cursor onto an empty third page here.
  assert.equal(second.nextCursor, null);
});

void test("a malformed cursor is an error, never a reset to the first page", async (t) => {
  const h = await start(t);
  h.seed(ALICE, false, run(1));

  for (const path of ["/v1/chats?cursor=not-a-cursor", "/v1/messages?cursor=not-a-cursor"]) {
    const res = await h.req(path);
    assert.equal(res.status, 400, path);
    const body = (await res.json()) as WireErrorBody;
    assert.equal(body.error.code, "bad_request");
    assert.equal(body.error.name, "CursorError");
    // Caller-controlled text is never echoed back into a model's context.
    assert.doesNotMatch(body.error.message, /not-a-cursor/);
  }
});

void test("the default page is 50, the number the tool schema advertises", async (t) => {
  const h = await start(t);
  h.seed(ALICE, false, run(51));
  const page = Page(Message).parse(await h.json("/v1/messages"));
  assert.equal(page.items.length, 50);
  assert.ok(page.nextCursor !== null);
});

void test("a limit outside the contract's bounds is refused by the route schema", async (t) => {
  const h = await start(t);
  const res = await h.req("/v1/messages?limit=500");
  assert.equal(res.status, 400);
  const body = (await res.json()) as WireErrorBody;
  assert.match(body.error.message, /limit/);
});

// --- filters ----------------------------------------------------------------------------------

void test("a contradictory kind/hasMedia pair is refused, not answered with an empty page", async (t) => {
  const h = await start(t);
  h.seed(ALICE, false, [{ id: "M1", ts: 1_700_000_001, text: "orange" }]);

  for (const path of ["/v1/messages?kind=text&hasMedia=true", "/v1/messages/search?q=orange&kind=text&hasMedia=true"]) {
    const res = await h.req(path);
    assert.equal(res.status, 400, path);
    const body = (await res.json()) as WireErrorBody;
    assert.equal(body.error.code, "bad_request");
    // The substring the tool layer has always carried, so what a model reads does not move.
    assert.match(body.error.message, /contradicts kind="text"/);
  }

  // A consistent pair is not refused, which is what makes the check about the contradiction rather
  // than about the two arguments ever appearing together.
  const ok = Page(Message).parse(await h.json("/v1/messages?kind=text&hasMedia=false"));
  assert.deepEqual(ids(ok.items), ["M1"]);
});

/**
 * Every one of these is a boolean or a string landing on a differently-named repository field —
 * `unread` onto `unreadOnly`, `chat` onto `chatId`, `sender` onto `senderId` — and a pair swapped
 * in the mapping type-checks perfectly. Only a test that varies one at a time catches it.
 */
void test("each chat filter lands on the repository field it means", async (t) => {
  const h = await start(t);
  h.seed(ALICE, false, [{ id: "M1", ts: 1_700_000_001 }]);
  h.seed(GROUP, true, [{ id: "G1", ts: 1_700_000_002, sender: ALICE }]);
  h.deps.chats.patch(GROUP, { name: "Les Amis", archived: true });
  h.deps.chats.bumpUnread(ALICE, 3);

  const only = async (query: string): Promise<string[]> =>
    ids(Page(Chat).parse(await h.json(`/v1/chats?${query}`)).items);
  assert.deepEqual(await only("isGroup=true"), [GROUP]);
  assert.deepEqual(await only("isGroup=false"), [ALICE]);
  assert.deepEqual(await only("archived=true"), [GROUP]);
  assert.deepEqual(await only("archived=false"), [ALICE]);
  assert.deepEqual(await only("unread=true"), [ALICE]);
  assert.deepEqual(await only("query=amis"), [GROUP]);
});

void test("the chat and sender filters are folded through canonicalId before they reach the store", async (t) => {
  const h = await start(t);
  h.deps.contacts.linkIdentity("999@lid", ALICE);
  h.seed(GROUP, true, [
    { id: "G1", ts: 1_700_000_001, sender: ALICE },
    { id: "G2", ts: 1_700_000_002, sender: FIXTURE_SELF, fromMe: true },
  ]);

  assert.deepEqual(ids(Page(Message).parse(await h.json(`/v1/messages?chat=${encodeURIComponent(GROUP)}`)).items), [
    "G2",
    "G1",
  ]);
  // The LID names the same person as the phone JID, so it must find the same messages.
  assert.deepEqual(ids(Page(Message).parse(await h.json("/v1/messages?sender=999%40lid")).items), ["G1"]);
});

void test("filters narrow, and asc reverses the order", async (t) => {
  const h = await start(t);
  h.seed(ALICE, false, [
    { id: "T1", ts: 1_700_000_001, text: "one" },
    { id: "P1", ts: 1_700_000_002, kind: "image" },
    { id: "T2", ts: 1_700_000_003, text: "two", fromMe: true, sender: FIXTURE_SELF },
  ]);

  assert.deepEqual(ids(Page(Message).parse(await h.json("/v1/messages?kind=image")).items), ["P1"]);
  assert.deepEqual(ids(Page(Message).parse(await h.json("/v1/messages?hasMedia=true")).items), ["P1"]);
  assert.deepEqual(ids(Page(Message).parse(await h.json("/v1/messages?fromMe=true")).items), ["T2"]);
  assert.deepEqual(ids(Page(Message).parse(await h.json("/v1/messages?asc=true")).items), ["T1", "P1", "T2"]);
  assert.deepEqual(ids(Page(Message).parse(await h.json("/v1/messages?after=1700000002&before=1700000002")).items), [
    "P1",
  ]);
});

// --- one message ------------------------------------------------------------------------------

/**
 * The field a plain `Message` would have dropped with nothing to notice, because it would simply be
 * absent: `whatsapp_download_media`'s summary embeds this array.
 */
void test("getMessage answers MessageDetail with the full per-reactor list", async (t) => {
  const h = await start(t);
  h.seed(ALICE, false, [{ id: "M1", ts: 1_700_000_001 }]);
  h.deps.contacts.upsert({ id: FIXTURE_SELF, name: "Moi" });
  h.deps.reactions.set({ chatId: ALICE, messageId: "M1", senderId: FIXTURE_SELF, emoji: "🎉", ts: 1_700_000_002 });

  const detail = MessageDetail.parse(await h.json(`/v1/messages/${encodeURIComponent(ALICE)}/M1`));
  assert.deepEqual(detail.reactions, [{ emoji: "🎉", from: { id: FIXTURE_SELF, name: "Moi" } }]);
  // The count still rides along, and agrees with the array rather than costing a second query.
  assert.equal(detail.reactionCount, 1);
});

void test("an unknown message is message_not_found rather than an empty body", async (t) => {
  const h = await start(t);
  h.seed(ALICE, false, run(1));

  const res = await h.req(`/v1/messages/${encodeURIComponent(ALICE)}/NOPE`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as WireErrorBody;
  assert.equal(body.error.code, "message_not_found");
  assert.equal(body.error.name, "MessageNotFoundError");
});

/**
 * The fold is applied at this boundary and nowhere below (Global Constraint 3). A LID and its phone
 * JID name one conversation, so a route reached by the LID must find the row stored under the phone
 * id — and a handler that skipped `canonicalId` would answer `message_not_found` for a message that
 * is right there.
 */
void test("a message named by LID resolves to the row stored under the phone JID", async (t) => {
  const h = await start(t);
  h.seed(ALICE, false, [{ id: "M1", ts: 1_700_000_001 }]);
  const lid = "999@lid";
  h.deps.contacts.linkIdentity(lid, ALICE);

  const detail = MessageDetail.parse(await h.json(`/v1/messages/${encodeURIComponent(lid)}/M1`));
  assert.equal(detail.chat, ALICE);
});
