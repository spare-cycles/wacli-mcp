/**
 * The seven media representations, plus the unauthenticated signed download.
 *
 * One route per representation rather than one `?as=` endpoint, for the typing reason the route
 * table gives: a route whose `response` were a union makes `HandlerResult` evaluate to `never`.
 * What that buys here is that each handler below has exactly one return shape and no caller
 * narrows anything.
 *
 * **This module owns the response-layer security, because this is where the response exists.**
 *
 * 1. `X-Content-Type-Options: nosniff` is set for every response by `rest/server.ts` — the header
 *    has to be written where the response is written, and a `BinaryPayload` carries no headers.
 * 2. The **inline allowlist** below is a literal set, never a prefix test over `image/`. The
 *    obvious predicate lets `image/svg+xml` through, and an SVG is a script-bearing document:
 *    served inline from an unauthenticated URL it is stored XSS against whoever opens the link.
 *    Everything off the list is forced to `attachment`, which overrides `?disposition=inline` — a
 *    caller cannot opt back in.
 * 3. `/media/dl/:token` is rate-limited per token, and every hit writes one redacted access record.
 *
 * **The mimetype is sender-chosen and it reaches a response header.** `media/store.ts` reads
 * `body.mimetype` verbatim out of the WhatsApp protobuf and only checks it is non-empty, and the
 * token's `m` field is a bare `z.string()`, so encrypting it *launders* it — a reader sees a value
 * the token vouches for. `safeContentType` is what stops that: anything that is not a bare
 * `type/subtype` of RFC 9110 token characters becomes `application/octet-stream`, so a CRLF cannot
 * split a header and a `text/html` cannot be rendered (the allowlist above already forces it to
 * `attachment`, and `nosniff` stops a browser second-guessing that).
 *
 * **The filename in a download is derived from the content hash, not from the sender.** Nothing in
 * the store carries a sender-declared filename — `MessageRow` has no column for one and `MediaFile`
 * is `{ path, sha256, bytes, mimetype }` — and this layer may not decode a protobuf to go looking
 * (Global Constraint 12: a handler reaches only for what it is handed). `boundFilename` is applied
 * anyway, because Task 6's carry-forward is about the *path* a name takes to `mint`, and the day
 * `MediaFile` grows a `fileName` the bound is already in front of it.
 */

import { readFile } from "node:fs/promises";
import {
  NotFoundError,
  UnsupportedMediaError,
  ApiError,
  type BinaryPayload,
  type Handlers,
  type Keyframe,
  type LinkTarget,
  type MediaSource,
} from "whatsapp-api-sdk";

import type { MessageRow } from "../../db/messages.js";
import { imageJpeg, keyframes, pdfExtract, probeDimensions, probeDuration } from "../../media/convert.js";
import type { MediaFile } from "../../media/store.js";
import { errorDetail } from "../errors.js";
import type { LinkPayload } from "../medialink.js";
import type { RestDeps } from "../server.js";
import { requireRow, transcriptOf } from "./subject.js";

/** The slice of the handler map this module owns. */
export type MediaHandlers = Pick<
  Handlers,
  | "fetchMedia"
  | "fetchMediaJpeg"
  | "fetchMediaLink"
  | "fetchMediaKeyframes"
  | "fetchMediaText"
  | "fetchMediaTranscript"
  | "fetchMediaMeta"
  | "fetchSignedMedia"
>;

/** What every per-message media route resolves first: the row it is about, and the file behind it. */
type Subject = { row: MessageRow; file: MediaFile };

const JPEG = "image/jpeg";
const PDF = "application/pdf";
const OCTET_STREAM = "application/octet-stream";

/** `GET /media/dl/:token`'s prefix. Not under `/v1`, so no `:chat` pattern can shadow it. */
const DOWNLOAD_PATH = "/media/dl";

/**
 * How many times one signed link may be redeemed before it is refused, whatever its remaining TTL.
 *
 * Defence in depth on a URL that is a bearer capability for one attachment: a link forwarded into a
 * group chat, a crawler following it, or a leaked log line all stop costing bytes at some point.
 * The counter is in memory and resets on restart, which is acceptable for something that expires in
 * fifteen minutes anyway — a persistent store would be a new failure mode for a secondary defence.
 */
const MAX_FETCHES_PER_TOKEN = 20;

/**
 * The longest download filename this API will mint into a token, in UTF-8 bytes.
 *
 * The token carries the name, so token length is filename length plus overhead — and `verify` has
 * no length cap of its own, leaving Node's 16 KB `maxHeaderSize` as the only ceiling, which is a
 * coincidence rather than a decision. 128 is well inside every filesystem's 255-byte component
 * limit and keeps a token comfortably short. Truncated rather than refused: a name too long is not
 * a reason to withhold the bytes.
 *
 * A known and accepted side channel rides along: token length still varies with name length, which
 * is observable on an unauthenticated URL. Padding was out of scope; this is the carry-forward
 * stated in the open rather than a hole nobody wrote down.
 */
const MAX_FILENAME_BYTES = 128;

/**
 * Which content types may be served `inline`: a literal table, plus the two families whose every
 * member a browser treats as media rather than as a document.
 *
 * Written this way on purpose. `mimetype.startsWith("image/")` reads as equivalent and admits
 * `image/svg+xml`, which carries script and renders as a document — from an unauthenticated URL
 * that is stored XSS. `audio/` and `video/` are prefixes because they have to be (there is no short
 * list of audio subtypes) and because neither family has a scriptable member the way `image/` does.
 *
 * Read with `=== true` rather than for truthiness: a lookup of `__proto__` on a plain object finds
 * `Object.prototype`, which is an object and therefore truthy, and a sender chooses this string.
 */
const INLINE_TYPES: Readonly<Record<string, true>> = {
  [JPEG]: true,
  "image/png": true,
  "image/gif": true,
  "image/webp": true,
  [PDF]: true,
};
const INLINE_FAMILIES = ["audio/", "video/"] as const;

/** RFC 9110 `token`, twice, with a `/` between: the only shape allowed into a content-type header. */
const CONTENT_TYPE = /^[!#$%&'*+.^_`|~a-z0-9-]+\/[!#$%&'*+.^_`|~a-z0-9-]+$/;

const utf8 = new TextEncoder();

/**
 * A sender-chosen mimetype, reduced to something safe to put in a header.
 *
 * Parameters are dropped (`audio/ogg; codecs=opus` becomes `audio/ogg`) and anything that is not a
 * bare `type/subtype` becomes `application/octet-stream`. That is what makes header injection
 * unexpressible rather than merely unlikely: a CRLF, a quote or a space has nowhere to live.
 */
export function safeContentType(raw: string): string {
  const bare = (raw.split(";")[0] ?? "").trim().toLowerCase();
  return CONTENT_TYPE.test(bare) ? bare : OCTET_STREAM;
}

/**
 * What a caller asked for, filtered through the allowlist. Anything unlisted downloads.
 *
 * `contentType` must already have been through `safeContentType`, or the comparison is against a
 * string a sender chose the punctuation of.
 */
function dispositionFor(requested: "inline" | "attachment", contentType: string): "inline" | "attachment" {
  if (requested !== "inline") return "attachment";
  if (INLINE_TYPES[contentType] === true) return "inline";
  return INLINE_FAMILIES.some((family) => contentType.startsWith(family)) ? "inline" : "attachment";
}

/**
 * A filename cut to `MAX_FILENAME_BYTES`, keeping the extension.
 *
 * The cut walks code points rather than UTF-16 units, so it never leaves half a surrogate pair
 * behind. Every name this module currently produces is short ASCII; the bound is here for the name
 * that will one day come from a sender.
 */
export function boundFilename(name: string): string {
  if (utf8.encode(name).length <= MAX_FILENAME_BYTES) return name;
  const dot = name.lastIndexOf(".");
  // An "extension" longer than 16 bytes, or one containing a path separator, is not an extension.
  const extension = dot > 0 && name.length - dot <= 16 && !/[/\\]/.test(name.slice(dot)) ? name.slice(dot) : "";
  const budget = MAX_FILENAME_BYTES - utf8.encode(extension).length;
  let stem = "";
  let used = 0;
  for (const point of name.slice(0, dot > 0 ? dot : undefined)) {
    const size = utf8.encode(point).length;
    if (used + size > budget) break;
    stem += point;
    used += size;
  }
  return stem + extension;
}

/**
 * The extension for a content type, where guessing wrong would be worse than guessing nothing.
 *
 * Only the cases where the subtype is not already the extension. Everything else falls through to
 * the subtype itself, and anything that does not look like an extension gets none at all.
 */
const EXTENSION: Readonly<Record<string, string>> = { [JPEG]: "jpg", "audio/mpeg": "mp3", [OCTET_STREAM]: "bin" };

/**
 * The name a download is offered under: twelve hex characters of the content hash, plus an
 * extension read off the content type.
 *
 * Content-addressed for the reason the token is — a name is a place a chat id or a person's name
 * would otherwise end up, and this URL exists to be shared. See the module header for why the
 * sender's own filename is not available to use instead.
 */
function downloadName(sha256: string, contentType: string): string {
  const subtype = (contentType.split("/")[1] ?? "").split("+")[0] ?? "";
  const extension = EXTENSION[contentType] ?? (/^[a-z0-9]{1,8}$/.test(subtype) ? subtype : "");
  return boundFilename(`${sha256.slice(0, 12)}${extension === "" ? "" : `.${extension}`}`);
}

/** A caller's ceiling, never above the deployment's. Absent means the deployment's. */
function bounded(asked: number | undefined, ceiling: number): number {
  return asked === undefined ? ceiling : Math.min(asked, ceiling);
}

export function mediaHandlers(deps: RestDeps): MediaHandlers {
  const { config, logger, media, links } = deps;

  /**
   * Metadata about a file, best-effort.
   *
   * A probe failure — no ffprobe in the image, a container it cannot parse — must not sink the
   * call: the size and the type are the payload and the dimensions are a caption on them. The
   * error's *fields*, never the error, for `errorDetail`'s reason.
   */
  const probed = async <T>(what: string, probe: () => Promise<T | undefined>): Promise<T | undefined> => {
    try {
      return await probe();
    } catch (err) {
      logger.warn({ ...errorDetail(err), what }, "media: could not read this property of an attachment");
      return undefined;
    }
  };

  /** The row and the resolved attachment. A cache miss reaches the socket; `MediaStore` decides. */
  const subject = async (chat: string, id: string): Promise<Subject> => {
    const row = requireRow(deps, chat, id);
    return { row, file: await media.fetch(row.chatId, row.id) };
  };

  /**
   * Refuse an attachment that can never become what was asked for, before a tool is spawned.
   *
   * `media/convert.ts` says exactly this is the handler's job: ffmpeg refusing a PDF and ffmpeg
   * built without a codec are the same exit status and the same class of stderr, so the module
   * reports both as `internal`/500. Here the stored mimetype is already known, so a wrong
   * attachment is an honest 415 that no retry will change.
   */
  const requireType = (file: MediaFile, wanted: string, representation: string): void => {
    const type = safeContentType(file.mimetype);
    if (wanted.endsWith("/") ? type.startsWith(wanted) : type === wanted) return;
    throw new UnsupportedMediaError(
      `this attachment is ${type}, and ${representation} can only be produced from ${wanted}${wanted.endsWith("/") ? "*" : ""}`,
    );
  };

  const sourceOf = (file: MediaFile): MediaSource => ({ bytes: file.bytes, mimetype: file.mimetype });

  /**
   * The bytes of a cached file.
   *
   * ENOENT here is the media cache having lost a file the row still points at — the same condition
   * `media/convert.ts` calls `source-missing` and answers 404 with. Without the mapping it would be
   * a bare `Error` and therefore a 500, which asks for a retry of something no retry can fix.
   */
  const readCached = async (path: string): Promise<Buffer> => {
    try {
      return await readFile(path);
    } catch (err) {
      const code: unknown = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      throw new NotFoundError("the bytes of this attachment are no longer in the media cache");
    }
  };

  // --- the signed download's two in-memory guards -----------------------------------------------

  /** Redemptions per token, keyed on the canonical token string `verify` guarantees. */
  const fetches = new Map<string, { count: number; expiresAt: number }>();
  let lastSweep = 0;

  /**
   * Drop the buckets of tokens that have expired, at most once per TTL window.
   *
   * Lazy rather than on a `setInterval`, and that is the whole reason it is written out: a timer
   * would have to be created here and disposed somewhere, and `mediaHandlers` has no lifetime — it
   * is a plain record of closures. A stale bucket is only memory, never an extra fetch, because
   * `verify` refuses an expired token before the counter is ever consulted.
   */
  const sweep = (now: number): void => {
    if (now - lastSweep < config.mediaLinkTtlSec) return;
    lastSweep = now;
    for (const [token, bucket] of fetches) if (bucket.expiresAt <= now) fetches.delete(token);
  };

  /**
   * One redacted line per hit on the signed download.
   *
   * Eight hex characters of the content hash, the representation, the outcome and the time. Never
   * the token — it is a credential — never the URL, which contains it, and never the chat: the
   * token deliberately carries no chat id, and reintroducing one in a log line would undo that.
   */
  const logAccess = (payload: LinkPayload | undefined, outcome: string, at: number): void => {
    logger.info(
      {
        sha256Prefix: payload === undefined ? null : payload.s.slice(0, 8),
        representation: payload?.r ?? null,
        outcome,
        at,
      },
      "media: signed download",
    );
  };

  return {
    /**
     * The original bytes. `?disposition` is a request; the allowlist above is the answer.
     *
     * Defaults to `inline` so a link works in an `<img>` without a query parameter, which is what
     * makes the allowlist load-bearing rather than decorative.
     */
    fetchMedia: async ({ params, query }): Promise<BinaryPayload> => {
      const { file } = await subject(params.chat, params.id);
      const mimeType = safeContentType(file.mimetype);
      return {
        bytes: await readCached(file.path),
        mimeType,
        filename: downloadName(file.sha256, mimeType),
        disposition: dispositionFor(query.disposition ?? "inline", mimeType),
      };
    },

    /**
     * JSON with base64 bytes rather than a binary response, so `source` — the *original*
     * attachment's size and mimetype — can ride along. Today's download summary reports those on
     * every branch and a binary response carries nothing but the derivative.
     */
    fetchMediaJpeg: async ({ params, query }) => {
      const { file } = await subject(params.chat, params.id);
      requireType(file, "image/", "a JPEG derivative");
      const jpeg = await imageJpeg(
        file.path,
        {
          maxBytes: bounded(query.maxBytes, config.maxImageBytes),
          // `maxEdge` has no configured counterpart to be bounded by, and it only ever shrinks:
          // asking for an edge larger than the image has is a no-op rather than an upscale.
          ...(query.maxEdge === undefined ? {} : { maxEdge: query.maxEdge }),
        },
        logger,
      );
      return {
        data: jpeg.bytes.toString("base64"),
        mimeType: jpeg.mimeType,
        width: jpeg.width,
        height: jpeg.height,
        source: sourceOf(file),
      };
    },

    /**
     * Mint a signed URL, having first resolved the attachment — so a link that cannot be produced
     * fails in front of its author rather than 404-ing for whoever it was sent to. For `for=jpeg`
     * that means converting now as well, which is also where `bytes` comes from.
     *
     * `?for=` is parsed against the two-value enum by `implement()` before this runs, so `mint`
     * never sees an unvalidated query value — Task 6's second carry-forward, satisfied structurally
     * by the route table rather than by a check here that could be forgotten.
     *
     * The URL is a **relative reference**. The API cannot know its own public origin: `PORT` is a
     * container port, and the `Host` header is caller-controlled, so building an absolute URL from
     * it would let a caller choose the origin of a capability URL. Every consumer already has the
     * base — the SDK client its `baseUrl`, the MCP its `apiUrl`, a browser the page it is on.
     */
    fetchMediaLink: async ({ params, query }) => {
      const { file } = await subject(params.chat, params.id);
      const target: LinkTarget = query.for ?? "raw";
      let mimeType = safeContentType(file.mimetype);
      let bytes = file.bytes;
      if (target === "jpeg") {
        requireType(file, "image/", "a JPEG derivative");
        const jpeg = await imageJpeg(file.path, { maxBytes: config.maxImageBytes }, logger);
        mimeType = jpeg.mimeType;
        bytes = jpeg.bytes.byteLength;
      }
      const filename = downloadName(file.sha256, mimeType);
      const { token, expiresAt } = links.mint({ s: file.sha256, r: target, m: mimeType, f: filename });
      return { url: `${DOWNLOAD_PATH}/${token}`, expiresAt, mimeType, bytes, filename };
    },

    fetchMediaKeyframes: async ({ params, query }) => {
      const { file } = await subject(params.chat, params.id);
      requireType(file, "video/", "a keyframe strip");
      const strip = await keyframes(
        file.path,
        {
          count: bounded(query.frames, config.videoKeyframes),
          maxBytes: bounded(query.maxBytes, config.maxImageBytes),
        },
        logger,
      );
      return {
        durationSec: strip.durationSec,
        width: strip.width,
        height: strip.height,
        frames: strip.frames.map((frame): Keyframe => ({
          index: frame.index,
          atSec: frame.atSec,
          mimeType: frame.mimeType,
          data: frame.bytes.toString("base64"),
        })),
        source: sourceOf(file),
      };
    },

    fetchMediaText: async ({ params }) => {
      const { file } = await subject(params.chat, params.id);
      requireType(file, PDF, "extracted text");
      return await pdfExtract(file.path, config.maxResultChars);
    },

    /**
     * Cache only, and never spends money — it does not even resolve the attachment, because the
     * transcript is a column on the row. Triggering transcription is `POST …/transcribe`, which is
     * what preserves the two-lane rule: the lane is a property of the call site.
     */
    fetchMediaTranscript: ({ params }) => Promise.resolve(transcriptOf(requireRow(deps, params.chat, params.id))),

    fetchMediaMeta: async ({ params }) => {
      const { row, file } = await subject(params.chat, params.id);
      const dimensions = await probed("dimensions", () => probeDimensions(file.path));
      const duration = await probed("duration", () => probeDuration(file.path));
      return {
        // The stored value, not the header-safe one: this field is data a client reads, not a
        // header a browser acts on, and reporting a laundered type would hide what is really there.
        mimetype: file.mimetype,
        bytes: file.bytes,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        // Rounded, as today's `duration_sec` is: a duration to a tenth of a second tells nobody
        // anything extra.
        durationSec: duration === undefined ? null : Math.round(duration),
        hasTranscript: transcriptOf(row) !== null,
        sha256: file.sha256,
      };
    },

    /**
     * The unauthenticated download. Everything that makes it safe is in this one handler.
     *
     * Order matters: verify first, so an expired or forged token is refused before it can touch the
     * rate-limit map or name a file; then the counter; then the bytes. A token that fails
     * verification has no sha and no representation to log, which is why the record's first two
     * fields are nullable.
     */
    fetchSignedMedia: async ({ params }): Promise<BinaryPayload> => {
      const at = Math.floor(Date.now() / 1000);
      let payload: LinkPayload;
      try {
        payload = links.verify(params.token);
      } catch (err) {
        logAccess(undefined, "refused", at);
        throw err;
      }

      sweep(at);
      const bucket = fetches.get(params.token) ?? { count: 0, expiresAt: payload.e };
      if (bucket.count >= MAX_FETCHES_PER_TOKEN) {
        logAccess(payload, "rate_limited", at);
        // `rate_limited`, not `budget_exhausted`: both are 429, but only this one comes back on its
        // own. A client that cannot tell them apart retries against a wall, or gives up on a ceiling
        // that would have lifted.
        throw new ApiError(
          "rate_limited",
          `this media link has been fetched ${String(MAX_FETCHES_PER_TOKEN)} times, which is its limit; ask for a new one`,
        );
      }
      fetches.set(params.token, { count: bucket.count + 1, expiresAt: bucket.expiresAt });

      const path = media.pathFor(payload.s);
      let bytes: Buffer;
      let mimeType: string;
      try {
        if (payload.r === "jpeg") {
          // Regenerated from the raw cached file on each fetch rather than materialised into a
          // second cache: the conversion is deterministic and cheap, and a derivative cache would
          // need its own key, eviction and invalidation for a media cache documented as never
          // evicted.
          bytes = (await imageJpeg(path, { maxBytes: config.maxImageBytes }, logger)).bytes;
          mimeType = JPEG;
        } else {
          bytes = await readCached(path);
          mimeType = safeContentType(payload.m);
        }
      } catch (err) {
        logAccess(payload, "unavailable", at);
        throw err;
      }

      logAccess(payload, "served", at);
      return {
        bytes,
        mimeType,
        filename: boundFilename(payload.f),
        disposition: dispositionFor("inline", mimeType),
      };
    },
  };
}
