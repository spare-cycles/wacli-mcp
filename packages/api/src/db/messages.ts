import type { Db } from "./client.js";

/**
 * Every kind a stored message can have, as a value rather than only a type: the tool layer needs the
 * list at runtime to advertise it as an enum, and deriving `MessageKind` from the array is what stops
 * the advertised set and the storable set from drifting apart.
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

/**
 * What `setTranscript` persists — and, aliased as `Transcript` in `media/transcribe.ts`, what the
 * transcribers produce. One declaration, so the two cannot drift apart.
 *
 * It lives *here*, in the layer that stores it, rather than in the layer that produces it, because
 * `db` sits below `media` and nothing in `db` may depend on a transcriber. To be exact about the
 * cost of the alternative: an import the other way would not actually close a module cycle today
 * (`media/transcribe.ts` reaches `db/meta.ts` → `db/client.ts` → `db/schema.ts` through
 * `media/budget.ts`, none of which import this file), and no lint rule forbids one. It is the
 * layering that rules it out, not the module graph.
 */
export type TranscriptInput = { text: string; model: string; language: string | null };

/**
 * Every field of a transcript: the column that stores it, and the `MessageRow` property that
 * surfaces it.
 *
 * This is a mechanism, not a note. Both directions are generated from it — the write
 * (`setTranscript`'s `SET` list, `markDeleted`'s `= NULL` list) and the read (`SELECT_COLUMNS`,
 * `MessageRowRaw`, `MessageRow`, `toMessageRow`) — so a field added to `TranscriptInput` is a
 * compile error here until it is given a column and a property, and from that moment it is
 * written, tombstoned, selected and returned without anyone editing SQL or a row mapping.
 *
 * Nothing weaker closes either end. On the write side the object form of `setTranscript` reads as
 * though it would, but both production callers pass a `Transcript` *variable* — excess property
 * checking never applies — so a new field would compile, be accepted, and be dropped at the SQL
 * layer without a word: the exact bug schema V3 exists to fix. On the read side a hand-written
 * `SELECT` and a hand-written `toMessageRow` fail in mirror image — the value stored correctly and
 * surfaced to nobody — and there is no compiler error there either. Half a map would have left the
 * second of those wide open.
 *
 * `row` earns its place beside `column` because the three namings genuinely differ: the field a
 * transcriber calls `text` is the column `transcript`, while `model` is `transcript_model` and
 * `transcriptModel`. Any one of them could be derived from another; all three could not.
 */
export const TRANSCRIPT_FIELDS = {
  // Every `column` below carries the `transcript_` prefix by convention, and that convention is the
  // only thing guarding it. The bound parameters are namespaced `:t_<field>` by construction, so a
  // field called `id` cannot displace the `:id` the WHERE reads — `column` has no equivalent. Mapping
  // one onto an existing column (say `text`) is the single combination in this chain that is silent
  // end to end: zero tsc errors, zero lint warnings, and `setTranscript` writes the transcript into
  // the message's own `text`. Every other omission is loud — a field with no entry fails the
  // `satisfies` and both mapped types, an entry with no column fails at `db.prepare`, and a `row`
  // colliding with an existing property fails TS2783. Keep the prefix.
  text: { column: "transcript", row: "transcript" },
  /** Which model produced the text. NULL means the whisper.cpp era, before schema V2. */
  model: { column: "transcript_model", row: "transcriptModel" },
  /**
   * The language the text was spoken in, as the backend reported it. NULL for a row stored before
   * schema V3, and equally for a backend that named no language — the two are not worth telling
   * apart, because neither is a language anything may act on.
   */
  language: { column: "transcript_language", row: "transcriptLanguage" },
} as const satisfies Record<keyof TranscriptInput, { column: string; row: string }>;

const TRANSCRIPT_FIELD_NAMES = Object.keys(TRANSCRIPT_FIELDS) as (keyof TranscriptInput)[];

/** The transcript half of a raw row: every mapped column, nullable — most messages carry no speech. */
type TranscriptColumns = {
  [F in keyof TranscriptInput as (typeof TRANSCRIPT_FIELDS)[F]["column"]]: TranscriptInput[F] | null;
};

/** The same fields under the names a reader of `MessageRow` sees. */
type TranscriptRowFields = {
  [F in keyof TranscriptInput as (typeof TRANSCRIPT_FIELDS)[F]["row"]]: TranscriptInput[F] | null;
};

export type MessageRow = {
  rowid: number;
  chatId: string;
  id: string;
  senderId: string;
  ts: number;
  fromMe: boolean;
  kind: MessageKind;
  text: string | null;
  quotedId: string | null;
  status: string | null;
  editedTs: number | null;
  deletedTs: number | null;
  mediaType: string | null;
  mediaSha: string | null;
  /**
   * True for a voice note, false for any other audio, null for a row stored before schema V2.
   *
   * `kind` cannot answer this: `audioMessage` maps to `"audio"` whether it is someone talking or a
   * forwarded song. Everything that decides whether to spend a GPU on a recording keys on this.
   */
  ptt: boolean | null;
  /** Declared seconds, from the envelope — so a length gate can run before the file is downloaded. */
  durationS: number | null;
} & TranscriptRowFields;

export type MessageInput = {
  chatId: string;
  id: string;
  senderId: string;
  ts: number;
  fromMe: boolean;
  kind: MessageKind;
  text?: string | undefined;
  quotedId?: string | undefined;
  status?: string | undefined;
  mediaType?: string | undefined;
  ptt?: boolean | undefined;
  durationS?: number | undefined;
  raw?: Uint8Array | undefined;
};

/** A voice note with no transcript yet: what the boot sweep finds and the queue works through. */
export type PendingTranscript = { chatId: string; id: string; ts: number; durationS: number | null };

/**
 * The kinds that carry an attachment: what `hasMedia` selects, and what `media/store.ts` will
 * download. Exported so there is one list — a second copy would let "has media" and "can be
 * fetched" drift apart, and a message that answers yes to one and no to the other is a tool call
 * that finds a hit and then refuses to open it.
 */
export const MEDIA_KINDS: readonly MessageKind[] = ["image", "video", "audio", "document", "sticker"];

/**
 * Everything both `list` and `search` can narrow by. One type, because a filter a caller can use to
 * find a message should not depend on whether they got there by browsing or by searching — the old
 * server had `--type`/`--has-media`/`--after`/`--before` on search alone, and the asymmetry was a
 * gap rather than a design.
 */
export type MessageFilter = {
  chatId?: string | undefined;
  senderId?: string | undefined;
  fromMe?: boolean | undefined;
  kind?: MessageKind | undefined;
  /** True for messages carrying an attachment (`MEDIA_KINDS`), false for those carrying none. */
  hasMedia?: boolean | undefined;
  before?: number | undefined;
  after?: number | undefined;
  includeDeleted?: boolean | undefined;
};

/** `MessageFilter` plus the one thing only an ordered listing has: which end to start from. */
export type MessageListFilter = MessageFilter & {
  /** Oldest first. Defaults to newest first, which is what a chat view wants. */
  asc?: boolean | undefined;
};

export type SearchHit = MessageRow & { matchedTranscript: boolean; snippet: string };

/**
 * The parameter namespace every transcript binding lives in.
 *
 * The UPDATE these clauses go into addresses its row with `:chatId` and `:id`, bound in the same
 * parameter object. A future transcript field named `id` would otherwise generate `id = :id` and
 * replace the row selector with the transcript's own value — a valid statement that updates the
 * wrong row or none, with nothing to report from SQLite and nothing from the compiler. It is the
 * one arrangement the map alone does not rule out; the prefix rules it out for free.
 */
const TRANSCRIPT_PARAM_PREFIX = "t_";

/** `transcript = :t_text, transcript_model = :t_model, …`. Takes the map rather than closing over
 *  it, so the namespacing above can be tested against a hostile one; only `TRANSCRIPT_FIELDS` is
 *  ever passed in production. */
export function transcriptSetClause(bindings: Record<string, { column: string }>): string {
  return Object.entries(bindings)
    .map(([field, { column }]) => `${column} = :${TRANSCRIPT_PARAM_PREFIX}${field}`)
    .join(", ");
}

const TRANSCRIPT_SET_CLAUSE = transcriptSetClause(TRANSCRIPT_FIELDS);
const TRANSCRIPT_CLEAR_CLAUSE = TRANSCRIPT_FIELD_NAMES.map((f) => `${TRANSCRIPT_FIELDS[f].column} = NULL`).join(", ");

export type MessagesRepo = {
  /** Returns true when the row was newly inserted, false when it updated an existing one.
   *  Task 8 depends on this to avoid double-counting unread on a redelivery. */
  upsert: (m: MessageInput) => boolean;
  get: (chatId: string, id: string) => MessageRow | undefined;
  /** The protobuf bytes stored at ingest. Backs the socket's getMessage contract. */
  getRaw: (chatId: string, id: string) => Uint8Array | undefined;
  list: (filter: MessageListFilter, limit: number, offset: number) => MessageRow[];
  search: (query: string, filter: MessageFilter, limit: number, offset: number) => SearchHit[];
  markEdited: (chatId: string, id: string, text: string, ts: number) => void;
  /**
   * Tombstone a revoked message: its text and its transcript go, the row and its `raw` stay.
   *
   * "Its transcript" means every transcript column, provenance included — a row answering
   * `{ text: null, model: "voxtral", language: "fr" }` describes a transcript that no longer
   * exists, and the `as=transcript` view being built on these columns would report it that way.
   * `transcript_model` had been left behind since V2; V3 would have added a second such residue.
   * Rows revoked before that was fixed are not left disagreeing with this: schema V4 clears the
   * same columns on every tombstone already in the store, so the state described above does not
   * exist for old rows either.
   */
  markDeleted: (chatId: string, id: string, ts: number) => void;
  setStatus: (chatId: string, id: string, status: string) => void;
  /**
   * Store a transcript together with the provenance that came with it.
   *
   * Taken as one object rather than as loose arguments because that is exactly what a transcriber
   * returns (`Transcript` in `media/transcribe.ts` is this very type): a caller passes what it was
   * given instead of unpacking it. What stops a field of that object from being quietly left out
   * of the write is not the object form — it is `TRANSCRIPT_FIELDS`, from which this statement is
   * generated.
   *
   * `model` is not optional. Making it so would let a caller store a transcript with no provenance,
   * which is the exact state schema V2 exists to end — and the one caller that could plausibly want
   * to (a test) is better served passing a name than being allowed to omit one. `language` *is*
   * nullable, because a backend genuinely may not report one.
   */
  setTranscript: (chatId: string, id: string, transcript: TranscriptInput) => void;
  setMedia: (chatId: string, id: string, sha: string, mediaType: string) => void;
  /**
   * Voice notes with no transcript, newest first, at or after `sinceTs`.
   *
   * Backs the boot sweep, so that a pod restart mid-backlog leaves no hole. `sinceTs` is the
   * caller's recency window rather than a default here: this repository has no opinion about how
   * old a recording has to be before transcribing it is a waste of money.
   */
  pendingTranscripts: (sinceTs: number, limit: number) => PendingTranscript[];
  /**
   * Whether this chat has anything I sent at or after `sinceTs`.
   *
   * The cheap proxy for "a conversation I actually take part in", which is what bounds
   * auto-transcription to chats worth spending on. Broadcast lists and channels I never answer
   * fail it, and that is the whole point.
   */
  hasOutboundSince: (chatId: string, sinceTs: number) => boolean;
  count: () => number;
  /**
   * The newest `ts` in the store, or `null` when it is empty.
   *
   * Exists for the freshness watchdog, not for a tool. The connection's own `lastEventAt` moves on
   * `connection.update` alone, so a socket that is answering while ingesting nothing looks identical
   * to a healthy quiet one from outside — which is exactly the shape of the 2026-07-26 outage. This
   * is the only value in the process that distinguishes them.
   */
  newestTs: () => number | null;
  /** Non-from_me, non-deleted messages at or before `ts`, newest first. Backs send.ts's markRead expansion. */
  unreadKeysUpTo: (chatId: string, ts: number, limit: number) => { id: string; senderId: string }[];
};

type MessageRowRaw = {
  rowid: number;
  chat_id: string;
  id: string;
  sender_id: string;
  ts: number;
  from_me: number;
  kind: string;
  text: string | null;
  quoted_id: string | null;
  status: string | null;
  edited_ts: number | null;
  deleted_ts: number | null;
  media_type: string | null;
  media_sha: string | null;
  ptt: number | null;
  duration_s: number | null;
} & TranscriptColumns;

type SearchRowRaw = MessageRowRaw & { snip_text: string | null; snip_transcript: string | null };

/**
 * The transcript half of a row, keyed the way `MessageRow` keys it.
 *
 * Read off the same map the `SELECT` was generated from, so a column that is stored cannot fail to
 * be surfaced. Written out by hand, this is where a mapped-and-migrated field would go missing
 * without a word.
 */
function transcriptOf(raw: TranscriptColumns): TranscriptRowFields {
  const fields: Record<string, string | null> = {};
  for (const field of TRANSCRIPT_FIELD_NAMES) {
    fields[TRANSCRIPT_FIELDS[field].row] = raw[TRANSCRIPT_FIELDS[field].column];
  }
  // The loop cannot show the compiler that it filled every key of the type it returns. What makes
  // that true is that the type is generated from the very map the loop walks.
  return fields as TranscriptRowFields;
}

function toMessageRow(raw: MessageRowRaw): MessageRow {
  return {
    rowid: raw.rowid,
    chatId: raw.chat_id,
    id: raw.id,
    senderId: raw.sender_id,
    ts: raw.ts,
    fromMe: raw.from_me !== 0,
    kind: raw.kind as MessageKind,
    text: raw.text,
    quotedId: raw.quoted_id,
    status: raw.status,
    editedTs: raw.edited_ts,
    deletedTs: raw.deleted_ts,
    mediaType: raw.media_type,
    mediaSha: raw.media_sha,
    // `null` is preserved rather than folded to `false`: a pre-V2 row is "we never recorded this",
    // which is a different answer from "this is not a voice note", and the sweep treats them
    // differently — an unknown row is left alone rather than transcribed on a guess.
    ptt: raw.ptt === null ? null : raw.ptt !== 0,
    durationS: raw.duration_s,
    ...transcriptOf(raw),
  };
}

/**
 * How a matched term is marked inside a snippet, before it is rendered for a reader.
 *
 * `snippet()` does not report whether the column it was asked about took part in the match: for a
 * column that did not, it answers that column's *leading text*, unmarked — NULL only when the column
 * itself is NULL, and `""` only when it is empty. So the presence of these markers is the only thing
 * in the result that distinguishes "this column matched" from "this column exists". Reading the
 * snippet's emptiness instead mislabels the ordinary case of a captioned video — a caption that does
 * not contain the query, plus a transcript that does — as a text hit, and hands back a snippet with
 * none of the searched words in it.
 *
 * They are control characters (SOH/STX) rather than `[`/`]` so that a bracket typed by a human in a
 * message can never be read as a match marker; nothing in a WhatsApp message body produces them.
 */
const MATCH_OPEN = "\u0001";
const MATCH_CLOSE = "\u0002";

/** True when a stored value carries a marker character of its own, which makes its snippet unreadable. */
function carriesMarker(stored: string | null): boolean {
  return stored !== null && (stored.includes(MATCH_OPEN) || stored.includes(MATCH_CLOSE));
}

/**
 * The snippet of a column that really matched, with its markers rendered as `[…]` for the reader —
 * or `undefined` when that column took no part in the match, or cannot be read as having done so.
 *
 * `stored` is the column's own value, and checking it is what keeps the marker rule sound. A message
 * body is sender-supplied UTF-8: nothing stops someone sending a literal SOH, and `snippet()` copies
 * whatever the column holds into the snippet verbatim. Read on its own, a snippet carrying that
 * character says "this column matched" for a column that did not — the same mislabelling the marker
 * rule replaced "is the snippet empty?" to prevent, arriving by a different door. A column whose
 * stored value carries a marker therefore contributes **no signal**: the hit is attributed to the
 * other column, or to neither, and never to the wrong one.
 */
function matchedSnippet(snippet: string | null, stored: string | null): string | undefined {
  if (snippet?.includes(MATCH_OPEN) !== true) return undefined;
  if (carriesMarker(stored)) return undefined;
  return snippet.replaceAll(MATCH_OPEN, "[").replaceAll(MATCH_CLOSE, "]");
}

/** Wrap a raw user query as a single quoted FTS5 string so no operator character reaches the parser. */
function quoteFtsQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

/**
 * The transcript columns are interpolated from `TRANSCRIPT_FIELDS` rather than listed, for the same
 * reason the `SET` clause is: a hand-written list is how a column the repository stores correctly
 * reaches no reader — V3's bug in mirror image, and just as quiet.
 */
const SELECT_COLUMNS = `
  rowid, chat_id, id, sender_id, ts, from_me, kind, text,
  quoted_id, status, edited_ts, deleted_ts, media_type, media_sha,
  ptt, duration_s, ${TRANSCRIPT_FIELD_NAMES.map((f) => TRANSCRIPT_FIELDS[f].column).join(", ")}
`;

const SEARCH_COLUMNS = `
  m.rowid, m.chat_id, m.id, m.sender_id, m.ts, m.from_me, m.kind, m.text,
  m.quoted_id, m.status, m.edited_ts, m.deleted_ts, m.media_type, m.media_sha,
  m.ptt, m.duration_s, ${TRANSCRIPT_FIELD_NAMES.map((f) => `m.${TRANSCRIPT_FIELDS[f].column}`).join(", ")},
  snippet(messages_fts, 0, char(1), char(2), '…', 12) AS snip_text,
  snippet(messages_fts, 1, char(1), char(2), '…', 12) AS snip_transcript
`;

/**
 * `MEDIA_KINDS` as a SQL list. Built from the constant above, never from anything a caller supplied
 * — which is what makes interpolating it into the statement text sound. Every value a caller *can*
 * influence is bound as a named parameter below.
 */
const MEDIA_KIND_SQL = MEDIA_KINDS.map((kind) => `'${kind}'`).join(", ");

/** The WHERE fragments and bound parameters for a filter. `qualify` prefixes a column for a join. */
function predicate(
  filter: MessageFilter,
  qualify: (column: string) => string,
): { where: string[]; params: Record<string, string | number> } {
  const where: string[] = [];
  const params: Record<string, string | number> = {};

  if (filter.chatId !== undefined) {
    where.push(`${qualify("chat_id")} = :chatId`);
    params["chatId"] = filter.chatId;
  }
  if (filter.senderId !== undefined) {
    where.push(`${qualify("sender_id")} = :senderId`);
    params["senderId"] = filter.senderId;
  }
  if (filter.fromMe !== undefined) {
    where.push(`${qualify("from_me")} = :fromMe`);
    params["fromMe"] = filter.fromMe ? 1 : 0;
  }
  if (filter.kind !== undefined) {
    where.push(`${qualify("kind")} = :kind`);
    params["kind"] = filter.kind;
  }
  if (filter.hasMedia !== undefined) {
    where.push(`${qualify("kind")} ${filter.hasMedia ? "IN" : "NOT IN"} (${MEDIA_KIND_SQL})`);
  }
  if (filter.before !== undefined) {
    where.push(`${qualify("ts")} <= :before`);
    params["before"] = filter.before;
  }
  if (filter.after !== undefined) {
    where.push(`${qualify("ts")} >= :after`);
    params["after"] = filter.after;
  }
  // A revoked row is a tombstone, not a message: it is excluded unless a caller asks for it by name.
  if (filter.includeDeleted !== true) {
    where.push(`${qualify("deleted_ts")} IS NULL`);
  }

  return { where, params };
}

/**
 * Shared skeleton for the search query; `extraWhere` is `predicate`'s output, already qualified with
 * the `m.` alias and already carrying the tombstone exclusion.
 */
function searchQuery(extraWhere: string): string {
  return `
    SELECT ${SEARCH_COLUMNS}
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
     WHERE messages_fts MATCH :q${extraWhere}
     ORDER BY rank
     LIMIT :limit OFFSET :offset
  `;
}

export function makeMessagesRepo(db: Db): MessagesRepo {
  const hasStmt = db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND id = ?");
  const insertStmt = db.prepare(`
    INSERT INTO messages
      (chat_id, id, sender_id, ts, from_me, kind, text, quoted_id, status, media_type, ptt, duration_s, raw)
    VALUES
      (:chatId, :id, :senderId, :ts, :fromMe, :kind, :text, :quotedId, :status, :mediaType, :ptt, :durationS, :raw)
    ON CONFLICT (chat_id, id) DO UPDATE SET
      sender_id = excluded.sender_id,
      ts = excluded.ts,
      from_me = excluded.from_me,
      kind = excluded.kind,
      text = COALESCE(excluded.text, messages.text),
      quoted_id = COALESCE(excluded.quoted_id, messages.quoted_id),
      status = COALESCE(excluded.status, messages.status),
      media_type = COALESCE(excluded.media_type, messages.media_type),
      -- COALESCE like every other field here: a redelivery whose envelope this build could not
      -- read must never downgrade a row that already knows it is a voice note, because that would
      -- take it out of the sweep's partial index and it would silently never be transcribed.
      ptt = COALESCE(excluded.ptt, messages.ptt),
      duration_s = COALESCE(excluded.duration_s, messages.duration_s),
      raw = COALESCE(excluded.raw, messages.raw)
  `);
  const getStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM messages WHERE chat_id = ? AND id = ?`);
  const getRawStmt = db.prepare("SELECT raw FROM messages WHERE chat_id = ? AND id = ?");
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM messages");
  const newestTsStmt = db.prepare("SELECT MAX(ts) AS ts FROM messages");
  const markEditedStmt = db.prepare(
    "UPDATE messages SET text = :text, edited_ts = :editedTs WHERE chat_id = :chatId AND id = :id",
  );
  const markDeletedStmt = db.prepare(
    `UPDATE messages
        SET text = NULL, ${TRANSCRIPT_CLEAR_CLAUSE}, deleted_ts = :deletedTs
      WHERE chat_id = :chatId AND id = :id`,
  );
  const setStatusStmt = db.prepare("UPDATE messages SET status = :status WHERE chat_id = :chatId AND id = :id");
  const setTranscriptStmt = db.prepare(
    `UPDATE messages
        SET ${TRANSCRIPT_SET_CLAUSE}
      WHERE chat_id = :chatId AND id = :id`,
  );
  const pendingTranscriptsStmt = db.prepare(`
    SELECT chat_id, id, ts, duration_s FROM messages
     WHERE ptt = 1 AND transcript IS NULL AND deleted_ts IS NULL AND ts >= :sinceTs
     ORDER BY ts DESC
     LIMIT :limit
  `);
  const hasOutboundSinceStmt = db.prepare(`
    SELECT 1 FROM messages
     WHERE chat_id = :chatId AND from_me = 1 AND ts >= :sinceTs
     LIMIT 1
  `);
  const setMediaStmt = db.prepare(
    "UPDATE messages SET media_sha = :mediaSha, media_type = :mediaType WHERE chat_id = :chatId AND id = :id",
  );
  const unreadKeysUpToStmt = db.prepare(`
    SELECT id, sender_id FROM messages
     WHERE chat_id = :chatId AND from_me = 0 AND deleted_ts IS NULL AND ts <= :ts
     ORDER BY ts DESC, rowid DESC
     LIMIT :limit
  `);

  function upsert(m: MessageInput): boolean {
    const existed = hasStmt.get(m.chatId, m.id) !== undefined;
    insertStmt.run({
      chatId: m.chatId,
      id: m.id,
      senderId: m.senderId,
      ts: m.ts,
      fromMe: m.fromMe ? 1 : 0,
      kind: m.kind,
      text: m.text ?? null,
      quotedId: m.quotedId ?? null,
      status: m.status ?? null,
      mediaType: m.mediaType ?? null,
      ptt: m.ptt === undefined ? null : m.ptt ? 1 : 0,
      durationS: m.durationS ?? null,
      raw: m.raw ?? null,
    });
    return !existed;
  }

  function get(chatId: string, id: string): MessageRow | undefined {
    const row = getStmt.get(chatId, id) as MessageRowRaw | undefined;
    return row === undefined ? undefined : toMessageRow(row);
  }

  function getRaw(chatId: string, id: string): Uint8Array | undefined {
    const row = getRawStmt.get(chatId, id) as { raw: Uint8Array | null } | undefined;
    if (row?.raw == null) return undefined;
    return row.raw;
  }

  function list(filter: MessageListFilter, limit: number, offset: number): MessageRow[] {
    const { where, params } = predicate(filter, (column) => column);
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    // `rowid` follows `ts` in both directions: it is the tie-break, so flipping one and not the
    // other would make an ascending page and its descending twin disagree about equal timestamps —
    // which is how a paginated walk skips or repeats a row.
    const direction = filter.asc === true ? "ASC" : "DESC";
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM messages ${whereSql}
          ORDER BY ts ${direction}, rowid ${direction} LIMIT :limit OFFSET :offset`,
      )
      .all({ ...params, limit, offset }) as MessageRowRaw[];
    return rows.map(toMessageRow);
  }

  function search(query: string, filter: MessageFilter, limit: number, offset: number): SearchHit[] {
    const { where, params } = predicate(filter, (column) => `m.${column}`);
    const extraWhere = where.length > 0 ? ` AND ${where.join(" AND ")}` : "";
    const rows = db
      .prepare(searchQuery(extraWhere))
      .all({ ...params, q: quoteFtsQuery(query), limit, offset }) as SearchRowRaw[];
    return rows.map((row) => {
      // Which column matched is read from the markers, never from whether its snippet is empty:
      // `snippet()` returns unmarked leading text for a column that took no part in the match, so
      // emptiness answers a different question (see `matchedSnippet`). A message matching in both
      // columns is a text hit, and shows the text snippet — the transcript label means the words
      // were found *only* in speech, which is what makes it worth telling the model about.
      const snipText = matchedSnippet(row.snip_text, row.text);
      const snipTranscript = matchedSnippet(row.snip_transcript, row.transcript);
      return {
        ...toMessageRow(row),
        matchedTranscript: snipText === undefined && snipTranscript !== undefined,
        snippet: snipText ?? snipTranscript ?? "",
      };
    });
  }

  function markEdited(chatId: string, id: string, text: string, ts: number): void {
    markEditedStmt.run({ chatId, id, text, editedTs: ts });
  }

  function markDeleted(chatId: string, id: string, ts: number): void {
    markDeletedStmt.run({ chatId, id, deletedTs: ts });
  }

  function setStatus(chatId: string, id: string, status: string): void {
    setStatusStmt.run({ chatId, id, status });
  }

  function setTranscript(chatId: string, id: string, t: TranscriptInput): void {
    // Bound field by field off the same list the SET clause came from, so the two cannot disagree
    // about how many parameters there are — nor about their names, which carry the same prefix the
    // clause emits and so can never land on the `chatId`/`id` the WHERE binds beside them. Passing
    // `t` itself would work today and throw "Unknown named parameter" the day a caller hands over
    // a structurally wider object.
    const params: Record<string, string | null> = { chatId, id };
    for (const field of TRANSCRIPT_FIELD_NAMES) params[`${TRANSCRIPT_PARAM_PREFIX}${field}`] = t[field];
    setTranscriptStmt.run(params);
  }

  function pendingTranscripts(sinceTs: number, limit: number): PendingTranscript[] {
    const rows = pendingTranscriptsStmt.all({ sinceTs, limit }) as {
      chat_id: string;
      id: string;
      ts: number;
      duration_s: number | null;
    }[];
    return rows.map((row) => ({ chatId: row.chat_id, id: row.id, ts: row.ts, durationS: row.duration_s }));
  }

  function hasOutboundSince(chatId: string, sinceTs: number): boolean {
    return hasOutboundSinceStmt.get({ chatId, sinceTs }) !== undefined;
  }

  function setMedia(chatId: string, id: string, sha: string, mediaType: string): void {
    setMediaStmt.run({ chatId, id, mediaSha: sha, mediaType });
  }

  function count(): number {
    return (countStmt.get() as { n: number }).n;
  }

  function newestTs(): number | null {
    // `MAX()` over an empty table is one row holding NULL, not zero rows.
    const row = newestTsStmt.get() as { ts: number | null };
    return row.ts;
  }

  function unreadKeysUpTo(chatId: string, ts: number, limit: number): { id: string; senderId: string }[] {
    const rows = unreadKeysUpToStmt.all({ chatId, ts, limit }) as { id: string; sender_id: string }[];
    return rows.map((row) => ({ id: row.id, senderId: row.sender_id }));
  }

  return {
    upsert,
    get,
    getRaw,
    list,
    search,
    markEdited,
    markDeleted,
    setStatus,
    setTranscript,
    setMedia,
    pendingTranscripts,
    hasOutboundSince,
    count,
    newestTs,
    unreadKeysUpTo,
  };
}
