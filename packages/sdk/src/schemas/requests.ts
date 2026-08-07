/**
 * Every query and body schema the route table names.
 *
 * Two properties make this file more than a list of fields.
 *
 * **Query schemas coerce; body schemas do not.** A body arrives as parsed JSON, so `false` is a
 * boolean and `5` is a number on both sides of the wire. A query string carries neither type: the
 * server sees `"false"` and `"5"`, and a plain `z.boolean()` would refuse every query the client
 * ever sends. So each query field is declared through one of the `*Param` helpers below, whose
 * *output* type is the value both sides work with and whose *input* accepts the string form the URL
 * carries. That keeps one schema honest for the client (validating before send) and the server
 * (parsing what Express handed it) instead of two that can drift.
 *
 * **No `limit` default lives here.** `.default(50)` would make `limit` a *required* field of
 * `z.infer`, and the generated client method types its `query` argument with exactly that — so
 * `client.listChats({ query: {} })` would stop compiling and every caller would have to restate a
 * default it does not care about. The default belongs to the handler, which is also where the
 * ceiling that goes with it is enforced.
 */

import { z } from "zod";

import { epochSeconds } from "./common.js";
import { MESSAGE_KINDS } from "./domain.js";
import { MediaRepresentation } from "./media.js";

/**
 * A boolean query parameter.
 *
 * Not `z.coerce.boolean()`, which is `Boolean(v)` and therefore reads `"false"` as **true** — the
 * one value a boolean flag most needs to get right. Only the two canonical spellings are accepted;
 * anything else falls through unchanged and is refused by `z.boolean()`, so `?archived=yes` is a
 * 400 rather than a silent `true`.
 */
const booleanParam = z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean());

/** A non-negative integer query parameter, bounded by the caller. */
const intParam = z.coerce.number().int();

/**
 * A timestamp query parameter, reached through the shared `epochSeconds` rather than a second
 * `.int().lt(1e11)` written out here. The bound is the contract's, not this filter's.
 */
const epochParam = z.coerce.number().pipe(epochSeconds);

/** The two fields every paginated route takes. */
const pageShape = {
  /**
   * 1-200. No default: see the file note. The handler applies 50, matching the MCP tool schema's
   * `limitSchema`, which is where the number a model reads is advertised.
   */
  limit: intParam.positive().max(200).optional(),
  /** An opaque `nextCursor` from a previous page. Nothing but the API may decode it. */
  cursor: z.string().min(1).optional(),
} as const;

export const PageQuery = z.object(pageShape);

export type PageQuery = z.infer<typeof PageQuery>;

/** `GET /v1/chats`. Spec §4's four filters, plus the page. */
export const ChatQuery = z.object({
  ...pageShape,
  query: z.string().min(1).optional(),
  isGroup: booleanParam.optional(),
  archived: booleanParam.optional(),
  unread: booleanParam.optional(),
});

export type ChatQuery = z.infer<typeof ChatQuery>;

/**
 * `GET /v1/groups`. The page and nothing else: the route *is* the filter, and `whatsapp_groups_list`
 * advertises `limit` and `cursor` alone.
 */
export const GroupQuery = PageQuery;

export type GroupQuery = z.infer<typeof GroupQuery>;

/**
 * `GET /v1/contacts`.
 *
 * `query` is optional here although `whatsapp_contacts_search` requires it: the underlying
 * `contacts.search` builds a `LIKE '%…%'`, so an absent term is a well-defined "every contact" and
 * the route is a listing that a UI wants unfiltered. The tool keeps its stricter schema.
 */
export const ContactQuery = z.object({ ...pageShape, query: z.string().min(1).optional() });

export type ContactQuery = z.infer<typeof ContactQuery>;

/**
 * The narrowing both `GET /v1/messages` and `GET /v1/messages/search` accept.
 *
 * Shared so the two cannot answer the same question differently — the same reason
 * `messageFilterShape` is shared between the two MCP tools today. `kind` and `hasMedia` can
 * contradict each other (`kind: "text"` with `hasMedia: true`); that is refused by the handler with
 * `bad_request` rather than by a `.refine()` here, because the refusal names which pair clashed and
 * a schema-level rule could only say "invalid".
 */
const messageFilterShape = {
  chat: z.string().min(1).optional(),
  sender: z.string().min(1).optional(),
  fromMe: booleanParam.optional(),
  kind: z.enum(MESSAGE_KINDS).optional(),
  hasMedia: booleanParam.optional(),
  /** Oldest timestamp to include, inclusive. */
  after: epochParam.optional(),
  /** Newest timestamp to include, inclusive. */
  before: epochParam.optional(),
} as const;

/** `GET /v1/messages`. */
export const MessageQuery = z.object({
  ...pageShape,
  ...messageFilterShape,
  /** Oldest first. Newest first is the default, as it is today. */
  asc: booleanParam.optional(),
});

export type MessageQuery = z.infer<typeof MessageQuery>;

/**
 * `GET /v1/messages/search`.
 *
 * Carries no `asc`: hits come back by relevance, and an ordering knob on a ranked result would
 * promise something FTS5 does not deliver. `whatsapp_messages_search` advertises none either.
 */
export const SearchQuery = z.object({
  ...pageShape,
  ...messageFilterShape,
  /** Words to look for. Literal text, not a query language. */
  q: z.string().min(1),
});

export type SearchQuery = z.infer<typeof SearchQuery>;

/** `:chat/:id` — the two path segments that name one message. */
export const MessageParams = z.object({ chat: z.string().min(1), id: z.string().min(1) });

export type MessageParams = z.infer<typeof MessageParams>;

/** `:chat` alone. */
export const ChatParams = z.object({ chat: z.string().min(1) });

export type ChatParams = z.infer<typeof ChatParams>;

/** `:token` — the encrypted, self-describing media token. Opaque to everything but the signer. */
export const TokenParams = z.object({ token: z.string().min(1) });

export type TokenParams = z.infer<typeof TokenParams>;

/** How a served attachment is presented. The API overrides `inline` for anything off its allowlist. */
export const Disposition = z.enum(["inline", "attachment"]);

export type Disposition = z.infer<typeof Disposition>;

/** `GET /v1/media/:chat/:id`. */
export const MediaRawQuery = z.object({ disposition: Disposition.optional() });

export type MediaRawQuery = z.infer<typeof MediaRawQuery>;

/**
 * `GET /v1/media/:chat/:id/jpeg`. Both bounds are optional; the API's configured values are the
 * defaults *and* the ceilings, so a client cannot ask for a larger derivative than the deployment
 * allows.
 */
export const MediaJpegQuery = z.object({
  maxBytes: intParam.positive().optional(),
  maxEdge: intParam.positive().optional(),
});

export type MediaJpegQuery = z.infer<typeof MediaJpegQuery>;

/**
 * Which representation a signed link points at.
 *
 * Narrower than `MediaRepresentation`, and derived from it rather than restated so the two cannot
 * drift: only the binary representations are worth an unauthenticated URL, and a token minted for a
 * JSON one would have no defined behaviour at a route that answers bytes.
 */
export const LinkTarget = MediaRepresentation.extract(["raw", "jpeg"]);

export type LinkTarget = z.infer<typeof LinkTarget>;

/** `GET /v1/media/:chat/:id/link`. */
export const MediaLinkQuery = z.object({ for: LinkTarget.optional() });

export type MediaLinkQuery = z.infer<typeof MediaLinkQuery>;

/** `GET /v1/media/:chat/:id/keyframes`. Same ceiling rule as `/jpeg`. */
export const MediaKeyframesQuery = z.object({
  frames: intParam.positive().optional(),
  maxBytes: intParam.positive().optional(),
});

export type MediaKeyframesQuery = z.infer<typeof MediaKeyframesQuery>;

/**
 * Who a send is addressed to.
 *
 * Deliberately more forgiving than the `:chat` path segment: the routes that take a message id got
 * their chat from a listing, while a send is the one place a caller starts from what a human said.
 * A name that matches several chats is refused with `ambiguous_recipient` and its numbered
 * candidates; `pick` settles it on the retry.
 */
const recipientShape = {
  recipient: z.string().min(1),
  pick: z.number().int().positive().optional(),
} as const;

/** `POST /v1/messages`. */
export const SendTextBody = z.object({
  ...recipientShape,
  text: z.string().min(1),
  replyTo: z.string().min(1).optional(),
  mentions: z.array(z.string().min(1)).optional(),
});

export type SendTextBody = z.infer<typeof SendTextBody>;

/**
 * `POST /v1/messages/file`.
 *
 * Flat, with `data` and `path` both optional, and **no `.refine()` pinning "exactly one of"**. The
 * rule is real but it is enforced where the two spellings of wrong can be named apart — passing
 * both, and passing neither are different mistakes with different advice — which is what
 * `fileSource` does today and what a schema-level `invalid_union` could not say.
 */
export const SendFileBody = z.object({
  ...recipientShape,
  /** The file's bytes, base64. */
  data: z.string().min(1).optional(),
  /** A file on the API host, under `WHATSAPP_SEND_FILE_DIR`. Refused unless that is configured. */
  path: z.string().min(1).optional(),
  filename: z.string().min(1).optional(),
  mimetype: z.string().min(1).optional(),
  caption: z.string().optional(),
  replyTo: z.string().min(1).optional(),
  asVoiceNote: z.boolean().optional(),
});

export type SendFileBody = z.infer<typeof SendFileBody>;

/** `PATCH /v1/messages/:chat/:id`. The replacement text in full — this is not a patch. */
export const EditMessageBody = z.object({ text: z.string().min(1) });

export type EditMessageBody = z.infer<typeof EditMessageBody>;

/**
 * `POST /v1/messages/:chat/:id/reaction`.
 *
 * `emoji` takes **no** `.min(1)`, and that is load-bearing: an empty string is how WhatsApp models
 * removing a reaction. The obvious improvement here silently deletes the removal path.
 */
export const ReactBody = z.object({ emoji: z.string() });

export type ReactBody = z.infer<typeof ReactBody>;

/**
 * `POST /v1/chats/:chat/read`.
 *
 * The id rides in the body rather than the path because the chat is what gets marked: everything at
 * or before this message's timestamp is acknowledged, not that message alone.
 */
export const MarkReadBody = z.object({ messageId: z.string().min(1) });

export type MarkReadBody = z.infer<typeof MarkReadBody>;

/** `POST /v1/recipients/resolve`. The same resolution a send performs, without sending anything. */
export const ResolveRecipientBody = z.object({ recipient: z.string().min(1) });

export type ResolveRecipientBody = z.infer<typeof ResolveRecipientBody>;
