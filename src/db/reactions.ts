import type { Db } from "./client.js";

export type ReactionRow = { chatId: string; messageId: string; senderId: string; emoji: string; ts: number };

export type ReactionsRepo = {
  /** An empty emoji removes the reaction. Same (chat, message, sender) replaces. */
  set: (r: ReactionRow) => void;
  forMessage: (chatId: string, messageId: string) => ReactionRow[];
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

  function count(): number {
    return (countStmt.get() as { n: number }).n;
  }

  return { set, forMessage, count };
}
