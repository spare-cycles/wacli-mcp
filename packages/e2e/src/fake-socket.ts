/**
 * One Baileys socket, faked, complete enough to drive the whole API end to end.
 *
 * `ConnectionDeps.makeSocket` is an injectable factory — documented "injectable so tests never open
 * a websocket" — and three *partial* fakes already live in `packages/api`'s own suites:
 * `connection.test.ts` has the event bus, `user` and `end`; `send.test.ts` has `sendMessage` and
 * `readMessages` plus a `generateWAMessageContent` echo; `ingest.test.ts` has the bare `ev.on`.
 * This is their union, plus the one thing none of them has.
 *
 * **`updateMediaMessage` is the addition.** `MediaStore.fetch` hands it to Baileys'
 * `downloadMediaMessage` as `reuploadRequest`, so it sits on the cache-miss path that
 * `whatsapp_download_media` exercises — the union of the three would have left the most interesting
 * media path untestable. Only `packages/api`'s `media/store.test.ts` had it, on a fake that has
 * nothing else at all.
 *
 * **What is genuinely new is that all of it is one object.** No existing fake drives
 * `connection.update`, `ev.on("messages.upsert")` *and* `sendMessage`/`readMessages` together, and
 * that combination is the whole point: the connection has to open before `requireSocket()` will
 * hand the sender anything, ingest has to have written a row before a write can quote it, and the
 * send has to come back through ingest before a read can see it.
 *
 * It is a bare object literal cast with `as unknown as WASocket`, which is the idiom all four
 * existing fakes use — never `satisfies WASocket`, which would demand the ~60 members of the real
 * type for no gain.
 */

import {
  proto,
  type AnyMessageContent,
  type BaileysEventMap,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "baileys";
import { EventEmitter } from "node:events";

/** One `sendMessage`, exactly as the sender made it. */
export type RecordedSend = { jid: string; content: AnyMessageContent; options: unknown };

export type FakeSocketOptions = {
  /** The account's own JID, reported through `sock.user.id` when the connection opens. */
  selfId?: string;
  /** Delivered as one `messages.upsert` by `open()`, after the connection reports itself open. */
  messages?: readonly WAMessage[];
  /** Delivered as one `contacts.upsert` by `open()`, before the messages, so senders resolve. */
  contacts?: readonly { id: string; name?: string; notify?: string }[];
};

export type FakeSocket = {
  /** Hand this to `ConnectionDeps.makeSocket`. */
  makeSocket: (config: unknown) => WASocket;
  /** Every `sendMessage` the sender made, in order. */
  sends: RecordedSend[];
  /** Every batch of keys handed to `readMessages`. */
  reads: WAMessageKey[][];
  /** Every message handed to `updateMediaMessage`, i.e. every expired-URL re-upload. */
  reuploads: WAMessage[];
  /**
   * Report the connection open and replay the seeded history.
   *
   * Must be called after `conn.start()`, which is what constructs the socket: a fake with no socket
   * yet has nothing to emit into. Awaiting it lets ingest's synchronous writes settle before a read
   * goes looking for them.
   */
  open: () => Promise<void>;
  /** Fire any Baileys event at whatever is listening. */
  emit: <T extends keyof BaileysEventMap>(event: T, payload: BaileysEventMap[T]) => void;
};

/** Bytes `downloadMediaMessage` would have produced, for a `MediaStore` that must not hit the network. */
export const FAKE_MEDIA_BYTES = Buffer.from("%PDF-1.4 not really a pdf, but really these bytes\n");

const DEFAULT_SELF = "33600000000:1@s.whatsapp.net";

/**
 * The `WAMessage` a real `sendMessage` hands back, mirroring `generateWAMessageContent`.
 *
 * Copied from `packages/api/src/whatsapp/send.test.ts` because the distinction it draws is
 * load-bearing here too: an edit and a delete come back as a `protocolMessage` and a reaction as a
 * `reactionMessage`, and ingest deliberately stores none of those as a new row. A fake that always
 * answered with a text message would make a send look like it created three.
 */
function generatedMessage(jid: string, content: AnyMessageContent, id: string): WAMessage {
  const key: WAMessageKey = { remoteJid: jid, id, fromMe: true };
  const base = { key, messageTimestamp: Math.floor(Date.now() / 1000) };
  if ("react" in content) return { ...base, message: { reactionMessage: content.react } };
  if ("delete" in content) {
    return {
      ...base,
      message: { protocolMessage: { key: content.delete, type: proto.Message.ProtocolMessage.Type.REVOKE } },
    };
  }
  if ("edit" in content && "text" in content) {
    return {
      ...base,
      message: {
        protocolMessage: {
          key: content.edit,
          editedMessage: { conversation: content.text },
          type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
        },
      },
    };
  }
  if ("text" in content) return { ...base, message: { conversation: content.text } };
  const mimetype = "mimetype" in content ? (content.mimetype ?? null) : null;
  if ("image" in content) return { ...base, message: { imageMessage: { mimetype } } };
  if ("video" in content) return { ...base, message: { videoMessage: { mimetype } } };
  if ("audio" in content) return { ...base, message: { audioMessage: { mimetype } } };
  if ("document" in content) return { ...base, message: { documentMessage: { mimetype } } };
  return { ...base, message: {} };
}

export function fakeSocket(opts: FakeSocketOptions = {}): FakeSocket {
  const bus = new EventEmitter();
  // Ten listeners is the Node default and `ingest.attach` alone registers eleven; the warning it
  // would otherwise print on every boot says nothing about this test.
  bus.setMaxListeners(50);

  const sends: RecordedSend[] = [];
  const reads: WAMessageKey[][] = [];
  const reuploads: WAMessage[] = [];
  let sent = 0;

  const sock = {
    ev: { on: bus.on.bind(bus), off: bus.off.bind(bus), removeAllListeners: bus.removeAllListeners.bind(bus) },
    user: { id: opts.selfId ?? DEFAULT_SELF },
    sendMessage: (jid: string, content: AnyMessageContent, options?: unknown): Promise<WAMessage | undefined> => {
      sends.push({ jid, content, options });
      sent += 1;
      return Promise.resolve(generatedMessage(jid, content, `SENT${String(sent)}`));
    },
    readMessages: (keys: WAMessageKey[]): Promise<void> => {
      reads.push(keys);
      return Promise.resolve();
    },
    updateMediaMessage: (m: WAMessage): Promise<WAMessage> => {
      reuploads.push(m);
      return Promise.resolve(m);
    },
    requestPairingCode: (n: string) => Promise.resolve(`CODE-${n.slice(-4)}`),
    logout: () => Promise.resolve(),
    end: () => undefined,
  } as unknown as WASocket;

  const emit = <T extends keyof BaileysEventMap>(event: T, payload: BaileysEventMap[T]): void => {
    bus.emit(event, payload);
  };

  return {
    makeSocket: () => sock,
    sends,
    reads,
    reuploads,
    emit,
    open: async () => {
      emit("connection.update", { connection: "open" });
      if (opts.contacts !== undefined && opts.contacts.length > 0) emit("contacts.upsert", [...opts.contacts]);
      if (opts.messages !== undefined && opts.messages.length > 0) {
        emit("messages.upsert", { messages: [...opts.messages], type: "notify" });
      }
      // Ingest writes synchronously inside the emit above; one turn of the loop is enough to let
      // anything it deferred settle before a reader goes looking.
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}
