/**
 * The domain resources the API serves.
 *
 * Denormalised on purpose (spec §4.1): `sender.name`, `Chat.name` and `reactionCount` are resolved
 * server-side because in-process they cost a function call and across HTTP a naive port costs fifty
 * round trips per page. A client cannot issue one request per row, so the row carries what it needs.
 *
 * Every timestamp here is integer **Unix seconds**. Only a `*Ms` name carries milliseconds, and
 * nothing in this file has one.
 */

import { z } from "zod";

/**
 * Every kind a stored message can have. Mirrors `packages/api`'s `MESSAGE_KINDS`, as a value rather
 * than only a type, because both the API's filters and the MCP's advertised enum need the list at
 * runtime.
 */
export const MESSAGE_KINDS = [
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contact",
  "system",
  "other",
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** The states the WhatsApp socket reports. Mirrors `packages/api`'s `ConnectionState`. */
export const CONNECTION_STATES = ["disconnected", "connecting", "pairing", "connected", "logged_out"] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

/**
 * A message row as a listing or a search returns it.
 *
 * Deliberately **without** the per-reactor list: embedding it costs one query per row, and a list
 * view needs only whether anyone reacted. `reactionCount` is filled for a whole page by one grouped
 * query; `MessageDetail` below carries the full array for the single-message path.
 */
export const Message = z.object({
  id: z.string(),
  chat: z.string(),
  ts: z.number().int(),
  fromMe: z.boolean(),
  sender: z.object({ id: z.string(), name: z.string() }),
  kind: z.enum(MESSAGE_KINDS),
  text: z.string().nullable(),
  transcript: z.string().nullable(),
  quotedId: z.string().nullable(),
  /**
   * Nullable, and this is a deliberate divergence from the plan's `z.string()`.
   *
   * `MessageRow.status` is `string | null` (`db/messages.ts:34`, `:167`, and `:398` writes
   * `m.status ?? null`) and `presentMessage` passes it through unmodified (`mcp/result.ts:135`), so
   * today's tool output already contains `"status": null` for any row WhatsApp never sent a receipt
   * for. A non-nullable schema could only accept that by inventing a placeholder, which changes
   * what the model reads; nullable accepts every value the plan's version does, plus the one the
   * data actually produces.
   */
  status: z.string().nullable(),
  edited: z.boolean(),
  deleted: z.boolean(),
  media: z.object({ type: z.string().nullable(), cached: z.boolean() }).nullable(),
  reactionCount: z.number().int(),
});

export type Message = z.infer<typeof Message>;

/** A `Message` plus what made it a hit: the excerpt, and whether the transcript is what matched. */
export const SearchHit = Message.extend({ snippet: z.string(), matchedTranscript: z.boolean() });

export type SearchHit = z.infer<typeof SearchHit>;

export const Reaction = z.object({ emoji: z.string(), from: z.object({ id: z.string(), name: z.string() }) });

export type Reaction = z.infer<typeof Reaction>;

/**
 * The single-message shape, and the reason it exists: `whatsapp_download_media`'s summary embeds the
 * FULL per-reactor list via `presentReactions`, not the batched `reactionCount` that list and search
 * use. A `getMessage` returning only `Message` would silently drop that array and change the tool's
 * output. Both fields stay: `reactionCount` so the shape is a superset of `Message`, `reactions` for
 * the detail path.
 *
 * Declared after `Reaction` on purpose: a `const` binding is in the temporal dead zone until it is
 * initialised, so referencing `Reaction` above its declaration is a runtime `ReferenceError`, not a
 * hoisting nicety. Order matters in this file.
 */
export const MessageDetail = Message.extend({ reactions: z.array(Reaction) });

export type MessageDetail = z.infer<typeof MessageDetail>;

/**
 * `name` follows today's `chatName()` fallback: a DM with no chat name of its own resolves to the
 * contact's display name, and reports `null` rather than echoing the JID back — a phone number is
 * not a name, and printing one as though it were is how a model addresses someone by their number.
 */
export const Chat = z.object({
  id: z.string(),
  name: z.string().nullable(),
  isGroup: z.boolean(),
  lastMessageTs: z.number().int().nullable(),
  unreadCount: z.number().int(),
  archived: z.boolean(),
  mutedUntil: z.number().int().nullable(),
  participantCount: z.number().int().nullable(),
});

export type Chat = z.infer<typeof Chat>;

export const Contact = z.object({
  id: z.string(),
  name: z.string().nullable(),
  notify: z.string().nullable(),
  phoneNumber: z.string().nullable(),
  lid: z.string().nullable(),
});

export type Contact = z.infer<typeof Contact>;

/**
 * `/health` is the one payload that is **not** camelCased.
 *
 * It is today's `HealthReport` verbatim, snake_case keys and all, because `whatsapp_health` hands it
 * to the model unchanged and those exact keys are part of what the split must not alter. There is no
 * camelCase mirror and no rename-back step anywhere: the SDK simply types the shape that exists.
 */
export const HealthReport = z.object({
  ok: z.boolean(),
  connection: z.enum(CONNECTION_STATES),
  needs_pairing: z.boolean(),
  last_event_age_sec: z.number().int(),
  last_connected_at: z.number().int().nullable(),
  last_message_at: z.number().int().nullable(),
  self_id: z.string().nullable(),
  counts: z.object({ chats: z.number().int(), messages: z.number().int(), contacts: z.number().int() }),
  schema_version: z.number().int(),
  transcription_available: z.boolean(),
  /** `null`, not an all-zero object, when the deployment runs no background lane: "off" and "idle" are different answers. */
  auto_transcribe: z
    .object({
      enabled: z.boolean(),
      queued: z.number().int(),
      in_flight: z.number().int(),
      transcribed_last_hour: z.number().int(),
      budget_day: z.string(),
      budget_spent_usd: z.number(),
      budget_usd: z.number(),
      budget_exhausted: z.boolean(),
    })
    .nullable(),
  read_only: z.boolean(),
});

export type HealthReport = z.infer<typeof HealthReport>;

/**
 * The contract revision this SDK build speaks.
 *
 * An integer the SDK owns, bumped whenever a route, a schema or an error code changes shape. Both
 * images embed their own copy: the API publishes the value from the SDK it was built against, and
 * the client compares it against the value from the SDK *it* was built against. Two matching numbers
 * mean the two builds agree; a mismatch is caught once, at session build, with an explicit
 * version-skew message — rather than as a pile of Zod parse errors at the boundary that reach the
 * model as noise about fields it never asked for.
 */
export const CONTRACT_VERSION = 1;

/**
 * What the API can do, and what the client is allowed to assume.
 *
 * `contractVersion` and `maxUploadBytes` are enforcement, not reporting: the first is compared at
 * session build, the second lets the MCP refuse an oversized upload against the API's real limit
 * instead of a second copy of the number that can drift out of step with it.
 */
export const Capabilities = z.object({
  apiVersion: z.string(),
  contractVersion: z.number().int(),
  readOnly: z.boolean(),
  maxUploadBytes: z.number().int(),
  features: z.object({ transcription: z.boolean(), autoTranscribe: z.boolean(), mediaLinks: z.boolean() }),
});

export type Capabilities = z.infer<typeof Capabilities>;
