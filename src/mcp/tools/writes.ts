/**
 * The six tools that change something on WhatsApp: sending text and files, reacting, marking read,
 * editing and revoking.
 *
 * Every one of them is deliberately thin — validate, call `ctx.sender`, shape the answer — because
 * all the judgement lives one layer down. `wa/send.ts` is what resolves a JID, requires a socket,
 * refuses a path outside `WA_SEND_FILE_DIR`, enforces the upload cap and feeds the sent message back
 * through ingest; duplicating any of that here would give a second, subtly different copy of a rule
 * that has to hold in exactly one place.
 *
 * Three conventions:
 *
 * 1. **A handler never throws.** Every failure `send.ts` documents — `ConnectionUnavailableError`,
 *    `NotFoundError`, `MessageRevokedError`, `NotOwnMessageError`, `SendPathError` — comes back as an
 *    `errorResult` with its one readable line. An exception escaping into the SDK becomes a protocol
 *    error the model cannot read, and it would take the tool call's identity with it.
 * 2. **This module is gated, not conditional.** It is registered only when `config.readOnly` is
 *    false (`buildMcpServer`), so a read-only server does not advertise these tools at all rather
 *    than advertising them and refusing every call.
 * 3. **No JID is interpreted here** (Global Constraint 11) and nothing is imported from `baileys`
 *    (Constraint 12): a caller-supplied `chat` is passed through verbatim and canonicalized by
 *    `send.ts`, which is the same path the read tools take through `jid.ts`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FileSource, SendRef } from "../../wa/send.js";
import type { ToolContext } from "../context.js";
import { errorResult, jsonResult, type ToolResult } from "../result.js";

const chatSchema = z.string().min(1).describe("Chat JID, exactly as `wa_chats_list` returns it — a person or a group.");

const messageIdSchema = z.string().min(1).describe("Message id, as returned by wa_messages_list or wa_send_text.");

const replyToSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Message id in the same chat to quote in reply. Omit to send without quoting.");

const WRITE_TOOL = { readOnlyHint: false, openWorldHint: true } as const;
const DESTRUCTIVE_TOOL = { readOnlyHint: false, openWorldHint: true, destructiveHint: true } as const;

/**
 * `wa_send_file`'s arguments, as one flat object with `data` and `path` both optional.
 *
 * Not a discriminated union — that renders as a top-level `anyOf`, which several MCP clients present
 * badly — and **not** a `.refine()`d object either, which is what this task was specified with. A
 * refinement makes the schema a `ZodEffects`, and `@modelcontextprotocol/sdk@1.30.0` cannot describe
 * one: `normalizeObjectSchema` reaches for `.shape`, a `ZodEffects` has none, and `listTools` falls
 * back to its `EMPTY_OBJECT_JSON_SCHEMA` — so the tool would advertise `{"type":"object",
 * "properties":{}}` and no client would ever learn that `chat` exists, let alone `data`. (Verified
 * against the installed sdk 1.30.0 + zod 3.25.76; the call still *validates* against the effect,
 * because `validateToolInput` falls back to the raw schema, so the breakage is invisible from a
 * server-side test that only checks that a bad call is refused.)
 *
 * The "exactly one of data/path" rule is therefore enforced in `fileSource` below and stated in both
 * descriptions. Nothing is lost by that: a refinement never appears in JSON Schema anyway, so it was
 * never machine-readable to a client in the first place.
 */
const sendFileShape = {
  chat: chatSchema,
  data: z
    .string()
    .min(1)
    .optional()
    .describe("The file's bytes, base64-encoded. Exactly one of `data` or `path` must be given."),
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A file on the server, inside the directory WA_SEND_FILE_DIR names. Disabled unless that " +
        "variable is set, in which case anything resolving outside it is refused. Prefer `data`.",
    ),
  filename: z.string().min(1).optional().describe("Name the recipient sees. Also used to guess the mimetype."),
  mimetype: z.string().min(1).optional().describe("Overrides the type guessed from `filename`, e.g. image/jpeg."),
  caption: z.string().optional().describe("Caption to send with an image, video or document. Ignored for audio."),
  reply_to: replyToSchema,
  as_voice_note: z
    .boolean()
    .optional()
    .describe("Send audio as a push-to-talk voice note rather than as an audio file."),
};

type SendFileArgs = { [K in keyof typeof sendFileShape]: z.infer<(typeof sendFileShape)[K]> };

/**
 * Run a handler, turning anything it throws into a readable `isError` result.
 *
 * Written once rather than as six try/catch blocks so that no tool can be added later without it.
 */
async function guarded(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work();
  } catch (err) {
    return errorResult(err);
  }
}

/** What a send answers with: where the message landed and what it is called. */
function sendResult(ref: SendRef, ctx: ToolContext): ToolResult {
  return jsonResult({ chat: ref.chatId, message_id: ref.messageId }, ctx.config.maxResultChars);
}

/**
 * What an operation with no new message answers with.
 *
 * It echoes the caller's own `chat` rather than a canonical JID: this layer does not interpret JIDs
 * (Constraint 11), and echoing the input is honest, where re-deriving it would be a claim.
 */
function okResult(chat: string, messageId: string, ctx: ToolContext): ToolResult {
  return jsonResult({ status: "ok", chat, message_id: messageId }, ctx.config.maxResultChars);
}

/**
 * The bytes to send, or a refusal naming what was wrong.
 *
 * This is where "exactly one of data/path" is enforced, for the reason `sendFileShape` documents.
 * Both spellings of wrong are refused explicitly rather than one silently winning: a caller that
 * sent both had a belief about which one applies, and picking one for it is how a model ends up
 * sending a file it did not mean to.
 */
function fileSource(args: SendFileArgs): FileSource {
  if (args.path !== undefined && args.data !== undefined) {
    throw new Error("give either `data` (base64 bytes) or `path` (a server-side file), not both");
  }
  if (args.path !== undefined) return { kind: "path", path: args.path };
  if (args.data !== undefined) return { kind: "data", base64: args.data };
  throw new Error("provide exactly one of `data` (base64 bytes) or `path` (a server-side file under WA_SEND_FILE_DIR)");
}

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "wa_send_text",
    {
      description:
        "Send a text message to a WhatsApp chat, optionally as a reply quoting an earlier message. " +
        "Needs a live connection: when the socket is down the call fails naming the connection state, " +
        "and the read tools keep working meanwhile.",
      inputSchema: {
        chat: chatSchema,
        text: z.string().min(1).describe("The message body. WhatsApp markdown (*bold*, _italic_) works."),
        reply_to: replyToSchema,
      },
      annotations: WRITE_TOOL,
    },
    async ({ chat, text, reply_to }) =>
      await guarded(async () => sendResult(await ctx.sender.sendText(chat, text, reply_to), ctx)),
  );

  server.registerTool(
    "wa_send_file",
    {
      description:
        "Send an image, video, voice note or document to a WhatsApp chat. Give the bytes as base64 in " +
        "`data`; `path` reads a server-side file and works only when WA_SEND_FILE_DIR is configured. " +
        "The type is taken from `mimetype`, else guessed from `filename`.",
      inputSchema: sendFileShape,
      annotations: WRITE_TOOL,
    },
    async (args) =>
      await guarded(async () => {
        const ref = await ctx.sender.sendFile(args.chat, fileSource(args), {
          filename: args.filename,
          mimetype: args.mimetype,
          caption: args.caption,
          replyTo: args.reply_to,
          asVoiceNote: args.as_voice_note,
        });
        return sendResult(ref, ctx);
      }),
  );

  server.registerTool(
    "wa_react",
    {
      description:
        "React to a message with an emoji, replacing whatever this account had reacted with before. " +
        "An empty `emoji` removes the reaction — that is how WhatsApp models a removal, not a mistake.",
      inputSchema: {
        chat: chatSchema,
        message_id: messageIdSchema,
        emoji: z.string().describe("A single emoji, or an empty string to remove this account's reaction."),
      },
      annotations: WRITE_TOOL,
    },
    async ({ chat, message_id, emoji }) =>
      await guarded(async () => {
        await ctx.sender.react(chat, message_id, emoji);
        return okResult(chat, message_id, ctx);
      }),
  );

  server.registerTool(
    "wa_mark_read",
    {
      description:
        "Mark a chat read up to and including one message — not that message alone. Everything " +
        "received at or before its timestamp is acknowledged, and the local unread count is cleared.",
      inputSchema: { chat: chatSchema, message_id: messageIdSchema },
      annotations: WRITE_TOOL,
    },
    async ({ chat, message_id }) =>
      await guarded(async () => {
        await ctx.sender.markRead(chat, message_id);
        return okResult(chat, message_id, ctx);
      }),
  );

  server.registerTool(
    "wa_edit_message",
    {
      description:
        "Replace the text of a message this account sent. WhatsApp refuses to edit anyone else's " +
        "message, and it stops accepting edits some time after a message was sent.",
      inputSchema: {
        chat: chatSchema,
        message_id: messageIdSchema,
        text: z.string().min(1).describe("The replacement text, in full — this is not a patch."),
      },
      annotations: WRITE_TOOL,
    },
    async ({ chat, message_id, text }) =>
      await guarded(async () => {
        await ctx.sender.editMessage(chat, message_id, text);
        return okResult(chat, message_id, ctx);
      }),
  );

  server.registerTool(
    "wa_delete_message",
    {
      description:
        "Revoke a message this account sent, for everyone in the chat. Irreversible, and only ever " +
        "possible for this account's own messages.",
      inputSchema: { chat: chatSchema, message_id: messageIdSchema },
      annotations: DESTRUCTIVE_TOOL,
    },
    async ({ chat, message_id }) =>
      await guarded(async () => {
        await ctx.sender.deleteMessage(chat, message_id);
        return okResult(chat, message_id, ctx);
      }),
  );
}
