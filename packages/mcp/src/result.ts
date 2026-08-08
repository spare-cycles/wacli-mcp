/**
 * How a tool hands something back to the model: MCP content blocks, bounded in size, plus the row
 * shapers every read tool funnels its rows through.
 *
 * Three rules, each of which exists because the alternative is expensive in a model's context.
 *
 * 1. **Every payload is capped.** A chat with a decade of history is one `whatsapp_messages_list` away
 *    from filling a context window; `jsonResult` truncates and says how much it cut, so the model
 *    can narrow the request instead of silently reading a prefix it believes is the whole answer.
 * 2. **An error is one line, never a stack.** Stack frames name files the model cannot open and
 *    push out the part of the conversation that mattered.
 * 3. **Row shaping happens here and nowhere else,** so `whatsapp_messages_list` and `whatsapp_messages_search`
 *    cannot drift into two different message shapes.
 *
 * **This file is where byte-identical output is won or lost.** The `present*` functions take SDK
 * domain objects — camelCase, and already denormalised by the API, which is why none of them needs a
 * contacts repository or a reaction count passed alongside — so their whole job is renaming into the
 * snake_case the model has always read. Every key below is pinned by `result.test.ts` against output
 * captured from the in-process server, as a *string* rather than a deep-equal, because key order is
 * part of what the model sees and structural equality cannot see it at all.
 */

import type { Chat, Contact, Message, Reaction, SearchHit } from "whatsapp-api-sdk";

import type { ToolContext } from "./context.js";
import { errorFields } from "./logger.js";

export type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type ToolResult = { content: Block[]; isError?: boolean };

/**
 * What a payload that had to be cut says about itself: how long the whole thing was, and how much of
 * it is really above.
 *
 * `shown` is what was actually emitted, never the cap that was asked for. The codepoint-safe cut
 * drops one further character whenever the boundary lands inside a surrogate pair, so a note built
 * from `maxChars` claims one more character than it delivered — exactly on the payloads where a
 * model might count on the number.
 */
function truncationNote(total: number, shown: number, advice: string): string {
  return `\n\n…[truncated: ${total} chars total, showing first ${shown}.${advice}]`;
}

const JSON_ADVICE =
  " The response was cut mid-JSON, so what is above is an incomplete document and will not parse " +
  'as it stands. Narrow the request with a smaller "limit" or more filters.';

/**
 * JSON, pretty-printed, truncated to `maxChars` with a note naming the true total length.
 *
 * The wording is carried over verbatim from the server this one replaces: it tells the model both
 * what happened and what to do about it, which a bare "…" does not.
 *
 * **It truncates from the end**, which makes the *order* of an envelope's keys load-bearing:
 * whatever is serialised last is what an oversized payload loses. `page` below is the one caller
 * that has to care, and it says why.
 */
export function jsonResult(data: unknown, maxChars: number): ToolResult {
  // `JSON.stringify` is *typed* as returning `string`, but really answers `undefined` for
  // `undefined`. Taking the declared type at face value turns "a tool returned nothing" into a
  // TypeError on `.length` that kills the whole call.
  const full = data === undefined ? "null" : JSON.stringify(data, null, 2);
  if (full.length <= maxChars) return { content: [{ type: "text", text: full }] };
  const shown = truncateToCodepoint(full, maxChars);
  return { content: [{ type: "text", text: shown + truncationNote(full.length, shown.length, JSON_ADVICE) }] };
}

/**
 * The first `maxChars` UTF-16 code units of `s`, minus a trailing half of a character.
 *
 * A plain `slice` cuts code units, and every emoji is two of them — so a boundary landing inside one
 * leaves a lone surrogate, which is not a character at all: it renders as a replacement glyph, and
 * re-encoding it (a JSON re-serialize, a transport that insists on well-formed UTF-8) mangles or
 * rejects it. Dropping the orphan costs one character and cannot produce one.
 */
function truncateToCodepoint(s: string, maxChars: number): string {
  const last = s.charCodeAt(maxChars - 1);
  // A high surrogate in the final position is the leading half of a pair whose trailing half is
  // being cut off. `charCodeAt` out of range answers NaN, which fails this test, so maxChars <= 0
  // needs no special case.
  const isOrphanedHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return s.slice(0, isOrphanedHighSurrogate ? maxChars - 1 : maxChars);
}

/**
 * Free text — a transcript, a PDF's contents, an instruction — under the same cap as everything else.
 *
 * `maxChars` is required rather than defaulted, because rule 1 above is "every payload is capped" and
 * an optional cap is one a caller forgets. A voice note is minutes of speech and a PDF is a document:
 * both are exactly as capable of filling a context window as a page of messages is, and the transcript
 * blocks used to be the one payload that escaped `WHATSAPP_MCP_MAX_RESULT_CHARS` entirely.
 */
export function textResult(text: string, maxChars: number): ToolResult {
  if (text.length <= maxChars) return { content: [{ type: "text", text }] };
  const shown = truncateToCodepoint(text, maxChars);
  return { content: [{ type: "text", text: shown + truncationNote(text.length, shown.length, "") }] };
}

/** An `isError` result carrying one readable line. Never a stack trace — see rule 2 above. */
export function errorResult(err: unknown): ToolResult {
  return { content: [{ type: "text", text: describeError(err) }], isError: true };
}

/**
 * The failure of one tool call: one line to the model, one line to the operator.
 *
 * The single choke point every handler's catch goes through, so that a `TypeError` in any of the
 * fourteen tools cannot be a thing only the model ever sees. The error object itself is never handed
 * to the logger — see `errorFields`.
 */
export function failedResult(tool: string, err: unknown, ctx: ToolContext): ToolResult {
  ctx.logger.warn({ ...errorFields(err), tool }, "tool: call failed");
  return errorResult(err);
}

/**
 * The one line an error is worth: its name and message, or a safe rendering of a non-Error throw.
 *
 * This is what renders an SDK error into model-visible text, which is why the taxonomy pins each
 * class's `name` rather than leaving it to the constructor: `ConnectionUnavailableError: WhatsApp
 * connection unavailable` is the sentence the model has been reading since before the split, and it
 * comes out of here unchanged even though the class behind it is now `NotConnectedError`.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message === "" ? err.name : `${err.name}: ${err.message}`;
  if (typeof err === "string") return err === "" ? "unknown error" : err;
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") return String(err);
  return "unknown error";
}

/**
 * The `{ next_cursor, items }` envelope every paginated tool answers with.
 *
 * `next_cursor` is serialized **before** `items` on purpose. `jsonResult` truncates from the end, so
 * whatever is last is what a page over `maxResultChars` loses — and with `items` first, the one field
 * that is always lost is the cursor. That breaks the pagination round trip on exactly the pages that
 * need it most, on top of the JSON already being cut short. This way the caller can still read where
 * to continue from, and the truncation note tells it what happened.
 *
 * A `deepEqual` test cannot defend this: structural equality is blind to key order. It is defended
 * by a test that reads the cursor back out of the *serialized* string of a page that was truncated.
 */
export function page(items: Record<string, unknown>[], nextCursor: string | null, ctx: ToolContext): ToolResult {
  return jsonResult({ next_cursor: nextCursor, items }, ctx.config.maxResultChars);
}

/**
 * A message row shaped for the model: resolved sender, media flags, edit/delete state.
 *
 * Deliberately **without** the per-reactor list. Embedding it costs the API one query per row, and a
 * list view does not need the emoji, only whether anyone reacted — which is what `reaction_count`
 * carries, filled for a whole page by one grouped query server-side. `presentReactions` below shapes
 * the full form for the single-message tools.
 *
 * `reaction_count` is the field this rename is most likely to lose, because in the in-process server
 * it was not part of `presentMessage` at all: the list and search paths spread it in afterwards.
 * `Message` carries it, so here it is a rename like every other key — and it is last, which is where
 * those two paths put it.
 */
export function presentMessage(m: Message): Record<string, unknown> {
  return {
    id: m.id,
    chat: m.chat,
    ts: m.ts,
    from_me: m.fromMe,
    sender: { id: m.sender.id, name: m.sender.name },
    kind: m.kind,
    text: m.text,
    transcript: m.transcript,
    quoted_id: m.quotedId,
    status: m.status,
    edited: m.edited,
    deleted: m.deleted,
    media: m.media === null ? null : { type: m.media.type, cached: m.media.cached },
    reaction_count: m.reactionCount,
  };
}

/**
 * A search hit: a message, plus what made it a hit.
 *
 * The two extra keys go *after* `reaction_count` and not before, because that is the order the
 * in-process search path built them in.
 */
export function presentSearchHit(h: SearchHit): Record<string, unknown> {
  return { ...presentMessage(h), snippet: h.snippet, matched_transcript: h.matchedTranscript };
}

/**
 * The full reaction shape, for single-message contexts only.
 *
 * Rebuilt key by key rather than passed through, even though `Reaction` is already
 * `{ emoji, from: { id, name } }`: a field added to the SDK schema would otherwise widen this tool's
 * output without anyone deciding that it should.
 */
export function presentReactions(rs: readonly Reaction[]): Record<string, unknown>[] {
  return rs.map((r) => ({ emoji: r.emoji, from: { id: r.from.id, name: r.from.name } }));
}

/**
 * A chat row shaped for the model.
 *
 * `name` arrives resolved: the DM-falls-back-to-the-contact rule that used to live beside this
 * function is the API's now, because a client cannot resolve a name it was never sent.
 */
export function presentChat(c: Chat): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    is_group: c.isGroup,
    last_message_ts: c.lastMessageTs,
    unread_count: c.unreadCount,
    archived: c.archived,
    muted_until: c.mutedUntil,
    participant_count: c.participantCount,
  };
}

export function presentContact(c: Contact): Record<string, unknown> {
  return { id: c.id, name: c.name, notify: c.notify, phone_number: c.phoneNumber, lid: c.lid };
}
