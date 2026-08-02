import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadConfig } from "../../config.js";
import type { MessageKind } from "../../db/messages.js";
import type { ToolContext } from "../context.js";
import { decodeCursor } from "../cursor.js";
import { harness, resultJson, resultPage, resultText } from "./harness.js";

const READ_TOOLS = [
  "wa_health",
  "wa_chats_list",
  "wa_messages_list",
  "wa_messages_search",
  "wa_contacts_search",
  "wa_groups_list",
] as const;

const ALICE = "33611111111@s.whatsapp.net";
const BOB = "33622222222@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";

/** `text: null` means the message carries none at all, which is what a voice note looks like. */
type SeedMessage = {
  id: string;
  ts: number;
  text?: string | null;
  kind?: MessageKind;
  sender?: string;
  fromMe?: boolean;
};

/** Insert a chat and its messages. Chats first: `messages.chat_id` has a foreign key onto them. */
function seedChat(ctx: ToolContext, chatId: string, isGroup: boolean, ms: readonly SeedMessage[]): void {
  ctx.chats.ensure(chatId, isGroup);
  for (const m of ms) {
    ctx.messages.upsert({
      chatId,
      id: m.id,
      senderId: m.sender ?? ALICE,
      ts: m.ts,
      fromMe: m.fromMe ?? false,
      kind: m.kind ?? "text",
      text: m.text === null ? undefined : (m.text ?? `message ${m.id}`),
    });
    ctx.chats.touch(chatId, m.ts);
  }
}

const ids = (items: readonly Record<string, unknown>[]): string[] => items.map((i) => i["id"] as string);

/** The row at `i`, asserted present. Keeps every later read off an optional chain the linter rejects. */
function at(items: readonly Record<string, unknown>[], i: number): Record<string, unknown> {
  const row = items[i];
  assert.ok(row !== undefined, `expected an item at index ${i}`);
  return row;
}

/**
 * Count the reaction queries a page really issues, by wrapping the repo in the live context.
 *
 * The handlers read `ctx.reactions` at call time rather than closing over it, so replacing it after
 * the server is built still observes the real calls.
 */
function countReactionQueries(ctx: ToolContext): { countsFor: number; forMessage: number } {
  const real = ctx.reactions;
  const calls = { countsFor: 0, forMessage: 0 };
  ctx.reactions = {
    ...real,
    countsFor: (keys) => {
      calls.countsFor++;
      return real.countsFor(keys);
    },
    forMessage: (chatId, messageId) => {
      calls.forMessage++;
      return real.forMessage(chatId, messageId);
    },
  };
  return calls;
}

// ── Health ────────────────────────────────────────────────────────────────

void test("wa_health reports the connection state and row counts without a socket", async () => {
  const h = await harness({
    state: "disconnected",
    seed: (ctx) => {
      seedChat(ctx, ALICE, false, [{ id: "M1", ts: 10 }]);
    },
  });
  const data = resultJson(await h.client.callTool({ name: "wa_health", arguments: {} }));

  assert.equal(data["connection"], "disconnected");
  assert.equal(typeof data["counts"], "object");
  assert.deepEqual(data["counts"], { chats: 1, messages: 1, contacts: 0 });
  assert.equal(data["schema_version"], 1);
  assert.equal(data["read_only"], false);
  assert.equal(data["needs_pairing"], false);
  assert.equal(data["self_id"], "33600000000@s.whatsapp.net");
  await h.close();
});

void test("wa_health is ok in every state except logged_out", async () => {
  for (const state of ["disconnected", "connecting", "pairing", "connected"] as const) {
    const h = await harness({ state });
    const data = resultJson(await h.client.callTool({ name: "wa_health", arguments: {} }));
    assert.equal(data["ok"], true, `${state} still serves reads, so it must not flap the healthcheck`);
    await h.close();
  }

  const h = await harness({ state: "logged_out" });
  const data = resultJson(await h.client.callTool({ name: "wa_health", arguments: {} }));
  assert.equal(data["ok"], false, "a logged-out server is dead until someone re-pairs it");
  assert.equal(data["needs_pairing"], true);
  await h.close();
});

void test("wa_health reports the age of the last event in seconds, not milliseconds", async () => {
  const h = await harness({ lastEventAgeSec: 42 });
  const data = resultJson(await h.client.callTool({ name: "wa_health", arguments: {} }));
  const age = data["last_event_age_sec"] as number;
  assert.ok(age >= 42 && age <= 44, `expected ~42 seconds, got ${age}`);
  await h.close();
});

void test("wa_health carries no secret from the config", async () => {
  const config = loadConfig({
    WA_DATA_DIR: "/tmp/wa-health-secrets",
    WA_MCP_TOKEN: "bearer-SUPERSECRET",
    NTFY_BASE_URL: "https://ntfy.example",
    NTFY_TOPIC: "t",
    NTFY_TOKEN: "ntfy-ALSOSECRET",
  });
  const h = await harness({ overrides: { config } });
  const text = resultText(await h.client.callTool({ name: "wa_health", arguments: {} }));

  assert.doesNotMatch(text, /SUPERSECRET/, "WA_MCP_TOKEN must never reach a health response");
  assert.doesNotMatch(text, /ALSOSECRET/, "NTFY_TOKEN must never reach a health response");
  assert.doesNotMatch(text, /ntfy\.example/);
  await h.close();
});

void test("wa_health reflects whether transcription can run", async () => {
  for (const available of [true, false]) {
    const h = await harness({ transcriptionAvailable: available });
    const data = resultJson(await h.client.callTool({ name: "wa_health", arguments: {} }));
    assert.equal(data["transcription_available"], available);
    await h.close();
  }
});

// ── Offline behaviour and descriptions ────────────────────────────────────

void test("every read tool works while the connection is down", async () => {
  const h = await harness({ state: "disconnected" });
  for (const name of ["wa_chats_list", "wa_messages_list", "wa_contacts_search", "wa_groups_list"]) {
    const res = await h.client.callTool({ name, arguments: name === "wa_contacts_search" ? { query: "a" } : {} });
    assert.notEqual(res.isError, true, `${name} must not require a socket`);
  }
  await h.close();
});

void test("every read tool works while logged out, including search", async () => {
  const h = await harness({
    state: "logged_out",
    seed: (ctx) => {
      seedChat(ctx, ALICE, false, [{ id: "M1", ts: 10, text: "bonjour" }]);
    },
  });
  for (const name of READ_TOOLS) {
    const args = name === "wa_messages_search" || name === "wa_contacts_search" ? { query: "bonjour" } : {};
    const res = await h.client.callTool({ name, arguments: args });
    assert.notEqual(res.isError, true, `${name} must answer from SQLite in every connection state`);
  }
  await h.close();
});

void test("every read tool describes what it reads and says it works offline", async () => {
  const h = await harness();
  const tools = (await h.client.listTools()).tools;
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [...READ_TOOLS].sort(),
    "Task 12 registers exactly the six read tools",
  );
  for (const t of tools) {
    assert.ok((t.description ?? "").length > 40, `${t.name} needs a description a model can act on`);
    assert.match(t.description ?? "", /offline|connection is down/i, `${t.name} must state that it works offline`);
  }
  await h.close();
});

// ── Chats ─────────────────────────────────────────────────────────────────

void test("wa_chats_list returns chats newest first and falls back to the contact's name", async () => {
  const h = await harness({
    seed: (ctx) => {
      ctx.contacts.upsert({ id: ALICE, name: "Alice" });
      seedChat(ctx, ALICE, false, [{ id: "M1", ts: 10 }]);
      ctx.chats.ensure(GROUP, true);
      ctx.chats.patch(GROUP, { name: "Les Copains", participantCount: 7 });
      ctx.chats.touch(GROUP, 20);
    },
  });
  const { items, nextCursor } = resultPage(await h.client.callTool({ name: "wa_chats_list", arguments: {} }));

  assert.deepEqual(ids(items), [GROUP, ALICE]);
  assert.equal(at(items, 0)["name"], "Les Copains");
  assert.equal(at(items, 0)["is_group"], true);
  assert.equal(at(items, 0)["participant_count"], 7);
  assert.equal(at(items, 1)["name"], "Alice", "a DM chat with no name of its own resolves to the contact");
  assert.equal(nextCursor, null);
  await h.close();
});

void test("wa_chats_list filters by name, group flag, archive and unread", async () => {
  const h = await harness({
    seed: (ctx) => {
      seedChat(ctx, ALICE, false, [{ id: "M1", ts: 10 }]);
      ctx.chats.patch(ALICE, { name: "Alice", unreadCount: 3 });
      ctx.chats.ensure(GROUP, true);
      ctx.chats.patch(GROUP, { name: "Archived Group", archived: true });
      ctx.chats.touch(GROUP, 20);
    },
  });
  const call = async (args: Record<string, unknown>): Promise<string[]> =>
    ids(resultPage(await h.client.callTool({ name: "wa_chats_list", arguments: args })).items);

  assert.deepEqual(await call({ query: "alic" }), [ALICE], "the name filter is case-insensitive and a substring");
  assert.deepEqual(await call({ is_group: true }), [GROUP]);
  assert.deepEqual(await call({ is_group: false }), [ALICE]);
  assert.deepEqual(await call({ archived: true }), [GROUP]);
  assert.deepEqual(await call({ archived: false }), [ALICE]);
  assert.deepEqual(await call({ unread_only: true }), [ALICE]);
  await h.close();
});

void test("wa_groups_list returns only groups, with participant counts", async () => {
  const h = await harness({
    seed: (ctx) => {
      seedChat(ctx, ALICE, false, [{ id: "M1", ts: 10 }]);
      ctx.chats.ensure(GROUP, true);
      ctx.chats.patch(GROUP, { name: "Les Copains", participantCount: 7 });
    },
  });
  const { items } = resultPage(await h.client.callTool({ name: "wa_groups_list", arguments: {} }));
  assert.deepEqual(ids(items), [GROUP]);
  assert.equal(at(items, 0)["participant_count"], 7);
  await h.close();
});

// ── Messages ──────────────────────────────────────────────────────────────

void test("wa_messages_list resolves sender names rather than returning bare jids", async () => {
  const h = await harness({
    seed: (ctx) => {
      ctx.contacts.upsert({ id: ALICE, name: "Alice Martin" });
      ctx.contacts.upsert({ id: BOB, notify: "Bobby" });
      seedChat(ctx, GROUP, true, [
        { id: "M1", ts: 10, sender: ALICE },
        { id: "M2", ts: 20, sender: BOB },
        { id: "M3", ts: 30, sender: "33633333333@s.whatsapp.net" },
      ]);
    },
  });
  const { items } = resultPage(await h.client.callTool({ name: "wa_messages_list", arguments: { chat: GROUP } }));

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

void test("wa_messages_list filters by chat, sender, direction and time window", async () => {
  const h = await harness({
    seed: (ctx) => {
      seedChat(ctx, GROUP, true, [
        { id: "M1", ts: 10, sender: ALICE },
        { id: "M2", ts: 20, sender: BOB },
        { id: "M3", ts: 30, sender: ALICE, fromMe: true },
      ]);
      seedChat(ctx, ALICE, false, [{ id: "D1", ts: 40, sender: ALICE }]);
    },
  });
  const call = async (args: Record<string, unknown>): Promise<string[]> =>
    ids(resultPage(await h.client.callTool({ name: "wa_messages_list", arguments: args })).items);

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

void test("wa_messages_list walks a chat forwards under asc", async () => {
  const h = await harness({
    seed: (ctx) => {
      seedChat(ctx, ALICE, false, [
        { id: "M1", ts: 10 },
        { id: "M2", ts: 20 },
        { id: "M3", ts: 30 },
      ]);
    },
  });
  const call = async (args: Record<string, unknown>): Promise<string[]> =>
    ids(resultPage(await h.client.callTool({ name: "wa_messages_list", arguments: args })).items);

  assert.deepEqual(await call({ chat: ALICE }), ["M3", "M2", "M1"], "the default stays newest first");
  assert.deepEqual(await call({ chat: ALICE, asc: true }), ["M1", "M2", "M3"]);
  // Paging forwards is the point of `asc`: reading a conversation from its start, a page at a time.
  assert.deepEqual(await call({ chat: ALICE, asc: true, limit: 2 }), ["M1", "M2"]);
  await h.close();
});

void test("the message filters narrow both wa_messages_list and wa_messages_search alike", async () => {
  const h = await harness({
    seed: (ctx) => {
      seedChat(ctx, GROUP, true, [
        { id: "T1", ts: 10, sender: ALICE, text: "orange juice please" },
        { id: "P1", ts: 20, sender: BOB, kind: "image", text: "orange sunset" },
        { id: "V1", ts: 30, sender: BOB, kind: "audio", text: null },
        { id: "L1", ts: 40, sender: ALICE, kind: "location", text: "orange county" },
      ]);
    },
  });
  const list = async (args: Record<string, unknown>): Promise<string[]> =>
    ids(resultPage(await h.client.callTool({ name: "wa_messages_list", arguments: args })).items);
  const search = async (args: Record<string, unknown>): Promise<string[]> =>
    ids(resultPage(await h.client.callTool({ name: "wa_messages_search", arguments: args })).items).sort();

  assert.deepEqual(await list({ chat: GROUP, kind: "image" }), ["P1"]);
  assert.deepEqual(await list({ chat: GROUP, has_media: true }), ["V1", "P1"]);
  assert.deepEqual(await list({ chat: GROUP, has_media: false }), ["L1", "T1"]);

  // The same four narrowings on search — the gap this closes: the old server had them on search
  // alone, and the new one had them on neither.
  assert.deepEqual(await search({ query: "orange", chat: GROUP }), ["L1", "P1", "T1"]);
  assert.deepEqual(await search({ query: "orange", sender: BOB }), ["P1"]);
  assert.deepEqual(await search({ query: "orange", kind: "image" }), ["P1"]);
  assert.deepEqual(await search({ query: "orange", has_media: true }), ["P1"]);
  assert.deepEqual(await search({ query: "orange", after: 20, before: 30 }), ["P1"]);
  await h.close();
});

void test("a kind that contradicts has_media is refused rather than answered with an empty page", async () => {
  const h = await harness({
    seed: (ctx) => {
      seedChat(ctx, ALICE, false, [{ id: "M1", ts: 10, text: "orange" }]);
    },
  });
  for (const name of ["wa_messages_list", "wa_messages_search"]) {
    const args = { kind: "text", has_media: true, ...(name === "wa_messages_search" && { query: "orange" }) };
    const res = await h.client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `${name} must refuse a contradictory filter`);
    assert.match(resultText(res), /contradicts kind="text"/);
  }
  // And a consistent pair is not refused, which is what makes the check about the contradiction
  // rather than about the two arguments ever appearing together.
  const ok = await h.client.callTool({ name: "wa_messages_list", arguments: { kind: "text", has_media: false } });
  assert.notEqual(ok.isError, true);
  assert.deepEqual(ids(resultPage(ok).items), ["M1"]);
  await h.close();
});

void test("wa_messages_list resolves a chat named by its LID to the folded phone chat", async () => {
  const lid = "5551234@lid";
  const h = await harness({
    seed: (ctx) => {
      seedChat(ctx, ALICE, false, [{ id: "M1", ts: 10, sender: ALICE }]);
      ctx.contacts.upsert({ id: ALICE, name: "Alice", phoneNumber: "33611111111", lid: "5551234" });
    },
  });
  const { items } = resultPage(await h.client.callTool({ name: "wa_messages_list", arguments: { chat: lid } }));
  assert.deepEqual(ids(items), ["M1"], "a LID argument must reach the same rows the phone jid does");
  await h.close();
});

void test("wa_messages_list carries a reaction count, not the reactions themselves", async () => {
  const h = await harness({
    seed: (ctx) => {
      seedChat(ctx, GROUP, true, [
        { id: "M1", ts: 10 },
        { id: "M2", ts: 20 },
      ]);
      ctx.reactions.set({ chatId: GROUP, messageId: "M1", senderId: ALICE, emoji: "👍", ts: 11 });
      ctx.reactions.set({ chatId: GROUP, messageId: "M1", senderId: BOB, emoji: "❤️", ts: 12 });
    },
  });
  const { items } = resultPage(await h.client.callTool({ name: "wa_messages_list", arguments: { chat: GROUP } }));

  assert.equal(at(items, 0)["reaction_count"], 0, "M2 has none");
  assert.equal(at(items, 1)["reaction_count"], 2);
  assert.equal(at(items, 1)["reactions"], undefined, "a list view carries counts, never the full shapes");
  await h.close();
});

void test("wa_messages_list flags media without pretending it is downloaded", async () => {
  const h = await harness({
    seed: (ctx) => {
      seedChat(ctx, ALICE, false, [
        { id: "M1", ts: 10, kind: "text" },
        { id: "M2", ts: 20, kind: "image" },
      ]);
      ctx.messages.upsert({
        chatId: ALICE,
        id: "M2",
        senderId: ALICE,
        ts: 20,
        fromMe: false,
        kind: "image",
        mediaType: "image/jpeg",
      });
    },
  });
  const { items } = resultPage(await h.client.callTool({ name: "wa_messages_list", arguments: { chat: ALICE } }));

  assert.deepEqual(at(items, 0)["media"], { type: "image/jpeg", cached: false });
  assert.equal(at(items, 1)["media"], null, "a text message carries no media object at all");
  await h.close();
});

void test("a page of reaction counts is one grouped query, not one per row", async () => {
  const h = await harness({
    seed: (ctx) => {
      seedChat(ctx, GROUP, true, [
        { id: "M1", ts: 10 },
        { id: "M2", ts: 20 },
        { id: "M3", ts: 30 },
      ]);
      ctx.reactions.set({ chatId: GROUP, messageId: "M1", senderId: ALICE, emoji: "👍", ts: 11 });
    },
  });

  const calls = countReactionQueries(h.ctx);
  const { items } = resultPage(await h.client.callTool({ name: "wa_messages_list", arguments: { chat: GROUP } }));
  assert.equal(items.length, 3);
  assert.equal(calls.countsFor, 1, "one grouped query covers the whole page");
  assert.equal(calls.forMessage, 0, "a list view must never fetch reaction rows one message at a time");
  await h.close();
});

void test("a search page spanning many chats is still one grouped query", async () => {
  // The case the per-chat shape got wrong: `wa_messages_search` pages span as many chats as they
  // have hits, so a query scoped to one chat is one query per chat — the same order of cost as
  // asking per row, which is what the requirement exists to rule out.
  const chats = Array.from({ length: 12 }, (_, i) => `1203630000000000${i.toString().padStart(2, "0")}@g.us`);
  const h = await harness({
    seed: (ctx) => {
      for (const [i, chatId] of chats.entries()) {
        seedChat(ctx, chatId, true, [{ id: "M1", ts: 10 + i, text: "shared keyword here" }]);
        ctx.reactions.set({ chatId, messageId: "M1", senderId: ALICE, emoji: "👍", ts: 11 + i });
      }
    },
  });

  const calls = countReactionQueries(h.ctx);
  const { items } = resultPage(
    await h.client.callTool({ name: "wa_messages_search", arguments: { query: "keyword" } }),
  );
  assert.equal(items.length, chats.length);
  assert.deepEqual(
    items.map((i) => i["reaction_count"]),
    items.map(() => 1),
    "every chat's own reaction is counted against its own message",
  );
  assert.equal(calls.countsFor, 1, `12 chats in one page must still cost one query, not ${chats.length}`);
  assert.equal(calls.forMessage, 0);
  await h.close();
});

// ── Search ────────────────────────────────────────────────────────────────

void test("wa_messages_search returns transcript hits labelled as such", async () => {
  const h = await harness({
    seed: (ctx) => {
      seedChat(ctx, ALICE, false, [
        { id: "T1", ts: 10, text: "hello bonjour written down" },
        { id: "V1", ts: 20, kind: "audio", text: null },
      ]);
      ctx.messages.setTranscript(ALICE, "V1", "bonjour tout le monde");
    },
  });

  const { items } = resultPage(
    await h.client.callTool({ name: "wa_messages_search", arguments: { query: "bonjour" } }),
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

void test("a transcript hit is labelled as one even when the message carries text of its own", async () => {
  // `text: null` — the case the test above covers — is the *easy* one: FTS5 answers `snippet()` with
  // NULL there. The two shapes below are the ones that need the match markers to be read. A caption
  // plus a transcript is the ordinary case for a video, so this goes live the moment anything writes
  // a transcript.
  const h = await harness({
    seed: (ctx) => {
      seedChat(ctx, ALICE, false, [
        { id: "C1", ts: 10, kind: "video", text: "voici la legende de ma video sans le mot" },
        { id: "E1", ts: 20, kind: "audio", text: "" },
      ]);
      ctx.messages.setTranscript(ALICE, "C1", "bonjour tout le monde");
      ctx.messages.setTranscript(ALICE, "E1", "bonjour les amis");
    },
  });

  const { items } = resultPage(
    await h.client.callTool({ name: "wa_messages_search", arguments: { query: "bonjour" } }),
  );
  const byId = new Map(items.map((i) => [i["id"] as string, i]));
  const captioned = byId.get("C1");
  const emptyText = byId.get("E1");

  assert.ok(captioned, "the captioned video must be among the hits");
  assert.equal(captioned["matched_transcript"], true, "a caption without the query is not what matched");
  assert.match(captioned["snippet"] as string, /bonjour/, "the snippet must contain the words searched for");

  assert.ok(emptyText, "the empty-text voice note must be among the hits");
  assert.equal(emptyText["matched_transcript"], true);
  assert.match(emptyText["snippet"] as string, /bonjour/);
  await h.close();
});

void test("wa_messages_search scopes to one chat, counts reactions and never explodes on operators", async () => {
  const h = await harness({
    seed: (ctx) => {
      seedChat(ctx, ALICE, false, [{ id: "A1", ts: 10, text: "shared keyword here" }]);
      seedChat(ctx, GROUP, true, [{ id: "G1", ts: 20, text: "shared keyword there" }]);
      ctx.reactions.set({ chatId: GROUP, messageId: "G1", senderId: ALICE, emoji: "👍", ts: 21 });
    },
  });

  const all = resultPage(await h.client.callTool({ name: "wa_messages_search", arguments: { query: "keyword" } }));
  assert.deepEqual(ids(all.items).sort(), ["A1", "G1"]);
  assert.equal(all.items.find((i) => i["id"] === "G1")?.["reaction_count"], 1, "counts are grouped per chat");

  const scoped = resultPage(
    await h.client.callTool({ name: "wa_messages_search", arguments: { query: "keyword", chat: GROUP } }),
  );
  assert.deepEqual(ids(scoped.items), ["G1"]);

  const operators = await h.client.callTool({ name: "wa_messages_search", arguments: { query: 'keyword OR "x' } });
  assert.notEqual(operators.isError, true, "a raw query is quoted, so FTS operator characters cannot throw");
  await h.close();
});

// ── Contacts ──────────────────────────────────────────────────────────────

void test("wa_contacts_search matches name, notify and phone number", async () => {
  const h = await harness({
    seed: (ctx) => {
      ctx.contacts.upsert({ id: ALICE, name: "Alice Martin", phoneNumber: "33611111111" });
      ctx.contacts.upsert({ id: BOB, notify: "Bobby", phoneNumber: "33622222222" });
    },
  });
  const call = async (query: string): Promise<string[]> =>
    ids(resultPage(await h.client.callTool({ name: "wa_contacts_search", arguments: { query } })).items);

  assert.deepEqual(await call("martin"), [ALICE]);
  assert.deepEqual(await call("bobby"), [BOB]);
  assert.deepEqual(await call("336222"), [BOB]);
  assert.deepEqual((await call("336")).sort(), [ALICE, BOB].sort());
  assert.deepEqual(await call("nobody"), []);

  const { items } = resultPage(await h.client.callTool({ name: "wa_contacts_search", arguments: { query: "martin" } }));
  assert.deepEqual(items[0], { id: ALICE, name: "Alice Martin", notify: null, phone_number: "33611111111", lid: null });
  await h.close();
});

// ── Pagination ────────────────────────────────────────────────────────────

void test("cursor pagination is stable across pages", async () => {
  const h = await harness({
    seed: (ctx) => {
      seedChat(
        ctx,
        ALICE,
        false,
        [1, 2, 3, 4, 5].map((n) => ({ id: `M${n}`, ts: n * 10 })),
      );
    },
  });

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const args: Record<string, unknown> = { chat: ALICE, limit: 2 };
    if (cursor !== null) args["cursor"] = cursor;
    const page: { items: Record<string, unknown>[]; nextCursor: string | null } = resultPage(
      await h.client.callTool({ name: "wa_messages_list", arguments: args }),
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
  // Four rows at limit 2: page 2 comes back *exactly* full, and the naive "shorter than limit"
  // rule would still hand out a cursor onto an empty page 3. The tools over-fetch by one instead.
  const h = await harness({
    seed: (ctx) => {
      seedChat(
        ctx,
        ALICE,
        false,
        [1, 2, 3, 4].map((n) => ({ id: `M${n}`, ts: n * 10 })),
      );
    },
  });

  const first = resultPage(await h.client.callTool({ name: "wa_messages_list", arguments: { chat: ALICE, limit: 2 } }));
  assert.equal(typeof first.nextCursor, "string");
  const second = resultPage(
    await h.client.callTool({
      name: "wa_messages_list",
      arguments: { chat: ALICE, limit: 2, cursor: first.nextCursor },
    }),
  );
  assert.equal(second.items.length, 2);
  assert.equal(second.nextCursor, null);
  await h.close();
});

void test("a row inserted mid-walk is re-shown, never skipped", async () => {
  // Documented behaviour of an offset cursor over a newest-first ordering: a row that arrives
  // between two pages shifts everything down, so the caller sees the boundary row twice. That is
  // the safe direction — a repeat is visible in the ids, a skip would be invisible.
  const h = await harness({
    seed: (ctx) => {
      seedChat(
        ctx,
        ALICE,
        false,
        [1, 2, 3, 4].map((n) => ({ id: `M${n}`, ts: n * 10 })),
      );
    },
  });

  const first = resultPage(await h.client.callTool({ name: "wa_messages_list", arguments: { chat: ALICE, limit: 2 } }));
  assert.deepEqual(ids(first.items), ["M4", "M3"]);

  h.ctx.messages.upsert({ chatId: ALICE, id: "M5", senderId: ALICE, ts: 50, fromMe: false, kind: "text", text: "new" });

  const second = resultPage(
    await h.client.callTool({
      name: "wa_messages_list",
      arguments: { chat: ALICE, limit: 2, cursor: first.nextCursor },
    }),
  );
  assert.deepEqual(ids(second.items), ["M3", "M2"], "M3 repeats; M2 is not skipped");
  await h.close();
});

void test("the default page size is 50", async () => {
  const h = await harness({
    seed: (ctx) => {
      seedChat(
        ctx,
        ALICE,
        false,
        Array.from({ length: 55 }, (_, i) => ({ id: `M${i}`, ts: i + 1 })),
      );
    },
  });
  const { items, nextCursor } = resultPage(
    await h.client.callTool({ name: "wa_messages_list", arguments: { chat: ALICE } }),
  );
  assert.equal(items.length, 50);
  assert.equal(typeof nextCursor, "string");
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

  for (const name of ["wa_chats_list", "wa_messages_list", "wa_groups_list", "wa_contacts_search"]) {
    const args = name === "wa_contacts_search" ? { query: "a", limit: 201 } : { limit: 201 };
    assert.match(await refused(name, args), /Input validation error/, `${name} must cap limit at 200`);
  }
  assert.match(await refused("wa_messages_list", { limit: 0 }), /Input validation error/);
  assert.match(await refused("wa_messages_list", { limit: -1 }), /Input validation error/);
  assert.match(await refused("wa_messages_list", { limit: 1.5 }), /Input validation error/);

  const ok = await h.client.callTool({ name: "wa_messages_list", arguments: { limit: 200 } });
  assert.notEqual(ok.isError, true, "200 is the cap, not one past it");
  await h.close();
});

void test("the advertised schema is what enforces the cap", async () => {
  // Belt and braces for the test above: if the SDK ever stopped validating, the cap would still be
  // visible to a client here — and its absence would be a silent regression otherwise.
  const h = await harness();
  for (const tool of (await h.client.listTools()).tools) {
    if (tool.name === "wa_health") continue;
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
    seed: (ctx) => {
      seedChat(ctx, ALICE, false, [{ id: "M1", ts: 10 }]);
    },
  });
  for (const name of ["wa_chats_list", "wa_messages_list", "wa_groups_list", "wa_messages_search"]) {
    const args: Record<string, unknown> = { cursor: "not-a-real-cursor!!" };
    if (name === "wa_messages_search") args["query"] = "message";
    const res = await h.client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `${name} must refuse a malformed cursor`);
    assert.match(resultText(res), /cursor/i);
    assert.doesNotMatch(resultText(res), /"items"/, "it must not quietly answer with page 1");
  }
  const contacts = await h.client.callTool({
    name: "wa_contacts_search",
    arguments: { query: "a", cursor: "not-a-real-cursor!!" },
  });
  assert.equal(contacts.isError, true);
  await h.close();
});

void test("an empty query is rejected rather than matching everything", async () => {
  const h = await harness({
    seed: (ctx) => {
      seedChat(ctx, ALICE, false, [{ id: "M1", ts: 10 }]);
    },
  });
  for (const name of ["wa_contacts_search", "wa_messages_search"]) {
    const res = await h.client.callTool({ name, arguments: { query: "" } });
    assert.equal(res.isError, true, `${name} must refuse an empty query`);
    assert.match(resultText(res), /Input validation error/);
  }
  await h.close();
});

void test("an oversized payload is truncated with the true length named", async () => {
  const config = { ...loadConfig({ WA_DATA_DIR: "/tmp/wa-trunc" }), maxResultChars: 1000 };
  const h = await harness({
    overrides: { config },
    seed: (ctx) => {
      seedChat(
        ctx,
        ALICE,
        false,
        Array.from({ length: 40 }, (_, i) => ({ id: `M${i}`, ts: i + 1, text: "x".repeat(200) })),
      );
    },
  });
  const text = resultText(await h.client.callTool({ name: "wa_messages_list", arguments: { chat: ALICE } }));
  assert.ok(text.length < 1400, `expected a capped payload, got ${text.length} chars`);
  assert.match(text, /truncated: \d{4,} chars total/);
  assert.match(text, /will not parse/, "the note must say the JSON above is incomplete, not merely shortened");
  await h.close();
});

void test("a truncated page still carries its next_cursor, so the round trip survives the cut", async () => {
  // `jsonResult` cuts from the end, so field order decides what a page over the cap loses. With
  // `items` first, the casualty is always the cursor — and a caller that cannot read the cursor
  // cannot narrow its request by paging either, which is the remedy the note recommends.
  const config = { ...loadConfig({ WA_DATA_DIR: "/tmp/wa-trunc-cursor" }), maxResultChars: 500 };
  const h = await harness({
    overrides: { config },
    seed: (ctx) => {
      seedChat(
        ctx,
        ALICE,
        false,
        Array.from({ length: 6 }, (_, i) => ({ id: `M${i}`, ts: i + 1, text: "x".repeat(400) })),
      );
    },
  });

  const text = resultText(await h.client.callTool({ name: "wa_messages_list", arguments: { chat: ALICE, limit: 2 } }));
  assert.match(text, /truncated/, "the seed must be big enough to be cut, or this proves nothing");
  const cursor = /"next_cursor": "([^"]+)"/.exec(text)?.[1];
  assert.ok(cursor, "the cursor must survive a payload the tool had to cut");
  assert.equal(decodeCursor(cursor), 2, "and it must be the real cursor onto page 2, not a stump");
  await h.close();
});
