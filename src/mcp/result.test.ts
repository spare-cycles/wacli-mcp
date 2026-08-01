import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ReactionRow } from "../db/reactions.js";
import type { ToolContext } from "./context.js";
import { errorResult, jsonResult, presentReactions, textResult } from "./result.js";

void test("jsonResult pretty-prints", () => {
  const r = jsonResult({ a: 1 }, 1000);
  assert.equal(r.content[0]?.type, "text");
  assert.match((r.content[0] as { text: string }).text, /"a": 1/);
});

void test("jsonResult truncates with a note naming the real size", () => {
  const r = jsonResult({ big: "x".repeat(5000) }, 200);
  const text = (r.content[0] as { text: string }).text;
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

  const body = truncatedBody((jsonResult(payload, maxChars).content[0] as { text: string }).text);
  assert.doesNotMatch(body, LONE_SURROGATE, "a lone surrogate is not a character and does not re-encode");
  assert.equal(body.length, maxChars - 1, "exactly the orphaned half is dropped, and nothing more");
});

void test("jsonResult drops nothing extra when the cut already falls between characters", () => {
  const payload = { s: "😀".repeat(40) };
  const full = JSON.stringify(payload, null, 2);
  const maxChars = full.indexOf("😀") + 10;
  assert.doesNotMatch(full.slice(0, maxChars), LONE_SURROGATE, "this cut is aligned by construction");

  const body = truncatedBody((jsonResult(payload, maxChars).content[0] as { text: string }).text);
  assert.equal(body.length, maxChars, "an aligned cut keeps the whole budget");
});

void test("jsonResult leaves a payload under the cap untouched", () => {
  const r = jsonResult({ a: 1 }, 1000);
  assert.equal((r.content[0] as { text: string }).text, JSON.stringify({ a: 1 }, null, 2));
  assert.equal(r.isError, undefined);
});

void test("errorResult marks isError and never leaks a stack", () => {
  const r = errorResult(new Error("boom"));
  assert.equal(r.isError, true);
  const text = (r.content[0] as { text: string }).text;
  assert.match(text, /boom/);
  assert.doesNotMatch(text, /at .*\.ts:/, "a stack trace is noise in a model's context");
});

void test("errorResult keeps no trace of a multi-frame stack, however deep the cause", () => {
  const inner = new Error("inner");
  const outer = new Error("outer", { cause: inner });
  const text = (errorResult(outer).content[0] as { text: string }).text;
  assert.doesNotMatch(text, /\n\s+at /, "no stack frame may survive, from the error or its cause");
  assert.ok(text.length < 200, `an error message must stay short, got ${text.length} chars`);
});

void test("errorResult handles non-Error throwables", () => {
  assert.match((errorResult("plain string").content[0] as { text: string }).text, /plain string/);
  assert.ok(errorResult(undefined).isError);
});

void test("textResult passes text through", () => {
  assert.equal((textResult("hi").content[0] as { text: string }).text, "hi");
});

// ── presentReactions ──────────────────────────────────────────────────────
//
// It has no caller until Task 13's single-message tools, which is exactly why the shape is pinned
// here: an exported function nobody exercises is a shape nobody has checked.

const ALICE = "33611111111@s.whatsapp.net";
const BOB = "33622222222@s.whatsapp.net";

/** `presentReactions` reads one thing from the context — how to name a sender — so that is the stub. */
function namingContext(names: Record<string, string>): ToolContext {
  const contacts = { displayName: (id: string) => names[id] ?? id };
  return { contacts } as unknown as ToolContext;
}

const reaction = (over: Partial<ReactionRow> = {}): ReactionRow => ({
  chatId: "120363000000000000@g.us",
  messageId: "M1",
  senderId: ALICE,
  emoji: "👍",
  ts: 1000,
  ...over,
});

void test("presentReactions names each reactor and keeps nothing else", () => {
  const ctx = namingContext({ [ALICE]: "Alice Martin" });
  const shaped = presentReactions([reaction(), reaction({ senderId: BOB, emoji: "❤️", ts: 1001 })], ctx);

  assert.deepEqual(shaped, [
    { emoji: "👍", from: { id: ALICE, name: "Alice Martin" } },
    // An unknown sender keeps its jid as its name, so the id is never lost.
    { emoji: "❤️", from: { id: BOB, name: BOB } },
  ]);
});

void test("presentReactions keeps the order it was given and answers [] for none", () => {
  const ctx = namingContext({});
  const emojis = ["1️⃣", "2️⃣", "3️⃣"];
  const shaped = presentReactions(
    emojis.map((emoji, i) => reaction({ emoji, senderId: `s${i}@s.whatsapp.net`, ts: 1000 + i })),
    ctx,
  );
  assert.deepEqual(
    shaped.map((r) => r["emoji"]),
    emojis,
    "the repo returns reactions oldest first; shaping must not reorder them",
  );
  assert.deepEqual(presentReactions([], ctx), []);
});
