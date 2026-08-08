/**
 * The six read tools, ported from `packages/api/src/mcp/tools/reads.test.ts`.
 *
 * **Every assertion here is the one the retired suite made**, unless it appears in the list below.
 * That list is the deliverable as much as the tests are: the two worst defects this plan's hardening
 * found — a redefined `whatsapp_health.ok` and a dropped reaction array — were both assertion-level
 * drift that a green suite would have reported as success. So an assertion that changed has to be
 * one someone can name, and these are the names.
 *
 * **Assertions that changed, and why.**
 *
 * 1. `schema_version` was compared against `packages/api`'s `SCHEMA_VERSION` constant, which this
 *    package cannot import (Global Constraint 1). It is now compared against the number the API
 *    reported, which is what the tool must pass through — the constant's *value* is pinned by the
 *    API's own suite.
 * 2. `last_event_age_sec` was asserted as a range (`>= 42 && <= 44`) because the retired harness
 *    computed it from a live clock. It is a field on the API's report now, so the assertion is an
 *    equality. Tighter, not looser.
 * 3. The secrets test named `WHATSAPP_MCP_TOKEN` and `NTFY_TOKEN`. This process has no ntfy; its two
 *    secrets are `WHATSAPP_API_TOKEN` and `WHATSAPP_MCP_TOKEN`, and both are asserted absent.
 * 4. "every read tool describes what it reads" compared the whole advertised tool list against the
 *    six read tools, because Task 12's server registered only those. The real server registers
 *    fourteen, so the six are selected out of the list and the *fourteen* are pinned in
 *    `server.test.ts` instead. The per-tool description assertions are unchanged.
 * 5. "the advertised schema is what enforces the cap" iterated every tool except `whatsapp_health`.
 *    The media and write tools take no `limit`, so it iterates the four paginated read tools by
 *    name. The assertions on each are unchanged.
 * 6. The malformed-cursor test's `decodeCursor(cursor) === 2` decoded the API's cursor with the
 *    API's own decoder. A cursor is opaque to this process by design, so the assertion is now that
 *    the exact token the API handed out came back out of the truncated page unaltered.
 *
 * **Assertions that were dropped, and why.** Each names behaviour that is now the API's, is covered
 * by `packages/api`'s own suite, and cannot be observed from this side of the split without the
 * fake asserting against itself:
 *
 * - "resolves a chat named by its LID to the folded phone chat" — `canonicalId` runs at the API
 *   boundary and nowhere else (Global Constraint 11). Replaced by a test that the JID reaches the
 *   API **uninterpreted**, which is this layer's half of that constraint.
 * - "a page of reaction counts is one grouped query" and "a search page spanning many chats is
 *   still one grouped query" — both counted calls into a SQLite repository this process does not
 *   have. The observable half is kept, in both places: every row carries its own `reaction_count`.
 *   (Only the *message* of the search assertion changed, from "counts are grouped per chat" — which
 *   describes the query plan — to "counts ride on the row", which describes what arrives.)
 * - "a row inserted mid-walk is re-shown, never skipped" — a documented property of the API's
 *   offset cursor.
 * - "a transcript hit is labelled as one even when the message carries text of its own" — the two
 *   shapes it distinguishes are FTS5 `snippet()` behaviours. What reaches this layer is one boolean,
 *   which the kept transcript test already pins in both states.
 * - the "never explodes on operators" half of the search test — FTS quoting is the API's. Replaced
 *   by an assertion that the query text is forwarded verbatim rather than escaped here.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ApiUnreachableError,
  Chat,
  Contact,
  Message,
  SearchHit,
  type MessageKind,
  type SearchQuery,
} from "whatsapp-api-sdk";

import { harness, resultJson, resultPage, resultText, type FakeApi } from "./harness.js";

const READ_TOOLS = [
  "whatsapp_health",
  "whatsapp_chats_list",
  "whatsapp_messages_list",
  "whatsapp_messages_search",
  "whatsapp_contacts_search",
  "whatsapp_groups_list",
] as const;

/** The four tools that page. `whatsapp_health` takes nothing; the media and write tools take no limit. */
const PAGED_TOOLS = [
  "whatsapp_chats_list",
  "whatsapp_messages_list",
  "whatsapp_groups_list",
  "whatsapp_contacts_search",
] as const;

const ALICE = "33611111111@s.whatsapp.net";
const BOB = "33622222222@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";

/** `text: null` means the message carries none at all, which is what a voice note looks like. */
type SeedMessage = {
  id: string;
  ts: number;
  chat?: string;
  text?: string | null;
  transcript?: string;
  kind?: MessageKind;
  sender?: string;
  senderName?: string;
  fromMe?: boolean;
  mediaType?: string;
  reactionCount?: number;
};

/**
 * A wire message, parsed by the schema it will arrive under.
 *
 * `.parse` rather than a cast: a fixture that could never come off the wire proves nothing, and the
 * denormalisation the API performs — a resolved `sender.name`, a filled `reactionCount` — is exactly
 * what the shape of these tests depends on.
 */
function message(m: SeedMessage): Message {
  const kind = m.kind ?? "text";
  return Message.parse({
    id: m.id,
    chat: m.chat ?? ALICE,
    ts: m.ts,
    fromMe: m.fromMe ?? false,
    sender: { id: m.sender ?? ALICE, name: m.senderName ?? m.sender ?? ALICE },
    kind,
    text: m.text === null ? null : (m.text ?? `message ${m.id}`),
    transcript: m.transcript ?? null,
    quotedId: null,
    status: null,
    edited: false,
    deleted: false,
    media: m.mediaType === undefined ? null : { type: m.mediaType, cached: false },
    reactionCount: m.reactionCount ?? 0,
  });
}

function hit(m: SeedMessage & { snippet?: string; matchedTranscript?: boolean }): SearchHit {
  return SearchHit.parse({
    ...message(m),
    snippet: m.snippet ?? `…${m.text ?? ""}…`,
    matchedTranscript: m.matchedTranscript ?? false,
  });
}

function chat(c: {
  id: string;
  name?: string | null;
  isGroup?: boolean;
  lastMessageTs?: number | null;
  unreadCount?: number;
  archived?: boolean;
  participantCount?: number | null;
}): Chat {
  return Chat.parse({
    id: c.id,
    name: c.name ?? null,
    isGroup: c.isGroup ?? false,
    lastMessageTs: c.lastMessageTs ?? null,
    unreadCount: c.unreadCount ?? 0,
    archived: c.archived ?? false,
    mutedUntil: null,
    participantCount: c.participantCount ?? null,
  });
}

const ids = (items: readonly Record<string, unknown>[]): string[] => items.map((i) => i["id"] as string);

/** The row at `i`, asserted present. Keeps every later read off an optional chain the linter rejects. */
function at(items: readonly Record<string, unknown>[], i: number): Record<string, unknown> {
  const row = items[i];
  assert.ok(row !== undefined, `expected an item at index ${i}`);
  return row;
}

/** The query object a read tool actually sent, which is where a rename goes wrong. */
function queryOf(api: FakeApi, route: "listChats" | "listMessages" | "searchMessages" | "listContacts" | "listGroups") {
  const input = api.inputOf(route) as { query: Record<string, unknown> } | undefined;
  assert.ok(input !== undefined, `expected a call to ${route}`);
  return input.query;
}

// ── Health ────────────────────────────────────────────────────────────────

void test("whatsapp_health reports the connection state and row counts without a socket", async () => {
  const h = await harness({
    state: "disconnected",
    seed: (api) => {
      api.data.health.counts = { chats: 1, messages: 1, contacts: 0 };
      api.data.health.schema_version = 7;
    },
  });
  const data = resultJson(await h.client.callTool({ name: "whatsapp_health", arguments: {} }));

  assert.equal(data["connection"], "disconnected");
  assert.equal(typeof data["counts"], "object");
  assert.deepEqual(data["counts"], { chats: 1, messages: 1, contacts: 0 });
  assert.equal(data["schema_version"], 7);
  assert.equal(data["read_only"], false);
  // `null`, not an all-zero object: "nothing queued" and "the feature is off" are different
  // answers, and only one of them makes an empty queue worth investigating.
  assert.equal(data["auto_transcribe"], null);
  assert.equal(data["needs_pairing"], false);
  assert.equal(data["self_id"], "33600000000@s.whatsapp.net");
  await h.close();
});

void test("whatsapp_health is ok in every state except logged_out", async () => {
  for (const state of ["disconnected", "connecting", "pairing", "connected"] as const) {
    const h = await harness({ state });
    const data = resultJson(await h.client.callTool({ name: "whatsapp_health", arguments: {} }));
    assert.equal(data["ok"], true, `${state} still serves reads, so it must not flap the healthcheck`);
    await h.close();
  }

  const h = await harness({ state: "logged_out" });
  const data = resultJson(await h.client.callTool({ name: "whatsapp_health", arguments: {} }));
  assert.equal(data["ok"], false, "a logged-out server is dead until someone re-pairs it");
  assert.equal(data["needs_pairing"], true);
  await h.close();
});

void test("whatsapp_health reports the age of the last event in seconds, not milliseconds", async () => {
  const h = await harness({ lastEventAgeSec: 42 });
  const data = resultJson(await h.client.callTool({ name: "whatsapp_health", arguments: {} }));
  assert.equal(data["last_event_age_sec"], 42);
  await h.close();
});

void test("whatsapp_health reports the newest ingested message, which is not the last event", async () => {
  // An empty store has no newest message, and `0` would read as 1970 to anything doing arithmetic.
  const empty = await harness();
  assert.equal(
    resultJson(await empty.client.callTool({ name: "whatsapp_health", arguments: {} }))["last_message_at"],
    null,
  );
  await empty.close();

  // The point of the field: the socket is healthy and its last *event* is recent, while ingestion
  // stopped long ago. Only `last_message_at` can tell those apart, and a watchdog outside the
  // process is the only thing that can act on it.
  const h = await harness({
    state: "connected",
    lastEventAgeSec: 0,
    seed: (api) => {
      api.data.health.last_message_at = 1_700_009_999;
    },
  });
  const data = resultJson(await h.client.callTool({ name: "whatsapp_health", arguments: {} }));
  assert.equal(data["last_message_at"], 1_700_009_999, "the MAX over the store, not the last row written");
  assert.ok((data["last_event_age_sec"] as number) < 5, "and the connection still looks perfectly fresh");
  await h.close();
});

void test("whatsapp_health carries no secret from the config", async () => {
  const h = await harness({
    env: {
      WHATSAPP_API_URL: "http://api.example:8080",
      WHATSAPP_API_TOKEN: "bearer-SUPERSECRET",
      WHATSAPP_MCP_TOKEN: "client-ALSOSECRET",
    },
  });
  const text = resultText(await h.client.callTool({ name: "whatsapp_health", arguments: {} }));

  assert.doesNotMatch(text, /SUPERSECRET/, "WHATSAPP_API_TOKEN must never reach a health response");
  assert.doesNotMatch(text, /ALSOSECRET/, "WHATSAPP_MCP_TOKEN must never reach a health response");
  await h.close();
});

void test("whatsapp_health reflects whether transcription can run", async () => {
  for (const available of [true, false]) {
    const h = await harness({ transcriptionAvailable: available });
    const data = resultJson(await h.client.callTool({ name: "whatsapp_health", arguments: {} }));
    assert.equal(data["transcription_available"], available);
    await h.close();
  }
});

/**
 * The split's second sanctioned change to tool output (spec §7.1): one extra object, and `ok`
 * untouched.
 *
 * The trap this closes is the one hardening found: making `ok` mean "logged in *and* the API
 * answered" reads like an improvement and silently redefines a field whose own tool description
 * says it is false only when the account has been logged out.
 */
void test("whatsapp_health adds one api object and leaves ok exactly as the API set it", async () => {
  const h = await harness({ state: "connected", env: { WHATSAPP_API_URL: "http://api.example:8080/" } });
  const data = resultJson(await h.client.callTool({ name: "whatsapp_health", arguments: {} }));

  assert.equal(data["ok"], true);
  const api = data["api"] as Record<string, unknown>;
  assert.equal(api["reachable"], true);
  assert.equal(typeof api["latencyMs"], "number");
  assert.equal(api["url"], "http://api.example:8080", "the configured base, trailing slash trimmed");
  assert.equal(api["error"], null);
  // `ok` first, so a probe reading a truncated body finds it; `api` last, so it cannot displace a
  // field the API sent.
  const keys = Object.keys(data);
  assert.equal(keys[0], "ok");
  assert.equal(keys[keys.length - 1], "api");
  await h.close();
});

void test("whatsapp_health fails rather than inventing a report the API never sent", async () => {
  const h = await harness({
    overrides: {
      getHealth: () => Promise.reject(new ApiUnreachableError("could not reach the API at http://api:8080")),
    },
  });
  const res = await h.client.callTool({ name: "whatsapp_health", arguments: {} });

  assert.equal(res.isError, true, "no report means no report");
  const text = resultText(res);
  assert.match(text, /ApiUnreachableError: could not reach the API/);
  assert.doesNotMatch(text, /"connection"/, "a fabricated connection state is state a model reasons about");
  assert.doesNotMatch(text, /"schema_version"/);
  await h.close();
});

// ── Offline behaviour and descriptions ────────────────────────────────────

void test("every read tool works while the connection is down", async () => {
  const h = await harness({ state: "disconnected" });
  for (const name of [
    "whatsapp_chats_list",
    "whatsapp_messages_list",
    "whatsapp_contacts_search",
    "whatsapp_groups_list",
  ]) {
    const res = await h.client.callTool({ name, arguments: name === "whatsapp_contacts_search" ? { query: "a" } : {} });
    assert.notEqual(res.isError, true, `${name} must not require a socket`);
  }
  await h.close();
});

void test("every read tool works while logged out, including search", async () => {
  const h = await harness({
    state: "logged_out",
    seed: (api) => {
      api.data.messages.push(message({ id: "M1", ts: 10, text: "bonjour" }));
      api.data.hits.push(hit({ id: "M1", ts: 10, text: "bonjour" }));
    },
  });
  for (const name of READ_TOOLS) {
    const args = name === "whatsapp_messages_search" || name === "whatsapp_contacts_search" ? { query: "bonjour" } : {};
    const res = await h.client.callTool({ name, arguments: args });
    assert.notEqual(res.isError, true, `${name} must answer from SQLite in every connection state`);
  }
  await h.close();
});

void test("every read tool describes what it reads and says it works offline", async () => {
  const h = await harness();
  const tools = (await h.client.listTools()).tools.filter((t) => (READ_TOOLS as readonly string[]).includes(t.name));
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS].sort(), "all six read tools are advertised");
  for (const t of tools) {
    assert.ok((t.description ?? "").length > 40, `${t.name} needs a description a model can act on`);
    assert.match(t.description ?? "", /offline|connection is down/i, `${t.name} must state that it works offline`);
  }
  await h.close();
});

// ── Chats ─────────────────────────────────────────────────────────────────

void test("whatsapp_chats_list returns chats newest first and falls back to the contact's name", async () => {
  const h = await harness({
    seed: (api) => {
      // In the order the API answers them — the ordering is its ORDER BY, and what is under test
      // here is that the tool preserves it rather than re-sorting.
      api.data.chats.push(
        chat({ id: GROUP, name: "Les Copains", isGroup: true, lastMessageTs: 20, participantCount: 7 }),
        chat({ id: ALICE, name: "Alice", lastMessageTs: 10 }),
      );
    },
  });
  const { items, nextCursor } = resultPage(await h.client.callTool({ name: "whatsapp_chats_list", arguments: {} }));

  assert.deepEqual(ids(items), [GROUP, ALICE]);
  assert.equal(at(items, 0)["name"], "Les Copains");
  assert.equal(at(items, 0)["is_group"], true);
  assert.equal(at(items, 0)["participant_count"], 7);
  assert.equal(at(items, 1)["name"], "Alice", "a DM chat with no name of its own resolves to the contact");
  assert.equal(nextCursor, null);
  await h.close();
});

void test("whatsapp_chats_list filters by name, group flag, archive and unread", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.chats.push(
        chat({ id: GROUP, name: "Archived Group", isGroup: true, archived: true, lastMessageTs: 20 }),
        chat({ id: ALICE, name: "Alice", unreadCount: 3, lastMessageTs: 10 }),
      );
    },
  });
  const call = async (args: Record<string, unknown>): Promise<string[]> =>
    ids(resultPage(await h.client.callTool({ name: "whatsapp_chats_list", arguments: args })).items);

  assert.deepEqual(await call({ query: "alic" }), [ALICE], "the name filter is case-insensitive and a substring");
  assert.deepEqual(await call({ is_group: true }), [GROUP]);
  assert.deepEqual(await call({ is_group: false }), [ALICE]);
  assert.deepEqual(await call({ archived: true }), [GROUP]);
  assert.deepEqual(await call({ archived: false }), [ALICE]);
  assert.deepEqual(await call({ unread_only: true }), [ALICE]);
  await h.close();
});

/**
 * The rename, asserted where it happens.
 *
 * Three of `whatsapp_chats_list`'s arguments are spelled differently on the wire, and a swap between
 * two adjacent booleans answers plausibly rather than wrongly — `archived` and `unread` are both
 * booleans over the same rows. This is the assertion the split needs and the retired suite could not
 * have had, because in-process there was no wire to rename onto.
 */
void test("whatsapp_chats_list sends each filter under the name the contract gives it", async () => {
  const h = await harness();
  await h.client.callTool({
    name: "whatsapp_chats_list",
    arguments: { query: "a", is_group: true, archived: false, unread_only: true, limit: 7, cursor: "fake-cursor:0" },
  });
  assert.deepEqual(queryOf(h.api, "listChats"), {
    query: "a",
    isGroup: true,
    archived: false,
    unread: true,
    limit: 7,
    cursor: "fake-cursor:0",
  });
  await h.close();
});

void test("whatsapp_groups_list returns only groups, with participant counts", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.chats.push(
        chat({ id: ALICE, name: "Alice", lastMessageTs: 10 }),
        chat({ id: GROUP, name: "Les Copains", isGroup: true, participantCount: 7 }),
      );
    },
  });
  const { items } = resultPage(await h.client.callTool({ name: "whatsapp_groups_list", arguments: {} }));
  assert.deepEqual(ids(items), [GROUP]);
  assert.equal(at(items, 0)["participant_count"], 7);
  await h.close();
});

// ── Messages ──────────────────────────────────────────────────────────────

void test("whatsapp_messages_list resolves sender names rather than returning bare jids", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.messages.push(
        message({ id: "M1", ts: 10, chat: GROUP, sender: ALICE, senderName: "Alice Martin" }),
        message({ id: "M2", ts: 20, chat: GROUP, sender: BOB, senderName: "Bobby" }),
        message({ id: "M3", ts: 30, chat: GROUP, sender: "33633333333@s.whatsapp.net" }),
      );
    },
  });
  const { items } = resultPage(await h.client.callTool({ name: "whatsapp_messages_list", arguments: { chat: GROUP } }));

  assert.deepEqual(ids(items), ["M3", "M2", "M1"]);
  assert.deepEqual(at(items, 2)["sender"], { id: ALICE, name: "Alice Martin" }, "a stored name wins");
  assert.deepEqual(at(items, 1)["sender"], { id: BOB, name: "Bobby" }, "notify is the fallback");
  assert.deepEqual(
    at(items, 0)["sender"],
    { id: "33633333333@s.whatsapp.net", name: "33633333333@s.whatsapp.net" },
    "an unknown sender keeps its jid, so the id is never lost",
  );
  await h.close();
});

void test("whatsapp_messages_list filters by chat, sender, direction and time window", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.messages.push(
        message({ id: "M1", ts: 10, chat: GROUP, sender: ALICE }),
        message({ id: "M2", ts: 20, chat: GROUP, sender: BOB }),
        message({ id: "M3", ts: 30, chat: GROUP, sender: ALICE, fromMe: true }),
        message({ id: "D1", ts: 40, chat: ALICE, sender: ALICE }),
      );
    },
  });
  const call = async (args: Record<string, unknown>): Promise<string[]> =>
    ids(resultPage(await h.client.callTool({ name: "whatsapp_messages_list", arguments: args })).items);

  assert.deepEqual(await call({}), ["D1", "M3", "M2", "M1"], "no chat filter walks every chat");
  assert.deepEqual(await call({ chat: ALICE }), ["D1"]);
  assert.deepEqual(await call({ chat: GROUP, sender: BOB }), ["M2"]);
  assert.deepEqual(await call({ chat: GROUP, from_me: true }), ["M3"]);
  assert.deepEqual(await call({ chat: GROUP, from_me: false }), ["M2", "M1"]);
  assert.deepEqual(await call({ chat: GROUP, after: 20 }), ["M3", "M2"], "after is inclusive");
  assert.deepEqual(await call({ chat: GROUP, before: 20 }), ["M2", "M1"], "before is inclusive");
  assert.deepEqual(await call({ chat: GROUP, after: 20, before: 20 }), ["M2"]);
  await h.close();
});

void test("whatsapp_messages_list walks a chat forwards under asc", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.messages.push(
        message({ id: "M1", ts: 10 }),
        message({ id: "M2", ts: 20 }),
        message({ id: "M3", ts: 30 }),
      );
    },
  });
  const call = async (args: Record<string, unknown>): Promise<string[]> =>
    ids(resultPage(await h.client.callTool({ name: "whatsapp_messages_list", arguments: args })).items);

  assert.deepEqual(await call({ chat: ALICE }), ["M3", "M2", "M1"], "the default stays newest first");
  assert.deepEqual(await call({ chat: ALICE, asc: true }), ["M1", "M2", "M3"]);
  // Paging forwards is the point of `asc`: reading a conversation from its start, a page at a time.
  assert.deepEqual(await call({ chat: ALICE, asc: true, limit: 2 }), ["M1", "M2"]);
  await h.close();
});

void test("the message filters narrow both whatsapp_messages_list and whatsapp_messages_search alike", async () => {
  const rows: SeedMessage[] = [
    { id: "T1", ts: 10, chat: GROUP, sender: ALICE, text: "orange juice please" },
    { id: "P1", ts: 20, chat: GROUP, sender: BOB, kind: "image", text: "orange sunset", mediaType: "image/jpeg" },
    { id: "V1", ts: 30, chat: GROUP, sender: BOB, kind: "audio", text: null, mediaType: "audio/ogg" },
    { id: "L1", ts: 40, chat: GROUP, sender: ALICE, kind: "location", text: "orange county" },
  ];
  const h = await harness({
    seed: (api) => {
      api.data.messages.push(...rows.map(message));
      api.data.hits.push(...rows.map((r) => hit(r)));
    },
  });
  const list = async (args: Record<string, unknown>): Promise<string[]> =>
    ids(resultPage(await h.client.callTool({ name: "whatsapp_messages_list", arguments: args })).items);
  const search = async (args: Record<string, unknown>): Promise<string[]> =>
    ids(resultPage(await h.client.callTool({ name: "whatsapp_messages_search", arguments: args })).items).sort();

  assert.deepEqual(await list({ chat: GROUP, kind: "image" }), ["P1"]);
  assert.deepEqual(await list({ chat: GROUP, has_media: true }), ["V1", "P1"]);
  assert.deepEqual(await list({ chat: GROUP, has_media: false }), ["L1", "T1"]);

  assert.deepEqual(await search({ query: "orange", chat: GROUP }), ["L1", "P1", "T1"]);
  assert.deepEqual(await search({ query: "orange", sender: BOB }), ["P1"]);
  assert.deepEqual(await search({ query: "orange", kind: "image" }), ["P1"]);
  assert.deepEqual(await search({ query: "orange", has_media: true }), ["P1"]);
  assert.deepEqual(await search({ query: "orange", after: 20, before: 30 }), ["P1"]);
  await h.close();
});

/**
 * The rename again, for the seven filters the two message tools share.
 *
 * `from_me`/`fromMe` and `has_media`/`hasMedia` are renamed inline in each tool rather than through
 * a shared mapper, so there are two sites and they can disagree. Search additionally renames
 * `query` to `q`, which is the one argument a model always passes.
 */
void test("both message tools send every filter under the name the contract gives it", async () => {
  const h = await harness();
  const args = {
    chat: GROUP,
    sender: BOB,
    from_me: true,
    kind: "image",
    has_media: true,
    after: 10,
    before: 20,
    limit: 5,
  };
  await h.client.callTool({ name: "whatsapp_messages_list", arguments: { ...args, asc: true } });
  await h.client.callTool({ name: "whatsapp_messages_search", arguments: { ...args, query: 'orange OR "x' } });

  const wire = { chat: GROUP, sender: BOB, fromMe: true, kind: "image", hasMedia: true, after: 10, before: 20 };
  assert.deepEqual(queryOf(h.api, "listMessages"), { ...wire, asc: true, limit: 5, cursor: undefined });
  assert.deepEqual(queryOf(h.api, "searchMessages"), {
    ...wire,
    q: 'orange OR "x',
    limit: 5,
    cursor: undefined,
  });
  // Forwarded verbatim, not escaped here: FTS quoting belongs to the layer that runs the query, and
  // a second escaping pass would search for the backslashes it added.
  assert.equal((queryOf(h.api, "searchMessages") as SearchQuery).q, 'orange OR "x');
  await h.close();
});

void test("a kind that contradicts has_media is refused rather than answered with an empty page", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.messages.push(message({ id: "M1", ts: 10, text: "orange" }));
      api.data.hits.push(hit({ id: "M1", ts: 10, text: "orange" }));
    },
  });
  for (const name of ["whatsapp_messages_list", "whatsapp_messages_search"]) {
    const args = { kind: "text", has_media: true, ...(name === "whatsapp_messages_search" && { query: "orange" }) };
    const res = await h.client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `${name} must refuse a contradictory filter`);
    assert.match(resultText(res), /contradicts kind="text"/);
  }
  // And a consistent pair is not refused, which is what makes the check about the contradiction
  // rather than about the two arguments ever appearing together.
  const ok = await h.client.callTool({ name: "whatsapp_messages_list", arguments: { kind: "text", has_media: false } });
  assert.notEqual(ok.isError, true);
  assert.deepEqual(ids(resultPage(ok).items), ["M1"]);
  await h.close();
});

/**
 * Global Constraint 11's half of the LID story that belongs to this side of the split.
 *
 * The retired test asserted that a LID argument found the folded phone chat's rows. That folding is
 * `canonicalId`, which runs at the API boundary and nowhere else — so what this layer must be held
 * to is the opposite property: it does not interpret the JID at all, and hands over exactly the
 * string it was given.
 */
void test("whatsapp_messages_list hands a LID to the API uninterpreted", async () => {
  const h = await harness();
  await h.client.callTool({ name: "whatsapp_messages_list", arguments: { chat: "5551234@lid" } });
  assert.equal(queryOf(h.api, "listMessages")["chat"], "5551234@lid");
  await h.close();
});

void test("whatsapp_messages_list carries a reaction count, not the reactions themselves", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.messages.push(
        message({ id: "M1", ts: 10, chat: GROUP, reactionCount: 2 }),
        message({ id: "M2", ts: 20, chat: GROUP, reactionCount: 0 }),
      );
    },
  });
  const { items } = resultPage(await h.client.callTool({ name: "whatsapp_messages_list", arguments: { chat: GROUP } }));

  assert.equal(at(items, 0)["reaction_count"], 0, "M2 has none");
  assert.equal(at(items, 1)["reaction_count"], 2);
  assert.equal(at(items, 1)["reactions"], undefined, "a list view carries counts, never the full shapes");
  await h.close();
});

void test("whatsapp_messages_list flags media without pretending it is downloaded", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.messages.push(
        message({ id: "M1", ts: 10, kind: "text" }),
        message({ id: "M2", ts: 20, kind: "image", mediaType: "image/jpeg" }),
      );
    },
  });
  const { items } = resultPage(await h.client.callTool({ name: "whatsapp_messages_list", arguments: { chat: ALICE } }));

  assert.deepEqual(at(items, 0)["media"], { type: "image/jpeg", cached: false });
  assert.equal(at(items, 1)["media"], null, "a text message carries no media object at all");
  await h.close();
});

// ── Search ────────────────────────────────────────────────────────────────

void test("whatsapp_messages_search returns transcript hits labelled as such", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.hits.push(
        hit({ id: "T1", ts: 10, text: "hello bonjour written down", snippet: "hello <b>bonjour</b> written down" }),
        hit({
          id: "V1",
          ts: 20,
          kind: "audio",
          text: null,
          transcript: "bonjour tout le monde",
          mediaType: "audio/ogg",
          snippet: "<b>bonjour</b> tout le monde",
          matchedTranscript: true,
        }),
      );
    },
  });

  const { items } = resultPage(
    await h.client.callTool({ name: "whatsapp_messages_search", arguments: { query: "bonjour" } }),
  );
  assert.equal(items.length, 2);

  const byId = new Map(items.map((i) => [i["id"] as string, i]));
  const voice = byId.get("V1");
  const typed = byId.get("T1");

  assert.ok(voice, "the voice note must be among the hits");
  assert.ok(typed, "the typed message must be among the hits");

  assert.equal(voice["matched_transcript"], true, "a voice-note hit must say so");
  assert.equal(voice["kind"], "audio");
  assert.equal(voice["transcript"], "bonjour tout le monde");
  assert.match(voice["snippet"] as string, /bonjour/);

  assert.equal(typed["matched_transcript"], false, "a hit on the message text is not a transcript hit");
  assert.match(typed["snippet"] as string, /bonjour/);
  await h.close();
});

void test("whatsapp_messages_search scopes to one chat and counts reactions", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.hits.push(
        hit({ id: "A1", ts: 10, chat: ALICE, text: "shared keyword here" }),
        hit({ id: "G1", ts: 20, chat: GROUP, text: "shared keyword there", reactionCount: 1 }),
      );
    },
  });

  const all = resultPage(
    await h.client.callTool({ name: "whatsapp_messages_search", arguments: { query: "keyword" } }),
  );
  assert.deepEqual(ids(all.items).sort(), ["A1", "G1"]);
  assert.equal(all.items.find((i) => i["id"] === "G1")?.["reaction_count"], 1, "counts ride on the row");

  const scoped = resultPage(
    await h.client.callTool({ name: "whatsapp_messages_search", arguments: { query: "keyword", chat: GROUP } }),
  );
  assert.deepEqual(ids(scoped.items), ["G1"]);
  await h.close();
});

// ── Contacts ──────────────────────────────────────────────────────────────

void test("whatsapp_contacts_search matches name, notify and phone number", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.contacts.push(
        Contact.parse({ id: ALICE, name: "Alice Martin", notify: null, phoneNumber: "33611111111", lid: null }),
        Contact.parse({ id: BOB, name: null, notify: "Bobby", phoneNumber: "33622222222", lid: null }),
      );
    },
  });
  const call = async (query: string): Promise<string[]> =>
    ids(resultPage(await h.client.callTool({ name: "whatsapp_contacts_search", arguments: { query } })).items);

  assert.deepEqual(await call("martin"), [ALICE]);
  assert.deepEqual(await call("bobby"), [BOB]);
  assert.deepEqual(await call("336222"), [BOB]);
  assert.deepEqual((await call("336")).sort(), [ALICE, BOB].sort());
  assert.deepEqual(await call("nobody"), []);

  const { items } = resultPage(
    await h.client.callTool({ name: "whatsapp_contacts_search", arguments: { query: "martin" } }),
  );
  assert.deepEqual(items[0], { id: ALICE, name: "Alice Martin", notify: null, phone_number: "33611111111", lid: null });
  await h.close();
});

// ── Pagination ────────────────────────────────────────────────────────────

void test("cursor pagination is stable across pages", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.messages.push(...[1, 2, 3, 4, 5].map((n) => message({ id: `M${n}`, ts: n * 10 })));
    },
  });

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const args: Record<string, unknown> = { chat: ALICE, limit: 2 };
    if (cursor !== null) args["cursor"] = cursor;
    const page: { items: Record<string, unknown>[]; nextCursor: string | null } = resultPage(
      await h.client.callTool({ name: "whatsapp_messages_list", arguments: args }),
    );
    assert.ok(page.items.length > 0, "a cursor must never hand back an empty page");
    seen.push(...ids(page.items));
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages < 10, "pagination must terminate");
  } while (cursor !== null);

  assert.equal(pages, 3);
  assert.deepEqual(seen, ["M5", "M4", "M3", "M2", "M1"], "no row skipped, no row repeated");
  assert.equal(new Set(seen).size, seen.length);
  await h.close();
});

void test("the last full page reports no next cursor, so no cursor ever yields nothing", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.messages.push(...[1, 2, 3, 4].map((n) => message({ id: `M${n}`, ts: n * 10 })));
    },
  });

  const first = resultPage(
    await h.client.callTool({ name: "whatsapp_messages_list", arguments: { chat: ALICE, limit: 2 } }),
  );
  assert.equal(typeof first.nextCursor, "string");
  const second = resultPage(
    await h.client.callTool({
      name: "whatsapp_messages_list",
      arguments: { chat: ALICE, limit: 2, cursor: first.nextCursor },
    }),
  );
  assert.equal(second.items.length, 2);
  assert.equal(second.nextCursor, null);
  await h.close();
});

void test("the default page size is 50", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.messages.push(...Array.from({ length: 55 }, (_row, i) => message({ id: `M${i}`, ts: i + 1 })));
    },
  });
  const { items, nextCursor } = resultPage(
    await h.client.callTool({ name: "whatsapp_messages_list", arguments: { chat: ALICE } }),
  );
  assert.equal(items.length, 50);
  assert.equal(typeof nextCursor, "string");
  // The default is the MCP's, not the API's: `limitSchema` carries `.default(50)`, so an omitted
  // `limit` reaches the wire as the number rather than as an absence the API would fill in itself.
  assert.equal(queryOf(h.api, "listMessages")["limit"], 50);
  await h.close();
});

void test("a limit above the cap is rejected by the schema", async () => {
  const h = await harness();
  // The SDK answers a schema violation with an `isError` result carrying "Input validation error",
  // rather than rejecting the call — so asserting on the wording is what proves the *schema* refused
  // it, not a handler that quietly clamped the value.
  const refused = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res = await h.client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `${name} ${JSON.stringify(args)} must be refused`);
    return resultText(res);
  };

  for (const name of PAGED_TOOLS) {
    const args = name === "whatsapp_contacts_search" ? { query: "a", limit: 201 } : { limit: 201 };
    assert.match(await refused(name, args), /Input validation error/, `${name} must cap limit at 200`);
  }
  assert.match(await refused("whatsapp_messages_list", { limit: 0 }), /Input validation error/);
  assert.match(await refused("whatsapp_messages_list", { limit: -1 }), /Input validation error/);
  assert.match(await refused("whatsapp_messages_list", { limit: 1.5 }), /Input validation error/);

  const ok = await h.client.callTool({ name: "whatsapp_messages_list", arguments: { limit: 200 } });
  assert.notEqual(ok.isError, true, "200 is the cap, not one past it");
  await h.close();
});

void test("the advertised schema is what enforces the cap", async () => {
  // Belt and braces for the test above: if the SDK ever stopped validating, the cap would still be
  // visible to a client here — and its absence would be a silent regression otherwise.
  const h = await harness();
  const tools = (await h.client.listTools()).tools.filter((t) => (PAGED_TOOLS as readonly string[]).includes(t.name));
  assert.equal(tools.length, PAGED_TOOLS.length);
  for (const tool of tools) {
    const limit = (tool.inputSchema.properties as Record<string, Record<string, unknown>>)["limit"];
    assert.ok(limit, `${tool.name} must take a limit`);
    assert.equal(limit["maximum"], 200, `${tool.name} must advertise the cap`);
    assert.equal(limit["default"], 50, `${tool.name} must advertise the default page size`);
    assert.equal(limit["type"], "integer");
  }
  await h.close();
});

void test("a malformed cursor is an error, not a silent restart from the first page", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.messages.push(message({ id: "M1", ts: 10 }));
      api.data.hits.push(hit({ id: "M1", ts: 10 }));
    },
  });
  for (const name of [
    "whatsapp_chats_list",
    "whatsapp_messages_list",
    "whatsapp_groups_list",
    "whatsapp_messages_search",
  ]) {
    const args: Record<string, unknown> = { cursor: "not-a-real-cursor!!" };
    if (name === "whatsapp_messages_search") args["query"] = "message";
    const res = await h.client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `${name} must refuse a malformed cursor`);
    assert.match(resultText(res), /cursor/i);
    // The name travels on the wire even though `bad_request` is the code, so the model reads the
    // same first word it always has.
    assert.match(resultText(res), /^CursorError: /);
    assert.doesNotMatch(resultText(res), /"items"/, "it must not quietly answer with page 1");
  }
  const contacts = await h.client.callTool({
    name: "whatsapp_contacts_search",
    arguments: { query: "a", cursor: "not-a-real-cursor!!" },
  });
  assert.equal(contacts.isError, true);
  await h.close();
});

void test("an empty query is rejected rather than matching everything", async () => {
  const h = await harness({
    seed: (api) => {
      api.data.messages.push(message({ id: "M1", ts: 10 }));
    },
  });
  for (const name of ["whatsapp_contacts_search", "whatsapp_messages_search"]) {
    const res = await h.client.callTool({ name, arguments: { query: "" } });
    assert.equal(res.isError, true, `${name} must refuse an empty query`);
    assert.match(resultText(res), /Input validation error/);
  }
  // And the tool's stricter schema is what did it: `GET /v1/contacts` accepts an absent term.
  assert.equal(h.api.countCalls("listContacts"), 0);
  await h.close();
});

void test("an oversized payload is truncated with the true length named", async () => {
  const h = await harness({
    maxResultChars: 1000,
    seed: (api) => {
      api.data.messages.push(
        ...Array.from({ length: 40 }, (_row, i) => message({ id: `M${i}`, ts: i + 1, text: "x".repeat(200) })),
      );
    },
  });
  const text = resultText(await h.client.callTool({ name: "whatsapp_messages_list", arguments: { chat: ALICE } }));
  assert.ok(text.length < 1400, `expected a capped payload, got ${text.length} chars`);
  assert.match(text, /truncated: \d{4,} chars total/);
  assert.match(text, /will not parse/, "the note must say the JSON above is incomplete, not merely shortened");
  await h.close();
});

void test("a truncated page still carries its next_cursor, so the round trip survives the cut", async () => {
  // `jsonResult` cuts from the end, so field order decides what a page over the cap loses. With
  // `items` first, the casualty is always the cursor — and a caller that cannot read the cursor
  // cannot narrow its request by paging either, which is the remedy the note recommends.
  const h = await harness({
    maxResultChars: 500,
    seed: (api) => {
      api.data.messages.push(
        ...Array.from({ length: 6 }, (_row, i) => message({ id: `M${i}`, ts: i + 1, text: "x".repeat(400) })),
      );
    },
  });

  const text = resultText(
    await h.client.callTool({ name: "whatsapp_messages_list", arguments: { chat: ALICE, limit: 2 } }),
  );
  assert.match(text, /truncated/, "the seed must be big enough to be cut, or this proves nothing");
  const cursor = /"next_cursor": "([^"]+)"/.exec(text)?.[1];
  assert.ok(cursor, "the cursor must survive a payload the tool had to cut");
  // Opaque to this process, so the assertion is that the API's own token came back whole rather
  // than that it decodes to an offset — decoding it here would freeze the API's encoding into the
  // contract, which is exactly what an opaque cursor exists to prevent.
  assert.equal(cursor, "fake-cursor:2", "and it must be the real cursor onto page 2, not a stump");
  await h.close();
});
