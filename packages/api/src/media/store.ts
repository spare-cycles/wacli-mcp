/**
 * The content-addressed download cache: one file per distinct attachment, named by the sha256 of its
 * bytes, never deleted.
 *
 * Three properties matter more than anything else here.
 *
 * 1. **A cache hit never touches the connection; a cache miss requires it.** Media already on disk
 *    stays readable while WhatsApp is unreachable, and a miss with no socket raises
 *    `ConnectionUnavailableError` *unwrapped* — "wait and retry" and "this is gone for good" are
 *    different answers and the caller acts differently on each.
 * 2. **The write is atomic.** A truncated file at a content-addressed path would be trusted forever
 *    by every later fetch, so bytes land in a per-attempt temp file, are flushed, and are then
 *    renamed into place.
 * 3. **Nothing is ever deleted.** Cache eviction is out of scope for v1; the directory grows with
 *    the attachments actually read, which is a known growth area rather than an oversight.
 */

import { downloadMediaMessage, getContentType, normalizeMessageContent, proto, type WAMessage } from "baileys";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { MEDIA_KINDS, type MessagesRepo } from "../db/messages.js";
import { errorFields } from "../logger.js";
import type { WhatsAppConnection } from "../whatsapp/connection.js";

export type MediaFile = { path: string; sha256: string; bytes: number; mimetype: string };

export type MediaStore = {
  /** Download, or return the cached copy of, a message's media. Throws the two errors below. */
  fetch: (chatId: string, messageId: string) => Promise<MediaFile>;
  pathFor: (sha256: string) => string;
};

/** What Baileys' `downloadMediaMessage` needs from the live socket to retry an expired URL. */
export type DownloadContext = {
  reuploadRequest: (message: WAMessage) => Promise<WAMessage>;
  logger: Logger;
};

/** Injectable so tests can exercise the cache without a websocket. Defaults to Baileys' own. */
export type MediaDownloader = (message: WAMessage, ctx: DownloadContext) => Promise<Buffer>;

export type MediaStoreDeps = {
  dir: string;
  messages: MessagesRepo;
  conn: WhatsAppConnection;
  logger: Logger;
  download?: MediaDownloader | undefined;
};

/** The media cannot be produced, and waiting will not help: no envelope, not media, gone for good. */
export class MediaUnavailableError extends Error {
  override name = "MediaUnavailableError";
}

/**
 * There is no such message in that chat.
 *
 * Distinct from `MediaUnavailableError`, which used to carry this case too, because the two ask the
 * caller for different corrections and `describeError` puts the class name in front of the model:
 * this one says *check the id* — the message may never have existed, or may belong to another chat —
 * while `MediaUnavailableError` says *the id is right and the bytes are gone*, which is what an
 * expired WhatsApp media URL produces and what no retry will fix. Folded together, an id typo and a
 * six-month-old photo are one indistinguishable failure, by name and by message.
 */
export class MessageNotFoundError extends Error {
  override name = "MessageNotFoundError";
}

/**
 * The same list `whatsapp_messages_search`'s `has_media` selects on, as a set for the membership test
 * here. Derived from the one constant rather than restated, so a search that says a message has an
 * attachment and a fetch that says it has none cannot disagree.
 */
const FETCHABLE = new Set(MEDIA_KINDS);

const DEFAULT_MIMETYPE = "application/octet-stream";
const SHA256_HEX = /^[0-9a-f]{64}$/;

const baileysDownload: MediaDownloader = (message, ctx) => downloadMediaMessage(message, "buffer", {}, ctx);

/** The declared mimetype of whatever attachment a message carries, or a safe default. */
function mimetypeOf(message: WAMessage): string {
  // `normalizeMessageContent` first, always: WhatsApp routinely wraps real content in
  // `ephemeralMessage` / `viewOnceMessageV2`, and reading the wrapper finds no mimetype at all.
  const content = normalizeMessageContent(message.message);
  const type = getContentType(content);
  if (content === undefined || type === undefined) return DEFAULT_MIMETYPE;
  const body: unknown = content[type];
  if (typeof body !== "object" || body === null) return DEFAULT_MIMETYPE;
  const mimetype: unknown = (body as { mimetype?: unknown }).mimetype;
  return typeof mimetype === "string" && mimetype !== "" ? mimetype : DEFAULT_MIMETYPE;
}

/** The size of a usable cached file, or undefined when it is absent, not a file, or empty. */
async function usableSize(path: string): Promise<number | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.size === 0) return undefined;
  return info.size;
}

export function makeMediaStore(deps: MediaStoreDeps): MediaStore {
  const { dir, messages, conn, logger } = deps;
  const download = deps.download ?? baileysDownload;

  function pathFor(sha256: string): string {
    // Every address this module produces is its own sha256 digest, but `pathFor` is public surface:
    // refusing anything that is not a bare digest stops it from ever becoming a path-traversal
    // primitive should a caller one day pass something it read from elsewhere.
    if (!SHA256_HEX.test(sha256)) {
      throw new MediaUnavailableError("a media id must be a lowercase sha256 hex digest");
    }
    return join(dir, sha256);
  }

  /**
   * Write `data` to `path` so that no reader ever sees a partial file there.
   *
   * The temp name is unique per attempt rather than the obvious `<sha>.tmp`: two concurrent fetches
   * of the same message would otherwise write into the same temp file and rename a byte-interleaved
   * mess into a content-addressed path, where every later fetch would trust it forever. With a name
   * each, the rename is atomic and the loser merely replaces identical bytes. The explicit `sync()`
   * is what makes the same true across a power loss and not just a crash.
   */
  async function writeAtomic(path: string, data: Buffer): Promise<void> {
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(tmp, "wx");
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, path);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  async function fetch(chatId: string, messageId: string): Promise<MediaFile> {
    const row = messages.get(chatId, messageId);
    if (row === undefined) throw new MessageNotFoundError(`no message ${messageId} in chat ${chatId}`);
    if (!FETCHABLE.has(row.kind)) {
      throw new MediaUnavailableError(
        `message ${messageId} in chat ${chatId} is a ${row.kind} message and carries no media`,
      );
    }

    // The cache is consulted before anything reaches for the socket, on purpose: an attachment
    // already on disk must stay readable in every connection state.
    if (row.mediaSha !== null) {
      const path = pathFor(row.mediaSha);
      const bytes = await usableSize(path);
      if (bytes !== undefined) {
        return { path, sha256: row.mediaSha, bytes, mimetype: row.mediaType ?? DEFAULT_MIMETYPE };
      }
      logger.warn({ chatId, messageId }, "media: cached file is missing or empty; downloading it again");
    }

    const raw = messages.getRaw(chatId, messageId);
    if (raw === undefined) {
      throw new MediaUnavailableError(
        `message ${messageId} in chat ${chatId} has no stored envelope, so its media cannot be downloaded`,
      );
    }
    const message = proto.WebMessageInfo.decode(raw) as WAMessage;

    // Deliberately not wrapped: a `ConnectionUnavailableError` from here means "the socket is down,
    // try again when it is back", which is a different answer from `MediaUnavailableError`'s "this
    // is not obtainable at all". Collapsing the two would tell the caller to give up on media that
    // is one reconnection away.
    const sock = conn.requireSocket();

    let data: Buffer;
    try {
      data = await download(message, { reuploadRequest: (m) => sock.updateMediaMessage(m), logger });
    } catch (err) {
      // The error's own fields, never the error: baileys hangs the WhatsApp CDN media URL off the
      // failure *and* puts it in the message (``Failed to fetch stream from ${url}``), and pino's
      // standard serializer copies every own enumerable key — so one `{ err }` writes a capability
      // URL for the attachment's encrypted bytes into the log. `errorFields` closes both channels:
      // it picks two fields and scrubs URLs out of the message it keeps.
      logger.warn({ ...errorFields(err), chatId, messageId }, "media: download failed");
      throw new MediaUnavailableError(
        `could not download the media for message ${messageId} in chat ${chatId}: WhatsApp media URLs expire, ` +
          "so a message this old is most likely no longer downloadable",
      );
    }
    if (data.byteLength === 0) {
      throw new MediaUnavailableError(
        `the media for message ${messageId} in chat ${chatId} downloaded as zero bytes and was discarded`,
      );
    }

    const sha256 = createHash("sha256").update(data).digest("hex");
    const mimetype = mimetypeOf(message);
    const path = pathFor(sha256);
    await writeAtomic(path, data);
    messages.setMedia(chatId, messageId, sha256, mimetype);
    return { path, sha256, bytes: data.byteLength, mimetype };
  }

  return { fetch, pathFor };
}
