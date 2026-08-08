/**
 * The two tools that turn an attachment into something a model can actually read: pictures as image
 * blocks, videos as a strip of keyframes, PDFs as text, voice notes as speech.
 *
 * Every result has the same shape it has always had: zero or more image blocks, then a JSON summary
 * block, then at most one block of text (a transcript, a PDF's contents, or an instruction). The
 * summary is where size, dimensions, duration and the message's reactions live — this is a
 * single-message context, which is the only place the full reaction shape belongs.
 *
 * **What changed across the split, and it is one thing.** The document branch reports `url` where
 * it used to report `path` — spec §7.1's first sanctioned exception. The path was a location on the
 * *API's* disk, which this process cannot open and a caller of this process cannot reach, so
 * reporting it would be reporting a fact about a filesystem nobody in the conversation has. Both
 * document sub-branches change, PDF included: `summaryOf` was called with `{ path }`
 * unconditionally, before the PDF test, so the PDF branch carried the same path the other one did.
 * The extraction-failure note is rewritten to match, because it used to point at "the path in the
 * summary above" and that field no longer exists. Everything else — every key, every order, every
 * fixed string — is byte for byte what the in-process server produced.
 *
 * **Never fetch raw bytes in order to inspect them.** Three branches need two calls to reproduce
 * today's fields (`summaryOf` reports `mimetype` and `bytes` unconditionally, and `/transcript`,
 * `/text` and `/link` do not all carry them), and two small metadata calls are the right cost.
 * Pulling a 20 MB video down to this process to read its dimensions is not: the API has the file,
 * the ffmpeg and the cache, and `/keyframes` answers with what was actually wanted.
 *
 * The failures stay distinguishable, which is the reason they were ever separate classes:
 * `ConnectionUnavailableError` means "wait and retry", `MediaUnavailableError` means "this is gone,
 * WhatsApp's media URLs have expired", `MessageNotFoundError` means "that id names nothing here",
 * and `ApiUnreachableError` means this process cannot find its own backend. `describeError` renders
 * each one's own name, so a model reads the same first word it always has.
 *
 * **The image-block budget is the API's now.** It used to be `config.videoKeyframes + 1`, enforced
 * in `compose` — but this process holds no such setting, and inventing a second ceiling here would
 * be a number that can disagree with the one that actually bounds the strip. `MediaKeyframesQuery`
 * caps `frames` at 16 and the API bounds it again by its own `videoKeyframes`, so the count is
 * decided once, by the side that owns it. The cap could never trigger from here in any case: the
 * image branch produces one block and the video branch produces exactly what `/keyframes` returned.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MediaUnavailableError, type Reaction } from "whatsapp-api-sdk";
import { z } from "zod";

import type { ToolContext } from "../context.js";
import { errorFields } from "../logger.js";
import {
  describeError,
  failedResult,
  jsonResult,
  presentReactions,
  textResult,
  type Block,
  type ToolResult,
} from "../result.js";

const chatSchema = z.string().min(1).describe("Chat JID, exactly as `whatsapp_chats_list` returns it.");
const messageIdSchema = z
  .string()
  .min(1)
  .describe("Message id, as returned by whatsapp_messages_list or whatsapp_messages_search.");

const PDF_MIMETYPE = "application/pdf";

/** Fields a branch adds to the summary on top of the ones every branch reports. */
type Extra = Record<string, unknown>;

/** The five keys every branch reports, in the order `summaryOf` has always written them. */
type Subject = { chat: string; messageId: string; kind: string; mimetype: string; bytes: number };

function summaryOf(subject: Subject, reactions: readonly Reaction[], extra: Extra): Extra {
  return {
    chat: subject.chat,
    message_id: subject.messageId,
    kind: subject.kind,
    mimetype: subject.mimetype,
    bytes: subject.bytes,
    ...extra,
    reactions: presentReactions(reactions),
  };
}

/** Images, then the JSON summary, then at most one block of text. */
function compose(
  images: readonly { data: string; mimeType: string }[],
  summary: Extra,
  note: string | undefined,
  ctx: ToolContext,
): ToolResult {
  const blocks: Block[] = images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
  blocks.push(...jsonResult(summary, ctx.config.maxResultChars).content);
  // Capped like every other payload: a note is a transcript or a PDF's text, both of which are as
  // capable of filling a context window as a page of messages is.
  if (note !== undefined) blocks.push(...textResult(note, ctx.config.maxResultChars).content);
  return { content: blocks };
}

/**
 * A voice note nobody has transcribed yet, and what to do about it.
 *
 * Reproduced character for character from the in-process server: it is a fixed string a model has
 * been reading since before the split, and the advice in it — that the result is cached — is what
 * stops a model treating a second call as a second bill.
 */
const TRANSCRIBE_HINT =
  "This voice note has not been transcribed yet. Call whatsapp_transcribe with the same chat and message_id " +
  "to get its text; the result is cached, so asking twice costs nothing extra.";

const SCANNED_PDF_NOTE = "This PDF carries no extractable text, which usually means it is a scan of a paper document.";

export function registerMediaTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "whatsapp_download_media",
    {
      description:
        "Fetch a message's attachment and return it in a form a model can read: a photo or sticker as " +
        "an image, a video as evenly spaced keyframes with its duration, a voice note as its cached " +
        "transcript (or the duration and a pointer to whatsapp_transcribe), a PDF as extracted text, and any " +
        "other document as the path it was cached at. Downloads once and reuses the cached copy after " +
        "that; a first download needs a live connection, while a cached one does not.",
      inputSchema: { chat: chatSchema, message_id: messageIdSchema },
      // Not `readOnlyHint`, for the same reason `whatsapp_transcribe` is not: a first fetch writes the
      // attachment into the media cache and stamps `media_sha` on the row. Idempotent, though —
      // content-addressed, so calling it twice writes the same bytes to the same path, and a second
      // call reads the cache without touching the socket at all.
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, message_id }) => {
      try {
        // One `getMessage` first, for three things at once: the canonical chat id the summary
        // reports, the kind that selects the branch, and the reactions every branch embeds. The
        // API raises `MessageNotFoundError` here for an id it has never seen, which is the same
        // class — and the same sentence — the in-process tool raised before reaching for media.
        const detail = await ctx.client.getMessage({ params: { chat, id: message_id } });
        const params = { chat: detail.chat, id: detail.id };
        const subject = { chat: detail.chat, messageId: detail.id, kind: detail.kind };

        switch (detail.kind) {
          case "image":
          case "sticker": {
            // `/jpeg` carries the derivative *and* `source`, which is the original's size and type —
            // the two fields the summary reports on every branch. One call, no raw bytes.
            const jpeg = await ctx.client.fetchMediaJpeg({ params, query: {} });
            const summary = summaryOf({ ...subject, ...jpeg.source }, detail.reactions, {
              width: jpeg.width,
              height: jpeg.height,
            });
            return compose([jpeg], summary, undefined, ctx);
          }

          case "video": {
            const strip = await ctx.client.fetchMediaKeyframes({ params, query: {} });
            const summary = summaryOf({ ...subject, ...strip.source }, detail.reactions, {
              width: strip.width,
              height: strip.height,
              // Rounded, as it always has been: a duration reported to a tenth of a second tells a
              // model nothing extra.
              duration_sec: Math.round(strip.durationSec),
              keyframes: strip.frames.length,
            });
            // The transcript comes off the row that was already fetched, not from a second
            // `/transcript` call: one round trip fewer, and one source of truth for one value.
            return compose(strip.frames, summary, detail.transcript ?? undefined, ctx);
          }

          case "audio": {
            // `/meta` and not `/transcript`: the transcript is on the row above, and what the row
            // does not carry is `bytes` and `mimetype`, which every summary reports. The same one
            // call serves both sub-branches, which is why it is made before the test.
            const meta = await ctx.client.fetchMediaMeta({ params });
            const source = { ...subject, mimetype: meta.mimetype, bytes: meta.bytes };
            if (detail.transcript !== null && detail.transcript !== "") {
              // Deliberately only the text. A `/transcript` call would also offer a model and a
              // language; putting either into the summary would widen a shape a model has read for
              // as long as the tool has existed.
              const cached = summaryOf(source, detail.reactions, { transcribed: true });
              return compose([], cached, detail.transcript, ctx);
            }
            const summary = summaryOf(source, detail.reactions, {
              // The duration is what tells a model whether a transcription is worth asking for.
              duration_sec: meta.durationSec === null ? null : Math.round(meta.durationSec),
              transcribed: false,
            });
            return compose([], summary, TRANSCRIBE_HINT, ctx);
          }

          case "document": {
            // The link is minted first, for both sub-branches: it is what supplies `url`,
            // `mimeType` and `bytes`, and minting it resolves the attachment — so a document that
            // cannot be produced fails here rather than after a text extraction that had nothing to
            // work on. `expiresAt` and `filename` are dropped: the summary has never carried them,
            // and passing the response through whole would add two fields to what a model reads.
            const link = await ctx.client.fetchMediaLink({ params, query: {} });
            const summary = summaryOf({ ...subject, mimetype: link.mimeType, bytes: link.bytes }, detail.reactions, {
              // `/link` answers a **relative** reference on purpose: the API cannot know its own
              // public origin, and building an absolute URL from the `Host` header would let a
              // caller choose the origin of a capability URL. This process does know the origin —
              // it is what `WHATSAPP_API_URL` names — so this is the layer that can honestly
              // resolve it, and it must, because a model or a human is going to open this.
              url: new URL(link.url, ctx.config.apiUrl).toString(),
            });
            if (!link.mimeType.startsWith(PDF_MIMETYPE)) return compose([], summary, undefined, ctx);

            let text: string;
            try {
              text = (await ctx.client.fetchMediaText({ params })).text;
            } catch (err) {
              // A failed extraction **degrades**: no `pdftotext` in the image, or a file that is not
              // the PDF it claims to be, does not make the size, the type and the link worthless —
              // and those are what a caller needs to do anything else with the attachment.
              ctx.logger.warn(errorFields(err), "media: could not extract the text of this PDF");
              const note =
                `The text of this PDF could not be extracted (${describeError(err)}). The document itself is ` +
                "intact and can be downloaded from the url in the summary above.";
              return compose([], summary, note, ctx);
            }
            return compose([], summary, text === "" ? SCANNED_PDF_NOTE : text, ctx);
          }

          default:
            // Unreachable in practice: every media route refuses a non-media kind before this runs.
            // Kept because `MessageKind` is a closed union and a new member must land somewhere.
            return failedResult(
              "whatsapp_download_media",
              new MediaUnavailableError(`message ${detail.id} is a ${detail.kind} message and carries no media`),
              ctx,
            );
        }
      } catch (err) {
        return failedResult("whatsapp_download_media", err, ctx);
      }
    },
  );

  server.registerTool(
    "whatsapp_transcribe",
    {
      description:
        "Transcribe a voice note or a video's audio track, and store the result so that " +
        "whatsapp_messages_search can find the message by what was said in it. Answers instantly from the " +
        "stored transcript when there is one — most recent voice notes are transcribed on arrival, so " +
        "this is usually free. Otherwise it runs on a GPU that scales to zero, so the first call after a " +
        "quiet period can take a minute or two while the endpoint starts.",
      inputSchema: { chat: chatSchema, message_id: messageIdSchema },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, message_id }) => {
      try {
        // One call, and the cache lookup is inside it. `POST …/transcribe` consults the stored
        // transcript before it spends anything and writes what it produces back through the
        // repository, which is what puts the speech into the search index — so a `getMessage` here
        // to check the cache first would be a round trip that changed nothing but the bill for it.
        //
        // The deadline is the SDK's `transcribe` override, not the shared one: a cold GPU endpoint
        // legitimately outlives the timeout every other route gets.
        const result = await ctx.client.transcribe({ params: { chat, id: message_id } });
        // The whole transcript is stored API-side; what comes back is capped like every other
        // payload, and `whatsapp_messages_search` still finds the message by anything past the cut.
        return textResult(result.text, ctx.config.maxResultChars);
      } catch (err) {
        return failedResult("whatsapp_transcribe", err, ctx);
      }
    },
  );
}
