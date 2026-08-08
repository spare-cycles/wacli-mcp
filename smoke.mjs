#!/usr/bin/env node
/**
 * Manual end-to-end smoke test against a *running* whatsapp deployment.
 *
 * This is not part of `pnpm test` and never will be: it needs a paired WhatsApp store — a real
 * account, real chats, real media — which no CI runner has and no fixture can fake. It is `.mjs`
 * and lives outside any package's `src/`, so neither the type gate nor ESLint looks at it.
 *
 * ── Which process this drives, and why ──────────────────────────────────────────────────────────
 *
 * **The MCP, by default, and that is the deliberate choice.** The system is now two processes with
 * a network between them, so "which half do I test" is a real question and the answer is: the half
 * a model actually talks to. Transcription is the API's work, but the MCP cannot answer a
 * `whatsapp_transcribe` call without the SDK client, the API's bearer gate, its handlers, SQLite,
 * the media pipeline and the GPU endpoint all working — so a green MCP run is a green API run plus
 * the contract between them. Driving the API directly would prove strictly less, and would prove
 * *nothing at all* about the one failure mode the split introduced: two containers built from
 * different commits, each internally consistent, disagreeing on the wire.
 *
 * `--api` exists for the other direction. When the MCP run fails, it answers "is the API broken, or
 * is the MCP not reaching it?" in one request — the bisect, not the test.
 *
 * ── What it is for ──────────────────────────────────────────────────────────────────────────────
 *
 *   1. The whole wiring, over two hops, exactly as a model reaches it — Express, the MCP's bearer
 *      gate, the Streamable-HTTP session, the per-session `GET /v1/capabilities`, the SDK's schema
 *      validation on both sides, the API's own bearer gate, the handlers, SQLite.
 *   2. **The transcription endpoint.** `--transcribe` is the only exercise a real GPU job ever gets.
 *      Nothing under any `src/**` reaches RunPod: `media/transcribe.test.ts` drives a `fetch` mock,
 *      because a real call costs GPU seconds and can take minutes on a cold worker. So an endpoint
 *      regression — a rotated key, an endpoint id that changed, a worker image that will not boot, a
 *      response field the worker renamed — is invisible until this script is run. It is also the
 *      only thing that exercises the three-timeout stack the split created
 *      (`WHATSAPP_MCP_TRANSCRIBE_TIMEOUT_MS`, the API's own limit, and any reverse proxy in
 *      between). Run it after every change to either image, and after every `runpod-sync.py --apply`.
 *
 *      ⚠️ It costs money, and the first call of a quiet day pays the full cold start.
 *
 * Usage:
 *
 *   node smoke.mjs                                    # health + tool list + whatsapp_chats_list
 *   node smoke.mjs --api                              # the API alone: /health, the gate, GET /v1/chats
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
 *   WHATSAPP_MCP_URL     base URL of the running MCP           (default http://127.0.0.1:8081)
 *   MCP_HTTP_PATH        the MCP path, if it was moved         (default /mcp)
 *   WHATSAPP_MCP_TOKEN   the bearer the MCP expects, if it has one configured
 *   WHATSAPP_API_URL     base URL of the API, for --api        (default http://127.0.0.1:8080)
 *   WHATSAPP_API_TOKEN   the bearer the API expects — required by --api, which is all 401s without it
 *
 * The MCP default is 8081 because that is the port `docker-compose.yml` publishes; the API's 8080 is
 * only reachable there if you uncommented its `ports:` line. A `pnpm --filter whatsapp-mcp dev` run
 * listens on 8080 instead — set WHATSAPP_MCP_URL for that.
 *
 * Find a voice note to pass to `--transcribe` from the tool output itself:
 *   node smoke.mjs                       -> pick a chat JID
 *   then call whatsapp_messages_list on it and look for kind "audio".
 */

import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = (process.env.WHATSAPP_MCP_URL || "http://127.0.0.1:8081").replace(/\/+$/, "");
const MCP_PATH = process.env.MCP_HTTP_PATH || "/mcp";
const TOKEN = process.env.WHATSAPP_MCP_TOKEN || "";
const API_BASE = (process.env.WHATSAPP_API_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const API_TOKEN = process.env.WHATSAPP_API_TOKEN || "";

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

/**
 * `--api`: the API on its own, so a failing MCP run can be bisected in one command.
 *
 * Three requests. `/health` is public and proves the process is up. An unauthenticated `/v1/chats`
 * must answer 401 — the gate is registered unconditionally and fails closed, so a 200 here means
 * either the deployment is wide open or you are talking to something that is not this API. Then the
 * real read, with the bearer.
 */
async function checkApi() {
  const healthRes = await fetch(`${API_BASE}/health`);
  assert.equal(healthRes.status, 200, `GET ${API_BASE}/health answered ${healthRes.status}`);
  const health = await healthRes.json();
  log("api /health", JSON.stringify(health));
  assert.equal(health.ok, true, "api health.ok is false — the account is logged out and needs re-pairing");

  const anon = await fetch(`${API_BASE}/v1/chats?limit=1`);
  assert.equal(anon.status, 401, `GET /v1/chats without a bearer answered ${anon.status}, not 401 — the gate is off`);
  log("api gate", "401 without a bearer, as it should be");

  assert.ok(API_TOKEN !== "", "WHATSAPP_API_TOKEN is unset, so every /v1 request would be a 401");
  const chatsRes = await fetch(`${API_BASE}/v1/chats?limit=5`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  assert.equal(chatsRes.status, 200, `GET /v1/chats answered ${chatsRes.status}: ${await chatsRes.text()}`);
  const page = await chatsRes.json();
  assert.ok(Array.isArray(page.items), "GET /v1/chats did not answer a { nextCursor, items } page");
  log("api GET /v1/chats", `${page.items.length} chats, next_cursor ${page.nextCursor ?? "null"}`);

  return health.needs_pairing === true;
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

  if (argv.includes("--api")) {
    const unpairedApi = await checkApi();
    if (unpairedApi) {
      console.log("\n\x1b[33mincomplete\x1b[0m — the API answered every request, but its store is not paired.");
      process.exit(2);
    }
    console.log("\n\x1b[32mok\x1b[0m — the API answered every request");
    return;
  }

  // 1. The MCP's /health — public by design, so this also proves it is up before we spend a session.
  //    It is the API's own report with an `api` block appended, so one fetch tells us about both.
  const healthRes = await fetch(`${BASE}/health`);
  assert.equal(healthRes.status, 200, `GET /health answered ${healthRes.status}`);
  const health = await healthRes.json();
  log("health", JSON.stringify(health));
  assert.ok(health.api, "no `api` block in /health — this is not a split-topology MCP");
  assert.equal(
    health.api.reachable,
    true,
    `the MCP cannot reach the API at ${health.api.url}: ${health.api.error}` +
      " — check WHATSAPP_API_URL and WHATSAPP_API_TOKEN on the mcp container",
  );
  log("api", `${health.api.url}, ${health.api.latencyMs}ms`);
  assert.equal(health.ok, true, "health.ok is false — the account is logged out and needs re-pairing");
  const unpaired = health.needs_pairing === true;
  if (unpaired) console.warn("  ! the server is waiting to be paired; writes and media will fail");
  if (!health.transcription_available && transcribe) {
    console.warn(
      "  ! transcription_available is false — no backend is reachable. Check WHATSAPP_RUNPOD_ENDPOINT_ID," +
        " RUNPOD_API_KEY and MISTRAL_API_KEY on the api container, and that jobs are going to api.runpod.ai (not .io).",
    );
  }

  // 2. Open a real MCP session over Streamable HTTP. This is also where the MCP fetches
  //    GET /v1/capabilities and refuses a contract-version mismatch, so a mismatched pair of
  //    containers fails here rather than on some later tool call.
  const client = new Client({ name: "whatsapp-mcp-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}${MCP_PATH}`), {
    requestInit: TOKEN === "" ? {} : { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  const server = client.getServerVersion();
  log("session", `connected to ${server?.name}@${server?.version}`);

  try {
    // 3. The tool surface. Unchanged across the split, on purpose — these three assertions are the
    //    migration's own proof, so do not soften them.
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name).sort();
    log("tools", `${names.length}: ${names.join(", ")}`);
    const expected = health.read_only ? EXPECTED_TOOLS_READONLY : EXPECTED_TOOLS;
    assert.equal(
      names.length,
      expected,
      `expected ${expected} tools${health.read_only ? " (WHATSAPP_MCP_READONLY is set on the api)" : ""}, got ${names.length}`,
    );
    for (const name of names) assert.match(name, /^whatsapp_/, `${name} is not whatsapp_-prefixed`);

    // 4. A real read, against the real store, two hops away.
    const chats = await callTool(client, "whatsapp_chats_list", { limit: 5 });
    log("whatsapp_chats_list", "\n" + resultText(chats));

    // 5. A real transcription, if asked. A cold endpoint takes minutes and costs money — that is
    //    the point of it being opt-in. Going through the MCP rather than straight at the API is
    //    deliberate: the timeout that has to hold is the MCP's, and it is longer than the API's on
    //    purpose so the SDK is never the component that quits first.
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
      assert.ok(text.trim().length > 0, "the transcription endpoint returned an empty transcript");
    }
  } finally {
    await client.close();
  }

  if (unpaired) {
    console.log(
      "\n\x1b[33mincomplete\x1b[0m — every step ran, but against an unpaired store: an empty " +
        "whatsapp_chats_list proves nothing, and neither writes nor media were reachable. Pair the api and run again.",
    );
    process.exit(2);
  }
  console.log("\n\x1b[32mok\x1b[0m — every step passed");
}

await main().catch((err) => {
  console.error(`\n\x1b[31mfailed\x1b[0m — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
