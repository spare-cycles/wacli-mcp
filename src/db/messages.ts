import type { Db } from "./client.js";

export type MessageKind =
  "text" | "image" | "video" | "audio" | "document" | "sticker" | "location" | "contact" | "system" | "other";

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
  raw?: Uint8Array | undefined;
};

export type MessageListFilter = {
  chatId?: string | undefined;
  senderId?: string | undefined;
  fromMe?: boolean | undefined;
  before?: number | undefined;
  after?: number | undefined;
  includeDeleted?: boolean | undefined;
};

export type SearchHit = MessageRow & { matchedTranscript: boolean; snippet: string };

export type MessagesRepo = {
  /** Returns true when the row was newly inserted, false when it updated an existing one.
   *  Task 8 depends on this to avoid double-counting unread on a redelivery. */
  upsert: (m: MessageInput) => boolean;
  upsertMany: (ms: readonly MessageInput[]) => void; // one transaction
  get: (chatId: string, id: string) => MessageRow | undefined;
  /** The protobuf bytes stored at ingest. Backs the socket's getMessage contract. */
  getRaw: (chatId: string, id: string) => Uint8Array | undefined;
  list: (filter: MessageListFilter, limit: number, offset: number) => MessageRow[];
  search: (query: string, opts: { chatId?: string | undefined }, limit: number, offset: number) => SearchHit[];
  markEdited: (chatId: string, id: string, text: string, ts: number) => void;
  markDeleted: (chatId: string, id: string, ts: number) => void;
  setStatus: (chatId: string, id: string, status: string) => void;
  setTranscript: (chatId: string, id: string, transcript: string) => void;
  setMedia: (chatId: string, id: string, sha: string, mediaType: string) => void;
  count: () => number;
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

/**
 * The snippet of a column that really matched, with its markers rendered as `[…]` for the reader —
 * or `undefined` when that column took no part in the match.
 */
function matchedSnippet(snippet: string | null): string | undefined {
  if (snippet?.includes(MATCH_OPEN) !== true) return undefined;
  return snippet.replaceAll(MATCH_OPEN, "[").replaceAll(MATCH_CLOSE, "]");
}

/** Wrap a raw user query as a single quoted FTS5 string so no operator character reaches the parser. */
function quoteFtsQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

const SELECT_COLUMNS = `
  rowid, chat_id, id, sender_id, ts, from_me, kind, text, transcript,
  quoted_id, status, edited_ts, deleted_ts, media_type, media_sha
`;

const SEARCH_COLUMNS = `
  m.rowid, m.chat_id, m.id, m.sender_id, m.ts, m.from_me, m.kind, m.text, m.transcript,
  m.quoted_id, m.status, m.edited_ts, m.deleted_ts, m.media_type, m.media_sha,
  snippet(messages_fts, 0, char(1), char(2), '…', 12) AS snip_text,
  snippet(messages_fts, 1, char(1), char(2), '…', 12) AS snip_transcript
`;

/** Shared skeleton for the search query; `extraWhere` scopes it to one chat when non-empty. */
function searchQuery(extraWhere: string): string {
  return `
    SELECT ${SEARCH_COLUMNS}
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
     WHERE messages_fts MATCH :q AND m.deleted_ts IS NULL${extraWhere}
     ORDER BY rank
     LIMIT :limit OFFSET :offset
  `;
}

export function makeMessagesRepo(db: Db): MessagesRepo {
  const hasStmt = db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND id = ?");
  const insertStmt = db.prepare(`
    INSERT INTO messages (chat_id, id, sender_id, ts, from_me, kind, text, quoted_id, status, media_type, raw)
    VALUES (:chatId, :id, :senderId, :ts, :fromMe, :kind, :text, :quotedId, :status, :mediaType, :raw)
    ON CONFLICT (chat_id, id) DO UPDATE SET
      sender_id = excluded.sender_id,
      ts = excluded.ts,
      from_me = excluded.from_me,
      kind = excluded.kind,
      text = COALESCE(excluded.text, messages.text),
      quoted_id = COALESCE(excluded.quoted_id, messages.quoted_id),
      status = COALESCE(excluded.status, messages.status),
      media_type = COALESCE(excluded.media_type, messages.media_type),
      raw = COALESCE(excluded.raw, messages.raw)
  `);
  const getStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM messages WHERE chat_id = ? AND id = ?`);
  const getRawStmt = db.prepare("SELECT raw FROM messages WHERE chat_id = ? AND id = ?");
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM messages");
  const markEditedStmt = db.prepare(
    "UPDATE messages SET text = :text, edited_ts = :editedTs WHERE chat_id = :chatId AND id = :id",
  );
  const markDeletedStmt = db.prepare(
    "UPDATE messages SET text = NULL, transcript = NULL, deleted_ts = :deletedTs WHERE chat_id = :chatId AND id = :id",
  );
  const setStatusStmt = db.prepare("UPDATE messages SET status = :status WHERE chat_id = :chatId AND id = :id");
  const setTranscriptStmt = db.prepare(
    "UPDATE messages SET transcript = :transcript WHERE chat_id = :chatId AND id = :id",
  );
  const setMediaStmt = db.prepare(
    "UPDATE messages SET media_sha = :mediaSha, media_type = :mediaType WHERE chat_id = :chatId AND id = :id",
  );
  const unreadKeysUpToStmt = db.prepare(`
    SELECT id, sender_id FROM messages
     WHERE chat_id = :chatId AND from_me = 0 AND deleted_ts IS NULL AND ts <= :ts
     ORDER BY ts DESC, rowid DESC
     LIMIT :limit
  `);
  const searchStmt = db.prepare(searchQuery(""));
  const searchScopedStmt = db.prepare(searchQuery(" AND m.chat_id = :chatId"));

  function upsertOne(m: MessageInput): boolean {
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
      raw: m.raw ?? null,
    });
    return !existed;
  }

  function upsert(m: MessageInput): boolean {
    return upsertOne(m);
  }

  function upsertMany(ms: readonly MessageInput[]): void {
    if (ms.length === 0) return;
    db.exec("BEGIN");
    try {
      for (const m of ms) upsertOne(m);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
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
    const where: string[] = [];
    const params: Record<string, string | number> = { limit, offset };

    if (filter.chatId !== undefined) {
      where.push("chat_id = :chatId");
      params["chatId"] = filter.chatId;
    }
    if (filter.senderId !== undefined) {
      where.push("sender_id = :senderId");
      params["senderId"] = filter.senderId;
    }
    if (filter.fromMe !== undefined) {
      where.push("from_me = :fromMe");
      params["fromMe"] = filter.fromMe ? 1 : 0;
    }
    if (filter.before !== undefined) {
      where.push("ts <= :before");
      params["before"] = filter.before;
    }
    if (filter.after !== undefined) {
      where.push("ts >= :after");
      params["after"] = filter.after;
    }
    if (filter.includeDeleted !== true) {
      where.push("deleted_ts IS NULL");
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM messages ${whereSql} ORDER BY ts DESC, rowid DESC LIMIT :limit OFFSET :offset`,
      )
      .all(params) as MessageRowRaw[];
    return rows.map(toMessageRow);
  }

  function search(query: string, opts: { chatId?: string | undefined }, limit: number, offset: number): SearchHit[] {
    const q = quoteFtsQuery(query);
    const rows =
      opts.chatId !== undefined
        ? (searchScopedStmt.all({ q, chatId: opts.chatId, limit, offset }) as SearchRowRaw[])
        : (searchStmt.all({ q, limit, offset }) as SearchRowRaw[]);
    return rows.map((row) => {
      // Which column matched is read from the markers, never from whether its snippet is empty:
      // `snippet()` returns unmarked leading text for a column that took no part in the match, so
      // emptiness answers a different question (see `matchedSnippet`). A message matching in both
      // columns is a text hit, and shows the text snippet — the transcript label means the words
      // were found *only* in speech, which is what makes it worth telling the model about.
      const snipText = matchedSnippet(row.snip_text);
      const snipTranscript = matchedSnippet(row.snip_transcript);
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

  function setTranscript(chatId: string, id: string, transcript: string): void {
    setTranscriptStmt.run({ chatId, id, transcript });
  }

  function setMedia(chatId: string, id: string, sha: string, mediaType: string): void {
    setMediaStmt.run({ chatId, id, mediaSha: sha, mediaType });
  }

  function count(): number {
    return (countStmt.get() as { n: number }).n;
  }

  function unreadKeysUpTo(chatId: string, ts: number, limit: number): { id: string; senderId: string }[] {
    const rows = unreadKeysUpToStmt.all({ chatId, ts, limit }) as { id: string; sender_id: string }[];
    return rows.map((row) => ({ id: row.id, senderId: row.sender_id }));
  }

  return {
    upsert,
    upsertMany,
    get,
    getRaw,
    list,
    search,
    markEdited,
    markDeleted,
    setStatus,
    setTranscript,
    setMedia,
    count,
    unreadKeysUpTo,
  };
}
