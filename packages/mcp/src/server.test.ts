/**
 * The assembled server: which tools it advertises, and what the write and media tools do with what
 * the API hands back. Ported from `packages/api/src/mcp/server.test.ts`.
 *
 * Everything here goes through the linked in-memory MCP client, so a call is parsed by the SDK's own
 * schema validation before a handler ever sees it — which is the only way to see the tool list, and
 * the advertised argument schemas, that a real client would see. That matters more than it sounds:
 * the `whatsapp_send_file` schema test below catches a failure mode in which every tool call still
 * behaves correctly and the advertised schema is empty.
 *
 * **What the split changed here, and it is three things — no more.** The retired suite ran jimp,
 * ffmpeg and ffprobe against real files, because the conversion happened in-process. It happens in
 * the API now, so what this suite asserts is that the MCP reports the API's answer unaltered: the
 * derivative's bytes pass through byte for byte, and the summary's keys and their order are pinned
 * as a *string* rather than a deep-equal, since key order is part of what a model reads.
 *
 * 1. **The document branch reports `url` where it reported `path`** — spec §7.1's first sanctioned
 *    exception. The path named a location on the API's disk. Both document sub-branches change, PDF
 *    included, and the extraction-failure note is reworded to match.
 * 2. **`whatsapp_send_file`'s "exactly one of data/path" is the API's refusal now.** The retired
 *    tests asserted the MCP refused it; the MCP forwards it, deliberately, so that one layer
 *    authors the refusal. What is asserted here is the forwarding; the refusal itself is asserted
 *    against the real API in `packages/e2e`.
 * 3. **The write and media tools no longer see a `Sender` or a `MediaStore`.** "Each write tool
 *    calls its own sender method, with the chat and the message id in that order" becomes "calls its
 *    own *route*, with the chat and the message id in the right path parameters" — the same defect
 *    it was written to catch (two tools asserted identically, a transposed string pair that
 *    type-checks), against the seam that now exists.
 *
 * **Assertions that were dropped, and why.** Four groups, each naming behaviour that moved wholly
 * to the API and is covered by its own suite:
 *
 * - **The transcription cache.** `whatsapp_transcribe caches: a second call does not re-run
 *   whisper`, and the assertions that the result was written into `messages.transcript_model` /
 *   `transcript_language` and that a failed run cached nothing, all read a SQLite row and counted
 *   runs of a stub `Transcriber`. The cache lookup is inside `POST …/transcribe` now. What is left
 *   for this layer is that the tool spends exactly one round trip and never consults the row first,
 *   which is asserted.
 * - **The keyframe budget.** `imageBlocks(res).length === config.videoKeyframes` named a setting
 *   this process no longer holds; the count is `strip.frames.length`, decided by the side that owns
 *   the ceiling.
 * - **The converter's output.** `jpeg.length > 0` and the `bytes === statSync(pngPath).size` pair
 *   asserted what jimp and ffmpeg produced from a file built in `before`. The MCP re-encodes
 *   nothing, so what replaces them is byte equality against what the API answered — a strictly
 *   stronger statement about *this* layer, and a strictly weaker one about ffmpeg, which is
 *   `packages/api`'s `convert.test.ts`'s subject and not this file's.
 * - **`summary["path"]`**, in both document branches: exception 1 above.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ApiUnreachableError,
  CONTRACT_VERSION,
  Capabilities,
  ConversionError,
  MessageDetail,
  MessageNotFoundError,
  MessageRevokedError,
  NotConnectedError,
  NotFoundError,
  NotOwnMessageError,
  SendPathError,
  type MessageKind,
} from "whatsapp-api-sdk";

import { loadConfig } from "./config.js";
import type { ToolContext } from "./context.js";
import { silentLogger } from "./logger.js";
import { ContractVersionError, buildSession, requireContractMatch } from "./server.js";
import {
  harness,
  makeFakeApi,
  resultText,
  type FakeApi,
  type Harness,
  type HarnessOptions,
  type RawToolResult,
} from "./tools/harness.js";
import { VERSION } from "./version.js";

const CHAT = "33611111111@s.whatsapp.net";
const MSG = "M1";

const WRITE_TOOLS = [
  "whatsapp_send_text",
  "whatsapp_send_file",
  "whatsapp_react",
  "whatsapp_mark_read",
  "whatsapp_edit_message",
  "whatsapp_delete_message",
] as const;

const READ_ONLY_TOOLS = [
  "whatsapp_chats_list",
  "whatsapp_contacts_search",
  "whatsapp_download_media",
  "whatsapp_groups_list",
  "whatsapp_health",
  "whatsapp_messages_list",
  "whatsapp_messages_search",
  "whatsapp_transcribe",
];

const ALL_TOOLS = [
  "whatsapp_chats_list",
  "whatsapp_contacts_search",
  "whatsapp_delete_message",
  "whatsapp_download_media",
  "whatsapp_edit_message",
  "whatsapp_groups_list",
  "whatsapp_health",
  "whatsapp_mark_read",
  "whatsapp_messages_list",
  "whatsapp_messages_search",
  "whatsapp_react",
  "whatsapp_send_file",
  "whatsapp_send_text",
  "whatsapp_transcribe",
];

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

/** The JSON summary a media tool returns alongside its blocks, as the exact string it emitted. */
function summaryText(res: RawToolResult): string {
  const text = blocks(res).find((b) => b.type === "text" && b.text?.startsWith("{") === true)?.text;
  assert.ok(text !== undefined, `expected a JSON summary block, got: ${resultText(res)}`);
  return text;
}

function summaryOf(res: RawToolResult): Record<string, unknown> {
  return JSON.parse(summaryText(res)) as Record<string, unknown>;
}

/** A single-message detail, parsed by the schema it arrives under, with the reactions every summary embeds. */
function detail(kind: MessageKind, over: Partial<MessageDetail> = {}): MessageDetail {
  return MessageDetail.parse({
    id: MSG,
    chat: CHAT,
    ts: 1_700_000_000,
    fromMe: false,
    sender: { id: CHAT, name: CHAT },
    kind,
    text: null,
    transcript: null,
    quotedId: null,
    status: null,
    edited: false,
    deleted: false,
    media: { type: "application/octet-stream", cached: true },
    reactionCount: 1,
    reactions: [{ emoji: "👍", from: { id: CHAT, name: CHAT } }],
    ...over,
  });
}

/** A harness whose store holds one media message of `kind`. */
function mediaHarness(kind: MessageKind, opts: HarnessOptions = {}): Promise<Harness> {
  return harness({
    ...opts,
    seed: (api) => {
      api.putDetail(detail(kind));
      opts.seed?.(api);
    },
  });
}

/** Every client method rejects with `err`, for testing how a tool reports a failure. */
function failingApi(err: Error): Partial<FakeApi> {
  const fail = (): Promise<never> => Promise.reject(err);
  return {
    sendText: fail,
    sendFile: fail,
    react: fail,
    markRead: fail,
    editMessage: fail,
    deleteMessage: fail,
  };
}

// --- the tool surface -------------------------------------------------------------------------

void test("read-only mode hides every write tool and keeps the rest", async () => {
  const h = await harness({ readOnly: true });
  try {
    const names = await toolNames(h);
    for (const n of WRITE_TOOLS) assert.ok(!names.includes(n), `${n} must not be advertised in read-only mode`);
    assert.ok(names.includes("whatsapp_chats_list"));
    // The media tools are not write tools: neither one changes anything on WhatsApp, and a read-only
    // deployment that could not look at an attachment would be crippled for no gain.
    assert.ok(names.includes("whatsapp_download_media"));
    assert.ok(names.includes("whatsapp_transcribe"));
  } finally {
    await h.close();
  }
});

/**
 * The flag is the API's answer now, and this is what that buys.
 *
 * A read-only server does not advertise `whatsapp_send_text` and refuse it — it does not advertise
 * it at all, so a model never plans around a tool that cannot work. Asserting the exact list, rather
 * than only the absence of the six, is what makes a *seventh* tool quietly slipping into the
 * read-only build a failure.
 */
void test("a read-only API makes the MCP advertise exactly eight tools", async () => {
  const h = await harness({ readOnly: true });
  try {
    assert.deepEqual((await toolNames(h)).sort(), READ_ONLY_TOOLS);
    assert.equal((await h.client.listTools()).tools.length, 8);
  } finally {
    await h.close();
  }
});

void test("the read-only gate follows the API's answer, not this process's configuration", async () => {
  // `WHATSAPP_MCP_READONLY` is gone. The same config, the same context, two capability answers.
  const config = loadConfig({ WHATSAPP_API_URL: "http://api:8080", WHATSAPP_MCP_READONLY: "true" });
  const ctx: ToolContext = { config, logger: silentLogger(), client: makeFakeApi({ readOnly: true }) };

  /** What a client connected to `server` would see advertised. */
  const advertised = async (server: McpServer): Promise<number> => {
    const client = new Client({ name: "test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const count = (await client.listTools()).tools.length;
    await client.close();
    await server.close();
    return count;
  };

  assert.equal(await advertised(await buildSession(ctx)), 8);
  assert.equal(await advertised(await buildSession({ ...ctx, client: makeFakeApi({ readOnly: false }) })), 14);
});

void test("all fourteen tools are advertised in normal mode", async () => {
  const h = await harness({ readOnly: false });
  try {
    assert.deepEqual((await toolNames(h)).sort(), ALL_TOOLS);
  } finally {
    await h.close();
  }
});

void test("every tool name is whatsapp_-prefixed", async () => {
  const h = await harness({});
  try {
    for (const name of await toolNames(h)) assert.match(name, /^whatsapp_/);
  } finally {
    await h.close();
  }
});

void test("the advertised version is the one in package.json", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  const h = await harness({});
  try {
    assert.equal(h.client.getServerVersion()?.version, pkg.version);
    assert.equal(h.client.getServerVersion()?.version, VERSION);
    assert.equal(h.client.getServerVersion()?.name, "whatsapp-mcp");
  } finally {
    await h.close();
  }
});

// --- the session, which is new: it is a round trip now --------------------------------------------

void test("a session against an API on another contract revision is refused, once, by name", () => {
  const caps = Capabilities.parse({
    apiVersion: "1.0.0",
    contractVersion: CONTRACT_VERSION + 1,
    readOnly: false,
    maxUploadBytes: 1024,
    features: { transcription: true, autoTranscribe: false, mediaLinks: true },
  });
  assert.throws(
    () => {
      requireContractMatch(caps);
    },
    (err: unknown) => {
      assert.ok(err instanceof ContractVersionError);
      assert.match(err.message, /contract version mismatch/);
      assert.match(err.message, new RegExp(`v${String(CONTRACT_VERSION)}`));
      assert.match(err.message, new RegExp(`v${String(CONTRACT_VERSION + 1)}`));
      // Global Constraint 8: the base URL is a value this process never puts into an error.
      assert.doesNotMatch(err.message, /http/);
      return true;
    },
  );
  assert.doesNotThrow(() => {
    requireContractMatch({ ...caps, contractVersion: CONTRACT_VERSION });
  });
});

void test("a session against an unreachable API opens no session rather than advertising fourteen dead tools", async () => {
  const config = loadConfig({ WHATSAPP_API_URL: "http://api:8080" });
  const client = makeFakeApi({
    overrides: {
      capabilities: () => Promise.reject(new ApiUnreachableError("could not reach the API at http://api:8080")),
    },
  });
  await assert.rejects(buildSession({ config, logger: silentLogger(), client }), /could not reach the API/);
});

// --- write tools ------------------------------------------------------------------------------

void test("a write tool fails with the connection state named when the socket is down", async () => {
  const h = await harness({
    state: "disconnected",
    overrides: failingApi(new NotConnectedError('WhatsApp connection unavailable: current state is "disconnected"')),
  });
  try {
    const res = await h.client.callTool({ name: "whatsapp_send_text", arguments: { chat: CHAT, text: "hi" } });
    assert.equal(res.isError, true);
    assert.match(resultText(res), /disconnected/);
    // The class is `NotConnectedError`; the word the model reads is the one it always has.
    assert.match(resultText(res), /^ConnectionUnavailableError: /);
  } finally {
    await h.close();
  }
});

void test("whatsapp_send_text answers with the reference WhatsApp gave back", async () => {
  const h = await harness({});
  try {
    const res = await h.client.callTool({ name: "whatsapp_send_text", arguments: { chat: CHAT, text: "hi" } });
    assert.notEqual(res.isError, true, resultText(res));
    assert.deepEqual(JSON.parse(resultText(res)), { chat: "c", message_id: "S1" });
    // The exact bytes, not merely the same fields: `chat` before `message_id`, and no `status`.
    assert.equal(JSON.stringify(JSON.parse(resultText(res))), '{"chat":"c","message_id":"S1"}');
  } finally {
    await h.close();
  }
});

void test("whatsapp_send_file passes every argument through to the API under the right name", async () => {
  const h = await harness({});
  try {
    // Snake_case in, camelCase out: this is the only place that renaming happens, and a swap between
    // two adjacent string options would be invisible to every other test in this file.
    await h.client.callTool({
      name: "whatsapp_send_file",
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
    assert.deepEqual(h.api.inputOf("sendFile"), {
      body: {
        recipient: CHAT,
        data: "aGk=",
        path: undefined,
        filename: "note.ogg",
        mimetype: "audio/ogg",
        caption: "listen",
        replyTo: "M7",
        asVoiceNote: true,
        pick: undefined,
      },
    });

    await h.client.callTool({ name: "whatsapp_send_file", arguments: { chat: CHAT, path: "/data/uploads/a.png" } });
    const byPath = h.api.inputOf("sendFile", 1) as { body: { path?: string; data?: string } };
    assert.equal(byPath.body.path, "/data/uploads/a.png");
    assert.equal(byPath.body.data, undefined);

    await h.client.callTool({ name: "whatsapp_send_text", arguments: { chat: CHAT, text: "hi", reply_to: "M7" } });
    assert.deepEqual(h.api.inputOf("sendText"), {
      body: { recipient: CHAT, text: "hi", replyTo: "M7", mentions: undefined, pick: undefined },
    });

    // `mention` and `pick` reach the API under their own names too.
    await h.client.callTool({
      name: "whatsapp_send_text",
      arguments: { chat: "Marie", text: "@33611111111 coucou", pick: 2, mention: ["33611111111"] },
    });
    assert.deepEqual(h.api.inputOf("sendText", 1), {
      body: {
        recipient: "Marie",
        text: "@33611111111 coucou",
        replyTo: undefined,
        mentions: ["33611111111"],
        pick: 2,
      },
    });
  } finally {
    await h.close();
  }
});

void test("whatsapp_react accepts an empty emoji, which is how WhatsApp removes a reaction", async () => {
  const h = await harness({});
  try {
    const res = await h.client.callTool({
      name: "whatsapp_react",
      arguments: { chat: CHAT, message_id: MSG, emoji: "" },
    });
    assert.notEqual(res.isError, true, resultText(res));
    assert.deepEqual(h.api.inputOf("react"), { params: { chat: CHAT, id: MSG }, body: { emoji: "" } });
  } finally {
    await h.close();
  }
});

/**
 * The retired suite asserted that the *MCP* refused a send with neither or both of `data`/`path`.
 * It does not any more, and that is deliberate: the API refuses it with the same two sentences this
 * layer used to produce, and a local pre-check would be a second author of a refusal that already
 * has one. So what is asserted here is that the call is forwarded rather than swallowed — and
 * `packages/e2e` asserts the real API's refusal of exactly these two shapes.
 */
void test("whatsapp_send_file forwards a request carrying neither or both of data and path", async () => {
  const h = await harness({});
  try {
    await h.client.callTool({ name: "whatsapp_send_file", arguments: { chat: CHAT } });
    await h.client.callTool({
      name: "whatsapp_send_file",
      arguments: { chat: CHAT, path: "/data/uploads/a.png", data: "aGk=" },
    });
    assert.equal(h.api.countCalls("sendFile"), 2, "the refusal is the API's, so both must reach it");
    const neither = h.api.inputOf("sendFile") as { body: { data?: string; path?: string } };
    assert.equal(neither.body.data, undefined);
    assert.equal(neither.body.path, undefined);
  } finally {
    await h.close();
  }
});

void test("every tool advertises its arguments, flat and not as a union", async () => {
  const h = await harness({});
  try {
    const tools = (await h.client.listTools()).tools;
    // Regression guard with teeth. `whatsapp_send_file` was specified as a `.refine()`d Zod object,
    // which sdk 1.30 cannot describe: `normalizeObjectSchema` looks for `.shape`, a `ZodEffects` has
    // none, and the tool ends up advertised as `{"type":"object","properties":{}}` — every argument
    // invisible to every client — while still validating server-side, so nothing else notices.
    for (const tool of tools) {
      const schema = tool.inputSchema as { type?: string; properties?: Record<string, unknown> };
      assert.equal(schema.type, "object", `${tool.name}: input schema must be an object`);
      assert.ok(!("anyOf" in schema) && !("oneOf" in schema), `${tool.name}: the top level must not be a union`);
      if (tool.name === "whatsapp_health") continue; // the one tool that really takes no arguments
      assert.ok(Object.keys(schema.properties ?? {}).length > 0, `${tool.name}: arguments must be advertised`);
    }

    const sendFile = tools.find((t) => t.name === "whatsapp_send_file")?.inputSchema as
      { properties?: Record<string, unknown>; required?: string[] } | undefined;
    for (const key of ["chat", "path", "data", "filename", "mimetype", "caption", "reply_to", "as_voice_note"]) {
      assert.ok(sendFile?.properties?.[key] !== undefined, `${key} must be a top-level property of whatsapp_send_file`);
    }
    assert.deepEqual(sendFile?.required, ["chat"], "only the chat is unconditionally required");
  } finally {
    await h.close();
  }
});

void test("an API failure comes back as a tool error, never as a thrown protocol error", async () => {
  const cases = [
    {
      err: new NotFoundError("no message M9 in chat c"),
      tool: "whatsapp_react",
      args: { chat: CHAT, message_id: "M9", emoji: "👍" },
    },
    {
      err: new NotOwnMessageError("message M1 was not sent by this account"),
      tool: "whatsapp_edit_message",
      args: { chat: CHAT, message_id: MSG, text: "x" },
    },
    {
      err: new MessageRevokedError("message M1 in chat c was revoked"),
      tool: "whatsapp_send_text",
      args: { chat: CHAT, text: "re", reply_to: MSG },
    },
    {
      // The API never echoes the offending path, and neither may the tool that reports it.
      err: new SendPathError("sending a file by path is disabled; set WHATSAPP_SEND_FILE_DIR"),
      tool: "whatsapp_send_file",
      args: { chat: CHAT, path: "/etc/passwd" },
    },
  ];
  for (const c of cases) {
    const h = await harness({ overrides: failingApi(c.err) });
    try {
      const res = await h.client.callTool({ name: c.tool, arguments: c.args });
      assert.equal(res.isError, true, `${c.tool} must answer with isError`);
      assert.ok(resultText(res).includes(c.err.message), `${c.tool} must carry the reason: ${resultText(res)}`);
      assert.ok(
        resultText(res).startsWith(`${c.err.name}: `),
        `${c.tool} must keep the class name: ${resultText(res)}`,
      );
      assert.doesNotMatch(resultText(res), /\n\s+at /, "never a stack trace");
    } finally {
      await h.close();
    }
  }
});

void test("whatsapp_mark_read and whatsapp_delete_message report success without inventing a message id", async () => {
  const h = await harness({});
  try {
    for (const tool of ["whatsapp_mark_read", "whatsapp_delete_message"]) {
      const res = await h.client.callTool({ name: tool, arguments: { chat: CHAT, message_id: MSG } });
      assert.notEqual(res.isError, true, resultText(res));
      // `chat` is the id the API resolved the call against — the fake answers "c" for every write —
      // and not the string that went in. One field name cannot mean the canonical chat in
      // `whatsapp_send_text` and "whatever you typed" here: a caller naming a chat by its LID would
      // get its own LID back and read an empty conversation when it fed that to
      // whatsapp_messages_list.
      assert.deepEqual(JSON.parse(resultText(res)), { status: "ok", chat: "c", message_id: MSG });
      assert.equal(JSON.stringify(JSON.parse(resultText(res))), `{"status":"ok","chat":"c","message_id":"${MSG}"}`);
    }
  } finally {
    await h.close();
  }
});

/**
 * Route and path parameters, per tool, against a fake that records every call.
 *
 * `markRead`, `deleteMessage`, `editMessage` and `react` all identify a message by two strings, so a
 * transposed pair type-checks, and two of the six tools are otherwise asserted identically — which
 * means calling `markRead` inside `whatsapp_delete_message` passes every other test in this file.
 * Distinct values for the chat and the id are what make a swap visible; recording the route name is
 * what makes the wrong-route-entirely case visible.
 *
 * `whatsapp_mark_read` is the odd one out on purpose: the id rides in the body, because the *chat*
 * is what gets marked, up to and including that message.
 */
void test("each write tool calls its own route, with the chat and the message id in the right places", async () => {
  const h = await harness({});
  try {
    const args = { chat: CHAT, message_id: MSG, emoji: "\u{1F44D}", text: "corrigé" };
    for (const tool of ["whatsapp_react", "whatsapp_mark_read", "whatsapp_edit_message", "whatsapp_delete_message"]) {
      const res = await h.client.callTool({ name: tool, arguments: args });
      assert.notEqual(res.isError, true, `${tool}: ${resultText(res)}`);
    }
    assert.deepEqual(
      h.api.calls.map((c) => `${c.route}(${JSON.stringify(c.input)})`),
      [
        `react({"params":{"chat":"${CHAT}","id":"${MSG}"},"body":{"emoji":"👍"}})`,
        `markRead({"params":{"chat":"${CHAT}"},"body":{"messageId":"${MSG}"}})`,
        `editMessage({"params":{"chat":"${CHAT}","id":"${MSG}"},"body":{"text":"corrigé"}})`,
        `deleteMessage({"params":{"chat":"${CHAT}","id":"${MSG}"}})`,
      ],
    );
  } finally {
    await h.close();
  }
});

// --- whatsapp_download_media ------------------------------------------------------------------------

void test("whatsapp_download_media returns image blocks for an image message", async () => {
  const h = await mediaHarness("image");
  try {
    const res = await h.client.callTool({
      name: "whatsapp_download_media",
      arguments: { chat: CHAT, message_id: MSG },
    });
    assert.notEqual(res.isError, true, resultText(res));

    const images = imageBlocks(res);
    assert.equal(images.length, 1, "an image message is one block, never a keyframe strip");
    const image = images[0];
    assert.ok(image !== undefined);
    assert.equal(image.mimeType, "image/jpeg");
    // The bytes are the API's, passed through untouched — this side re-encodes nothing.
    assert.equal(image.data, h.api.data.jpeg.data);
    assert.equal(
      Buffer.from(image.data ?? "", "base64")
        .subarray(0, 2)
        .toString("hex"),
      "ffd8",
    );

    const summary = summaryOf(res);
    assert.equal(summary["width"], 160);
    assert.equal(summary["height"], 120);
    assert.equal(summary["bytes"], 4242, "the *original* attachment's size, not the derivative's");
    assert.equal(summary["mimetype"], "image/png", "and the original's type");
    // Single-message context: this is the one place the full reaction shape belongs.
    assert.deepEqual(summary["reactions"], [{ emoji: "👍", from: { id: CHAT, name: CHAT } }]);

    // Every key, in the order `summaryOf` has always written them. A deep-equal cannot see this.
    assert.equal(
      JSON.stringify(JSON.parse(summaryText(res))),
      `{"chat":"${CHAT}","message_id":"M1","kind":"image","mimetype":"image/png","bytes":4242,` +
        `"width":160,"height":120,"reactions":[{"emoji":"👍","from":{"id":"${CHAT}","name":"${CHAT}"}}]}`,
    );

    // Two calls and no raw bytes: `/jpeg` carries the derivative *and* the original's size and type.
    assert.equal(h.api.countCalls("fetchMedia"), 0, "pulling the original down to inspect it is the thing not to do");
    assert.equal(h.api.countCalls("fetchMediaJpeg"), 1);
    assert.equal(h.api.countCalls("getMessage"), 1);
  } finally {
    await h.close();
  }
});

void test("whatsapp_download_media decodes a sticker, which is always WebP", async () => {
  const h = await mediaHarness("sticker", {
    seed: (api) => {
      api.data.jpeg = { ...api.data.jpeg, width: 128, height: 128, source: { bytes: 900, mimetype: "image/webp" } };
    },
  });
  try {
    const res = await h.client.callTool({
      name: "whatsapp_download_media",
      arguments: { chat: CHAT, message_id: MSG },
    });
    assert.notEqual(res.isError, true, resultText(res));
    assert.equal(imageBlocks(res).length, 1);
    assert.equal(summaryOf(res)["width"], 128);
    assert.equal(summaryOf(res)["kind"], "sticker");
  } finally {
    await h.close();
  }
});

void test("whatsapp_download_media samples a video and reports its rounded duration", async () => {
  const h = await mediaHarness("video");
  try {
    const res = await h.client.callTool({
      name: "whatsapp_download_media",
      arguments: { chat: CHAT, message_id: MSG },
    });
    assert.notEqual(res.isError, true, resultText(res));

    // Exactly what `/keyframes` returned: the image-block budget is the API's now, and inventing a
    // second ceiling here would be a number that can disagree with the one that bounds the strip.
    assert.equal(imageBlocks(res).length, h.api.data.keyframes.frames.length);

    const summary = summaryOf(res);
    assert.equal(summary["width"], 320);
    assert.equal(summary["height"], 240);
    // Rounded, as it always has been: 2.4 seconds is 2, not 2.4.
    assert.equal(summary["duration_sec"], 2);
    assert.equal(summary["keyframes"], 4);
  } finally {
    await h.close();
  }
});

void test("whatsapp_download_media returns the cached transcript for an audio message", async () => {
  const h = await mediaHarness("audio", {
    seed: (api) => {
      api.putDetail(detail("audio", { transcript: "bonjour, c'est un message vocal" }));
    },
  });
  try {
    const res = await h.client.callTool({
      name: "whatsapp_download_media",
      arguments: { chat: CHAT, message_id: MSG },
    });
    assert.notEqual(res.isError, true, resultText(res));
    assert.equal(imageBlocks(res).length, 0, "audio carries no picture");
    assert.match(resultText(res), /bonjour, c'est un message vocal/);
    assert.equal(summaryOf(res)["transcribed"], true);
    // The cached transcript is the point: downloading a voice note must not spend a whisper run.
    assert.equal(h.api.countCalls("transcribe"), 0);
    // Nor a second read of it: it came off the row that was already fetched.
    assert.equal(h.api.countCalls("fetchMediaTranscript"), 0);
  } finally {
    await h.close();
  }
});

void test("whatsapp_download_media tells the model to transcribe an untranscribed voice note", async () => {
  const h = await mediaHarness("audio");
  try {
    const res = await h.client.callTool({
      name: "whatsapp_download_media",
      arguments: { chat: CHAT, message_id: MSG },
    });
    assert.notEqual(res.isError, true, resultText(res));
    assert.match(resultText(res), /whatsapp_transcribe/);
    assert.equal(summaryOf(res)["duration_sec"], 2, "the duration is what tells the model whether it is worth it");
    assert.equal(summaryOf(res)["transcribed"], false);
    assert.equal(h.api.countCalls("transcribe"), 0);
  } finally {
    await h.close();
  }
});

/**
 * Spec §7.1's first sanctioned exception, and the only change to what a model reads that is not a
 * bug.
 *
 * The retired tool reported `path`: a location on the API's disk, which this process cannot open and
 * a caller of this process cannot reach. `url` is the same attachment, resolved against
 * `WHATSAPP_API_URL` — because `/link` answers a **relative** reference on purpose, so that the API
 * never has to guess its own public origin from a `Host` header a caller controls.
 */
void test("whatsapp_download_media hands back an absolute url for a document it cannot render", async () => {
  const h = await mediaHarness("document", { env: { WHATSAPP_API_URL: "https://wa.example.com/base/" } });
  try {
    const res = await h.client.callTool({
      name: "whatsapp_download_media",
      arguments: { chat: CHAT, message_id: MSG },
    });
    assert.notEqual(res.isError, true, resultText(res));
    const summary = summaryOf(res);
    assert.equal(
      summary["url"],
      "https://wa.example.com/media/dl/tok3n",
      "root-relative, so the base path is replaced",
    );
    assert.equal(summary["path"], undefined, "the API's filesystem is not a fact anyone in the conversation has");
    assert.equal(summary["mimetype"], "application/octet-stream");
    assert.equal(summary["bytes"], 1024);
    // `expiresAt` and `filename` are dropped: the summary has never carried them, and passing the
    // whole response through would add two fields to what a model reads.
    assert.equal(summary["expiresAt"], undefined);
    assert.equal(summary["filename"], undefined);
    assert.equal(
      JSON.stringify(JSON.parse(summaryText(res))),
      `{"chat":"${CHAT}","message_id":"M1","kind":"document","mimetype":"application/octet-stream","bytes":1024,` +
        `"url":"https://wa.example.com/media/dl/tok3n",` +
        `"reactions":[{"emoji":"👍","from":{"id":"${CHAT}","name":"${CHAT}"}}]}`,
    );
    // Not a PDF, so no extraction was attempted and no text block was emitted.
    assert.equal(h.api.countCalls("fetchMediaText"), 0);
    assert.equal(blocks(res).length, 1);
  } finally {
    await h.close();
  }
});

void test("whatsapp_download_media extracts the text of a PDF", async () => {
  const h = await mediaHarness("document", {
    seed: (api) => {
      api.data.link = { ...api.data.link, mimeType: "application/pdf", filename: "notes.pdf" };
    },
  });
  try {
    const res = await h.client.callTool({
      name: "whatsapp_download_media",
      arguments: { chat: CHAT, message_id: MSG },
    });
    assert.notEqual(res.isError, true, resultText(res));
    assert.match(resultText(res), /le contenu du document/);
    assert.equal(h.api.countCalls("fetchMediaText"), 1);
  } finally {
    await h.close();
  }
});

void test("a scanned PDF says so rather than answering with an empty block", async () => {
  const h = await mediaHarness("document", {
    seed: (api) => {
      api.data.link = { ...api.data.link, mimeType: "application/pdf" };
      api.data.pdf = { text: "", truncated: false };
    },
  });
  try {
    const res = await h.client.callTool({
      name: "whatsapp_download_media",
      arguments: { chat: CHAT, message_id: MSG },
    });
    assert.match(resultText(res), /carries no extractable text, which usually means it is a scan/);
  } finally {
    await h.close();
  }
});

void test("a PDF whose text cannot be extracted degrades to the summary rather than failing", async () => {
  const h = await mediaHarness("document", {
    seed: (api) => {
      api.data.link = { ...api.data.link, mimeType: "application/pdf" };
    },
    overrides: {
      fetchMediaText: () => Promise.reject(new ConversionError("pdftotext is not installed in this image")),
    },
  });
  try {
    const res = await h.client.callTool({
      name: "whatsapp_download_media",
      arguments: { chat: CHAT, message_id: MSG },
    });
    assert.notEqual(res.isError, true, "one failed extraction must not throw away the whole answer");
    assert.match(resultText(res), /pdftotext/, "and it says why the text is missing");
    const summary = summaryOf(res);
    // The reworded half of the sanctioned change: the note used to point at "the path in the summary
    // above", and that field no longer exists.
    assert.match(resultText(res), /can be downloaded from the url in the summary above/);
    assert.equal(summary["url"], "http://api:8080/media/dl/tok3n", "the url, size and mimetype survive the failure");
    assert.equal(summary["mimetype"], "application/pdf");
    assert.equal(summary["bytes"], 1024);
  } finally {
    await h.close();
  }
});

void test("whatsapp_download_media refuses a message the store has never seen", async () => {
  const h = await harness({});
  try {
    const res = await h.client.callTool({
      name: "whatsapp_download_media",
      arguments: { chat: CHAT, message_id: "M404" },
    });
    assert.equal(res.isError, true);
    assert.match(resultText(res), /M404/);
    assert.match(resultText(res), /^MessageNotFoundError: /);
    // The message is looked up before any media route is reached, so nothing was fetched.
    assert.equal(h.api.countCalls("fetchMediaJpeg"), 0);
  } finally {
    await h.close();
  }
});

void test("whatsapp_download_media refuses a message that carries no media at all", async () => {
  // Unreachable in practice — every media route refuses a non-media kind first — but `MessageKind`
  // is a closed union and a new member has to land somewhere.
  const h = await mediaHarness("text");
  try {
    const res = await h.client.callTool({
      name: "whatsapp_download_media",
      arguments: { chat: CHAT, message_id: MSG },
    });
    assert.equal(res.isError, true);
    assert.match(resultText(res), /^MediaUnavailableError: message M1 is a text message and carries no media$/);
  } finally {
    await h.close();
  }
});

void test("whatsapp_download_media distinguishes a downed connection from media that is gone", async () => {
  const gone = new MessageNotFoundError("no message M1 in chat c");
  const cases = [
    {
      err: new ConversionError("WhatsApp media URLs expire, so a message this old is no longer downloadable"),
      name: "ConversionError",
    },
    {
      err: new NotConnectedError('WhatsApp connection unavailable: current state is "connecting"'),
      name: "ConnectionUnavailableError",
    },
    { err: gone, name: "MessageNotFoundError" },
  ];
  for (const c of cases) {
    const h = await mediaHarness("image", {
      overrides: { fetchMediaJpeg: () => Promise.reject(c.err) },
    });
    try {
      const res = await h.client.callTool({
        name: "whatsapp_download_media",
        arguments: { chat: CHAT, message_id: MSG },
      });
      assert.equal(res.isError, true);
      assert.ok(
        resultText(res).startsWith(`${c.name}: `),
        `the failures must stay distinguishable: ${resultText(res)}`,
      );
    } finally {
      await h.close();
    }
  }
});

// --- whatsapp_transcribe ----------------------------------------------------------------------------

void test("whatsapp_transcribe answers with the text and spends exactly one round trip", async () => {
  const h = await mediaHarness("audio");
  try {
    const res = await h.client.callTool({ name: "whatsapp_transcribe", arguments: { chat: CHAT, message_id: MSG } });
    assert.notEqual(res.isError, true, resultText(res));
    assert.equal(resultText(res), "transcrit");
    assert.equal(h.api.countCalls("transcribe"), 1);
    assert.deepEqual(h.api.inputOf("transcribe"), { params: { chat: CHAT, id: MSG } });
    // The cache lookup is inside `POST …/transcribe`, so a `getMessage` here to check it first would
    // be a round trip that changed nothing but the bill for it.
    assert.equal(h.api.countCalls("getMessage"), 0);
    assert.equal(h.api.countCalls("fetchMediaTranscript"), 0);
  } finally {
    await h.close();
  }
});

void test("whatsapp_transcribe reports why transcription failed, verbatim", async () => {
  const reason = "no speech was detected in this recording";
  const h = await mediaHarness("audio", {
    overrides: {
      transcribe: () => Promise.reject(new ConversionError(reason)),
    },
  });
  try {
    const res = await h.client.callTool({ name: "whatsapp_transcribe", arguments: { chat: CHAT, message_id: MSG } });
    assert.equal(res.isError, true);
    assert.ok(resultText(res).includes(reason), resultText(res));
  } finally {
    await h.close();
  }
});

void test("whatsapp_transcribe refuses a message the API has never seen", async () => {
  const h = await harness({
    overrides: { transcribe: () => Promise.reject(new MessageNotFoundError("no message M404 in chat c")) },
  });
  try {
    const res = await h.client.callTool({ name: "whatsapp_transcribe", arguments: { chat: CHAT, message_id: "M404" } });
    assert.equal(res.isError, true);
    assert.match(resultText(res), /M404/);
  } finally {
    await h.close();
  }
});

void test("a transcript longer than the cap is truncated like every other payload", async () => {
  const h = await mediaHarness("audio", {
    maxResultChars: 200,
    seed: (api) => {
      api.data.transcribed = { text: "x".repeat(5000), model: "test-model", language: "fr" };
    },
  });
  try {
    const res = await h.client.callTool({ name: "whatsapp_transcribe", arguments: { chat: CHAT, message_id: MSG } });
    const text = resultText(res);
    assert.ok(text.length < 600, `a capped payload must be short, got ${text.length}`);
    assert.match(text, /5000 chars total, showing first 200/);
  } finally {
    await h.close();
  }
});
