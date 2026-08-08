/**
 * The six read tools, over the typed client.
 *
 * Every input schema below — every `.describe()` string, `limitSchema`'s `.max(200).default(50)`,
 * the `messageFilterShape` both message tools share — is **copied verbatim** from the in-process
 * server this replaces. A model's view of these six tools does not change across the split, so
 * neither does a single character of what is advertised. `reads.test.ts` and the README both pin
 * them.
 *
 * That includes the wording of the descriptions, which still say a read "reads the local SQLite
 * store only, so it answers offline". It is not stale: the sentence describes the *deployment*, and
 * it is still true of it — the API answers all six from SQLite without touching the socket, so all
 * six keep working while the connection is down, mid-backoff, or logged out (Global Constraint 13).
 * What changed is which process holds the file, which is not a thing the sentence claims.
 *
 * Three conventions survive the move unchanged:
 *
 * 1. **Pagination is a round trip**, and the cursor is opaque. The overfetch that decides whether a
 *    `next_cursor` is warranted is the API's now — a client cannot ask SQLite for one more row —
 *    and a malformed cursor is still an error rather than a silent restart from page one: the API
 *    answers `bad_request` with the name `CursorError`, so what a model reads is unchanged.
 * 2. **Reaction counts ride on the row.** `Message.reactionCount` arrives filled, resolved by one
 *    grouped query server-side, so a page of fifty is one request rather than fifty-one.
 * 3. **A handler never throws.** Everything comes back as `page`/`jsonResult` or `failedResult`,
 *    because an exception escaping into the MCP SDK becomes a protocol error rather than something
 *    a model can read.
 *
 * **Two failures a model must be able to tell apart, and they already read differently.**
 * `ConnectionUnavailableError: WhatsApp connection unavailable: …` means WhatsApp is down and the
 * reads still work; `ApiUnreachableError: could not reach the API at <base>` means this process
 * cannot find its own backend and *nothing* works. `describeError` renders each class's own name,
 * which is what keeps them distinct without a mapping table here — the SDK's taxonomy is what pins
 * the two names, and `errors.test.ts` is what holds them to it.
 *
 * Nothing here interprets a JID (Global Constraint 11): `chat` and `sender` go to the API verbatim
 * and `canonicalId` is applied there, at the one boundary allowed to apply it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MESSAGE_KINDS } from "whatsapp-api-sdk";
import { z } from "zod";

import type { ToolContext } from "../context.js";
import { fetchApiHealth } from "../health.js";
import {
  failedResult,
  jsonResult,
  page,
  presentChat,
  presentContact,
  presentMessage,
  presentSearchHit,
} from "../result.js";

const OFFLINE = "Reads the local SQLite store only, so it answers offline, while the WhatsApp connection is down.";

const limitSchema = z
  .number()
  .int()
  .positive()
  .max(200)
  .default(50)
  .describe("Maximum rows to return, 1-200. Defaults to 50.");

const cursorSchema = z
  .string()
  .optional()
  .describe("Opaque `next_cursor` from a previous page. Omit for the first page.");

const READ_ONLY_TOOL = { readOnlyHint: true, openWorldHint: false } as const;

/**
 * The narrowing arguments `whatsapp_messages_list` and `whatsapp_messages_search` both take.
 *
 * Shared so the two tools cannot answer the same question differently — the same reason the API
 * shares one `messageFilterShape` between its two message routes.
 */
const messageFilterShape = {
  chat: z.string().min(1).optional().describe("Chat JID, as returned by whatsapp_chats_list. Omit for every chat."),
  sender: z.string().min(1).optional().describe("Sender JID. In a group this is the participant."),
  from_me: z.boolean().optional().describe("True for messages this account sent, false for received ones."),
  kind: z.enum(MESSAGE_KINDS).optional().describe("Restrict to one kind of message, e.g. image or audio."),
  has_media: z
    .boolean()
    .optional()
    .describe("True for messages carrying an attachment (image, video, audio, document, sticker), false for none."),
  after: z.number().int().optional().describe("Oldest timestamp to include, Unix seconds UTC, inclusive."),
  before: z.number().int().optional().describe("Newest timestamp to include, Unix seconds UTC, inclusive."),
};

/**
 * Only two of these seven are spelled differently on the wire, and both tools rename them inline —
 * `{ ...filter, fromMe: from_me, hasMedia: has_media }` — rather than through a shared mapper. Five
 * keys that already agree travel by spread, so there is nothing to keep in step, and the two that
 * do not are renamed next to the argument they came from.
 *
 * The `kind`/`has_media` contradiction — `kind: "text"` with `has_media: true` asks for a text
 * message carrying an attachment — is **not** checked here any more. The API refuses it, with the
 * same `contradicts kind="…"` sentence a model has always read, because it is the layer that knows
 * which kinds carry media and a second copy of that list here is a second thing to keep in step.
 */

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "whatsapp_health",
    {
      description:
        "WhatsApp server health: connection state, whether pairing is needed, seconds since the last socket " +
        `event, row counts in the local store, schema version, and whether transcription can run. ${OFFLINE} ` +
        "`ok` is false only when the account has been logged out, which needs a human to re-pair.",
      inputSchema: {},
      annotations: READ_ONLY_TOOL,
    },
    async () => {
      try {
        // The API's own report plus one `api` object saying whether this process could reach it —
        // and `ok` is left exactly as the API set it. See `health.ts`: making `ok` also mean "and
        // the API answered" would redefine a field whose own description above rules that out.
        const health = await fetchApiHealth(ctx);
        // No report means no report. Fabricating a `connection`, a `counts` or a `schema_version`
        // the API never sent would invent state a model then reasons about, so the failure is what
        // is reported — as an `isError`, which is how every other tool reports one.
        if (health.kind === "failure") return failedResult("whatsapp_health", health.error, ctx);
        return jsonResult(health.report, ctx.config.maxResultChars);
      } catch (err) {
        return failedResult("whatsapp_health", err, ctx);
      }
    },
  );

  server.registerTool(
    "whatsapp_chats_list",
    {
      description:
        "List WhatsApp chats — direct messages and groups — most recently active first, with their unread " +
        `counts, archive and mute state. ${OFFLINE}`,
      inputSchema: {
        query: z.string().min(1).optional().describe("Case-insensitive substring of the chat name."),
        is_group: z.boolean().optional().describe("True for groups only, false for direct messages only."),
        archived: z.boolean().optional().describe("Restrict to archived (true) or unarchived (false) chats."),
        unread_only: z.boolean().optional().describe("Only chats with at least one unread message."),
        limit: limitSchema,
        cursor: cursorSchema,
      },
      annotations: READ_ONLY_TOOL,
    },
    async ({ query, is_group, archived, unread_only, limit, cursor }) => {
      try {
        const res = await ctx.client.listChats({
          query: { query, isGroup: is_group, archived, unread: unread_only, limit, cursor },
        });
        return page(res.items.map(presentChat), res.nextCursor, ctx);
      } catch (err) {
        return failedResult("whatsapp_chats_list", err, ctx);
      }
    },
  );

  server.registerTool(
    "whatsapp_groups_list",
    {
      description:
        "List WhatsApp group chats only, most recently active first, with their participant counts. " + OFFLINE,
      inputSchema: { limit: limitSchema, cursor: cursorSchema },
      annotations: READ_ONLY_TOOL,
    },
    async ({ limit, cursor }) => {
      try {
        const res = await ctx.client.listGroups({ query: { limit, cursor } });
        return page(res.items.map(presentChat), res.nextCursor, ctx);
      } catch (err) {
        return failedResult("whatsapp_groups_list", err, ctx);
      }
    },
  );

  server.registerTool(
    "whatsapp_messages_list",
    {
      description:
        "List stored WhatsApp messages, newest first unless `asc` is set, with sender names resolved from " +
        `contacts and a count of the reactions each one carries. Deleted messages are omitted. ${OFFLINE}`,
      inputSchema: {
        ...messageFilterShape,
        asc: z.boolean().optional().describe("Oldest first. Use it to read a chat forwards from `after`."),
        limit: limitSchema,
        cursor: cursorSchema,
      },
      annotations: READ_ONLY_TOOL,
    },
    async ({ asc, limit, cursor, from_me, has_media, ...filter }) => {
      try {
        const res = await ctx.client.listMessages({
          query: { ...filter, fromMe: from_me, hasMedia: has_media, asc, limit, cursor },
        });
        return page(res.items.map(presentMessage), res.nextCursor, ctx);
      } catch (err) {
        return failedResult("whatsapp_messages_list", err, ctx);
      }
    },
  );

  server.registerTool(
    "whatsapp_messages_search",
    {
      description:
        "Full-text search over stored WhatsApp message text and over voice-note transcripts, best matches " +
        "first. Each hit carries a snippet and `matched_transcript`, which is true when the words were found " +
        `in a transcription rather than in typed text. ${OFFLINE}`,
      inputSchema: {
        query: z.string().min(1).describe("Words to look for. Treated as literal text, not as a query language."),
        ...messageFilterShape,
        limit: limitSchema,
        cursor: cursorSchema,
      },
      annotations: READ_ONLY_TOOL,
    },
    async ({ query, limit, cursor, from_me, has_media, ...filter }) => {
      try {
        const res = await ctx.client.searchMessages({
          query: { q: query, ...filter, fromMe: from_me, hasMedia: has_media, limit, cursor },
        });
        return page(res.items.map(presentSearchHit), res.nextCursor, ctx);
      } catch (err) {
        return failedResult("whatsapp_messages_search", err, ctx);
      }
    },
  );

  server.registerTool(
    "whatsapp_contacts_search",
    {
      description:
        "Search stored WhatsApp contacts by name, by the push name they broadcast, or by phone number. " + OFFLINE,
      inputSchema: {
        query: z.string().min(1).describe("Case-insensitive substring of a name, push name or phone number."),
        limit: limitSchema,
        cursor: cursorSchema,
      },
      annotations: READ_ONLY_TOOL,
    },
    async ({ query, limit, cursor }) => {
      try {
        // `GET /v1/contacts` takes an optional term because a UI wants the unfiltered listing; this
        // tool keeps the stricter `.min(1)`, exactly as it always has, because an empty search term
        // from a model is a mistake rather than a request for every contact.
        const res = await ctx.client.listContacts({ query: { query, limit, cursor } });
        return page(res.items.map(presentContact), res.nextCursor, ctx);
      } catch (err) {
        return failedResult("whatsapp_contacts_search", err, ctx);
      }
    },
  );
}
