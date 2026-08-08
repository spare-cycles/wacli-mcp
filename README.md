# whatsapp-mcp

An [MCP](https://modelcontextprotocol.io) server that gives a language model a WhatsApp account.

It is **two processes**, and they are not interchangeable.

**`whatsapp-api`** holds the account. One Node process, one WhatsApp connection, using
[Baileys](https://github.com/WhiskeySockets/Baileys) — a TypeScript implementation of WhatsApp's multi-device protocol.
Everything that arrives on that connection is written straight into a local SQLite database (`node:sqlite`) with an FTS5
index, and the media pipeline lives here too. It exposes 24 REST routes, 22 of them under `/v1` behind a bearer token.
It is **stateful**: the volume it mounts *is* the WhatsApp account.

**`whatsapp-mcp`** is the MCP server. It turns tool calls into HTTP requests against `whatsapp-api` and does nothing
else — no Baileys, no SQLite, no ffmpeg, no volume. It is **stateless**: losing it costs a reconnect and nothing more.

Between them sits **`whatsapp-api-sdk`**: one Zod route table both sides compile against, `implement()` on the server
side, `createClient()` on the consumer side, and a closed error taxonomy. It is the only thing keeping two separately
deployed processes in agreement about the wire.

The media pipeline is the reason this is more than a message log. An inbound attachment is not handed to the model as a
file path it cannot open: a photo comes back as an image block, downscaled to fit a context window; a video as evenly
spaced keyframes plus its duration; a PDF as extracted text; a voice note as a transcript, produced on a remote GPU and
written back into the search index — so `whatsapp_messages_search` finds a message by what was *said* in it.

Both processes speak Streamable HTTP / REST only, each behind its own optional bearer token. The only subprocesses
anywhere are `ffmpeg`, `ffprobe` and `pdftotext`, all invoked by the API, plus a remote GPU endpoint for transcription.

## Tools

Fourteen tools, all `whatsapp_`-prefixed. The six write tools are not registered at all when the API reports a
read-only deployment — the MCP asks `GET /v1/capabilities` when a session opens and skips `registerWriteTools` — so a
read-only deployment does not advertise them and a model never sees an ability it does not have.

| Tool | What it does | Needs the WhatsApp connection |
| --- | --- | --- |
| `whatsapp_health` | Connection state, whether pairing is needed, seconds since the last socket event, row counts, schema version, whether transcription can run. | no |
| `whatsapp_chats_list` | Chats — direct and group — most recently active first, with unread counts, archive and mute state. Filterable by name, group flag, archived, unread. | no |
| `whatsapp_groups_list` | Group chats only, with participant counts. | no |
| `whatsapp_messages_list` | Stored messages, newest first — or oldest first with `asc`. Sender names resolved from contacts, reaction counts attached. | no |
| `whatsapp_messages_search` | Full-text search over message text *and* voice-note transcripts, best matches first. Each hit carries a snippet and `matched_transcript`. | no |
| `whatsapp_contacts_search` | Contacts by name, push name or phone number. | no |
| `whatsapp_download_media` | An attachment in a form a model can consume: image, video keyframes, cached transcript, PDF text, or a download link. Downloads once, reuses the cached copy after. | first fetch only |
| `whatsapp_transcribe` | Transcribe a voice note or a video's audio on a GPU endpoint, and store the transcript so search can find it. Instant on a second call — and usually on the first, since notes are transcribed as they arrive. | first fetch only |
| `whatsapp_send_text` | Send a text message, optionally quoting an earlier one and @mentioning participants. | **yes** |
| `whatsapp_send_file` | Send an image, video, voice note or document — bytes as base64 in `data`, or a file on the API host via `path` (see `WHATSAPP_SEND_FILE_DIR`). | **yes** |
| `whatsapp_react` | React with an emoji; an empty emoji removes the reaction. | **yes** |
| `whatsapp_mark_read` | Mark a chat read up to and including one message. | **yes** |
| `whatsapp_edit_message` | Replace the text of a message this account sent. | **yes** |
| `whatsapp_delete_message` | Revoke a message this account sent, for everyone. Irreversible. | **yes** |

**The split changed three things a caller can see, and nothing else.** Same fourteen names, same input schemas, same
output JSON everywhere they are not listed here:

1. **`whatsapp_download_media`'s document branch returns a link, not a path.** It used to report a `path` into the
   server's media cache. It now reports a `url` — the API's signed download link, resolved against
   `WHATSAPP_API_URL` (`packages/mcp/src/tools/media.ts`). PDF text extraction is unchanged and still inline. ⚠️ The
   link points at the **API's** address as the MCP knows it: under the shipped `docker-compose.yml` that is
   `http://api:8080/media/dl/…`, reachable from inside the compose network and nowhere else. Publish the API's port
   and set `WHATSAPP_API_URL` to an address the link's consumer can reach, or treat the field as an identifier rather
   than something to click.
2. **`whatsapp_health` gained an `api` block.** The API's own report is passed through byte for byte — `ok` still means
   only "the account has not been logged out" — with one object appended: `api: { reachable, latencyMs, url, error }`.
   `reachable` is false only for a genuine transport failure; a 401 or a 500 means the API is there and something else
   is wrong. `url` has any userinfo stripped, so it can never carry a password.
3. **`WHATSAPP_SEND_FILE_DIR` names a directory on the API host.** `whatsapp_send_file`'s `path` argument is forwarded
   verbatim and resolved by the API, against the API's filesystem. A path that exists next to the MCP container is not
   a path this reads.

**Narrowing a listing or a search.** `whatsapp_messages_list` and `whatsapp_messages_search` take the same filters —
`chat`, `sender`, `from_me`, `kind`, `has_media`, `after`, `before` — so "the photos Marie sent me in June" is one call
whether or not you have a word to search for. `kind` and `has_media` are refused when they contradict each other
(`kind: "text"` with `has_media: true`) rather than answered with an empty page, which would read as "there are none".

**Naming a recipient.** `whatsapp_send_text` and `whatsapp_send_file` accept a chat JID, a phone number written any
usual way, or a contact/group/chat name. A name matching several chats or contacts is **refused** with the matches
listed and numbered — never resolved by guessing — and re-sending with `pick` set to one of those numbers chooses.
Every other tool takes the JID it was given by a listing, which it treats as an opaque string: all JID interpretation
happens inside the API.

**Times and paging.** Every timestamp crossing the tool surface — `after`, `before`, and the `ts` on every row — is an
integer Unix second in UTC. A date string is a validation error rather than a silently different window. `limit` caps
at 200 and a listing that has more hands back an opaque `next_cursor`; walking that cursor is how you read a long
history, and the cursor is stable against messages arriving while you page.

Every tool result is capped at `WHATSAPP_MCP_MAX_RESULT_CHARS` — the JSON payloads and the free-text blocks alike, so a
transcript or a PDF's contents is bounded exactly as a page of messages is. Whatever is cut carries a note saying how
long the whole thing was and how much of it is above. Failures come back as an MCP error result naming what went wrong,
not as a transport error. A write attempted while the socket is down fails with the connection state in the message,
so a model can tell "retry in a moment" from "this will never work".

### The failure mode the split adds

**A read tool now needs the API to be reachable.** In one process, every read answered from local SQLite and therefore
worked in every connection state — disconnected, reconnecting, waiting to be paired. That guarantee is now the *API's*,
not the MCP's: the tool descriptions still say a read "answers offline, while the WhatsApp connection is down", and
that stays true of the process holding the store. What is new is the hop in front of it.

When that hop fails — DNS, connection refused, a TLS reject, a timeout, a truncated response — the SDK raises
`ApiUnreachableError`, code `api_unreachable`, message `could not reach the API at <url>`. It is a first-class member
of the error taxonomy and the only one the API never sends, because it describes a state in which the API said nothing
at all (`packages/sdk/src/client.ts`, `packages/sdk/src/errors.ts`). A 401, a 500 or an unparseable body is *not*
`api_unreachable`: those mean the API answered, and they point at the API's logs rather than at the network.

Practically: an API that is down fails reads that used to succeed. `whatsapp_health` still answers — the merged report
degrades to `{ ok: false, api }` with no invented fields — and the MCP container's own `/health` reports `ok: false`,
so an orchestrator restarts it. Nothing else in the MCP alerts, because alerting lives in the API; `api.reachable` is
there so an external watchdog can see the condition.

## Prerequisites

- **Node 24 or newer.** Not negotiable: the API's storage is `node:sqlite`, which is still flagged experimental and has
  changed shape across majors. `engines.node` is `">=24"` in every package.
- **pnpm 10.** Pinned in the root `package.json`'s `packageManager` field; `corepack enable` picks it up.
- **`ffmpeg` and `ffprobe`** on `PATH` — **for the API only**. Video keyframes, audio conversion, voice notes. Also
  needed to run the test suite, which builds its media fixtures with them.
- **`pdftotext`** (`poppler-utils`) — the API only. PDF text extraction. Its absence degrades one branch of
  `whatsapp_download_media`; the rest is unaffected.
- **A transcription endpoint** — the API only. Transcription runs on a **RunPod serverless GPU** (Voxtral Small 24B on
  vLLM, see [`spare-cycles/transcribe-worker`](https://github.com/spare-cycles/transcribe-worker)), with Mistral's
  hosted API as a fallback. Set `WHATSAPP_RUNPOD_ENDPOINT_ID` + `RUNPOD_API_KEY`, and/or `MISTRAL_API_KEY`. With
  neither, `whatsapp_transcribe` fails and `whatsapp_health` reports `transcription_available: false`; nothing else
  changes.

The MCP image has no `apt-get` line at all, and that absence is the point: it transcodes nothing, reads no PDF and
opens no database. The API image ships ffmpeg and poppler-utils. Locally, `apt install ffmpeg poppler-utils` covers
both.

⚠️ **whisper.cpp is gone.** It ran in-process against a 574 MB model on a machine with no GPU — minutes of CPU per
recording — and left with the `WHATSAPP_WHISPER_BIN` / `_MODEL` / `_THREADS` variables and the `models/` directory.
Only `WHATSAPP_WHISPER_MAX_SECONDS` survives, as a deprecated alias for `WHATSAPP_TRANSCRIBE_MAX_SECONDS`.

## Quickstart

There is no single-container option. Two containers, one volume, one shared secret:

```bash
export WHATSAPP_API_TOKEN=$(openssl rand -hex 32)   # MCP -> API. Unset and every /v1 route answers 401.
export WHATSAPP_MCP_TOKEN=$(openssl rand -hex 32)   # client -> MCP. Unset and the MCP path is open.
export WHATSAPP_PHONE_NUMBER=33612345678            # E.164 digits, no leading +

docker compose up -d
docker compose logs -f api        # the first run prints a pairing code
```

Then point an MCP client at `http://localhost:8081/mcp` with `Authorization: Bearer $WHATSAPP_MCP_TOKEN`.

`docker-compose.yml` publishes only the MCP, on 8081. The API is the privileged half — it holds the account, the store
and the media cache — so it is reachable on the compose network and nowhere else, and the MCP waits on its
`service_healthy` before starting, because a session opens with a `GET /v1/capabilities` and starting against an API
that is not yet listening turns the first tool call into a confusing failure instead of a wait.

`WHATSAPP_API_TOKEN` is the pair that authenticates MCP → API. It is the same string in both services, on purpose, and
the API **fails closed**: unset, every `/v1` route answers 401 and the boot logs a warning saying so. `/health` stays
public on both.

## First run: pairing

Pairing is the **API's**, not the MCP's. Nothing about it involves the MCP container, and an MCP restart cannot affect
an established pairing.

The API pairs **by code, not by QR**. It never renders a QR — a QR in a container log is a live credential anyone
reading the log can use, so the code path is the only one implemented (`packages/api/src/whatsapp/connection.ts`,
`handleQr` and `requestPairingCode`).

1. Set `WHATSAPP_PHONE_NUMBER` on the **api** service, to the account's number in E.164 **digits only, no leading `+`**
   — e.g. `33612345678`. Validated at boot: 8–15 digits, no leading zero, or the process exits with a `ConfigError`.
2. Start the API against an empty `WHATSAPP_DATA_DIR`. It reaches the `pairing` state and logs an eight-character
   pairing code — Crockford base32, so no `0`, `I`, `O` or `U` and no separator — both as a structured log line and as
   a plain banner on stdout so it survives a log tail:

   ```
   === WhatsApp pairing code: 7KQ2XMR9 ===
   ```

3. On the phone: **WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead**, and enter
   the code. WhatsApp's own entry field shows it in two groups of four; type the eight characters as logged. Codes
   expire; if you miss one, the socket rotates and a new code is issued on the next attempt.
4. `whatsapp_health` flips to `connection: "connected"`, and WhatsApp starts pushing history. Contacts, chats and
   messages land in SQLite as they arrive.

Leaving `WHATSAPP_PHONE_NUMBER` unset is not a silent failure: the API logs, once per socket, that pairing requires it,
and sits in `pairing` until it is configured.

Credentials live in the database under `WHATSAPP_DATA_DIR`, so **the volume is the account**. It is the one stateful
thing in the topology. Back it up, and be aware that deleting it means re-pairing from a phone.
`whatsapp_health` reporting `ok: false` means exactly one thing: WhatsApp logged the device out and a human has to
re-pair it.

## Configuration

Every variable is optional except where noted. Invalid numbers fall back to the default rather than failing the boot;
`WHATSAPP_PHONE_NUMBER` and `WHATSAPP_API_URL` are the exceptions and throw.

**This is a contract, and it is checkable.** The three tables below list exactly the keys read by `loadConfig` in
`packages/api/src/config.ts` and `packages/mcp/src/config.ts`, and nothing else — with one flagged exception,
`LOG_LEVEL`, which both processes read directly in their `logger.ts`. Setting a variable on the wrong process does
nothing at all, silently, which is the whole reason the ownership is written down.

### Read by both processes

| Variable | Default | What it does |
| --- | --- | --- |
| `WHATSAPP_API_TOKEN` | — | The shared secret. The API gates every `/v1` route with it; the MCP presents it. **Unset on the API means every `/v1` route answers 401** — fail-closed, warned once at boot. An empty string counts as unset on both sides, deliberately: `WHATSAPP_API_TOKEN=` in a compose file is a variable someone meant to fill in. |
| `PORT` | `8080` | HTTP listen port, clamped to `[1, 65535]`. Binds `0.0.0.0`. Each process reads its own. |
| `WHATSAPP_MAX_UPLOAD_BYTES` | 64 MiB | Largest file `whatsapp_send_file` will send, whichever way the bytes arrived. Clamped to `[1, 256 MiB]`. It also sizes each process's HTTP body limit — this value plus base64 overhead plus 1 MiB of envelope. **Give both the same value:** raising it on the API alone just moves the refusal to the MCP's body parser, which is a worse message for the same outcome. |
| `WHATSAPP_MCP_MAX_RESULT_CHARS` | `200000` | Clamped to `[1000, 50000000]`. The MCP truncates every tool payload longer than this with a note naming the full length; the API cuts `GET /v1/media/:chat/:id/text` at the same number. Shared so that raising it for the MCP does not leave the API still answering the default. |
| `LOG_LEVEL` | `info` | pino level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. Read in each package's `logger.ts`, **not** through `loadConfig` — the one variable here that is not part of a `Config`. **`trace` and `debug` are not safe to leave on the API.** The same logger is handed to Baileys, which logs raw stanzas at those levels — including the pairing `ref`, which is a live credential. Turn them on to debug, then turn them back off. |

### Read by `whatsapp-mcp` only

| Variable | Default | What it does |
| --- | --- | --- |
| `WHATSAPP_API_URL` | — | **Required.** The API's base URL: absolute `http(s)`, no trailing slash, and **no credentials** — a URL carrying a userinfo section is refused at boot rather than stripped, because `fetch` refuses such a URL outright and a deployment that believed it authenticated that way would fail every request. The value never appears in an error message. |
| `WHATSAPP_MCP_TOKEN` | — | Bearer token guarding the MCP path. **Unset means the endpoint is unauthenticated.** Compared in constant time; never logged, never echoed in a refusal. Setting this on the API does nothing. |
| `MCP_HTTP_PATH` | `/mcp` | Path the MCP endpoint is mounted on. `/health` is always at `/health` and always public. Setting this on the API does nothing. |
| `WHATSAPP_MCP_SESSION_TTL` | `1800` | Idle session lifetime in **seconds**, clamped to `[60, 86400]`. The floor is a minute because a TTL shorter than a client's poll interval evicts a live session; the ceiling is a day because an abandoned session holds an `McpServer` open. This was a hard-coded 30 minutes before the split. |
| `WHATSAPP_MCP_REQUEST_TIMEOUT_MS` | `30000` | How long any one API call may take, clamped to `[1000, 300000]`. |
| `WHATSAPP_MCP_TRANSCRIBE_TIMEOUT_MS` | `960000` | The same, for `transcribe` alone, clamped to `[60000, 3900000]`. A separate knob because the numbers force it: one shared timeout either abandons a fifteen-minute transcription five minutes in, or gives every ordinary read a fifteen-minute rope. The default sits just above the API's own `WHATSAPP_TRANSCRIBE_TIMEOUT_MS` so the SDK is never the component that quits first. ⚠️ **A reverse proxy in front of the API needs a matching read timeout.** It is the one component this repo cannot configure, and a proxy 504 abandons a GPU job that keeps running and keeps being billed. |

### Read by `whatsapp-api` only

| Variable | Default | What it does |
| --- | --- | --- |
| `WHATSAPP_DATA_DIR` | `/data/whatsapp` | The state directory. Holds `whatsapp.db` (store + credentials) and `tmp/`. |
| `WHATSAPP_MEDIA_DIR` | `$WHATSAPP_DATA_DIR/media` | The content-addressed attachment cache. See the note on eviction below. |
| `WHATSAPP_PHONE_NUMBER` | — | The account's number, E.164 digits without `+`. Required to pair; ignored once paired. Rejected at boot if malformed. |
| `WHATSAPP_MCP_READONLY` | off | `1`/`true`/`yes`/`on`. The API reports it through `GET /v1/capabilities`, and the MCP responds by not registering the six write tools. Despite the name it is the **API's** variable — it is the process that would perform the write. The media tools stay: neither changes anything on WhatsApp. |
| `WHATSAPP_TRANSCRIBE_BACKENDS` | `runpod,mistral` | Which backends to try, **in order**. `runpod` is the self-hosted endpoint, `mistral` the paid API. Flipping this to `mistral` alone is the documented lever for when the endpoint is down. An unknown name is dropped rather than failing the boot — this is an incident control. |
| `WHATSAPP_RUNPOD_ENDPOINT_ID` | — | The RunPod serverless endpoint id. Jobs go to `https://api.runpod.ai/v2/<id>/…`. ⚠️ **`api.runpod.**io**` is the *management* API and answers 401 to a job — a failure that reads exactly like a bad key.** |
| `RUNPOD_API_KEY` | — | Credential for that endpoint. |
| `MISTRAL_API_KEY` | — | Credential for the fallback. Without it there is no fallback, which is a legitimate configuration: it is the only path that sends conversation audio to a model vendor. |
| `WHATSAPP_TRANSCRIBE_MAX_SECONDS` | `900` | Recordings longer than this are refused rather than transcribed. Clamped to `[1, 14400]`. |
| `WHATSAPP_WHISPER_MAX_SECONDS` | — | Deprecated alias for the above, kept for one release. It is the only transcription variable a live deployment already sets, and silently halving the limit back to the default during a rollout would start refusing recordings that used to work. |
| `WHATSAPP_TRANSCRIBE_TIMEOUT_MS` | `900000` | How long a job may take end to end, cold start included. Clamped to `[1000, 3600000]`. Keep it in step with the endpoint's own `execution_timeout_ms`, or a job dies at whichever is lower. |
| `RUNPOD_PRICE_PER_SECOND` | `0.000756` | A100 80 GB flex, $2.72/hr. Used only by the budget ledger. |
| `RUNPOD_IDLE_TIMEOUT_SECONDS` | `120` | **Must match the endpoint's `idle_timeout`.** The ledger charges one of these per cold burst, because RunPod bills the idle tail and no job response can see it. |
| `WHATSAPP_MAX_IMAGE_BYTES` | 5 MiB | Budget for an image block returned to the model; larger images are downscaled to fit. Clamped to `[1, 100 MiB]`. |
| `WHATSAPP_SEND_FILE_DIR` | — | The **one** directory `whatsapp_send_file`'s `path` argument may resolve inside, **on the API host**. Unset disables `path` entirely, which is the default and the right one: a container serving a remote client has no legitimate caller for a server-side path, and left open, `path` is an arbitrary-file-read primitive that would hand `/proc/self/environ` — every secret in the process environment — to a WhatsApp conversation. When set, paths are resolved through symlinks and confined to it; a refusal never echoes the path it was asked to read. |
| `WHATSAPP_VIDEO_KEYFRAMES` | `4` | Frames extracted per video, evenly spaced. Clamped to `[1, 16]`. |
| `WHATSAPP_MEDIA_LINK_TTL` | `900` | How long a signed media download link stays redeemable, in seconds. Clamped to `[60, 86400]`. `GET /media/dl/:token` is unauthenticated by design, so this is the lifetime of an unauthenticated capability for one attachment: the ceiling is a day because a link outliving one is a durable leak of conversation content, and the floor is a minute because a link too short-lived to survive being clicked is not a link. The value is baked into each token at mint, so lowering it never revokes one already handed out. |
| `WHATSAPP_AUTOTRANSCRIBE` | off | Transcribe voice notes **as they arrive**, so `whatsapp_transcribe` answers from cache and a cold GPU is never in anyone's way. Off in code, on in the deployment: it spends money on recordings nobody asked about. |
| `WHATSAPP_AUTOTRANSCRIBE_MAX_AGE` | `86400` | Anything older is history, not news. Bounds the offline drain after a long outage. |
| `WHATSAPP_AUTOTRANSCRIBE_MAX_PER_HOUR` | `20` | A ceiling independent of the dollar cap, so a pricing mistake cannot become an unbounded burst. |
| `WHATSAPP_AUTOTRANSCRIBE_MAX_SECONDS` | `300` | Checked against the stored `duration_s` **before the download** — which is why schema V2 persists it. |
| `WHATSAPP_AUTOTRANSCRIBE_CHAT_WINDOW_DAYS` | `30` | A chat counts as mine if I sent something in it this recently. Keeps broadcast lists and shops off the bill. |
| `WHATSAPP_AUTOTRANSCRIBE_CHATS` | — | Chat ids that bypass the window, for the conversation you only ever listen to. |
| `WHATSAPP_AUTOTRANSCRIBE_DAILY_BUDGET_USD` | `2` | A **hard stop**, on deliberately over-counted spend. Breaching it stops the background lane until UTC midnight and fires an ntfy alert; `whatsapp_transcribe` keeps working. `0` means stop. |
| `WHATSAPP_AUTOTRANSCRIBE_CONCURRENCY` | `2` | Background jobs in flight. Kept **below** the endpoint's worker ceiling: that gap is what guarantees an interactive call always has a worker to land on. |
| `NTFY_BASE_URL` | — | ntfy server for connection alerts. Alerting is all-or-nothing: it is off unless both this and `NTFY_TOPIC` are set. |
| `NTFY_TOPIC` | — | The **incident** topic: disconnection, waiting-to-be-paired, logged-out, and the recovery that closes one of those. Recovery is deliberately not routed elsewhere — an operator who sees the alarm on this topic has to see the all-clear on it too. |
| `NTFY_TOPIC_INFO` | `NTFY_TOPIC` | The **routine** topic, for traffic that is not a problem: today, the startup self-test. Unset, routine notices join the incident topic. Setting it can only ever move traffic off the incident topic, never silence it. |
| `NTFY_TOKEN` | — | Bearer token for ntfy, if the server needs one. Travels in a header and appears in no log line. **A token the server does not recognise fails silently:** every publish is a `warn` and nothing more, by design — an alerting failure must never take the WhatsApp socket down — so a wrong token means no alert will ever arrive and nothing will say so except `alerts: ntfy publish rejected` in the log. The startup self-test exists to put that line where it can be found on boot rather than during the first real incident. |

Alerting lives entirely in the API, and debounces on purpose: a dropped socket must stay down for a grace period before
anyone is paged, re-alerts on a cadence while still down, and announces recovery only if a down alert actually went out.
`logged_out` skips the grace and goes out immediately — no backoff recovers it. An MCP that cannot reach the API
notifies nobody; `api.reachable` in the merged health report is what an external watchdog watches instead.

No token — `WHATSAPP_API_TOKEN`, `WHATSAPP_MCP_TOKEN`, `NTFY_TOKEN` — appears in a log line, an error message, or a
`/health` response. The API's `/health` returns a closed record built in `packages/api/src/rest/handlers/meta.ts`
rather than a spread of the config, so a new config field can never widen it by accident.

**`last_event_age_sec` and `last_message_at` measure different things, and only the second one detects a frozen
store.** `last_event_age_sec` is the age of the last `connection.update` — the socket's opinion of itself — so it stays
small on a connection that is answering while receiving nothing. `last_message_at` is `MAX(ts)` over the store, the one
value that separates "healthy and quiet" from "connected and ingesting nothing". Nothing inside the API decides which
of those it is, because *quiet* is a property of the conversation and not of the server; that judgement belongs to a
watchdog outside the process, with its own clock and its own threshold. The API's `/health` answers `200` in every
connection state, so a probe pointed at it detects a dead HTTP server and nothing more — deliberately, since read
tools keep working while disconnected and a reconnect must not flap the container.

## Running it from source

```bash
pnpm install
pnpm --filter whatsapp-api dev    # builds the SDK, then tsx for the API
pnpm --filter whatsapp-mcp dev    # in another shell, with WHATSAPP_API_URL set
pnpm build                        # tsc -> packages/*/dist
```

Both `dev` scripts run through `tsx` but compile `whatsapp-api-sdk` first, because the SDK is consumed through its
`dist/`. The consequence worth knowing: an edit under `packages/sdk/src` is invisible to a running `dev` process until
the SDK is rebuilt — in *both* processes, which is how a contract change becomes a mismatch rather than an error.

The API's endpoints:

```
GET   http://0.0.0.0:8080/health           public, unauthenticated, JSON
GET   http://0.0.0.0:8080/media/dl/:token  unauthenticated by design — the token is the capability
*     http://0.0.0.0:8080/v1/…             22 routes behind Bearer $WHATSAPP_API_TOKEN
```

The MCP's:

```
POST/GET/DELETE  http://0.0.0.0:8080/mcp     Streamable HTTP MCP, one session per Mcp-Session-Id
GET              http://0.0.0.0:8080/health  public, unauthenticated, JSON
```

Sessions are created on `initialize` and swept after `WHATSAPP_MCP_SESSION_TTL` idle. `/health` sits in front of the
bearer gate on both processes deliberately — a container healthcheck that needs the secret is a secret in the compose
file.

## Docker

Two images, both `node:24-slim`, both built **from the workspace root** so the install sees the lockfile,
`pnpm-workspace.yaml` and every manifest:

```bash
docker build -f packages/api/Dockerfile -t whatsapp-api:latest .
docker build -f packages/mcp/Dockerfile -t whatsapp-mcp:latest .
```

`ghcr.io/spare-cycles/whatsapp-mcp-api` and `ghcr.io/spare-cycles/whatsapp-mcp` are what
`.github/workflows/docker.yml` publishes, from one matrix, gated on the same `check` job. amd64 only.

The API image adds ffmpeg, poppler-utils and ca-certificates, sets `WHATSAPP_DATA_DIR=/data/whatsapp` and `PORT=8080`,
and creates `/data/whatsapp` owned by `node`. The MCP image installs no system package at all. Both run as the
unprivileged `node` user, so a bind mount in place of a named volume must be writable by uid 1000, and both carry a
`HEALTHCHECK` polling `/health` — the API's fails only on a logged-out account, the MCP's also on an unreachable API.

`docker-compose.yml` is the shape this is meant to run in. Read it before writing your own: the `service_healthy`
dependency, the unpublished API port and the shared `WHATSAPP_API_TOKEN` are each there for a reason stated in the file.

## Upgrading from the single container

An existing deployment is one container with one volume, and that volume holds credentials that cannot be recovered
without re-pairing the account from a phone. Read this before changing anything.

1. **The volume is unchanged and needs no migration.** Attach it to the **api** container, at the same
   `/data/whatsapp` path. Same contents, same schema, same credentials; the store migrates itself forward on boot. Do
   not attach it to the mcp container — that process opens no database, and a volume mounted there does nothing.
2. **The old image tag is superseded by two.** There is no single-container image any more and no combined tag. Pull
   `…/whatsapp-mcp-api` and `…/whatsapp-mcp` and run both.
3. **Generate a new `WHATSAPP_API_TOKEN` and give it to both containers.** It did not exist before the split. Without
   it the API answers 401 to every `/v1` request and the MCP can do nothing; with different values on the two
   containers, the same. `openssl rand -hex 32`.
4. **Move `WHATSAPP_MCP_TOKEN` and `MCP_HTTP_PATH` to the mcp container.** They are real variables that changed owner.
   Left on the api container they are read by nothing and warn about nothing, and the MCP endpoint ends up
   unauthenticated.
5. **Re-point your MCP client** at the mcp container's published port. Under the shipped compose file that is
   `http://localhost:8081/mcp`.

Everything else in the configuration table stays on the api container, which is where it already was.

## Quality gate

```bash
pnpm check     # build, then prettier --check, eslint, tsc --noEmit
pnpm test      # build, then node:test via tsx, per package
pnpm build     # tsc -> packages/*/dist
```

`pnpm check` is `build && format:check && lint && typecheck`, and the last three must be silent. It builds first
because `whatsapp-api-sdk` resolves through its `dist/`. The TypeScript config is the full strict set —
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`
and the rest — and ESLint runs `strictTypeChecked` + `stylisticTypeChecked` with zero tolerance for warnings. Do not
weaken a compiler option to make code compile.

CI (`.github/workflows/ci.yml`) runs the same gate on every pull request, on Node 24, installing ffmpeg between `check`
and `test`. `.github/workflows/docker.yml` re-runs it as a `check` job and gates both image builds on it with
`needs: check`, so nothing red is ever tagged `:latest`.

## Testing

Tests are `node:test`, run through `tsx`, and live beside their subject as `packages/*/src/**/*.test.ts`. No test
framework is installed. Media tests are not mocked at the boundary that matters: they build real PNG, WebP and MP4
fixtures with ffmpeg and convert them back, because a stubbed converter only ever asserts the stub.

```bash
pnpm test                                                          # everything
node --import tsx --test packages/api/src/whatsapp/ingest.test.ts  # one file
```

`packages/e2e` is the suite that exists because of the split: it boots the real API composition — real SQLite, real
ingest — behind a fake Baileys socket, spawns the real MCP as a separate OS process, and drives it over real HTTP with
a real MCP client. It is the only thing that would catch an MCP suite passing green against a stub while the real pair
is broken.

What the suite structurally cannot cover is a real WhatsApp account and a real GPU job. That is `smoke.mjs`:

```bash
node smoke.mjs                                         # health, session, 14 tools, whatsapp_chats_list
node smoke.mjs --api                                   # the API's own /health and GET /v1/chats
node smoke.mjs --transcribe <chatJid> <messageId>      # ... and a real transcription
```

It runs against a **running deployment with a paired store** — a real account, real chats, real media — which no CI
runner has and no fixture can fake, so it is manual by design and excluded from the lint and type gates.
`--transcribe` is the only exercise a real transcription ever gets — it costs GPU seconds, and the first call of a
quiet day pays the full cold start. Run it after any change to either image, and after every `runpod-sync.py --apply`.

## Two things to know

**Baileys is an unofficial client, and using it carries a real ban risk.** It is a clean-room reimplementation of
WhatsApp's multi-device protocol, not an API Meta offers, supports or condones. Meta bans accounts for automated
behaviour, and the traffic pattern of a language model driving an account — bursts of sends, messages to people who
never messaged you, unusual timing — is exactly what that detection looks for. Nothing here rate-limits on your behalf.
Use an account you can afford to lose, keep the volume human, and do not point it at strangers. A ban takes the number
with it, not just this server.

**The media cache is never evicted.** `WHATSAPP_MEDIA_DIR` holds one file per distinct attachment, named by the sha256
of its bytes, and nothing ever deletes one. That is a deliberate v1 scope decision, not an oversight — the alternative
is an eviction policy that has to reason about which cached transcript is still referenced by the search index — but it
means the directory grows monotonically with every attachment ever read, and a chat full of videos will grow it fast.
There is no configured ceiling and no alert when the volume fills. Watch it, and empty it by hand when you need to:
every file in it is re-derivable from WhatsApp, so deleting the lot costs nothing but a re-download, and transcripts
already in the database survive.
