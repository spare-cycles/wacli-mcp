/**
 * Database rows, as the wire types the contract names.
 *
 * **Denormalisation is the whole point** (spec §4.1). In process, a tool that wanted a sender's
 * display name or a message's reaction count could reach for it row by row and pay a function call.
 * Across HTTP a client cannot: one request per row turns a fifty-row page into fifty round trips,
 * so the row carries what a reader needs — `sender.name` resolved, `reactionCount` filled in.
 *
 * That makes the batching a property of the *signature* rather than of the implementation.
 * `presentMessage` takes an already-computed count and has no access to a reactions repo at all, so
 * there is no per-row query for a later change to reintroduce; `reactionCounts` is the one function
 * that talks to the repo, and it issues exactly one grouped query for a whole page.
 *
 * Row shaping lives here and nowhere else, so `listMessages` and `searchMessages` cannot drift into
 * two different message shapes.
 */

import type { Chat, Contact, Message, SearchHit } from "whatsapp-api-sdk";

import type { ChatRow } from "../db/chats.js";
import type { ContactRow, ContactsRepo } from "../db/contacts.js";
import type { MessageRow, SearchHit as SearchHitRow } from "../db/messages.js";
import type { ReactionsRepo } from "../db/reactions.js";

/** What a presenter is allowed to reach for: name resolution, and nothing else. */
export type PresentDeps = { contacts: ContactsRepo };

/**
 * `(chatId, messageId)` as one map key.
 *
 * A message id is unique only inside its own chat, so keying on the id alone lets one chat's
 * reaction count land on another chat's message — invisible in a single-chat listing and wrong in
 * every search page. The separator is an explicit escape rather than a literal control character: a
 * raw NUL byte in a source file makes the whole file read as binary to grep and to a diff viewer,
 * which this repository has already been bitten by once.
 */
export function reactionKey(chatId: string, messageId: string): string {
  return `${chatId}\u0000${messageId}`;
}

/**
 * Reaction counts for a whole page, in **one** grouped query — one per page, not one per row and
 * not one per chat the page touches.
 *
 * Messages with no reactions are absent from the result rather than present with a zero, so callers
 * read it with `?? 0`.
 */
export function reactionCounts(
  reactions: ReactionsRepo,
  rows: readonly { chatId: string; id: string }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  if (rows.length === 0) return counts;
  const keys = rows.map((row) => ({ chatId: row.chatId, messageId: row.id }));
  for (const c of reactions.countsFor(keys)) counts.set(reactionKey(c.chatId, c.messageId), c.count);
  return counts;
}

/**
 * A message row as a listing or a search returns it.
 *
 * Deliberately **without** the per-reactor list: embedding it costs one query per row, and a list
 * view needs only whether anyone reacted. `getMessage` answers `MessageDetail`, which carries the
 * full array, and builds it from `reactions.forMessage` for the one row it is about.
 */
export function presentMessage(m: MessageRow, deps: PresentDeps, reactionCount: number): Message {
  return {
    id: m.id,
    chat: m.chatId,
    ts: m.ts,
    fromMe: m.fromMe,
    sender: { id: m.senderId, name: deps.contacts.displayName(m.senderId) },
    kind: m.kind,
    text: m.text,
    transcript: m.transcript,
    quotedId: m.quotedId,
    status: m.status,
    // Booleans on the wire, not the timestamps behind them: nothing reads *when* a message was
    // edited, and a nullable stamp would be a second way to ask the same question.
    edited: m.editedTs !== null,
    deleted: m.deletedTs !== null,
    // `null` only when the row has neither a declared type nor cached bytes. A row can have one
    // without the other — an attachment fetched before its type was recorded, or a type recorded
    // for bytes never downloaded — and both are messages that carry media.
    media: m.mediaType === null && m.mediaSha === null ? null : { type: m.mediaType, cached: m.mediaSha !== null },
    reactionCount,
  };
}

/** A `Message` plus what made it a hit. The DB row is a superset of `MessageRow`; the wire type is not. */
export function presentSearchHit(h: SearchHitRow, deps: PresentDeps, reactionCount: number): SearchHit {
  return { ...presentMessage(h, deps, reactionCount), snippet: h.snippet, matchedTranscript: h.matchedTranscript };
}

export function presentChat(c: ChatRow, deps: PresentDeps): Chat {
  return {
    id: c.id,
    name: chatName(c, deps),
    isGroup: c.isGroup,
    lastMessageTs: c.lastMessageTs,
    unreadCount: c.unreadCount,
    archived: c.archived,
    mutedUntil: c.mutedUntil,
    participantCount: c.participantCount,
  };
}

export function presentContact(c: ContactRow): Contact {
  return { id: c.id, name: c.name, notify: c.notify, phoneNumber: c.phoneNumber, lid: c.lid };
}

/**
 * A DM's chat row often carries no name of its own while the contact behind it does, so fall back
 * to the contact. `displayName` answers with the JID when it knows nothing, which is already `id`
 * here — report `null` instead of repeating it, so "unnamed" stays distinguishable from "named
 * after its JID", and a model never addresses someone by their phone number.
 */
function chatName(c: ChatRow, deps: PresentDeps): string | null {
  if (c.name !== null) return c.name;
  if (c.isGroup) return null;
  const resolved = deps.contacts.displayName(c.id);
  return resolved === c.id ? null : resolved;
}
