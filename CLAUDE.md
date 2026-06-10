# wacli-mcp — MCP server wrapping the `wacli` WhatsApp CLI

- Strict TS gate: `pnpm check` (format + lint + typecheck) covers `server.ts` + `sync-supervisor.ts`. Runtime/ops scripts go through `tsc` (add to `tsconfig.json` `include`), NOT raw `.mjs` — only `smoke.mjs` is excluded from the gate.
- `docker build` blockers: the wacli stage needs **Go ≥ 1.25** (`golang:1.25-bookworm`; wacli's `go.mod` requires it) + CGO/`sqlite_fts5`; and `package.json` must pin `packageManager` (pnpm 10.x) so corepack doesn't use pnpm 11, whose `minimumReleaseAge` policy fails `pnpm install --frozen-lockfile` on recently-published deps.
- Default transport is stdio (`pnpm dev`, `smoke.mjs`); HTTP (Streamable) is gated by `WACLI_MCP_HTTP=1`/`PORT`.
- Runs as two services sharing one store on `mcp-net`: `wacli-sync` runs `sync --follow` (holds the single WhatsApp connection + store lock); `wacli-mcp` reads lockless (WAL) and its sends delegate via `<store>/.send.sock`. One sync replica only.
- Canonical `wacli` source is checked out at `../wacli-latest` (`github.com/openclaw/wacli`, `v0.11.0-12` = the deployed build) — grep-verify wacli runtime behavior there instead of guessing. E.g. `--follow` holds the store lock and opens `.send.sock` (`cmd/wacli/sync.go:46,72`, `send_ipc.go:22`); typed reads pass `needLock=false` so they're lockless (`cmd/wacli/messages.go`, `chats.go`).
- Deployed via the `portainer-setup` `mcp-servers` stack (see that repo's CLAUDE.md for the deploy gotchas); ghcr image is private (NAS pulls via a Portainer `ghcr` registry cred).
- `README.md` is the detailed reference (tool list, full env-var tables, transport/Docker/supervisor docs). Whole-wiring smoke test: `WACLI_BIN=../wacli-latest/dist/wacli node smoke.mjs` (needs an authed store).
