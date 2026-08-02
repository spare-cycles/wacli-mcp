# whatsapp-mcp

An [MCP](https://modelcontextprotocol.io) server that gives a language model a WhatsApp account.

One Node process holds one WhatsApp connection, using [Baileys](https://github.com/WhiskeySockets/Baileys) — a
TypeScript implementation of WhatsApp's multi-device protocol. Everything that arrives on that connection is written
straight into a local SQLite database with an FTS5 index; every tool that reads answers from that database, so the read
surface keeps working while the socket is down, reconnecting, or waiting to be paired. Only sends, and the first
download of a given attachment, need the connection to be live.

There is no second process, no CLI to shell out to, no store lock and no IPC. The only subprocesses are `ffmpeg`,
`ffprobe`, `pdftotext` and `whisper-cli`, each invoked on demand by the media pipeline.

The media pipeline is the reason this is more than a message log. An inbound attachment is not handed to the model as a
file path it cannot open: a photo comes back as an image block, downscaled to fit a context window; a video as evenly
spaced keyframes plus its duration; a PDF as extracted text; a voice note as a transcript, produced by whisper.cpp and
written back into the search index — so `whatsapp_messages_search` finds a message by what was *said* in it.

Transport is Streamable HTTP only, behind an optional bearer token.

## Tools

Fourteen tools, all `whatsapp_`-prefixed. The six write tools are not registered at all when `WHATSAPP_MCP_READONLY` is set — a
read-only deployment does not advertise them, so a model never sees an ability it does not have.

| Tool | What it does | Needs the connection |
| --- | --- | --- |
| `whatsapp_health` | Connection state, whether pairing is needed, seconds since the last socket event, row counts, schema version, whether transcription can run. | no |
| `whatsapp_chats_list` | Chats — direct and group — most recently active first, with unread counts, archive and mute state. Filterable by name, group flag, archived, unread. | no |
| `whatsapp_groups_list` | Group chats only, with participant counts. | no |
| `whatsapp_messages_list` | Stored messages, newest first — or oldest first with `asc`. Sender names resolved from contacts, reaction counts attached. | no |
| `whatsapp_messages_search` | Full-text search over message text *and* voice-note transcripts, best matches first. Each hit carries a snippet and `matched_transcript`. | no |
| `whatsapp_contacts_search` | Contacts by name, push name or phone number. | no |
| `whatsapp_download_media` | An attachment in a form a model can consume: image, video keyframes, cached transcript, PDF text, or a cached path. Downloads once, reuses the cached copy after. | first fetch only |
| `whatsapp_transcribe` | Transcribe a voice note or a video's audio with whisper, and store the transcript so search can find it. Instant on a second call. | first fetch only |
| `whatsapp_send_text` | Send a text message, optionally quoting an earlier one and @mentioning participants. | **yes** |
| `whatsapp_send_file` | Send an image, video, voice note or document — bytes as base64 in `data`, or a server-side file via `path` (see `WHATSAPP_SEND_FILE_DIR`). | **yes** |
| `whatsapp_react` | React with an emoji; an empty emoji removes the reaction. | **yes** |
| `whatsapp_mark_read` | Mark a chat read up to and including one message. | **yes** |
| `whatsapp_edit_message` | Replace the text of a message this account sent. | **yes** |
| `whatsapp_delete_message` | Revoke a message this account sent, for everyone. Irreversible. | **yes** |

**Narrowing a listing or a search.** `whatsapp_messages_list` and `whatsapp_messages_search` take the same filters — `chat`,
`sender`, `from_me`, `kind`, `has_media`, `after`, `before` — so "the photos Marie sent me in June" is one call
whether or not you have a word to search for. `kind` and `has_media` are refused when they contradict each other
(`kind: "text"` with `has_media: true`) rather than answered with an empty page, which would read as "there are none".

**Naming a recipient.** `whatsapp_send_text` and `whatsapp_send_file` accept a chat JID, a phone number written any usual way, or
a contact/group/chat name. A name matching several chats or contacts is **refused** with the matches listed and
numbered — never resolved by guessing — and re-sending with `pick` set to one of those numbers chooses. Every other
tool takes the JID it was given by a listing.

**Times and paging.** Every timestamp crossing the tool surface — `after`, `before`, and the `ts` on every row — is an
integer Unix second in UTC. A date string is a validation error rather than a silently different window. `limit` caps
at 200 and a listing that has more hands back an opaque `next_cursor`; walking that cursor is how you read a long
history, and the cursor is stable against messages arriving while you page.

Every tool result is capped at `WHATSAPP_MCP_MAX_RESULT_CHARS` — the JSON payloads and the free-text blocks alike, so a
transcript or a PDF's contents is bounded exactly as a page of messages is. Whatever is cut carries a note saying how
long the whole thing was and how much of it is above. Failures come back as an MCP error result naming what went wrong,
not as a transport error. A write attempted while the socket is down fails with the connection
state in the message, so a model can tell "retry in a moment" from "this will never work".

## Prerequisites

- **Node 24 or newer.** Not negotiable: storage is `node:sqlite`, which is still flagged experimental and has changed
  shape across majors. `engines.node` is `">=24"`.
- **pnpm 10.** Pinned in `package.json`'s `packageManager` field; `corepack enable` picks it up.
- **`ffmpeg` and `ffprobe`** on `PATH` — video keyframes, audio conversion, voice notes. Also needed to run the test
  suite, which builds its media fixtures with them.
- **`pdftotext`** (`poppler-utils`) — PDF text extraction. Its absence degrades one branch of `whatsapp_download_media`; the
  rest of the server is unaffected.
- **`whisper-cli`** (whisper.cpp) — transcription only. Point `WHATSAPP_WHISPER_BIN` at it. Without it, `whatsapp_transcribe` fails
  and `whatsapp_health` reports `transcription_available: false`; nothing else changes.

The Docker image ships all four. Locally, `apt install ffmpeg poppler-utils` covers everything but whisper.

## First run: pairing

The server pairs **by code, not by QR**. It never renders a QR — a QR in a container log is a live credential anyone
reading the log can use, so the code path is the only one implemented (`src/whatsapp/connection.ts`, `handleQr` and
`requestPairingCode`).

1. Set `WHATSAPP_PHONE_NUMBER` to the account's number in E.164 **digits only, no leading `+`** — e.g. `33612345678`.
   Validated at boot: 8–15 digits, no leading zero, or the process exits with a `ConfigError`.
2. Start the server against an empty `WHATSAPP_DATA_DIR`. It reaches the `pairing` state and logs an eight-character pairing
   code — Crockford base32, so no `0`, `I`, `O` or `U` and no separator — both as a structured log line and as a plain
   banner on stdout so it survives a log tail:

   ```
   === WhatsApp pairing code: 7KQ2XMR9 ===
   ```

3. On the phone: **WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead**, and enter
   the code. WhatsApp's own entry field shows it in two groups of four; type the eight characters as logged. Codes
   expire; if you miss one, the socket rotates and a new code is issued on the next attempt.
4. `whatsapp_health` flips to `connection: "connected"`, and WhatsApp starts pushing history. Contacts, chats and messages
   land in SQLite as they arrive.

Leaving `WHATSAPP_PHONE_NUMBER` unset is not a silent failure: the server logs, once per socket, that pairing requires it,
and sits in `pairing` until it is configured.

Credentials live in the database under `WHATSAPP_DATA_DIR`, so **the volume is the account**. Back it up, and be aware that
deleting it means re-pairing. `whatsapp_health` reporting `ok: false` means exactly one thing: WhatsApp logged the device out
and a human has to re-pair it.

## Configuration

Every variable is optional except where noted. Invalid numbers fall back to the default rather than failing the boot;
`WHATSAPP_PHONE_NUMBER` is the one exception and throws. All of this is one function — `loadConfig` in `src/config.ts`.

| Variable | Default | What it does |
| --- | --- | --- |
| `WHATSAPP_DATA_DIR` | `/data/whatsapp` | The state directory. Holds `whatsapp.db` (store + credentials), `models/` (the whisper model) and `tmp/`. |
| `WHATSAPP_MEDIA_DIR` | `$WHATSAPP_DATA_DIR/media` | The content-addressed attachment cache. See the note on eviction below. |
| `WHATSAPP_PHONE_NUMBER` | — | The account's number, E.164 digits without `+`. Required to pair; ignored once paired. Rejected at boot if malformed. |
| `PORT` | `8080` | HTTP listen port, clamped to `[1, 65535]`. Binds `0.0.0.0`. |
| `MCP_HTTP_PATH` | `/mcp` | Path the MCP endpoint is mounted on. `/health` is always at `/health` and always public. |
| `WHATSAPP_MCP_TOKEN` | — | Bearer token guarding the MCP path. **Unset means the endpoint is unauthenticated**, which the server warns about once at boot. Compared in constant time; never logged, never echoed in a refusal. |
| `WHATSAPP_MCP_READONLY` | off | `1`/`true`/`yes`/`on` unregisters the six write tools. The media tools stay: neither changes anything on WhatsApp. |
| `WHATSAPP_WHISPER_BIN` | `whisper-cli` | Path to the whisper.cpp binary. |
| `WHATSAPP_WHISPER_MODEL` | `large-v3-turbo-q5_0` | Model name. Fetched once, lazily, from Hugging Face into `$WHATSAPP_DATA_DIR/models/ggml-<model>.bin` — 574 MB for the default. |
| `WHATSAPP_WHISPER_THREADS` | CPUs − 1 (min 1) | Threads passed to whisper, clamped to the CPU count. |
| `WHATSAPP_WHISPER_MAX_SECONDS` | `900` | Recordings longer than this are refused rather than transcribed. Clamped to `[1, 14400]`. |
| `WHATSAPP_MAX_IMAGE_BYTES` | 5 MiB | Budget for an image block returned to the model; larger images are downscaled to fit. Clamped to `[1, 100 MiB]`. |
| `WHATSAPP_MAX_UPLOAD_BYTES` | 64 MiB | Largest file `whatsapp_send_file` will send, whichever way the bytes arrived. Clamped to `[1, 256 MiB]`. It also sizes the HTTP body limit, which is this value plus base64 overhead plus 1 MiB of envelope — so raising it raises what an authenticated client may POST. |
| `WHATSAPP_SEND_FILE_DIR` | — | The **one** directory `whatsapp_send_file`'s `path` argument may resolve inside. Unset disables `path` entirely, which is the default and the right one: a container serving a remote client has no legitimate caller for a server-side path, and left open, `path` is an arbitrary-file-read primitive that would hand `/proc/self/environ` — every secret in the process environment — to a WhatsApp conversation. When set, paths are resolved through symlinks and confined to it; a refusal never echoes the path it was asked to read. |
| `WHATSAPP_VIDEO_KEYFRAMES` | `4` | Frames extracted per video, evenly spaced. Clamped to `[1, 16]`. |
| `WHATSAPP_MCP_MAX_RESULT_CHARS` | `200000` | Every tool payload longer than this is truncated with a note naming the full length — JSON results, transcripts and extracted PDF text alike. Clamped to `[1000, 50000000]`. |
| `NTFY_BASE_URL` | — | ntfy server for connection alerts. Alerting is all-or-nothing: it is off unless both this and `NTFY_TOPIC` are set. |
| `NTFY_TOPIC` | — | The **incident** topic: disconnection, waiting-to-be-paired, logged-out, and the recovery that closes one of those. Recovery is deliberately not routed elsewhere — an operator who sees the alarm on this topic has to see the all-clear on it too. |
| `NTFY_TOPIC_INFO` | `NTFY_TOPIC` | The **routine** topic, for traffic that is not a problem: today, the startup self-test. Optional; unset, routine notices join the incident topic, which is the single-topic behaviour that predates the split. Setting it can only ever move traffic off the incident topic, never silence it. |
| `NTFY_TOKEN` | — | Bearer token for ntfy, if the server needs one. Travels in a header and appears in no log line. **A token the server does not recognise fails silently:** every publish is a `warn` and nothing more, by design — an alerting failure must never take the WhatsApp socket down — so a wrong token means no alert will ever arrive and nothing will say so except `alerts: ntfy publish rejected` in the log. The startup self-test exists to put that line where it can be found on boot rather than during the first real incident. |
| `LOG_LEVEL` | `info` | pino level for every log line the process writes: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. Read in `src/logger.ts`, not through `loadConfig`, so it is the one variable here that is not part of `Config`. **`trace` and `debug` are not safe to leave on.** The same logger is handed to Baileys, which logs raw stanzas at those levels — including the pairing `ref`, which is a live credential. Turn them on to debug, then turn them back off. |

Alerting debounces on purpose: a dropped socket must stay down for a grace period before anyone is paged, re-alerts on
a cadence while still down, and announces recovery only if a down alert actually went out. `logged_out` skips the grace
and goes out immediately — no backoff recovers it.

`WHATSAPP_MCP_TOKEN` and `NTFY_TOKEN` never appear in a log line, an error message, or the `/health` response. `/health`
returns a closed record built in `src/mcp/health.ts` rather than a spread of the config, so a new config field can
never widen it by accident.

**`last_event_age_sec` and `last_message_at` measure different things, and only the second one detects a frozen
store.** `last_event_age_sec` is the age of the last `connection.update` — the socket's opinion of itself — so it stays
small on a connection that is answering while receiving nothing. `last_message_at` is `MAX(ts)` over the store, the one
value that separates "healthy and quiet" from "connected and ingesting nothing". Nothing inside the server decides
which of those it is, because *quiet* is a property of the conversation and not of the server; that judgement belongs
to a watchdog outside the process, with its own clock and its own threshold. `/health` answers `200` in every
connection state, so a probe pointed at it detects a dead HTTP server and nothing more — deliberately, since read
tools keep working while disconnected and a reconnect must not flap the container.

## Running it

```bash
pnpm install
pnpm dev                      # tsx, no build step
pnpm build && pnpm start      # compiled
```

Two endpoints:

```
POST/GET/DELETE  http://0.0.0.0:8080/mcp     Streamable HTTP MCP, one session per Mcp-Session-Id
GET              http://0.0.0.0:8080/health  public, unauthenticated, JSON
```

Sessions are created on `initialize` and swept after 30 minutes idle. `/health` sits in front of the bearer gate
deliberately — a container healthcheck that needs the secret is a secret in the compose file.

## Docker

The image is `node:24-slim` plus ffmpeg, poppler-utils, and whisper.cpp binaries copied out of
`ghcr.io/ggml-org/whisper.cpp` (pinned by digest). There is no compiler in the build. **amd64 only**, because that
upstream image publishes no other architecture.

```bash
docker build -t whatsapp-mcp:latest .

docker run -d --name whatsapp-mcp -p 8080:8080 \
  -v whatsapp-data:/data/whatsapp \
  -e WHATSAPP_PHONE_NUMBER=33612345678 \
  -e WHATSAPP_MCP_TOKEN="$(openssl rand -hex 32)" \
  whatsapp-mcp:latest

docker logs -f whatsapp-mcp          # watch for the pairing code on the first run
```

The image sets `WHATSAPP_DATA_DIR=/data/whatsapp`, `WHATSAPP_WHISPER_BIN=/opt/whisper/bin/whisper-cli`, `PORT=8080` and
`LD_LIBRARY_PATH=/opt/whisper/bin` — that last one is load-bearing: `whisper-cli` is dynamically linked against
`libwhisper.so` and three `libggml*.so` that live beside it. It runs as the unprivileged `node` user, so a bind mount
in place of the named volume must be writable by uid 1000. A `HEALTHCHECK` polls `/health` and fails only on a
logged-out account.

The first `whatsapp_transcribe` in a fresh container downloads the 574 MB model into the volume. It is worth doing once,
deliberately, rather than discovering it under a user's request.

## Quality gate

```bash
pnpm check     # prettier --check, eslint, tsc --noEmit
pnpm test      # node:test via tsx
pnpm build     # tsc -> dist/
```

`pnpm check` is `format:check && lint && typecheck`, and all three must be silent. The TypeScript config is the full
strict set — `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`,
`verbatimModuleSyntax` and the rest — and ESLint runs `strictTypeChecked` + `stylisticTypeChecked` with zero tolerance
for warnings. Do not weaken a compiler option to make code compile.

CI (`.github/workflows/ci.yml`) runs the same gate on every pull request, on Node 24, installing ffmpeg between `check`
and `test`. `.github/workflows/docker.yml` re-runs it as a `check` job and gates the image build on it with
`needs: check`, so nothing red is ever tagged `:latest`.

## Testing

Tests are `node:test`, run through `tsx`, and live beside their subject as `src/**/*.test.ts`. No test framework is
installed. Media tests are not mocked at the boundary that matters: they build real PNG, WebP and MP4 fixtures with
ffmpeg and convert them back, because a stubbed converter only ever asserts the stub.

```bash
pnpm test                                              # everything
node --import tsx --test src/whatsapp/ingest.test.ts         # one file
```

What the suite structurally cannot cover is the wiring end to end, and whisper. That is `smoke.mjs`:

```bash
node smoke.mjs                                         # health, session, 14 tools, whatsapp_chats_list
node smoke.mjs --transcribe <chatJid> <messageId>      # ... and a real transcription
```

It runs against a **running server with a paired store** — a real account, real chats, real media — which no CI runner
has and no fixture can fake, so it is manual by design and excluded from the lint and type gates. `--transcribe` is the
only exercise whisper and the model download ever get; run it after any change to the image.

## Two things to know

**Baileys is an unofficial client, and using it carries a real ban risk.** It is a clean-room reimplementation of
WhatsApp's multi-device protocol, not an API Meta offers, supports or condones. Meta bans accounts for automated
behaviour, and the traffic pattern of a language model driving an account — bursts of sends, messages to people who
never messaged you, unusual timing — is exactly what that detection looks for. Nothing here rate-limits on your behalf.
Use an account you can afford to lose, keep the volume human, and do not point it at strangers. A ban takes the number
with it, not just this server.

**The media cache is never evicted.** `WHATSAPP_MEDIA_DIR` holds one file per distinct attachment, named by the sha256 of its
bytes, and nothing ever deletes one. That is a deliberate v1 scope decision, not an oversight — the alternative is an
eviction policy that has to reason about which cached transcript is still referenced by the search index — but it means
the directory grows monotonically with every attachment ever read, and a chat full of videos will grow it fast. There
is no configured ceiling and no alert when the volume fills. Watch it, and empty it by hand when you need to: every
file in it is re-derivable from WhatsApp, so deleting the lot costs nothing but a re-download, and transcripts already
in the database survive.
