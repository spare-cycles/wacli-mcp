# Design — rewrite `wacli-mcp` on Baileys (`wa-mcp`)

**Date:** 2026-08-01
**Status:** Approved (pre-implementation)
**Component:** whole repository — full rewrite
**Supersedes:** the `wacli` subprocess architecture in `server.ts`, `sync-supervisor.ts`, `send-file.ts`

## Problem

`wacli-mcp` is a thin MCP server that shells out to the Go [`wacli`](https://github.com/openclaw/wacli)
CLI. Everything about its shape is dictated by that subprocess:

1. **The Go dependency.** The Docker build needs Go ≥ 1.25, CGO, `sqlite_fts5`, and a
   pinned upstream ref, for a project that is otherwise pure TypeScript.
2. **The capability ceiling.** The server can only do what the CLI exposes. Reactions,
   replies, edits, deletes, read receipts and media download are either absent or
   reachable only through the untyped `wacli_run` escape hatch.
3. **The single-connection split.** Exactly one process may hold the WhatsApp connection
   and the store write-lock, so the deployment is two containers: `wacli-sync` running
   `sync --follow`, and `wacli-mcp` reading lockless over WAL and delegating sends
   through `<store>/.send.sock`. The heartbeat file, the healthcheck, the lock-wait
   tuning, and the self-heal valve in `sync-supervisor.ts` all exist to manage that seam.
4. **Upstream risk.** `wacli` moves on its own cadence and its behaviour has to be
   grep-verified against a checkout at `../wacli-latest` rather than read from code we own.

## Goal

Replace the whole thing with a single always-on TypeScript process built on
[Baileys](https://github.com/WhiskeySockets/Baileys), owning the WhatsApp connection, its
own SQLite store, and the MCP surface — and give the model first-class access to media,
including voice notes.

## Decisions (settled during brainstorming)

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | **Forward-only history, fresh store.** | Baileys has no archive-walking equivalent of `wacli sync`. It gives an initial pairing sync of whatever WhatsApp chooses to send, plus everything live from connect onward. The old store is abandoned, not migrated. The initial sync **is** ingested (it arrives as `messaging-history.set` and costs nothing extra), but its depth is WhatsApp's choice and nothing is built on top of it. `fetchMessageHistory` is not used in v1. |
| 2 | **One always-on process, HTTP transport only.** | Forward-only history requires an always-connected writer, which rules out putting the socket in a stdio process spawned per client. One process means no IPC, no store lock, no `.send.sock`, no supervisor. Claude Code connects over HTTP like any remote MCP server. |
| 3 | **Baileys `7.0.0-rc14`.** | ESM-native (this repo already is), and the line that models **LID** correctly. 6.7.24 on the `legacy` tag predates that identity model and is CJS. Accepted cost: pinning a prerelease. |
| 4 | **Tool scope: parity + conversation essentials.** | Today's typed tools, plus reply, react, mark-read, edit, delete, and media. No group admin, polls, status, forwarding, location or contact cards in v1. |
| 5 | **Pairing by code, printed to logs.** | Headless container on a NAS; `WA_PHONE_NUMBER` in E.164 without `+`, code read from Portainer's log view. No QR rendering, no unauthenticated pairing route. |
| 6 | **Media is converted to what a model can consume.** | The Anthropic Messages API accepts text and images only. An MCP `audio` block is legal and useless. Images pass through, video becomes keyframes, audio becomes a transcript, PDFs become text. |
| 7 | **Local `whisper.cpp`, `large-v3-turbo-q5_0`, on demand, cached.** | Voice notes stay on the NAS. Turbo keeps large-v3's full encoder, so it is far too slow to run at ingest, but fine on demand. Transcripts are cached in the row and indexed into FTS. |
| 8 | **Rename `wacli_*` → `wa_*`, package `wa-mcp`.** | There is no wacli left. Breaking for client configs; done now rather than never. |
| 9 | **Bearer-token auth on the HTTP endpoint.** | Defence in depth behind the existing Cloudflare Access boundary. The endpoint can now send as you, delete messages, and read all media. |

### Verified facts behind these decisions

Checked 2026-08-01; recorded because several are load-bearing and non-obvious.

1. npm `baileys` and `@whiskeysockets/baileys` both publish `7.0.0-rc14` (2026-07-29);
   `legacy` is `6.7.24`, published the same day and still receiving security backports.
2. Baileys v7 requires the auth state to support three additional key types beyond 6.x:
   `lid-mapping`, `device-list`, `tctoken`. Contacts lose their `jid`/`lid` fields in
   favour of an `id` plus *either* `phoneNumber` or `lid`.
3. Baileys' own documentation states **"DON'T EVER USE `useMultiFileAuthState` IN PROD"** —
   it is a reference implementation, not a production store.
4. `makeWASocket` requires a `getMessage(key)` callback, used to resend undelivered
   messages and to decrypt poll votes. The message store is therefore a hard dependency
   of the socket, not an optional feature.
5. v7 stopped sending delivery ACKs because WhatsApp was banning accounts over it.
6. Node 22's built-in `node:sqlite` bundles SQLite 3.51.3 **with FTS5 compiled in**
   (verified by running it on 22.23.1, unflagged), so full-text search needs no native
   module. It is still marked experimental and emits a warning: pin the Node major in the
   image, and treat any Node upgrade as an explicit compatibility check rather than a
   routine bump.
7. MCP tool results may contain `text`, `image`, `audio`, `resource_link` and embedded
   `resource` blocks — but the Anthropic Messages API accepts text and images (JPEG, PNG,
   GIF, WebP) only. Audio input remains an open feature request
   (anthropic-sdk-python#1198, opened 2026-02-23).
8. `ggerganov/whisper.cpp` on Hugging Face ships `ggml-large-v3-turbo-q5_0.bin` at 574 MB
   (also `q8_0` at 874 MB, f16 at 1625 MB).

## Architecture

One process, one direction of flow:

```
        WhatsApp (single websocket, Baileys 7-rc14)
                    │  events            ▲ sends
                    ▼                    │
   ingest ──► SQLite (WAL, FTS5) ◄── repositories
                    ▲                    │
              auth state           MCP tool handlers
                                         │  ▲
                                    media pipeline
                                         │
                              Streamable HTTP  :8080/mcp
```

### Modules

| Path | Responsibility | Depends on |
| --- | --- | --- |
| `src/config.ts` | Environment → one typed, validated `Config`. Fails loudly at boot on invalid values. | — |
| `src/db/client.ts` | Open the database, set WAL and pragmas, run migrations. | `node:sqlite` |
| `src/db/schema.ts` | DDL and versioned migrations. | — |
| `src/db/auth-state.ts` | Baileys `AuthenticationState` over SQLite, wrapped in `makeCacheableSignalKeyStore`. | `db/client` |
| `src/db/messages.ts`<br>`src/db/chats.ts`<br>`src/db/contacts.ts`<br>`src/db/reactions.ts` | One repository per entity: writes from ingest, reads for tools. No Baileys types cross this boundary. | `db/client` |
| `src/wa/jid.ts` | LID ↔ PN normalization and resolution. **The only place raw JIDs are interpreted.** | — |
| `src/wa/connection.ts` | Socket lifecycle: create, pairing code, reconnect with backoff, `restartRequired`, state machine. | `baileys`, `db/auth-state` |
| `src/wa/ingest.ts` | Baileys events → repository writes. The only such mapping in the codebase. | `db/*`, `wa/jid` |
| `src/wa/send.ts` | Outbound operations; returns the produced `WAMessage` for re-ingest. | `wa/connection` |
| `src/media/download.ts` | `downloadMediaMessage` + content-addressed disk cache. | `baileys` |
| `src/media/convert.ts` | ffmpeg: video keyframes, audio extraction; image downscaling; PDF text extraction. | ffmpeg |
| `src/media/transcribe.ts` | `whisper-cli` invocation, model provisioning, transcript caching. | whisper.cpp |
| `src/mcp/server.ts` | `McpServer` construction and tool registration. | `mcp/tools/*` |
| `src/mcp/tools/*.ts` | One file per tool group. Handlers call repositories, `send.ts` and `media/`; never Baileys. | `db/*`, `wa/send`, `media/*` |
| `src/http.ts` | Express: `/mcp`, `/health`, bearer-token check. | `mcp/server` |
| `src/alerts.ts` | ntfy publishing, driven by the connection state machine. | `wa/connection` |
| `src/main.ts` | Wiring only. | everything |

### Two consequences of Baileys' contract

**The store is load-bearing.** `getMessage(key)` is required by `makeWASocket`. The
`messages` repository implements it, which is why every row retains the serialized raw
message alongside its extracted columns.

**Auth state must be a real store.** SQLite-backed, covering the v7 key types, wrapped in
`makeCacheableSignalKeyStore` so signal-key reads do not hit disk per message.

## Data model

One SQLite file, WAL, opened by exactly one process — so there is no lock protocol.

| Table | Columns | Notes |
| --- | --- | --- |
| `chats` | `id` PK, `name`, `is_group`, `last_message_ts`, `unread_count`, `archived`, `muted_until`, `raw` | Fed by `chats.upsert`/`chats.update` and by every inbound message. |
| `messages` | `rowid` INTEGER PK, `UNIQUE(chat_id, id)`, `sender_id`, `ts`, `from_me`, `kind`, `text`, `transcript`, `quoted_id`, `status`, `edited_ts`, `deleted_ts`, `media_type`, `media_sha`, `raw` | `raw` satisfies the `getMessage` contract. `transcript` is populated lazily. The surrogate integer key exists because FTS5 external content indexes by `rowid`; `(chat_id, id)` stays the logical key and is enforced by the unique index. |
| `messages_fts` | FTS5 external-content (`content='messages'`, `content_rowid='rowid'`) over `text` and `transcript` | Maintained by triggers on `messages`. Updates and deletes must issue the FTS5 `'delete'` command with the **old** column values before inserting the new row — external-content tables do not track their source automatically. |
| `contacts` | `id` PK, `phone_number`, `lid`, `name`, `notify`, `raw` | v7 shape: an `id` plus *either* `phoneNumber` or `lid`. |
| `reactions` | `(chat_id, message_id, sender_id)` PK, `emoji`, `ts` | A reaction is an event, not a message. Replaced on change, deleted on removal. |
| `auth_creds` | `key` PK, `value` | |
| `auth_keys` | `(type, id)` PK, `value` | `type` includes `lid-mapping`, `device-list`, `tctoken`. |
| `meta` | `key` PK, `value` | Schema version, first-connect timestamp, last-event timestamp. |

### Invariants

1. **Identity is normalized in `wa/jid.ts` and nowhere else.** WhatsApp emits both
   `1234@lid` and `33612345678@s.whatsapp.net` for the same person, and which one arrives
   depends on the event and the chat. Every write normalizes to a canonical id and records
   the mapping from `sock.signalRepository.lidMapping`. If this leaks into ingest or the
   tool layer, the store ends up holding one human as two contacts — the most likely quiet
   failure of this project.
2. **Sent messages take the inbound path.** `send.ts` returns the `WAMessage` Baileys
   produced and hands it to the same ingest function an incoming message goes through. One
   writer, one mapping.
3. **Edits and deletes are in-place tombstones,** not new rows: `edited_ts` / `deleted_ts`
   on the original. A deleted message keeps its row with text cleared, so threads stay
   coherent and FTS drops it.
4. **Every message reference is `(chat, message_id)`.** WhatsApp keys are unique only
   within a chat.
5. **Results carry resolved names.** A message row returns `sender: {id, name}` resolved
   through `contacts`; a bare `221355…@lid` is useless to a model.

## Tool surface — 14 tools

### Reads — available in every connection state, since they hit SQLite

| Tool | Input | Returns |
| --- | --- | --- |
| `wa_health` | — | Connection state, whether pairing is needed, seconds since last event, row counts, schema version. |
| `wa_chats_list` | name filter, group/DM, archived, unread, cursor | Chats, most recent first. |
| `wa_messages_list` | chat, sender, time window, from-me, cursor | Messages with resolved senders. |
| `wa_messages_search` | query, optional chat scope, cursor | FTS5 over text **and** transcripts; voice-note hits are labelled. |
| `wa_contacts_search` | query, cursor | Contacts. |
| `wa_groups_list` | cursor | Groups with participant counts. |

### Writes — hidden entirely in read-only mode; fail fast with the connection state named

| Tool | Input | Notes |
| --- | --- | --- |
| `wa_send_text` | chat, text, optional `reply_to` | The optional field *is* reply-with-quote. |
| `wa_send_file` | chat, `{path}` \| `{data: base64}`, caption, `reply_to`, `as_voice_note` | Replaces today's two send-file tools with one discriminated union. `as_voice_note` is why ffmpeg stays. |
| `wa_react` | chat, message, emoji | Empty string removes. |
| `wa_mark_read` | chat, up-to message | |
| `wa_edit_message` | chat, message, new text | Own messages only. |
| `wa_delete_message` | chat, message | For everyone; own messages only. |

### Media

| Tool | Behaviour |
| --- | --- |
| `wa_download_media` | Returns the message's media in a form the model can consume: image blocks for images, stickers and video keyframes; extracted text for PDFs; path plus metadata otherwise. For audio, returns a cached transcript if present, else duration and a pointer to `wa_transcribe`. |
| `wa_transcribe` | Explicit, model-callable. Works on voice notes, audio files, and a video's audio track. First call runs whisper.cpp; the result is written to `messages.transcript` and indexed into FTS. Subsequent calls are a table lookup. |

**No `wa_run` escape hatch.** With no CLI underneath, the honest equivalent is a raw
`sendMessage` passthrough — a footgun with no identified caller. Wanting it is the signal
to add a typed tool instead.

## Media pipeline

All of it lazy; nothing is downloaded or converted until a tool asks.

```
message row (raw) ──► download (Baileys, cached to WA_MEDIA_DIR by sha256)
                            │
        ┌───────────────────┼────────────────────┬──────────────┐
     image/sticker        video               audio/ptt      document
        │                   │                    │              │
   downscale          ffmpeg keyframes      ffmpeg → wav    pdf → text
   → image block      → N image blocks      → whisper.cpp   other → path
                      + audio track ────────►  → text        + metadata
                                              (cached)
```

1. **Caching is by content hash, in two layers.** Bytes land in `WA_MEDIA_DIR/<sha256>`;
   transcripts land in the `messages` row. WhatsApp media URLs expire, so re-downloading an
   old message can simply fail — the cache is what makes old media durable, not an
   optimization.
2. **Animated stickers** yield their first frame; static WebP passes through, which the
   Messages API accepts natively.
3. **Transcripts join the search index.** Because transcription is on demand, FTS coverage
   of voice notes grows with use. `wa_messages_search` queries text and transcripts in one
   statement.
4. **Model provisioning.** `WA_WHISPER_MODEL` defaults to `large-v3-turbo-q5_0`, fetched
   into the volume on first use rather than baked into the image. Changing model is a
   restart, not a rebuild.
5. **Packaging whisper.cpp.** Preferred: `COPY --from` the prebuilt `whisper-cli` binary
   out of the upstream whisper.cpp image, keeping a C++ toolchain out of our Dockerfile
   and the deployment at one container. *Unverified: that image's tag and internal layout
   were not confirmed during design.* Fallback is a compile stage. Either way it stays
   behind `media/transcribe.ts`, and if transcription is unavailable every other tool
   still works.

## Lifecycle and failure

**State machine** — `disconnected | connecting | pairing | connected | logged_out`, owned
by `wa/connection.ts`, the single source of truth for `/health` and for tool gating.

1. Reconnect on close with exponential backoff and jitter, with two explicit exceptions:
   `restartRequired` (expected immediately after pairing — recreate the socket, not a
   failure) and `loggedOut` (terminal — stop retrying, alert loudly; only re-pairing fixes
   it).
2. Read tools work in every state. Write tools fail fast with the state named, rather than
   hanging.
3. The pairing code is requested inside `connection.update` when no session exists, using
   `WA_PHONE_NUMBER`, and printed to stdout.

**Observability replaces the heartbeat file.** `/health` returns connection state, seconds
since last event, row counts and schema version, and is the Docker healthcheck. ntfy
alerting ports over from `sync-supervisor.ts` roughly intact — down-after-grace, periodic
re-alert, recovery notice, startup self-test — but driven by the state machine rather than
by polling a file another process wrote. The child-process supervision, lock-wait juggling
and self-heal valve delete outright: there is no child and no lock.

**Ban risk.** Baileys is an unofficial client and accounts are banned for automated
behaviour — v7 removed delivery ACKs specifically because of it. Mitigations: keep
`markOnlineOnConnect` off, present a plausible browser identity, and do not send at machine
speed.

## Configuration

| Var | Default | Meaning |
| --- | --- | --- |
| `WA_DATA_DIR` | `/data/wa` | SQLite file, auth state, whisper model. |
| `WA_MEDIA_DIR` | `${WA_DATA_DIR}/media` | Content-addressed media cache. |
| `WA_PHONE_NUMBER` | – | E.164 without `+`. Required for first pairing only. |
| `PORT` | `8080` | HTTP listen port. |
| `WA_MCP_TOKEN` | – | Bearer token required on `/mcp`. Unset disables the check, with a warning at boot. |
| `WA_MCP_READONLY` | – | `1` ⇒ hide every write tool. |
| `WA_WHISPER_MODEL` | `large-v3-turbo-q5_0` | Model name; fetched on first use. |
| `WA_WHISPER_THREADS` | cores − 1 | whisper.cpp thread count. |
| `WA_MAX_IMAGE_BYTES` | 5 MiB | Downscale threshold for returned images. |
| `WA_VIDEO_KEYFRAMES` | `4` | Keyframes extracted per video. |
| `WA_MCP_MAX_RESULT_CHARS` | `200000` | Cap on text returned to the model. |
| `NTFY_BASE_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` | – | Alert publishing, as today. |

Everything prefixed `WACLI_` is gone.

## Testing

Three layers, no live WhatsApp in CI, `node:test` throughout.

1. **Unit** — the parts with real logic and no I/O: `jid.ts` normalization (LID/PN pairs,
   group participants, self), ingest mappers driven by recorded Baileys event fixtures,
   send-argument builders, config parsing, cursor encoding.
2. **Integration** — a temp SQLite file; feed recorded fixtures through ingest, assert the
   resulting rows, then read back through the real tool handlers. Covers migrations and FTS
   behaviour across edits, deletes and transcript backfill.
3. **Contract** — an in-process MCP client against the server with a stubbed socket,
   asserting tool schemas and result shapes. Catches the schema drift that otherwise only
   appears in Claude.

A manual smoke script against a real paired store stays, as today.

## Deployment and cutover

1. The Portainer `mcp-servers` stack drops from two services to one.
2. The image goes from Go toolchain + CGO + ffmpeg + Node to `node:24-slim` + ffmpeg + a
   copied `whisper-cli`. No native npm modules: `node:sqlite` is built in.
3. New volume for the SQLite file and media cache. The old wacli store volume is left in
   place rather than deleted, so the cutover is reversible.
4. WhatsApp permits several linked devices, so the new server is paired **alongside** the
   running wacli deployment. The old stack is torn down only once the new one is trusted.

## Out of scope for v1

Group administration (create, membership, invite links, subject and description), polls,
status and stories, broadcast lists, message forwarding, location and contact cards,
presence broadcast and subscription, newsletters, and any migration of the existing wacli
message history.
