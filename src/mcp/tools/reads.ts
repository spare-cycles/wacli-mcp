/**
 * The six read tools. Every one of them answers from SQLite alone: none calls `requireSocket`, so
 * all six keep working while the connection is down, mid-backoff, or logged out (Global Constraint
 * 13). Their descriptions say so, because that is the property a model needs to know when a write
 * tool has just failed.
 *
 * Three conventions are shared by all of them:
 *
 * 1. **Pagination is a round trip.** Every paginated tool answers `{ items, next_cursor }`, and a
 *    `next_cursor` is handed out only when a further page really has rows — the query over-fetches
 *    by one to find out. A cursor is opaque; a malformed one is an error, never a silent restart.
 * 2. **Reaction counts are one grouped query per page,** not one per row. The full reaction shapes
 *    belong to single-message tools.
 * 3. **A handler never throws.** Everything comes back as `jsonResult` or `failedResult`, because an
 *    exception escaping into the SDK becomes a protocol error rather than something a model can read.
 *    `failedResult` is `errorResult` plus a log line: a handler that answered the model and told the
 *    operator nothing makes a `TypeError` in here invisible to everyone who could fix it.
 *
 * This module imports nothing from `baileys` (Constraint 12) and interprets no JID itself — `chat`
 * and `sender` arguments go through `whatsapp/jid.ts`'s `canonicalId` (Constraint 11), the same way
 * `whatsapp/send.ts` treats them, so a chat named by its LID reaches the same rows as its phone JID.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChatListFilter } from "../../db/chats.js";
import {
  MEDIA_KINDS,
  MESSAGE_KINDS,
  type MessageFilter,
  type MessageListFilter,
  type MessageRow,
  type SearchHit,
} from "../../db/messages.js";
import { canonicalId } from "../../whatsapp/jid.js";
import type { ToolContext } from "../context.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import { buildHealth } from "../health.js";
import { failedResult, jsonResult, presentChat, presentContact, presentMessage, type ToolResult } from "../result.js";

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

/** One page of rows, plus the cursor onto the next one — `null` when this page is the last. */
type Page<T> = { rows: T[]; nextCursor: string | null };

/**
 * Run a paginated query.
 *
 * It asks for `limit + 1` rows and keeps `limit`. That one extra row is the difference between
 * "there may be more" and "there is more": the naive rule — a cursor whenever the page came back
 * full — hands out a cursor onto an empty page whenever the total is an exact multiple of the page
 * size, and a model that follows it reads an empty result as a bug.
 */
function paginate<T>(
  cursor: string | undefined,
  limit: number,
  fetch: (limit: number, offset: number) => T[],
): Page<T> {
  const offset = decodeCursor(cursor);
  const rows = fetch(limit + 1, offset);
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, nextCursor: hasMore ? encodeCursor(offset + limit) : null };
}

/**
 * The `{ next_cursor, items }` envelope every paginated tool answers with.
 *
 * `next_cursor` is serialized **before** `items` on purpose. `jsonResult` truncates from the end, so
 * whatever is last is what a page over `maxResultChars` loses — and with `items` first, the one field
 * that is always lost is the cursor. That breaks the pagination round trip on exactly the pages that
 * need it most, on top of the JSON already being cut short. This way the caller can still read where
 * to continue from, and the truncation note tells it what happened.
 */
function page(items: Record<string, unknown>[], nextCursor: string | null, ctx: ToolContext): ToolResult {
  return jsonResult({ next_cursor: nextCursor, items }, ctx.config.maxResultChars);
}

/**
 * `(chatId, messageId)` as one map key. A message id is only unique within its chat, so keying on
 * the id alone would let one chat's reaction count land on another chat's message in a search page.
 * The separator is an explicit escape rather than a literal control character: a raw NUL byte in a
 * source file makes the whole file read as binary to grep and to a diff viewer.
 */
function reactionKey(chatId: string, messageId: string): string {
  return `${chatId}\u0000${messageId}`;
}

/**
 * Reaction counts for a whole page, in **one** grouped query — one per page, not one per row and not
 * one per chat the page touches.
 *
 * The per-chat shape this replaced was fine for a list scoped to one chat and quietly awful for a
 * search: a 200-hit page spanning 200 chats issued 200 queries, which is the order of cost the
 * requirement exists to avoid.
 */
function reactionCounts(ctx: ToolContext, rows: readonly MessageRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (rows.length === 0) return counts;
  const keys = rows.map((row) => ({ chatId: row.chatId, messageId: row.id }));
  for (const c of ctx.reactions.countsFor(keys)) counts.set(reactionKey(c.chatId, c.messageId), c.count);
  return counts;
}

function presentMessagePage(rows: readonly MessageRow[], ctx: ToolContext): Record<string, unknown>[] {
  const counts = reactionCounts(ctx, rows);
  return rows.map((m) => ({ ...presentMessage(m, ctx), reaction_count: counts.get(reactionKey(m.chatId, m.id)) ?? 0 }));
}

function presentSearchPage(hits: readonly SearchHit[], ctx: ToolContext): Record<string, unknown>[] {
  const counts = reactionCounts(ctx, hits);
  return hits.map((h) => ({
    ...presentMessage(h, ctx),
    reaction_count: counts.get(reactionKey(h.chatId, h.id)) ?? 0,
    snippet: h.snippet,
    matched_transcript: h.matchedTranscript,
  }));
}

/** A caller-supplied JID, resolved to the id the store actually keys on. Undefined stays undefined. */
function resolveId(jid: string | undefined, ctx: ToolContext): string | undefined {
  return jid === undefined ? undefined : canonicalId(jid, ctx.contacts);
}

/**
 * The narrowing arguments `whatsapp_messages_list` and `whatsapp_messages_search` both take.
 *
 * Shared so the two tools cannot answer the same question differently. The old server put `type`,
 * `has_media`, `after` and `before` on search alone, which meant "photos Marie sent me in June" was
 * askable only if you also had a word to search for.
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

type MessageFilterArgs = { [K in keyof typeof messageFilterShape]: z.infer<(typeof messageFilterShape)[K]> };

/**
 * The filter those arguments describe, or a refusal naming the contradiction.
 *
 * `kind` and `has_media` can disagree — `kind: "text", has_media: true` asks for a text message with
 * an attachment. Answering that with an empty page reads as "there are none", which is a different
 * and wrong answer: a model that believes it would stop looking. Saying so is what the old server
 * did for its one instance of the clash, and this generalizes it to every kind.
 */
function messageFilter(args: MessageFilterArgs, ctx: ToolContext): MessageFilter {
  if (args.kind !== undefined && args.has_media !== undefined) {
    const carries = (MEDIA_KINDS as readonly string[]).includes(args.kind);
    if (carries !== args.has_media) {
      throw new Error(
        `has_media=${String(args.has_media)} contradicts kind="${args.kind}", which ` +
          `${carries ? "always carries" : "never carries"} an attachment — drop one of the two`,
      );
    }
  }
  return {
    chatId: resolveId(args.chat, ctx),
    senderId: resolveId(args.sender, ctx),
    fromMe: args.from_me,
    kind: args.kind,
    hasMedia: args.has_media,
    after: args.after,
    before: args.before,
  };
}

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
        return jsonResult(await buildHealth(ctx), ctx.config.maxResultChars);
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
    ({ query, is_group, archived, unread_only, limit, cursor }) => {
      try {
        const filter: ChatListFilter = { query, isGroup: is_group, archived, unreadOnly: unread_only };
        const { rows, nextCursor } = paginate(cursor, limit, (l, o) => ctx.chats.list(filter, l, o));
        return page(
          rows.map((c) => presentChat(c, ctx)),
          nextCursor,
          ctx,
        );
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
    ({ limit, cursor }) => {
      try {
        const filter: ChatListFilter = { isGroup: true };
        const { rows, nextCursor } = paginate(cursor, limit, (l, o) => ctx.chats.list(filter, l, o));
        return page(
          rows.map((c) => presentChat(c, ctx)),
          nextCursor,
          ctx,
        );
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
    ({ asc, limit, cursor, ...args }) => {
      try {
        const filter: MessageListFilter = { ...messageFilter(args, ctx), asc };
        const { rows, nextCursor } = paginate(cursor, limit, (l, o) => ctx.messages.list(filter, l, o));
        return page(presentMessagePage(rows, ctx), nextCursor, ctx);
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
    ({ query, limit, cursor, ...args }) => {
      try {
        const filter = messageFilter(args, ctx);
        const { rows, nextCursor } = paginate(cursor, limit, (l, o) => ctx.messages.search(query, filter, l, o));
        return page(presentSearchPage(rows, ctx), nextCursor, ctx);
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
    ({ query, limit, cursor }) => {
      try {
        const { rows, nextCursor } = paginate(cursor, limit, (l, o) => ctx.contacts.search(query, l, o));
        return page(rows.map(presentContact), nextCursor, ctx);
      } catch (err) {
        return failedResult("whatsapp_contacts_search", err, ctx);
      }
    },
  );
}
