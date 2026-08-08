/**
 * The media representations, one schema per JSON response.
 *
 * The casing looks inconsistent and is not: `mimeType` is the derivative's own type, in the shape an
 * MCP image block already uses, while `mimetype` is the field name carried by the stored
 * `MediaFile` and reported to the model today. Renaming either would change tool output.
 */

import { z } from "zod";

import { epochSeconds } from "./common.js";

/**
 * Which representation of an attachment is meant.
 *
 * No longer a query parameter — each representation is its own route, because one route whose
 * response is `JsonResponse | BinaryResponse` types as `never`. It survives as a value because a
 * signed download token still has to say what it points at.
 */
export const MediaRepresentation = z.enum(["raw", "jpeg", "link", "keyframes", "text", "transcript", "meta"]);

export type MediaRepresentation = z.infer<typeof MediaRepresentation>;

/**
 * The **original** attachment's size and type, carried alongside every derivative.
 *
 * A binary response would report only the derivative's bytes and mime type, and today's
 * `whatsapp_download_media` summary reports the source's on every branch. Embedding it here keeps
 * that summary reproducible in one round trip instead of a second `/meta` call.
 */
export const MediaSource = z.object({ bytes: z.number().int(), mimetype: z.string() });

export type MediaSource = z.infer<typeof MediaSource>;

/** `GET /v1/media/:chat/:id/jpeg` — base64 rather than binary, so `source` can ride along. */
export const JpegDerivative = z.object({
  data: z.string(),
  mimeType: z.string(),
  // Positive rather than merely integral: an image with a zero edge is not an image, and this
  // schema is the only thing between a size the API measured wrongly and a client that believes it.
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  source: MediaSource,
});

export type JpegDerivative = z.infer<typeof JpegDerivative>;

export const Keyframe = z.object({
  index: z.number().int(),
  atSec: z.number(),
  mimeType: z.string(),
  data: z.string(),
});

export type Keyframe = z.infer<typeof Keyframe>;

/**
 * `GET /v1/media/:chat/:id/keyframes` — frames inline, base64.
 *
 * Not N sub-URLs: the MCP's terminal use *is* base64 image blocks, so any other encoding is a
 * decode-then-re-encode, and a UI renders `data:` URLs directly either way.
 */
export const KeyframeStrip = z.object({
  durationSec: z.number(),
  // Positive for `JpegDerivative`'s reason, with more riding on it: these two numbers describe
  // every frame in the strip at once, so a zero here would call a strip of real frames empty.
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frames: z.array(Keyframe),
  source: MediaSource,
});

export type KeyframeStrip = z.infer<typeof KeyframeStrip>;

/**
 * `GET /v1/media/:chat/:id/link` — a URL to the unauthenticated signed download.
 *
 * `expiresAt` is integer Unix seconds, like every other timestamp in the contract, and uses the
 * shared `epochSeconds` so a milliseconds deadline is refused rather than granting a link a
 * thousand-fold longer life than it was signed for.
 */
export const MediaLink = z.object({
  url: z.string(),
  expiresAt: epochSeconds,
  mimeType: z.string(),
  bytes: z.number().int(),
  filename: z.string(),
});

export type MediaLink = z.infer<typeof MediaLink>;

/** `GET /v1/media/:chat/:id/text` — a PDF's extracted text, and whether it was cut short. */
export const PdfExtract = z.object({ text: z.string(), truncated: z.boolean() });

export type PdfExtract = z.infer<typeof PdfExtract>;

/**
 * A transcript that exists.
 *
 * Factored out of `MediaTranscript` because `POST /v1/messages/:chat/:id/transcribe` answers the
 * same three fields and cannot answer `null` — it either produced speech or it threw. Declaring the
 * object once means the read path and the write path cannot disagree about what a transcript is.
 */
export const Transcript = z.object({ text: z.string(), model: z.string(), language: z.string().nullable() });

export type Transcript = z.infer<typeof Transcript>;

/**
 * `GET /v1/media/:chat/:id/transcript` — the cached transcript, or `null` when there is none.
 *
 * Reads the cache and never spends money: triggering transcription is a separate write route. That
 * is what preserves the two-lane rule, since the lane is a property of the call site.
 */
export const MediaTranscript = Transcript.nullable();

export type MediaTranscript = z.infer<typeof MediaTranscript>;

/** `GET /v1/media/:chat/:id/meta` — everything about the attachment that is not the bytes. */
export const MediaMeta = z.object({
  mimetype: z.string(),
  bytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationSec: z.number().nullable(),
  hasTranscript: z.boolean(),
  sha256: z.string(),
});

export type MediaMeta = z.infer<typeof MediaMeta>;
