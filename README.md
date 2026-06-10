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
| `wacli_send_file` | Send a file (hidden in read-only mode). |
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

**Hardening notes:** every call runs the binary via `spawn` (argv array — no shell, so no shell injection), with UTF-8-safe streaming, a proportional timeout head-start (wacli's own `--timeout` is set to 90% of the hard deadline so its structured error wins), and an output cap. Children are spawned detached and killed by **process group** (so wacli's own `ffmpeg`/`ffprobe` helpers don't orphan), and reaped on `SIGINT`/`SIGTERM`/`exit`. An `EPIPE` from a disconnecting client, plus any `uncaughtException`/`unhandledRejection`, shut the server down cleanly instead of crashing mid-write. `wacli_run` is sandboxed: it cannot override the server-owned globals (`--store`/`--account`/`--read-only`/`--timeout`/`--json`/`--events`) and cannot run `auth`, `sync`, or follow mode. The typed tools build their own argv and are not subject to that policy, so search/message content that happens to look like a flag (e.g. `--store`) works.

## Test

```bash
WACLI_BIN=../wacli-latest/dist/wacli node smoke.mjs
```
