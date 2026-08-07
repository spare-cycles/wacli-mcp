import { proto, type AnyMessageContent, type WAMessage, type WAMessageKey, type WASocket } from "baileys";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Logger } from "pino";
import { makeChatsRepo, type ChatsRepo } from "../db/chats.js";
import { openDb } from "../db/client.js";
import { makeContactsRepo, type ContactsRepo } from "../db/contacts.js";
import { makeMessagesRepo, type MessageRow, type MessagesRepo } from "../db/messages.js";
import { makeReactionsRepo } from "../db/reactions.js";
import type { WhatsAppConnection } from "./connection.js";
import * as fx from "./fixtures.js";
import { makeIngest, type Ingest } from "./ingest.js";
import {
  makeSender,
  MessageRevokedError,
  NotFoundError,
  NotOwnMessageError,
  SendPathError,
  type SendDeps,
} from "./send.js";

const DM = "33612345678@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";
const SELF = "33600000000@s.whatsapp.net";

const dir = mkdtempSync(join(tmpdir(), "whatsapp-send-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const silentLogger = {
  info() {
    /* no-op */
  },
  warn() {
    /* no-op */
  },
  error() {
    /* no-op */
  },
  debug() {
    /* no-op */
  },
} as unknown as Logger;

/**
 * The `WAMessage` a real `sendMessage` would hand back for a given content, mirroring
 * `generateWAMessageContent` (baileys `lib/Utils/messages.js`): an edit and a delete both become a
 * `protocolMessage`, a reaction becomes a `reactionMessage`, and only ordinary content stays
 * ordinary. Nothing else lets a test observe what ingest does with what a send produced — a fake
 * that always returned a text message would make the "no spurious row" assertions vacuous.
 */
function generatedMessage(jid: string, content: AnyMessageContent, id: string): WAMessage {
  const key: WAMessageKey = { remoteJid: jid, id, fromMe: true };
  const base = { key, messageTimestamp: fx.FIXTURE_TS };
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

type RecordedSend = { jid: string; content: AnyMessageContent; options: unknown };

/** A socket stub that records every call and answers with what Baileys would have produced. */
function fakeSocket() {
  const calls: RecordedSend[] = [];
  const readCalls: WAMessageKey[][] = [];
  let sent = 0;
  const sock = {
    sendMessage: (jid: string, content: AnyMessageContent, options?: unknown): Promise<WAMessage | undefined> => {
      calls.push({ jid, content, options });
      sent += 1;
      return Promise.resolve(generatedMessage(jid, content, `SENT${sent}`));
    },
    readMessages: (keys: WAMessageKey[]): Promise<void> => {
      readCalls.push(keys);
      return Promise.resolve();
    },
  };
  return { sock, calls, readCalls };
}

// --- the stub harness -------------------------------------------------------------------------

/** A stored message, as the harness's fake repository holds it. */
type FakeRow = {
  fromMe?: boolean | undefined;
  ts?: number | undefined;
  senderId?: string | undefined;
  /** false models a row stored without its protobuf envelope, which cannot be quoted. */
  quotable?: boolean | undefined;
  /**
   * true models a tombstoned row: `markDeleted` cleared its `text`, and deliberately left `raw` —
   * the envelope Baileys' retry path still needs — sitting there for a read site to misuse.
   */
  deleted?: boolean | undefined;
};

type HarnessOptions = {
  rows?: Record<string, FakeRow> | undefined;
  sendFileDir?: string | undefined;
  maxUploadBytes?: number | undefined;
  /** LID → phone JID, the one identity fact `canonicalId` consults. */
  pnForLid?: ((lid: string) => string | undefined) | undefined;
  /** Chats and contacts a name can resolve to; see `whatsapp/recipient.ts`. Empty means JIDs only. */
  named?: readonly { id: string; name: string; isGroup?: boolean }[] | undefined;
  /** true makes `requireSocket()` throw, as it does whenever the connection is not open. */
  offline?: boolean | undefined;
};

function materialize(id: string, spec: FakeRow): { row: MessageRow; raw: Uint8Array | undefined } {
  const fromMe = spec.fromMe ?? false;
  const ts = spec.ts ?? fx.FIXTURE_TS;
  const row: MessageRow = {
    rowid: 1,
    chatId: DM,
    id,
    senderId: spec.senderId ?? DM,
    ts,
    fromMe,
    kind: "text",
    // Exactly what `markDeleted` leaves behind: text and transcript cleared, deleted_ts set.
    text: spec.deleted === true ? null : "stored",
    transcript: null,
    quotedId: null,
    status: null,
    editedTs: null,
    deletedTs: spec.deleted === true ? fx.FIXTURE_TS + 1 : null,
    mediaType: null,
    mediaSha: null,
    // Schema V2. `null` rather than `false` for `ptt`: these fixtures are text messages, which
    // carry no audio facts at all, and that is a different statement from "not a voice note".
    ptt: null,
    durationS: null,
    transcriptModel: null,
  };
  const raw =
    spec.quotable === false
      ? undefined
      : proto.WebMessageInfo.encode(fx.textMessage({ chat: DM, id, ts, fromMe })).finish();
  return { row, raw };
}

/** The substring rule both repositories match names by, restated for the stubs above. */
function matchesName(name: string, query: string | undefined): boolean {
  return query === undefined || name.toLowerCase().includes(query.toLowerCase());
}

function harness(opts: HarnessOptions = {}) {
  const named = (opts.named ?? []).map((c) => ({ ...c, notify: null }));
  const { sock, calls, readCalls } = fakeSocket();
  const entries = Object.entries(opts.rows ?? {}).map(([id, spec]) => [id, materialize(id, spec)] as const);
  const stored = new Map(entries);
  const ingested: WAMessage[] = [];
  const clearedUnread: string[] = [];
  const unreadLimits: number[] = [];

  const messages = {
    get: (_chatId: string, id: string) => stored.get(id)?.row,
    getRaw: (_chatId: string, id: string) => stored.get(id)?.raw,
    unreadKeysUpTo: (_chatId: string, ts: number, limit: number) => {
      unreadLimits.push(limit);
      return [...stored.values()]
        .map((e) => e.row)
        .filter((r) => !r.fromMe && r.deletedTs === null && r.ts <= ts)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit)
        .map((r) => ({ id: r.id, senderId: r.senderId }));
    },
  } satisfies Pick<MessagesRepo, "get" | "getRaw" | "unreadKeysUpTo">;

  const deps: SendDeps = {
    conn: {
      requireSocket: () => {
        if (opts.offline === true) throw new Error('WhatsApp connection unavailable: current state is "disconnected"');
        return sock as unknown as WASocket;
      },
    } as unknown as WhatsAppConnection,
    ingest: {
      ingestMessage: (m: WAMessage) => {
        ingested.push(m);
      },
    } as unknown as Ingest,
    messages: messages as unknown as MessagesRepo,
    chats: {
      clearUnread: (id: string) => {
        clearedUnread.push(id);
      },
      // Substring, case-insensitive — the same shape the real `chats.list({ query })` has.
      list: (filter: { query?: string | undefined }) =>
        named.filter((c) => c.isGroup === true && matchesName(c.name, filter.query)),
    } as unknown as ChatsRepo,
    contacts: {
      pnForLid: opts.pnForLid ?? (() => undefined),
      search: (query: string) => named.filter((c) => c.isGroup !== true && matchesName(c.name, query)),
    } as unknown as ContactsRepo,
    maxUploadBytes: opts.maxUploadBytes ?? 1024,
    sendFileDir: opts.sendFileDir,
  };

  return { sender: makeSender(deps), calls, readCalls, ingested, clearedUnread, unreadLimits };
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

// --- text -------------------------------------------------------------------------------------

void test("sendText sends and re-ingests the produced message", async () => {
  const h = harness();
  const ref = await h.sender.sendText(DM, "salut");
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0]?.content, { text: "salut" });
  assert.equal(ref.chatId, DM);
  assert.equal(ref.messageId, "SENT1");
  assert.equal(h.ingested.length, 1, "a sent message must take the inbound path");
  assert.equal(h.ingested[0]?.key.id, "SENT1");
});

void test("sendText resolves a recipient named by name", async () => {
  const h = harness({
    named: [
      { id: DM, name: "Marie" },
      { id: GROUP, name: "Les Copains", isGroup: true },
    ],
  });
  await h.sender.sendText("Marie", "salut");
  assert.equal(h.calls[0]?.jid, DM, "the name must reach the socket as the resolved JID");
  await h.sender.sendText("Les Copains", "salut");
  assert.equal(h.calls[1]?.jid, GROUP);
  // And a phone number written the way a human writes one.
  await h.sender.sendText("+33 6 12 34 56 78", "salut");
  assert.equal(h.calls[2]?.jid, DM);
});

void test("an ambiguous name is refused before the socket is touched at all", async () => {
  const h = harness({
    named: [
      { id: DM, name: "Marie Dupont" },
      { id: SELF, name: "Marie Curie" },
    ],
  });
  await assert.rejects(() => h.sender.sendText("Marie", "salut"), /matches 2/);
  assert.equal(h.calls.length, 0, "nothing may be sent while the recipient is in doubt");
  // `pick` is what resolves it, and it selects by the order the refusal printed.
  await h.sender.sendText("Marie", "salut", { pick: 1 });
  assert.equal(h.calls[0]?.jid, SELF, "1) Marie Curie sorts before 2) Marie Dupont");
});

void test("sendText marks mentions, resolving each to a user JID", async () => {
  const h = harness();
  await h.sender.sendText(GROUP, "@33612345678 tu viens ?", { mentions: ["+33 6 12 34 56 78"] });
  assert.deepEqual(h.calls[0]?.content, { text: "@33612345678 tu viens ?", mentions: [DM] });
});

void test("sendText omits the mentions field entirely when there are none", async () => {
  const h = harness();
  await h.sender.sendText(DM, "salut", { mentions: [] });
  assert.deepEqual(h.calls[0]?.content, { text: "salut" }, "an empty list must not become mentions: []");
});

void test("a mention that is a name rather than a number is refused, and sends nothing", async () => {
  const h = harness({ named: [{ id: DM, name: "Marie" }] });
  // Resolving it would happily answer with a group JID, which WhatsApp renders as a broken tag.
  await assert.rejects(() => h.sender.sendText(GROUP, "@Marie", { mentions: ["Marie"] }), /must be a phone number/);
  assert.equal(h.calls.length, 0);
});

void test("sendFile takes a name and a pick too", async () => {
  const h = harness({ named: [{ id: DM, name: "Marie" }] });
  await h.sender.sendFile("Marie", { kind: "data", base64: b64("hi") }, { filename: "a.txt" });
  assert.equal(h.calls[0]?.jid, DM);
});

void test("sendText with replyTo attaches the quoted message", async () => {
  const h = harness({ rows: { M0: { fromMe: false } } });
  await h.sender.sendText(DM, "re", { replyTo: "M0" });
  const quoted = (h.calls[0]?.options as { quoted?: WAMessage }).quoted;
  assert.ok(quoted, "replyTo must become a quoted option");
  // `quoted` wants the whole WebMessageInfo envelope, not the inner `message` the socket's
  // getMessage contract unwraps: Baileys reads `quoted.key` *and* `quoted.message`.
  assert.equal(quoted.key.id, "M0");
  assert.equal(quoted.message?.conversation, "hello");
});

void test("replyTo pointing at an unknown message fails loudly", async () => {
  const h = harness();
  await assert.rejects(() => h.sender.sendText(DM, "re", { replyTo: "GHOST" }), NotFoundError);
  assert.equal(h.calls.length, 0);
});

void test("replyTo pointing at a row with no stored envelope fails rather than sending a broken quote", async () => {
  const h = harness({ rows: { M0: { quotable: false } } });
  await assert.rejects(() => h.sender.sendText(DM, "re", { replyTo: "M0" }), NotFoundError);
  assert.equal(h.calls.length, 0);
});

// --- the tombstone, honoured on the send path too ----------------------------------------------

void test("a reply naming a revoked message is refused, and nothing is sent", async () => {
  const h = harness({ rows: { M0: { deleted: true } } });
  await assert.rejects(() => h.sender.sendText(DM, "re", { replyTo: "M0" }), MessageRevokedError);
  assert.equal(
    h.calls.length,
    0,
    "quoting embeds the stored envelope as contextInfo.quotedMessage, which would re-publish to the chat exactly the content the sender revoked",
  );
});

void test("a file reply naming a revoked message is refused too", async () => {
  const h = harness({ rows: { M0: { deleted: true } } });
  await assert.rejects(
    () => h.sender.sendFile(DM, { kind: "data", base64: b64("x") }, { mimetype: "image/png", replyTo: "M0" }),
    MessageRevokedError,
  );
  assert.equal(h.calls.length, 0);
});

void test("reacting to a revoked message is refused", async () => {
  const h = harness({ rows: { M0: { deleted: true } } });
  await assert.rejects(() => h.sender.react(DM, "M0", "\u{1F44D}"), MessageRevokedError);
  assert.equal(h.calls.length, 0, "a tombstone is not a message to hang a reaction on");
});

void test("editing or re-revoking a revoked message is refused", async () => {
  const h = harness({ rows: { MINE: { fromMe: true, deleted: true } } });
  await assert.rejects(() => h.sender.editMessage(DM, "MINE", "back from the dead"), MessageRevokedError);
  await assert.rejects(() => h.sender.deleteMessage(DM, "MINE"), MessageRevokedError);
  assert.equal(h.calls.length, 0);
});

void test("a revoked message is refused as revoked, not as missing", async () => {
  const h = harness({ rows: { M0: { deleted: true } } });
  await assert.rejects(
    () => h.sender.sendText(DM, "re", { replyTo: "M0" }),
    (err: unknown) => {
      assert.ok(err instanceof MessageRevokedError);
      assert.ok(!(err instanceof NotFoundError), "the row is present; calling it missing tells the caller to retry");
      assert.match(err.message, /revoked/);
      return true;
    },
  );
});

void test("an ordinary reply, reaction, edit and delete still work alongside the tombstone check", async () => {
  const h = harness({ rows: { LIVE: { fromMe: true }, THEIRS: { fromMe: false }, GONE: { deleted: true } } });
  await h.sender.sendText(DM, "re", { replyTo: "LIVE" });
  await h.sender.react(DM, "THEIRS", "\u{1F44D}");
  await h.sender.editMessage(DM, "LIVE", "corrigé");
  await h.sender.deleteMessage(DM, "LIVE");
  assert.equal(h.calls.length, 4, "the check must refuse only the tombstoned row");
  assert.equal((h.calls[0]?.options as { quoted?: WAMessage }).quoted?.key.id, "LIVE");
});

void test("the chat argument is canonicalized before sending", async () => {
  const h = harness();
  await h.sender.sendText("33612345678:12@s.whatsapp.net", "hi");
  assert.equal(h.calls[0]?.jid, DM);
});

void test("a LID chat is canonicalized through the contacts lookup", async () => {
  const h = harness({ pnForLid: (lid) => (lid === "999" ? DM : undefined) });
  await h.sender.sendText("999@lid", "hi");
  assert.equal(h.calls[0]?.jid, DM);
});

void test("a send on a connection that is not open fails fast and touches nothing", async () => {
  const h = harness({ offline: true });
  await assert.rejects(() => h.sender.sendText(DM, "hi"), /disconnected/);
  assert.equal(h.calls.length, 0);
});

// --- files ------------------------------------------------------------------------------------

void test("sendFile from base64 rejects oversize payloads before sending", async () => {
  const h = harness();
  const big = Buffer.alloc(2048).toString("base64");
  await assert.rejects(() => h.sender.sendFile(DM, { kind: "data", base64: big }, {}), /exceeds/i);
  assert.equal(h.calls.length, 0);
});

void test("sendFile picks the content key from the mimetype", async () => {
  const h = harness();
  await h.sender.sendFile(DM, { kind: "data", base64: b64("x") }, { mimetype: "image/png", caption: "cap" });
  assert.ok(Object.hasOwn(h.calls[0]?.content as object, "image"));
  assert.equal((h.calls[0]?.content as { caption?: string }).caption, "cap");
  await h.sender.sendFile(DM, { kind: "data", base64: b64("x") }, { mimetype: "application/pdf", filename: "a.pdf" });
  assert.ok(Object.hasOwn(h.calls[1]?.content as object, "document"));
  assert.equal((h.calls[1]?.content as { fileName?: string }).fileName, "a.pdf");
  await h.sender.sendFile(DM, { kind: "data", base64: b64("x") }, { mimetype: "video/mp4" });
  assert.ok(Object.hasOwn(h.calls[2]?.content as object, "video"));
});

void test("the mimetype falls back to the filename extension, then to octet-stream", async () => {
  const h = harness();
  await h.sender.sendFile(DM, { kind: "data", base64: b64("x") }, { filename: "holiday.JPG" });
  assert.ok(Object.hasOwn(h.calls[0]?.content as object, "image"));
  assert.equal((h.calls[0]?.content as { mimetype?: string }).mimetype, "image/jpeg");
  await h.sender.sendFile(DM, { kind: "data", base64: b64("x") }, { filename: "notes" });
  const doc = h.calls[1]?.content as { document?: unknown; mimetype?: string; fileName?: string };
  assert.ok(doc.document);
  assert.equal(doc.mimetype, "application/octet-stream");
  assert.equal(doc.fileName, "notes");
});

void test("asVoiceNote sends audio with ptt set", async () => {
  const h = harness();
  await h.sender.sendFile(DM, { kind: "data", base64: b64("x") }, { mimetype: "audio/ogg", asVoiceNote: true });
  const content = h.calls[0]?.content as { audio?: unknown; ptt?: boolean };
  assert.ok(content.audio);
  assert.equal(content.ptt, true);
});

void test("asVoiceNote with nothing to infer a mimetype from still sends audio", async () => {
  const h = harness();
  await h.sender.sendFile(DM, { kind: "data", base64: b64("x") }, { asVoiceNote: true });
  const content = h.calls[0]?.content as { audio?: unknown; ptt?: boolean };
  assert.ok(content.audio, "an explicit voice note must not silently become an octet-stream document");
  assert.equal(content.ptt, true);
});

void test("an explicit mimetype outranks asVoiceNote", async () => {
  const h = harness();
  await h.sender.sendFile(DM, { kind: "data", base64: b64("x") }, { mimetype: "image/png", asVoiceNote: true });
  assert.ok(Object.hasOwn(h.calls[0]?.content as object, "image"));
});

void test("sendFile carries replyTo through as a quoted message", async () => {
  const h = harness({ rows: { M0: {} } });
  await h.sender.sendFile(DM, { kind: "data", base64: b64("x") }, { mimetype: "image/png", replyTo: "M0" });
  assert.ok((h.calls[0]?.options as { quoted?: WAMessage }).quoted);
});

// --- path confinement (the plan's Task 13 security requirement, enforced here) -----------------

void test("path sending is refused when no directory is configured", async () => {
  const h = harness({ sendFileDir: undefined });
  await assert.rejects(
    () => h.sender.sendFile(DM, { kind: "path", path: "/etc/passwd" }, {}),
    /WHATSAPP_SEND_FILE_DIR/,
    "the refusal must name the variable that would enable it",
  );
  assert.equal(h.calls.length, 0);
});

void test("the disabled refusal is distinguishable from an out-of-bounds one", async () => {
  const h = harness({ sendFileDir: undefined });
  await assert.rejects(
    () => h.sender.sendFile(DM, { kind: "path", path: "/etc/passwd" }, {}),
    (err: unknown) => {
      assert.ok(err instanceof SendPathError);
      assert.doesNotMatch(err.message, /outside/i, "an unconfigured directory is not a containment failure");
      return true;
    },
  );
});

void test("path sending refuses traversal, symlink escape and sibling-prefix paths", async () => {
  const h = harness({ sendFileDir: "/data/uploads" });
  for (const p of ["/etc/passwd", "/data/uploads/../../etc/passwd", "/data/uploads-evil/x", "/proc/self/environ"]) {
    await assert.rejects(() => h.sender.sendFile(DM, { kind: "path", path: p }, {}), /outside/i, p);
  }
  assert.equal(h.calls.length, 0);
});

void test("containment holds against a real directory, its siblings and a symlink out of it", async () => {
  const root = realpathSync(mkdtempSync(join(dir, "root-")));
  const uploads = join(root, "uploads");
  const evil = join(root, "uploads-evil");
  mkdirSync(uploads);
  mkdirSync(evil);
  writeFileSync(join(uploads, "ok.txt"), "hello");
  writeFileSync(join(evil, "secret.txt"), "nope");
  writeFileSync(join(root, "outside.txt"), "nope");
  symlinkSync(join(root, "outside.txt"), join(uploads, "escape.txt"));

  const h = harness({ sendFileDir: uploads });
  await h.sender.sendFile(DM, { kind: "path", path: join(uploads, "ok.txt") }, { mimetype: "text/plain" });
  assert.equal(h.calls.length, 1, "a file genuinely inside the directory must send");

  for (const p of [
    join(uploads, "escape.txt"), // a symlink whose target is out of bounds
    join(uploads, "..", "outside.txt"), // traversal back out
    join(evil, "secret.txt"), // sibling sharing the directory's name as a prefix
    join(uploads, "does-not-exist.txt"), // absent, and must not be told apart from the rest
    uploads, // the directory itself is not a file to send
  ]) {
    await assert.rejects(() => h.sender.sendFile(DM, { kind: "path", path: p }, {}), /outside/i, p);
  }
  assert.equal(h.calls.length, 1, "no refused path may reach the socket");
});

void test("the refusal never echoes the path it was asked to read", async () => {
  const root = realpathSync(mkdtempSync(join(dir, "quiet-")));
  const uploads = join(root, "uploads");
  mkdirSync(uploads);
  const h = harness({ sendFileDir: uploads });
  await assert.rejects(
    () => h.sender.sendFile(DM, { kind: "path", path: "/etc/shadow" }, {}),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /etc|shadow/, "echoing the probed path answers the probe");
      return true;
    },
  );
});

void test("a file inside the directory is still held to the upload limit", async () => {
  const root = realpathSync(mkdtempSync(join(dir, "big-")));
  writeFileSync(join(root, "big.bin"), Buffer.alloc(64));
  const h = harness({ sendFileDir: root, maxUploadBytes: 16 });
  await assert.rejects(() => h.sender.sendFile(DM, { kind: "path", path: join(root, "big.bin") }, {}), /exceeds/i);
  assert.equal(h.calls.length, 0);
});

// --- reactions --------------------------------------------------------------------------------

void test("react sends a reaction keyed to the target message", async () => {
  const h = harness({ rows: { M1: { fromMe: false } } });
  await h.sender.react(DM, "M1", "👍");
  const content = h.calls[0]?.content as { react?: { text: string; key: WAMessageKey } };
  assert.equal(content.react?.text, "👍");
  assert.equal(content.react.key.id, "M1");
  assert.equal(content.react.key.fromMe, false);
  assert.equal(content.react.key.participant, undefined, "a DM key must not carry a participant");
});

void test("an empty emoji is a valid reaction removal", async () => {
  const h = harness({ rows: { M1: { fromMe: false } } });
  await h.sender.react(DM, "M1", "");
  assert.equal((h.calls[0]?.content as { react: { text: string } }).react.text, "");
});

void test("reacting in a group names the participant the message came from", async () => {
  const h = harness({ rows: { M1: { senderId: SELF, fromMe: true } } });
  await h.sender.react(GROUP, "M1", "🎉");
  const key = (h.calls[0]?.content as { react: { key: WAMessageKey } }).react.key;
  assert.equal(key.remoteJid, GROUP);
  assert.equal(key.participant, SELF);
  assert.equal(key.fromMe, true);
});

void test("reacting to an unknown message fails loudly", async () => {
  const h = harness();
  await assert.rejects(() => h.sender.react(DM, "GHOST", "👍"), NotFoundError);
});

// --- edits and deletes ------------------------------------------------------------------------

void test("edit and delete refuse messages that are not ours", async () => {
  const h = harness({ rows: { THEIRS: { fromMe: false }, MINE: { fromMe: true } } });
  await assert.rejects(() => h.sender.editMessage(DM, "THEIRS", "nope"), NotOwnMessageError);
  await assert.rejects(() => h.sender.deleteMessage(DM, "THEIRS"), NotOwnMessageError);
  await h.sender.editMessage(DM, "MINE", "ok");
  await h.sender.deleteMessage(DM, "MINE");
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0]?.content, { text: "ok", edit: { remoteJid: DM, id: "MINE", fromMe: true } });
  assert.deepEqual(h.calls[1]?.content, { delete: { remoteJid: DM, id: "MINE", fromMe: true } });
});

void test("edit and delete on an unknown message fail loudly", async () => {
  const h = harness();
  await assert.rejects(() => h.sender.editMessage(DM, "GHOST", "x"), NotFoundError);
  await assert.rejects(() => h.sender.deleteMessage(DM, "GHOST"), NotFoundError);
});

// --- markRead ---------------------------------------------------------------------------------

void test("markRead calls readMessages with the target key", async () => {
  const h = harness({ rows: { M1: { fromMe: false } } });
  await h.sender.markRead(DM, "M1");
  assert.equal(h.readCalls.length, 1);
  assert.equal(h.readCalls[0]?.length, 1);
  assert.deepEqual(h.readCalls[0][0], { remoteJid: DM, id: "M1", fromMe: false });
});

void test("markRead expands to every older unread message, not just the target", async () => {
  const h = harness({
    rows: {
      M1: { ts: 1 },
      M2: { ts: 2 },
      M3: { ts: 3 },
      M4: { ts: 4 }, // newer than the target: must not be marked
      MINE: { ts: 2, fromMe: true }, // ours: never unread
    },
  });
  await h.sender.markRead(DM, "M3");
  const ids = (h.readCalls[0] ?? []).map((k) => k.id);
  assert.deepEqual(ids, ["M3", "M2", "M1"], "marking M3 read must also mark M1 and M2, newest first");
});

void test("markRead clears the chat's unread count locally", async () => {
  const h = harness({ rows: { M1: {} } });
  await h.sender.markRead(DM, "M1");
  assert.deepEqual(h.clearedUnread, [DM]);
});

void test("markRead caps its expansion so a deep backlog cannot build an unbounded array", async () => {
  const h = harness({ rows: { M1: {} } });
  await h.sender.markRead(DM, "M1");
  assert.deepEqual(h.unreadLimits, [500]);
});

void test("markRead in a group builds keys carrying the participant", async () => {
  const h = harness({ rows: { M1: { senderId: DM } } });
  await h.sender.markRead(GROUP, "M1");
  assert.deepEqual(h.readCalls[0]?.[0], { remoteJid: GROUP, id: "M1", fromMe: false, participant: DM });
});

void test("markRead on an unknown message fails loudly and clears nothing", async () => {
  const h = harness();
  await assert.rejects(() => h.sender.markRead(DM, "GHOST"), NotFoundError);
  assert.deepEqual(h.clearedUnread, []);
});

void test("markRead with nothing to mark still clears the local count", async () => {
  const h = harness({ rows: { MINE: { fromMe: true } } });
  await h.sender.markRead(DM, "MINE");
  assert.equal(h.readCalls.length, 0, "an empty batch is not worth a round trip");
  assert.deepEqual(h.clearedUnread, [DM]);
});

// --- against the real ingest and the real repositories -----------------------------------------

/**
 * Invariant 2 says a send re-ingests what it produced. Everything above proves the call happens;
 * only the real `Ingest` over real repositories proves what it *does* — that a text send lands as a
 * row and that an edit, a delete and a reaction, which travel as control stanzas, do not add one.
 */
let dbn = 0;
function liveHarness() {
  const db = openDb(join(dir, `s${dbn++}.db`));
  const repos = {
    chats: makeChatsRepo(db),
    contacts: makeContactsRepo(db),
    messages: makeMessagesRepo(db),
    reactions: makeReactionsRepo(db),
  };
  const ingest = makeIngest({ db, ...repos, logger: silentLogger, selfId: () => SELF });
  const { sock, calls } = fakeSocket();
  const sender = makeSender({
    conn: { requireSocket: () => sock as unknown as WASocket } as unknown as WhatsAppConnection,
    ingest,
    messages: repos.messages,
    chats: repos.chats,
    contacts: repos.contacts,
    maxUploadBytes: 1024,
    sendFileDir: undefined,
  });
  return { ...repos, ingest, sender, calls };
}

void test("a sent text becomes a row through the real ingest", async () => {
  const h = liveHarness();
  const ref = await h.sender.sendText(DM, "salut");
  const row = h.messages.get(DM, ref.messageId);
  assert.equal(row?.text, "salut");
  assert.equal(row.fromMe, true);
  assert.equal(h.chats.get(DM)?.unreadCount, 0, "our own message must not raise an unread count");
});

void test("an edit, a delete and a reaction round-trip without creating a spurious row", async () => {
  const h = liveHarness();
  const ref = await h.sender.sendText(DM, "salut");
  const before = h.messages.count();

  await h.sender.editMessage(DM, ref.messageId, "corrigé");
  await h.sender.react(DM, ref.messageId, "👍");
  await h.sender.deleteMessage(DM, ref.messageId);

  assert.equal(h.calls.length, 4);
  assert.equal(h.messages.count(), before, "control stanzas are wire control, never conversation");
});

void test("quoting works against an envelope the real ingest stored", async () => {
  const h = liveHarness();
  h.ingest.ingestMessage(fx.textMessage({ chat: DM, id: "M0", ts: fx.FIXTURE_TS }));
  await h.sender.sendText(DM, "re", { replyTo: "M0" });
  const quoted = (h.calls[0]?.options as { quoted?: WAMessage }).quoted;
  assert.equal(quoted?.key.id, "M0");
  assert.equal(quoted.message?.conversation, "hello");
});

void test("a revoked message's content is never re-published, against the real repository", async () => {
  const h = liveHarness();
  h.ingest.ingestMessage(fx.textMessage({ chat: DM, id: "M0", ts: fx.FIXTURE_TS, text: "the secret" }));
  h.messages.markDeleted(DM, "M0", fx.FIXTURE_TS + 1);

  const row = h.messages.get(DM, "M0");
  assert.equal(row?.text, null, "markDeleted clears the text");
  assert.ok(
    h.messages.getRaw(DM, "M0"),
    "and deliberately keeps the envelope, which Baileys' retry path reads — so the send path is what has to refuse it",
  );

  await assert.rejects(() => h.sender.sendText(DM, "re", { replyTo: "M0" }), MessageRevokedError);
  await assert.rejects(() => h.sender.react(DM, "M0", "\u{1F44D}"), MessageRevokedError);
  assert.equal(h.calls.length, 0, "nothing carrying `the secret` may reach the socket");
});

void test("markRead expands over rows the real ingest wrote", async () => {
  const h = liveHarness();
  for (const [i, id] of ["A", "B", "C"].entries()) {
    h.ingest.ingestMessage(fx.textMessage({ chat: DM, id, ts: fx.FIXTURE_TS + i }));
  }
  assert.equal(h.chats.get(DM)?.unreadCount, 3);
  await h.sender.markRead(DM, "C");
  assert.equal(h.chats.get(DM)?.unreadCount, 0);
});
