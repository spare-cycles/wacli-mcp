/**
 * Everything a tool handler is allowed to reach: the five repositories, the connection, the sender,
 * the media store, the transcriber, and config.
 *
 * It is a plain record on purpose. Tools receive it, they do not construct it — `main.ts` (Task 14)
 * is the single place the real objects are wired together, and every test builds the same shape with
 * whichever parts it needs stubbed.
 *
 * Note what is *not* here: no database handle, and nothing from `baileys`. A tool that needs a query
 * the repositories do not expose grows a repository method (Global Constraint 12).
 */

import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { ChatsRepo } from "../db/chats.js";
import type { ContactsRepo } from "../db/contacts.js";
import type { MessagesRepo } from "../db/messages.js";
import type { MetaRepo } from "../db/meta.js";
import type { ReactionsRepo } from "../db/reactions.js";
import type { AutoTranscriber } from "../media/autotranscribe.js";
import type { MediaStore } from "../media/store.js";
import type { Transcriber } from "../media/transcribe.js";
import type { WhatsAppConnection } from "../whatsapp/connection.js";
import type { Sender } from "../whatsapp/send.js";

export type ToolContext = {
  config: Config;
  logger: Logger;
  chats: ChatsRepo;
  contacts: ContactsRepo;
  messages: MessagesRepo;
  reactions: ReactionsRepo;
  meta: MetaRepo;
  conn: WhatsAppConnection;
  sender: Sender;
  media: MediaStore;
  transcriber: Transcriber;
  /**
   * Terms worth spelling correctly in this chat, for a backend that can use them.
   *
   * A function on the context rather than a module import inside the tool, so a test can pass one
   * that returns nothing and so the tool layer keeps its rule of reaching only for what it is
   * handed (Global Constraint 12).
   */
  biasTermsFor: (chatId: string) => readonly string[];
  /**
   * The background transcription lane, when the deployment runs one.
   *
   * Optional because auto-transcription is off by default and `whatsapp_health` has to be able to
   * say so — the alternative is a null-object that reports plausible zeroes for a feature that is
   * not running.
   */
  autoTranscriber?: AutoTranscriber | undefined;
};
