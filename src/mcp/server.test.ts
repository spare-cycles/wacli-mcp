/**
 * The assembled server: which tools it advertises, and what the write and media tools do with what
 * the layers under them hand back.
 *
 * Everything here goes through the linked in-memory client, so a call is parsed by the SDK's own
 * schema validation before a handler ever sees it — which is the only way to see the tool list, and
 * the advertised argument schemas, that a real client would see. That matters more than it sounds:
 * the `wa_send_file` schema test below catches a failure mode in which every tool call still behaves
 * correctly and the advertised schema is empty.
 *
 * Two things are deliberately **not** stubbed. The image and video branches run jimp, ffmpeg and
 * ffprobe against real files built in `before`, because a stubbed converter would only ever assert
 * the stub — and the sticker route in particular exists because jimp cannot decode WebP. The
 * repositories are the real SQLite ones the harness builds.
 *
 * What *is* stubbed: the sender, the media store and the transcriber, none of which can exist in a
 * test without a WhatsApp socket. Each test that cares about a failure path installs a stub that
 * fails the way the real object documents it will, so what is under test is the tool's mapping of
 * that failure into an `isError` result rather than the failure itself.
 */

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { promisify } from "node:util";
import type { MessageKind } from "../db/messages.js";
import { MediaUnavailableError, type MediaFile, type MediaStore } from "../media/store.js";
import { TranscriptionError, type Transcriber } from "../media/transcribe.js";
import { ConnectionUnavailableError } from "../wa/connection.js";
import {
  MessageRevokedError,
  NotFoundError,
  NotOwnMessageError,
  SendPathError,
  type FileSource,
  type Sender,
  type SendFileOptions,
} from "../wa/send.js";
import type { ToolContext } from "./context.js";
import { buildMcpServer } from "./server.js";
import { harness, resultText, type Harness, type HarnessOptions, type RawToolResult } from "./tools/harness.js";

const run = promisify(execFile);

const CHAT = "33611111111@s.whatsapp.net";
const MSG = "M1";

const WRITE_TOOLS = [
  "wa_send_text",
  "wa_send_file",
  "wa_react",
  "wa_mark_read",
  "wa_edit_message",
  "wa_delete_message",
] as const;

const ALL_TOOLS = [
  "wa_chats_list",
  "wa_contacts_search",
  "wa_delete_message",
  "wa_download_media",
  "wa_edit_message",
  "wa_groups_list",
  "wa_health",
  "wa_mark_read",
  "wa_messages_list",
  "wa_messages_search",
  "wa_react",
  "wa_send_file",
  "wa_send_text",
  "wa_transcribe",
];

/** Fixtures are built once: ffmpeg is not free, and nothing here mutates them. */
const dir = mkdtempSync(join(tmpdir(), "wa-mcp-server-"));
const pngPath = join(dir, "photo.png");
const webpPath = join(dir, "sticker.webp");
const mp4Path = join(dir, "clip.mp4");
const docPath = join(dir, "notes.bin");

/** One still frame of `size`, in whatever format `extra` selects. */
function still(size: string, out: string, extra: readonly string[] = []): readonly string[] {
  return ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc=size=${size}:duration=1`, "-frames:v", "1", ...extra, out];
}

before(async () => {
  await run("ffmpeg", still("160x120", pngPath));
  await run("ffmpeg", still("128x128", webpPath, ["-c:v", "libwebp"]));
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-t", "2", mp4Path]);
  writeFileSync(docPath, "not a pdf at all\n");
});

/** The server under test is always the real one, so the read-only gating is exercised, not faked. */
function serverHarness(opts: HarnessOptions = {}): Promise<Harness> {
  return harness({ ...opts, build: buildMcpServer });
}

async function toolNames(h: Harness): Promise<string[]> {
  return (await h.client.listTools()).tools.map((t) => t.name);
}

type Block = { type: string; text?: string; data?: string; mimeType?: string };

function blocks(res: RawToolResult): Block[] {
  return (res.content ?? []) as Block[];
}

function imageBlocks(res: RawToolResult): Block[] {
  return blocks(res).filter((b) => b.type === "image");
}

/** The JSON summary a media tool returns alongside its blocks. */
function summaryOf(res: RawToolResult): Record<string, unknown> {
  const text = blocks(res).find((b) => b.type === "text" && b.text?.startsWith("{") === true)?.text;
  assert.ok(text !== undefined, `expected a JSON summary block, got: ${resultText(res)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/** A media store that always answers with one real file on disk. */
function mediaAt(path: string, mimetype: string): MediaStore {
  const file: MediaFile = { path, sha256: "b".repeat(64), bytes: statSync(path).size, mimetype };
  return { fetch: () => Promise.resolve(file), pathFor: (sha256: string) => join(dir, sha256) };
}

/** A sender whose every method fails the same way, for testing how a tool reports that failure. */
function failingSender(err: Error): Sender {
  const fail = (): Promise<never> => Promise.reject(err);
  return { sendText: fail, sendFile: fail, react: fail, markRead: fail, editMessage: fail, deleteMessage: fail };
}

function seedMedia(ctx: ToolContext, kind: MessageKind, mimetype: string): void {
  ctx.chats.ensure(CHAT, false);
  const ts = 1_700_000_000;
  ctx.messages.upsert({ chatId: CHAT, id: MSG, senderId: CHAT, ts, fromMe: false, kind, mediaType: mimetype });
}

// --- the tool surface -------------------------------------------------------------------------

void test("read-only mode hides every write tool and keeps the rest", async () => {
  const h = await serverHarness({ readOnly: true });
  try {
    const names = await toolNames(h);
    for (const n of WRITE_TOOLS) assert.ok(!names.includes(n), `${n} must not be advertised in read-only mode`);
    assert.ok(names.includes("wa_chats_list"));
    // The media tools are not write tools: neither one changes anything on WhatsApp, and a read-only
    // deployment that could not look at an attachment would be crippled for no gain.
    assert.ok(names.includes("wa_download_media"));
    assert.ok(names.includes("wa_transcribe"));
  } finally {
    await h.close();
  }
});

void test("all fourteen tools are advertised in normal mode", async () => {
  const h = await serverHarness({ readOnly: false });
  try {
    assert.deepEqual((await toolNames(h)).sort(), ALL_TOOLS);
  } finally {
    await h.close();
  }
});

void test("every tool name is wa_-prefixed", async () => {
  const h = await serverHarness({});
  try {
    for (const name of await toolNames(h)) assert.match(name, /^wa_/);
  } finally {
    await h.close();
  }
});

void test("the advertised version is the one in package.json", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  const h = await serverHarness({});
  try {
    assert.equal(h.client.getServerVersion()?.version, pkg.version);
    assert.equal(h.client.getServerVersion()?.name, "wa-mcp");
  } finally {
    await h.close();
  }
});

// --- write tools ------------------------------------------------------------------------------

void test("a write tool fails with the connection state named when the socket is down", async () => {
  const h = await serverHarness({ state: "disconnected" });
  try {
    const res = await h.client.callTool({ name: "wa_send_text", arguments: { chat: CHAT, text: "hi" } });
    assert.equal(res.isError, true);
    assert.match(resultText(res), /disconnected/);
  } finally {
    await h.close();
  }
});

void test("wa_send_text answers with the reference WhatsApp gave back", async () => {
  const h = await serverHarness({});
  try {
    const res = await h.client.callTool({ name: "wa_send_text", arguments: { chat: CHAT, text: "hi" } });
    assert.notEqual(res.isError, true, resultText(res));
    assert.deepEqual(JSON.parse(resultText(res)), { chat: "c", message_id: "S1" });
  } finally {
    await h.close();
  }
});

void test("wa_send_file passes every argument through to the sender under the right name", async () => {
  const files: { chat: string; src: FileSource; opts: SendFileOptions }[] = [];
  const texts: { chat: string; text: string; replyTo: string | undefined }[] = [];
  const sender: Sender = {
    ...failingSender(new Error("not part of this test")),
    sendText: (chat, text, replyTo) => {
      texts.push({ chat, text, replyTo });
      return Promise.resolve({ chatId: chat, messageId: "S1" });
    },
    sendFile: (chat, src, opts) => {
      files.push({ chat, src, opts });
      return Promise.resolve({ chatId: chat, messageId: "S2" });
    },
  };
  const h = await serverHarness({ overrides: { sender } });
  try {
    // Snake_case in, camelCase out: this is the only place that renaming happens, and a swap between
    // two adjacent string options would be invisible to every other test in this file.
    await h.client.callTool({
      name: "wa_send_file",
      arguments: {
        chat: CHAT,
        data: "aGk=",
        filename: "note.ogg",
        mimetype: "audio/ogg",
        caption: "listen",
        reply_to: "M7",
        as_voice_note: true,
      },
    });
    const sent = files[0];
    assert.ok(sent !== undefined, "the call must have reached the sender at all");
    assert.equal(sent.chat, CHAT);
    assert.deepEqual(sent.src, { kind: "data", base64: "aGk=" });
    assert.deepEqual(sent.opts, {
      filename: "note.ogg",
      mimetype: "audio/ogg",
      caption: "listen",
      replyTo: "M7",
      asVoiceNote: true,
    });

    await h.client.callTool({ name: "wa_send_file", arguments: { chat: CHAT, path: "/data/uploads/a.png" } });
    const byPath = files[1];
    assert.ok(byPath !== undefined);
    assert.deepEqual(byPath.src, { kind: "path", path: "/data/uploads/a.png" });

    await h.client.callTool({ name: "wa_send_text", arguments: { chat: CHAT, text: "hi", reply_to: "M7" } });
    assert.deepEqual(texts[0], { chat: CHAT, text: "hi", replyTo: "M7" });
  } finally {
    await h.close();
  }
});

void test("wa_react accepts an empty emoji, which is how WhatsApp removes a reaction", async () => {
  const calls: string[] = [];
  const sender: Sender = {
    ...failingSender(new Error("not part of this test")),
    react: (chat, _messageId, emoji) => {
      calls.push(emoji);
      return Promise.resolve({ chatId: chat });
    },
  };
  const h = await serverHarness({ overrides: { sender } });
  try {
    const res = await h.client.callTool({ name: "wa_react", arguments: { chat: CHAT, message_id: MSG, emoji: "" } });
    assert.notEqual(res.isError, true, resultText(res));
    assert.deepEqual(calls, [""], "a `min(1)` on the emoji would make removal impossible");
  } finally {
    await h.close();
  }
});

void test("wa_send_file rejects a request carrying neither path nor data", async () => {
  const h = await serverHarness({});
  try {
    const res = await h.client.callTool({ name: "wa_send_file", arguments: { chat: CHAT } });
    assert.equal(res.isError, true);
  } finally {
    await h.close();
  }
});

void test("wa_send_file rejects a request carrying both path and data", async () => {
  const h = await serverHarness({});
  try {
    const args = { chat: CHAT, path: "/data/uploads/a.png", data: "aGk=" };
    const res = await h.client.callTool({ name: "wa_send_file", arguments: args });
    assert.equal(res.isError, true);
  } finally {
    await h.close();
  }
});

void test("every tool advertises its arguments, flat and not as a union", async () => {
  const h = await serverHarness({});
  try {
    const tools = (await h.client.listTools()).tools;
    // Regression guard with teeth. `wa_send_file` was specified as a `.refine()`d Zod object, which
    // sdk 1.30 cannot describe: `normalizeObjectSchema` looks for `.shape`, a `ZodEffects` has none,
    // and the tool ends up advertised as `{"type":"object","properties":{}}` — every argument
    // invisible to every client — while still validating server-side, so nothing else notices.
    for (const tool of tools) {
      const schema = tool.inputSchema as { type?: string; properties?: Record<string, unknown> };
      assert.equal(schema.type, "object", `${tool.name}: input schema must be an object`);
      assert.ok(!("anyOf" in schema) && !("oneOf" in schema), `${tool.name}: the top level must not be a union`);
      if (tool.name === "wa_health") continue; // the one tool that really takes no arguments
      assert.ok(Object.keys(schema.properties ?? {}).length > 0, `${tool.name}: arguments must be advertised`);
    }

    const sendFile = tools.find((t) => t.name === "wa_send_file")?.inputSchema as
      { properties?: Record<string, unknown>; required?: string[] } | undefined;
    for (const key of ["chat", "path", "data", "filename", "mimetype", "caption", "reply_to", "as_voice_note"]) {
      assert.ok(sendFile?.properties?.[key] !== undefined, `${key} must be a top-level property of wa_send_file`);
    }
    assert.deepEqual(sendFile?.required, ["chat"], "only the chat is unconditionally required");
  } finally {
    await h.close();
  }
});

void test("a sender failure comes back as a tool error, never as a thrown protocol error", async () => {
  const cases = [
    {
      err: new NotFoundError("no message M9 in chat c"),
      tool: "wa_react",
      args: { chat: CHAT, message_id: "M9", emoji: "👍" },
    },
    {
      err: new NotOwnMessageError("message M1 was not sent by this account"),
      tool: "wa_edit_message",
      args: { chat: CHAT, message_id: MSG, text: "x" },
    },
    {
      err: new MessageRevokedError("message M1 in chat c was revoked"),
      tool: "wa_send_text",
      args: { chat: CHAT, text: "re", reply_to: MSG },
    },
    {
      // `send.ts` never echoes the offending path, and neither may the tool that reports it.
      err: new SendPathError("sending a file by path is disabled; set WA_SEND_FILE_DIR"),
      tool: "wa_send_file",
      args: { chat: CHAT, path: "/etc/passwd" },
    },
  ];
  for (const c of cases) {
    const h = await serverHarness({ overrides: { sender: failingSender(c.err) } });
    try {
      const res = await h.client.callTool({ name: c.tool, arguments: c.args });
      assert.equal(res.isError, true, `${c.tool} must answer with isError`);
      assert.ok(resultText(res).includes(c.err.message), `${c.tool} must carry the reason: ${resultText(res)}`);
    } finally {
      await h.close();
    }
  }
});

void test("wa_mark_read and wa_delete_message report success without inventing a message id", async () => {
  const h = await serverHarness({});
  try {
    for (const tool of ["wa_mark_read", "wa_delete_message"]) {
      const res = await h.client.callTool({ name: tool, arguments: { chat: CHAT, message_id: MSG } });
      assert.notEqual(res.isError, true, resultText(res));
      // `chat` is the id the sender resolved the call against — the stub answers "c" for every
      // method — and not the string that went in. One field name cannot mean the canonical chat in
      // `wa_send_text` and "whatever you typed" here: a caller naming a chat by its LID would get
      // its own LID back and read an empty conversation when it fed that to wa_messages_list.
      assert.deepEqual(JSON.parse(resultText(res)), { status: "ok", chat: "c", message_id: MSG });
    }
  } finally {
    await h.close();
  }
});

/**
 * Argument order, per tool, against a sender that records which method was called with what.
 *
 * `markRead`, `deleteMessage`, `editMessage` and `react` all take `(chat, messageId, …)` as strings,
 * so a transposed pair type-checks, and two of the six tools are otherwise asserted identically —
 * which means calling `markRead` inside `wa_delete_message` passes every other test in this file.
 * Distinct values for the chat and the id are what make a swap visible; recording the method name is
 * what makes the wrong-method-entirely case visible.
 */
void test("each write tool calls its own sender method, with the chat and the message id in that order", async () => {
  const calls: string[] = [];
  const record =
    (method: string) =>
    (chat: string, messageId: string): Promise<{ chatId: string }> => {
      calls.push(`${method}(${chat}, ${messageId})`);
      return Promise.resolve({ chatId: chat });
    };
  const sender: Sender = {
    ...failingSender(new Error("not part of this test")),
    react: record("react"),
    markRead: record("markRead"),
    editMessage: record("editMessage"),
    deleteMessage: record("deleteMessage"),
  };
  const h = await serverHarness({ overrides: { sender } });
  try {
    const args = { chat: CHAT, message_id: MSG, emoji: "\u{1F44D}", text: "corrigé" };
    for (const tool of ["wa_react", "wa_mark_read", "wa_edit_message", "wa_delete_message"]) {
      const res = await h.client.callTool({ name: tool, arguments: args });
      assert.notEqual(res.isError, true, `${tool}: ${resultText(res)}`);
    }
    assert.deepEqual(calls, [
      `react(${CHAT}, ${MSG})`,
      `markRead(${CHAT}, ${MSG})`,
      `editMessage(${CHAT}, ${MSG})`,
      `deleteMessage(${CHAT}, ${MSG})`,
    ]);
  } finally {
    await h.close();
  }
});

// --- wa_download_media ------------------------------------------------------------------------

void test("wa_download_media returns image blocks for an image message", async () => {
  const h = await serverHarness({
    seed: (ctx) => {
      seedMedia(ctx, "image", "image/png");
      ctx.reactions.set({ chatId: CHAT, messageId: MSG, senderId: CHAT, emoji: "👍", ts: 1_700_000_001 });
    },
    overrides: { media: mediaAt(pngPath, "image/png") },
  });
  try {
    const res = await h.client.callTool({ name: "wa_download_media", arguments: { chat: CHAT, message_id: MSG } });
    assert.notEqual(res.isError, true, resultText(res));

    const images = imageBlocks(res);
    assert.equal(images.length, 1, "an image message is one block, never a keyframe strip");
    const image = images[0];
    assert.ok(image !== undefined);
    assert.equal(image.mimeType, "image/jpeg");
    const jpeg = Buffer.from(image.data ?? "", "base64");
    assert.ok(jpeg.length > 0, "the block must carry real bytes");
    assert.equal(jpeg.subarray(0, 2).toString("hex"), "ffd8", "the block must actually be a JPEG");

    const summary = summaryOf(res);
    assert.equal(summary["width"], 160);
    assert.equal(summary["height"], 120);
    assert.equal(summary["bytes"], statSync(pngPath).size);
    assert.equal(summary["mimetype"], "image/png");
    // Single-message context: this is the one place the full reaction shape belongs.
    assert.deepEqual(summary["reactions"], [{ emoji: "👍", from: { id: CHAT, name: CHAT } }]);
  } finally {
    await h.close();
  }
});

void test("wa_download_media decodes a sticker, which is always WebP", async () => {
  const h = await serverHarness({
    seed: (ctx) => {
      seedMedia(ctx, "sticker", "image/webp");
    },
    overrides: { media: mediaAt(webpPath, "image/webp") },
  });
  try {
    const res = await h.client.callTool({ name: "wa_download_media", arguments: { chat: CHAT, message_id: MSG } });
    assert.notEqual(res.isError, true, resultText(res));
    assert.equal(imageBlocks(res).length, 1);
    assert.equal(summaryOf(res)["width"], 128);
  } finally {
    await h.close();
  }
});

void test("wa_download_media samples a video and never exceeds the keyframe budget", async () => {
  const h = await serverHarness({
    seed: (ctx) => {
      seedMedia(ctx, "video", "video/mp4");
    },
    overrides: { media: mediaAt(mp4Path, "video/mp4") },
  });
  try {
    const res = await h.client.callTool({ name: "wa_download_media", arguments: { chat: CHAT, message_id: MSG } });
    assert.notEqual(res.isError, true, resultText(res));

    // The `videoKeyframes + 1` cap in `compose` is deliberately *not* asserted here. No branch can
    // reach it — the image branch produces one block and this one produces exactly
    // `config.videoKeyframes` — so from out here any assertion about it is a restatement of the line
    // above. The line that used to follow it (`length <= budget + 1`) was exactly that.
    assert.equal(imageBlocks(res).length, h.ctx.config.videoKeyframes);

    const summary = summaryOf(res);
    assert.equal(summary["width"], 320);
    assert.equal(summary["height"], 240);
    assert.equal(summary["duration_sec"], 2);
  } finally {
    await h.close();
  }
});

void test("wa_download_media returns the cached transcript for an audio message", async () => {
  const h = await serverHarness({
    seed: (ctx) => {
      seedMedia(ctx, "audio", "audio/ogg");
      ctx.messages.setTranscript(CHAT, MSG, "bonjour, c'est un message vocal");
    },
    overrides: { media: mediaAt(docPath, "audio/ogg") },
  });
  try {
    const res = await h.client.callTool({ name: "wa_download_media", arguments: { chat: CHAT, message_id: MSG } });
    assert.notEqual(res.isError, true, resultText(res));
    assert.equal(imageBlocks(res).length, 0, "audio carries no picture");
    assert.match(resultText(res), /bonjour, c'est un message vocal/);
    // The cached transcript is the point: downloading a voice note must not spend a whisper run.
    assert.equal(h.transcribeCalls.n, 0);
  } finally {
    await h.close();
  }
});

void test("wa_download_media tells the model to transcribe an untranscribed voice note", async () => {
  const h = await serverHarness({
    seed: (ctx) => {
      seedMedia(ctx, "audio", "audio/ogg");
    },
    overrides: { media: mediaAt(mp4Path, "audio/ogg") },
  });
  try {
    const res = await h.client.callTool({ name: "wa_download_media", arguments: { chat: CHAT, message_id: MSG } });
    assert.notEqual(res.isError, true, resultText(res));
    assert.match(resultText(res), /wa_transcribe/);
    assert.equal(summaryOf(res)["duration_sec"], 2, "the duration is what tells the model whether it is worth it");
    assert.equal(h.transcribeCalls.n, 0);
  } finally {
    await h.close();
  }
});

void test("wa_download_media hands back the cache path for a document it cannot render", async () => {
  const h = await serverHarness({
    seed: (ctx) => {
      seedMedia(ctx, "document", "application/octet-stream");
    },
    overrides: { media: mediaAt(docPath, "application/octet-stream") },
  });
  try {
    const res = await h.client.callTool({ name: "wa_download_media", arguments: { chat: CHAT, message_id: MSG } });
    assert.notEqual(res.isError, true, resultText(res));
    const summary = summaryOf(res);
    assert.equal(summary["path"], docPath);
    assert.equal(summary["mimetype"], "application/octet-stream");
    assert.equal(summary["bytes"], statSync(docPath).size);
  } finally {
    await h.close();
  }
});

void test("a PDF whose text cannot be extracted degrades to the summary rather than failing", async () => {
  // The fixture is deliberately *not* a PDF, and that is the point: what is under test is the
  // routing, not pdftotext (convert.test.ts covers that against a real PDF). The same bytes under
  // `application/octet-stream` came back with their path and no error in the test above; claiming to
  // be a PDF sends them to pdftotext, which refuses them — so the failure is proof of the branch.
  const h = await serverHarness({
    seed: (ctx) => {
      seedMedia(ctx, "document", "application/pdf");
    },
    overrides: { media: mediaAt(docPath, "application/pdf") },
  });
  try {
    const res = await h.client.callTool({ name: "wa_download_media", arguments: { chat: CHAT, message_id: MSG } });
    assert.notEqual(res.isError, true, "one failed extraction must not throw away the whole answer");
    assert.match(resultText(res), /pdftotext/, "and it says why the text is missing");
    const summary = summaryOf(res);
    assert.equal(summary["path"], docPath, "the path, size and mimetype survive the failure");
    assert.equal(summary["mimetype"], "application/pdf");
    assert.equal(summary["bytes"], statSync(docPath).size);
  } finally {
    await h.close();
  }
});

void test("wa_download_media refuses a message the store has never seen", async () => {
  const h = await serverHarness({});
  try {
    const res = await h.client.callTool({ name: "wa_download_media", arguments: { chat: CHAT, message_id: "M404" } });
    assert.equal(res.isError, true);
    assert.match(resultText(res), /M404/);
  } finally {
    await h.close();
  }
});

void test("wa_download_media distinguishes a downed connection from media that is gone", async () => {
  const gone = new MediaUnavailableError("WhatsApp media URLs expire, so a message this old is no longer downloadable");
  const down = new ConnectionUnavailableError("connecting");
  for (const err of [gone, down]) {
    const h = await serverHarness({
      seed: (ctx) => {
        seedMedia(ctx, "image", "image/png");
      },
      overrides: {
        media: { fetch: () => Promise.reject(err), pathFor: (sha: string) => join(dir, sha) },
      },
    });
    try {
      const res = await h.client.callTool({ name: "wa_download_media", arguments: { chat: CHAT, message_id: MSG } });
      assert.equal(res.isError, true);
      assert.ok(resultText(res).includes(err.name), `the two failures must stay distinguishable: ${resultText(res)}`);
    } finally {
      await h.close();
    }
  }
});

// --- wa_transcribe ----------------------------------------------------------------------------

void test("wa_transcribe caches: a second call does not re-run whisper", async () => {
  const h = await serverHarness({
    seed: (ctx) => {
      seedMedia(ctx, "audio", "audio/ogg");
    },
    overrides: { media: mediaAt(docPath, "audio/ogg") },
  });
  try {
    const first = await h.client.callTool({ name: "wa_transcribe", arguments: { chat: CHAT, message_id: MSG } });
    assert.notEqual(first.isError, true, resultText(first));
    assert.equal(resultText(first), "transcrit");
    assert.equal(h.transcribeCalls.n, 1);
    // Written through, so wa_messages_search finds it: setTranscript re-indexes into FTS.
    assert.equal(h.ctx.messages.get(CHAT, MSG)?.transcript, "transcrit");

    const second = await h.client.callTool({ name: "wa_transcribe", arguments: { chat: CHAT, message_id: MSG } });
    assert.equal(resultText(second), "transcrit");
    assert.equal(h.transcribeCalls.n, 1, "the second call must be served from the cache");
  } finally {
    await h.close();
  }
});

void test("wa_transcribe reports why transcription failed, verbatim", async () => {
  const reason = "no speech was detected in this recording";
  const transcriber: Transcriber = {
    ensureModel: () => Promise.resolve("/models/x.bin"),
    transcribeFile: () => Promise.reject(new TranscriptionError(reason)),
    available: () => Promise.resolve(true),
  };
  const h = await serverHarness({
    seed: (ctx) => {
      seedMedia(ctx, "audio", "audio/ogg");
    },
    overrides: { media: mediaAt(docPath, "audio/ogg"), transcriber },
  });
  try {
    const res = await h.client.callTool({ name: "wa_transcribe", arguments: { chat: CHAT, message_id: MSG } });
    assert.equal(res.isError, true);
    assert.ok(resultText(res).includes(reason), resultText(res));
    assert.equal(h.ctx.messages.get(CHAT, MSG)?.transcript, null, "a failed run must not cache anything");
  } finally {
    await h.close();
  }
});

void test("wa_transcribe refuses a message the store has never seen", async () => {
  const h = await serverHarness({});
  try {
    const res = await h.client.callTool({ name: "wa_transcribe", arguments: { chat: CHAT, message_id: "M404" } });
    assert.equal(res.isError, true);
    assert.equal(h.transcribeCalls.n, 0);
  } finally {
    await h.close();
  }
});
