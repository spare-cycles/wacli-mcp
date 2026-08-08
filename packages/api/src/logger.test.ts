import { strict as assert } from "node:assert";
import { test } from "node:test";
import { errorFields, scrubUrls } from "./logger.js";

// The URL baileys really produces on the common failure — an expired media URL answering non-2xx.
// `lib/Utils/messages-media.js` throws ``new Boom(`Failed to fetch stream from ${url}`, …)``, and
// the signed query is the capability: whoever holds it can fetch the attachment's encrypted bytes.
const CDN_URL =
  "https://mmg.whatsapp.net/v/t62.7118-24/12345_678_910_n.enc?ccb=11-4&oh=01_Q5AaIQ&oe=68B4C0D1&_nc_sid=5e03e0";

void test("scrubUrls keeps the host and drops the path and query", () => {
  const scrubbed = scrubUrls(`Failed to fetch stream from ${CDN_URL}`);
  assert.equal(scrubbed, "Failed to fetch stream from <url mmg.whatsapp.net>");
  assert.doesNotMatch(scrubbed, /oh=|oe=|_nc_sid|\.enc/);
});

void test("scrubUrls leaves a message with no URL untouched", () => {
  assert.equal(scrubUrls("could not download the media: it expired"), "could not download the media: it expired");
});

void test("scrubUrls handles several URLs and stops at the surrounding punctuation", () => {
  const scrubbed = scrubUrls(`tried "http://a.example/x?k=1" then <https://b.example/y>, both refused`);
  assert.equal(scrubbed, 'tried "<url a.example>" then <<url b.example>>, both refused');
});

void test("errorFields scrubs the message, so a URL in the message cannot reach a log line", () => {
  const fields = errorFields(new Error(`Failed to fetch stream from ${CDN_URL}`));
  assert.equal(fields.errorType, "Error");
  assert.doesNotMatch(fields.errorMessage, /mmg\.whatsapp\.net\/v/);
  assert.doesNotMatch(fields.errorMessage, /oh=|oe=/);
  assert.match(fields.errorMessage, /Failed to fetch stream/, "the diagnosis itself must survive");
});

void test("errorFields reports a non-Error throwable without inventing a message", () => {
  const fields = errorFields("plain string");
  assert.equal(fields.errorType, "string");
  assert.equal(fields.errorMessage, "a non-Error value was thrown");
});

void test("errorFields never emits the stack, which pino's own serializer would", () => {
  const fields = errorFields(new Error("boom"));
  assert.deepEqual(Object.keys(fields).sort(), ["errorMessage", "errorType"]);
});
