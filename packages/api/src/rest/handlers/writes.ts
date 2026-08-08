/**
 * The eight routes that change something: the six sends, transcription, and the recipient lookup a
 * UI needs to build a picker.
 *
 * **`readOnly` is enforced here, and this is the only place it is enforced.** A separate process
 * cannot be trusted to police itself: the MCP additionally *discovers* the flag so it never
 * advertises a tool that cannot work, but that is a courtesy layered on top of this gate, not a
 * substitute for it. The gate covers exactly the six sends — a read-only deployment refuses every
 * one of them here, whatever the caller. `transcribe` and `resolveRecipient` are
 * deliberately outside it: `whatsapp_transcribe` lives in `registerMediaTools` and answers today in
 * a read-only deployment, and resolving a recipient sends nothing at all.
 *
 * **An ambiguous recipient is refused, never guessed.** `whatsapp/recipient.ts` does the refusing;
 * what this layer adds is the machine-readable half — `details.candidates`, 1-based, in the
 * resolver's own total order, so `pick: 2` on the retry means the row the refusal numbered 2
 * (Global Constraint 11). The candidates are re-derived from `candidatesFor` rather than parsed out
 * of the message, so the list a client reads and the list the resolver will index into on the retry
 * are produced by one function.
 *
 * **`react`'s `emoji` takes no `.min(1)`, on the wire schema or here.** An empty string is how
 * WhatsApp models *removing* a reaction; the obvious improvement deletes the removal path.
 */

import {
  AmbiguousRecipientError as WireAmbiguousRecipientError,
  ApiError,
  BadRequestError,
  type Handlers,
  type RecipientCandidate as WireRecipientCandidate,
  type SendResult,
} from "whatsapp-api-sdk";

import { canonicalId, parseRecipient } from "../../whatsapp/jid.js";
import { AmbiguousRecipientError, candidatesFor } from "../../whatsapp/recipient.js";
import type { FileSource, SendFileOptions, SendTextOptions } from "../../whatsapp/send.js";
import type { RestDeps } from "../server.js";
import { requireRow, transcriptOf } from "./subject.js";

/** The slice of the handler map this module owns. */
export type WriteHandlers = Pick<
  Handlers,
  "sendText" | "sendFile" | "editMessage" | "deleteMessage" | "react" | "markRead" | "transcribe" | "resolveRecipient"
>;

/** `SendFileBody`'s two mutually exclusive sources, as this layer sees them. */
type FileBody = { data?: string | undefined; path?: string | undefined };

/**
 * The bytes to send, or a refusal naming what was wrong.
 *
 * "Exactly one of `data`/`path`" is enforced here rather than by a `.refine()` on the wire schema,
 * because the two spellings of wrong are different mistakes with different advice and an
 * `invalid_union` could only say "invalid". Both messages are the ones the retired in-process tool
 * layer produced, character for character, so nothing a model reads moves.
 */
function fileSource(body: FileBody): FileSource {
  if (body.path !== undefined && body.data !== undefined) {
    throw new BadRequestError("give either `data` (base64 bytes) or `path` (a server-side file), not both");
  }
  if (body.path !== undefined) return { kind: "path", path: body.path };
  if (body.data !== undefined) return { kind: "data", base64: body.data };
  throw new BadRequestError(
    "provide exactly one of `data` (base64 bytes) or `path` (a server-side file under WHATSAPP_SEND_FILE_DIR)",
  );
}

export function writeHandlers(deps: RestDeps): WriteHandlers {
  const { config, chats, contacts, messages, media, sender, transcriber } = deps;

  /**
   * The gate, applied before anything is resolved or read.
   *
   * `read_only` is 403 and its `name` is the literal `"Error"`, like every other refusal this
   * codebase raises without a legacy class behind it.
   */
  const requireWritable = (): void => {
    if (config.readOnly) {
      throw new ApiError(
        "read_only",
        "this deployment is read-only: sending, editing, reacting, revoking and marking read are disabled",
      );
    }
  };

  /**
   * Every chat or contact a recipient string matches, numbered the way `pick` counts.
   *
   * A JID or a phone number resolves without touching the store, exactly as `resolveRecipient`
   * does, and answers with the one candidate it is — so `POST /v1/recipients/resolve` is useful for
   * confirming what an id folds to, not only for names.
   */
  const candidates = (recipient: string): WireRecipientCandidate[] => {
    const form = parseRecipient(recipient);
    if (form.kind !== "name") {
      const id = canonicalId(form.jid, contacts);
      return [{ index: 1, id, label: contacts.displayName(id), exact: true }];
    }
    // `.trim()` because `resolveRecipient` looks the name up trimmed: an untrimmed lookup here
    // would number a different list than the one `pick` will index into.
    return candidatesFor(recipient.trim(), { chats, contacts }).map((candidate, i) => ({
      index: i + 1,
      id: candidate.id,
      label: candidate.label,
      exact: candidate.exact,
    }));
  };

  /**
   * Run a send, and give an ambiguity refusal the numbered list a client can act on.
   *
   * The domain error carries only its message — it is raised well below HTTP — so the details are
   * attached here, at the one layer that knows what `details` is for.
   */
  const sending = async (recipient: string, work: () => Promise<SendResult>): Promise<SendResult> => {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof AmbiguousRecipientError)) throw err;
      throw new WireAmbiguousRecipientError(err.message, {
        name: err.name,
        details: { candidates: candidates(recipient) },
      });
    }
  };

  return {
    sendText: ({ body }) => {
      requireWritable();
      const options: SendTextOptions = { replyTo: body.replyTo, mentions: body.mentions, pick: body.pick };
      return sending(body.recipient, async () => {
        const ref = await sender.sendText(body.recipient, body.text, options);
        return { chat: ref.chatId, messageId: ref.messageId };
      });
    },

    /**
     * `data` is base64 in the JSON body; `path` names a file on the **API** host and stays gated
     * behind `WHATSAPP_SEND_FILE_DIR`, unset by default. `whatsapp/send.ts` resolves it through
     * symlinks, confines it to that directory, and never echoes the path it was asked to read —
     * distinct answers would turn the refusal into a filesystem-existence oracle.
     */
    sendFile: ({ body }) => {
      requireWritable();
      const source = fileSource(body);
      const options: SendFileOptions = {
        filename: body.filename,
        mimetype: body.mimetype,
        caption: body.caption,
        replyTo: body.replyTo,
        asVoiceNote: body.asVoiceNote,
        pick: body.pick,
      };
      return sending(body.recipient, async () => {
        const ref = await sender.sendFile(body.recipient, source, options);
        return { chat: ref.chatId, messageId: ref.messageId };
      });
    },

    /**
     * The five routes below take a chat and a message id that came from a listing, so there is
     * nothing to disambiguate and no `pick`: each answers with the chat the sender really acted on
     * — a LID and its phone JID are one conversation — rather than echoing what the caller typed.
     */
    editMessage: async ({ params, body }) => {
      requireWritable();
      const ref = await sender.editMessage(params.chat, params.id, body.text);
      return { chat: ref.chatId, messageId: params.id };
    },

    deleteMessage: async ({ params }) => {
      requireWritable();
      const ref = await sender.deleteMessage(params.chat, params.id);
      return { chat: ref.chatId, messageId: params.id };
    },

    react: async ({ params, body }) => {
      requireWritable();
      const ref = await sender.react(params.chat, params.id, body.emoji);
      return { chat: ref.chatId, messageId: params.id };
    },

    /** The id is in the body because the *chat* is what gets marked, up to and including it. */
    markRead: async ({ params, body }) => {
      requireWritable();
      const ref = await sender.markRead(params.chat, body.messageId);
      return { chat: ref.chatId, messageId: body.messageId };
    },

    /**
     * Costs money and mutates the store, so it is a write — and synchronous, because a caller that
     * asked for a transcript wants the text rather than a job id.
     *
     * The cache is consulted first, which is what makes this affordable to call twice, and the
     * result is written back through the repository rather than kept in memory: the UPDATE fires
     * the FTS trigger, and that is what puts the speech into the search index.
     *
     * Not behind `requireWritable`: `whatsapp_transcribe` is registered by `registerMediaTools` and
     * answers today in a read-only deployment. Gating it here would be a behaviour change smuggled
     * in under a refactor.
     */
    transcribe: async ({ params }) => {
      const row = requireRow(deps, params.chat, params.id);
      const cached = transcriptOf(row);
      if (cached !== null) return cached;

      const file = await media.fetch(row.chatId, row.id);
      // The interactive lane: someone asked, so this may fall back to the paid API when the
      // self-hosted endpoint is cold or down. The background lane may not — see `transcribe.ts`.
      const result = await transcriber.transcribeFile(file.path, {
        mimetype: file.mimetype,
        lane: "interactive",
        biasTerms: deps.biasTermsFor(row.chatId),
      });
      messages.setTranscript(row.chatId, row.id, result);
      return result;
    },

    /** The same resolution a send performs, without sending anything. */
    resolveRecipient: ({ body }) => Promise.resolve({ candidates: candidates(body.recipient) }),
  };
}
