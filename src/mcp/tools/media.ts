/**
 * The two tools that turn an attachment into something a model can actually read: pictures as image
 * blocks, videos as a strip of keyframes, PDFs as text, voice notes as speech.
 *
 * Unlike the read tools, these two may reach for the socket — `MediaStore.fetch` requires it on a
 * cache miss, because an attachment that was never downloaded cannot be produced from SQLite. That
 * makes the failures they can hit genuinely different, and each is surfaced as itself rather than
 * collapsed into the others: `ConnectionUnavailableError` means "wait and retry",
 * `MediaUnavailableError` means "this is gone, WhatsApp's media URLs have expired", and
 * `MessageNotFoundError` means "that id names nothing here". Telling a model to give up on media that
 * is one reconnection away — or to keep retrying an id it mistyped — is the mistake this avoids.
 *
 * Every result has the same shape: zero or more image blocks, then a JSON summary block, then at most
 * one block of text (a transcript, a PDF's contents, or an instruction). The summary is where size,
 * dimensions, duration and the message's reactions live — this is a single-message context, which is
 * the only place the full reaction shape belongs.
 *
 * **The image-block budget is `config.videoKeyframes + 1`, enforced in `compose` for every branch.**
 * Image blocks are by far the most expensive thing a tool can put into a context window, and the cap
 * belongs somewhere a new branch cannot forget it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MessageRow } from "../../db/messages.js";
import {
  imageBlock,
  pdfText,
  probeDimensions,
  probeDuration,
  videoKeyframes,
  type Dimensions,
  type ImageBlock,
} from "../../media/convert.js";
import { MediaUnavailableError, MessageNotFoundError, type MediaFile } from "../../media/store.js";
import { errorFields } from "../../logger.js";
import { canonicalId } from "../../wa/jid.js";
import type { ToolContext } from "../context.js";
import {
  describeError,
  failedResult,
  jsonResult,
  presentReactions,
  textResult,
  type Block,
  type ToolResult,
} from "../result.js";

const chatSchema = z.string().min(1).describe("Chat JID, exactly as `wa_chats_list` returns it.");
const messageIdSchema = z
  .string()
  .min(1)
  .describe("Message id, as returned by wa_messages_list or wa_messages_search.");

const PDF_MIMETYPE = "application/pdf";

/** Fields a branch adds to the summary on top of the ones every branch reports. */
type Extra = Record<string, unknown>;

/** The message a branch is about, plus the file it resolved to. */
type Subject = { row: MessageRow; file: MediaFile };

/**
 * Metadata about a media file, best-effort.
 *
 * A probe failure — no ffprobe in the image, a container it cannot parse — must not sink the whole
 * call: the picture or the transcript is the payload, and the dimensions are a caption on it. So it
 * is logged and reported as unknown rather than raised.
 */
async function probed<T>(what: string, ctx: ToolContext, probe: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await probe();
  } catch (err) {
    // The error's fields, never the error object — see `errorFields`. A failed download reaches the
    // logger with a WhatsApp CDN URL hanging off it, and one habit here is worth more than one
    // careful site.
    ctx.logger.warn({ ...errorFields(err), what }, "media: could not read this property of an attachment");
    return undefined;
  }
}

function dimensionFields(dims: Dimensions | undefined): Extra {
  return { width: dims?.width ?? null, height: dims?.height ?? null };
}

/** Seconds, rounded — a duration reported to a tenth of a second tells a model nothing extra. */
function durationField(seconds: number | undefined): Extra {
  return { duration_sec: seconds === undefined ? null : Math.round(seconds) };
}

function summaryOf(subject: Subject, ctx: ToolContext, extra: Extra): Extra {
  const { row, file } = subject;
  return {
    chat: row.chatId,
    message_id: row.id,
    kind: row.kind,
    mimetype: file.mimetype,
    bytes: file.bytes,
    ...extra,
    reactions: presentReactions(ctx.reactions.forMessage(row.chatId, row.id), ctx),
  };
}

/**
 * Images, then the JSON summary, then at most one block of text.
 *
 * The cap on image blocks is applied here and nowhere else. It cannot currently trigger — the image
 * branch produces one block and the video branch produces `videoKeyframes` — so a trigger means a
 * branch has started producing more than it should, which is worth a log line rather than a silent
 * truncation.
 */
function compose(
  images: readonly ImageBlock[],
  summary: Extra,
  note: string | undefined,
  ctx: ToolContext,
): ToolResult {
  const budget = ctx.config.videoKeyframes + 1;
  if (images.length > budget) {
    ctx.logger.warn({ produced: images.length, budget }, "media: capping the image blocks in one result");
  }
  const blocks: Block[] = images
    .slice(0, budget)
    .map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
  blocks.push(...jsonResult(summary, ctx.config.maxResultChars).content);
  // Capped like every other payload: a note is a transcript or a PDF's text, both of which are as
  // capable of filling a context window as a page of messages is.
  if (note !== undefined) blocks.push(...textResult(note, ctx.config.maxResultChars).content);
  return { content: blocks };
}

/** One image block, plus the dimensions and size of what it was made from. */
async function imageAnswer(subject: Subject, ctx: ToolContext): Promise<ToolResult> {
  const dims = await probed("dimensions", ctx, () => probeDimensions(subject.file.path));
  const block = await imageBlock(subject.file.path, ctx.config.maxImageBytes, ctx.logger);
  return compose([block], summaryOf(subject, ctx, dimensionFields(dims)), undefined, ctx);
}

/** A strip of keyframes, the clip's duration and size, and its transcript when one is cached. */
async function videoAnswer(subject: Subject, ctx: ToolContext): Promise<ToolResult> {
  const dims = await probed("dimensions", ctx, () => probeDimensions(subject.file.path));
  const duration = await probed("duration", ctx, () => probeDuration(subject.file.path));
  const count = ctx.config.videoKeyframes;
  const frames = await videoKeyframes(subject.file.path, count, ctx.config.maxImageBytes, ctx.logger);
  const extra: Extra = { ...dimensionFields(dims), ...durationField(duration), keyframes: frames.length };
  const transcript = subject.row.transcript;
  return compose(frames, summaryOf(subject, ctx, extra), transcript ?? undefined, ctx);
}

/**
 * The cached transcript when there is one, and otherwise the duration plus what to do about it.
 *
 * Transcribing here instead would make every download of a voice note spend a whisper run — minutes
 * of CPU on the machine this deploys to — for a model that may only have wanted to know how long it
 * is. `wa_transcribe` is the tool that decides to pay that, and it writes its answer back here.
 */
async function audioAnswer(subject: Subject, ctx: ToolContext): Promise<ToolResult> {
  const transcript = subject.row.transcript;
  if (transcript !== null && transcript !== "") {
    return compose([], summaryOf(subject, ctx, { transcribed: true }), transcript, ctx);
  }
  const duration = await probed("duration", ctx, () => probeDuration(subject.file.path));
  const summary = summaryOf(subject, ctx, { ...durationField(duration), transcribed: false });
  const note =
    "This voice note has not been transcribed yet. Call wa_transcribe with the same chat and message_id " +
    "to get its text; the result is cached, so asking twice costs nothing extra.";
  return compose([], summary, note, ctx);
}

/**
 * A PDF as text; anything else as the path it is cached at, for a human or another tool to open.
 *
 * A failed extraction **degrades**, exactly as `probed` does above and for the same reason: no
 * `pdftotext` in the image, or a file that is not the PDF it claims to be, does not make the path,
 * the size and the mimetype worthless — and those are what a caller needs to do anything else with
 * the attachment. Sinking the whole call would throw away everything the summary already holds in
 * order to report the one part that failed.
 */
async function documentAnswer(subject: Subject, ctx: ToolContext): Promise<ToolResult> {
  const summary = summaryOf(subject, ctx, { path: subject.file.path });
  if (!subject.file.mimetype.startsWith(PDF_MIMETYPE)) {
    return compose([], summary, undefined, ctx);
  }
  let text: string;
  try {
    text = await pdfText(subject.file.path, ctx.config.maxResultChars);
  } catch (err) {
    ctx.logger.warn(errorFields(err), "media: could not extract the text of this PDF");
    const note =
      `The text of this PDF could not be extracted (${describeError(err)}). The document itself is ` +
      "intact and cached at the path in the summary above.";
    return compose([], summary, note, ctx);
  }
  const note =
    text === "" ? "This PDF carries no extractable text, which usually means it is a scan of a paper document." : text;
  return compose([], summary, note, ctx);
}

export function registerMediaTools(server: McpServer, ctx: ToolContext): void {
  /** The row a media tool is about, or the error explaining why there is nothing to fetch. */
  function subjectRow(chat: string, messageId: string): MessageRow {
    const chatId = canonicalId(chat, ctx.contacts);
    const row = ctx.messages.get(chatId, messageId);
    // `MessageNotFoundError`, not `MediaUnavailableError`: a bad id and an expired attachment are
    // different answers, and the class name is what a model reads first. `MediaStore.fetch` raises
    // the same class for the same reason — this check is ahead of it because `wa_transcribe` answers
    // from `row.transcript` without fetching anything at all.
    if (row === undefined) throw new MessageNotFoundError(`no message ${messageId} in chat ${chatId}`);
    return row;
  }

  server.registerTool(
    "wa_download_media",
    {
      description:
        "Fetch a message's attachment and return it in a form a model can read: a photo or sticker as " +
        "an image, a video as evenly spaced keyframes with its duration, a voice note as its cached " +
        "transcript (or the duration and a pointer to wa_transcribe), a PDF as extracted text, and any " +
        "other document as the path it was cached at. Downloads once and reuses the cached copy after " +
        "that; a first download needs a live connection, while a cached one does not.",
      inputSchema: { chat: chatSchema, message_id: messageIdSchema },
      // Not `readOnlyHint`, for the same reason `wa_transcribe` is not: a first fetch writes the
      // attachment into the media cache and stamps `media_sha` on the row. Idempotent, though —
      // content-addressed, so calling it twice writes the same bytes to the same path, and a second
      // call reads the cache without touching the socket at all.
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, message_id }) => {
      try {
        const row = subjectRow(chat, message_id);
        const file = await ctx.media.fetch(row.chatId, row.id);
        const subject: Subject = { row, file };
        switch (row.kind) {
          case "image":
          case "sticker":
            return await imageAnswer(subject, ctx);
          case "video":
            return await videoAnswer(subject, ctx);
          case "audio":
            return await audioAnswer(subject, ctx);
          case "document":
            return await documentAnswer(subject, ctx);
          default:
            // Unreachable in practice: `MediaStore.fetch` refuses a non-media kind before this runs.
            // Kept because `MessageKind` is a closed union and a new member must land somewhere.
            return failedResult(
              "wa_download_media",
              new MediaUnavailableError(`message ${row.id} is a ${row.kind} message and carries no media`),
              ctx,
            );
        }
      } catch (err) {
        return failedResult("wa_download_media", err, ctx);
      }
    },
  );

  server.registerTool(
    "wa_transcribe",
    {
      description:
        "Transcribe a voice note or a video's audio track with whisper, and store the result so that " +
        "wa_messages_search can find the message by what was said in it. Answers instantly from the " +
        "stored transcript when there is one; otherwise this is minutes of CPU, so call it on one " +
        "message at a time rather than over a whole chat.",
      inputSchema: { chat: chatSchema, message_id: messageIdSchema },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, message_id }) => {
      try {
        const row = subjectRow(chat, message_id);
        // The cache is consulted before anything else, on purpose: a stored transcript is the whole
        // reason this tool is affordable to call twice.
        if (row.transcript !== null && row.transcript !== "")
          return textResult(row.transcript, ctx.config.maxResultChars);

        const file = await ctx.media.fetch(row.chatId, row.id);
        const text = await ctx.transcriber.transcribeFile(file.path);
        // Written through the repository rather than kept in memory: the update fires the FTS
        // trigger, which is what puts the speech into the search index.
        ctx.messages.setTranscript(row.chatId, row.id, text);
        // The whole transcript is stored; what comes back is capped like every other payload, and
        // `wa_messages_search` still finds the message by anything said past the cut.
        return textResult(text, ctx.config.maxResultChars);
      } catch (err) {
        return failedResult("wa_transcribe", err, ctx);
      }
    },
  );
}
