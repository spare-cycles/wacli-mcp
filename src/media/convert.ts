/**
 * Turning an attachment into something a language model can actually consume: JPEG image blocks,
 * video keyframes, 16 kHz mono audio and PDF text.
 *
 * Nothing here touches Baileys, the database or the network — every function takes a path on disk
 * and either shells out to a system binary or works in-process with jimp. Two rules shape it:
 *
 * 1. **Every external process carries a timeout.** A malformed file can make ffmpeg spin forever,
 *    and an MCP tool call that never returns is worse than one that fails: the client has no way to
 *    tell the difference between "slow" and "wedged". `runTool` is the only spawn point.
 * 2. **Every size loop provably terminates.** `imageBlock` halves the longest edge down to a floor
 *    and then stops, returning the smallest attempt rather than chasing a cap it cannot reach.
 */

import { execFile, type ExecFileException } from "node:child_process";
import { Jimp } from "jimp";
import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger.js";

export type ImageBlock = { data: string; mimeType: string };

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

export type ToolResult = { stdout: Buffer; stderr: string };

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
export function runTool(bin: string, args: readonly string[], timeoutMs: number): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve, reject) => {
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
 * WhatsApp sticker arrives in. Without this fallback `wa_download_media` would fail on every
 * sticker, so the one extra process is worth paying on the formats that need it.
 */
async function decodeImage(source: string | Buffer): Promise<Image> {
  try {
    return await Jimp.read(source);
  } catch {
    // Not a format jimp knows. Fall through to ffmpeg, which reads far more of them.
  }
  // Only a file on disk can be handed to ffmpeg; in-memory sources here are frames ffmpeg itself
  // just produced, so a jimp failure on one of those is a real corruption rather than a format gap.
  if (typeof source !== "string") throw new ConversionError("the image data could not be decoded");

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
 * Encode `img` as the largest JPEG that fits `maxBytes`, shrinking until it does or until it can't.
 *
 * Termination: each pass that fails the cap halves the longest edge, so `longest` strictly decreases
 * and reaches `MIN_EDGE_PX` in at most log2(longest / 320) passes, at which point the loop breaks —
 * and `MAX_SHRINK_PASSES` bounds it regardless. An image that simply cannot be squeezed under a tiny
 * cap therefore returns the smallest attempt: a warning and an oversized block beat an unbounded
 * loop or an exception. Downscaling only ever sets one edge, so the aspect ratio is preserved.
 */
async function fitToCap(img: Image, maxBytes: number, log: Logger): Promise<ImageBlock> {
  // Seeded with the full-size, high-quality encode so "smallest so far" is never undefined.
  let smallest = await encodeJpeg(img, HIGH_QUALITY);
  if (smallest.byteLength <= maxBytes) return toBlock(smallest);

  for (let pass = 0; pass < MAX_SHRINK_PASSES; pass += 1) {
    const lower = await encodeJpeg(img, LOW_QUALITY);
    if (lower.byteLength <= maxBytes) return toBlock(lower);
    if (lower.byteLength < smallest.byteLength) smallest = lower;

    const longest = Math.max(img.width, img.height);
    if (longest <= MIN_EDGE_PX) break;
    const next = Math.max(MIN_EDGE_PX, Math.floor(longest / 2));
    img.resize(img.width >= img.height ? { w: next } : { h: next });

    const higher = await encodeJpeg(img, HIGH_QUALITY);
    if (higher.byteLength <= maxBytes) return toBlock(higher);
    if (higher.byteLength < smallest.byteLength) smallest = higher;
  }

  log.warn(
    { bytes: smallest.byteLength, maxBytes, width: img.width, height: img.height },
    "media: image could not be brought under the size cap; returning the smallest attempt",
  );
  return toBlock(smallest);
}

/** Re-encode an image file to a base64 JPEG at or under `maxBytes`, downscaling as needed. */
export async function imageBlock(path: string, maxBytes: number, log: Logger = defaultLogger): Promise<ImageBlock> {
  return await fitToCap(await decodeImage(path), maxBytes, log);
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
    // `-ss` before `-i` seeks on the input, which is the fast path and still frame-accurate.
    const { stdout } = await runTool(
      FFMPEG,
      // prettier-ignore
      ["-v", "error", "-ss", at.toFixed(3), "-i", path, "-frames:v", "1", "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
      FFMPEG_TIMEOUT_MS,
    );
    if (stdout.byteLength === 0) {
      throw new ConversionError(`ffmpeg produced no frame at ${at.toFixed(3)}s of this video`);
    }
    blocks.push(
      stdout.byteLength <= maxBytes ? toBlock(stdout) : await fitToCap(await decodeImage(stdout), maxBytes, log),
    );
  }
  return blocks;
}

/**
 * Re-encode any audio (including a video's audio track — hence `-vn`) as 16 kHz mono PCM, the only
 * input format whisper.cpp accepts.
 */
export async function toWav16k(path: string, outPath: string): Promise<void> {
  await runTool(
    FFMPEG,
    ["-v", "error", "-y", "-i", path, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outPath],
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
 * The text of a PDF, capped at `maxChars`.
 *
 * `pdftotext` comes from **poppler-utils**, which the runtime image must install; when it is
 * missing the error names the binary, because that is the only clue a misbuilt image gives.
 */
export async function pdfText(path: string, maxChars: number): Promise<string> {
  const { stdout } = await runTool(PDFTOTEXT, ["-enc", "UTF-8", path, "-"], PDFTOTEXT_TIMEOUT_MS);
  // pdftotext separates pages with a form feed, which is noise in a chat transcript.
  const text = stdout.toString("utf8").replace(/\f/g, "\n").trim();
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}
