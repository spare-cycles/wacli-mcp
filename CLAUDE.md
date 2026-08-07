# whatsapp-mcp — one Node process: Baileys + SQLite/FTS5 + a 14-tool MCP surface over HTTP

`README.md` is the reference (tools, env vars, pairing, Docker). This file is the list of things that
are non-obvious enough to get broken by an edit that looks correct.

- **All raw JID interpretation lives in `packages/api/src/whatsapp/jid.ts`.** No other production module
  may contain `@lid`, `@s.whatsapp.net` or `@g.us`, or split a JID on `@` or `:`. WhatsApp hands the
  same human two identities — a phone JID and a LID — and folding them is the difference between one
  conversation and two half-empty ones. Every layer above calls `canonicalId(jid, contacts)` and
  treats the result as an opaque key. Two enforcing checks, run from the repo root, each of which
  must print nothing. **`packages/api` — exemptions for the three files that carry JID literals as
  data:**
  ```bash
  grep -rn '@lid\|@s\.whatsapp\.net\|@g\.us' packages/api/src/ --include='*.ts' \
    | grep -v '\.test\.ts:' \
    | grep -v 'src/whatsapp/jid\.ts:' \
    | grep -v 'src/whatsapp/fixtures\.ts:'
  ```
  A test for identity folding has to name a LID, and `fixtures.ts` is message data, so both are
  excluded. **`packages/mcp` — stricter, no exemptions at all, and `canonicalId` is banned outright:**
  ```bash
  grep -rn '@lid\|@s\.whatsapp\.net\|@g\.us\|canonicalId' packages/mcp/src/
  ```
  No `--include`, no `grep -v`: the MCP server treats every id as an opaque string it received from
  the API, so there is nothing for it to say about JID syntax even in a test. A test that needs an id
  uses whatever opaque string the API handed back.

  The other two packages are deliberately outside both checks, and neither is an oversight.
  `packages/sdk` is a wire contract — it carries ids as strings and never parses one — and
  `packages/e2e` exists to fake the Baileys socket, whose `connection.update` payload has a real
  `user.id` in it (`packages/api/src/whatsapp/connection.test.ts` shows the shape). Scanning `e2e`
  would flag `fake-socket.ts` for doing exactly its job.

- **`getMessage` makes the store load-bearing for the protocol, not just for reads.** Baileys calls
  it to re-encrypt a message a peer failed to decrypt, and to build a quote. It is wired in
  `packages/api/src/main.ts` to `messages.getRaw(...)`, which returns the stored protobuf envelope — so the `raw`
  BLOB column is not a debugging convenience, and a change that stops persisting it silently breaks
  retries and replies rather than failing a test. It is typed to return the **inner** `proto.IMessage`,
  not the `WebMessageInfo` envelope.

- **FTS5 is an external-content table** (`content='messages'`, `content_rowid='rowid'`), kept in sync
  by three triggers in `packages/api/src/db/schema.ts` — insert, delete, and an update that deletes-then-inserts.
  An external-content FTS index stores no copy of the text, so a write that bypasses those triggers
  leaves the index wrong forever with no error. In particular `setTranscript` writes through the
  repository *because* the UPDATE trigger is what puts transcribed speech into the search index.

- **Which FTS column matched is read from the `snippet()` markers, never from a snippet being empty.**
  `snippet()` returns unmarked leading text for a column that took no part in the match, so "empty
  means no match" mislabels the common case — a captioned video whose caption does not contain the
  query but whose transcript does — as a text hit. `packages/api/src/db/messages.ts` asks for `char(1)`/`char(2)`
  delimiters and tests for those markers.

- **Baileys is pinned exactly: `"baileys": "7.0.0-rc14"`.** No caret, no tilde. It is a prerelease
  and rc→rc has broken APIs before. Bumping it is a task with a test run, not a dependency refresh.
  Related: `packages/api/src/mcp/tools/*` must not import from `baileys` — Baileys types stop at the `whatsapp/` and
  `media/` boundary.

- **The socket's `browser[1]` is a protocol value, not a cosmetic label, and only six strings work.**
  Baileys sends `companion_platform_display` as `${browser[1]} (${browser[0]})`, and WhatsApp
  validates it strictly for the pairing-code IQ — but not for QR registration, so this breaks
  exactly one code path and only at first pairing. `Browsers.macOS("Desktop")` is answered
  `<iq type='error'><error code='400' text='bad-request'/></iq>`, and `requestPairingCode` never
  awaits that reply: it returns the locally generated code either way. So the whole failure
  surfaces as eight plausible characters the phone refuses, with a healthy-looking pod and no
  error in the log. Only Baileys' `BROWSER_TO_COMPANION_WEB_CLIENT` keys — Chrome, Edge, Firefox,
  IE, Opera, Safari — are safe; `packages/api/src/whatsapp/connection.ts` uses `Browsers.macOS("Chrome")`. Upstream
  issue #2560, whose fix (PR #2559) is unmerged as of rc14 — recheck on any Baileys bump.

- **`creds.me` is written when a pairing code is *requested*, not when pairing succeeds**, and
  Baileys branches registration-vs-login on `creds.me` alone. So an unclaimed code leaves a device
  WhatsApp has never seen, the next socket tries to log in as it, and the `<failure reason='401'/>`
  that comes back is indistinguishable from a real logout — which wipes the store and parks the
  server in `logged_out` with no retry. `createSocket` therefore calls `discardUnregisteredIdentity()`,
  which trusts `creds.registered` (set only on a completed pairing) rather than `creds.me`. Without
  it every missed pairing code costs a manual restart.

- ⚰️ **whisper.cpp is gone (2026-08-03), and with it the whole reason this image was amd64-only.**
  Transcription ran in-process against a 574 MB model on a GPU-less VPS — minutes of CPU per voice
  note. It now runs on a RunPod serverless endpoint (Voxtral Small 24B on vLLM; see
  [`spare-cycles/transcribe-worker`](https://github.com/spare-cycles/transcribe-worker)) with
  Mistral's API as fallback. The whisper stage, `LD_LIBRARY_PATH`, `libgomp1`, the `models/`
  directory and `WHATSAPP_WHISPER_{BIN,MODEL,THREADS}` all left with it.

- 🔴 **`api.runpod.ai` submits jobs; `api.runpod.io` manages endpoints.** Same `/v2` prefix,
  different hosts, different auth scopes — and the management host answers a job with a **401**,
  which reads exactly like a bad key. `media/backends/runpod.ts` pins the jobs host in a named
  constant for this reason, and says so in the 401 branch.

- **Two lanes, and the background one must never reach Mistral.** `whatsapp_transcribe` is
  interactive and may fall back to the paid API; auto-transcription is background and may not.
  Paying a vendor to transcribe a recording nobody asked about is not worth it — and it is also the
  only path that would send conversation audio to a model vendor with nobody deciding to.
  `LANE_BACKENDS` in `media/transcribe.ts` is the enforcement, and `transcribe.test.ts` asserts it
  because no type can.

- 🔴 **The flood guard is the ingest *path*, never the upsert's `type`.** `messaging-history.set`
  passes `transcribe: false` (`whatsapp/ingest.ts`), which is what stops a re-pair's replay of
  thousands of messages from becoming thousands of GPU jobs. Filtering on `type` instead looks
  equivalent and is not: `messages.upsert` carries both `notify` **and** the offline `append` drain,
  and `append` is legitimate recent traffic received while the process was down — dropping it would
  silently skip real voice notes, with nothing anywhere reporting it.

- **The budget ledger charges wall time plus one idle tail per cold burst, and over-counts on
  purpose.** RunPod bills the cold start and the whole idle timeout, neither of which appears in a
  job's response; a ledger built on the worker's `infer_s` would report cents while the console
  reported ~$82/month. It persists through `meta`, so a restart does not reset the day —
  `budget.test.ts` asserts exactly that, because a cap a crash loop can clear is not a cap.

- **`node:sqlite` is experimental, so the Node version is a compatibility decision.** `engines.node`
  is `">=24"` and the image is `node:24-slim`; a Node major bump is a deliberate check that FTS5,
  external-content tables and the `run()`/`get()` shapes still behave, never a routine upgrade. The
  suite is the check — run it on the new major before changing anything.

- **HTTP transport only, with bearer auth.** No stdio transport and no `StdioServerTransport` import.
  Middleware order in `packages/api/src/http.ts` is load-bearing: `/health` is registered **before** the bearer
  gate (a container healthcheck that needs the secret is a secret in the compose file), and
  `express.json` is mounted **on the MCP path behind the gate**, so an anonymous `POST /anything`
  cannot make the server buffer and parse ~90 MB. No log line in that file is ever handed a raw error
  object: body-parser hangs the whole raw payload off a parse failure and pino's serializer copies
  every own key, so one `{ err }` writes a caller's request body to disk.

- **A Zod `.refine()` on a tool's input silently blanks its advertised schema.** On
  `@modelcontextprotocol/sdk@1.30.0` a refinement makes the schema a `ZodEffects`, which has no
  `.shape`; `normalizeObjectSchema` falls back to `EMPTY_OBJECT_JSON_SCHEMA`, so `listTools`
  advertises `{"type":"object","properties":{}}` and no client learns that any argument exists. The
  call still *validates*, so a server-side test that only checks a bad call is refused sees nothing
  wrong. Cross-field rules go in the handler (`fileSource` in `packages/api/src/mcp/tools/writes.ts`) and in the
  description. Same class of trap: a discriminated union renders as a top-level `anyOf`, which
  several clients present badly.

- **Read tools must work in every connection state** — they query SQLite and never touch the socket.
  Only write tools and a media *cache miss* may require a live connection.

- **An ambiguous recipient name is refused, never resolved by picking one.** `whatsapp/recipient.ts` turns a
  JID, a phone number or a *name* into a chat id, and the whole point of it is the refusal: two people
  called Marie is the ordinary case, and guessing sends a private message to the wrong person. The
  refusal numbers the candidates and `pick` selects by that number, so the candidate order must stay a
  total order over the data — sorting by anything a query happens to return would make `pick: 2` mean
  a different person on the retry than in the refusal that suggested it. An out-of-range `pick` is an
  error rather than a clamp, for the same reason.

- **`whatsapp/send.ts` must not name a local helper `resolve`.** `node:path`'s `resolve` is imported at the
  top of that file and used by `resolveSendPath`'s containment check; a `(string) => string` shadow
  inside `makeSender` type-checks perfectly and silently reroutes the path check. Hence `resolveChat`.

- **Timestamps are integer Unix seconds, UTC, everywhere in the store.** `Number(m.messageTimestamp)`
  at the boundary, because protobuf may hand back a `Long` that fails silently in comparisons.
  Anything from `Date.now()` divides by 1000 and floors; the only milliseconds in the codebase carry
  `Ms` in the name.

- **The gate is `pnpm check` (build + prettier + eslint + tsc) and `pnpm test`, both green before a
  commit.** Both build first, because the SDK's `exports` name `dist/`: see the workspace bullet below.
  Full TS strict set, ESLint `strictTypeChecked` + `stylisticTypeChecked` at zero warnings; do not
  weaken a compiler option to make code compile. `eslint.base.js` names `eslint.config.js` in its
  `ignores` — being outside `src/` is *not* enough, because `projectService` fatals on any file no
  tsconfig includes; root-level `smoke.mjs` is safe only because `pnpm -r run lint` never leaves a
  package directory. Symmetrically, `src/mcp/tools/harness.ts` and `src/whatsapp/fixtures.ts` are named
  one by one in `packages/api/tsconfig.build.json`'s `exclude`: both are test scaffolding, neither is a
  `*.test.ts` file, so that glob catches neither and anything left out compiles into `dist/` and
  ships in the image as dead code. Any new non-`*.test.ts` scaffolding needs a line there too.

- **`whatsapp-api-sdk` resolves through `dist/`, so something must build it before anything reads it.**
  Its `exports`/`types` name `./dist/index.js` and `./dist/index.d.ts` — the same paths `npm publish`
  and `pnpm deploy --prod` will use, which is why they may not point at `src/index.ts` however well
  Node's type stripping happens to cope. Two mechanisms cover it: `api` and `mcp` each build their
  workspace deps first via `build:deps` (`pnpm --filter "<pkg>^..." run build`), so a bare
  `pnpm --filter whatsapp-api typecheck` is self-sufficient; and the root `check`/`test` build once
  up front. **Prefer the root scripts anyway** — not because the recursive ones fail to resolve, since
  `build:deps` means they now do, but because `pnpm -r run typecheck` fans out `api`'s and `mcp`'s
  `build:deps` concurrently, and on a cold tree that is two `tsc` invocations emitting into
  `packages/sdk/dist` at once. Building once up front keeps that unreachable, and the SDK's build is
  `tsc -b` so the warm case is a no-op rather than a second writer.

- **`WHATSAPP_SEND_FILE_DIR` is unset by default and that is a security decision.** `whatsapp_send_file`'s `path`
  argument is an arbitrary-file-read primitive that would hand `/proc/self/environ` to a WhatsApp
  conversation; it is disabled entirely unless that variable names a directory, and refusals never
  echo the path they were asked to read. `WHATSAPP_MCP_TOKEN` and `NTFY_TOKEN` appear in no log line, no
  error message and not in `/health`, which returns a closed record rather than a spread of `Config`.

- **The media cache is never evicted** (v1 scope, documented in `README.md`). `WHATSAPP_MEDIA_DIR` grows
  monotonically, one sha256-named file per distinct attachment.

- **`smoke.mjs` is the only coverage a real GPU job gets.** The suite drives a `fetch` mock, so a
  rotated key, a changed endpoint id, a worker image that will not boot or a renamed response field
  are all invisible to it. `smoke.mjs` is manual, needs a running server against a paired store, and
  is excluded from every gate. Run `node smoke.mjs --transcribe <chat> <messageId>` after any change
  to either image, to the media pipeline, or after a `runpod-sync.py --apply`. ⚠️ It costs GPU
  seconds, and the first call of a quiet day pays the full cold start.
