import { escapeLike, type Db } from "./client.js";

export type ChatRow = {
  id: string;
  name: string | null;
  isGroup: boolean;
  lastMessageTs: number | null;
  unreadCount: number;
  archived: boolean;
  mutedUntil: number | null;
  participantCount: number | null;
};

export type ChatPatch = {
  name?: string | undefined;
  isGroup?: boolean | undefined;
  unreadCount?: number | undefined;
  archived?: boolean | undefined;
  mutedUntil?: number | null | undefined;
  participantCount?: number | undefined;
  raw?: unknown;
};

export type ChatListFilter = {
  query?: string | undefined;
  isGroup?: boolean | undefined;
  archived?: boolean | undefined;
  unreadOnly?: boolean | undefined;
};

export type ChatsRepo = {
  /** Create the row if absent; never clobbers a known name with null. */
  ensure: (id: string, isGroup: boolean) => void;
  patch: (id: string, p: ChatPatch) => void;
  get: (id: string) => ChatRow | undefined;
  list: (filter: ChatListFilter, limit: number, offset: number) => ChatRow[];
  /** Advance last_message_ts only forwards, so out-of-order history can't rewind a chat. */
  touch: (id: string, ts: number) => void;
  bumpUnread: (id: string, by: number) => void;
  clearUnread: (id: string) => void;
  count: () => number;
};

type ChatRowRaw = {
  id: string;
  name: string | null;
  is_group: number;
  last_message_ts: number | null;
  unread_count: number;
  archived: number;
  muted_until: number | null;
  participant_count: number | null;
};

function toChatRow(raw: ChatRowRaw): ChatRow {
  return {
    id: raw.id,
    name: raw.name,
    isGroup: raw.is_group !== 0,
    lastMessageTs: raw.last_message_ts,
    unreadCount: raw.unread_count,
    archived: raw.archived !== 0,
    mutedUntil: raw.muted_until,
    participantCount: raw.participant_count,
  };
}

const SELECT_COLUMNS = `
  id, name, is_group, last_message_ts, unread_count, archived, muted_until, participant_count
`;

export function makeChatsRepo(db: Db): ChatsRepo {
  const ensureStmt = db.prepare("INSERT INTO chats (id, is_group) VALUES (?, ?) ON CONFLICT (id) DO NOTHING");
  const getStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM chats WHERE id = ?`);
  const touchStmt = db.prepare("UPDATE chats SET last_message_ts = MAX(COALESCE(last_message_ts, 0), ?) WHERE id = ?");
  const bumpUnreadStmt = db.prepare("UPDATE chats SET unread_count = unread_count + ? WHERE id = ?");
  const clearUnreadStmt = db.prepare("UPDATE chats SET unread_count = 0 WHERE id = ?");
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM chats");

  function ensure(id: string, isGroup: boolean): void {
    ensureStmt.run(id, isGroup ? 1 : 0);
  }

  function patch(id: string, p: ChatPatch): void {
    const sets: string[] = [];
    const params: Record<string, string | number | null> = { id };

    if (Object.hasOwn(p, "name")) {
      sets.push("name = :name");
      params["name"] = p.name ?? null;
    }
    if (Object.hasOwn(p, "isGroup")) {
      sets.push("is_group = :isGroup");
      params["isGroup"] = p.isGroup === true ? 1 : 0;
    }
    if (Object.hasOwn(p, "unreadCount")) {
      sets.push("unread_count = :unreadCount");
      params["unreadCount"] = p.unreadCount ?? null;
    }
    if (Object.hasOwn(p, "archived")) {
      sets.push("archived = :archived");
      params["archived"] = p.archived === true ? 1 : 0;
    }
    if (Object.hasOwn(p, "mutedUntil")) {
      sets.push("muted_until = :mutedUntil");
      params["mutedUntil"] = p.mutedUntil ?? null;
    }
    if (Object.hasOwn(p, "participantCount")) {
      sets.push("participant_count = :participantCount");
      params["participantCount"] = p.participantCount ?? null;
    }
    if (Object.hasOwn(p, "raw")) {
      sets.push("raw = :raw");
      params["raw"] = p.raw === undefined ? null : JSON.stringify(p.raw);
    }

    if (sets.length === 0) return;
    db.prepare(`UPDATE chats SET ${sets.join(", ")} WHERE id = :id`).run(params);
  }

  function get(id: string): ChatRow | undefined {
    const row = getStmt.get(id) as ChatRowRaw | undefined;
    return row === undefined ? undefined : toChatRow(row);
  }

  function list(filter: ChatListFilter, limit: number, offset: number): ChatRow[] {
    const where: string[] = [];
    const params: Record<string, string | number> = { limit, offset };

    if (filter.query !== undefined) {
      where.push("LOWER(name) LIKE :query ESCAPE '\\'");
      params["query"] = `%${escapeLike(filter.query)}%`.toLowerCase();
    }
    if (filter.isGroup !== undefined) {
      where.push("is_group = :isGroup");
      params["isGroup"] = filter.isGroup ? 1 : 0;
    }
    if (filter.archived !== undefined) {
      where.push("archived = :archived");
      params["archived"] = filter.archived ? 1 : 0;
    }
    if (filter.unreadOnly === true) {
      where.push("unread_count > 0");
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM chats ${whereSql} ORDER BY last_message_ts DESC NULLS LAST, id ASC LIMIT :limit OFFSET :offset`,
      )
      .all(params) as ChatRowRaw[];
    return rows.map(toChatRow);
  }

  function touch(id: string, ts: number): void {
    touchStmt.run(ts, id);
  }

  function bumpUnread(id: string, by: number): void {
    bumpUnreadStmt.run(by, id);
  }

  function clearUnread(id: string): void {
    clearUnreadStmt.run(id);
  }

  function count(): number {
    return (countStmt.get() as { n: number }).n;
  }

  return { ensure, patch, get, list, touch, bumpUnread, clearUnread, count };
}
