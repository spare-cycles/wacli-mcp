/**
 * Real conversions against real fixtures. ffmpeg, ffprobe, pdftotext and jimp all run for real and
 * none of them is stubbed, deliberately: a stubbed ffmpeg would only ever assert the stub, and every
 * bug this module can have — a wrong flag, a codec jimp cannot decode, a loop that never terminates,
 * a process that hangs — lives precisely in the part a stub replaces.
 */

import { Jimp } from "jimp";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import type { Logger } from "pino";
import {
  ConversionError,
  imageBlock,
  imageJpeg,
  keyframes,
  keyframeTimestamps,
  pdfExtract,
  pdfText,
  probeDimensions,
  probeDuration,
  runTool,
  toOpus16k,
  videoKeyframes,
} from "./convert.js";

const run = promisify(execFile);

const dir = mkdtempSync(join(tmpdir(), "whatsapp-conv-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const png = join(dir, "in.png"); // 1280x720 still
const mp4 = join(dir, "in.mp4"); // 320x240, 3 s, video only
const hdMp4 = join(dir, "hd.mp4"); // 1280x720, 2 s, video only
const avMp4 = join(dir, "av.mp4"); // 320x240 + a 440 Hz tone, 2 s
const wav = join(dir, "in.wav"); // 2 s sine
const webp = join(dir, "sticker.webp"); // the format every WhatsApp sticker arrives in
const pdf = join(dir, "doc.pdf");
const longPdf = join(dir, "long.pdf"); // more text than any small `maxChars`, so truncation is real
const notMedia = join(dir, "notes.txt");

const PDF_TEXT = "Hello media pipeline";
const LONG_PDF_TEXT = Array.from({ length: 12 }, (_, i) => `line ${String(i)} abcdefghijklmnopqrst`).join("\n");

/**
 * A minimal but structurally valid single-page PDF, one line of Helvetica text per line of `text`.
 *
 * Hand-built rather than generated, because nothing in the toolchain produces a PDF and adding a
 * dependency to make a test fixture would violate the no-new-runtime-modules rule for no gain. The
 * xref offsets are computed from the assembled string, which is safe only because every byte here
 * is ASCII, so a character index is a byte offset. Newlines become real baselines rather than one
 * long line, because `pdftotext` reports only what fits inside the MediaBox: a single line of 300
 * characters comes back clipped to the ~50 that fit across the page.
 */
function minimalPdf(text: string): Buffer {
  const lines = text.split("\n").map((line, i) => `${i === 0 ? "" : "0 -14 Td "}(${line}) Tj`);
  const body = `BT /F1 12 Tf 20 180 Td ${lines.join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R" +
      " /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });

  const startxref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

type Captured = { level: string; msg: string };

/** A logger that records instead of printing, so a test can assert that a warning was emitted. */
function captureLogger(): { logger: Logger; entries: Captured[] } {
  const entries: Captured[] = [];
  const record =
    (level: string) =>
    (_obj: unknown, msg?: string): void => {
      entries.push({ level, msg: msg ?? "" });
    };
  const logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  } as unknown as Logger;
  return { logger, entries };
}

function bytesOf(base64: string): number {
  return Buffer.from(base64, "base64").byteLength;
}

/** Float comparison for timestamps: 100 * 0.05 is not exactly 5 in IEEE 754. */
function near(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 1e-6;
}

before(async () => {
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:duration=1", "-frames:v", "1", png]); // prettier-ignore
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-t", "3", mp4]);
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=10", "-t", "2", hdMp4]);
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", avMp4]); // prettier-ignore
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", wav]);
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=512x512:duration=1", "-frames:v", "1", "-c:v", "libwebp", webp]); // prettier-ignore
  writeFileSync(pdf, minimalPdf(PDF_TEXT));
  writeFileSync(longPdf, minimalPdf(LONG_PDF_TEXT));
  writeFileSync(notMedia, "not a media file at all\n");
});

// --- images -----------------------------------------------------------------------------------

void test("imageBlock returns base64 JPEG under the cap", async () => {
  const b = await imageBlock(png, 20_000);
  assert.equal(b.mimeType, "image/jpeg");
  assert.ok(bytesOf(b.data) <= 20_000, `expected <= 20000 bytes, got ${bytesOf(b.data)}`);
});

void test("a large cap leaves the image at its original size rather than upscaling it", async () => {
  const b = await imageBlock(png, 5_000_000);
  const decoded = await Jimp.read(Buffer.from(b.data, "base64"));
  assert.equal(decoded.width, 1280);
  assert.equal(decoded.height, 720);
});

void test("imageBlock terminates on an unreachable cap, returning the smallest attempt and warning", async () => {
  const { logger, entries } = captureLogger();
  // 500 bytes is below what a 320px JPEG of this pattern can reach, so every attempt overshoots and
  // the loop has to stop on its own. An implementation that keeps halving would never return here.
  const b = await imageBlock(png, 500, logger);
  assert.equal(b.mimeType, "image/jpeg");
  assert.ok(bytesOf(b.data) > 500, "the test is vacuous unless the cap really is unreachable");

  const full = await imageBlock(png, 5_000_000);
  assert.ok(bytesOf(b.data) < bytesOf(full.data), "the returned attempt must be the shrunken one");
  assert.ok(
    entries.some((e) => e.level === "warn"),
    "giving up on the cap must be logged",
  );

  // Downscaling must set one edge and let the other follow; setting both would squash the picture.
  // Tolerance rather than equality because each step rounds to whole pixels.
  const decoded = await Jimp.read(Buffer.from(b.data, "base64"));
  const ratio = decoded.width / decoded.height;
  assert.ok(Math.abs(ratio - 1280 / 720) < 0.02, `aspect ratio drifted: ${decoded.width}x${decoded.height}`);
});

void test("keyframeTimestamps asked for no frames returns none", () => {
  assert.deepEqual(keyframeTimestamps(100, 0), []);
});

void test("imageBlock decodes WebP, which jimp cannot read, through the ffmpeg fallback", async () => {
  const b = await imageBlock(webp, 5_000_000);
  assert.equal(b.mimeType, "image/jpeg");
  const decoded = await Jimp.read(Buffer.from(b.data, "base64"));
  assert.equal(decoded.width, 512);
});

void test("a file that is not there is named as such, and costs no ffmpeg process", async () => {
  // jimp reports a missing file and a format it does not ship with the same opaque error, so without
  // an explicit check both fall through to the ffmpeg fallback — where a missing *input* is reported
  // as "ffmpeg is not installed or not on PATH" on any image built without ffmpeg, which sends the
  // reader to rebuild a runtime that was fine.
  await assert.rejects(
    () => imageBlock(join(dir, "does-not-exist.png"), 1000),
    (err: unknown) => {
      assert.ok(err instanceof ConversionError, `expected ConversionError, got ${String(err)}`);
      assert.match(err.message, /ENOENT/, "the error must name what is actually wrong");
      assert.doesNotMatch(err.message, /ffmpeg/, "and must not blame the transcoder for it");
      return true;
    },
  );
});

void test("imageJpeg returns bytes, and reports the size those bytes actually are", async () => {
  const out = await imageJpeg(png, { maxBytes: 5_000_000 });
  assert.equal(out.mimeType, "image/jpeg");
  assert.ok(Buffer.isBuffer(out.bytes) && out.bytes.byteLength > 0, "bytes, not base64");
  assert.equal(out.width, 1280);
  assert.equal(out.height, 720);
  const decoded = await Jimp.read(out.bytes);
  assert.equal(decoded.width, out.width, "the reported width must be the width of the returned bytes");
  assert.equal(decoded.height, out.height);
});

void test("imageJpeg shrinks to maxEdge and lets the other edge follow", async () => {
  const out = await imageJpeg(png, { maxBytes: 5_000_000, maxEdge: 640 });
  assert.equal(out.width, 640);
  assert.equal(out.height, 360, "setting both edges would squash the picture");
  const decoded = await Jimp.read(out.bytes);
  assert.equal(decoded.width, 640);
});

void test("imageJpeg does not upscale a small image to maxEdge", async () => {
  const out = await imageJpeg(png, { maxBytes: 5_000_000, maxEdge: 4000 });
  assert.equal(out.width, 1280);
});

void test("imageJpeg on an unreachable cap returns the smallest attempt, sized as it really is", async () => {
  const { logger, entries } = captureLogger();
  // Same unreachable cap as the imageBlock case: every attempt overshoots, so the loop must stop on
  // the edge floor rather than keep halving.
  const out = await imageJpeg(png, { maxBytes: 500 }, logger);
  assert.ok(out.bytes.byteLength > 500, "the test is vacuous unless the cap really is unreachable");
  assert.ok(out.width < 1280, `the returned attempt must be a shrunken one, got ${out.width}px`);
  // The returned size belongs to the returned bytes, not to whatever the last pass left the image
  // at: the smallest attempt can predate the final resize.
  const decoded = await Jimp.read(out.bytes);
  assert.equal(decoded.width, out.width);
  assert.equal(decoded.height, out.height);
  assert.ok(
    entries.some((e) => e.level === "warn"),
    "giving up on the cap must be logged",
  );
});

void test("imageJpeg decodes WebP through the same ffmpeg fallback", async () => {
  const out = await imageJpeg(webp, { maxBytes: 5_000_000 });
  assert.equal(out.width, 512);
  assert.equal(out.height, 512);
});

void test("imageJpeg names a file that is not there", async () => {
  await assert.rejects(() => imageJpeg(join(dir, "does-not-exist.png"), { maxBytes: 1000 }), ConversionError);
});

// --- video ------------------------------------------------------------------------------------

void test("videoKeyframes returns the requested number of distinct frames", async () => {
  const frames = await videoKeyframes(mp4, 3, 100_000);
  assert.equal(frames.length, 3);
  assert.notEqual(frames[0]?.data, frames[2]?.data, "frames must be sampled across the video, not duplicated");
  for (const f of frames) assert.equal(f.mimeType, "image/jpeg");
});

void test("videoKeyframes with a count of one samples the middle of the video", async () => {
  const frames = await videoKeyframes(mp4, 1, 100_000);
  assert.equal(frames.length, 1);
  assert.ok(bytesOf(frames[0]?.data ?? "") > 0);
});

void test("videoKeyframes shrinks a frame that overruns the cap", async () => {
  const [big] = await videoKeyframes(hdMp4, 1, 5_000_000);
  const [small] = await videoKeyframes(hdMp4, 1, 20_000);
  assert.ok(big !== undefined && small !== undefined);
  assert.ok(
    bytesOf(small.data) < bytesOf(big.data),
    `a capped frame must be smaller: ${bytesOf(small.data)} vs ${bytesOf(big.data)}`,
  );
});

void test("keyframeTimestamps skips the first and last 5% and spaces the rest evenly", () => {
  const three = keyframeTimestamps(100, 3);
  assert.equal(three.length, 3);
  assert.ok(near(three[0] ?? -1, 5), `first sample should skip 5%, got ${String(three[0])}`);
  assert.ok(near(three[1] ?? -1, 50));
  assert.ok(near(three[2] ?? -1, 95), `last sample should stop 5% short, got ${String(three[2])}`);

  const one = keyframeTimestamps(100, 1);
  assert.equal(one.length, 1);
  assert.ok(near(one[0] ?? -1, 50), "a single sample belongs in the middle");
});

void test("videoKeyframes refuses a file it cannot read a duration from", async () => {
  await assert.rejects(() => videoKeyframes(notMedia, 2, 100_000), ConversionError);
});

void test("keyframes carry their index and timestamp, in order", async () => {
  const { durationSec, frames } = await keyframes(mp4, { count: 3, maxBytes: 5 * 1024 * 1024 });
  assert.ok(durationSec > 2.5 && durationSec < 3.5, `expected ~3s, got ${String(durationSec)}`);
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames.map((f) => f.index),
    [0, 1, 2],
  );
  // The labels must come from the one helper that decides the spacing, or a strip and its captions
  // can drift apart with nothing to catch it.
  assert.deepEqual(
    frames.map((f) => f.atSec),
    keyframeTimestamps(durationSec, 3),
  );
  assert.ok(
    frames.every((f, i) => i === 0 || f.atSec > (frames[i - 1]?.atSec ?? Infinity)),
    "timestamps must increase across the strip",
  );
  assert.ok(frames.every((f) => f.atSec >= 0 && f.atSec <= durationSec));
  assert.ok(frames.every((f) => Buffer.isBuffer(f.bytes) && f.bytes.length > 0));
  assert.notDeepEqual(frames[0]?.bytes, frames[2]?.bytes, "frames must be sampled across the video");
});

void test("keyframes report the size of the frames they return", async () => {
  const strip = await keyframes(mp4, { count: 2, maxBytes: 5 * 1024 * 1024 });
  assert.equal(strip.width, 320);
  assert.equal(strip.height, 240);
  for (const f of strip.frames) {
    const decoded = await Jimp.read(f.bytes);
    assert.equal(decoded.width, strip.width);
    assert.equal(decoded.height, strip.height);
  }
});

void test("a capped strip is shrunk as one, so every frame is the size the strip reports", async () => {
  // 1280x720 frames do not fit 30 kB, so the whole strip has to come down — and it has to come down
  // by the same amount for every frame, or the single width/height the strip reports is a lie for
  // some of them.
  const strip = await keyframes(hdMp4, { count: 3, maxBytes: 30_000 });
  assert.ok(strip.width < 1280, `expected a shrunken strip, got ${strip.width}px`);
  assert.equal(strip.frames.length, 3);
  for (const f of strip.frames) {
    assert.ok(f.bytes.byteLength <= 30_000, `frame ${String(f.index)} overruns the cap: ${f.bytes.byteLength}`);
    const decoded = await Jimp.read(f.bytes);
    assert.equal(decoded.width, strip.width, `frame ${String(f.index)} is not the size the strip reports`);
    assert.equal(decoded.height, strip.height);
  }
});

void test("keyframes with a count of one samples the middle of the video", async () => {
  const { durationSec, frames } = await keyframes(mp4, { count: 1, maxBytes: 5 * 1024 * 1024 });
  assert.equal(frames.length, 1);
  assert.ok(near(frames[0]?.atSec ?? -1, durationSec / 2));
});

void test("keyframes refuses a file it cannot read a duration from", async () => {
  await assert.rejects(() => keyframes(notMedia, { count: 2, maxBytes: 100_000 }), ConversionError);
});

void test("keyframes refuses a strip with no frames in it", async () => {
  // The return type promises one width and one height; with no frames there is no honest answer,
  // so this is refused rather than answered with zeroes.
  await assert.rejects(() => keyframes(mp4, { count: 0, maxBytes: 100_000 }), ConversionError);
});

// --- audio ------------------------------------------------------------------------------------

void test("toOpus16k produces a mono Opus stream far smaller than its input", async () => {
  const out = join(dir, "out.ogg");
  await toOpus16k(wav, out);
  const { stdout } = await run("ffprobe", [
    ...["-v", "error", "-show_entries", "stream=codec_name,channels"],
    ...["-of", "default=noprint_wrappers=1:nokey=1", out],
  ]);
  const [codec, channels] = stdout.trim().split("\n");
  assert.equal(codec, "opus");
  assert.equal(channels, "1");
  // Size is the property that matters, not the sample rate: the audio is base64'd into a JSON
  // request against a 10 MB cap, and Opus is what keeps a long recording inside it. (Sample rate is
  // deliberately not asserted — Opus always *decodes* at 48 kHz, so ffprobe reports 48000 whatever
  // `-ar` asked for, and asserting 16000 would be asserting a thing that is never true.)
  assert.ok(statSync(out).size * 4 < statSync(wav).size, `${statSync(out).size} vs ${statSync(wav).size}`);
});

void test("toOpus16k extracts the audio track of a video and drops the video stream", async () => {
  const out = join(dir, "from-video.ogg");
  await toOpus16k(avMp4, out);
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    out,
  ]);
  assert.equal(stdout.trim(), "audio", "a video stream must not survive into the upload");
});

void test("toOpus16k on an unreadable input raises ConversionError", async () => {
  await assert.rejects(() => toOpus16k(join(dir, "nope.ogg"), join(dir, "nope.out.ogg")), ConversionError);
});

void test("probeDuration reads a duration", async () => {
  const d = await probeDuration(wav);
  assert.ok(d !== undefined && d > 1.5 && d < 2.5, `expected ~2s, got ${String(d)}`);
});

void test("probeDuration on a file that is not media raises ConversionError", async () => {
  await assert.rejects(() => probeDuration(notMedia), ConversionError);
});

// --- dimensions -------------------------------------------------------------------------------

void test("probeDimensions reads the size of a still, a video and a sticker alike", async () => {
  assert.deepEqual(await probeDimensions(png), { width: 1280, height: 720 });
  assert.deepEqual(await probeDimensions(mp4), { width: 320, height: 240 });
  // WebP is the whole reason this goes through ffprobe rather than jimp, which cannot decode it.
  assert.deepEqual(await probeDimensions(webp), { width: 512, height: 512 });
});

void test("probeDimensions answers undefined for a file with no picture in it", async () => {
  // ffprobe exits 0 and prints nothing for an audio-only file, so "no dimensions" must not be read
  // as a failure — and must not come back as NaN either.
  assert.equal(await probeDimensions(wav), undefined);
});

void test("probeDimensions on a file that is not media raises ConversionError", async () => {
  await assert.rejects(() => probeDimensions(notMedia), ConversionError);
});

// --- documents --------------------------------------------------------------------------------

void test("pdfText extracts the page text", async () => {
  const text = await pdfText(pdf, 10_000);
  assert.match(text, new RegExp(PDF_TEXT));
});

void test("pdfText truncates to maxChars", async () => {
  const text = await pdfText(pdf, 5);
  assert.equal(text.length, 5);
  assert.equal(text, PDF_TEXT.slice(0, 5));
});

void test("pdfText names the missing tool when pdftotext is not installed", async () => {
  const path = process.env["PATH"];
  process.env["PATH"] = join(dir, "empty-bin"); // a directory that holds no binaries
  try {
    await assert.rejects(() => pdfText(pdf, 10_000), /pdftotext/);
  } finally {
    process.env["PATH"] = path;
  }
});

void test("pdfText refuses a file that is not a PDF", async () => {
  await assert.rejects(() => pdfText(notMedia, 10_000), ConversionError);
});

void test("pdfExtract reports truncation rather than hiding it", async () => {
  const whole = await pdfExtract(longPdf, 10_000);
  assert.equal(whole.truncated, false);
  assert.ok(whole.text.length > 100, `the fixture must overrun the cap, got ${String(whole.text.length)} chars`);

  const cut = await pdfExtract(longPdf, 100);
  assert.equal(cut.text.length, 100);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, whole.text.slice(0, 100), "what is kept must be the head of the whole text");
});

void test("pdfExtract does not flag text that fits", async () => {
  const out = await pdfExtract(pdf, 10_000);
  assert.equal(out.truncated, false);
  assert.match(out.text, new RegExp(PDF_TEXT));
});

void test("pdfExtract refuses a file that is not a PDF", async () => {
  await assert.rejects(() => pdfExtract(notMedia, 10_000), ConversionError);
});

// --- the process wrapper ----------------------------------------------------------------------

void test("runTool kills a process that overruns its timeout", async () => {
  const started = Date.now();
  await assert.rejects(() => runTool("sleep", ["30"], 300), /timed out/);
  assert.ok(Date.now() - started < 10_000, "the timeout must fire rather than wait for the process");
});

void test("runTool names a binary that is not installed", async () => {
  await assert.rejects(() => runTool("whatsapp-mcp-no-such-binary", [], 5_000), /whatsapp-mcp-no-such-binary/);
});
