/**
 * The one message a per-message route is about, and the transcript it may carry.
 *
 * Three handler modules need both — `getMessage`, every media representation, and `transcribe` —
 * and a copy in each is a copy that drifts. The lookup is also where `canonicalId` is applied, and
 * this layer is the only one allowed to apply it (Global Constraint 3): a LID and its phone JID
 * name one conversation, and a route that skipped the fold would answer `message_not_found` for a
 * message that is right there under the other identity.
 */

import { MessageNotFoundError, type Transcript } from "whatsapp-api-sdk";

import type { MessageRow } from "../../db/messages.js";
import { canonicalId } from "../../whatsapp/jid.js";
import type { RestDeps } from "../server.js";

/**
 * The stored row a caller named, or `message_not_found`.
 *
 * The **wire** class rather than `media/store.ts`'s in-process one, and that is the rule this whole
 * layer follows: the modules below throw domain errors and `rest/errors.ts` maps them, while a
 * handler deciding a refusal of its own throws the wire error directly — which `toApiError` passes
 * through by identity rather than rebuilding. Both render `MessageNotFoundError: no message … in
 * chat …`, character for character, so nothing a model reads moves.
 */
export function requireRow(deps: RestDeps, chat: string, id: string): MessageRow {
  const chatId = canonicalId(chat, deps.contacts);
  const row = deps.messages.get(chatId, id);
  if (row === undefined) throw new MessageNotFoundError(`no message ${id} in chat ${chatId}`);
  return row;
}

/**
 * What a row stored before schema V2 reports as its model.
 *
 * `Transcript.model` is a required string on the wire and `messages.transcript_model` is NULL for
 * every transcript the whisper.cpp era produced. Reporting the text without a model is not an
 * option the schema allows, and inventing a plausible model name would be a lie about provenance —
 * which is the exact thing schema V2 added the column to stop. So it says so.
 */
const UNKNOWN_MODEL = "unknown";

/**
 * The cached transcript, or `null` when there is none.
 *
 * The empty string counts as none: `markDeleted` clears the column outright, but a backend that
 * heard nothing has been known to store `""`, and a transcript of nothing is not a transcript.
 */
export function transcriptOf(row: MessageRow): Transcript | null {
  const text = row.transcript;
  if (text === null || text === "") return null;
  return { text, model: row.transcriptModel ?? UNKNOWN_MODEL, language: row.transcriptLanguage };
}
