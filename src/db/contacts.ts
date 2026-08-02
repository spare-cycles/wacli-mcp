import { lidFromJid, phoneFromJid } from "../whatsapp/jid.js";
import { escapeLike, type Db } from "./client.js";

export type ContactRow = {
  id: string;
  phoneNumber: string | null;
  lid: string | null;
  name: string | null;
  notify: string | null;
};

export type ContactInput = {
  id: string;
  phoneNumber?: string | undefined;
  lid?: string | undefined;
  name?: string | undefined;
  notify?: string | undefined;
  raw?: unknown;
};

export type ContactsRepo = {
  upsert: (c: ContactInput) => void;
  upsertMany: (cs: readonly ContactInput[]) => void;
  get: (id: string) => ContactRow | undefined;
  search: (query: string, limit: number, offset: number) => ContactRow[];
  /** Best display name: name, then notify, then the phone number, then the id. */
  displayName: (id: string) => string;
  /** Record that a LID and a phone JID are the same person. Idempotent, order-independent. */
  linkIdentity: (lidJid: string, phoneJid: string) => void;
  /** Backing for jid.ts's IdentityLookup. */
  pnForLid: (lid: string) => string | undefined;
  count: () => number;
};

type ContactRowRaw = {
  id: string;
  phone_number: string | null;
  lid: string | null;
  name: string | null;
  notify: string | null;
};

type LidChatRow = {
  is_group: number;
  last_message_ts: number | null;
  unread_count: number;
  name: string | null;
};

function toContactRow(raw: ContactRowRaw): ContactRow {
  return { id: raw.id, phoneNumber: raw.phone_number, lid: raw.lid, name: raw.name, notify: raw.notify };
}

const SELECT_COLUMNS = "id, phone_number, lid, name, notify";

export function makeContactsRepo(db: Db): ContactsRepo {
  const upsertStmt = db.prepare(`
    INSERT INTO contacts (id, phone_number, lid, name, notify, raw)
    VALUES (:id, :phoneNumber, :lid, :name, :notify, :raw)
    ON CONFLICT (id) DO UPDATE SET
      phone_number = COALESCE(excluded.phone_number, contacts.phone_number),
      lid = COALESCE(excluded.lid, contacts.lid),
      name = COALESCE(excluded.name, contacts.name),
      notify = COALESCE(excluded.notify, contacts.notify),
      raw = COALESCE(excluded.raw, contacts.raw)
  `);
  const getStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM contacts WHERE id = ?`);
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM contacts");
  const pnForLidStmt = db.prepare("SELECT id FROM contacts WHERE lid = ? AND phone_number IS NOT NULL");
  const searchStmt = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM contacts
     WHERE LOWER(name) LIKE :like ESCAPE '\\'
        OR LOWER(notify) LIKE :like ESCAPE '\\'
        OR LOWER(phone_number) LIKE :like ESCAPE '\\'
     LIMIT :limit OFFSET :offset`,
  );

  // --- linkIdentity's statements. Prepared once, run inside one transaction per call. ---

  // Contact merge: the phone row is the survivor.
  const ensurePhoneContactStmt = db.prepare(
    "INSERT INTO contacts (id, phone_number) VALUES (:id, :phoneNumber) ON CONFLICT (id) DO NOTHING",
  );
  const foldContactStmt = db.prepare(`
    UPDATE contacts SET
      name = COALESCE(contacts.name, (SELECT name FROM contacts WHERE id = :lidId)),
      notify = COALESCE(contacts.notify, (SELECT notify FROM contacts WHERE id = :lidId)),
      lid = :lid
    WHERE id = :phoneId
  `);
  const deleteContactStmt = db.prepare("DELETE FROM contacts WHERE id = ?");

  // Conversation re-pointing (Risk 1's completion): fold a chat already ingested under the LID
  // id into the phone id, so a mapping revealed mid-conversation doesn't split it into two.
  const getLidChatStmt = db.prepare("SELECT is_group, last_message_ts, unread_count, name FROM chats WHERE id = ?");
  const ensurePhoneChatStmt = db.prepare(
    "INSERT INTO chats (id, is_group) VALUES (:id, :isGroup) ON CONFLICT (id) DO NOTHING",
  );
  const foldChatStmt = db.prepare(`
    UPDATE chats SET
      last_message_ts = CASE
        WHEN last_message_ts IS NULL AND :lidTs IS NULL THEN NULL
        ELSE MAX(COALESCE(last_message_ts, 0), COALESCE(:lidTs, 0))
      END,
      unread_count = unread_count + :lidUnread,
      name = COALESCE(name, :lidName)
    WHERE id = :phoneId
  `);
  const deleteChatStmt = db.prepare("DELETE FROM chats WHERE id = ?");

  // Re-point messages/reactions before deleting the LID chat row above, or ON DELETE CASCADE on
  // messages.chat_id would drop them. UPDATE OR IGNORE absorbs a (chat_id, id) collision instead
  // of letting the unique index abort the whole merge; whatever is left under the LID id after
  // that is a duplicate of a row that already moved, so it's dropped.
  const repointMessagesChatStmt = db.prepare("UPDATE OR IGNORE messages SET chat_id = :phoneId WHERE chat_id = :lidId");
  const dropLeftoverMessagesStmt = db.prepare("DELETE FROM messages WHERE chat_id = ?");
  const repointReactionsChatStmt = db.prepare(
    "UPDATE OR IGNORE reactions SET chat_id = :phoneId WHERE chat_id = :lidId",
  );
  const dropLeftoverReactionsStmt = db.prepare("DELETE FROM reactions WHERE chat_id = ?");
  // Group messages carry the participant as sender_id, so the same person can appear as a LID
  // sender in a group whose chat id was never a LID itself.
  const repointSenderStmt = db.prepare("UPDATE messages SET sender_id = :phoneId WHERE sender_id = :lidId");
  // Same rationale as messages.sender_id above, and for the same reason as the reactions.chat_id
  // re-point: the same person can hold a reaction under both identities on the same message
  // (e.g. one reaction recorded before identity resolution, one after), which collides on the
  // (chat_id, message_id, sender_id) primary key. UPDATE OR IGNORE keeps the row already under
  // the phone id and drops whatever is left stuck under the LID id.
  const repointReactionsSenderStmt = db.prepare(
    "UPDATE OR IGNORE reactions SET sender_id = :phoneId WHERE sender_id = :lidId",
  );
  const dropLeftoverReactionsSenderStmt = db.prepare("DELETE FROM reactions WHERE sender_id = ?");

  function upsertOne(c: ContactInput): void {
    upsertStmt.run({
      id: c.id,
      phoneNumber: c.phoneNumber ?? null,
      lid: c.lid ?? null,
      name: c.name ?? null,
      notify: c.notify ?? null,
      raw: c.raw === undefined ? null : JSON.stringify(c.raw),
    });
  }

  function upsert(c: ContactInput): void {
    upsertOne(c);
  }

  function upsertMany(cs: readonly ContactInput[]): void {
    if (cs.length === 0) return;
    db.exec("BEGIN");
    try {
      for (const c of cs) upsertOne(c);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function get(id: string): ContactRow | undefined {
    const row = getStmt.get(id) as ContactRowRaw | undefined;
    return row === undefined ? undefined : toContactRow(row);
  }

  function search(query: string, limit: number, offset: number): ContactRow[] {
    const like = `%${escapeLike(query)}%`.toLowerCase();
    const rows = searchStmt.all({ like, limit, offset }) as ContactRowRaw[];
    return rows.map(toContactRow);
  }

  function displayName(id: string): string {
    const c = get(id);
    if (c === undefined) return id;
    return c.name ?? c.notify ?? c.phoneNumber ?? id;
  }

  function pnForLid(lid: string): string | undefined {
    const row = pnForLidStmt.get(lid) as { id: string } | undefined;
    return row?.id;
  }

  function count(): number {
    return (countStmt.get() as { n: number }).n;
  }

  /**
   * Layering compromise, deliberate: this repository writes directly to `chats`, `messages` and
   * `reactions`, not just `contacts`. The identity merge must be atomic — one transaction, no
   * window where the conversation is half under the LID id and half under the phone id — and
   * splitting it across the contacts/chats/messages repositories would either need a transaction
   * spanning three repos or leave that window open. See plan Risk 1.
   */
  function linkIdentity(lidJid: string, phoneJid: string): void {
    const lid = lidFromJid(lidJid);
    const phone = phoneFromJid(phoneJid);
    if (lid === undefined || phone === undefined) return;

    db.exec("BEGIN");
    try {
      // `ensure` the phone contact row first: a lid-mapping.update event routinely arrives
      // before any message from that person, so neither row may exist yet.
      ensurePhoneContactStmt.run({ id: phoneJid, phoneNumber: phone });
      foldContactStmt.run({ lidId: lidJid, lid, phoneId: phoneJid });
      deleteContactStmt.run(lidJid);

      const lidChat = getLidChatStmt.get(lidJid) as LidChatRow | undefined;
      if (lidChat !== undefined) {
        ensurePhoneChatStmt.run({ id: phoneJid, isGroup: lidChat.is_group });
        foldChatStmt.run({
          lidTs: lidChat.last_message_ts,
          lidUnread: lidChat.unread_count,
          lidName: lidChat.name,
          phoneId: phoneJid,
        });
      }

      repointMessagesChatStmt.run({ phoneId: phoneJid, lidId: lidJid });
      dropLeftoverMessagesStmt.run(lidJid);
      repointReactionsChatStmt.run({ phoneId: phoneJid, lidId: lidJid });
      dropLeftoverReactionsStmt.run(lidJid);
      repointSenderStmt.run({ phoneId: phoneJid, lidId: lidJid });
      repointReactionsSenderStmt.run({ phoneId: phoneJid, lidId: lidJid });
      dropLeftoverReactionsSenderStmt.run(lidJid);

      if (lidChat !== undefined) deleteChatStmt.run(lidJid);

      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return { upsert, upsertMany, get, search, displayName, linkIdentity, pnForLid, count };
}
