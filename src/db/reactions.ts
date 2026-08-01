import type { Db } from "./client.js";

export type ReactionRow = { chatId: string; messageId: string; senderId: string; emoji: string; ts: number };

export type ReactionsRepo = {
  /** An empty emoji removes the reaction. Same (chat, message, sender) replaces. */
  set: (r: ReactionRow) => void;
  forMessage: (chatId: string, messageId: string) => ReactionRow[];
  /**
   * How many reactions each of `messageIds` carries, in **one** grouped query.
   *
   * This exists so a list of fifty messages costs one query rather than fifty `forMessage` calls.
   * Messages with no reactions are simply absent from the map.
   */
  countsFor: (chatId: string, messageIds: readonly string[]) => Map<string, number>;
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

  function countsFor(chatId: string, messageIds: readonly string[]): Map<string, number> {
    const counts = new Map<string, number>();
    if (messageIds.length === 0) return counts;
    // The placeholder count varies with the page size, so this one statement cannot be prepared
    // ahead of time. The list is bounded by the tools' `limit` cap (200), so the SQL stays small.
    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT message_id, COUNT(*) AS c FROM reactions
          WHERE chat_id = ? AND message_id IN (${placeholders})
          GROUP BY message_id`,
      )
      .all(chatId, ...messageIds) as { message_id: string; c: number }[];
    for (const row of rows) counts.set(row.message_id, row.c);
    return counts;
  }

  function count(): number {
    return (countStmt.get() as { n: number }).n;
  }

  return { set, forMessage, countsFor, count };
}
