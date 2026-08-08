/**
 * The six read routes. Every one of them answers from SQLite alone: none reaches for the socket, so
 * a listing, a search and a single message all keep working while the connection is down — the
 * property `mcp/tools/reads.ts` has always had and the one a model relies on when WhatsApp is
 * flapping.
 *
 * Three things live here rather than below, and each is a boundary rather than a convenience.
 *
 * **Pagination.** The `limit + 1` overfetch that turns a raw `(limit, offset)` repository call into
 * `{ items, nextCursor }` moves out of the tool layer and into this one. The extra row is the
 * difference between "there may be more" and "there is more": handing out a cursor whenever a page
 * came back full produces a cursor onto an empty page every time the total is an exact multiple of
 * the page size. A malformed cursor is an error — `decodeCursor` throws `CursorError`, which maps
 * to `bad_request` — and never a silent reset to offset 0, because silently restarting a walk is
 * how a model loops over page 1 forever believing it is progressing.
 *
 * **The `kind`/`hasMedia` contradiction.** `kind: "text"` with `hasMedia: true` asks for a text
 * message carrying an attachment. Answering it with an empty page reads as "there are none", which
 * is a different and wrong answer, so it is refused and the refusal names which pair clashed. It is
 * not a `.refine()` on the wire schema for that reason: a schema-level rule could only say
 * "invalid".
 *
 * **`canonicalId`.** Every chat and sender id arriving from a client passes through it here, at the
 * API boundary, and nowhere below (Global Constraint 3).
 */

import type { Handlers, Chat, Message, MessageDetail, Reaction, SearchHit } from "whatsapp-api-sdk";
import { BadRequestError } from "whatsapp-api-sdk";

import type { ChatListFilter, ChatRow } from "../../db/chats.js";
import type { ContactRow } from "../../db/contacts.js";
import {
  MEDIA_KINDS,
  type MessageFilter,
  type MessageKind,
  type MessageListFilter,
  type MessageRow,
  type SearchHit as SearchHitRow,
} from "../../db/messages.js";
import { canonicalId } from "../../whatsapp/jid.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import {
  presentChat,
  presentContact,
  presentMessage,
  presentSearchHit,
  reactionCounts,
  reactionKey,
} from "../present.js";
import type { RestDeps } from "../server.js";
import { requireRow } from "./subject.js";

/** The slice of the handler map this module owns. */
export type ReadHandlers = Pick<
  Handlers,
  "listChats" | "listGroups" | "listContacts" | "listMessages" | "searchMessages" | "getMessage"
>;

/**
 * The page size when a caller names none.
 *
 * 50, matching `limitSchema` in `mcp/tools/reads.ts` — that is the number a model has been reading
 * off the advertised tool schema, and a default that differed would change every unparameterised
 * listing's length. The wire schema deliberately carries no `.default()`, so the number lives in
 * exactly one place: here.
 */
const DEFAULT_LIMIT = 50;

/** The two fields every paginated route accepts. */
type PageQuery = { limit?: number | undefined; cursor?: string | undefined };

/** One page as the contract shapes it: the rows, and where to continue from. */
type Page<T> = { nextCursor: string | null; items: T[] };

/**
 * Run a paginated query and shape its page.
 *
 * `present` runs on the *sliced* page rather than on the overfetch, which matters because it is
 * what issues the grouped reaction query: presenting first would count reactions for a row that is
 * about to be thrown away.
 */
function paginate<Row, Item>(
  query: PageQuery,
  fetch: (limit: number, offset: number) => Row[],
  present: (rows: readonly Row[]) => Item[],
): Page<Item> {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = decodeCursor(query.cursor);
  const rows = fetch(limit + 1, offset);
  const hasMore = rows.length > limit;
  return {
    nextCursor: hasMore ? encodeCursor(offset + limit) : null,
    items: present(hasMore ? rows.slice(0, limit) : rows),
  };
}

/** Everything both `GET /v1/messages` and `GET /v1/messages/search` narrow by. */
type FilterQuery = {
  chat?: string | undefined;
  sender?: string | undefined;
  fromMe?: boolean | undefined;
  kind?: MessageKind | undefined;
  hasMedia?: boolean | undefined;
  after?: number | undefined;
  before?: number | undefined;
};

/** A caller-supplied id, folded to the one the store keys on. Undefined stays undefined. */
const canonical = (jid: string | undefined, deps: RestDeps): string | undefined =>
  jid === undefined ? undefined : canonicalId(jid, deps.contacts);

/**
 * The filter a query describes, or a refusal naming the contradiction.
 *
 * The message keeps the substring `contradicts kind="…"` that the tool layer's has always carried,
 * so what a model reads is unchanged; the parameter is spelled `hasMedia` because that is what this
 * API's query string calls it.
 */
function messageFilter(query: FilterQuery, deps: RestDeps): MessageFilter {
  const { kind, hasMedia } = query;
  if (kind !== undefined && hasMedia !== undefined) {
    const carries = (MEDIA_KINDS as readonly string[]).includes(kind);
    if (carries !== hasMedia) {
      throw new BadRequestError(
        `hasMedia=${String(hasMedia)} contradicts kind="${kind}", which ` +
          `${carries ? "always carries" : "never carries"} an attachment — drop one of the two`,
      );
    }
  }
  return {
    chatId: canonical(query.chat, deps),
    senderId: canonical(query.sender, deps),
    fromMe: query.fromMe,
    kind,
    hasMedia,
    after: query.after,
    before: query.before,
  };
}

export function readHandlers(deps: RestDeps): ReadHandlers {
  const { chats, contacts, messages, reactions } = deps;

  /** A page of message rows, with the reaction counts fetched in one grouped query for all of them. */
  const messagePage = (rows: readonly MessageRow[]): Message[] => {
    const counts = reactionCounts(reactions, rows);
    return rows.map((row) => presentMessage(row, deps, counts.get(reactionKey(row.chatId, row.id)) ?? 0));
  };

  const searchPage = (rows: readonly SearchHitRow[]): SearchHit[] => {
    const counts = reactionCounts(reactions, rows);
    return rows.map((row) => presentSearchHit(row, deps, counts.get(reactionKey(row.chatId, row.id)) ?? 0));
  };

  const chatPage = (rows: readonly ChatRow[]): Chat[] => rows.map((row) => presentChat(row, deps));

  return {
    listChats: ({ query }) => {
      const filter: ChatListFilter = {
        query: query.query,
        isGroup: query.isGroup,
        archived: query.archived,
        unreadOnly: query.unread,
      };
      return Promise.resolve(paginate(query, (limit, offset) => chats.list(filter, limit, offset), chatPage));
    },

    /**
     * Groups are `listChats` with the filter fixed, not a second query: the route *is* the filter,
     * which is why `GroupQuery` carries the page and nothing else.
     */
    listGroups: ({ query }) =>
      Promise.resolve(paginate(query, (limit, offset) => chats.list({ isGroup: true }, limit, offset), chatPage)),

    /**
     * `query` is optional here although `whatsapp_contacts_search` requires it. `contacts.search`
     * builds a `LIKE '%…%'`, so an empty term is a well-defined "every contact with a name, a push
     * name or a number" and this route is a listing a UI wants unfiltered.
     */
    listContacts: ({ query }) =>
      Promise.resolve(
        paginate(
          query,
          (limit, offset) => contacts.search(query.query ?? "", limit, offset),
          (rows: readonly ContactRow[]) => rows.map(presentContact),
        ),
      ),

    listMessages: ({ query }) => {
      const filter: MessageListFilter = { ...messageFilter(query, deps), asc: query.asc };
      return Promise.resolve(paginate(query, (limit, offset) => messages.list(filter, limit, offset), messagePage));
    },

    searchMessages: ({ query }) => {
      const filter = messageFilter(query, deps);
      return Promise.resolve(
        paginate(query, (limit, offset) => messages.search(query.q, filter, limit, offset), searchPage),
      );
    },

    /**
     * `MessageDetail`, and the `reactions` array is the whole reason the shape exists.
     *
     * `whatsapp_download_media`'s summary embeds the full per-reactor list, which is a different
     * thing from the batched `reactionCount` a listing carries — and a handler that answered plain
     * `Message` here would drop it with no type to notice, because the field would simply be
     * absent. One `forMessage` call for the one row this route is about; `reactionCount` is its
     * length rather than a second query for the same rows.
     */
    getMessage: ({ params }) => {
      const row = requireRow(deps, params.chat, params.id);
      const rows = reactions.forMessage(row.chatId, row.id);
      const detail: MessageDetail = {
        ...presentMessage(row, deps, rows.length),
        reactions: rows.map((r): Reaction => ({
          emoji: r.emoji,
          from: { id: r.senderId, name: contacts.displayName(r.senderId) },
        })),
      };
      return Promise.resolve(detail);
    },
  };
}
