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
 * 3. **A handler never throws.** Everything comes back as `jsonResult` or `errorResult`, because an
 *    exception escaping into the SDK becomes a protocol error rather than something a model can read.
 *
 * This module imports nothing from `baileys` (Constraint 12) and interprets no JID itself — `chat`
 * and `sender` arguments go through `wa/jid.ts`'s `canonicalId` (Constraint 11), the same way
 * `wa/send.ts` treats them, so a chat named by its LID reaches the same rows as its phone JID.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChatListFilter, ChatRow } from "../../db/chats.js";
import type { MessageListFilter, MessageRow, SearchHit } from "../../db/messages.js";
import { canonicalId } from "../../wa/jid.js";
import type { ToolContext } from "../context.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import { buildHealth } from "../health.js";
import { errorResult, jsonResult, presentChat, presentContact, presentMessage, type ToolResult } from "../result.js";

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

function page(items: Record<string, unknown>[], nextCursor: string | null, ctx: ToolContext): ToolResult {
  return jsonResult({ items, next_cursor: nextCursor }, ctx.config.maxResultChars);
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
 * Reaction counts for a whole page, in one grouped query per distinct chat.
 *
 * A list scoped to one chat therefore costs exactly one query; a cross-chat search costs one per
 * chat it touched. Either way it is not one per row, which for a default page would be fifty.
 */
function reactionCounts(ctx: ToolContext, rows: readonly MessageRow[]): Map<string, number> {
  const idsByChat = new Map<string, string[]>();
  for (const row of rows) {
    const existing = idsByChat.get(row.chatId);
    if (existing === undefined) idsByChat.set(row.chatId, [row.id]);
    else existing.push(row.id);
  }

  const counts = new Map<string, number>();
  for (const [chatId, messageIds] of idsByChat) {
    for (const [messageId, n] of ctx.reactions.countsFor(chatId, messageIds)) {
      counts.set(reactionKey(chatId, messageId), n);
    }
  }
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

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "wa_health",
    {
      description:
        "WhatsApp server health: connection state, whether pairing is needed, seconds since the last socket " +
        `event, row counts in the local store, schema version, and whether transcription can run. ${OFFLINE} ` +
        '`ok` is false only when the account has been logged out, which needs a human to re-pair."',
      inputSchema: {},
      annotations: READ_ONLY_TOOL,
    },
    async () => {
      try {
        return jsonResult(await buildHealth(ctx), ctx.config.maxResultChars);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "wa_chats_list",
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
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "wa_groups_list",
    {
      description:
        "List WhatsApp group chats only, most recently active first, with their participant counts. " + OFFLINE,
      inputSchema: { limit: limitSchema, cursor: cursorSchema },
      annotations: READ_ONLY_TOOL,
    },
    ({ limit, cursor }) => {
      try {
        const filter: ChatListFilter = { isGroup: true };
        const { rows, nextCursor } = paginate<ChatRow>(cursor, limit, (l, o) => ctx.chats.list(filter, l, o));
        return page(
          rows.map((c) => presentChat(c, ctx)),
          nextCursor,
          ctx,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "wa_messages_list",
    {
      description:
        "List stored WhatsApp messages, newest first, with sender names resolved from contacts and a count " +
        `of the reactions each one carries. Deleted messages are omitted. ${OFFLINE}`,
      inputSchema: {
        chat: z.string().min(1).optional().describe("Chat JID, as returned by wa_chats_list. Omit for every chat."),
        sender: z.string().min(1).optional().describe("Sender JID. In a group this is the participant."),
        from_me: z.boolean().optional().describe("True for messages this account sent, false for received ones."),
        after: z.number().int().optional().describe("Oldest timestamp to include, Unix seconds UTC, inclusive."),
        before: z.number().int().optional().describe("Newest timestamp to include, Unix seconds UTC, inclusive."),
        limit: limitSchema,
        cursor: cursorSchema,
      },
      annotations: READ_ONLY_TOOL,
    },
    ({ chat, sender, from_me, after, before, limit, cursor }) => {
      try {
        const filter: MessageListFilter = {
          chatId: resolveId(chat, ctx),
          senderId: resolveId(sender, ctx),
          fromMe: from_me,
          after,
          before,
        };
        const { rows, nextCursor } = paginate(cursor, limit, (l, o) => ctx.messages.list(filter, l, o));
        return page(presentMessagePage(rows, ctx), nextCursor, ctx);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "wa_messages_search",
    {
      description:
        "Full-text search over stored WhatsApp message text and over voice-note transcripts, best matches " +
        "first. Each hit carries a snippet and `matched_transcript`, which is true when the words were found " +
        `in a transcription rather than in typed text. ${OFFLINE}`,
      inputSchema: {
        query: z.string().min(1).describe("Words to look for. Treated as literal text, not as a query language."),
        chat: z.string().min(1).optional().describe("Restrict the search to one chat JID."),
        limit: limitSchema,
        cursor: cursorSchema,
      },
      annotations: READ_ONLY_TOOL,
    },
    ({ query, chat, limit, cursor }) => {
      try {
        const opts = { chatId: resolveId(chat, ctx) };
        const { rows, nextCursor } = paginate(cursor, limit, (l, o) => ctx.messages.search(query, opts, l, o));
        return page(presentSearchPage(rows, ctx), nextCursor, ctx);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "wa_contacts_search",
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
        return errorResult(err);
      }
    },
  );
}
