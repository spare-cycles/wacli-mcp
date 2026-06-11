#!/usr/bin/env node
/**
 * wacli-mcp — a thin MCP server wrapping the `wacli` WhatsApp CLI.
 *
 * Design: every tool shells out to the wacli binary with `--json` and returns
 * the parsed `{ success, data, error }` envelope. Curated tools give the model
 * typed schemas for the common operations; `wacli_run` is a generic escape
 * hatch for the long tail (polls, presence, channels, profile, ...).
 *
 * Config via env:
 *   WACLI_BIN                   path to the wacli binary (default: "wacli" on PATH)
 *   WACLI_STORE_DIR             store directory passed to wacli (default: wacli's own ~/.wacli)
 *   WACLI_ACCOUNT               named account from config.yaml (--account)
 *   WACLI_MCP_READONLY          "1" => pass --read-only to wacli (it rejects writes) and hide the
 *                               send tools. Also honored: wacli's own WACLI_READONLY (1/true/yes/on).
 *   WACLI_MCP_TIMEOUT_MS        hard subprocess timeout in ms (default 120000, min 1000, max 3600000)
 *   WACLI_MCP_MAX_OUTPUT_CHARS  cap on buffered child output (default 5,000,000, max 50,000,000)
 *   WACLI_MCP_MAX_RESULT_CHARS  cap on the text returned to the model (default 200,000)
 *   WACLI_MCP_LOCK_WAIT         Go duration (e.g. "10s") to wait for the store write-lock before
 *                               failing; lets writes queue behind a transient lock. Default: fail fast.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { z } from "zod";

/** Parse a positive-integer env var; fall back on invalid/≤0, then clamp into [min, max]. */
function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** wacli (and this server) treat 1/true/yes/on as truthy for read-only. */
function envTruthy(raw: string | undefined): boolean {
  return raw !== undefined && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

// A Go duration like "10s", "500ms", "1m30s". Validated so a typo can't break every call.
const GO_DURATION = /^\d+(\.\d+)?(ns|us|µs|ms|s|m|h)(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))*$/;

/** Validate a Go-duration env var; return undefined (and warn) on anything invalid or zero. */
function envDuration(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (v === "" || v === "0") return undefined;
  if (!GO_DURATION.test(v)) {
    console.error(
      `wacli-mcp: ignoring invalid WACLI_MCP_LOCK_WAIT=${JSON.stringify(raw)} (expected a Go duration like "10s")`,
    );
    return undefined;
  }
  return v;
}

const WACLI_BIN = process.env["WACLI_BIN"] || "wacli";
const STORE_DIR = process.env["WACLI_STORE_DIR"] ?? "";
const ACCOUNT = process.env["WACLI_ACCOUNT"] ?? "";
// Read-only if our own flag is set OR wacli's native WACLI_READONLY is set, so the tool list
// we advertise matches what wacli will actually accept.
const READONLY = process.env["WACLI_MCP_READONLY"] === "1" || envTruthy(process.env["WACLI_READONLY"]);
// Clamped upper bounds: keep the setTimeout delay well under the 32-bit limit, and keep the
// output buffer well under V8's max string length so accumulation can never throw RangeError.
const TIMEOUT_MS = envInt(process.env["WACLI_MCP_TIMEOUT_MS"], 120_000, 1_000, 3_600_000);
const MAX_OUTPUT_CHARS = envInt(process.env["WACLI_MCP_MAX_OUTPUT_CHARS"], 5_000_000, 10_000, 50_000_000);
const MAX_RESULT_CHARS = envInt(process.env["WACLI_MCP_MAX_RESULT_CHARS"], 200_000, 1_000, 50_000_000);
// Optional: wait this long for the store write-lock before failing, so a write briefly queues
// behind a transient lock (a concurrent sync/auth) instead of erroring immediately. Reads ignore it.
const LOCK_WAIT = envDuration(process.env["WACLI_MCP_LOCK_WAIT"]);
// Threshold (seconds) for judging the shared wacli-sync heartbeat fresh in wacli_doctor output.
// Mirror the sync supervisor's SYNC_STALE_SEC default so a "locked" doctor reading can be classified
// HEALTHY (a sync sidecar owns the connection) vs FAULT (sync down, store going stale).
const SYNC_STALE_SEC = envInt(process.env["WACLI_MCP_SYNC_STALE_SEC"], 360, 1, 86_400);

// Serve over HTTP (Streamable HTTP) when explicitly enabled or a PORT is provided; otherwise stdio.
const HTTP_MODE = envTruthy(process.env["WACLI_MCP_HTTP"]) || process.env["PORT"] !== undefined;

// Give wacli's own --timeout a proportional head start (90% of the hard deadline) so it emits its
// structured JSON error before the hard SIGKILL — correct for both large and small timeouts.
const WACLI_TIMEOUT = `${Math.floor(TIMEOUT_MS * 0.9)}ms`;

// Globals are fixed at startup; build the argv prefix once.
const GLOBAL_FLAGS: string[] = ["--json", "--timeout", WACLI_TIMEOUT];
if (STORE_DIR) GLOBAL_FLAGS.push("--store", STORE_DIR);
if (ACCOUNT) GLOBAL_FLAGS.push("--account", ACCOUNT);
if (READONLY) GLOBAL_FLAGS.push("--read-only");
if (LOCK_WAIT) GLOBAL_FLAGS.push("--lock-wait", LOCK_WAIT);

// Subcommands that must never run under MCP: `auth` is interactive (QR); `sync` defaults to
// --follow=true and ignores --timeout, so it would run until the hard SIGKILL.
const BLOCKED_SUBCOMMANDS = new Set(["auth", "sync"]);

// Global flags the server owns. wacli_run may not set these, because cobra honors the LAST
// occurrence — e.g. a user-supplied `--read-only=false` would silently undo our sandbox.
const RESERVED_GLOBAL_FLAGS = ["--json", "--store", "--account", "--read-only", "--timeout", "--lock-wait", "--events"];

// Global flags that consume the following token as their value (so it isn't the subcommand).
const VALUE_GLOBAL_FLAGS = new Set(["--store", "--account", "--timeout", "--lock-wait"]);

// In-flight children, reaped on shutdown so we never orphan a wacli process tree.
const activeChildren = new Set<ChildProcess>();

// The HTTP server instance (HTTP mode only), closed on shutdown.
let activeHttpServer: HttpServer | undefined;

type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

const EnvelopeSchema = z.object({ success: z.boolean(), data: z.unknown(), error: z.string().nullable() });

/** SIGKILL the child's whole process group (it is a detached group leader) so wacli's own
 *  grandchildren (ffmpeg/ffprobe during media sends, etc.) don't survive as orphans. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL"); // negative pid → entire process group
      return;
    } catch {
      /* group already gone or not a leader; fall back to single-process kill */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already dead */
  }
}

/** Run wacli with the given args (after the global flags) and resolve the parsed data. */
function runWacli(args: string[]): Promise<unknown> {
  const fullArgs = [...GLOBAL_FLAGS, ...args];

  return new Promise((resolve, reject) => {
    const child = spawn(WACLI_BIN, fullArgs, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    activeChildren.add(child);
    // Decode as UTF-8 across chunk boundaries (multibyte accents/emoji must not be split).
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    let killReason: "timeout" | "overflow" | null = null;

    const timer = setTimeout(() => {
      if (!killReason) {
        killReason = "timeout";
        killTree(child);
      }
    }, TIMEOUT_MS);

    child.stdout.on("data", (d: string) => {
      stdout += d;
      if (stdout.length > MAX_OUTPUT_CHARS && !killReason) {
        killReason = "overflow";
        killTree(child);
      }
    });
    child.stderr.on("data", (d: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += d;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`wacli binary not found at "${WACLI_BIN}". Set WACLI_BIN to the full path.`));
      } else {
        reject(new Error(`failed to spawn wacli: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      // Output was aborted mid-stream: the buffer is truncated, don't try to parse it.
      if (killReason === "overflow") {
        reject(
          new Error(
            `wacli output exceeded ${MAX_OUTPUT_CHARS} chars and was aborted; narrow the request (e.g. a smaller "limit").`,
          ),
        );
        return;
      }
      // Try the envelope first even on timeout — wacli may have emitted a complete result just
      // before the deadline; don't discard a valid answer as a timeout failure.
      const result = parseEnvelope(stdout, stderr, code);
      if (result.ok) {
        resolve(result.value);
        return;
      }
      if (killReason === "timeout") {
        reject(new Error(`wacli timed out after ${TIMEOUT_MS}ms: wacli ${fullArgs.join(" ")}`));
        return;
      }
      reject(new Error(result.error));
    });
  });
}

/** Interpret one stream for a {success,data,error} JSON envelope, or null if it isn't one. */
function tryEnvelope(stream: string): ParseResult | null {
  const trimmed = stream.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastJsonLine(trimmed));
  } catch {
    return null;
  }
  const env = EnvelopeSchema.safeParse(parsed);
  if (!env.success) return null;
  return env.data.success
    ? { ok: true, value: env.data.data }
    : { ok: false, error: env.data.error ?? "wacli returned success=false" };
}

/** wacli prints the success envelope to stdout and the error envelope to stderr — check both. */
function parseEnvelope(stdout: string, stderr: string, code: number | null): ParseResult {
  const fromStreams = tryEnvelope(stdout) ?? tryEnvelope(stderr);
  if (fromStreams) return fromStreams;
  if (code === 0) return { ok: true, value: stdout.trim() || { ok: true } };
  return { ok: false, error: stderr.trim() || stdout.trim() || `wacli exited with code ${String(code)}` };
}

/** wacli may emit NDJSON lifecycle lines (with --events); the data envelope is the last JSON line. */
function lastJsonLine(s: string): string {
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? s;
}

/** The subcommand is the first token that isn't a global flag (or a value-taking global flag's value). */
function firstSubcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === undefined) continue;
    if (VALUE_GLOBAL_FLAGS.has(tok)) {
      i++; // skip the flag's value too
      continue;
    }
    if (tok.startsWith("-")) continue; // boolean global flag or --flag=value form
    return tok;
  }
  return undefined;
}

/**
 * Policy for the `wacli_run` escape hatch only (the typed tools build trusted argv themselves).
 * Tokens after a standalone `--` are positional content and are never inspected, so a user can
 * still pass e.g. a media id that looks like a flag. Write-protection in read-only mode is
 * enforced by wacli's own --read-only; here we block what wacli can't handle gracefully over MCP
 * and prevent overriding the globals the server owns.
 */
function enforcePolicy(args: string[]): string | null {
  const termIdx = args.indexOf("--");
  const flagScope = termIdx === -1 ? args : args.slice(0, termIdx);

  if (flagScope.some((a) => a === "--follow" || a.startsWith("--follow="))) {
    return `follow mode is not allowed over MCP (it never returns).`;
  }
  for (const flag of RESERVED_GLOBAL_FLAGS) {
    if (flagScope.some((a) => a === flag || a.startsWith(`${flag}=`))) {
      return `"${flag}" is managed by the server and cannot be overridden per call (configure it via env).`;
    }
  }
  const sub = firstSubcommand(flagScope);
  if (sub && BLOCKED_SUBCOMMANDS.has(sub)) {
    return `subcommand "${sub}" is not available over MCP (interactive or never-returning). Run it directly in a terminal.`;
  }
  return null;
}

/** Build argv from a flag map, skipping undefined/false and expanding repeatables. */
function flags(map: Record<string, string | number | boolean | string[] | undefined>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined || v === false) continue;
    if (Array.isArray(v)) {
      for (const item of v) out.push(`--${k}`, item);
    } else if (v === true) {
      out.push(`--${k}`);
    } else {
      out.push(`--${k}`, String(v));
    }
  }
  return out;
}

/** Await wacli output and wrap it as an MCP text result, truncating to keep the model's context bounded. */
async function asResult(p: Promise<unknown>) {
  const data = await p;
  const full = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const text =
    full.length > MAX_RESULT_CHARS
      ? full.slice(0, MAX_RESULT_CHARS) +
        `\n\n…[truncated: ${full.length} chars total, showing first ${MAX_RESULT_CHARS}. Narrow the request with a smaller "limit" or more filters.]`
      : full;
  return { content: [{ type: "text" as const, text }] };
}

// ── wacli_doctor enrichment ──────────────────────────────────────────────────
// `wacli doctor` reports THIS server's own store view: when a wacli-sync sidecar holds the live
// WhatsApp connection, doctor shows connected:false / connection_state:"locked_by_other_process".
// That is the HEALTHY steady state (this server is the read-only reader; sync owns the socket), but
// it reads like a fault. Attach a verdict derived from the shared heartbeat so it can't be misread.
function syncSupervisorHealth(): Record<string, unknown> {
  const path = process.env["SYNC_HEARTBEAT_FILE"] || (STORE_DIR ? `${STORE_DIR}/.sync-heartbeat` : "");
  if (!path) return { present: false, note: "no store dir configured; cannot locate .sync-heartbeat" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {
      present: false,
      healthy: false,
      note: "no .sync-heartbeat — no wacli-sync sidecar running. This server may own the connection directly (see `connected`), or sync is down.",
    };
  }
  const ts = Number(raw.trim());
  if (!Number.isFinite(ts)) return { present: true, healthy: false, note: "unparseable heartbeat file" };
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  const healthy = ageSec < SYNC_STALE_SEC;
  return {
    present: true,
    healthy,
    heartbeat_age_sec: ageSec,
    stale_threshold_sec: SYNC_STALE_SEC,
    note: healthy
      ? `HEALTHY — a wacli-sync sidecar owns the WhatsApp connection (heartbeat ${ageSec}s old). This server's connected:false / locked_by_other_process is the normal read-only-reader state, NOT a fault.`
      : `FAULT — heartbeat ${ageSec}s old (> ${SYNC_STALE_SEC}s): wacli-sync is down or stuck and the store is going stale.`,
  };
}

/** Attach the sync-supervisor verdict to wacli's own doctor JSON (additive; never throws). */
async function augmentDoctor(p: Promise<unknown>): Promise<unknown> {
  const data = await p;
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), sync_supervisor: syncSupervisorHealth() };
  }
  return data;
}

// Shared field schema: wacli imposes no hard upper bound, but a very large limit would flood the
// model's context, so we cap (and document) it here.
const limitSchema = z.number().int().positive().max(1000).optional().describe("max results (default 50, max 1000)");

/** Construct a fresh MCP server with all tools registered — one per stdio process, one per HTTP session. */
function buildServer(): McpServer {
  const server = new McpServer({ name: "wacli-mcp", version: "0.2.1" });
  registerTools(server);
  return server;
}

/** Register every tool on a server instance. Split out so each HTTP session gets an isolated server. */
function registerTools(server: McpServer): void {
  // ── Read tools ────────────────────────────────────────────────────────────

  server.registerTool(
    "wacli_doctor",
    {
      description:
        "Diagnostics: store path, auth status, sync stats, FTS availability, plus a `sync_supervisor` verdict that classifies a `locked_by_other_process` reading as HEALTHY (a wacli-sync sidecar holds the live connection) vs FAULT (sync down, store stale). Good first call to confirm wacli is set up.",
      inputSchema: {},
    },
    () => asResult(augmentDoctor(runWacli(["doctor"]))),
  );

  server.registerTool(
    "wacli_chats_list",
    {
      description: "List chats from the local synced DB (most recent first).",
      inputSchema: {
        query: z.string().optional().describe("filter chats by name/jid substring"),
        limit: limitSchema,
      },
    },
    ({ query, limit }) => asResult(runWacli(["chats", "list", ...flags({ query, limit })])),
  );

  server.registerTool(
    "wacli_messages_search",
    {
      description: "Full-text search over synced messages (FTS5 if available, else LIKE).",
      inputSchema: {
        query: z.string().min(1).describe("search text"),
        chat: z.string().optional().describe("restrict to a chat JID"),
        from: z.string().optional().describe("restrict to a sender JID"),
        type: z.enum(["text", "image", "video", "audio", "document"]).optional(),
        has_media: z.boolean().optional().describe("only messages with media (cannot combine with type=text)"),
        after: z.string().optional().describe("RFC3339 or YYYY-MM-DD lower bound"),
        before: z.string().optional().describe("RFC3339 or YYYY-MM-DD upper bound"),
        limit: limitSchema,
      },
    },
    ({ query, chat, from, type, has_media, after, before, limit }) => {
      // wacli rejects this combination; catch it here with a clearer message than wacli's.
      if (type === "text" && has_media) {
        return asResult(
          Promise.reject(new Error("`has_media` cannot be combined with type=text (text messages have no media).")),
        );
      }
      // `--` terminates flag parsing so a query starting with "-" isn't treated as a flag.
      return asResult(
        runWacli([
          "messages",
          "search",
          ...flags({ chat, from, type, "has-media": has_media, after, before, limit }),
          "--",
          query,
        ]),
      );
    },
  );

  server.registerTool(
    "wacli_messages_list",
    {
      description: "List messages from the local DB, with filters. Newest first unless asc=true.",
      inputSchema: {
        chat: z.string().optional().describe("filter by chat JID"),
        sender: z.string().optional().describe("filter by sender JID"),
        from_me: z.boolean().optional().describe("only messages sent by me"),
        after: z.string().optional(),
        before: z.string().optional(),
        asc: z.boolean().optional().describe("oldest first"),
        limit: limitSchema,
      },
    },
    ({ chat, sender, from_me, after, before, asc, limit }) =>
      asResult(
        runWacli(["messages", "list", ...flags({ chat, sender, "from-me": from_me, after, before, asc, limit })]),
      ),
  );

  server.registerTool(
    "wacli_contacts_search",
    {
      description: "Search synced contacts by name/number.",
      inputSchema: {
        query: z.string().min(1).describe("contact name or number"),
        limit: limitSchema,
      },
    },
    // `--` terminates flag parsing so a query starting with "-" isn't treated as a flag.
    ({ query, limit }) => asResult(runWacli(["contacts", "search", ...flags({ limit }), "--", query])),
  );

  server.registerTool(
    "wacli_groups_list",
    {
      description: "List WhatsApp groups from the local DB.",
      inputSchema: {},
    },
    () => asResult(runWacli(["groups", "list"])),
  );

  // ── Send tools (suppressed in read-only mode; wacli would reject them there anyway) ──

  if (!READONLY) {
    server.registerTool(
      "wacli_send_text",
      {
        description:
          "Send a WhatsApp text message. `to` accepts a JID, a phone number, or a contact/group/chat name (use `pick` to disambiguate a name).",
        inputSchema: {
          to: z.string().min(1).describe("recipient: JID, phone number, or contact/group/chat name"),
          message: z.string().min(1).describe("message text"),
          pick: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("if `to` is an ambiguous name, pick the Nth match (1-indexed)"),
          reply_to: z.string().optional().describe("message ID to quote/reply to"),
          no_preview: z.boolean().optional().describe("disable link preview"),
          mention: z.array(z.string()).optional().describe("phone numbers or user JIDs to @mention"),
        },
      },
      ({ to, message, pick, reply_to, no_preview, mention }) =>
        asResult(
          runWacli([
            "send",
            "text",
            ...flags({ to, message, pick, "reply-to": reply_to, "no-preview": no_preview, mention }),
          ]),
        ),
    );

    server.registerTool(
      "wacli_send_file",
      {
        description: "Send a file (image/video/audio/document) from a local path. `to` resolves like wacli_send_text.",
        inputSchema: {
          to: z.string().min(1).describe("recipient: JID, phone number, or contact/group/chat name"),
          file: z.string().min(1).describe("absolute path to the file on this machine"),
          caption: z.string().optional(),
          filename: z.string().optional().describe("display name (defaults to basename)"),
          pick: z.number().int().positive().optional(),
          reply_to: z.string().optional(),
        },
      },
      ({ to, file, caption, filename, pick, reply_to }) =>
        asResult(runWacli(["send", "file", ...flags({ to, file, caption, filename, pick, "reply-to": reply_to })])),
    );
  }

  // ── Generic escape hatch ────────────────────────────────────────────────────

  server.registerTool(
    "wacli_run",
    {
      description:
        'Run an arbitrary wacli subcommand for cases not covered by the typed tools (e.g. polls, presence, channels, profile, media download). Pass argv AFTER the binary name, e.g. ["presence","subscribe","--jid","123@s.whatsapp.net"]. `--json` and the timeout are added automatically; the server-owned globals (--store/--account/--read-only/--timeout/--json/--events) cannot be overridden. `auth`, `sync`, and follow mode are blocked. Long-running commands (e.g. history backfill) are bounded only by the hard timeout.',
      inputSchema: {
        args: z.array(z.string()).min(1).describe("argv tokens for wacli, excluding the binary name and --json"),
      },
    },
    ({ args }) => {
      const violation = enforcePolicy(args);
      return asResult(violation ? Promise.reject(new Error(violation)) : runWacli(args));
    },
  );
}

// ── Lifecycle: reap children and fail cleanly ────────────────────────────────

function reapChildren(): void {
  for (const child of activeChildren) killTree(child);
  activeChildren.clear();
  activeHttpServer?.close();
}
process.on("exit", reapChildren);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    reapChildren();
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}
// The MCP client closing the stdio pipe (EPIPE) must not crash us mid-write — shut down cleanly.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") {
    reapChildren();
    process.exit(0);
  }
});
process.on("uncaughtException", (err) => {
  console.error("wacli-mcp uncaught exception:", err);
  // In HTTP mode a single bad request must not take the server down for every other client.
  if (HTTP_MODE) return;
  reapChildren();
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("wacli-mcp unhandled rejection:", reason);
  if (HTTP_MODE) return;
  reapChildren();
  process.exit(1);
});

// ── HTTP transport (Streamable HTTP) ─────────────────────────────────────────

const HTTP_PORT = envInt(process.env["PORT"] ?? process.env["MCP_HTTP_PORT"], 8080, 1, 65535);
const HTTP_PATH = process.env["MCP_HTTP_PATH"] || "/mcp";
const STATELESS = envTruthy(process.env["WACLI_MCP_STATELESS"]);
const SESSION_TTL_MS = 30 * 60_000; // evict sessions idle longer than this

type HttpSession = { transport: StreamableHTTPServerTransport; lastSeen: number };

/** A JSON-RPC error envelope for the cases we answer ourselves, around the transport. */
function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}

/** Last resort: a thrown request becomes a 500 and never reaches the process-global handlers. */
function respondInternalError(res: Response, err: unknown): void {
  console.error("wacli-mcp http request error:", err);
  if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, "Internal server error"));
}

/** Adapt an async handler to Express while keeping every rejection contained (lint + availability). */
function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    void fn(req, res).catch((err: unknown) => {
      respondInternalError(res, err);
    });
  };
}

function headerSessionId(req: Request): string | undefined {
  const h = req.headers["mcp-session-id"];
  return Array.isArray(h) ? h[0] : h;
}

/** Start the Streamable-HTTP server. Stateful sessions by default; WACLI_MCP_STATELESS = a fresh
 *  server per request with JSON responses, for clients that don't track sessions. */
async function startHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  if (STATELESS) {
    app.post(
      HTTP_PATH,
      wrap(async (req, res) => {
        const body = req.body as unknown;
        const server = buildServer();
        // Omit sessionIdGenerator → stateless (no session id); explicit `undefined` is rejected
        // under exactOptionalPropertyTypes.
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        // Cast: the transport is a Transport at runtime; its onclose typing trips
        // exactOptionalPropertyTypes against the interface.
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res, body);
      }),
    );
    // With no sessions, the server→client SSE stream and explicit teardown are meaningless.
    const notAllowed = (_req: Request, res: Response): void => {
      res.status(405).json(jsonRpcError(-32000, "Method not allowed in stateless mode"));
    };
    app.get(HTTP_PATH, notAllowed);
    app.delete(HTTP_PATH, notAllowed);
  } else {
    const sessions = new Map<string, HttpSession>();

    // onclose fires only when a stream closes; a client that just stops polling would otherwise leak
    // its session forever — so sweep idle ones.
    const sweeper = setInterval(() => {
      const now = Date.now();
      for (const [id, s] of sessions) {
        if (now - s.lastSeen > SESSION_TTL_MS) {
          sessions.delete(id);
          void s.transport.close();
        }
      }
    }, 60_000);
    sweeper.unref();

    app.post(
      HTTP_PATH,
      wrap(async (req, res) => {
        const body = req.body as unknown;
        const sessionId = headerSessionId(req);
        if (sessionId) {
          const existing = sessions.get(sessionId);
          if (!existing) {
            res.status(404).json(jsonRpcError(-32001, "Unknown or expired session"));
            return;
          }
          existing.lastSeen = Date.now();
          await existing.transport.handleRequest(req, res, body);
          return;
        }
        // No session yet: only an initialize request may open one.
        if (!isInitializeRequest(body)) {
          res.status(400).json(jsonRpcError(-32000, "No valid session; send an initialize request first"));
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, lastSeen: Date.now() });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        const server = buildServer();
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res, body);
      }),
    );

    // GET = server→client SSE stream; DELETE = explicit teardown. Both require a live session.
    const handleSessionRequest = wrap(async (req, res) => {
      const sessionId = headerSessionId(req);
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (!existing) {
        res.status(404).json(jsonRpcError(-32001, "Unknown or expired session"));
        return;
      }
      existing.lastSeen = Date.now();
      await existing.transport.handleRequest(req, res);
    });
    app.get(HTTP_PATH, handleSessionRequest);
    app.delete(HTTP_PATH, handleSessionRequest);
  }

  await new Promise<void>((resolve) => {
    activeHttpServer = app.listen(HTTP_PORT, "0.0.0.0", resolve);
  });
  console.error(
    `wacli-mcp ready (http://0.0.0.0:${HTTP_PORT}${HTTP_PATH}, ${STATELESS ? "stateless" : "stateful"}` +
      `, bin=${WACLI_BIN}${READONLY ? ", read-only" : ""}, timeout=${TIMEOUT_MS}ms)`,
  );
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

if (HTTP_MODE) {
  await startHttp();
} else {
  const server = buildServer();
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (err) {
    console.error("wacli-mcp failed to start:", err);
    reapChildren();
    process.exit(1);
  }
  // stderr is safe for logs; stdout is reserved for the MCP protocol.
  console.error(`wacli-mcp ready (stdio, bin=${WACLI_BIN}${READONLY ? ", read-only" : ""}, timeout=${TIMEOUT_MS}ms)`);
}
