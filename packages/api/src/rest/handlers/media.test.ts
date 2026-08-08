/**
 * The seven media representations and the signed download, against real files and real tools.
 *
 * **Nothing in the conversion path is stubbed.** ffmpeg, ffprobe, pdftotext and jimp all run, for
 * `convert.test.ts`'s reason: a stubbed tool only ever asserts the stub, and the failures this layer
 * has to answer for — a wrong mimetype reaching a converter, a source that is not there, a strip
 * that cannot be sampled — live precisely in the part a stub replaces. The host these run on may
 * lack a codec the container has; the container gate is the one that counts.
 *
 * The security half of this file is the half worth reading. A served attachment carries
 * sender-chosen bytes under a sender-chosen mimetype, and `/media/dl/:token` serves it to anyone
 * holding the URL. Four tests below are about what that must never become.
 */

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, before, test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { JpegDerivative, KeyframeStrip, MediaLink, MediaMeta, MediaTranscript, PdfExtract } from "whatsapp-api-sdk";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_DM } from "../../whatsapp/fixtures.js";
import { at, harness, type Harness, type LogEntry, type WireErrorBody } from "./harness.js";
import { boundFilename, safeContentType } from "./media.js";

const run = promisify(execFile);

const ALICE = FIXTURE_DM;
const CHAT = encodeURIComponent(ALICE);

const fixtures = mkdtempSync(join(tmpdir(), "whatsapp-rest-fx-"));
after(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

let jpeg: Buffer;
let mp4: Buffer;
let pdf: Buffer;

const PDF_TEXT = "Hello media pipeline";

/**
 * A minimal but structurally valid single-page PDF. The same construction `convert.test.ts` uses
 * and for the same reason: nothing in the toolchain produces a PDF, and a dependency added to make
 * a test fixture would be a runtime module for no gain. Every byte is ASCII, so a character index
 * is a byte offset and the xref can be computed from the assembled string.
 */
function minimalPdf(text: string): Buffer {
  const body = `BT /F1 12 Tf 20 180 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R" +
      " /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${String(body.length)} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${String(i + 1)} 0 obj\n${object}\nendobj\n`;
  });
  const startxref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(startxref)}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

before(async () => {
  const jpegPath = join(fixtures, "in.jpg");
  const mp4Path = join(fixtures, "in.mp4");
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:duration=1", "-frames:v", "1", jpegPath]); // prettier-ignore
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10", "-t", "2", mp4Path]);
  jpeg = readFileSync(jpegPath);
  mp4 = readFileSync(mp4Path);
  pdf = minimalPdf(PDF_TEXT);
  writeFileSync(join(fixtures, "doc.pdf"), pdf);
});

async function start(t: TestContext, opts: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = await harness(opts);
  t.after(() => h.close());
  return h;
}

/** A harness with one attachment already cached, which is the shape almost every test below wants. */
async function withAttachment(
  t: TestContext,
  bytes: Buffer,
  mimetype: string,
  opts: Parameters<typeof harness>[0] = {},
): Promise<Harness> {
  const h = await start(t, opts);
  h.seed(ALICE, false, [{ id: "M1", ts: 1_700_000_001, kind: "image", text: null }]);
  h.attach(ALICE, "M1", bytes, mimetype);
  return h;
}

const accessLines = (entries: readonly LogEntry[]): LogEntry[] =>
  entries.filter((e) => e.msg === "media: signed download");

// --- the two pure helpers -----------------------------------------------------------------------

void test("a mimetype only reaches a header if it is a bare type/subtype", () => {
  assert.equal(safeContentType("image/jpeg"), "image/jpeg");
  assert.equal(safeContentType("AUDIO/OGG; codecs=opus"), "audio/ogg");
  // The one that matters: `res.setHeader` would throw on this, and a 500 on every fetch of an
  // attachment is a sender's choice of denial. There is nowhere in the token shape for it to live.
  assert.equal(safeContentType("image/jpeg\r\nX-Evil: 1"), "application/octet-stream");
  assert.equal(safeContentType(""), "application/octet-stream");
  assert.equal(safeContentType("notamimetype"), "application/octet-stream");
});

void test("a filename is bounded in bytes and keeps its extension", () => {
  assert.equal(boundFilename("short.pdf"), "short.pdf");
  const long = `${"a".repeat(400)}.pdf`;
  const bounded = boundFilename(long);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 128);
  assert.ok(bounded.endsWith(".pdf"));
  // Multi-byte characters are cut on a code point, never through one.
  const accented = boundFilename(`${"é".repeat(400)}.pdf`);
  assert.ok(Buffer.byteLength(accented, "utf8") <= 128);
  assert.ok(!accented.includes("\ufffd"));
});

// --- the raw route ------------------------------------------------------------------------------

void test("the raw route serves the original bytes, inline, with a filename", async (t) => {
  const h = await withAttachment(t, jpeg, "image/jpeg");

  const res = await h.req(`/v1/media/${CHAT}/M1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.match(res.headers.get("content-disposition") ?? "", /^inline; filename="[0-9a-f]{12}\.jpg"$/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), jpeg);
});

void test("the raw route can be forced to download rather than render", async (t) => {
  const h = await withAttachment(t, jpeg, "image/jpeg");
  const res = await h.req(`/v1/media/${CHAT}/M1?disposition=attachment`);
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename=/);
});

/**
 * The single most important line in this file.
 *
 * `mimetype.startsWith("image/")` reads as the obvious predicate and lets this through. An SVG is a
 * script-bearing document, so served inline from a URL that needs no credential it is stored XSS
 * against whoever opens the link — and the mimetype is chosen by the sender, not by us.
 */
void test("an SVG is served attachment even when inline is asked for", async (t) => {
  const h = await withAttachment(t, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml");

  const res = await h.req(`/v1/media/${CHAT}/M1?disposition=inline`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

void test("a sender-chosen text/html downloads, and a header-splitting mimetype becomes octet-stream", async (t) => {
  const html = await withAttachment(t, Buffer.from("<script>alert(1)</script>"), "text/html");
  const htmlRes = await html.req(`/v1/media/${CHAT}/M1?disposition=inline`);
  // Express appends a charset to a text type of its own accord; the disposition is the point here.
  assert.match(htmlRes.headers.get("content-type") ?? "", /^text\/html\b/);
  assert.match(htmlRes.headers.get("content-disposition") ?? "", /^attachment;/);

  const split = await withAttachment(t, jpeg, "image/jpeg\r\nX-Evil: 1");
  const splitRes = await split.req(`/v1/media/${CHAT}/M1`);
  assert.equal(splitRes.status, 200);
  assert.equal(splitRes.headers.get("content-type"), "application/octet-stream");
  assert.equal(splitRes.headers.get("x-evil"), null);
});

void test("nosniff is on every media response, JSON and binary alike", async (t) => {
  const h = await withAttachment(t, jpeg, "image/jpeg");
  for (const path of [`/v1/media/${CHAT}/M1`, `/v1/media/${CHAT}/M1/meta`, `/v1/media/${CHAT}/M1/link`]) {
    const res = await h.req(path);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
  }
});

// --- the derivatives ------------------------------------------------------------------------------

void test("/jpeg answers base64 with the derivative's size and the original's, both", async (t) => {
  const h = await withAttachment(t, jpeg, "image/jpeg");

  const body = JpegDerivative.parse(await h.json(`/v1/media/${CHAT}/M1/jpeg`));
  assert.equal(body.mimeType, "image/jpeg");
  assert.equal(body.width, 160);
  assert.equal(body.height, 120);
  // `source` is the whole reason this route answers JSON rather than bytes.
  assert.deepEqual(body.source, { bytes: jpeg.byteLength, mimetype: "image/jpeg" });
  assert.ok(Buffer.from(body.data, "base64").byteLength > 0);
});

void test("/jpeg honours maxEdge, and cannot be asked for more than the deployment allows", async (t) => {
  const h = await withAttachment(t, jpeg, "image/jpeg", { config: { maxImageBytes: 200_000 } });

  const small = JpegDerivative.parse(await h.json(`/v1/media/${CHAT}/M1/jpeg?maxEdge=40`));
  assert.equal(small.width, 40);

  // Asking for a cap above the configured one gets the configured one, not the ask.
  const capped = JpegDerivative.parse(await h.json(`/v1/media/${CHAT}/M1/jpeg?maxBytes=50000000`));
  assert.ok(Buffer.from(capped.data, "base64").byteLength <= 200_000);
});

/**
 * The handler refuses a wrong attachment, rather than letting a tool refuse it: `media/convert.ts`
 * reports a tool that ran and exited non-zero as `internal`/500, which is a server fault and the
 * wrong retry advice for a PDF that will never be a photograph.
 */
void test("a representation an attachment can never become is 415, not 500", async (t) => {
  const h = await withAttachment(t, pdf, "application/pdf");
  for (const path of [`/v1/media/${CHAT}/M1/jpeg`, `/v1/media/${CHAT}/M1/keyframes`]) {
    const res = await h.req(path);
    assert.equal(res.status, 415, path);
    assert.equal(((await res.json()) as WireErrorBody).error.code, "unsupported_media", path);
  }

  const image = await withAttachment(t, jpeg, "image/jpeg");
  const text = await image.req(`/v1/media/${CHAT}/M1/text`);
  assert.equal(text.status, 415);
});

void test("/keyframes returns indexed frames, not one binary blob", async (t) => {
  const h = await withAttachment(t, mp4, "video/mp4");

  const body = KeyframeStrip.parse(await h.json(`/v1/media/${CHAT}/M1/keyframes?frames=3`));
  assert.equal(body.frames.length, 3);
  assert.deepEqual(
    body.frames.map((f) => f.index),
    [0, 1, 2],
  );
  assert.ok(body.durationSec > 0);
  assert.deepEqual(body.source, { bytes: mp4.byteLength, mimetype: "video/mp4" });
  for (const frame of body.frames) {
    assert.equal(frame.mimeType, "image/jpeg");
    assert.ok(Buffer.from(frame.data, "base64").byteLength > 0);
  }
});

void test("a client cannot ask for a bigger strip than the deployment configured", async (t) => {
  const h = await withAttachment(t, mp4, "video/mp4", { config: { videoKeyframes: 2 } });
  const body = KeyframeStrip.parse(await h.json(`/v1/media/${CHAT}/M1/keyframes?frames=9`));
  assert.equal(body.frames.length, 2);

  // Above the contract's own ceiling it never reaches ffmpeg at all.
  const res = await h.req(`/v1/media/${CHAT}/M1/keyframes?frames=99`);
  assert.equal(res.status, 400);
});

void test("/text extracts a PDF and says whether the cap cut it short", async (t) => {
  const whole = await withAttachment(t, pdf, "application/pdf");
  const body = PdfExtract.parse(await whole.json(`/v1/media/${CHAT}/M1/text`));
  assert.match(body.text, /Hello media pipeline/);
  assert.equal(body.truncated, false);

  const cut = await withAttachment(t, pdf, "application/pdf", { config: { maxResultChars: 5 } });
  const short = PdfExtract.parse(await cut.json(`/v1/media/${CHAT}/M1/text`));
  assert.equal(short.text.length, 5);
  assert.equal(short.truncated, true);
});

// --- transcript and meta --------------------------------------------------------------------------

void test("/transcript reads the cache and never triggers transcription", async (t) => {
  const h = await start(t);
  h.seed(ALICE, false, [
    { id: "V1", ts: 1_700_000_001, kind: "audio", text: null },
    {
      id: "V2",
      ts: 1_700_000_002,
      kind: "audio",
      text: null,
      transcript: { text: "salut", model: "voxtral", language: "fr" },
    },
  ]);

  assert.equal(MediaTranscript.parse(await h.json(`/v1/media/${CHAT}/V1/transcript`)), null);
  assert.deepEqual(MediaTranscript.parse(await h.json(`/v1/media/${CHAT}/V2/transcript`)), {
    text: "salut",
    model: "voxtral",
    language: "fr",
  });
  assert.equal(h.transcribeCalls.n, 0);
});

/**
 * Not even the attachment is resolved: the transcript is a column on the row, and reaching for the
 * bytes would make a cache miss with the socket down a 503 for a question SQLite could answer.
 */
void test("/transcript answers for a message whose attachment was never downloaded", async (t) => {
  const h = await start(t, { state: "disconnected" });
  h.seed(ALICE, false, [{ id: "V1", ts: 1_700_000_001, kind: "audio", text: null }]);
  assert.equal((await h.req(`/v1/media/${CHAT}/V1/transcript`)).status, 200);
});

void test("/meta reports the attachment's shape, transcript included", async (t) => {
  const h = await withAttachment(t, mp4, "video/mp4");

  const body = MediaMeta.parse(await h.json(`/v1/media/${CHAT}/M1/meta`));
  assert.equal(body.mimetype, "video/mp4");
  assert.equal(body.bytes, mp4.byteLength);
  assert.equal(body.width, 160);
  assert.equal(body.height, 120);
  assert.equal(body.durationSec, 2);
  assert.equal(body.hasTranscript, false);
  assert.match(body.sha256, /^[0-9a-f]{64}$/);
});

// --- signed links -----------------------------------------------------------------------------

void test("a signed link round-trips to the bytes, without a bearer token", async (t) => {
  const h = await withAttachment(t, jpeg, "image/jpeg");

  const link = MediaLink.parse(await h.json(`/v1/media/${CHAT}/M1/link`));
  assert.match(link.url, /^\/media\/dl\/v1\./);
  assert.equal(link.mimeType, "image/jpeg");
  assert.equal(link.bytes, jpeg.byteLength);
  assert.ok(link.expiresAt > Math.floor(Date.now() / 1000));

  const res = await h.anon(link.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), jpeg);
});

void test("for=jpeg mints a link to the derivative, and reports the derivative's size", async (t) => {
  const h = await withAttachment(t, jpeg, "image/jpeg");

  const link = MediaLink.parse(await h.json(`/v1/media/${CHAT}/M1/link?for=jpeg`));
  assert.equal(link.mimeType, "image/jpeg");

  const res = await h.anon(link.url);
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).byteLength, link.bytes);
});

/**
 * Task 6's second carry-forward, satisfied structurally: `?for=` is parsed against the two-value
 * enum by `implement()` before a handler runs, so `mint` never sees a raw query value — and the
 * refusal names the options rather than echoing what was received, which Zod's own
 * `invalid_enum_value` message would have done.
 */
void test("an unknown for= is refused before anything is minted, and never echoed", async (t) => {
  const h = await withAttachment(t, jpeg, "image/jpeg");

  const res = await h.req(`/v1/media/${CHAT}/M1/link?for=%3Cscript%3E`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as WireErrorBody;
  assert.equal(body.error.code, "bad_request");
  assert.match(body.error.message, /raw \| jpeg/);
  assert.doesNotMatch(body.error.message, /script/);
});

/**
 * The link resolves the attachment at mint time so that a link which cannot be produced fails in
 * front of its author rather than 404-ing for whoever it was sent to.
 */
void test("a link to an attachment that cannot be resolved fails at mint, not at redemption", async (t) => {
  const h = await start(t, { state: "disconnected" });
  h.seed(ALICE, false, [{ id: "M1", ts: 1_700_000_001, kind: "image", text: null }]);

  const res = await h.req(`/v1/media/${CHAT}/M1/link`);
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as WireErrorBody).error.code, "not_connected");
});

void test("a forged or expired token is one indistinguishable 404", async (t) => {
  let clock = 1_000_000;
  const h = await withAttachment(t, jpeg, "image/jpeg", { now: () => clock });

  const link = MediaLink.parse(await h.json(`/v1/media/${CHAT}/M1/link`));
  const forged = await h.anon("/media/dl/v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(forged.status, 404);

  clock = link.expiresAt + 1;
  const expired = await h.anon(link.url);
  assert.equal(expired.status, 404);
  const body = (await expired.json()) as WireErrorBody;
  assert.equal(body.error.code, "not_found");
  assert.equal(body.error.message, ((await forged.json()) as WireErrorBody).error.message);
});

void test("the 21st fetch of one token is refused", async (t) => {
  const h = await withAttachment(t, jpeg, "image/jpeg");
  const link = MediaLink.parse(await h.json(`/v1/media/${CHAT}/M1/link`));

  for (let i = 0; i < 20; i++) {
    assert.equal((await h.anon(link.url)).status, 200, `fetch ${String(i + 1)}`);
  }
  const refused = await h.anon(link.url);
  assert.equal(refused.status, 429);
  assert.equal(((await refused.json()) as WireErrorBody).error.code, "budget_exhausted");

  // Per token, not per attachment: a fresh link to the same bytes still works.
  const second = MediaLink.parse(await h.json(`/v1/media/${CHAT}/M1/link`));
  assert.equal((await h.anon(second.url)).status, 200);
});

void test("a signed fetch is logged redacted: never the token, never the URL, never a JID", async (t) => {
  const h = await withAttachment(t, jpeg, "image/jpeg");
  const link = MediaLink.parse(await h.json(`/v1/media/${CHAT}/M1/link`));
  const token = link.url.slice("/media/dl/".length);

  assert.equal((await h.anon(link.url)).status, 200);
  await h.anon("/media/dl/v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

  const lines = accessLines(h.entries);
  assert.equal(lines.length, 2);
  const served = at(lines, 0).obj;
  assert.equal(served["outcome"], "served");
  assert.equal(served["representation"], "raw");
  assert.match(String(served["sha256Prefix"]), /^[0-9a-f]{8}$/);
  assert.equal(typeof served["at"], "number");
  // A token that never verified has no sha and no representation to report.
  const refused = at(lines, 1).obj;
  assert.equal(refused["outcome"], "refused");
  assert.equal(refused["sha256Prefix"], null);

  const everything = JSON.stringify(h.entries);
  assert.doesNotMatch(everything, new RegExp(token.slice(0, 32).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(everything, /whatsapp\.net/);
  // A concrete URL never appears; the route *pattern* `/media/dl/:token` in the rejection line does,
  // and that is exactly the substitution `rest/server.ts` makes so a log carries no credential.
  assert.doesNotMatch(everything, /media\/dl\/v1\./);
});

// --- failures ------------------------------------------------------------------------------------

void test("a cache miss with the socket down is a refusal, not a hang", async (t) => {
  const h = await start(t, { state: "disconnected" });
  h.seed(ALICE, false, [{ id: "M1", ts: 1_700_000_001, kind: "image", text: null }]);

  const res = await h.req(`/v1/media/${CHAT}/M1`);
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as WireErrorBody).error.code, "not_connected");
});

void test("a cached attachment is readable in every connection state", async (t) => {
  const h = await withAttachment(t, jpeg, "image/jpeg", { state: "logged_out" });
  assert.equal((await h.req(`/v1/media/${CHAT}/M1`)).status, 200);
});

void test("an unknown message is message_not_found on every media route", async (t) => {
  const h = await start(t);
  const paths = ["", "/jpeg", "/link", "/keyframes", "/text", "/transcript", "/meta"];
  for (const suffix of paths) {
    const res = await h.req(`/v1/media/${CHAT}/NOPE${suffix}`);
    assert.equal(res.status, 404, suffix);
    assert.equal(((await res.json()) as WireErrorBody).error.code, "message_not_found", suffix);
  }
});
