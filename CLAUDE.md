# whatsapp-mcp — `api` (Baileys + SQLite/FTS5 + REST) · `sdk` (the contract) · `mcp` (14 tools over HTTP) · `e2e`

`README.md` is the reference (tools, env vars, pairing, Docker, upgrading). This file is the list of
things that are non-obvious enough to get broken by an edit that looks correct. It is not a summary
of the README, and nothing belongs here that a careful reader would infer from the code in front of
them.

## The split

- **`whatsapp-api-sdk` is the only thing keeping the two processes in agreement, and it agrees at
  compile time only.** `packages/sdk/src/routes.ts` is one table of 24 routes; `implement()` types
  the API's handler map against it and `createClient()` types the MCP's calls against it, so a route
  whose response shape changed fails `tsc` on both sides at once. Nothing checks a **running** pair:
  two containers built from different commits typecheck perfectly and disagree on the wire. The only
  defences are `CONTRACT_VERSION` — fetched per session via `GET /v1/capabilities`, and a mismatch
  throws `ContractVersionError` before a single tool is registered (`packages/mcp/src/server.ts`) —
  and `packages/e2e`, which spawns the real MCP as a separate OS process against the real API
  composition. Change a payload shape and you owe both an SDK bump and a thought about rollout order.

- **`packages/mcp` must never import `baileys`, `node:sqlite`, or anything from `packages/api`.**
  Not a style rule: the MCP image has no `apt-get` line, no volume and no `/data`, so a module that
  reaches for any of those turns a stateless container into one that half-works. `packages/e2e`
  holds `whatsapp-api`, `whatsapp-mcp` and `baileys` as **dev**dependencies precisely so none of them
  lands on `whatsapp-mcp`'s own manifest. Three checks, each of which must print nothing:
  ```bash
  grep -rn 'baileys\|node:sqlite' packages/mcp/src/
  grep -rn 'whatsapp-api[\"/]' packages/mcp/src/
  pnpm --filter whatsapp-mcp why baileys
  ```
  Inside `packages/api`, Baileys stops at `whatsapp/`, `media/store.ts`, `db/auth-state.ts` and
  `main.ts`. **`packages/api/src/rest/**` imports it nowhere** and must keep not importing it: the
  REST layer's job is to turn domain values into SDK-shaped JSON, and a `proto.IMessage` leaking into
  a handler is how the contract stops being the contract.

- **All raw JID interpretation lives in `packages/api/src/whatsapp/jid.ts`.** No other production
  module may contain `@lid`, `@s.whatsapp.net` or `@g.us`, or split a JID on `@` or `:`. WhatsApp
  hands the same human two identities — a phone JID and a LID — and folding them is the difference
  between one conversation and two half-empty ones. Every layer above calls
  `canonicalId(jid, contacts)` and treats the result as an opaque key. Two enforcing checks, run from
  the repo root, each of which must print nothing.

  **`packages/api` — exemptions for the three files that carry JID literals as data:**
  ```bash
  grep -rn '@lid\|@s\.whatsapp\.net\|@g\.us' packages/api/src/ --include='*.ts' \
    | grep -v '\.test\.ts:' \
    | grep -v 'src/whatsapp/jid\.ts:' \
    | grep -v 'src/whatsapp/fixtures\.ts:'
  ```
  A test for identity folding has to name a LID, and `fixtures.ts` is message data.

  **`packages/mcp` — the ban is on *doing* anything with a JID, not on the characters:**
  ```bash
  grep -rn '@lid\|@s\.whatsapp\.net\|@g\.us\|canonicalId(' packages/mcp/src/ --include='*.ts' \
    | grep -v '\.test\.ts:' \
    | grep -v 'src/tools/harness\.ts:'
  ```
  The MCP treats every id as an opaque string it received from the API, so no production module there
  parses one and none may **call** `canonicalId` — hence `canonicalId(`, with the paren, which lets
  the two comments in `tools/{reads,writes}.ts` go on saying that folding happens at the API boundary.
  The test files and `tools/harness.ts` are exempt because their JIDs are opaque fixture data:
  `result.test.ts` pins whole serialized API payloads as golden strings, and those payloads contain
  real-shaped ids by construction.

  The other two packages are outside both checks, and neither is an oversight. `packages/sdk` is a
  wire contract — it carries ids as strings and never parses one — and `packages/e2e` fakes the
  Baileys socket, whose `connection.update` payload has a real `user.id` in it, and legitimately
  imports `canonicalId` to reimplement the API's own `getMessage` wiring.

- **`{ next_cursor, items }` key order is load-bearing, and `deepEqual` is blind to it.**
  `packages/mcp/src/result.ts`'s `page()` serializes the cursor **first** because `jsonResult`
  truncates from the end: with `items` first, the one field an oversized page always loses is the
  cursor, which breaks the pagination round trip on exactly the pages that need it. Structural
  equality cannot defend this, so `result.test.ts` compares `JSON.stringify` against a golden
  **string** and reads the cursor back out of a deliberately truncated page. Do not "simplify" either
  test into a `deepEqual`. Note the REST layer underneath uses camelCase `nextCursor`
  (`packages/api/src/rest/handlers/reads.ts`, `Page` in the SDK); the snake_case rename to the tool
  surface happens in `page()` and nowhere else.

- **`pnpm deploy --legacy` in both Dockerfiles is a deliberate choice, not a leftover flag.** From
  pnpm 10, `deploy` refuses a workspace that does not set `inject-workspace-packages=true` — but
  injecting changes how workspace dependencies link **in development too**, turning the SDK from a
  symlink into a hard copy that goes stale until the next install. That is a real cost paid on every
  SDK edit, to satisfy a constraint that only matters inside an image. `--legacy` keeps the dev
  workflow untouched. Do not "fix the deprecation" by flipping the workspace setting. What `deploy`
  buys over hand-copying the layout: `whatsapp-api-sdk` arrives as a real dependency of the deployed
  tree, so a `zod` import *inside the SDK* resolves from the deploy's own store — under a preserved
  workspace layout Node's realpath walk restarts at `packages/sdk` and needs
  `packages/sdk/node_modules` copied in by hand, a line whose absence fails only once the SDK imports
  something.

- **The MCP has no way to alert, and read tools now have a network in front of them.** A failed hop
  raises `ApiUnreachableError` / `api_unreachable` — the one error code the API never sends, because
  it describes a state in which the API said nothing (`packages/sdk/src/client.ts`). A 401, a 500 or
  an unparseable body is *not* `api_unreachable`; conflating them sends an operator to look at DNS
  instead of at the API's logs. `alerts.ts` is API-side, so an MCP that cannot reach its API pages
  nobody; `api.reachable` in the merged health report exists so an external watchdog can.

## `packages/api`

- 🔴 **`media/autotranscribe.ts` contains literal NUL bytes, and some grep tooling skips such a file
  *silently*.** The NULs are the `keyOf` separator. The consequence is not cosmetic: a call-site
  audit over `packages/api/src/media/` for `setTranscript` returns the two test files and **omits the
  production caller**, with no warning that a file was skipped. That is a confidently wrong answer to
  exactly the question you ask before changing a signature — and it has already bitten once, during
  the schema V3 change. Shell `grep -rn` finds it; so does `LC_ALL=C grep -rnUa`. Some editor/agent
  grep implementations do not. **Verify any "I found every caller" claim in this repo with
  `LC_ALL=C grep -rnUa`, and treat a clean result from anything else as unproven.** The related trap:
  a caller that hand-builds a `MessageRow` literal (e.g. `whatsapp/send.test.ts`) contains the method
  name nowhere at all, so no grep finds it — only `tsc` does.

- **`getMessage` makes the store load-bearing for the protocol, not just for reads.** Baileys calls
  it to re-encrypt a message a peer failed to decrypt, and to build a quote. It is wired in
  `packages/api/src/main.ts:144` to `messages.getRaw(...)`, which returns the stored protobuf
  envelope — so the `raw` BLOB column is not a debugging convenience, and a change that stops
  persisting it silently breaks retries and replies rather than failing a test. It is typed to return
  the **inner** `proto.IMessage`, not the `WebMessageInfo` envelope. ⚠️ Do not confuse it with the
  REST operation also called `getMessage` (`GET /v1/messages/:chat/:id`), which is cross-boundary by
  design. Same name, opposite rules.

- **FTS5 is an external-content table** (`content='messages'`, `content_rowid='rowid'`), kept in sync
  by three triggers in `packages/api/src/db/schema.ts` — insert, delete, and an update that
  deletes-then-inserts. An external-content FTS index stores no copy of the text, so a write that
  bypasses those triggers leaves the index wrong forever with no error. In particular `setTranscript`
  writes through the repository *because* the UPDATE trigger is what puts transcribed speech into the
  search index.

- **Which FTS column matched is read from the `snippet()` markers, never from a snippet being empty.**
  `snippet()` returns unmarked leading text for a column that took no part in the match, so "empty
  means no match" mislabels the common case — a captioned video whose caption does not contain the
  query but whose transcript does — as a text hit. `packages/api/src/db/messages.ts` asks for
  `char(1)`/`char(2)` delimiters and tests for those markers.

- **`node:sqlite` is experimental, so the Node version is a compatibility decision.** `engines.node`
  is `">=24"` and the image is `node:24-slim`; a Node major bump is a deliberate check that FTS5,
  external-content tables and the `run()`/`get()` shapes still behave, never a routine upgrade. The
  suite is the check — run it on the new major before changing anything.

- **Baileys is pinned exactly: `"baileys": "7.0.0-rc14"`.** No caret, no tilde. It is a prerelease and
  rc→rc has broken APIs before. Bumping it is a task with a test run, not a dependency refresh.

- **The socket's `browser[1]` is a protocol value, not a cosmetic label, and only six strings work.**
  Baileys sends `companion_platform_display` as `${browser[1]} (${browser[0]})`, and WhatsApp
  validates it strictly for the pairing-code IQ — but not for QR registration, so this breaks exactly
  one code path and only at first pairing. `Browsers.macOS("Desktop")` is answered
  `<iq type='error'><error code='400' text='bad-request'/></iq>`, and `requestPairingCode` never
  awaits that reply: it returns the locally generated code either way. So the whole failure surfaces
  as eight plausible characters the phone refuses, with a healthy-looking pod and no error in the log.
  Only Baileys' `BROWSER_TO_COMPANION_WEB_CLIENT` keys — Chrome, Edge, Firefox, IE, Opera, Safari —
  are safe; `packages/api/src/whatsapp/connection.ts:187` uses `Browsers.macOS("Chrome")`. Upstream
  issue #2560, whose fix (PR #2559) is unmerged as of rc14 — recheck on any Baileys bump.

- **`creds.me` is written when a pairing code is *requested*, not when pairing succeeds**, and
  Baileys branches registration-vs-login on `creds.me` alone. So an unclaimed code leaves a device
  WhatsApp has never seen, the next socket tries to log in as it, and the `<failure reason='401'/>`
  that comes back is indistinguishable from a real logout — which wipes the store and parks the API
  in `logged_out` with no retry. `createSocket` therefore calls `discardUnregisteredIdentity()`,
  which trusts `creds.registered` (set only on a completed pairing) rather than `creds.me`. Without
  it every missed pairing code costs a manual restart.

- 🔴 **`api.runpod.ai` submits jobs; `api.runpod.io` manages endpoints.** Same `/v2` prefix, different
  hosts, different auth scopes — and the management host answers a job with a **401**, which reads
  exactly like a bad key. `media/backends/runpod.ts` pins the jobs host in a named constant for this
  reason, and says so in the 401 branch.

- **Two lanes, and the background one must never reach Mistral.** `whatsapp_transcribe` is
  interactive and may fall back to the paid API; auto-transcription is background and may not. Paying
  a vendor to transcribe a recording nobody asked about is not worth it — and it is also the only
  path that would send conversation audio to a model vendor with nobody deciding to. `LANE_BACKENDS`
  in `media/transcribe.ts:110` is the enforcement, and `transcribe.test.ts` asserts it because no
  type can.

- 🔴 **The flood guard is the ingest *path*, never the upsert's `type`.** `messaging-history.set`
  passes `transcribe: false` (`whatsapp/ingest.ts:677`), which is what stops a re-pair's replay of
  thousands of messages from becoming thousands of GPU jobs. Filtering on `type` instead looks
  equivalent and is not: `messages.upsert` carries both `notify` **and** the offline `append` drain,
  and `append` is legitimate recent traffic received while the process was down — dropping it would
  silently skip real voice notes, with nothing anywhere reporting it.

- **The budget ledger charges wall time plus one idle tail per cold burst, and over-counts on
  purpose.** RunPod bills the cold start and the whole idle timeout, neither of which appears in a
  job's response; a ledger built on the worker's `infer_s` would report cents while the console
  reported ~$82/month. It persists through `meta`, so a restart does not reset the day —
  `budget.test.ts` asserts exactly that, because a cap a crash loop can clear is not a cap.

- **An ambiguous recipient name is refused, never resolved by picking one.**
  `whatsapp/recipient.ts` turns a JID, a phone number or a *name* into a chat id, and the whole point
  of it is the refusal: two people called Marie is the ordinary case, and guessing sends a private
  message to the wrong person. The refusal numbers the candidates and `pick` selects by that number,
  so the candidate order must stay a total order over the data — sorting by anything a query happens
  to return would make `pick: 2` mean a different person on the retry than in the refusal that
  suggested it. An out-of-range `pick` is an error rather than a clamp, for the same reason.

- **`whatsapp/send.ts` must not name a local helper `resolve`.** `node:path`'s `resolve` is imported
  at the top of that file and used by `resolveSendPath`'s containment check; a `(string) => string`
  shadow inside `makeSender` type-checks perfectly and silently reroutes the path check. Hence
  `resolveChat` (`send.ts:246`).

- **Timestamps are integer Unix seconds, UTC, everywhere in the store.** `Number(m.messageTimestamp)`
  at the boundary, because protobuf may hand back a `Long` that fails silently in comparisons.
  Anything from `Date.now()` divides by 1000 and floors; the only milliseconds in the codebase carry
  `Ms` in the name.

- **The `/v1` bearer gate fails closed, and the shape of the code is what makes it do so.**
  `packages/api/src/rest/server.ts` mounts, in this order: the nosniff header, the `public`/`signed`
  routes (`/health`, `GET /media/dl/:token`), the gate on `/v1`, `express.json` on `/v1`, the 22
  gated routes, then the 4-arg error middleware. Two properties are easy to destroy. The gate is
  registered unconditionally and tests `token !== undefined && bearerMatches(...)` **inside** the
  handler — wrapping the `app.use` in `if (token)` reads as tidier and turns an unset
  `WHATSAPP_API_TOKEN` from "every `/v1` route answers 401" into "the account is open to anything
  that can reach the port". And `express.json` sits behind the gate so an anonymous `POST /v1/…`
  cannot make the process buffer and parse ~90 MB (`bodyLimitBytes` is `maxUploadBytes × 4/3 + 1 MiB`,
  for base64). `assertGateReachesEveryBearerRoute` checks the arrangement at boot. No log line in
  that file is ever handed a raw error object: body-parser hangs the whole raw payload off a parse
  failure and pino's serializer copies every own key, so one `{ err }` writes a caller's request body
  to disk.

- **`/health` is a closed record, not a spread of `Config`, and that is what keeps secrets out of
  it.** `buildHealth` in `packages/api/src/rest/handlers/meta.ts` names every field it returns, so a
  new config field cannot widen the public payload by accident — the `/health` route sits in front of
  the bearer gate, so "widen" means "publish". The same reasoning covers the tokens:
  `WHATSAPP_API_TOKEN`, `WHATSAPP_MCP_TOKEN` and `NTFY_TOKEN` appear in no log line, no error message
  and no health response, and `whatsapp_send_file`'s refusals never echo the path they were asked to
  read.

## `packages/mcp`

- **HTTP transport only.** No stdio transport and no `StdioServerTransport` import, anywhere.
  `packages/mcp/src/http.ts` repeats the API's ordering rule for the same reasons: `GET /health` is
  registered **before** the bearer gate (a container healthcheck that needs the secret is a secret in
  the compose file), and `express.json` is mounted on `config.httpPath` **behind** the gate.

- **A Zod `.refine()` on a tool's input silently blanks its advertised schema.** On
  `@modelcontextprotocol/sdk@1.30.0` a refinement makes the schema a `ZodEffects`, which has no
  `.shape`; `normalizeObjectSchema` falls back to `EMPTY_OBJECT_JSON_SCHEMA`, so `listTools`
  advertises `{"type":"object","properties":{}}` and no client learns that any argument exists. The
  call still *validates*, so a server-side test that only checks a bad call is refused sees nothing
  wrong. `packages/mcp/src/tools/writes.ts` therefore keeps `whatsapp_send_file`'s arguments flat with
  `data` and `path` both optional, and the "exactly one of" rule is enforced **by the API** and merely
  described here. Same class of trap: a discriminated union renders as a top-level `anyOf`, which
  several clients present badly.

- **Read-only is the API's fact, learned per session.** `WHATSAPP_MCP_READONLY` is read by
  `packages/api/src/config.ts`; the MCP discovers it from `GET /v1/capabilities` when a session opens
  and skips `registerWriteTools`. Asking at session time rather than at boot is deliberate — the MCP
  must start whether or not the API is up — which also means a deployment flipped to read-only takes
  effect on the next session, not on the next request.

- **`whatsapp_download_media`'s document branch hands back a URL built from `WHATSAPP_API_URL`.**
  The API mints a relative `/media/dl/<token>` and the MCP resolves it against its own configured base
  (`tools/media.ts`). Under the shipped compose file that yields `http://api:8080/…`, which resolves
  on the compose network and nowhere else. It is a correct link to an address the model's host may not
  have; treat `WHATSAPP_API_URL` as part of the tool's output contract, not just as plumbing.

## The gate

- **`pnpm check` (build + prettier + eslint + tsc) and `pnpm test`, both green before a commit, and
  the authoritative run is a container.** The host is not a valid environment for this repo: its
  ffmpeg has **no webp encoder at all** (`ffmpeg -encoders | grep webp` returns nothing), and the
  media fixtures are built with real ffmpeg, so the suite is red on the host before any change is
  made. Never claim green from a host run. The run that counts:
  ```bash
  docker run --rm -e CI=true \
    -v "$PWD":/w -v /w/node_modules -v /w/packages/api/node_modules \
    -w /w node:24-slim bash -c '
      apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg poppler-utils >/dev/null
      corepack enable
      pnpm config set store-dir /tmp/pnpm-store
      pnpm install --frozen-lockfile && pnpm test'
  ```
  `-e CI=true` is not optional: without it pnpm aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`
  whenever a host `node_modules` exists in the mount. Neither is a `store-dir` outside the mount,
  or the run leaves a ~136 MB `.pnpm-store/` inside the repo for the next `git add -A` to commit.

- **Use the root scripts, not `pnpm -r run <script>`.** Both build first because the SDK's `exports`
  name `dist/` (below), and `pnpm -r run typecheck` fans out `api`'s and `mcp`'s `build:deps`
  concurrently — on a cold tree, two `tsc` invocations emitting into `packages/sdk/dist` at once.
  Building once up front keeps that unreachable; the SDK's build is `tsc -b`, so the warm case is a
  no-op rather than a second writer.

- **`whatsapp-api-sdk` resolves through `dist/`, so something must build it before anything reads it.**
  Its `exports`/`types` name `./dist/index.js` and `./dist/index.d.ts` — the same paths `npm publish`
  and `pnpm deploy --prod` use, which is why they may not point at `src/index.ts` however well Node's
  type stripping happens to cope. `api`, `mcp` and `e2e` each build their workspace deps first via
  `build:deps` (`pnpm --filter "<pkg>^..." run build`), so a bare `pnpm --filter whatsapp-mcp typecheck`
  is self-sufficient.

- **Full TS strict set, ESLint `strictTypeChecked` + `stylisticTypeChecked` at zero warnings; do not
  weaken a compiler option to make code compile.** `eslint.base.js` names `eslint.config.js` in its
  `ignores` — being outside `src/` is *not* enough, because `projectService` fatals ("was not found by
  the project service") on any file no tsconfig includes, rather than skipping it. Root-level
  `smoke.mjs` is safe only because `pnpm -r run lint` never leaves a package directory. Symmetrically,
  each package's `tsconfig.build.json` names its non-`*.test.ts` scaffolding in `exclude` one by one —
  `src/rest/handlers/harness.ts` and `src/whatsapp/fixtures.ts` for `api`, `src/tools/harness.ts` for
  `mcp` — because the `*.test.ts` glob catches neither and anything left out compiles into `dist/` and
  ships in the image as dead code. Any new scaffolding module needs a line there too.

- **`smoke.mjs` is the only coverage a real GPU job and a real WhatsApp account ever get.** The suite
  drives a `fetch` mock, so a rotated key, a changed endpoint id, a worker image that will not boot or
  a renamed response field are all invisible to it; `packages/e2e` pairs no account. `smoke.mjs` is
  manual, needs a running deployment against a paired store, and is excluded from every gate. Run
  `node smoke.mjs --transcribe <chat> <messageId>` after any change to either image, to the media
  pipeline, or after a `runpod-sync.py --apply`. ⚠️ It costs GPU seconds, and the first call of a
  quiet day pays the full cold start.
