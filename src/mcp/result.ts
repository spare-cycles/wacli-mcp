/**
 * How a tool hands something back to the model: MCP content blocks, bounded in size, plus the two
 * row shapers every read tool funnels its rows through.
 *
 * Three rules, each of which exists because the alternative is expensive in a model's context.
 *
 * 1. **Every payload is capped.** A chat with a decade of history is one `wa_messages_list` away
 *    from filling a context window; `jsonResult` truncates and says how much it cut, so the model
 *    can narrow the request instead of silently reading a prefix it believes is the whole answer.
 * 2. **An error is one line, never a stack.** Stack frames name files the model cannot open and
 *    push out the part of the conversation that mattered.
 * 3. **Row shaping happens here and nowhere else,** so `wa_messages_list` and `wa_messages_search`
 *    cannot drift into two different message shapes.
 */

import type { ChatRow } from "../db/chats.js";
import type { ContactRow } from "../db/contacts.js";
import type { MessageRow } from "../db/messages.js";
import type { ReactionRow } from "../db/reactions.js";
import type { ToolContext } from "./context.js";

export type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type ToolResult = { content: Block[]; isError?: boolean };

/**
 * JSON, pretty-printed, truncated to `maxChars` with a note naming the true total length.
 *
 * The wording is carried over verbatim from the server this one replaces: it tells the model both
 * what happened and what to do about it, which a bare "…" does not.
 */
export function jsonResult(data: unknown, maxChars: number): ToolResult {
  // `JSON.stringify` is *typed* as returning `string`, but really answers `undefined` for
  // `undefined`. Taking the declared type at face value turns "a tool returned nothing" into a
  // TypeError on `.length` that kills the whole call.
  const full = data === undefined ? "null" : JSON.stringify(data, null, 2);
  const text =
    full.length > maxChars
      ? full.slice(0, maxChars) +
        `\n\n…[truncated: ${full.length} chars total, showing first ${maxChars}. ` +
        `Narrow the request with a smaller "limit" or more filters.]`
      : full;
  return { content: [{ type: "text", text }] };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** An `isError` result carrying one readable line. Never a stack trace — see rule 2 above. */
export function errorResult(err: unknown): ToolResult {
  return { content: [{ type: "text", text: describeError(err) }], isError: true };
}

/** The one line an error is worth: its name and message, or a safe rendering of a non-Error throw. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message === "" ? err.name : `${err.name}: ${err.message}`;
  if (typeof err === "string") return err === "" ? "unknown error" : err;
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") return String(err);
  return "unknown error";
}

/**
 * A message row shaped for the model: resolved sender, media flags, edit/delete state.
 *
 * Deliberately **without** reactions. Embedding them costs one query per row — fifty extra queries
 * for a default page — and a list view does not need the emoji, only whether anyone reacted. List
 * and search results carry `reaction_count`, filled for the whole page by one grouped query;
 * `presentReactions` below shapes the full form for the single-message tools.
 */
export function presentMessage(m: MessageRow, ctx: ToolContext): Record<string, unknown> {
  return {
    id: m.id,
    chat: m.chatId,
    ts: m.ts,
    from_me: m.fromMe,
    sender: { id: m.senderId, name: ctx.contacts.displayName(m.senderId) },
    kind: m.kind,
    text: m.text,
    transcript: m.transcript,
    quoted_id: m.quotedId,
    status: m.status,
    edited: m.editedTs !== null,
    deleted: m.deletedTs !== null,
    media: m.mediaType === null && m.mediaSha === null ? null : { type: m.mediaType, cached: m.mediaSha !== null },
  };
}

/** The full reaction shape, for single-message contexts only. */
export function presentReactions(rs: readonly ReactionRow[], ctx: ToolContext): Record<string, unknown>[] {
  return rs.map((r) => ({ emoji: r.emoji, from: { id: r.senderId, name: ctx.contacts.displayName(r.senderId) } }));
}

export function presentChat(c: ChatRow, ctx: ToolContext): Record<string, unknown> {
  return {
    id: c.id,
    name: chatName(c, ctx),
    is_group: c.isGroup,
    last_message_ts: c.lastMessageTs,
    unread_count: c.unreadCount,
    archived: c.archived,
    muted_until: c.mutedUntil,
    participant_count: c.participantCount,
  };
}

export function presentContact(c: ContactRow): Record<string, unknown> {
  return { id: c.id, name: c.name, notify: c.notify, phone_number: c.phoneNumber, lid: c.lid };
}

/**
 * A DM's chat row often carries no name of its own while the contact behind it does, so fall back to
 * the contact. `displayName` answers with the JID when it knows nothing, which is already `id` here —
 * report `null` instead of repeating it, so "unnamed" is distinguishable from "named after its JID".
 */
function chatName(c: ChatRow, ctx: ToolContext): string | null {
  if (c.name !== null) return c.name;
  if (c.isGroup) return null;
  const resolved = ctx.contacts.displayName(c.id);
  return resolved === c.id ? null : resolved;
}
