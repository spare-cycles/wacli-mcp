# wa-mcp

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
written back into the search index — so `wa_messages_search` finds a message by what was *said* in it.

Transport is Streamable HTTP only, behind an optional bearer token.

## Tools

Fourteen tools, all `wa_`-prefixed. The six write tools are not registered at all when `WA_MCP_READONLY` is set — a
read-only deployment does not advertise them, so a model never sees an ability it does not have.

| Tool | What it does | Needs the connection |
| --- | --- | --- |
| `wa_health` | Connection state, whether pairing is needed, seconds since the last socket event, row counts, schema version, whether transcription can run. | no |
| `wa_chats_list` | Chats — direct and group — most recently active first, with unread counts, archive and mute state. Filterable by name, group flag, archived, unread. | no |
| `wa_groups_list` | Group chats only, with participant counts. | no |
| `wa_messages_list` | Stored messages, newest first, sender names resolved from contacts, reaction counts attached. Filterable by chat, sender, direction and time window. | no |
| `wa_messages_search` | Full-text search over message text *and* voice-note transcripts, best matches first. Each hit carries a snippet and `matched_transcript`. | no |
| `wa_contacts_search` | Contacts by name, push name or phone number. | no |
| `wa_download_media` | An attachment in a form a model can consume: image, video keyframes, cached transcript, PDF text, or a cached path. Downloads once, reuses the cached copy after. | first fetch only |
| `wa_transcribe` | Transcribe a voice note or a video's audio with whisper, and store the transcript so search can find it. Instant on a second call. | first fetch only |
| `wa_send_text` | Send a text message, optionally quoting an earlier one. | **yes** |
| `wa_send_file` | Send an image, video, voice note or document — bytes as base64 in `data`, or a server-side file via `path` (see `WA_SEND_FILE_DIR`). | **yes** |
| `wa_react` | React with an emoji; an empty emoji removes the reaction. | **yes** |
| `wa_mark_read` | Mark a chat read up to and including one message. | **yes** |
| `wa_edit_message` | Replace the text of a message this account sent. | **yes** |
| `wa_delete_message` | Revoke a message this account sent, for everyone. Irreversible. | **yes** |

Every tool returns a JSON result, truncated at `WA_MCP_MAX_RESULT_CHARS`; failures come back as an MCP error result
naming what went wrong, not as a transport error. A write attempted while the socket is down fails with the connection
state in the message, so a model can tell "retry in a moment" from "this will never work".

## Prerequisites

- **Node 24 or newer.** Not negotiable: storage is `node:sqlite`, which is still flagged experimental and has changed
  shape across majors. `engines.node` is `">=24"`.
- **pnpm 10.** Pinned in `package.json`'s `packageManager` field; `corepack enable` picks it up.
- **`ffmpeg` and `ffprobe`** on `PATH` — video keyframes, audio conversion, voice notes. Also needed to run the test
  suite, which builds its media fixtures with them.
- **`pdftotext`** (`poppler-utils`) — PDF text extraction. Its absence degrades one branch of `wa_download_media`; the
  rest of the server is unaffected.
- **`whisper-cli`** (whisper.cpp) — transcription only. Point `WA_WHISPER_BIN` at it. Without it, `wa_transcribe` fails
  and `wa_health` reports `transcription_available: false`; nothing else changes.

The Docker image ships all four. Locally, `apt install ffmpeg poppler-utils` covers everything but whisper.

## First run: pairing

The server pairs **by code, not by QR**. It never renders a QR — a QR in a container log is a live credential anyone
reading the log can use, so the code path is the only one implemented (`src/wa/connection.ts`, `handleQr` and
`requestPairingCode`).

1. Set `WA_PHONE_NUMBER` to the account's number in E.164 **digits only, no leading `+`** — e.g. `33612345678`.
   Validated at boot: 8–15 digits, no leading zero, or the process exits with a `ConfigError`.
2. Start the server against an empty `WA_DATA_DIR`. It reaches the `pairing` state and logs an eight-character pairing
   code — Crockford base32, so no `0`, `I`, `O` or `U` and no separator — both as a structured log line and as a plain
   banner on stdout so it survives a log tail:

   ```
   === WhatsApp pairing code: 7KQ2XMR9 ===
   ```

3. On the phone: **WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead**, and enter
   the code. WhatsApp's own entry field shows it in two groups of four; type the eight characters as logged. Codes
   expire; if you miss one, the socket rotates and a new code is issued on the next attempt.
4. `wa_health` flips to `connection: "connected"`, and WhatsApp starts pushing history. Contacts, chats and messages
   land in SQLite as they arrive.

Leaving `WA_PHONE_NUMBER` unset is not a silent failure: the server logs, once per socket, that pairing requires it,
and sits in `pairing` until it is configured.

Credentials live in the database under `WA_DATA_DIR`, so **the volume is the account**. Back it up, and be aware that
deleting it means re-pairing. `wa_health` reporting `ok: false` means exactly one thing: WhatsApp logged the device out
and a human has to re-pair it.

## Configuration

Every variable is optional except where noted. Invalid numbers fall back to the default rather than failing the boot;
`WA_PHONE_NUMBER` is the one exception and throws. All of this is one function — `loadConfig` in `src/config.ts`.

| Variable | Default | What it does |
| --- | --- | --- |
| `WA_DATA_DIR` | `/data/wa` | The state directory. Holds `wa.db` (store + credentials), `models/` (the whisper model) and `tmp/`. |
| `WA_MEDIA_DIR` | `$WA_DATA_DIR/media` | The content-addressed attachment cache. See the note on eviction below. |
| `WA_PHONE_NUMBER` | — | The account's number, E.164 digits without `+`. Required to pair; ignored once paired. Rejected at boot if malformed. |
| `PORT` | `8080` | HTTP listen port, clamped to `[1, 65535]`. Binds `0.0.0.0`. |
| `MCP_HTTP_PATH` | `/mcp` | Path the MCP endpoint is mounted on. `/health` is always at `/health` and always public. |
| `WA_MCP_TOKEN` | — | Bearer token guarding the MCP path. **Unset means the endpoint is unauthenticated**, which the server warns about once at boot. Compared in constant time; never logged, never echoed in a refusal. |
| `WA_MCP_READONLY` | off | `1`/`true`/`yes`/`on` unregisters the six write tools. The media tools stay: neither changes anything on WhatsApp. |
| `WA_WHISPER_BIN` | `whisper-cli` | Path to the whisper.cpp binary. |
| `WA_WHISPER_MODEL` | `large-v3-turbo-q5_0` | Model name. Fetched once, lazily, from Hugging Face into `$WA_DATA_DIR/models/ggml-<model>.bin` — 574 MB for the default. |
| `WA_WHISPER_THREADS` | CPUs − 1 (min 1) | Threads passed to whisper, clamped to the CPU count. |
| `WA_WHISPER_MAX_SECONDS` | `900` | Recordings longer than this are refused rather than transcribed. Clamped to `[1, 14400]`. |
| `WA_MAX_IMAGE_BYTES` | 5 MiB | Budget for an image block returned to the model; larger images are downscaled to fit. Clamped to `[1, 100 MiB]`. |
| `WA_MAX_UPLOAD_BYTES` | 64 MiB | Largest file `wa_send_file` will send, whichever way the bytes arrived. Clamped to `[1, 256 MiB]`. It also sizes the HTTP body limit, which is this value plus base64 overhead plus 1 MiB of envelope — so raising it raises what an authenticated client may POST. |
| `WA_SEND_FILE_DIR` | — | The **one** directory `wa_send_file`'s `path` argument may resolve inside. Unset disables `path` entirely, which is the default and the right one: a container serving a remote client has no legitimate caller for a server-side path, and left open, `path` is an arbitrary-file-read primitive that would hand `/proc/self/environ` — every secret in the process environment — to a WhatsApp conversation. When set, paths are resolved through symlinks and confined to it; a refusal never echoes the path it was asked to read. |
| `WA_VIDEO_KEYFRAMES` | `4` | Frames extracted per video, evenly spaced. Clamped to `[1, 16]`. |
| `WA_MCP_MAX_RESULT_CHARS` | `200000` | Tool results longer than this are truncated with a marker. Clamped to `[1000, 50000000]`. |
| `NTFY_BASE_URL` | — | ntfy server for connection alerts. Alerting is all-or-nothing: it is off unless both this and `NTFY_TOPIC` are set. |
| `NTFY_TOPIC` | — | ntfy topic to publish to. |
| `NTFY_TOKEN` | — | Bearer token for ntfy, if the server needs one. Travels in a header and appears in no log line. |

Alerting debounces on purpose: a dropped socket must stay down for a grace period before anyone is paged, re-alerts on
a cadence while still down, and announces recovery only if a down alert actually went out. `logged_out` skips the grace
and goes out immediately — no backoff recovers it.

`WA_MCP_TOKEN` and `NTFY_TOKEN` never appear in a log line, an error message, or the `/health` response. `/health`
returns a closed record built in `src/mcp/health.ts` rather than a spread of the config, so a new config field can
never widen it by accident.

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
docker build -t wa-mcp:latest .

docker run -d --name wa-mcp -p 8080:8080 \
  -v wa-data:/data/wa \
  -e WA_PHONE_NUMBER=33612345678 \
  -e WA_MCP_TOKEN="$(openssl rand -hex 32)" \
  wa-mcp:latest

docker logs -f wa-mcp          # watch for the pairing code on the first run
```

The image sets `WA_DATA_DIR=/data/wa`, `WA_WHISPER_BIN=/opt/whisper/bin/whisper-cli`, `PORT=8080` and
`LD_LIBRARY_PATH=/opt/whisper/bin` — that last one is load-bearing: `whisper-cli` is dynamically linked against
`libwhisper.so` and three `libggml*.so` that live beside it. It runs as the unprivileged `node` user, so a bind mount
in place of the named volume must be writable by uid 1000. A `HEALTHCHECK` polls `/health` and fails only on a
logged-out account.

The first `wa_transcribe` in a fresh container downloads the 574 MB model into the volume. It is worth doing once,
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
node --import tsx --test src/wa/ingest.test.ts         # one file
```

What the suite structurally cannot cover is the wiring end to end, and whisper. That is `smoke.mjs`:

```bash
node smoke.mjs                                         # health, session, 14 tools, wa_chats_list
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

**The media cache is never evicted.** `WA_MEDIA_DIR` holds one file per distinct attachment, named by the sha256 of its
bytes, and nothing ever deletes one. That is a deliberate v1 scope decision, not an oversight — the alternative is an
eviction policy that has to reason about which cached transcript is still referenced by the search index — but it means
the directory grows monotonically with every attachment ever read, and a chat full of videos will grow it fast. There
is no configured ceiling and no alert when the volume fills. Watch it, and empty it by hand when you need to: every
file in it is re-derivable from WhatsApp, so deleting the lot costs nothing but a re-download, and transcripts already
in the database survive.
