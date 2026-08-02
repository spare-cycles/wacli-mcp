#!/usr/bin/env node
/**
 * Manual end-to-end smoke test against a *running* whatsapp-mcp server.
 *
 * This is not part of `pnpm test` and never will be: it needs a paired WhatsApp store — a real
 * account, real chats, real media — which no CI runner has and no fixture can fake. It is `.mjs`
 * and lives outside `src/`, so neither the type gate nor ESLint looks at it.
 *
 * What it is *for* is the two things the unit suite structurally cannot cover:
 *
 *   1. The whole wiring, over HTTP, exactly as a model reaches it — Express, the bearer gate, the
 *      Streamable-HTTP session, the SDK's schema validation, the tool handlers, SQLite.
 *   2. **whisper.** `--transcribe` is the only exercise transcription and the ~574 MB model
 *      download ever get. Nothing in `src/**` runs whisper-cli: `media/transcribe.test.ts` drives a
 *      fake binary, because a real one is minutes of CPU per call. So a whisper regression — a
 *      missing shared library, a wrong `LD_LIBRARY_PATH`, a model URL that moved, a flag whisper.cpp
 *      renamed — is invisible until this script is run. Run it after every image change.
 *
 * Usage:
 *
 *   node smoke.mjs                                    # health + tool list + whatsapp_chats_list
 *   node smoke.mjs --transcribe <chatJid> <messageId> # ... and transcribe one voice note
 *
 * Exit codes:
 *
 *   0  every step passed against a live, paired store
 *   1  a step failed
 *   2  every step passed, but the store is **not paired** — which makes the run prove almost nothing.
 *      An unpaired server answers `whatsapp_chats_list` with a perfectly valid empty page, so the reads
 *      here cannot tell "the wiring works" from "there is nothing behind it", and every write and
 *      every media fetch would fail. A green line for that is a green line for the case this script
 *      exists to catch, so it gets a colour and a code of its own.
 *
 * Environment:
 *
 *   WHATSAPP_MCP_URL     base URL of the running server        (default http://127.0.0.1:8080)
 *   MCP_HTTP_PATH  the MCP path, if the server moved it  (default /mcp)
 *   WHATSAPP_MCP_TOKEN   the bearer token, if the server has one configured
 *
 * Find a voice note to pass to `--transcribe` from the tool output itself:
 *   node smoke.mjs                       -> pick a chat JID
 *   then call whatsapp_messages_list on it and look for kind "audio".
 */

import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = (process.env.WHATSAPP_MCP_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MCP_PATH = process.env.MCP_HTTP_PATH || "/mcp";
const TOKEN = process.env.WHATSAPP_MCP_TOKEN || "";

/** Every tool this server is supposed to advertise, and how many of them a read-only one drops. */
const EXPECTED_TOOLS = 14;
const EXPECTED_TOOLS_READONLY = 8;

function log(step, detail) {
  console.log(`\x1b[36m·\x1b[0m ${step}${detail === undefined ? "" : ` ${detail}`}`);
}

/** The text of a tool result, whatever mix of blocks it came back as. */
function resultText(res) {
  return (res.content ?? [])
    .map((b) => (b.type === "text" ? b.text : `[${b.type}${b.mimeType ? ` ${b.mimeType}` : ""}]`))
    .join("\n");
}

/** Call a tool and fail loudly on `isError`, which the SDK reports in-band rather than as a throw. */
async function callTool(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  assert.notEqual(res.isError, true, `${name} failed: ${resultText(res)}`);
  return res;
}

async function main() {
  const argv = process.argv.slice(2);
  const transcribeAt = argv.indexOf("--transcribe");
  let transcribe;
  if (transcribeAt !== -1) {
    const [chat, messageId] = argv.slice(transcribeAt + 1, transcribeAt + 3);
    assert.ok(chat && messageId, "usage: node smoke.mjs --transcribe <chatJid> <messageId>");
    transcribe = { chat, messageId };
  }

  // 1. /health — public by design, so this also proves the server is up before we spend a session.
  const healthRes = await fetch(`${BASE}/health`);
  assert.equal(healthRes.status, 200, `GET /health answered ${healthRes.status}`);
  const health = await healthRes.json();
  log("health", JSON.stringify(health));
  assert.equal(health.ok, true, "health.ok is false — the account is logged out and needs re-pairing");
  const unpaired = health.needs_pairing === true;
  if (unpaired) console.warn("  ! the server is waiting to be paired; writes and media will fail");
  if (!health.transcription_available && transcribe) {
    console.warn("  ! transcription_available is false — whisper-cli or the model is missing");
  }

  // 2. Open a real MCP session over Streamable HTTP.
  const client = new Client({ name: "whatsapp-mcp-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}${MCP_PATH}`), {
    requestInit: TOKEN === "" ? {} : { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  const server = client.getServerVersion();
  log("session", `connected to ${server?.name}@${server?.version}`);

  try {
    // 3. The tool surface.
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name).sort();
    log("tools", `${names.length}: ${names.join(", ")}`);
    const expected = health.read_only ? EXPECTED_TOOLS_READONLY : EXPECTED_TOOLS;
    assert.equal(
      names.length,
      expected,
      `expected ${expected} tools${health.read_only ? " (WHATSAPP_MCP_READONLY is set)" : ""}, got ${names.length}`,
    );
    for (const name of names) assert.match(name, /^whatsapp_/, `${name} is not whatsapp_-prefixed`);

    // 4. A real read, against the real store.
    const chats = await callTool(client, "whatsapp_chats_list", { limit: 5 });
    log("whatsapp_chats_list", "\n" + resultText(chats));

    // 5. whisper, if asked. Minutes of CPU on a cold model — that is the point of it being opt-in.
    if (transcribe) {
      log("whatsapp_transcribe", `${transcribe.chat} / ${transcribe.messageId} — this can take minutes`);
      const started = Date.now();
      const res = await callTool(client, "whatsapp_transcribe", {
        chat: transcribe.chat,
        message_id: transcribe.messageId,
      });
      const text = resultText(res);
      log("whatsapp_transcribe", `${Math.round((Date.now() - started) / 1000)}s, ${text.length} chars`);
      console.log(text);
      assert.ok(text.trim().length > 0, "whisper returned an empty transcript");
    }
  } finally {
    await client.close();
  }

  if (unpaired) {
    console.log(
      "\n\x1b[33mincomplete\x1b[0m — every step ran, but against an unpaired store: an empty " +
        "whatsapp_chats_list proves nothing, and neither writes nor media were reachable. Pair the server and run again.",
    );
    process.exit(2);
  }
  console.log("\n\x1b[32mok\x1b[0m — every step passed");
}

await main().catch((err) => {
  console.error(`\n\x1b[31mfailed\x1b[0m — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
