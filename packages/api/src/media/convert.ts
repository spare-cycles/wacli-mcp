/**
 * Turning an attachment into something a language model or an HTTP client can actually consume:
 * JPEG bytes and base64 image blocks, video keyframes, 16 kHz mono audio and PDF text.
 *
 * Nothing here touches Baileys, the database or the network — every function takes a path on disk
 * and either shells out to a system binary or works in-process with jimp. Two rules shape it:
 *
 * 1. **Every external process carries a timeout.** A malformed file can make ffmpeg spin forever,
 *    and an MCP tool call that never returns is worse than one that fails: the client has no way to
 *    tell the difference between "slow" and "wedged". `runTool` is the only spawn point.
 * 2. **Every size loop provably terminates.** `fitToCap` — the one shrink loop, shared by the
 *    single-image and the whole-strip conversions — halves the longest edge down to a floor and
 *    then stops, returning the smallest attempt rather than chasing a cap it cannot reach.
 */

import { execFile, type ExecFileException } from "node:child_process";
import { stat } from "node:fs/promises";
import { Jimp } from "jimp";
import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger.js";

export type ImageBlock = { data: string; mimeType: string };

export type Dimensions = { width: number; height: number };

/**
 * A JPEG as bytes, and the size those bytes actually are.
 *
 * `ImageBlock` is the MCP's shape: base64, and no dimensions. The REST layer reports the size of the
 * derivative next to it, and that size has to be the size of *these* bytes rather than of the source
 * file — anything the cap forced down has been downscaled since.
 */
export type JpegBytes = { bytes: Buffer; mimeType: "image/jpeg"; width: number; height: number };

/**
 * One sampled frame of a video, with what a caller needs to caption it.
 *
 * The SDK exports a `Keyframe` of the same name for the wire, carrying the same frame base64'd in
 * `data`. Same concept, deliberately the same word, and not the same type: this side produces bytes
 * and the route encodes them, so an auto-import that swaps one for the other will not compile.
 */
export type Keyframe = { index: number; atSec: number; bytes: Buffer; mimeType: "image/jpeg" };

/**
 * A whole strip, and the one size every frame in it has.
 *
 * `width`/`height` are the frames' size, not the video stream's, and they are returned here rather
 * than left to a separate `probeDimensions` call in the handler so that the strip and its reported
 * size cannot disagree. They would: ffmpeg applies a video's rotation matrix when it writes a frame
 * while ffprobe reports the coded size, so a portrait phone video comes out of `probeDimensions`
 * turned on its side — and a strip the cap forced down is smaller than either.
 */
export type KeyframeStrip = { durationSec: number; width: number; height: number; frames: Keyframe[] };

/** A PDF's text and whether `maxChars` cut it short. Structurally the SDK's `PdfExtract` wire shape. */
export type PdfExtract = { text: string; truncated: boolean };

/** A conversion could not be performed: a missing tool, a bad exit, a timeout, an undecodable file. */
export class ConversionError extends Error {
  override name = "ConversionError";
}

const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";
const PDFTOTEXT = "pdftotext";

const FFMPEG_TIMEOUT_MS = 60_000;
const FFPROBE_TIMEOUT_MS = 15_000;
const PDFTOTEXT_TIMEOUT_MS = 30_000;

/** Big enough for a full-resolution JPEG frame on stdout, small enough to bound a runaway process. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** How much of a failed tool's stderr goes into the error. Enough to diagnose, not enough to flood. */
const STDERR_TAIL_CHARS = 600;

const JPEG_MIME = "image/jpeg";
const HIGH_QUALITY = 80;
const LOW_QUALITY = 60;
/** The longest edge is never shrunk below this: past it a photo stops being readable at all. */
const MIN_EDGE_PX = 320;
/**
 * A hard ceiling on shrink passes. The loop already terminates on its own — each pass halves the
 * longest edge, so the floor is reached in log2(longest / 320) passes, about 17 for the largest
 * image any camera produces. This bound exists so that termination does not *depend* on that being
 * true: a future edit that breaks the halving turns into a fast, loud failure rather than a wedged
 * tool call. Verified by mutation — removing the resize without this makes the loop spin forever.
 */
const MAX_SHRINK_PASSES = 24;

/** Fraction of the running time skipped at each end when sampling keyframes. */
const KEYFRAME_MARGIN = 0.05;

/**
 * The most frames one strip may be asked for.
 *
 * Cost is linear in `count` on two axes and nothing else bounds either. **Time:** extraction is
 * sequential and each `extractFrame` carries its own 60 s `FFMPEG_TIMEOUT_MS`, so the per-process
 * timeout bounds a process and not a request — 16 frames is a 16-minute worst case, an unbounded
 * `count` is an unbounded one. **Memory:** when any frame overruns `maxBytes` the whole strip is
 * decoded at once, and a jimp bitmap is width x height x 4 — 33.2 MB for a 4K frame, 8.3 MB for
 * 1080p — so 16 frames is ~531 MB of 4K bitmaps resident, already as much as the NAS this deploys
 * to should be asked for. That path is not exotic either: `extractFrame` writes at `-q:v 4`, which
 * puts a 4K frame at 1.5-4 MB, so any `maxBytes` under that reaches it.
 *
 * 16 because `WHATSAPP_VIDEO_KEYFRAMES` is already clamped to `[1, 16]` in `config.ts`; a different
 * number here would mean one surface accepting what the other refuses. A refusal rather than a
 * clamp, because a clamp answers a request for 40 frames with 16 and no indication that it did.
 */
const MAX_KEYFRAMES = 16;

/**
 * What an external process left behind. Named for the process and not for the tool call: `ToolResult`
 * is `src/mcp/result.ts`'s MCP content-block envelope, and `src/mcp/tools/media.ts` imports from both
 * files — two exported types of the same name and no relation is one careless auto-import away from a
 * confusing compile error, or from none at all.
 */
export type ProcessOutput = { stdout: Buffer; stderr: string };

/** A jimp image, named off the factory so the enormous structural type never has to be written out. */
type Image = Awaited<ReturnType<typeof Jimp.read>>;

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= STDERR_TAIL_CHARS ? trimmed : `…${trimmed.slice(-STDERR_TAIL_CHARS)}`;
}

function toolFailure(bin: string, timeoutMs: number, err: ExecFileException, stderr: Buffer): ConversionError {
  // ENOENT here is the binary itself, not the input file: execFile could not spawn it at all. Naming
  // the binary is the whole value of this branch — it is what a runtime image built without ffmpeg
  // or poppler-utils will surface, and "spawn failed" would send the reader looking at the wrong
  // layer entirely.
  if (err.code === "ENOENT") {
    return new ConversionError(`${bin} is not installed or not on PATH, and this conversion needs it`);
  }
  if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new ConversionError(`${bin} produced more than ${MAX_OUTPUT_BYTES} bytes of output and was stopped`);
  }
  if (err.killed === true) {
    return new ConversionError(`${bin} timed out after ${timeoutMs}ms and was killed`);
  }
  const detail = tail(stderr.toString("utf8"));
  const status = typeof err.code === "number" ? `exit ${err.code}` : (err.signal ?? "unknown failure");
  return new ConversionError(`${bin} failed (${status})${detail === "" ? "" : `: ${detail}`}`);
}

/**
 * Run an external tool to completion, or fail loudly. The only place this module spawns anything.
 *
 * Exported because the timeout has no other observable trigger from outside — and because Task 11's
 * whisper.cpp invocation needs exactly this contract rather than a second copy of it.
 */
export function runTool(bin: string, args: readonly string[], timeoutMs: number): Promise<ProcessOutput> {
  return new Promise<ProcessOutput>((resolve, reject) => {
    execFile(
      bin,
      [...args],
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "buffer", killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        if (err !== null) {
          reject(toolFailure(bin, timeoutMs, err, stderr));
          return;
        }
        resolve({ stdout, stderr: stderr.toString("utf8") });
      },
    );
  });
}

/** The errno of whatever is wrong with `path` (`ENOENT`, `EACCES`, …), or undefined when it is fine. */
async function statusOfFile(path: string): Promise<string | undefined> {
  try {
    await stat(path);
    return undefined;
  } catch (err) {
    const code: unknown = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
    return typeof code === "string" ? code : "unreadable";
  }
}

function toBlock(jpeg: Buffer): ImageBlock {
  return { data: jpeg.toString("base64"), mimeType: JPEG_MIME };
}

async function encodeJpeg(img: Image, quality: number): Promise<Buffer> {
  return await img.getBuffer(JPEG_MIME, { quality });
}

/**
 * Decode an image, falling back to ffmpeg for anything jimp cannot read.
 *
 * jimp 1.6 ships BMP, GIF, JPEG, PNG and TIFF — and **not WebP**, which is the format every single
 * WhatsApp sticker arrives in. Without this fallback `whatsapp_download_media` would fail on every
 * sticker, so the one extra process is worth paying on the formats that need it.
 */
async function decodeImage(source: string | Buffer): Promise<Image> {
  try {
    return await Jimp.read(source);
  } catch {
    // Not a format jimp knows — or a file that is not there. jimp 1.6 cannot tell them apart *for*
    // us: every source failure arrives as the same bare `Error` ("Could not load Buffer from URL:
    // …"), with no `code`, no `cause` and nothing else to read, so the distinction is made below
    // rather than off the error. Fall through to ffmpeg, which reads far more formats.
  }
  // Only a file on disk can be handed to ffmpeg; in-memory sources here are frames ffmpeg itself
  // just produced, so a jimp failure on one of those is a real corruption rather than a format gap.
  if (typeof source !== "string") throw new ConversionError("the image data could not be decoded");

  // Before the spawn, not after it. An unreadable path costs an ffmpeg process for a failure that is
  // already decided — and on an image without ffmpeg installed it is then reported as "ffmpeg is not
  // installed or not on PATH", which sends whoever reads it to rebuild an image that was fine.
  const unreadable = await statusOfFile(source);
  if (unreadable !== undefined) {
    throw new ConversionError(`the file to decode could not be read (${unreadable}), so nothing can be made of it`);
  }

  const { stdout } = await runTool(
    FFMPEG,
    ["-v", "error", "-i", source, "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
    FFMPEG_TIMEOUT_MS,
  );
  try {
    return await Jimp.read(stdout);
  } catch {
    throw new ConversionError("the image could not be decoded even after transcoding it with ffmpeg");
  }
}

/**
 * One encode of every image at one quality: the bytes, the size none of them exceeds, and the
 * largest of them in bytes.
 */
type Attempt = { frames: [Buffer, ...Buffer[]]; width: number; height: number; worst: number };

/**
 * Encode every image at `quality`.
 *
 * `width`/`height` are the largest of each across the batch, so no frame exceeds them in either
 * dimension — and for a single image, or for a strip whose frames `fitStrip` has already proved to
 * share one size, that maximum *is* the size every buffer was made at. `worst` is the largest frame
 * in bytes, which is what the cap has to be judged against: a strip fits only when all of it fits.
 */
async function encodeAll(images: readonly [Image, ...Image[]], quality: number): Promise<Attempt> {
  const [head, ...rest] = images;
  const frames: [Buffer, ...Buffer[]] = [await encodeJpeg(head, quality)];
  for (const img of rest) frames.push(await encodeJpeg(img, quality));
  let worst = 0;
  for (const frame of frames) worst = Math.max(worst, frame.byteLength);
  let width = 0;
  let height = 0;
  for (const img of images) {
    width = Math.max(width, img.width);
    height = Math.max(height, img.height);
  }
  return { frames, width, height, worst };
}

/**
 * Encode `images` as the largest JPEGs that each fit `maxBytes`, shrinking until they do or can't.
 *
 * One loop for a single image and for a whole keyframe strip, because a strip is fitted as a unit:
 * every frame is resized by the same step and the attempt is judged by its largest frame, so the one
 * width and height the strip reports is true of every frame in it. Fitting each frame on its own
 * would let two frames of the same video end up at different sizes, and then at most one of them
 * matches what the strip claims.
 *
 * Termination: each pass that fails the cap brings every image whose longest edge exceeds `next`
 * down to `next`, so the batch's largest edge strictly decreases and reaches `MIN_EDGE_PX` in at
 * most log2(longest / 320) passes, at which point the loop breaks — and `MAX_SHRINK_PASSES` bounds
 * it regardless. Images that simply cannot be squeezed under a tiny cap therefore come back as the
 * smallest attempt: a warning and an oversized result beat an unbounded loop or an exception.
 * Downscaling only ever sets one edge, so the aspect ratio holds.
 */
async function fitToCap(images: readonly [Image, ...Image[]], maxBytes: number, log: Logger): Promise<Attempt> {
  // Seeded with the full-size, high-quality encode so "smallest so far" is never undefined.
  let smallest = await encodeAll(images, HIGH_QUALITY);
  if (smallest.worst <= maxBytes) return smallest;

  for (let pass = 0; pass < MAX_SHRINK_PASSES; pass += 1) {
    const lower = await encodeAll(images, LOW_QUALITY);
    if (lower.worst <= maxBytes) return lower;
    if (lower.worst < smallest.worst) smallest = lower;

    // The largest edge anywhere in the batch, not the head's: `Attempt` carries the maximum of each
    // dimension, and max(max w, max h) is exactly max over images of max(w, h). Shrinking by the
    // head while judging by the worst would leave a larger frame untouched for every pass.
    const longest = Math.max(lower.width, lower.height);
    if (longest <= MIN_EDGE_PX) break;
    const next = Math.max(MIN_EDGE_PX, Math.floor(longest / 2));
    for (const img of images) {
      // jimp's resize has no shrink-only guard (`@jimp/plugin-resize` does `w = Math.round(w) || 1`
      // unconditionally), so an image already at or under the target would be *upscaled* — bytes
      // spent inventing detail, the thing `imageJpeg`'s `maxEdge` goes out of its way to avoid.
      if (Math.max(img.width, img.height) <= next) continue;
      img.resize(img.width >= img.height ? { w: next } : { h: next });
    }

    const higher = await encodeAll(images, HIGH_QUALITY);
    if (higher.worst <= maxBytes) return higher;
    if (higher.worst < smallest.worst) smallest = higher;
  }

  log.warn(
    { bytes: smallest.worst, maxBytes, width: smallest.width, height: smallest.height },
    "media: image could not be brought under the size cap; returning the smallest attempt",
  );
  return smallest;
}

/** Re-encode an image file to a base64 JPEG at or under `maxBytes`, downscaling as needed. */
export async function imageBlock(path: string, maxBytes: number, log: Logger = defaultLogger): Promise<ImageBlock> {
  const { frames } = await fitToCap([await decodeImage(path)], maxBytes, log);
  return toBlock(frames[0]);
}

/**
 * Re-encode an image file to JPEG **bytes** at or under `maxBytes`, with the size they came out at.
 *
 * `maxEdge` is applied before the cap and only ever shrinks: an edge larger than the image already
 * has would upscale it, inventing detail and spending bytes to do it. It is a caller's deliberate
 * ceiling, so it is honoured below `MIN_EDGE_PX` too — that floor governs the automatic shrinking,
 * which then has nothing left to do and stops on its first pass. A `maxEdge` below one pixel, or one
 * that is not a finite number, is no ceiling at all and is ignored. Nothing arriving from a route
 * can be one — `MediaJpegQuery.maxEdge` is `intParam.positive()`, and `z.number().int()` refuses
 * Infinity and NaN — and jimp would not object either way: `@jimp/plugin-resize` validates with
 * `z.number().min(0)` and then clamps, `w = Math.round(w) || 1`, so a resize to zero silently yields
 * a one-pixel edge rather than an error. That same clamp is why an extreme aspect ratio is safe in
 * `fitToCap`: 4000x1 resized to `w: 320` comes back 320x1 instead of throwing on a zero height.
 */
export async function imageJpeg(
  path: string,
  opts: { maxBytes: number; maxEdge?: number },
  log: Logger = defaultLogger,
): Promise<JpegBytes> {
  const img = await decodeImage(path);
  const { maxEdge } = opts;
  if (maxEdge !== undefined && Number.isFinite(maxEdge) && maxEdge >= 1) {
    const edge = Math.floor(maxEdge);
    if (Math.max(img.width, img.height) > edge) {
      img.resize(img.width >= img.height ? { w: edge } : { h: edge });
    }
  }
  const { frames, width, height } = await fitToCap([img], opts.maxBytes, log);
  return { bytes: frames[0], mimeType: JPEG_MIME, width, height };
}

/**
 * The sample points for `count` keyframes across a clip of `duration` seconds.
 *
 * Exported for testing. The first and last 5% are skipped on purpose: the opening frame of a video
 * is very often black, a title card, or a fade, and the closing one just as often — sampling them
 * wastes half the budget on frames that say nothing about the content.
 */
export function keyframeTimestamps(duration: number, count: number): number[] {
  if (count <= 0) return [];
  const start = duration * KEYFRAME_MARGIN;
  const span = duration * (1 - 2 * KEYFRAME_MARGIN);
  if (count === 1) return [start + span / 2];
  return Array.from({ length: count }, (_, i) => start + (span * i) / (count - 1));
}

/**
 * One frame, as the JPEG ffmpeg itself wrote.
 *
 * `-ss` before `-i` seeks on the input, which is the fast path and still frame-accurate.
 */
async function extractFrame(path: string, at: number): Promise<Buffer> {
  const { stdout } = await runTool(
    FFMPEG,
    // prettier-ignore
    ["-v", "error", "-ss", at.toFixed(3), "-i", path, "-frames:v", "1", "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
    FFMPEG_TIMEOUT_MS,
  );
  if (stdout.byteLength === 0) {
    throw new ConversionError(`ffmpeg produced no frame at ${at.toFixed(3)}s of this video`);
  }
  return stdout;
}

/**
 * `count` evenly spaced frames as JPEG image blocks.
 *
 * Extractions run **sequentially**. Firing `count` ffmpeg processes at once on the NAS this deploys
 * to trades a small wall-clock win for a spike that starves the WhatsApp connection's event loop of
 * CPU, which is exactly the wrong trade for a background attachment read.
 */
export async function videoKeyframes(
  path: string,
  count: number,
  maxBytes: number,
  log: Logger = defaultLogger,
): Promise<ImageBlock[]> {
  if (count <= 0) return [];
  const duration = await probeDuration(path);
  if (duration === undefined) {
    throw new ConversionError("could not read a duration for this video, so no keyframes can be sampled from it");
  }

  const blocks: ImageBlock[] = [];
  for (const at of keyframeTimestamps(duration, count)) {
    const frame = await extractFrame(path, at);
    if (frame.byteLength <= maxBytes) {
      blocks.push(toBlock(frame));
      continue;
    }
    const { frames } = await fitToCap([await decodeImage(frame)], maxBytes, log);
    blocks.push(toBlock(frames[0]));
  }
  return blocks;
}

/** One extracted frame: the JPEG ffmpeg wrote, and the point in the clip it was sampled at. */
type Shot = { atSec: number; bytes: Buffer };

/**
 * The pixel size a JPEG declares in its frame header, read without decoding it.
 *
 * A strip has to know every frame's size before it can promise one, and learning it by decoding
 * would cost the common path a width x height x 4 bitmap per frame — the very allocation
 * `MAX_KEYFRAMES` exists to bound. Walking the marker segments to the SOF reaches it within a few
 * hundred bytes of a JPEG ffmpeg wrote and allocates nothing. The input is always ffmpeg's own
 * `-c:v mjpeg` output, so anything unreadable here is a broken toolchain and is reported as one.
 *
 * Termination: every branch advances `at` by at least one and the loop is bounded by the buffer.
 */
function jpegSize(jpeg: Buffer): Dimensions {
  if (jpeg.byteLength < 4 || jpeg.readUInt16BE(0) !== 0xffd8) {
    throw new ConversionError("this frame is not a JPEG, so the size of it cannot be read");
  }
  let at = 2;
  while (at + 1 < jpeg.byteLength) {
    // Segments are contiguous and each starts on 0xff; anything else means the stream is corrupt.
    if (jpeg.readUInt8(at) !== 0xff) break;
    const marker = jpeg.readUInt8(at + 1);
    // A repeated 0xff is fill, not a marker: step over one byte and read the next as the marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    at += 2;
    // TEM, RST0-7, SOI and EOI stand alone: no length field follows them.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    // Past the start of scan there is only entropy-coded data, and a frame header always precedes it.
    if (marker === 0xda) break;
    if (at + 1 >= jpeg.byteLength) break;
    // SOF0-SOF15, minus the three unrelated markers that share the range: DHT, JPG and DAC. The
    // payload is length(2), sample precision(1), height(2), width(2) — in that order.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 6 >= jpeg.byteLength) break;
      return { width: jpeg.readUInt16BE(at + 5), height: jpeg.readUInt16BE(at + 3) };
    }
    const length = jpeg.readUInt16BE(at);
    if (length < 2) break;
    at += length;
  }
  throw new ConversionError("this frame carries no JPEG frame header, so the size of it cannot be read");
}

/**
 * Bring a strip inside `maxBytes` at one shared size, and answer what that size is.
 *
 * Every frame's size is read from its header first, because `KeyframeStrip` promises one width and
 * one height for the whole strip and can only keep that promise if the frames agree. They normally
 * do — one video, one command, one filter chain — but a stream that changes resolution mid-file
 * (broadcast MPEG-TS, a concatenation of two encodes) hands each `-ss … -frames:v 1` a different
 * size, and for that there is no honest single number: the maximum describes no frame at all and
 * the first frame's describes only the first. So it is refused. Reporting a size that is wrong for
 * some of the frames is the one outcome a caller cannot detect, and refusing costs a header scan
 * per frame instead of the decode per frame that measuring honestly would take.
 *
 * With that settled the fast path decodes nothing: when ffmpeg's own frames are already inside the
 * cap they are passed through untouched, as `videoKeyframes` does. Overrunning the cap is what costs
 * a decode per frame, because a strip can only be resized as a unit if all of it is in memory at
 * once — the resident cost `MAX_KEYFRAMES` bounds.
 */
async function fitStrip(
  shots: readonly [Shot, ...Shot[]],
  maxBytes: number,
  log: Logger,
): Promise<{ width: number; height: number; frames: Buffer[] }> {
  const [head, ...rest] = shots;
  const size = jpegSize(head.bytes);
  for (const shot of rest) {
    const other = jpegSize(shot.bytes);
    if (other.width !== size.width || other.height !== size.height) {
      throw new ConversionError(
        `this video changes resolution mid-stream (${String(size.width)}x${String(size.height)} at ` +
          `${head.atSec.toFixed(3)}s, ${String(other.width)}x${String(other.height)} at ` +
          `${shot.atSec.toFixed(3)}s), and a keyframe strip reports one size for every frame in it`,
      );
    }
  }

  if (shots.every((shot) => shot.bytes.byteLength <= maxBytes)) {
    return { width: size.width, height: size.height, frames: shots.map((shot) => shot.bytes) };
  }

  const images: [Image, ...Image[]] = [await decodeImage(head.bytes)];
  for (const shot of rest) images.push(await decodeImage(shot.bytes));
  const { frames, width, height } = await fitToCap(images, maxBytes, log);
  return { width, height, frames };
}

/**
 * A keyframe strip as bytes: `count` evenly spaced frames, each labelled with its position in the
 * clip, plus the duration and the size the frames came out at.
 *
 * The labels come from `keyframeTimestamps`, the same helper that decides where to seek, rather than
 * from a second copy of the spacing rule — two spacings that disagreed would put a strip and its
 * captions out of step with nothing to catch it. Extraction is sequential for `videoKeyframes`'
 * reason, and the whole strip is then fitted to `maxBytes` as a unit so `width`/`height` describe
 * every frame rather than only the first.
 */
export async function keyframes(
  path: string,
  opts: { count: number; maxBytes: number },
  log: Logger = defaultLogger,
): Promise<KeyframeStrip> {
  // Before the probe, not after it. An unusable `count` is decided entirely by the arguments, so
  // spending an ffprobe on it buys nothing — and lets a duration failure report itself instead of
  // the real complaint when a caller gets both wrong at once. A strip reports one width and one
  // height, so with no frames there is nothing for them to describe; `MAX_KEYFRAMES` covers the
  // other end, and says there why it is a refusal rather than a silent clamp.
  const { count } = opts;
  if (!Number.isInteger(count) || count < 1 || count > MAX_KEYFRAMES) {
    throw new ConversionError(
      `a keyframe strip needs a whole number of frames between 1 and ${String(MAX_KEYFRAMES)}, ` +
        `and ${String(count)} was asked for`,
    );
  }

  const durationSec = await probeDuration(path);
  if (durationSec === undefined) {
    throw new ConversionError("could not read a duration for this video, so no keyframes can be sampled from it");
  }

  const [firstAt, ...restAt] = keyframeTimestamps(durationSec, count);
  // Unreachable: `count >= 1` above, so there is always a first sample point. The compiler cannot
  // see that, and the tuple below needs a head it can prove is there.
  if (firstAt === undefined) {
    throw new ConversionError("no sample points could be derived for this video");
  }

  const shots: [Shot, ...Shot[]] = [{ atSec: firstAt, bytes: await extractFrame(path, firstAt) }];
  for (const at of restAt) shots.push({ atSec: at, bytes: await extractFrame(path, at) });

  const fitted = await fitStrip(shots, opts.maxBytes, log);
  const frames: Keyframe[] = [];
  for (const [index, shot] of shots.entries()) {
    const bytes = fitted.frames[index];
    // The fitter answers one buffer per shot, in order. The compiler cannot see that, and a mismatch
    // would otherwise pair a frame with another frame's timestamp — silently, and forever.
    if (bytes === undefined) throw new ConversionError("a frame went missing while the strip was being resized");
    frames.push({ index, atSec: shot.atSec, bytes, mimeType: JPEG_MIME });
  }
  return { durationSec, width: fitted.width, height: fitted.height, frames };
}

/**
 * Re-encode any audio (including a video's audio track — hence `-vn`) as 16 kHz mono Opus.
 *
 * Opus rather than the 16 kHz PCM WAV this used to produce, because the audio no longer stays on
 * this machine: it is base64'd into a JSON request against a 10 MB cap. WAV would inflate a
 * two-minute recording to roughly 3.8 MB before encoding and 5 MB after, where 24 kbps Opus is
 * about 360 kB — the difference between comfortably inside the cap and refused by it.
 *
 * **A WhatsApp voice note never reaches here.** It already arrives as ~16 kbps mono Ogg/Opus, so
 * re-encoding it would spend a process to make it very slightly worse; `transcribe.ts` sends those
 * bytes through untouched. This is for a video's audio track, or an audio file large enough to
 * threaten the cap on its own.
 */
export async function toOpus16k(path: string, outPath: string): Promise<void> {
  await runTool(
    FFMPEG,
    // 24 kbps is above WhatsApp's own 16 kbps and well past the point where speech recognition
    // stops caring; the ceiling here is the request limit, not fidelity.
    ["-v", "error", "-y", "-i", path, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "libopus", "-b:a", "24k", outPath],
    FFMPEG_TIMEOUT_MS,
  );
}

/** Duration in seconds, or undefined when the container declares none (a raw stream, say). */
export async function probeDuration(path: string): Promise<number | undefined> {
  const { stdout } = await runTool(
    FFPROBE,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
    FFPROBE_TIMEOUT_MS,
  );
  const seconds = Number(stdout.toString("utf8").trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * The pixel size of an image or of a video's first video stream, or undefined when it declares none.
 *
 * Added for `whatsapp_download_media`, which reports what the model is looking at. ffprobe rather than
 * jimp because it answers for every format in one place — a WebP sticker included, which jimp cannot
 * decode at all — and because the video branch needs exactly the same answer, where there is no
 * decoded image to ask.
 */
export async function probeDimensions(path: string): Promise<Dimensions | undefined> {
  const { stdout } = await runTool(
    FFPROBE,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path],
    FFPROBE_TIMEOUT_MS,
  );
  // A file with no video stream at all — an audio-only container — prints nothing rather than
  // failing, so "no dimensions" arrives here as an empty line, not as an error.
  const [width, height] = stdout.toString("utf8").trim().split("x").map(Number);
  if (width === undefined || height === undefined) return undefined;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return undefined;
  return { width, height };
}

/**
 * The whole text of a PDF, with the page separators turned into newlines.
 *
 * `pdftotext` comes from **poppler-utils**, which the runtime image must install; when it is
 * missing the error names the binary, because that is the only clue a misbuilt image gives.
 */
async function readPdfText(path: string): Promise<string> {
  const { stdout } = await runTool(PDFTOTEXT, ["-enc", "UTF-8", path, "-"], PDFTOTEXT_TIMEOUT_MS);
  // pdftotext separates pages with a form feed, which is noise in a chat transcript.
  return stdout.toString("utf8").replace(/\f/g, "\n").trim();
}

/** The text of a PDF, capped at `maxChars`. */
export async function pdfText(path: string, maxChars: number): Promise<string> {
  const text = await readPdfText(path);
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/**
 * `text` cut to at most `maxChars`, never through a surrogate pair.
 *
 * Exported for testing: reaching this boundary through a PDF fixture would take an astral character,
 * which needs a CID font that nothing in the toolchain produces, and the rule is worth pinning
 * directly in any case. `String.prototype.slice` counts UTF-16 code units, so a cut landing between
 * a high and a low surrogate leaves an unpaired high surrogate behind and the client renders U+FFFD
 * where a character used to be. Dropping the orphan costs one unit out of `maxChars`, and only on
 * the boundaries that would otherwise be broken. `truncated` is decided before the cut, so it is
 * right either way. `pdfText` keeps the raw slice: it is the in-process MCP's path and Task 16 has
 * not moved it yet, so its output stays byte-for-byte what it has always been.
 */
export function cutToChars(text: string, maxChars: number): PdfExtract {
  if (text.length <= maxChars) return { text, truncated: false };
  const cap = Math.max(0, Math.floor(maxChars));
  // A high surrogate sitting on the cut has its low partner on the far side of it.
  const lastUnit = cap > 0 ? text.charCodeAt(cap - 1) : 0;
  const end = lastUnit >= 0xd800 && lastUnit <= 0xdbff ? cap - 1 : cap;
  return { text: text.slice(0, end), truncated: true };
}

/**
 * The text of a PDF, capped at `maxChars`, saying whether the cap cut anything off.
 *
 * `pdfText` truncates silently, which is fine for a model reading a summary into a prompt and wrong
 * for an API: a client that cannot tell a whole document from the first paragraph of one has no way
 * to know it should ask for more, and no way to say so to whoever is reading its answer.
 */
export async function pdfExtract(path: string, maxChars: number): Promise<PdfExtract> {
  return cutToChars(await readPdfText(path), maxChars);
}
