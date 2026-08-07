import type { Db } from "./client.js";

export type ReactionRow = { chatId: string; messageId: string; senderId: string; emoji: string; ts: number };

/** A message named the way this store keys one: an id is unique only inside its own chat. */
export type MessageKey = { chatId: string; messageId: string };

export type ReactionCount = MessageKey & { count: number };

export type ReactionsRepo = {
  /** An empty emoji removes the reaction. Same (chat, message, sender) replaces. */
  set: (r: ReactionRow) => void;
  forMessage: (chatId: string, messageId: string) => ReactionRow[];
  /**
   * How many reactions each of `keys` carries, in **one** grouped query — for a whole page, however
   * many chats that page spans.
   *
   * It takes `(chatId, messageId)` pairs rather than one chat and its ids because a search page
   * legitimately spans as many chats as it has hits: scoping the query to a single chat would turn a
   * 200-hit cross-chat search into 200 queries, which is the same order of cost that reaching for
   * `forMessage` per row would have had. Messages with no reactions are simply absent from the
   * answer, never present with a zero.
   */
  countsFor: (keys: readonly MessageKey[]) => ReactionCount[];
  count: () => number;
};

type ReactionRowRaw = { chat_id: string; message_id: string; sender_id: string; emoji: string; ts: number };

function toReactionRow(raw: ReactionRowRaw): ReactionRow {
  return { chatId: raw.chat_id, messageId: raw.message_id, senderId: raw.sender_id, emoji: raw.emoji, ts: raw.ts };
}

const SELECT_COLUMNS = "chat_id, message_id, sender_id, emoji, ts";

export function makeReactionsRepo(db: Db): ReactionsRepo {
  const upsertStmt = db.prepare(`
    INSERT INTO reactions (chat_id, message_id, sender_id, emoji, ts)
    VALUES (:chatId, :messageId, :senderId, :emoji, :ts)
    ON CONFLICT (chat_id, message_id, sender_id) DO UPDATE SET
      emoji = excluded.emoji,
      ts = excluded.ts
  `);
  const deleteStmt = db.prepare("DELETE FROM reactions WHERE chat_id = ? AND message_id = ? AND sender_id = ?");
  const forMessageStmt = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM reactions WHERE chat_id = ? AND message_id = ? ORDER BY ts ASC`,
  );
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM reactions");

  function set(r: ReactionRow): void {
    if (r.emoji === "") {
      deleteStmt.run(r.chatId, r.messageId, r.senderId);
      return;
    }
    upsertStmt.run({ chatId: r.chatId, messageId: r.messageId, senderId: r.senderId, emoji: r.emoji, ts: r.ts });
  }

  function forMessage(chatId: string, messageId: string): ReactionRow[] {
    const rows = forMessageStmt.all(chatId, messageId) as ReactionRowRaw[];
    return rows.map(toReactionRow);
  }

  function countsFor(keys: readonly MessageKey[]): ReactionCount[] {
    if (keys.length === 0) return [];
    // The placeholder count varies with the page size, so this one statement cannot be prepared
    // ahead of time. The list is bounded by the tools' `limit` cap (200), so the SQL stays small.
    //
    // `(chat_id, message_id) IN (VALUES …)` is a row-value comparison, which SQLite answers from the
    // reactions primary key (`SEARCH reactions USING COVERING INDEX … (chat_id=? AND message_id=?)`)
    // rather than by scanning — so one statement covers a page spanning any number of chats.
    const placeholders = keys.map(() => "(?, ?)").join(", ");
    const params = keys.flatMap((k) => [k.chatId, k.messageId]);
    const rows = db
      .prepare(
        `SELECT chat_id, message_id, COUNT(*) AS c FROM reactions
          WHERE (chat_id, message_id) IN (VALUES ${placeholders})
          GROUP BY chat_id, message_id`,
      )
      .all(...params) as { chat_id: string; message_id: string; c: number }[];
    return rows.map((row) => ({ chatId: row.chat_id, messageId: row.message_id, count: row.c }));
  }

  function count(): number {
    return (countStmt.get() as { n: number }).n;
  }

  return { set, forMessage, countsFor, count };
}
