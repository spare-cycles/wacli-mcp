import { strict as assert } from "node:assert";
import { test } from "node:test";
import { errorResult, jsonResult, textResult } from "./result.js";

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
