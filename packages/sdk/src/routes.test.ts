import { strict as assert } from "node:assert";
import { test } from "node:test";

import { z } from "zod";

import { routes, type BinaryPayload, type HandlerResult, type Route, type RouteKey, type Routes } from "./routes.js";
import { Page } from "./schemas/common.js";
import { Chat } from "./schemas/domain.js";

/**
 * The table under its common supertype.
 *
 * `routes` itself is 24 distinct literal types, and reading `.params` off that union is a compile
 * error on the two thirds of the entries that do not declare one. This is the same widening
 * `implement()` performs, and it is an assignment rather than an assertion — if a future entry
 * stopped satisfying `Route`, this line would be the first thing to fail.
 */
const table: Record<RouteKey, Route> = routes;

/**
 * Every operation, as `METHOD path auth`.
 *
 * `satisfies Record<RouteKey, string>` makes this exhaustive by construction: add a route without a
 * row here and the test file stops compiling. That is deliberate — a table this size drifts
 * silently, and the census is also what a reviewer diffs when a route changes shape.
 *
 * ⚠️ Changing any row means the contract changed. Bump `CONTRACT_VERSION` in `schemas/domain.ts`
 * with it, or an API and an MCP built from different commits will disagree without saying so.
 */
const CENSUS = {
  // unauthenticated — mounted before the bearer gate, and outside `/v1` by path
  getHealth: "GET /health public",
  fetchSignedMedia: "GET /media/dl/:token signed",
  // meta
  capabilities: "GET /v1/capabilities bearer",
  // reads
  listChats: "GET /v1/chats bearer",
  listGroups: "GET /v1/groups bearer",
  listContacts: "GET /v1/contacts bearer",
  listMessages: "GET /v1/messages bearer",
  searchMessages: "GET /v1/messages/search bearer",
  getMessage: "GET /v1/messages/:chat/:id bearer",
  // media
  fetchMedia: "GET /v1/media/:chat/:id bearer",
  fetchMediaJpeg: "GET /v1/media/:chat/:id/jpeg bearer",
  fetchMediaLink: "GET /v1/media/:chat/:id/link bearer",
  fetchMediaKeyframes: "GET /v1/media/:chat/:id/keyframes bearer",
  fetchMediaText: "GET /v1/media/:chat/:id/text bearer",
  fetchMediaTranscript: "GET /v1/media/:chat/:id/transcript bearer",
  fetchMediaMeta: "GET /v1/media/:chat/:id/meta bearer",
  // writes
  sendText: "POST /v1/messages bearer",
  sendFile: "POST /v1/messages/file bearer",
  editMessage: "PATCH /v1/messages/:chat/:id bearer",
  deleteMessage: "DELETE /v1/messages/:chat/:id bearer",
  react: "POST /v1/messages/:chat/:id/reaction bearer",
  transcribe: "POST /v1/messages/:chat/:id/transcribe bearer",
  markRead: "POST /v1/chats/:chat/read bearer",
  resolveRecipient: "POST /v1/recipients/resolve bearer",
} satisfies Record<RouteKey, string>;

/** The arithmetic the contract states: 6 reads + 7 media + 8 writes + 3 unauthenticated/meta = 24. */
const GROUPS = {
  reads: ["listChats", "listGroups", "listContacts", "listMessages", "searchMessages", "getMessage"],
  media: [
    "fetchMedia",
    "fetchMediaJpeg",
    "fetchMediaLink",
    "fetchMediaKeyframes",
    "fetchMediaText",
    "fetchMediaTranscript",
    "fetchMediaMeta",
  ],
  writes: [
    "sendText",
    "sendFile",
    "editMessage",
    "deleteMessage",
    "react",
    "markRead",
    "transcribe",
    "resolveRecipient",
  ],
  meta: ["capabilities", "getHealth", "fetchSignedMedia"],
} satisfies Record<string, RouteKey[]>;

// --- the whole-table invariants -------------------------------------------------------------------

void test("every route in the table has a unique method+path", () => {
  const seen = new Set<string>();
  for (const r of Object.values(routes)) {
    const key = `${r.method} ${r.path}`;
    assert.ok(!seen.has(key), `duplicate route ${key}`);
    seen.add(key);
  }
});

void test("the table is exactly the 24 operations the contract names, with their methods and paths", () => {
  assert.equal(Object.keys(routes).length, 24);
  assert.deepEqual(Object.keys(routes).toSorted(), Object.keys(CENSUS).toSorted());
  for (const [key, route] of Object.entries(table)) {
    assert.equal(`${route.method} ${route.path} ${route.auth}`, CENSUS[key as RouteKey], key);
  }
});

void test("the census adds up the way the contract says: 6 reads, 7 media, 8 writes, 3 unauthenticated or meta", () => {
  assert.equal(GROUPS.reads.length, 6);
  assert.equal(GROUPS.media.length, 7);
  assert.equal(GROUPS.writes.length, 8);
  assert.equal(GROUPS.meta.length, 3);
  assert.deepEqual(
    [...GROUPS.reads, ...GROUPS.media, ...GROUPS.writes, ...GROUPS.meta].toSorted(),
    [...Object.keys(routes)].toSorted(),
  );
});

void test("only /health and the signed download escape the bearer gate, and only they sit outside /v1", () => {
  for (const [key, route] of Object.entries(table)) {
    const gated = route.auth === "bearer";
    assert.equal(gated, route.path.startsWith("/v1/"), `${key} is ${route.auth} at ${route.path}`);
  }
  // Named rather than counted: the mount order partitions on exactly these two, and a third
  // ungated route is a security change that must be argued for here first.
  assert.deepEqual(
    Object.entries(table)
      .filter(([, r]) => r.auth !== "bearer")
      .map(([k]) => k),
    ["getHealth", "fetchSignedMedia"],
  );
});

void test("every :param segment in a path is declared by the route's params schema, and nothing else is", () => {
  for (const [key, route] of Object.entries(table)) {
    const inPath = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);
    const declared = route.params === undefined ? [] : Object.keys((route.params as z.ZodObject<z.ZodRawShape>).shape);
    assert.deepEqual(declared.toSorted(), inPath.toSorted(), key);
  }
});

void test("each media representation is its own route with one response kind, which is what keeps HandlerResult from collapsing", () => {
  // The seven representations exist as seven routes for this reason. A single `?as=` route whose
  // `response` were `JsonResponse | BinaryResponse` would satisfy neither branch of the conditional
  // and type as `never`, and nothing at runtime would notice. Pinned per route rather than counted,
  // because "one file → binary, many or structured → JSON" is the rule the split encodes.
  const KINDS = {
    fetchMedia: "binary",
    fetchMediaJpeg: "json",
    fetchMediaLink: "json",
    fetchMediaKeyframes: "json",
    fetchMediaText: "json",
    fetchMediaTranscript: "json",
    fetchMediaMeta: "json",
  } satisfies Record<(typeof GROUPS.media)[number], "json" | "binary">;
  for (const key of GROUPS.media) assert.equal(table[key].response.kind, KINDS[key], key);
});

// --- HandlerResult, which must resolve for both kinds and never to `never` -------------------------
//
// These are compile-time assertions with a runtime tail. The annotation is the assertion: if
// `HandlerResult<R>` were `never`, no object literal would be assignable to it and `tsc` would fail
// here — which is why each one is written as an annotated binding rather than an `as`.

void test("HandlerResult for a JSON route is the response schema's inferred output", () => {
  const chat: z.infer<typeof Chat> = {
    id: "33600000000@s.whatsapp.net",
    name: "Marie",
    isGroup: false,
    lastMessageTs: 1_700_000_000,
    unreadCount: 2,
    archived: false,
    mutedUntil: null,
    participantCount: null,
  };
  const page: HandlerResult<Routes["listChats"]> = { nextCursor: "b2Zmc2V0OjUw", items: [chat] };
  assert.deepEqual(Page(Chat).parse(page), page);
});

void test("HandlerResult for a binary route is BinaryPayload, not the JSON branch and not never", () => {
  const payload: HandlerResult<Routes["fetchMedia"]> = {
    bytes: new Uint8Array([0xff, 0xd8]),
    mimeType: "image/jpeg",
    filename: "photo.jpg",
    disposition: "inline",
  };
  const asPayload: BinaryPayload = payload;
  assert.equal(asPayload.mimeType, "image/jpeg");
});

void test("HandlerResult does not let the two kinds cross", () => {
  // @ts-expect-error a JSON route answers its parsed body, never bytes
  const notAPage: HandlerResult<Routes["listChats"]> = { bytes: new Uint8Array(), mimeType: "image/jpeg" };
  // @ts-expect-error a binary route answers bytes, never a parsed page
  const notPayload: HandlerResult<Routes["fetchMedia"]> = { nextCursor: null, items: [] };
  assert.ok(notAPage);
  assert.ok(notPayload);
});
