/**
 * The six tools that change something on WhatsApp: sending text and files, reacting, marking read,
 * editing and revoking.
 *
 * Every one of them is deliberately thin — one client call, one shaper — because all the judgement
 * lives at the other end of it. The API is what resolves a recipient, requires a socket, refuses a
 * path outside `WHATSAPP_SEND_FILE_DIR`, enforces the upload cap and feeds the sent message back
 * through ingest. Duplicating any of that here would give a second, subtly different copy of a rule
 * that has to hold in exactly one place — and this side of the split cannot even see the facts it
 * would need: which chats exist, whose name is ambiguous, what is on the API's disk.
 *
 * That includes "exactly one of `data`/`path`", which the API refuses with the same two sentences
 * this layer used to produce, word for word. A local pre-check would be a second author of a
 * refusal that already has one.
 *
 * Three conventions:
 *
 * 1. **A handler never throws.** Every failure comes back as a `failedResult`: one readable line to
 *    the model, one log line to the operator. An exception escaping into the MCP SDK becomes a
 *    protocol error the model cannot read, and it would take the tool call's identity with it.
 * 2. **This module is gated, not conditional.** `buildMcpServer` registers it only when the API
 *    reports a writable deployment, so a read-only one does not advertise these six tools at all
 *    rather than advertising them and refusing every call. The flag arrives from
 *    `GET /v1/capabilities` per session, so flipping the API takes effect on the next connect.
 *    It is a courtesy, not the enforcement: the API refuses a write with `read_only` regardless.
 * 3. **No JID is interpreted here** (Global Constraint 11): a caller-supplied `chat` goes to the
 *    API verbatim, and `canonicalId` is applied at that boundary and nowhere else.
 *
 * **An ambiguous recipient still reads exactly as it did.** The refusal's message already carries
 * the numbered list of matches, so `describeError` renders the same sentences it always has; what
 * is new is `details.candidates` on the error, a machine-readable copy of that list, which a
 * programmatic client can render without parsing prose. Nothing here has to build it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SendResult } from "whatsapp-api-sdk";
import { z } from "zod";

import type { ToolContext } from "../context.js";
import { failedResult, jsonResult, type ToolResult } from "../result.js";

const chatSchema = z
  .string()
  .min(1)
  .describe("Chat JID, exactly as `whatsapp_chats_list` returns it — a person or a group.");

/**
 * The recipient of a send, which is deliberately more forgiving than `chatSchema`.
 *
 * The four tools that also take a `message_id` got their chat from a listing, so a JID is the only
 * sensible thing to pass them. A send has no such provenance — it is the one place a caller starts
 * from what a human said — so it accepts a name too, and `pick` settles the ambiguity that follows.
 */
const recipientSchema = z
  .string()
  .min(1)
  .describe(
    "Who to send to: a chat JID from whatsapp_chats_list, a phone number, or a contact/group/chat name. " +
      "An ambiguous name is refused with the matches listed; re-send with `pick` to choose one.",
  );

const pickSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("When the recipient name matched several chats or contacts, the 1-indexed one to use.");

const messageIdSchema = z
  .string()
  .min(1)
  .describe("Message id, as returned by whatsapp_messages_list or whatsapp_send_text.");

const replyToSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Message id in the same chat to quote in reply. Omit to send without quoting.");

const WRITE_TOOL = { readOnlyHint: false, openWorldHint: true } as const;
const DESTRUCTIVE_TOOL = { readOnlyHint: false, openWorldHint: true, destructiveHint: true } as const;

/**
 * `whatsapp_send_file`'s arguments, as one flat object with `data` and `path` both optional.
 *
 * Not a discriminated union — that renders as a top-level `anyOf`, which several MCP clients present
 * badly — and **not** a `.refine()`d object either. A refinement makes the schema a `ZodEffects`, and
 * `@modelcontextprotocol/sdk@1.30.0` cannot describe one: `normalizeObjectSchema` reaches for
 * `.shape`, a `ZodEffects` has none, and `listTools` falls back to its `EMPTY_OBJECT_JSON_SCHEMA` —
 * so the tool would advertise `{"type":"object","properties":{}}` and no client would ever learn
 * that `chat` exists, let alone `data`. (Verified against the installed sdk 1.30.0 + zod 3.25.76;
 * the call still *validates* against the effect, because `validateToolInput` falls back to the raw
 * schema, so the breakage is invisible from a server-side test that only checks that a bad call is
 * refused.)
 *
 * The "exactly one of data/path" rule is therefore enforced by the API and stated in both
 * descriptions. Nothing is lost by that: a refinement never appears in JSON Schema anyway, so it was
 * never machine-readable to a client in the first place.
 *
 * `path` names a file on the **API** host, which is the third and last of the sanctioned changes in
 * meaning across the split (spec §7.1): the variable is the API's, the disk is the API's, and there
 * is no longer any sense in which it could mean a file beside this process. The description says so.
 */
const sendFileShape = {
  chat: recipientSchema,
  pick: pickSchema,
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
      "A file on the server, inside the directory WHATSAPP_SEND_FILE_DIR names. Disabled unless that " +
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

/**
 * What a send answers with: where the message landed and what it is called.
 *
 * **Two shapers, and the asymmetry between them is the contract, not an oversight.** The two sends
 * answer `{ chat, message_id }`; the other four answer the same pair behind a `status: "ok"`. The
 * wire carries neither spelling — every write route answers `{ chat, messageId }` — so `status` is
 * re-added here for exactly four tools. Unifying the two into one tidier helper would change what
 * four tools print, which is the whole thing this split is not allowed to do.
 */
function sendResult(res: SendResult, ctx: ToolContext): ToolResult {
  return jsonResult({ chat: res.chat, message_id: res.messageId }, ctx.config.maxResultChars);
}

/**
 * What an operation with no new message answers with.
 *
 * `chat` is the id the API resolved the call against, exactly as `sendResult` reports it — never
 * the string the caller passed in. Echoing the input would make one field name mean the canonical
 * chat in two of these six tools and "whatever you typed" in the other four, so a model that fed a
 * LID to `whatsapp_react` and the answer to `whatsapp_messages_list` would read an empty chat.
 */
function okResult(res: SendResult, ctx: ToolContext): ToolResult {
  return jsonResult({ status: "ok", chat: res.chat, message_id: res.messageId }, ctx.config.maxResultChars);
}

/**
 * Run a handler, turning anything it throws into a readable `isError` result *and* a log line.
 *
 * Written once rather than as six try/catch blocks so that no tool can be added later without it —
 * which is also why the logging belongs here: a failure reported to the model and to nobody else
 * leaves a bug in one of these six handlers with no trace anywhere an operator looks. `failedResult`
 * never hands the error object to the logger; see `errorFields`.
 */
async function guarded(tool: string, ctx: ToolContext, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work();
  } catch (err) {
    return failedResult(tool, err, ctx);
  }
}

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "whatsapp_send_text",
    {
      description:
        "Send a text message to a WhatsApp chat, optionally as a reply quoting an earlier message. " +
        "Needs a live connection: when the socket is down the call fails naming the connection state, " +
        "and the read tools keep working meanwhile.",
      inputSchema: {
        chat: recipientSchema,
        text: z.string().min(1).describe("The message body. WhatsApp markdown (*bold*, _italic_) works."),
        reply_to: replyToSchema,
        pick: pickSchema,
        mention: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Phone numbers or user JIDs to @mention. Write each one into `text` as @<number> too — " +
              "this list only marks them, it does not insert them.",
          ),
      },
      annotations: WRITE_TOOL,
    },
    async ({ chat, text, reply_to, pick, mention }) =>
      await guarded("whatsapp_send_text", ctx, async () =>
        sendResult(
          await ctx.client.sendText({
            body: { recipient: chat, text, replyTo: reply_to, mentions: mention, pick },
          }),
          ctx,
        ),
      ),
  );

  server.registerTool(
    "whatsapp_send_file",
    {
      description:
        "Send an image, video, voice note or document to a WhatsApp chat. Give the bytes as base64 in " +
        "`data`; `path` reads a server-side file and works only when WHATSAPP_SEND_FILE_DIR is configured. " +
        "The type is taken from `mimetype`, else guessed from `filename`.",
      inputSchema: sendFileShape,
      annotations: WRITE_TOOL,
    },
    async (args) =>
      await guarded("whatsapp_send_file", ctx, async () =>
        sendResult(
          await ctx.client.sendFile({
            body: {
              recipient: args.chat,
              data: args.data,
              path: args.path,
              filename: args.filename,
              mimetype: args.mimetype,
              caption: args.caption,
              replyTo: args.reply_to,
              asVoiceNote: args.as_voice_note,
              pick: args.pick,
            },
          }),
          ctx,
        ),
      ),
  );

  server.registerTool(
    "whatsapp_react",
    {
      description:
        "React to a message with an emoji, replacing whatever this account had reacted with before. " +
        "An empty `emoji` removes the reaction — that is how WhatsApp models a removal, not a mistake.",
      inputSchema: {
        chat: chatSchema,
        message_id: messageIdSchema,
        // No `.min(1)`, and it is load-bearing: an empty string is how WhatsApp models removing a
        // reaction. The obvious improvement silently deletes the removal path. The wire schema
        // makes the same omission for the same reason.
        emoji: z.string().describe("A single emoji, or an empty string to remove this account's reaction."),
      },
      annotations: WRITE_TOOL,
    },
    async ({ chat, message_id, emoji }) =>
      await guarded("whatsapp_react", ctx, async () =>
        okResult(await ctx.client.react({ params: { chat, id: message_id }, body: { emoji } }), ctx),
      ),
  );

  server.registerTool(
    "whatsapp_mark_read",
    {
      description:
        "Mark a chat read up to and including one message — not that message alone. Everything " +
        "received at or before its timestamp is acknowledged, and the local unread count is cleared.",
      inputSchema: { chat: chatSchema, message_id: messageIdSchema },
      annotations: WRITE_TOOL,
    },
    async ({ chat, message_id }) =>
      await guarded("whatsapp_mark_read", ctx, async () =>
        // The id rides in the body because the *chat* is what gets marked, up to and including it.
        okResult(await ctx.client.markRead({ params: { chat }, body: { messageId: message_id } }), ctx),
      ),
  );

  server.registerTool(
    "whatsapp_edit_message",
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
      await guarded("whatsapp_edit_message", ctx, async () =>
        okResult(await ctx.client.editMessage({ params: { chat, id: message_id }, body: { text } }), ctx),
      ),
  );

  server.registerTool(
    "whatsapp_delete_message",
    {
      description:
        "Revoke a message this account sent, for everyone in the chat. Irreversible, and only ever " +
        "possible for this account's own messages.",
      inputSchema: { chat: chatSchema, message_id: messageIdSchema },
      annotations: DESTRUCTIVE_TOOL,
    },
    async ({ chat, message_id }) =>
      await guarded("whatsapp_delete_message", ctx, async () =>
        okResult(await ctx.client.deleteMessage({ params: { chat, id: message_id } }), ctx),
      ),
  );
}
