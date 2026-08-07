# Splitting whatsapp-mcp into an API and an MCP consumer

**Status:** design, approved for planning
**Date:** 2026-08-07

## 1. Why

Today one Node process owns the Baileys socket, the SQLite store, the media cache, transcription and
a 14-tool MCP surface. The layering inside it is already clean — `db/`, `whatsapp/` and `media/` are
domain, `mcp/` is an adapter, `main.ts` is the only wiring — but the *only* way to reach any of it is
to speak MCP.

That is the constraint being removed. There are consumers that are not language models: a
human-facing web UI or dashboard first, ad-hoc scripts after. Those want structured rows and real
files, not base64 JPEG strips capped at a model's context budget.

So the split is not primarily about code hygiene. It is about making the WhatsApp capability a
product surface, with MCP demoted to its first consumer.

### Non-goals

- Scaling out. The API is a hard singleton: one socket, one SQLite writer, one volume, and the
  volume *is* the account. Nothing in this design makes a second instance meaningful.
- Building the web UI. This design only stops making it impossible.
- An event stream. A UI will want SSE for live messages; MCP does not, and it is purely additive.
  Reserved, not designed.
- Changing what a language model sees. See §7.

## 2. Topology

Three packages in one pnpm workspace, two container images.

```
whatsapp-api-sdk      routes + Zod schemas + error taxonomy + typed client
   ^          ^
   |          |
whatsapp-api  whatsapp-mcp        (and, later, the web UI)
```

`whatsapp-api` depends on the SDK as well as `whatsapp-mcp`. That is deliberate and is the main
structural idea in this document: the SDK owns the route table, the server *implements* it, so an
operation that exists in the contract and not in the server is a compile error rather than a 404
somebody finds in production.

**Monorepo, not three repos.** The SDK will be edited on nearly every feature for the first months;
a two-repo version-bump dance per added field would dominate the work. The SDK is still published to
a registry, so a future consumer never needs a checkout of this repo. If the API is ever extracted,
the boundary is already a network contract and the move is mechanical.

```
packages/
  api/    whatsapp-api        node:24-slim + ffmpeg + poppler-utils
  sdk/    whatsapp-api-sdk    published; only runtime dep is zod
  mcp/    whatsapp-mcp        node:24-slim, no native dependencies at all
```

## 3. The SDK

### 3.1 Route table

The contract is data, not a hand-written client:

```ts
export const routes = {
  listChats: {
    method: "GET",
    path: "/v1/chats",
    query: ChatQuery,
    response: { kind: "json", schema: Page(Chat) },
  },
  fetchMedia: {
    method: "GET",
    path: "/v1/media/:chat/:id",
    query: MediaQuery,
    response: { kind: "binary" },
  },
} as const satisfies RouteTable;
```

`response` is a discriminated union because Zod cannot parse bytes and pretending otherwise is how a
binary endpoint ends up with no type-safe result. `{ kind: "binary" }` says so in the contract.

Both sides derive from this table:

- **Server** — `implement(routes, handlers)`, where the handler map is typed
  `{ [K in keyof typeof routes]: Handler<(typeof routes)[K]> }`. A missing handler, a handler
  returning the wrong shape, or a query field the handler does not accept all fail `tsc`.
- **Client** — `createClient({ baseUrl, token, fetch })` exposes one method per route. Requests are
  validated on the way out; JSON responses are `.parse`d on the way in. A field the API stops
  sending becomes a thrown parse error at the boundary rather than an `undefined` discovered three
  layers away.

`fetch` is injectable so tests drive the client without a listener.

### 3.2 Errors

One wire shape, one closed code union:

```json
{ "error": { "code": "ambiguous_recipient", "message": "…", "details": { } } }
```

Codes: `bad_request`, `unauthorized`, `not_found`, `message_not_found`, `media_unavailable`,
`conversion_failed`, `ambiguous_recipient`, `recipient_not_found`, `read_only`, `not_connected`,
`transcription_unavailable`, `budget_exhausted`, `payload_too_large`, `internal`.

The client maps each code to a typed error class.

**Constraint:** those classes keep the same `name` and `message` as today's in-process errors —
`AmbiguousRecipientError`, `RecipientNotFoundError`, `MediaUnavailableError`, `MessageNotFoundError`,
`ConversionError`. `describeError` renders `err.name + err.message` straight into a model's context,
so preserving them keeps the model-facing text identical and lets the existing assertions stand.

Two codes have no in-process ancestor:

- `not_connected` — the WhatsApp socket is down. Replaces what `requireSocket` throws today.
- `api_unreachable` — client-side only, never on the wire. The MCP could not reach the API at all.
  Distinct from `not_connected` so a model can tell "WhatsApp is down" from "my backend is down".

## 4. API surface

All routes are `/v1`, bearer-authenticated with `WHATSAPP_API_TOKEN`, except `/health` and the signed
media download route.

| Route | Purpose |
| --- | --- |
| `GET /health` | Unauthenticated. Container healthcheck. Closed record, no secrets. |
| `GET /v1/capabilities` | `readOnly`, feature flags, API version. |
| `GET /v1/chats` | Paginated. Filters: `query`, `isGroup`, `archived`, `unread`. |
| `GET /v1/groups` | Groups only, with participant counts. |
| `GET /v1/contacts` | Paginated, `query`. |
| `GET /v1/messages` | Filters: `chat`, `sender`, `fromMe`, `kind`, `hasMedia`, `after`, `before`, `asc`. |
| `GET /v1/messages/search` | Same filters plus `q`; adds `snippet` and `matchedTranscript`. |
| `GET /v1/messages/:chat/:id` | One message plus its full reaction list. |
| `GET /v1/media/:chat/:id` | Representations — see §5. Downloads from WhatsApp on cache miss. |
| `GET /v1/media/dl/:token` | Unauthenticated signed download. See §5.2. |
| `POST /v1/recipients/resolve` | Name → candidate list. What a UI needs to build a picker. |
| `POST /v1/messages` | Send text. |
| `POST /v1/messages/file` | Send a file. |
| `PATCH /v1/messages/:chat/:id` | Edit. |
| `DELETE /v1/messages/:chat/:id` | Revoke for everyone. |
| `POST /v1/messages/:chat/:id/reaction` | React; empty emoji removes. |
| `POST /v1/messages/:chat/:id/transcribe` | Transcribe. Costs money, mutates the store. `202` + job id (§4.4). |
| `GET /v1/jobs/:jobId` | Status and result of an async job (§4.4). |
| `POST /v1/chats/:chat/read` | Mark read up to a message. |

### 4.1 Rows are denormalized, and this is load-bearing

`presentMessage` currently calls `ctx.contacts.displayName(m.senderId)` **per row**, and
`reactionCounts` issues one grouped query per page. In-process both are free. Across HTTP, a naive
port becomes fifty round trips per page.

So the `Message` resource carries `sender: { id, name }` and `reactionCount` already resolved, and
`Chat` carries its resolved display name. This is not an MCP concession — it is what a web UI wants
too, and it is why the API is denormalized by design rather than a thin mirror of the tables.

### 4.2 Pagination

Cursors stay opaque strings with exactly the encoding `mcp/cursor.ts` defines today, but the module
moves to `packages/api` and ownership goes with it. The MCP passes `nextCursor` back verbatim and
never decodes it. A malformed cursor remains an error (`bad_request`), never a silent reset to
offset zero — silently restarting a paginated walk is how a model loops over page 1 forever,
convinced it is making progress.

### 4.3 Recipient ambiguity

`whatsapp/recipient.ts`'s refusal is domain logic and stays API-side. It surfaces as `409` with
`code: "ambiguous_recipient"` and `details.candidates`, each carrying a stable 1-based `index`, `id`,
`label` and `exact`. The MCP renders the numbered refusal it renders today; a UI renders a picker.

The candidate order must remain a total order over the data, for the reason it always had to: `pick`
selects by number, and an order that varied between the refusal and the retry would send a private
message to the wrong person.

`POST /v1/recipients/resolve` exposes the same resolution without sending anything.

## 5. Media

### 5.1 Representations

One endpoint, `as` selects the representation. The rule the route table encodes: **one file → binary,
many or structured → JSON.**

| `as` | Response | Applies to | Notes |
| --- | --- | --- | --- |
| `raw` *(default)* | binary | any | `disposition=attachment\|inline`; original mimetype |
| `link` | JSON | any | `{ url, expiresAt, mimeType, bytes, filename }`; `for=raw\|jpeg` |
| `jpeg` | binary | image | Downscaled to fit `maxBytes` / `maxEdge` |
| `keyframes` | JSON | video | `{ durationSec, frames: [{ index, atSec, mimeType, data }] }` |
| `text` | JSON | pdf | `{ text, truncated }` |
| `transcript` | JSON | audio, video | `{ text, model, language }` or `null`. Cache only. |
| `meta` | JSON | any | mimetype, bytes, dimensions, duration, `hasTranscript`, sha256 |

`keyframes` carries base64 frames inline rather than N sub-URLs because the MCP's terminal use *is*
base64 image blocks, so any other encoding is a decode-then-re-encode; a UI renders `data:` URLs
directly. Every MCP branch stays one round trip.

`as=transcript` reads the cache and never spends money. Triggering transcription is
`POST /v1/messages/:chat/:id/transcribe`. That preserves the existing two-lane rule — the
interactive lane may fall back to a paid API, the background lane may not — because the lane is a
property of the call site, and only one of these two is a call site.

`maxBytes`, `maxEdge` and `frames` are optional; the API's configured values are the defaults and
also the ceilings. One knob, API-side, so a client cannot ask for a 4 K frame strip.

### 5.2 Signed links

`as=link` returns a URL to `GET /v1/media/dl/:token`, which is unauthenticated by design — that is
what makes it shareable, browser-downloadable and usable from an `<img>` without leaking a bearer
token into the DOM.

It is a real security surface: an unauthenticated route serving conversation attachments. It gets
the same posture as `WHATSAPP_SEND_FILE_DIR`.

**Which representations get a link.** `for=raw` (the default) or `for=jpeg`, and nothing else. Those
are the two binary representations, and a URL is only worth minting for something a browser can
render or download directly. `text`, `transcript`, `meta` and `keyframes` are JSON: a caller that
can parse JSON can send an `Authorization` header, so an unauthenticated URL buys them nothing.

`for=jpeg` is regenerated from the raw cached file on each fetch rather than materialised into a
second cache. The conversion is deterministic and cheap, and a derivative cache would need its own
key, its own eviction and its own invalidation for a media cache that is documented as never
evicted. If thumbnail traffic ever justifies one, it is a pure optimisation behind an unchanged
contract.

**Token format.** A MAC verifies data, it does not carry it — a bare HMAC of the parameters leaves
the download route with nothing to resolve. So the token carries its own payload. It is
**encrypted**, not merely encoded:

```
v1.<base64url( iv ‖ ciphertext ‖ tag )>
```

AES-256-GCM, key derived via HKDF from `WHATSAPP_API_TOKEN`, 96-bit random IV per token. GCM is
authenticated encryption, so it replaces the separate HMAC rather than adding to it: a tampered
token fails the tag check and never decrypts. The plaintext is a compact record
`{ s, r, m, f, e }` — the raw file's sha256, the representation, the mimetype, the download
filename and the expiry in Unix seconds.

Verification order is fixed: decrypt and check the GCM tag first, *then* check `e` against the
clock. Checking expiry first would answer a forged token differently from a stale one, which is a
distinguishing oracle for free.

**Why encrypted rather than signed-and-readable.** base64url is encoding, not secrecy: a signed
payload is world-readable to anyone holding the link, and this payload carries a filename.
`contrat_divorce.pdf` or `bilan_medical.pdf` in a URL is a disclosure on its own, independent of
any identifier. Encryption removes the whole class rather than the one field anybody thought of.

**No account identifier appears in the token at all.** The obvious payload is chat id plus message
id, and a chat id *is* a phone number. Substituting the LID would be an improvement and not a fix:
a LID is pseudonymous, not anonymous — it is stable per account, so two links correlate to the same
person — it is precisely what `canonicalId` folds *away* (reversing that fold reintroduces the
split-identity bug `CLAUDE.md` calls out), and groups have no LID. Keying on the raw file's sha256
sidesteps the question: a content hash identifies bytes, not people.

- Rotating `WHATSAPP_API_TOKEN` invalidates every outstanding link, which is the correct behaviour.
  When no API token is configured — the API is then presumably behind a private network — the key is
  32 random bytes generated at boot, so links do not survive a restart. Stated rather than silent,
  because a link that dies on deploy is surprising exactly once.
- Short TTL, `WHATSAPP_MEDIA_LINK_TTL` (default 900 s).
- `as=link` resolves and caches the attachment at **mint** time, so a link that cannot be produced
  fails in front of the caller instead of 404-ing for whoever it was sent to.
- The token names a content hash, not a path, so traversal is not expressible: a sha256 matching no
  cached file is a 404, never a filesystem read.
- The URL is never logged, on either side. It is a credential.

### 5.3 Why not S3

An object store was considered for hosting media and rejected for v1.

- It does not remove the API from the hot path. A cold attachment must be downloaded from WhatsApp
  by the process holding the socket, so S3 adds a second hop on exactly the requests that were
  already slow.
- It adds a bucket, credentials, a lifecycle policy and egress cost to serve a cache that already
  lives on the volume and is never evicted.
- It widens the blast radius for conversation content.
- A signed URL served by the API has every property actually wanted: shareable, expiring, no bearer,
  browser-downloadable.

`MediaLinkProvider` is an interface with a `local` implementation. An `s3` implementation is
additive the day the volume becomes the constraint.

## 6. Module ledger

| Destination | Modules |
| --- | --- |
| `packages/api` | `db/*`, `whatsapp/*`, `media/*` including `convert.ts`, `alerts.ts`, `config.ts` (API vars), `logger.ts`, `main.ts`; `http.ts` becomes the REST server |
| `packages/sdk` | Schemas, route table, error taxonomy, client. Almost entirely new code. |
| `packages/mcp` | `mcp/tools/*`, `mcp/result.ts`, `mcp/server.ts`, `mcp/health.ts`, `http.ts` (Streamable HTTP + bearer, near-unchanged), thin `main.ts`, own `logger.ts` |
| Deleted | `mcp/context.ts`'s repository fields; the combined in-process bootstrap |

`ToolContext` collapses from thirteen fields to three: `{ config, logger, client }`.

**`convert.ts` stays wholly API-side.** It is tempting to move it to the MCP, since image downscaling
and keyframe extraction are model-shaping. But the API needs ffmpeg regardless — it transcodes a
video's audio track before every transcription upload — so moving it would put ffmpeg, poppler and
jimp in *both* images, and would make the MCP pull a 20 MB video over HTTP to produce a four-frame
strip. Keeping it API-side leaves the MCP with **zero native dependencies**: `node:24-slim` and
nothing else, no `apt-get` line in its Dockerfile.

## 7. What a language model sees

**The fourteen tools' input schemas and output JSON are unchanged**, with the exceptions in §7.1.
This is the hard goal, and it is what makes the migration verifiable: `smoke.mjs` and the existing
assertions in `reads.test.ts` and `server.test.ts` keep passing with the repositories in
`ToolContext` swapped for a stubbed client.

### 7.1 The three deliberate changes

1. **`whatsapp_download_media`'s non-PDF document branch returns a link, not a path.** Today it
   reports the on-disk path in `WHATSAPP_MEDIA_DIR` "for a human or another tool to open". Across a
   process boundary that path is a lie unless both containers share the volume. It becomes a signed
   URL (§5.2), which is strictly more useful to a remote client and no less useful to a local one.
2. **`whatsapp_health` merges two reports** — the API's health plus the MCP's own reachability and
   latency to it. A model asking whether things work needs both answers.
3. **`WHATSAPP_SEND_FILE_DIR` now names a directory on the API host.** Same security posture,
   different machine. Still unset by default, still the only directory `path` may resolve inside.

## 8. Invariants that change

- **JID handling gets stricter.** `reads.ts` calls `canonicalId` today. After the split the MCP must
  not canonicalize at all: ids are opaque strings and the API canonicalizes at its boundary.
  `CLAUDE.md`'s enforcing grep applies to `packages/api` only, and `packages/mcp` gains a stronger
  rule — no `canonicalId` import, no JID parsing of any kind.
- **"Read tools work in every connection state" weakens to "whenever the API is reachable."** This
  split trades a process-local guarantee for a network one. That is the real cost of the design and
  it is worth naming; `api_unreachable` exists so the degradation is legible rather than mysterious.
- **`readOnly` is enforced API-side and discovered MCP-side.** The API returns `403 read_only`
  regardless of what any client believes, because a separate process cannot be trusted to police
  itself. The MCP fetches `/v1/capabilities` to decide which tools to *register*, preserving today's
  property that a read-only deployment never advertises a write tool. `startHttp` already builds a
  fresh `McpServer` per session (`src/http.ts:253`), so capabilities are fetched per session:
  flipping the API to read-only takes effect on the next client connect, with no MCP restart. This
  requires widening `HttpDeps.buildServer` from `() => McpServer` to `() => Promise<McpServer>`,
  which is the only change the MCP's transport layer needs.
- **Two secrets.** `WHATSAPP_API_TOKEN` (MCP → API) and `WHATSAPP_MCP_TOKEN` (client → MCP). Neither
  appears in a log line, an error message, or either `/health`.
- **`getMessage` stays API-side.** The Baileys protocol hook that re-encrypts a message for a peer
  and builds quotes is wired to `messages.getRaw`. It never crosses the boundary, and the `raw` BLOB
  column remains load-bearing for the protocol.
- **`maxResultChars` truncation stays MCP-side.** It is a model context budget, not an API concern.

## 9. Configuration

| Package | Variables |
| --- | --- |
| api | `WHATSAPP_DATA_DIR`, `WHATSAPP_PHONE_NUMBER`, `WHATSAPP_API_TOKEN`, `WHATSAPP_MCP_READONLY`, `WHATSAPP_MEDIA_DIR`, `WHATSAPP_SEND_FILE_DIR`, `WHATSAPP_MAX_UPLOAD_BYTES`, `WHATSAPP_MAX_IMAGE_BYTES`, `WHATSAPP_VIDEO_KEYFRAMES`, `WHATSAPP_MEDIA_LINK_TTL`, `WHATSAPP_RUNPOD_ENDPOINT_ID`, `RUNPOD_API_KEY`, `MISTRAL_API_KEY`, `WHATSAPP_AUTOTRANSCRIBE*`, `NTFY_*`, `PORT` |
| mcp | `WHATSAPP_API_URL`, `WHATSAPP_API_TOKEN`, `WHATSAPP_MCP_TOKEN`, `WHATSAPP_MCP_MAX_RESULT_CHARS`, `WHATSAPP_MCP_SESSION_TTL`, `PORT` |

`WHATSAPP_MCP_READONLY` stays API-side despite its name, because the API is what enforces it. The
name is kept rather than renamed so an existing deployment does not silently become writable on
upgrade.

## 10. Testing

- **Moved unchanged.** Every test under `db/`, `whatsapp/` and `media/` moves to `packages/api` with
  no edits. If one needs an edit, that is a signal the split is leaking.
- **SDK.** Schema round-trips; the error-code-to-class mapping; the client against an injected
  `fetch`.
- **API.** One route-level test per operation against an ephemeral listener, asserting both the happy
  shape and the error code.
- **MCP.** The existing tool tests, with `ToolContext`'s repositories replaced by a stubbed client.
  Assertions on output JSON are unchanged — that is the migration's proof.
- **End-to-end, and this is the one that matters.** A test that boots the real API over a temp
  SQLite and a real listener, then drives the real MCP tools against it through the real SDK
  client. The socket seam already exists and is the one to use: `ConnectionDeps.makeSocket` is an
  injectable Baileys factory, documented as "injectable so tests never open a websocket", and the
  `WAMessage` envelopes in `whatsapp/fixtures.ts` are what gets pushed through it into
  `ingest.attach`. Note that `fixtures.ts` supplies *messages*, not a socket — the fake socket is
  the thing this test has to build, and it is the only genuinely new test infrastructure in the
  whole split.

  Without this test, nothing stops the stubbed client of the MCP suite from drifting away from the
  real API: both suites would stay green while the pair was broken. That is the failure mode the
  split introduces and the only one no type can catch.
- **`smoke.mjs`** gains an API-only mode and keeps its MCP mode, so each image can be smoke-tested
  alone. It remains manual and outside every gate.

The gate stays `pnpm check` and `pnpm test`, run across the workspace.

## 11. Sequence

Each step ends with a green gate **and a working product**. In particular the in-process MCP stays
wired and serving until step 3 replaces it — there is no window in which the deployed image cannot
answer a tool call.

0. **Workspace scaffold.** pnpm workspace, three package directories. Move all current source to
   `packages/api` unchanged. Nothing else changes; the image still works exactly as it does today.
1. **SDK contract.** Schemas, route table, error taxonomy, client, its own tests. No behaviour change
   anywhere — nothing imports it yet.
2. **API implements the contract.** Routes over the existing domain modules, mounted *alongside* the
   existing in-process MCP surface, plus the media representations and signed links. Both surfaces
   are live and answer from the same domain objects, which is what makes step 3 verifiable: the REST
   answer and the tool answer can be compared directly.
3. **MCP consumes the contract.** `packages/mcp` becomes real — tools rewritten against the client,
   `ToolContext` collapsed, every direct repository import deleted. Existing tool assertions must
   pass untouched. Only once its end-to-end test is green does the in-process MCP surface come out
   of the API.
4. **Ship.** Two Dockerfiles, compose file, `README.md` and `CLAUDE.md` split per package, `smoke.mjs`
   modes.
5. **Delete the seam.** Dead config, the old combined bootstrap, `mcp/` under `packages/api`. No
   shims, no re-exports, no deprecated paths.

## 12. Risks

| Risk | Handling |
| --- | --- |
| Chatty reads (per-row name resolution) | §4.1 denormalization, decided up front rather than discovered under load |
| Stub drift between the fake client and the real API | The end-to-end test in §10 is the only defence, and is not optional |
| A network partition turning read tools into failures | `api_unreachable` as a distinct, legible code; named as an accepted cost in §8 |
| Signed links leaking conversation content | HMAC over the exact tuple, short TTL, constant-time compare, never logged (§5.2) |
| Baileys' pinned `7.0.0-rc14` behaviour changing under a workspace hoist | Pin stays exact; the API package owns it and no other package may import `baileys` |
| Two images drifting in Node major | Both pinned to `node:24-slim`; `engines.node` `">=24"` in all three packages |
