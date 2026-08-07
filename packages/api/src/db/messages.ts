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

export type MessageRow = {
  rowid: number;
  chatId: string;
  id: string;
  senderId: string;
  ts: number;
  fromMe: boolean;
  kind: MessageKind;
  text: string | null;
  transcript: string | null;
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
  /** Which model produced `transcript`. NULL means the whisper.cpp era, before schema V2. */
  transcriptModel: string | null;
  /**
   * The language `transcript` was spoken in, as the backend reported it.
   *
   * NULL for a row stored before schema V3, and equally for a backend that named no language — the
   * two are not worth telling apart, because neither is a language anything may act on.
   */
  transcriptLanguage: string | null;
};

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
 * What `setTranscript` persists.
 *
 * Structurally the transcribers' `Transcript` (`media/transcribe.ts`), restated here rather than
 * imported: `db` sits below `media`, and importing upwards — even a type — would make the
 * dependency circular. A caller hands over what its backend returned, unchanged.
 */
export type TranscriptInput = { text: string; model: string; language: string | null };

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
  markDeleted: (chatId: string, id: string, ts: number) => void;
  setStatus: (chatId: string, id: string, status: string) => void;
  /**
   * Store a transcript together with the provenance that came with it.
   *
   * Taken as one object rather than as loose arguments because that is the shape the transcribers
   * already return (`Transcript` in `media/transcribe.ts`): a caller passes what it was given
   * instead of unpacking it, and a field added to a transcript later cannot be silently dropped by
   * a call site that simply never passed it.
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
  transcript: string | null;
  quoted_id: string | null;
  status: string | null;
  edited_ts: number | null;
  deleted_ts: number | null;
  media_type: string | null;
  media_sha: string | null;
  ptt: number | null;
  duration_s: number | null;
  transcript_model: string | null;
  transcript_language: string | null;
};

type SearchRowRaw = MessageRowRaw & { snip_text: string | null; snip_transcript: string | null };

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
    transcript: raw.transcript,
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
    transcriptModel: raw.transcript_model,
    transcriptLanguage: raw.transcript_language,
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

const SELECT_COLUMNS = `
  rowid, chat_id, id, sender_id, ts, from_me, kind, text, transcript,
  quoted_id, status, edited_ts, deleted_ts, media_type, media_sha,
  ptt, duration_s, transcript_model, transcript_language
`;

const SEARCH_COLUMNS = `
  m.rowid, m.chat_id, m.id, m.sender_id, m.ts, m.from_me, m.kind, m.text, m.transcript,
  m.quoted_id, m.status, m.edited_ts, m.deleted_ts, m.media_type, m.media_sha,
  m.ptt, m.duration_s, m.transcript_model, m.transcript_language,
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
    "UPDATE messages SET text = NULL, transcript = NULL, deleted_ts = :deletedTs WHERE chat_id = :chatId AND id = :id",
  );
  const setStatusStmt = db.prepare("UPDATE messages SET status = :status WHERE chat_id = :chatId AND id = :id");
  const setTranscriptStmt = db.prepare(
    `UPDATE messages
        SET transcript = :transcript, transcript_model = :model, transcript_language = :language
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
    setTranscriptStmt.run({ chatId, id, transcript: t.text, model: t.model, language: t.language });
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
