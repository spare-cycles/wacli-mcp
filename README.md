# wacli-mcp

A thin [MCP](https://modelcontextprotocol.io) server that wraps the [`wacli`](https://github.com/steipete/wacli) WhatsApp CLI. Every tool shells out to `wacli --json` and returns the parsed `{ success, data, error }` envelope.

## Tools

| Tool | What it does |
| --- | --- |
| `wacli_doctor` | Store path, auth status, sync stats, FTS availability. Call first. |
| `wacli_chats_list` | List chats from the local synced DB. |
| `wacli_messages_search` | Full-text search over synced messages. |
| `wacli_messages_list` | List messages with filters (chat, sender, time, from-me). |
| `wacli_contacts_search` | Search synced contacts. |
| `wacli_groups_list` | List groups. |
| `wacli_send_text` | Send a text message (hidden in read-only mode). |
| `wacli_send_file_path` | Send a file from a path on the server's filesystem (hidden in read-only mode). **Breaking:** renamed from `wacli_send_file` (the old name is gone, not aliased — update any client that used it). |
| `wacli_send_file_bytes` | Send a file from client-supplied base64 content — no server-side path (hidden in read-only mode). |
| `wacli_run` | Escape hatch: run any other wacli subcommand (polls, presence, channels, profile, media…). |

`auth` (interactive QR) and `--follow` (never returns) are blocked. There's a hard subprocess timeout on every call.

## Prerequisites

1. **A `wacli` binary.** Either `brew install steipete/tap/wacli`, or build from source:
   ```bash
   cd ../wacli-latest && go build -tags sqlite_fts5 -o dist/wacli ./cmd/wacli
   ```
2. **Authenticate once, out of band** (the server never shows a QR):
   ```bash
   wacli auth          # scan QR
   wacli sync --follow # optional: keep a fresh local copy running separately
   ```

## Setup

```bash
cd wacli-mcp
pnpm install        # or: npm install
```

Dev run (no build step, via tsx):
```bash
pnpm dev
```

Production (compiled):
```bash
pnpm build && node dist/server.js
```

## Transports: stdio (default) or Streamable HTTP

By default the server speaks **stdio** (one client per process) — ideal for a local Claude Code / Desktop config. Set `WACLI_MCP_HTTP=1` (or any `PORT`) to serve **Streamable HTTP** instead, for a long-lived remote server:

```bash
WACLI_MCP_HTTP=1 PORT=8080 node dist/server.js
# → POST/GET/DELETE http://0.0.0.0:8080/mcp   ·   GET /health → {"ok":true}
```

The HTTP transport keeps one MCP session per `Mcp-Session-Id` (created on `initialize`, swept after 30 min idle), isolates each request (a bad request returns a JSON-RPC 500 and never brings the server down for other clients), and leaves DNS-rebinding protection off so it can sit behind a reverse proxy that rewrites `Host`. `WACLI_MCP_STATELESS=1` switches to a stateless, session-less mode (JSON responses, fresh server per request).

## Docker

The image bundles a self-built Linux `wacli` (CGO + `sqlite_fts5`) and `ffmpeg`, and runs in HTTP mode by default.

```bash
# Build (pin a wacli release tag for reproducibility):
docker build --build-arg WACLI_REF=v0.5.0 -t ghcr.io/spare-cycles/wacli-mcp:0.1.0 .

# Authenticate once (interactive QR) into a persistent store volume:
docker run --rm -it -v wacli-store:/data/wacli \
  ghcr.io/spare-cycles/wacli-mcp:0.1.0 wacli --store /data/wacli auth

# Serve (HTTP on :8080, reading the authenticated store):
docker run --rm -p 8080:8080 -v wacli-store:/data/wacli \
  ghcr.io/spare-cycles/wacli-mcp:0.1.0
```

The container runs as a non-root user (UID 1000); when the store is a bind mount, `chown` it to `1000:1000` first (an init sidecar handles this in the Portainer deployment). CI builds and pushes `ghcr.io/<owner>/wacli-mcp` on pushes to `main` and tags (`.github/workflows/docker.yml`).

## Continuous sync + alerting (`sync-supervisor.ts`)

The MCP server reads from the local store on demand; it does **not** keep the store fresh on its own. The image also ships a **sync supervisor** ([sync-supervisor.ts](sync-supervisor.ts)) that runs as a *separate* container against the **same** store: it runs `wacli sync --follow --events`, which holds the one WhatsApp connection and exposes the send-delegate socket — so the MCP server's reads stay lockless and its sends delegate to this connection (set the server's `WACLI_MCP_LOCK_WAIT` empty so sends delegate immediately rather than waiting).

It turns wacli's NDJSON lifecycle events into a **heartbeat file** (integer Unix seconds, refreshed only while connected) for the Docker healthcheck, and **ntfy alerts** (down after a grace, periodic re-alerts, recovery notice, plus a startup self-test and a child-exit alert). Run it by overriding the command:

```bash
docker run --rm -v wacli-store:/data/wacli \
  -e NTFY_BASE_URL=https://ntfy.example.com -e NTFY_TOPIC=alerts -e NTFY_TOKEN=tk_… \
  ghcr.io/spare-cycles/wacli-mcp:0.2.0 node dist/sync-supervisor.js
```

| Env | Default | Meaning |
| --- | --- | --- |
| `SYNC_STALE_SEC` | `360` | Down/stale grace before alerting; also the healthcheck freshness threshold. |
| `SYNC_REALERT_SEC` | `1800` | Re-alert cadence while still down. |
| `SYNC_LOCK_WAIT` | `30s` | `--lock-wait` so the sync wins the store lock at startup/restart. |
| `NTFY_BASE_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` | – | ntfy publish (JSON to the root URL, `Bearer` auth). |
| `SYNC_DOWNLOAD_MEDIA` / `SYNC_REFRESH_GROUPS` | – | Optional `wacli sync` flags. |

**One connection per device:** run exactly one supervisor; while it holds the connection, `wacli_run` calls that need the lock and don't delegate (media download, history backfill, presence, channels, group admin, profile) return "store is locked". The typed read/send tools are unaffected.

## Quality gate

Strict TypeScript + ESLint (typescript-eslint `strictTypeChecked` + `stylisticTypeChecked`, type-aware) + Prettier.

```bash
pnpm check        # format check + lint + typecheck (run this before committing)
pnpm lint         # eslint .
pnpm lint:fix     # eslint --fix
pnpm format       # prettier --write .
pnpm typecheck    # tsc --noEmit
```

`tsconfig.json` enables the full strict set (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `noUnused*`, …). `smoke.mjs` is a manual integration script and is excluded from the lint/type gate.

## Configure in Claude Code / Claude Desktop

Add to your MCP config (`~/.claude.json`, or Claude Desktop's `claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "wacli": {
      "command": "npx",
      "args": ["tsx", "/Users/loup/code/perso/wacli-mcp/server.ts"],
      "env": {
        "WACLI_BIN": "/Users/loup/code/perso/wacli-latest/dist/wacli"
      }
    }
  }
}
```

Or register it with the CLI:
```bash
claude mcp add wacli -e WACLI_BIN=/Users/loup/code/perso/wacli-latest/dist/wacli -- npx tsx /Users/loup/code/perso/wacli-mcp/server.ts
```

## Configuration (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `WACLI_BIN` | `wacli` (PATH) | Path to the wacli binary. |
| `WACLI_STORE_DIR` | wacli's `~/.wacli` | Override the store dir (`--store`). |
| `WACLI_ACCOUNT` | – | Named account from `config.yaml` (`--account`). |
| `WACLI_MCP_READONLY` | – | `1` ⇒ pass `--read-only` to wacli (it rejects writes) **and** hide the send tools. wacli's native `WACLI_READONLY` (`1/true/yes/on`) is also honored, so the advertised tools match what wacli accepts. |
| `WACLI_MCP_TIMEOUT_MS` | `120000` | Hard kill timeout per call (ms). Invalid/≤0 falls back to the default; clamped to [1000, 3600000]. |
| `WACLI_MCP_MAX_OUTPUT_CHARS` | `5000000` | Cap on buffered child output; a command that exceeds it is aborted. Clamped to [10000, 50000000]. |
| `WACLI_MCP_MAX_RESULT_CHARS` | `200000` | Cap on the text returned to the model (truncated with a note) so a large result can't flood context. |
| `WACLI_MCP_LOCK_WAIT` | – | Go duration (e.g. `10s`) to wait for the store write-lock before failing, so a write queues behind a transient lock (a concurrent `sync`/`auth`) instead of erroring immediately. Reads ignore it; invalid values are warned and ignored. |
| `WACLI_UPLOAD_DIR` | `os.tmpdir()` | Dir where `wacli_send_file_bytes` writes its short-lived temp files (removed after each send). |
| `WACLI_MAX_UPLOAD_BYTES` | `67108864` (64 MiB) | Max **decoded** size accepted by `wacli_send_file_bytes`; clamped to [1, 268435456]. The HTTP body limit is derived from this (`ceil(× 4/3) + 1 MiB`) so a within-cap upload isn't rejected with a 413. |

**Hardening notes:** every call runs the binary via `spawn` (argv array — no shell, so no shell injection), with UTF-8-safe streaming, a proportional timeout head-start (wacli's own `--timeout` is set to 90% of the hard deadline so its structured error wins), and an output cap. Children are spawned detached and killed by **process group** (so wacli's own `ffmpeg`/`ffprobe` helpers don't orphan), and reaped on `SIGINT`/`SIGTERM`/`exit`. An `EPIPE` from a disconnecting client shuts the server down cleanly instead of crashing mid-write; in **stdio** mode an `uncaughtException`/`unhandledRejection` also exits cleanly, but in **HTTP** mode they are logged and the server keeps serving other clients (a per-request error returns a JSON-RPC 500). `wacli_run` is sandboxed: it cannot override the server-owned globals (`--store`/`--account`/`--read-only`/`--timeout`/`--json`/`--events`) and cannot run `auth`, `sync`, or follow mode. The typed tools build their own argv and are not subject to that policy, so search/message content that happens to look like a flag (e.g. `--store`) works.

## Test

```bash
WACLI_BIN=../wacli-latest/dist/wacli node smoke.mjs
```
