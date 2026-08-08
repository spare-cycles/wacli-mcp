import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CursorError, decodeCursor, encodeCursor } from "./cursor.js";

void test("an absent cursor is offset 0", () => {
  assert.equal(decodeCursor(undefined), 0);
});

void test("encode and decode round-trip", () => {
  for (const offset of [0, 1, 50, 999_999]) {
    assert.equal(decodeCursor(encodeCursor(offset)), offset);
  }
});

void test("the encoding is base64url of the documented shape", () => {
  assert.equal(encodeCursor(50), Buffer.from('{"o":50}', "utf8").toString("base64url"));
  assert.doesNotMatch(encodeCursor(50), /[+/=]/, "base64url, so a cursor is safe in a URL or a JSON string");
});

void test("a malformed cursor throws CursorError rather than resetting to 0", () => {
  for (const bad of ["", "not-base64!!", "eyJvIjotMX0", "eyJ4IjoxfQ", "eyJvIjoiNSJ9", "eyJvIjoxLjV9"]) {
    assert.throws(() => decodeCursor(bad), CursorError, `"${bad}" must be rejected`);
  }
});

void test("CursorError does not echo the cursor back", () => {
  // The cursor is caller-controlled text; repeating it verbatim in an error puts caller-controlled
  // content into the model's context for no diagnostic gain.
  try {
    decodeCursor("zzzz-not-a-cursor");
    assert.fail("expected a throw");
  } catch (err) {
    assert.ok(err instanceof CursorError);
    assert.doesNotMatch(err.message, /zzzz/);
  }
});
