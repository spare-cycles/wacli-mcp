# whatsapp-api / whatsapp-mcp Split — Implementation Plan

**Goal:** Split the single-process `whatsapp-mcp` server into a `whatsapp-api` REST service, a
`whatsapp-api-sdk` contract package, and a stateless `whatsapp-mcp` consumer, without changing what
a language model sees.

**Architecture:** One pnpm workspace, three packages. `whatsapp-api-sdk` owns a route table of Zod
schemas; `whatsapp-api` *implements* that table over the existing domain modules (Baileys socket,
SQLite, media cache, transcription); `whatsapp-mcp` *consumes* it through a generated-from-table
typed client and keeps all model-shaping (base64 blocks, snake_case presentation, truncation).
Both server and client depend on the SDK, so an operation in the contract with no handler is a
compile error.

**Tech Stack:** TypeScript 5.6 strict, Node 24 (`node:sqlite`), pnpm 10.33 workspace, Zod 3.25,
Express 5, Baileys 7.0.0-rc14 (exact pin), `@modelcontextprotocol/sdk` 1.30, ffmpeg/ffprobe/pdftotext.

**Source spec:** `docs/superpowers/specs/2026-08-07-whatsapp-api-mcp-split-design.md`

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **`baileys` is pinned exactly `"7.0.0-rc14"`** — no caret, no tilde. Only `packages/api` may
   depend on it or import it. `packages/mcp` and `packages/sdk` must not list it; an accidental
   import must fail module resolution rather than rely on convention.
2. **The 14 MCP tools' input schemas and output JSON are unchanged**, with exactly three documented
   exceptions (Task 14: the document branch returns a link not a path, in **both** its PDF and
   non-PDF sub-cases; Task 12: `whatsapp_health` merges API health with MCP reachability;
   `WHATSAPP_SEND_FILE_DIR` now names a directory on the API host).
   Every other byte of every tool result stays identical.
3. **All raw JID interpretation lives in `packages/api/src/whatsapp/jid.ts`.** No other production
   module in `packages/api` may contain `@lid`, `@s.whatsapp.net` or `@g.us`, or split a JID on `@`
   or `:`. `packages/mcp` is stricter still: it must not import `canonicalId`, must not contain those
   literals anywhere including tests, and treats every id as an opaque string.
4. **Timestamps are integer Unix seconds, UTC, everywhere.** Only variables named `*Ms` carry
   milliseconds.
5. **Secrets never appear in a log line, an error message, or any `/health` payload.**
   `WHATSAPP_API_TOKEN`, `WHATSAPP_MCP_TOKEN`, `NTFY_TOKEN`, and every signed media URL are
   credentials. Health payloads are closed records, never a spread of `Config`.
6. **No log line is ever handed a raw error object.** Use the existing `errorFields(err)` /
   `errorDetail(err)` helpers; body-parser hangs the raw payload off a parse failure and pino's
   serializer copies every own key, so one `{ err }` writes a caller's request body to disk.
7. **Full TS strict set stays on.** `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
   `verbatimModuleSyntax`, `noPropertyAccessFromIndexSignature` and the rest. Never weaken a compiler
   option to make code compile. ESLint `strictTypeChecked` + `stylisticTypeChecked`, zero warnings.
8. **A Zod `.refine()` on a tool's input silently blanks its advertised MCP schema.** On
   `@modelcontextprotocol/sdk@1.30.0` a refinement produces a `ZodEffects`, which has no `.shape`, so
   `listTools` advertises `{"type":"object","properties":{}}`. Cross-field rules live in the handler
   and in the description, never in the schema. This binds MCP tool schemas only — SDK *wire*
   schemas may refine freely.
9. **FTS5 is an external-content table** kept in sync by three triggers. Any write that bypasses the
   repository leaves the index silently wrong forever. `setTranscript` must keep writing through the
   repository, because the UPDATE trigger is what puts transcribed speech into the search index.
10. **Read paths never require the socket.** Confirmed across all of `db/`: no repository method
    touches the connection. Only writes, and a media *cache miss*, may call `requireSocket()`.
11. **An ambiguous recipient is refused, never resolved by guessing.** Candidate ordering must be a
    total order over the data, because `pick` selects by number and an unstable order would send a
    private message to the wrong person. An out-of-range `pick` is an error, not a clamp.
12. **The Baileys `getMessage` callback is load-bearing for the protocol, not just for reads.** It
    stays wired to `messages.getRaw` inside `packages/api` and never crosses the package boundary.
    The `raw` BLOB column must keep being persisted. ⚠️ Do not confuse this with the **REST
    operation** also called `getMessage` (Task 8), which is public and cross-boundary by design.
    Same name, opposite rules: the socket callback must never leave `packages/api`; the route exists
    precisely to leave it.
13. **`packageExtensions` is workspace-scoped config** and stays at the workspace root
    (`pnpm-workspace.yaml`), never in `packages/api/package.json`, even though `baileys` moves there.
14. **`projectService: true` fatals on any file no tsconfig includes** — "was not found by the
    project service" — it does not skip. Any file outside a package's `src/` that ESLint can reach
    needs an explicit `ignores` entry.
15. **The gate is `pnpm check` and `pnpm test` at the workspace root, both green.** Because the host
    toolchain is unreliable for this repo (see Risks), the authoritative run is inside
    `node:24-slim` + ffmpeg + poppler-utils.

---

## Baseline: the environment you are working in

Read this before Task 1; it will save you an hour of confusion.

- **The host runs Node 26; the project targets Node 24.** `engines.node` is `">=24"` and both images
  pin `node:24-slim`.
- **The host `ffmpeg` (Homebrew 8.1.2) has no webp encoder at all.** `ffmpeg -encoders | grep webp`
  returns nothing. The media test fixtures are built with real ffmpeg, so on the host the suite is
  **already red before any change**: 379 pass, 103 fail (≈51 distinct, each printed twice), confined
  entirely to `src/media/convert.test.ts` and `src/mcp/server.test.ts`.
- **The authoritative verification is a container**, which has libwebp and Node 24:

```bash
docker run --rm -v "$PWD":/w -w /w node:24-slim bash -c '
  apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg poppler-utils >/dev/null
  corepack enable && pnpm install --frozen-lockfile && pnpm -r run test'
```

Never claim green from a host run of the media or server suites.

---

## File structure

```
pnpm-workspace.yaml                 packages/* + workspace-scoped packageExtensions
package.json                        root: shared devDeps, -r orchestration scripts, no bin
eslint.base.js                      shared flat-config array
.dockerignore                       workspace-aware
tsconfig.base.json                  compilerOptions only, no include/rootDir/outDir

packages/sdk/                       whatsapp-api-sdk — only runtime dep is zod
  src/errors.ts                     ApiErrorCode union, ApiError classes, fromWire/toWire
  src/schemas/common.ts             Cursor, Page(T), Timestamp, OpaqueId
  src/schemas/domain.ts             Chat, Message, SearchHit, Contact, Reaction, Health, Capabilities
  src/schemas/media.ts              MediaRepresentation, Keyframe, JpegDerivative, KeyframeStrip,
                                    MediaMeta, MediaLink, PdfExtract
  src/schemas/requests.ts           every query/body schema
  src/routes.ts                     the route table (single source of truth)
  src/server.ts                     implement() — typed handler map, RouteTable types
  src/client.ts                     createClient()
  src/index.ts                      public surface

packages/api/                       whatsapp-api — ffmpeg + poppler
  src/db/**                         moved unchanged (+ Task 4: schema V3)
  src/whatsapp/**                   moved unchanged
  src/media/**                      moved unchanged (+ Task 5: convert additions)
  src/alerts.ts src/logger.ts       moved unchanged
  src/config.ts                     API vars only
  src/version.ts                    moved
  src/rest/cursor.ts                moved from src/mcp/cursor.ts, unchanged encoding
  src/rest/present.ts               denormalised row → SDK domain object
  src/rest/medialink.ts             HMAC signed-token mint/verify
  src/rest/handlers/*.ts            one file per route group
  src/rest/server.ts                Express app, auth gate, implement() wiring
  src/main.ts                       bootstrap

packages/mcp/                       whatsapp-mcp — zero native deps
  src/config.ts src/logger.ts src/version.ts
  src/context.ts                    ToolContext = { config, logger, client }
  src/result.ts                     moved, presenters retargeted at SDK types
  src/server.ts                     buildMcpServer(ctx, capabilities)
  src/health.ts                     merged API + reachability report
  src/tools/{reads,media,writes}.ts flattened from src/mcp/tools/
  src/tools/harness.ts              rewritten over a stubbed SDK client
  src/http.ts                       Streamable HTTP, async buildServer
  src/main.ts                       bootstrap

packages/api/tests/e2e/             fake socket + real API + real SDK + real MCP tools
```

**Naming note:** the `mcp/` directory prefix is dropped inside `packages/mcp` — the package name
carries it. `src/mcp/tools/reads.ts` becomes `packages/mcp/src/tools/reads.ts`.

---

## Task order and why

Tasks 1–3 build the contract with no behaviour change. Tasks 4–5 close the two capability gaps the
scouts found (no `language` column; `convert.ts` returns the wrong shapes) — both must land before
any route can be written against them. Tasks 6–11 implement the API. **Task 11** mounts REST
*alongside* the still-working in-process MCP, so the product never stops working. Tasks 12–14 build
the MCP consumer. Task 15 is the e2e proof. Only Task 16, once that proof is green, removes the
in-process MCP. Tasks 17–18 ship.

---

### Task 1: Workspace scaffold, code moved unchanged

**Files:**
- Create: `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.base.js`,
  `packages/{api,sdk,mcp}/package.json`, `packages/{api,sdk,mcp}/tsconfig.json`,
  `packages/{api,mcp}/tsconfig.build.json`, `packages/{api,sdk,mcp}/eslint.config.js`
- Create (**placeholders — do not skip these**): `packages/sdk/src/index.ts` and
  `packages/mcp/src/index.ts`, each containing exactly `export {};`
- Modify: `package.json` (root), `.dockerignore` — the existing patterns (`node_modules`, `dist`) are
  unanchored and so already match at any depth; no functional change is required here yet, and
  Task 17 supersedes the file. Noted so nobody invents an edit.
- Move: all of `src/**` → `packages/api/src/**` (contents unchanged), `smoke.mjs` stays at root
- Delete: root `tsconfig.json`, root `tsconfig.build.json`, root `eslint.config.js`

**Why the placeholders.** `packages/sdk` gets its first real source in Task 2 and `packages/mcp` in
Task 12, so at the end of *this* task both packages have a `package.json` and a `tsconfig.json`
whose `include` is `src/**/*.ts` — and no `src/` at all. `tsc` treats that as a hard error,
`TS18003: No inputs were found in config file`, not a graceful zero-file pass. Task 1's own
"482 pass, 0 fail" gate and Global Constraint 15 would both fail on the very first task. A
one-line `export {};` in each costs nothing and Task 2 / Task 12 overwrite it.

**Interfaces:**
- Produces: three workspace packages named `whatsapp-api`, `whatsapp-api-sdk`, `whatsapp-mcp`.
  `packages/api` and `packages/mcp` both declare `"whatsapp-api-sdk": "workspace:*"`.

**Critical details:**

`pnpm-workspace.yaml` — `packageExtensions` moves here (Global Constraint 13):

```yaml
packages:
  - "packages/*"
packageExtensions:
  baileys:
    peerDependenciesMeta:
      sharp:
        optional: true
```

Root `package.json`: drop `bin` — and **redistribute it, do not just delete it**. The current root
declares `"whatsapp-mcp": "dist/main.js"`, which stops resolving the moment there is no root
`dist/`. `packages/mcp/package.json` takes `{"whatsapp-mcp": "dist/main.js"}` and
`packages/api/package.json` takes `{"whatsapp-api": "dist/main.js"}`, each relative to its own
package. Then drop `dependencies` entirely, keep shared devDeps
(`eslint`, `typescript`, `typescript-eslint`, `prettier`, `eslint-config-prettier`, `@eslint/js`,
`tsx`, `@types/node`), and orchestrate:

```json
"scripts": {
  "build": "pnpm -r run build",
  "typecheck": "pnpm -r run typecheck",
  "lint": "pnpm -r run lint",
  "test": "pnpm -r run test",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "check": "pnpm run format:check && pnpm run lint && pnpm run typecheck"
}
```

Note `pnpm run`, not `npm run` — the current root uses `npm run` inconsistently.

Dependency split — with one **transitional** entry that is easy to get wrong:

| package | dependencies |
| --- | --- |
| `packages/api` | **`whatsapp-api-sdk: workspace:*`**, `baileys` (exact pin), `jimp`, `express`, `pino`, `zod`, **`@modelcontextprotocol/sdk`** *(transitional)*; dev: `@hapi/boom`, `@types/express` |
| `packages/mcp` | **`whatsapp-api-sdk: workspace:*`**, `@modelcontextprotocol/sdk`, `express`, `pino`, `zod`; dev: `@types/express` |
| `packages/sdk` | `zod`, and nothing else at runtime |

The `workspace:*` entries are not decoration: they are what makes `pnpm -r run build` order the SDK
before its two consumers, and what makes "an operation in the contract with no handler is a compile
error" true rather than aspirational.

**`packages/api` keeps `@modelcontextprotocol/sdk` until Task 16.** Task 1 moves *all* of `src/**`
into it, including `src/mcp/**` and the Streamable-HTTP `src/http.ts`, and those files import the MCP
SDK. The in-process MCP surface stays live through the side-by-side phase (Task 11) precisely so the
product never stops working, so the dependency has to stay with it. Task 16 deletes both together.
Drop it at Task 1 and the very first gate cannot typecheck.

`packages/mcp` needs `@types/express` for the same reason `packages/api` does: Task 12 ports
`http.ts` verbatim and it imports Express types.

`packages/sdk/package.json` must also be **publishable**, because spec §2 makes "the SDK is still
published to a registry" the justification for choosing a monorepo over three repos. That means
`name`, `version`, `license`, `files`, `exports`, `types` and `publishConfig`. Note the scope
boundary: the *release workflow* (a CI publish job, a versioning policy) is deliberately **not** in
this plan — see the deferrals list. A publishable package with no automated release is a coherent
intermediate state; an unpublishable one silently invalidates the topology decision.

`tsconfig.build.json` exclusions follow the files, and the timing matters here too. At Task 1
`packages/api/src/mcp/tools/harness.ts` still exists, so `packages/api/tsconfig.build.json` must keep
**both** exclusions for now, or Task 1 ships test scaffolding into `dist/` — the exact thing
CLAUDE.md documents that exclude list to prevent. `packages/mcp` gets its own `harness.ts` exclusion
in Task 12; `packages/api` drops its copy in Task 16.

```json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "src/whatsapp/fixtures.ts", "src/mcp/tools/harness.ts"]
}
```

ESLint: one `eslint.base.js` at the root exporting the shared config array, and a three-line
`eslint.config.js` per package that sets its own `tsconfigRootDir: import.meta.dirname`. Do **not**
rely on `projectService` auto-discovery across sibling packages (Global Constraint 14). Each
package's `ignores` must cover its own `dist/`. Root `eslint.config.js` is deleted; `smoke.mjs` at
the workspace root is no longer reachable by any package's `eslint .`, so its ignore entry moves
nowhere — but confirm with `pnpm -r run lint` that nothing fatals.

- [ ] **Step 1: Create the workspace files and move the tree**

`git mv src packages/api/src`. Write every file listed above. Run `pnpm install` to regenerate
`pnpm-lock.yaml` — it restructures from one `importers: .:` entry to one per package. This diff is
generated and mechanical; never hand-edit it.

**Also repoint the root `Dockerfile`, in this task.** It currently does
`COPY tsconfig.json tsconfig.build.json ./` and `COPY src ./src`; both paths cease to exist the
moment the tree moves. `.github/workflows/docker.yml`'s build job runs on every push to `main`, uses
`context: .` with no `file:` override, and is not otherwise touched until Task 17 — so leaving this
alone means the image build fails from Task 1 and stays failing for fifteen tasks, publishing
nothing to ghcr.io the whole time. That is a silent deployment freeze in the middle of the
migration.

The fix here is small and temporary: keep one root `Dockerfile` that builds the workspace and runs
`packages/api`'s entrypoint, so the published image keeps meaning what it means today (the whole
server, MCP surface included — which is still true until Task 16). Task 17 replaces it with the two
real per-package Dockerfiles.

```dockerfile
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm -r run build
# NOTE: no `pnpm prune --prod` here. It is not workspace-recursive, so at a workspace root it
# does not do what the single-package Dockerfile used it for. This temporary image is allowed to
# carry devDependencies; Task 17 slims both real images with `pnpm deploy --filter <pkg> --prod`.
# runtime CMD becomes: node packages/api/dist/main.js
```

- [ ] **Step 2: Verify the gate is still green, in the container**

Run: the container command from the Baseline section.
Expected: **482 pass, 0 fail.** (The host baseline's 379 pass / 103 fail sums to the same 482; the
container has libwebp, so every one of the 103 ffmpeg-dependent failures now passes.) Do **not**
expect the host's 379/103 split to reappear here — if it does, you are not running in the container.
Any other failure means the move broke something.

- [ ] **Step 3: Verify baileys is not reachable from mcp or sdk**

```bash
pnpm --filter whatsapp-mcp why baileys   # expect: nothing
pnpm --filter whatsapp-api-sdk why baileys
```
Expected: no dependency path. This is Global Constraint 1 made mechanical.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: convert to a pnpm workspace, move the server into packages/api"
```

---

### Task 2: SDK error taxonomy and domain schemas

**Files:**
- Create: `packages/sdk/src/errors.ts`, `packages/sdk/src/schemas/common.ts`,
  `packages/sdk/src/schemas/domain.ts`, `packages/sdk/src/schemas/media.ts`
- Test: `packages/sdk/src/errors.test.ts`, `packages/sdk/src/schemas/domain.test.ts`

**Interfaces — Produces:**

```ts
export const API_ERROR_CODES = [
  "bad_request", "unauthorized", "not_found", "message_not_found", "media_unavailable",
  "conversion_failed", "ambiguous_recipient", "recipient_not_found", "read_only",
  "not_connected", "transcription_unavailable", "budget_exhausted", "payload_too_large",
  "internal",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const wireError = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    /**
     * The original error's `name`, so the client can reconstruct the exact string
     * `describeError` renders. Required, not optional: several live throw sites are bare
     * `new Error(...)` whose name is literally "Error", and losing that changes tool output.
     */
    name: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
}
export class AmbiguousRecipientError extends ApiError {}   // name = "AmbiguousRecipientError"
export class RecipientNotFoundError extends ApiError {}
export class MediaUnavailableError extends ApiError {}
export class MessageNotFoundError extends ApiError {}
export class ConversionError extends ApiError {}
export class NotConnectedError extends ApiError {}
// The four `whatsapp/send.ts` throws. Easy to miss because they never appear in a tool signature —
// they surface only through `describeError`, which is exactly why omitting them breaks output.
export class NotFoundError extends ApiError {}
export class MessageRevokedError extends ApiError {}
export class NotOwnMessageError extends ApiError {}
export class SendPathError extends ApiError {}
export class ApiUnreachableError extends ApiError {}       // client-side only, never on the wire

export function errorFromWire(status: number, body: unknown): ApiError;
export function errorToWire(err: unknown): { status: number; body: z.infer<typeof wireError> };
```

**This is the highest-risk detail in the whole plan.** `packages/mcp`'s `describeError` renders
`` `${err.name}: ${err.message}` `` straight into the model's context, and the existing tests assert
on that text. So each subclass's `name` and `message` must reproduce today's in-process error
exactly.

Two specifics, both verified:

1. `NotConnectedError` must carry `WhatsApp connection unavailable: current state is "<state>"`, and
   because the current class is named `ConnectionUnavailableError`, the SDK class must set
   `this.name = "ConnectionUnavailableError"` despite being called `NotConnectedError`
   (`src/whatsapp/connection.ts:46-52`; asserted at `src/mcp/server.test.ts:~661`).
2. **`src/whatsapp/send.ts` throws four more error types the first draft of this taxonomy missed** —
   `NotFoundError` (`send.ts:102`, also `:287`, `:325`), `MessageRevokedError` (`:115`, `:288`),
   `NotOwnMessageError` (`:120`, `:305`) and `SendPathError` (`:125`, `:357`, `:364`). Each needs its
   own wire code (`not_found`, `message_revoked`, `not_own_message`, `send_path_refused`) and a class
   preserving its `name` and message. Their messages interpolate ids —
   ``no message ${id} in chat ${chatId}`` — so the API must send the rendered message and the SDK must
   not reconstruct it. `SendPathError`'s message must never echo the path it was asked to read.

Add `message_revoked`, `not_own_message` and `send_path_refused` to `API_ERROR_CODES`.

**Third pass, and the one most likely to be skipped: bare `Error` throws and `CursorError`.** The
two rounds above chased classes with an `override name`. But `describeError` renders *whatever*
reaches it, and several live throw sites are plain `new Error(...)` whose `name` is the literal
string `"Error"`. Route them through the generic path and today's `Error: …` silently becomes
`ApiError: …` — a Global Constraint 2 break with no failing test, because no test asserts these
renderings today.

| site | today's rendered prefix |
| --- | --- |
| `whatsapp/recipient.ts:101` — `` `pick` only applies when the recipient is named by name…`` | `Error: ` |
| `whatsapp/send.ts:261` — ``cannot @mention "${mention}"…`` | `Error: ` |
| `whatsapp/send.ts:337` — `file exceeds the maximum upload size…` | `Error: ` |
| `whatsapp/send.ts:400` — ``WhatsApp accepted the send to ${chatId} but returned no message id`` | `Error: ` |
| `mcp/cursor.ts:13` — `CursorError`, thrown by `decodeCursor` for every paginated read | `CursorError: ` |
| `mcp/tools/reads.ts:172` — the `kind`/`has_media` contradiction | `Error: ` |

The wire carries a code; the SDK must reconstruct the **name** as well as the message. So
`errorFromWire` needs an explicit `name` on the wire envelope, or a code-to-name table covering
these. Concretely: add `invalid_cursor` mapped to a class whose `name` is `"CursorError"`, and give
`bad_request` a class that sets `this.name = "Error"` when the API reports the failure originated
from a bare throw. That last one is ugly, and it is the price of "every other byte stays identical" —
the alternative is to declare these a fourth documented exception, which is a decision, not an
oversight. **This plan takes the byte-identical route.**

The API side must therefore send the original `name`: extend the wire envelope to
`{ error: { code, name, message, details? } }`. Without `name` on the wire this is unimplementable.

Domain schemas (denormalised per spec §4.1 — resolved names and counts, because a client cannot
issue one round trip per row):

```ts
export const Message = z.object({
  id: z.string(), chat: z.string(), ts: z.number().int(), fromMe: z.boolean(),
  sender: z.object({ id: z.string(), name: z.string() }),
  kind: z.enum(MESSAGE_KINDS), text: z.string().nullable(), transcript: z.string().nullable(),
  quotedId: z.string().nullable(), status: z.string(),
  edited: z.boolean(), deleted: z.boolean(),
  media: z.object({ type: z.string().nullable(), cached: z.boolean() }).nullable(),
  reactionCount: z.number().int(),
});
export const SearchHit = Message.extend({ snippet: z.string(), matchedTranscript: z.boolean() });

/**
 * The single-message shape, and the reason it exists: `whatsapp_download_media`'s summary embeds
 * the FULL per-reactor list (`{ emoji, from: { id, name } }[]`) via `presentReactions`, not the
 * batched `reactionCount` that list and search use. A `getMessage` returning only `Message` would
 * silently drop that array and change the tool's output. Keep both fields: `reactionCount` so the
 * shape stays a superset of `Message`, `reactions` for the detail path.
 */
export const Reaction = z.object({ emoji: z.string(), from: z.object({ id: z.string(), name: z.string() }) });
// Declared after `Reaction` on purpose: `const` bindings are in the temporal dead zone until
// initialised, so referencing `Reaction` above its declaration is a runtime ReferenceError, not a
// hoisting nicety. Order matters in this file.
export const MessageDetail = Message.extend({ reactions: z.array(Reaction) });
export const Chat = z.object({
  id: z.string(), name: z.string().nullable(), isGroup: z.boolean(),
  lastMessageTs: z.number().int().nullable(), unreadCount: z.number().int(),
  archived: z.boolean(), mutedUntil: z.number().int().nullable(),
  participantCount: z.number().int().nullable(),
});
export const Contact = z.object({
  id: z.string(), name: z.string().nullable(), notify: z.string().nullable(),
  phoneNumber: z.string().nullable(), lid: z.string().nullable(),
});
export const Page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ nextCursor: z.string().nullable(), items: z.array(item) });
```

`Chat.name` uses the same fallback logic as today's `chatName()` — a DM with no chat name falls back
to the contact's display name, and reports `null` rather than echoing the JID.

**`/health` is the one payload that does NOT get camelCased.** It returns today's `HealthReport`
verbatim, snake_case keys and all (`ok`, `needs_pairing`, `last_event_age_sec`, `auto_transcribe`,
`read_only`, …), because `whatsapp_health` hands it to the model unchanged and Global Constraint 2
requires those exact keys. So there is no `Health` schema mirroring it in camelCase and no
rename-back step in Task 13 — an earlier draft claimed both; that was wrong. The SDK simply types
the existing shape.
`Capabilities` is `{ readOnly: boolean, apiVersion: string, features: { transcription: boolean, autoTranscribe: boolean, mediaLinks: boolean } }`.

- [ ] **Step 1: Write the failing test**

```ts
void test("a wire error round-trips to a class whose name matches the legacy in-process error", () => {
  const err = errorFromWire(503, {
    error: { code: "not_connected", message: 'WhatsApp connection unavailable: current state is "disconnected"' },
  });
  assert.equal(err.name, "ConnectionUnavailableError");
  assert.equal(`${err.name}: ${err.message}`,
    'ConnectionUnavailableError: WhatsApp connection unavailable: current state is "disconnected"');
});

void test("an unknown code does not throw and degrades to a generic ApiError", () => {
  const err = errorFromWire(500, { error: { code: "nonsense", message: "x" } });
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, "internal");
});
```

- [ ] **Step 2: Run and see it fail** — `pnpm --filter whatsapp-api-sdk test`, expect
  "errorFromWire is not defined".
- [ ] **Step 3: Implement** `errors.ts`, then the four schema files.
- [ ] **Step 4: Run and see it pass.**
- [ ] **Step 5: Commit** — `feat(sdk): error taxonomy and domain schemas`

---

### Task 3: SDK route table, `implement()`, and `createClient()`

**Files:**
- Create: `packages/sdk/src/schemas/requests.ts`, `packages/sdk/src/routes.ts`,
  `packages/sdk/src/server.ts`, `packages/sdk/src/client.ts`, `packages/sdk/src/index.ts`
- Test: `packages/sdk/src/client.test.ts`, `packages/sdk/src/routes.test.ts`

**Interfaces — Produces:**

```ts
export type JsonResponse<S extends z.ZodTypeAny> = { kind: "json"; schema: S };
export type BinaryResponse = { kind: "binary" };
export type RouteResponse = JsonResponse<z.ZodTypeAny> | BinaryResponse;

export type Route = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;                    // ":param" segments
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  response: RouteResponse;
  /**
   * Which gate this route sits behind. It is **not** decoration: `implement()` returns it on every
   * binding and Task 7 partitions the mount order by it — public and signed bindings are mounted
   * *before* the bearer gate, bearer bindings *after*. That is what lets `/health` and the signed
   * download live in this table (and therefore on the generated client) while still being
   * reachable without a token.
   */
  auth: "bearer" | "public" | "signed";
};
export const routes = { /* … */ } as const satisfies Record<string, Route>;
export type Routes = typeof routes;

export type BinaryPayload = {
  bytes: Uint8Array; mimeType: string;
  filename?: string; disposition?: "inline" | "attachment";
};
export type HandlerResult<R extends Route> =
  R["response"] extends JsonResponse<infer S> ? z.infer<S> :
  R["response"] extends BinaryResponse ? BinaryPayload : never;

export type Handler<R extends Route> = (input: {
  params: R["params"] extends z.ZodTypeAny ? z.infer<R["params"]> : undefined;
  query:  R["query"]  extends z.ZodTypeAny ? z.infer<R["query"]>  : undefined;
  body:   R["body"]   extends z.ZodTypeAny ? z.infer<R["body"]>   : undefined;
}) => Promise<HandlerResult<R>>;

export type Handlers = { [K in keyof Routes]: Handler<Routes[K]> };

/** What `implement()` hands back for the API to mount however it likes. */
export type RouteBinding = {
  method: Route["method"];
  path: string;                     // Express-style, ":param" segments preserved
  auth: Route["auth"];
  /** Parses params/query/body with the route's schemas, calls the handler, writes the response. */
  handle: (req: RawRequest, res: RawResponse) => Promise<void>;
};
export type RawRequest = {
  params: Record<string, string>; query: Record<string, unknown>; body: unknown;
};
export type RawResponse = {
  status: (code: number) => RawResponse;
  header: (name: string, value: string) => RawResponse;
  json: (body: unknown) => void;
  send: (body: Uint8Array) => void;
};
export function implement(handlers: Handlers): RouteBinding[];

/**
 * One typed client method per route. Each part is **required exactly when the route declares it**
 * — making them all optional would let `client.sendText({})` compile and fail only at runtime,
 * which defeats the point of generating the client from the table. Routes declaring nothing take
 * no argument at all.
 */
type Declared<R extends Route> =
  (R["params"] extends z.ZodTypeAny ? { params: z.infer<R["params"]> } : object) &
  (R["query"]  extends z.ZodTypeAny ? { query:  z.infer<R["query"]>  } : object) &
  (R["body"]   extends z.ZodTypeAny ? { body:   z.infer<R["body"]>   } : object);

export type ClientMethod<R extends Route> = keyof Declared<R> extends never
  ? () => Promise<HandlerResult<R>>
  : (input: Declared<R>) => Promise<HandlerResult<R>>;

export type WhatsAppApiClient = { [K in keyof Routes]: ClientMethod<Routes[K]> };
export function createClient(opts: {
  baseUrl: string; token?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number;
}): WhatsAppApiClient;
```

A binary route's handler returns `{ bytes: Uint8Array; mimeType: string; filename?: string; disposition?: "inline" | "attachment" }`; the client returns the same shape. A JSON route's handler
returns `z.infer<schema>` and the client `.parse`s the response.

`implement()` returns route bindings rather than mounting them, so `packages/api` keeps ownership of
Express, middleware order and the auth gate. `Handlers` being an exhaustive mapped type over
`Routes` is what makes a missing handler a compile error — do not weaken it to `Partial`.

The full route list is spec §4, with one **deliberate deviation**: spec §5.1's single
`GET /v1/media/:chat/:id?as=…` is split into one route per representation (Task 9). A single route
whose `response` is `JsonResponse | BinaryResponse` makes `HandlerResult<R>` evaluate to `never` —
`R["response"]` is an indexed access, not a naked type parameter, so the union distributes over
neither conditional branch. The alternatives were a distributive helper returning a union the caller
must narrow at runtime (which defeats a typed SDK) or separate entries. Separate entries also keep
the `method + path` uniqueness invariant, which query-param routing cannot: Express does not route
on `?as=`.

**The table holds exactly 24 operations**, and the arithmetic is worth stating because implementers
use it as a checklist: 6 reads (`listChats`, `listGroups`, `listContacts`, `listMessages`,
`searchMessages`, `getMessage`) + 7 media (`raw`, `jpeg`, `link`, `keyframes`, `text`, `transcript`,
`meta`) + 8 writes (`sendText`, `sendFile`, `editMessage`, `deleteMessage`, `react`, `markRead`,
`transcribe`, `resolveRecipient`) + `capabilities` + `getHealth` + `fetchSignedMedia` = 24.

**`getHealth` and `fetchSignedMedia` belong in the table even though they are unauthenticated.** An
earlier draft pulled them out and collapsed `auth` to a single literal; that was wrong, and the way
it was wrong is instructive. The generated client is `{ [K in keyof Routes]: ClientMethod<Routes[K]> }`
— so a route absent from the table has no client method, and Task 14's `whatsapp_health` calls
`client.getHealth()`. Removing it from the table makes `packages/mcp` fail to compile. Routes carry
`auth` and the mounting code partitions on it (Task 7); that keeps one source of truth instead of a
table plus a set of hand-written exceptions.

**Client behaviour:**
- Request bodies and queries are validated before send.
- A non-2xx response is parsed with `wireError` and thrown via `errorFromWire`.
- A `fetch` rejection (DNS, ECONNREFUSED, timeout) becomes `ApiUnreachableError`, never
  `NotConnectedError` — those two mean different things and the MCP surfaces them differently.
- `timeoutMs` uses `AbortSignal.timeout`.
- **Every request carries an `x-request-id` header**, generated by the client when absent. The split
  turns one greppable log stream into two independent pino streams, and without a shared id an
  MCP-side tool failure caused by an API-side 500 cannot be tied to its cause. Both sides log it on
  every request and every error. It costs a header and a `randomUUID()`; recovering the correlation
  after the fact costs an afternoon per incident.

- [ ] **Step 1: Write the failing test**

```ts
void test("the client parses a page and returns typed rows", async () => {
  const client = createClient({ baseUrl: "http://x", token: "t", fetch: async () =>
    new Response(JSON.stringify({ nextCursor: null, items: [] }), { status: 200,
      headers: { "content-type": "application/json" } }) });
  const page = await client.listChats({ query: { limit: 5 } });
  assert.deepEqual(page, { nextCursor: null, items: [] });
});

void test("a transport failure is ApiUnreachableError, not NotConnectedError", async () => {
  const client = createClient({ baseUrl: "http://x", fetch: () => Promise.reject(new TypeError("fetch failed")) });
  await assert.rejects(() => client.listChats({ query: {} }), (e: unknown) => e instanceof ApiUnreachableError);
});

void test("every route in the table has a unique method+path", () => {
  const seen = new Set<string>();
  for (const r of Object.values(routes)) {
    const key = `${r.method} ${r.path}`;
    assert.ok(!seen.has(key), `duplicate route ${key}`);
    seen.add(key);
  }
});
```

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement** requests schemas, the route table, `implement()`, `createClient()`.
- [ ] **Step 4: Run and see it pass.**
- [ ] **Step 5: Commit** — `feat(sdk): route table, typed client, and the implement() seam`

---

### Task 4: Schema V3 — persist the transcript's language

**Files:**
- Modify: `packages/api/src/db/schema.ts`, `packages/api/src/db/messages.ts`,
  `packages/api/src/media/transcribe.ts` callers (`media/autotranscribe.ts`,
  `mcp/tools/media.ts:290`)
- Modify (**test call sites — verified by grep, all still on the 4-arg positional form; miss one and
  Task 4's own acceptance step goes red**): `packages/api/src/db/messages.test.ts`,
  `packages/api/src/mcp/server.test.ts:540`, `packages/api/src/mcp/tools/reads.test.ts:525,562,563`,
  `packages/api/src/media/autotranscribe.test.ts:331`, `packages/api/src/media/bias.test.ts:107`
- Do **not** modify `mcp/health.ts`: it reads `meta.schemaVersion()` dynamically, so bumping the
  constant needs no edit there. An earlier draft listed it; that was wrong.
- Test: `packages/api/src/db/messages.test.ts`, `packages/api/src/db/client.test.ts`

The signature changes from four positional arguments to an object, which is a compile error under
TS strict at every old call site rather than a silent behaviour change — that is the good case, but
only if the Files list is complete.

**Why:** the spec's `as=transcript` representation returns `{ text, model, language }`, but
`MessageRow` has `transcript` and `transcriptModel` and **no language column**. The backend
`Transcribed` type carries `language` and the persist path drops it, so the field could never
populate. Rather than delete the field from the contract, persist the data that already exists.

**Interfaces:**
- Consumes: `Transcript = { text: string; model: string; language: string | null }` from
  `media/transcribe.ts`.
- Produces: `MessageRow` gains `transcriptLanguage: string | null`.
  `MessagesRepo.setTranscript` signature becomes
  `setTranscript(chatId: string, messageId: string, t: { text: string; model: string; language: string | null }): void`.

**Critical:** `setTranscript` must keep writing through the repository so the FTS UPDATE trigger
fires (Global Constraint 9). Adding a column does not change that, but changing the write path would.
Bump `SCHEMA_VERSION` to 3 and add the migration beside the existing V1→V2 one; migrations are
forward-only and must be idempotent on an already-migrated store.

- [ ] **Step 1: Write the failing test**

```ts
void test("a transcript's language survives a round trip", () => {
  const { messages } = repos();
  seedMessage(messages, { id: "M1", chat: "c", kind: "audio" });
  messages.setTranscript("c", "M1", { text: "bonjour", model: "voxtral", language: "fr" });
  assert.equal(messages.get("c", "M1")?.transcriptLanguage, "fr");
});

void test("an older store migrates to V3 without losing transcripts", () => {
  // open a V2 store with a transcript, reopen, assert schemaVersion === 3 and the text survives
});
```

- [ ] **Step 2: Run and see it fail** — expect `transcriptLanguage` to be undefined.
- [ ] **Step 3: Implement** the migration, the column, the row mapping, the setter, and update
  every caller of `setTranscript`.
- [ ] **Step 4: Run and see it pass** — `pnpm --filter whatsapp-api test`.
- [ ] **Step 5: Commit** — `feat(db): schema V3 persists a transcript's language`

---

### Task 5: `convert.ts` produces the shapes the API needs

**Files:**
- Modify: `packages/api/src/media/convert.ts`
- Test: `packages/api/src/media/convert.test.ts`

**Why:** the scouts confirmed the existing functions return MCP-shaped values, not API-shaped ones.
`imageBlock` returns base64 in an `ImageBlock`; `videoKeyframes` returns `ImageBlock[]` with no
`index`/`atSec`; `pdfText` truncates silently with no flag. The API serves binary and structured
JSON, so it needs bytes and metadata.

**Interfaces — Produces (additive; existing exports stay so nothing else breaks yet):**

```ts
export type JpegBytes = { bytes: Buffer; mimeType: "image/jpeg"; width: number; height: number };
export async function imageJpeg(path: string, opts: { maxBytes: number; maxEdge?: number }): Promise<JpegBytes>;

export type Keyframe = { index: number; atSec: number; bytes: Buffer; mimeType: "image/jpeg" };
export async function keyframes(path: string, opts: { count: number; maxBytes: number }): Promise<{ durationSec: number; frames: Keyframe[] }>;

export type PdfExtract = { text: string; truncated: boolean };
export async function pdfExtract(path: string, maxChars: number): Promise<PdfExtract>;
```

`keyframes` derives `atSec` from the existing pure, already-exported `keyframeTimestamps` helper —
do not recompute the spacing a second way, or the strip and its labels will disagree. Keep the two
existing rules: every external process carries a timeout (`runTool` is the only spawn point), and
every size loop provably terminates (halve the longest edge to a floor, then return the smallest
attempt rather than chasing an unreachable cap).

`imageBlock` and `videoKeyframes` are *not* deleted in this task — `packages/api/src/mcp/tools/media.ts`
still uses them until Task 16 removes the in-process MCP. Delete them there.

- [ ] **Step 1: Write the failing test**

```ts
void test("keyframes carry their index and timestamp, in order", async () => {
  const mp4 = await fixtureVideo(6);
  const { durationSec, frames } = await keyframes(mp4, { count: 3, maxBytes: 5 * 1024 * 1024 });
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((f) => f.index), [0, 1, 2]);
  assert.ok(frames.every((f) => f.atSec >= 0 && f.atSec <= durationSec));
  assert.ok(frames.every((f) => Buffer.isBuffer(f.bytes) && f.bytes.length > 0));
});

void test("pdfExtract reports truncation rather than hiding it", async () => {
  const pdf = await fixturePdfWithChars(5000);
  const out = await pdfExtract(pdf, 100);
  assert.equal(out.text.length, 100);
  assert.equal(out.truncated, true);
});
```

- [ ] **Step 2: Run and see it fail** (in the container — these need real ffmpeg).
- [ ] **Step 3: Implement** the three functions.
- [ ] **Step 4: Run and see it pass.**
- [ ] **Step 5: Commit** — `feat(media): byte-returning conversions for the REST layer`

---

### Task 6: Signed media links

**Files:**
- Create: `packages/api/src/rest/medialink.ts`
- Test: `packages/api/src/rest/medialink.test.ts`
- Modify: `packages/api/src/config.ts` (add `mediaLinkTtlSec`)

**Interfaces — Produces:**

```ts
export type LinkPayload = { s: string; r: MediaRepresentation; m: string; f: string; e: number };
export type MediaLinkSigner = {
  mint: (p: Omit<LinkPayload, "e">) => { token: string; expiresAt: number };
  verify: (token: string) => LinkPayload;   // throws ApiError("not_found") on any failure
};
export function makeMediaLinkSigner(deps: { apiToken: string | undefined; ttlSec: number; now?: () => number }): MediaLinkSigner;
```

**Token format** — `v1.<base64url(payload)>.<base64url(hmac)>`, where the HMAC is SHA-256 over the
literal bytes `"v1." + payload`, keyed by HKDF over `WHATSAPP_API_TOKEN`. A MAC verifies data, it
does not carry it, so the payload must travel in the token or the download route has nothing to
resolve.

**Security requirements, all testable:**
1. **Verification order is fixed**: parse version → recompute MAC → `timingSafeEqual` → *then* check
   expiry. Checking expiry first gives a forged token a different error than a stale one, which is a
   free distinguishing oracle.
2. **The payload names a sha256, never a JID.** A chat id is a phone number, and this URL exists to
   be shared. Keying on the content hash carries no identity.
3. When `apiToken` is undefined, derive from 32 random bytes generated at construction, so links do
   not survive a restart. Log that fact once at boot.
4. `verify` throws the *same* `not_found` error for a bad MAC, a bad version, malformed base64 and an
   expired token — never a distinguishing message.
5. **The token is never logged — but the request must still be observable.** "Never logged" plus no
   rate limit means a validly-minted, still-live link can be fetched without bound and an operator
   has no way to notice. Forgery is thoroughly handled above; *volume abuse of a real link* is not.
   So: log a redacted access record — the sha256's first 8 hex characters, the representation, the
   outcome, and the timestamp — never the token, never the URL, never the chat. And rate-limit the
   route per token (a small fixed ceiling per TTL window is enough; the link is meant for one or two
   fetches, not a hundred). It is the only unauthenticated route that serves **conversation
   content** — `GET /health` is also unauthenticated, but returns a closed record with no secrets
   and no message data.
6. **`X-Content-Type-Options: nosniff` on every media response**, and `Content-Disposition:
   attachment` for anything that is not an image, audio or video type. WhatsApp attachments include
   browser-renderable types such as SVG and HTML; serving one unauthenticated, with a
   browser-trusted `Content-Type` and no sniffing guard, turns the media cache into a hosting
   provider for stored XSS against whoever opens the link.

- [ ] **Step 1: Write the failing test**

```ts
void test("a tampered payload is refused", () => {
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 900 });
  const { token } = s.mint({ s: "a".repeat(64), r: "raw", m: "image/jpeg", f: "x.jpg" });
  const [v, payload, mac] = token.split(".");
  const forged = [v, Buffer.from('{"s":"b"}').toString("base64url"), mac].join(".");
  assert.throws(() => s.verify(forged), /not_found/);
});

void test("an expired token and a forged token are indistinguishable", () => {
  let now = 1000;
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 10, now: () => now });
  const { token } = s.mint({ s: "a".repeat(64), r: "raw", m: "image/jpeg", f: "x.jpg" });
  now = 5000;
  const expired = (() => { try { s.verify(token); return null; } catch (e) { return (e as Error).message; } })();
  const forged = (() => { try { s.verify("v1.aaaa.bbbb"); return null; } catch (e) { return (e as Error).message; } })();
  assert.equal(expired, forged);
});

void test("the payload carries no chat id or phone number", () => {
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 900 });
  const { token } = s.mint({ s: "a".repeat(64), r: "raw", m: "image/jpeg", f: "x.jpg" });
  const payload = Buffer.from(token.split(".")[1]!, "base64url").toString("utf8");
  assert.doesNotMatch(payload, /@|\d{8,}/);
});
```

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see it pass.**
- [ ] **Step 5: Commit** — `feat(api): signed, self-describing media download tokens`

---

### Task 7: REST plumbing — cursor, presenters, Express skeleton, health and capabilities

**Files:**
- Move: `packages/api/src/mcp/cursor.ts` → `packages/api/src/rest/cursor.ts` (encoding unchanged)
- Create: `packages/api/src/rest/present.ts`, `packages/api/src/rest/server.ts`,
  `packages/api/src/rest/handlers/meta.ts`
- Test: `packages/api/src/rest/present.test.ts`, `packages/api/src/rest/server.test.ts`

**Interfaces — Produces:**

```ts
export function presentMessage(m: MessageRow, deps: { contacts: ContactsRepo }, reactionCount: number): sdk.Message;
// `SearchHit` here is the DB row from `db/messages.ts`; `sdk.SearchHit` is the wire type from
// Task 2. They are deliberately different shapes — import the SDK one aliased to avoid a clash.
export function presentSearchHit(h: SearchHit, deps: { contacts: ContactsRepo }, reactionCount: number): sdk.SearchHit;
export function presentChat(c: ChatRow, deps: { contacts: ContactsRepo }): sdk.Chat;
export function presentContact(c: ContactRow): sdk.Contact;
export function reactionCounts(reactions: ReactionsRepo, rows: readonly { chatId: string; id: string }[]): Map<string, number>;

export type RestDeps = {
  config: Config;
  logger: Logger;
  chats: ChatsRepo; contacts: ContactsRepo; messages: MessagesRepo;
  reactions: ReactionsRepo; meta: MetaRepo;
  conn: WhatsAppConnection;
  sender: Sender;
  media: MediaStore;
  transcriber: Transcriber;
  links: MediaLinkSigner;
  biasTermsFor: (chatId: string) => readonly string[];
  autoTranscriber?: AutoTranscriber | undefined;
};
export type RestHandle = {
  url: string;
  close: () => Promise<void>;
};
export function startRest(deps: RestDeps): Promise<RestHandle>;
```

**Denormalisation is the point** (spec §4.1). `presentMessage` resolves the sender's display name and
takes an already-batched reaction count. `reactionCounts` issues **one** grouped query per page via
`reactions.countsFor(keys)` — never one per row. Carry over the existing `(chatId, messageId)`
composite key joined by `\u0000`, because a message id is only unique within its chat.

**Middleware order is load-bearing** and mirrors today's `http.ts`. Every route comes from
`implement()`; the order is produced by **partitioning the bindings on `binding.auth`**, not by
hand-mounting exceptions:

1. Bindings where `auth !== "bearer"` — today that is `getHealth` (`GET /health`) and
   `fetchSignedMedia` (`GET /media/dl/:token`). Mounted first, so no gate applies.
2. Bearer gate on `/v1` (constant-time compare, `WWW-Authenticate: Bearer` on 401).
3. `express.json` mounted **on `/v1` behind the gate**, so an anonymous `POST /anything` cannot make
   the server buffer and parse ~90 MB. Limit is `maxUploadBytes` + base64 overhead + 1 MiB.
4. Bindings where `auth === "bearer"` — the other 22.
5. Four-argument error middleware last — arity is how Express identifies it. Map `ApiError` → its
   status + `errorToWire`; anything else → 500 `internal`. Log `errorDetail(err)`, never the raw
   error object (Global Constraint 6).

**`GET /media/dl/:token` sits outside `/v1` by path, and that is separate from its `auth` value.**
A route `GET /v1/media/:chat/:id` also matches `/v1/media/dl/<token>` with `chat = "dl"`, so had the
download stayed under `/v1` the two would shadow each other depending on registration order. The
distinct prefix removes the hazard structurally rather than by ordering — no `:chat` pattern can
match it. Partitioning by `auth` then handles the gate, and the two mechanisms are independent:
one prevents shadowing, the other prevents a 401.

Two tests, because each catches a different regression: one fetching an actual minted URL end to end
(Task 9) to catch shadowing, and one asserting `GET /health` answers 200 with no `Authorization`
header while `GET /v1/chats` answers 401.

`GET /health` returns the existing `HealthReport` shape unchanged. `GET /v1/capabilities` returns
`{ readOnly, apiVersion, features }`.

- [ ] **Step 1: Write the failing test**

```ts
void test("/health answers without a bearer token", async () => {
  const h = await startRest(testDeps({ apiToken: "secret" }));
  const res = await fetch(`${h.url}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  await h.close();
});

void test("a /v1 route without a bearer token is refused and names no secret", async () => {
  const h = await startRest(testDeps({ apiToken: "secret" }));
  const res = await fetch(`${h.url}/v1/chats`);
  assert.equal(res.status, 401);
  assert.doesNotMatch(await res.text(), /secret/);
  await h.close();
});

void test("a page of messages costs one reaction query, not one per row", () => {
  const { spy, reactions } = countingReactions();
  presentPage(rowsOfLength(50), { contacts, reactions });
  assert.equal(spy.calls, 1);
});
```

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see it pass.**
- [ ] **Step 5: Commit** — `feat(api): REST skeleton, presenters, health and capabilities`

---

### Task 8: Read routes

**Files:**
- Create: `packages/api/src/rest/handlers/reads.ts`
- Test: `packages/api/src/rest/handlers/reads.test.ts`

**Interfaces — Consumes:** `routes` (Task 3), presenters and cursor (Task 7).
**Produces:** handlers for `listChats`, `listGroups`, `listContacts`, `listMessages`,
`searchMessages`, `getMessage`.

**`getMessage` returns `MessageDetail`, not `Message`.** `whatsapp_download_media`'s summary embeds
the full per-reactor array `{ emoji, from: { id, name } }[]` (`src/mcp/tools/media.ts`, `summaryOf`
→ `presentReactions(ctx.reactions.forMessage(...))`), which is a different thing from the batched
`reactionCount` that list and search carry. Returning plain `Message` here would drop that array and
silently change the tool's output — a Global Constraint 2 violation that no type would catch,
because the field would simply be absent. So this handler calls `reactions.forMessage(chatId, id)`
and populates `reactions`, while list and search keep using the batched `countsFor` path.

Filters map one-to-one onto the existing `MessageFilter`. The `kind`/`has_media` contradiction
(`kind: "text"` with `hasMedia: true`) is refused with `bad_request` rather than answered with an
empty page — an empty page reads as "there are none", which is a different and wrong answer.

Pagination: the `limit+1` overfetch that turns raw `(limit, offset)` into `{ items, nextCursor }`
moves out of the old `mcp/tools/reads.ts::paginate` and into this layer. A malformed cursor is
`bad_request`, never a silent reset to offset 0 — silently restarting a walk is how a model loops
over page 1 forever believing it is progressing.

Every id arriving from a client passes through `canonicalId` here, at the API boundary. This is the
only layer allowed to do it (Global Constraint 3).

- [ ] **Step 1: Write the failing test**

```ts
void test("a contradictory kind/hasMedia pair is refused, not answered empty", async () => {
  const res = await api.get("/v1/messages?kind=text&hasMedia=true");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "bad_request");
});

void test("a malformed cursor is an error, never a reset to the first page", async () => {
  const res = await api.get("/v1/chats?cursor=not-a-cursor");
  assert.equal(res.status, 400);
});

void test("reads answer while the socket is down", async () => {
  const api = await testApi({ connectionState: "disconnected" });
  assert.equal((await api.get("/v1/chats")).status, 200);
});
```

- [ ] **Step 2–4: fail → implement → pass.**
- [ ] **Step 5: Commit** — `feat(api): read routes`

---

### Task 9: Media routes and the signed download

**Files:**
- Create: `packages/api/src/rest/handlers/media.ts`
- Test: `packages/api/src/rest/handlers/media.test.ts`

**Interfaces — Consumes:** `MediaStore.fetch/pathFor`, Task 5's conversions, Task 6's signer.
**Produces:** seven media routes plus the signed download.

Representation → route. This replaces spec §5.1's single `?as=` endpoint, for the typing reason in
Task 3; the representations themselves are unchanged.

| route | response | produced by |
| --- | --- | --- |
| `GET /v1/media/:chat/:id` | binary, `?disposition=attachment\|inline` | `MediaStore.fetch` |
| `GET /v1/media/:chat/:id/jpeg` | JSON `{ data, mimeType, width, height, source }` | `imageJpeg`, base64 |
| `GET /v1/media/:chat/:id/link` | JSON `{ url, expiresAt, mimeType, bytes, filename }` | Task 6 signer |
| `GET /v1/media/:chat/:id/keyframes` | JSON `{ durationSec, width, height, frames: [{ index, atSec, mimeType, data }], source }` | `keyframes`, base64 |
| `GET /v1/media/:chat/:id/text` | JSON `{ text, truncated }` | `pdfExtract` |
| `GET /v1/media/:chat/:id/transcript` | JSON `{ text, model, language } \| null` | `MessageRow` (Task 4) |
| `GET /v1/media/:chat/:id/meta` | JSON `{ mimetype, bytes, width, height, durationSec, hasTranscript, sha256 }` | row + `probeDimensions`/`probeDuration` |
| `GET /media/dl/:token` | binary, public | Task 6 signer — note: **not** under `/v1`, see Task 7 |

`source` is `{ bytes: number, mimetype: string }` — the size and type of the **original** attachment,
not of the derivative.

**Why `/jpeg` is JSON rather than binary, and why `source` exists at all.** Today's
`whatsapp_download_media` summary reports `mimetype` and `bytes` on every branch and `width`/`height`
on the image and video branches, all read from the `MediaFile` and `probeDimensions` in-process. None
of that survives a binary response: `BinaryPayload` carries the derivative's bytes and mime type and
nothing about the source. An implementer would then either drop those fields — a Global Constraint 2
violation on the two heaviest branches — or make a second `/meta` call that this plan elsewhere
forbids. Embedding the metadata alongside base64 `data` keeps one call per branch and reproduces the
summary exactly. It costs a UI the ability to `<img src>` a resized derivative directly; the raw
route still serves the original, and a binary thumbnail endpoint is listed under deferrals.

Each route has exactly one response kind, so each SDK client method has one concrete return type and
no caller narrows anything.

`MediaRepresentation` (Task 2) survives as the enum stamped into a signed token's payload — the token
still has to say which representation it points at — it is simply no longer a query parameter.

`/link` **must resolve and cache the attachment at mint time**, so a link that cannot be produced
fails in front of the caller rather than 404-ing for whoever it was sent to. That is also what lets
the token key on a sha256 instead of a chat id.

`/transcript` reads cache only and never spends money. Triggering transcription is a separate
write route (Task 10) — that is what preserves the two-lane rule, since the lane is a property of
the call site.

`maxBytes` / `maxEdge` / `frames` are optional query parameters on the routes that use them; the
API's configured values are both the defaults and the ceilings, so a client cannot request a 4K strip.

- [ ] **Step 1: Write the failing test**

```ts
void test("a signed link round-trips to the bytes, without a bearer token", async () => {
  const { url } = await api.getJson(`/v1/media/${CHAT}/${MSG}/link`);
  const res = await fetch(url);                      // no Authorization header
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
});

void test("/keyframes returns indexed frames, not one binary blob", async () => {
  const body = await api.getJson(`/v1/media/${CHAT}/${VIDEO}/keyframes?frames=3`);
  assert.equal(body.frames.length, 3);
  assert.deepEqual(body.frames.map((f) => f.index), [0, 1, 2]);
});

void test("/transcript never triggers transcription", async () => {
  const { calls } = transcriberSpy();
  await api.getJson(`/v1/media/${CHAT}/${AUDIO}/transcript`);
  assert.equal(calls, 0);
});

void test("a cache miss with the socket down is media_unavailable, not a hang", async () => {
  const api = await testApi({ connectionState: "disconnected" });
  const res = await api.get(`/v1/media/${CHAT}/${UNCACHED}`);
  assert.equal(res.status, 503);
});

void test("the raw route can be forced to download rather than render", async () => {
  const res = await api.get(`/v1/media/${CHAT}/${MSG}?disposition=attachment`);
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename=/);
});
```

- [ ] **Step 2–4: fail → implement → pass.**
- [ ] **Step 5: Commit** — `feat(api): media representations and signed downloads`

---

### Task 10: Write routes, recipient resolution, transcription

**Files:**
- Create: `packages/api/src/rest/handlers/writes.ts`
- Test: `packages/api/src/rest/handlers/writes.test.ts`

**Produces:** `sendText`, `sendFile`, `editMessage`, `deleteMessage`, `react`, `markRead`,
`transcribe`, `resolveRecipient`.

`readOnly` is enforced **here**, returning `403 read_only`, regardless of what any client believes —
a separate process cannot be trusted to police itself. The MCP additionally *discovers* it (Task 14)
so it never advertises a tool that cannot work, but that is a UX nicety layered on top of this gate.

Ambiguity surfaces as `409 ambiguous_recipient` with
`details.candidates: [{ index, id, label, exact }]`, 1-based, in the resolver's existing total order
(Global Constraint 11). `POST /v1/recipients/resolve` exposes the same resolution without sending.

`sendFile` accepts base64 in the JSON body. `path` remains gated behind `WHATSAPP_SEND_FILE_DIR`,
unset by default, resolved through symlinks and confined to that directory; a refusal never echoes
the path it was asked to read.

- [ ] **Step 1: Write the failing test**

```ts
void test("an ambiguous recipient is refused with numbered candidates", async () => {
  const res = await api.post("/v1/messages", { recipient: "Marie", text: "hi" });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, "ambiguous_recipient");
  assert.deepEqual(body.error.details.candidates.map((c) => c.index), [1, 2]);
});

void test("a read-only deployment refuses a write even when asked directly", async () => {
  const api = await testApi({ readOnly: true });
  assert.equal((await api.post("/v1/messages", { recipient: CHAT, text: "hi" })).status, 403);
});

void test("path sending is refused when no directory is configured, without echoing the path", async () => {
  const res = await api.post("/v1/messages/file", { recipient: CHAT, path: "/proc/self/environ" });
  assert.equal(res.status, 400);
  assert.doesNotMatch(await res.text(), /proc/);
});
```

- [ ] **Step 2–4: fail → implement → pass.**
- [ ] **Step 5: Commit** — `feat(api): write routes, recipient resolution, transcription`

---

### Task 11: API bootstrap and config split, REST alongside MCP

**Files:**
- Modify: `packages/api/src/main.ts`, `packages/api/src/config.ts`
- Test: `packages/api/src/main.test.ts`

**The product must keep working.** This task mounts the REST server **in addition to** the existing
in-process MCP surface. Both answer from the same domain objects, which is what makes Task 15's
comparison possible. The in-process MCP is removed in Task 16 and not before.

Config keeps every existing API variable and adds `WHATSAPP_API_TOKEN` and
`WHATSAPP_MEDIA_LINK_TTL` (default 900, clamped `[60, 86400]`). Invalid numbers fall back to the
default rather than failing the boot; `WHATSAPP_PHONE_NUMBER` stays the one exception that throws.

Shutdown order gains the REST handle and keeps the existing dependency order: stop accepting
requests, stop the socket, stop alerting, close the store.

- [ ] **Step 1: Write the failing test**

"Share one store" needs an operational definition, or two engineers will test two different things.
It means: a write through REST is visible to the very next in-process MCP tool call, in the same
process, against the same `Db` handle.

```ts
void test("a REST write is visible to the in-process MCP surface immediately", async () => {
  const app = await bootBoth({ seed: (r) => seedChat(r, ALICE) });
  await app.rest.post("/v1/chats/" + ALICE + "/read", { messageId: "M1" });
  const page = resultPage(await app.mcp.callTool({ name: "whatsapp_chats_list", arguments: {} }));
  assert.equal(page.items[0]!["unread_count"], 0);
  await app.close();
});

void test("both surfaces are listening and neither shadows the other", async () => {
  const app = await bootBoth({});
  assert.equal((await fetch(`${app.url}/health`)).status, 200);
  assert.equal((await app.mcp.listTools()).tools.length, 14);
  await app.close();
});
```
- [ ] **Step 2–4: fail → implement → pass.**
- [ ] **Step 5: Commit** — `feat(api): mount REST beside the existing MCP surface`

---

### Task 12: MCP package skeleton — config, logger, http, health

**Files:**
- Create: `packages/mcp/src/{config,logger,version,context,health,main}.ts`,
  `packages/mcp/src/http.ts`, `packages/mcp/tsconfig.build.json`
- Test: `packages/mcp/src/http.test.ts`, `packages/mcp/src/config.test.ts`

**Interfaces — Produces:**

```ts
export type ToolContext = { config: McpConfig; logger: Logger; client: WhatsAppApiClient };
export type McpConfig = {
  apiUrl: string; apiToken: string | undefined; mcpToken: string | undefined;
  httpPath: string; port: number; sessionTtlMs: number; maxResultChars: number;
  /** From WHATSAPP_MCP_REQUEST_TIMEOUT_MS, default 30000, clamped [1000, 300000]. Feeds
   *  createClient({ timeoutMs }). Not in spec §9's table — recorded as a deviation. */
  requestTimeoutMs: number;
};
```

`ToolContext` collapses from thirteen fields to three. Nothing else may be added to it — a tool that
needs data grows an SDK call, not a context field.

**`http.ts` is ported near-verbatim** from `packages/api/src/http.ts` with one change:
`HttpDeps.buildServer` becomes `() => Promise<McpServer>`.

**Be precise about what the risk is, because an earlier draft of this plan overstated it.** There is
**no bug today**: at `src/http.ts:253-259` both `const server = buildServer()` and the
`new StreamableHTTPServerTransport({...})` that follows sit *outside* any `try`, and the synchronous
call cannot reject, so the later `try`/`finally` is always entered with both bound. The hazard is
created *by this change*, not uncovered by it — once the call is awaited it can reject, and then
`transport` is never constructed.

So the requirement is narrow and concrete:

1. `await buildServer()` and the transport construction move inside the `try`.
2. The `finally` currently reads `transport.sessionId` unconditionally. It must guard on the binding
   existing — `if (transport !== undefined && transport.sessionId === undefined)` — or a rejected
   build throws a `ReferenceError`/`TypeError` from the cleanup path and masks the real error.
3. A build rejection returns its own JSON-RPC error response and registers no session.

`wrap()` already forwards a rejection through `next(err)` when nothing has been written, so the
existing four-argument error middleware handles the response — provided the throw happens before any
write, which it does. Everything else — `/health` before the gate, `express.json` on the MCP path
behind it, the session map, the unref'd sweeper, `closeAllConnections` on shutdown — is unchanged.

`health.ts` merges the API's `/health` with the MCP's own reachability:

```ts
export type McpHealthReport = HealthReport & {
  api: { reachable: boolean; latencyMs: number | null; url: string; error: string | null };
};
```

`api.url` must be the configured base URL with any credentials stripped, and `api.error` a
`describeError` string, never a raw error.

**`ok` keeps the API's meaning exactly, and this is a contract requirement, not a preference.**
`buildHealth` today sets `ok: snap.state !== "logged_out"`, and the `whatsapp_health` tool's
description — which Task 14 copies verbatim — says "`ok` is false only when the account has been
logged out, which needs a human to re-pair." Making `ok` also mean "and the API answered" would
silently redefine a field whose own description rules that out, and it is not one of Global
Constraint 2's three exceptions.

So the two consumers diverge deliberately:

| consumer | API reachable | API unreachable |
| --- | --- | --- |
| `whatsapp_health` **tool** | merged report; `ok` is the API's own value | **`isError` result** carrying `ApiUnreachableError`'s text — never a report with invented fields |
| MCP `GET /health` (container probe) | `ok` mirrors the API's | `ok: false` — an MCP that cannot reach its API is genuinely unhealthy |

Fabricating a `connection`, `counts` or `schema_version` for a report the API never returned would
be worse than failing: it invents state the model would then reason about.

- [ ] **Step 1: Write the failing test**

```ts
void test("a rejecting buildServer answers with an error and leaks no session", async () => {
  const h = await startHttp({ ...deps, buildServer: () => Promise.reject(new Error("boom")) });
  const res = await fetch(`${h.url}/mcp`, { method: "POST", body: initializeBody(), headers: initHeaders() });
  assert.equal(res.status, 500);
  assert.equal(h.sessionCount(), 0);
  await h.close();
});

void test("the container probe is unhealthy when the API cannot be reached", async () => {
  const ctx = ctxWith({ fetch: () => Promise.reject(new TypeError("fetch failed")) });
  const report = await buildProbe(ctx);
  assert.equal(report.api.reachable, false);
  assert.equal(report.ok, false);
});

void test("a disconnected-but-reachable API leaves ok true, exactly as before the split", async () => {
  const ctx = ctxWith({ health: { ...healthFixture, ok: true, connection: "disconnected" } });
  const report = await buildProbe(ctx);
  assert.equal(report.ok, true);
  assert.equal(report.api.reachable, true);
});
```

- [ ] **Step 2–4: fail → implement → pass.**
- [ ] **Step 5: Commit** — `feat(mcp): package skeleton, async buildServer, merged health`

---

### Task 13: MCP result shaping against SDK types

**Files:**
- Create: `packages/mcp/src/result.ts`
- Test: `packages/mcp/src/result.test.ts`

**This task is where "byte-identical output" is won or lost.** `result.ts` moves across almost
unchanged, but the `present*` functions now take **SDK domain objects** (camelCase, already
denormalised) instead of `MessageRow` + a `ContactsRepo`. Their job shrinks to renaming into the
snake_case the model already sees, and it must be exact:

```ts
export function presentMessage(m: SdkMessage): Record<string, unknown> {
  return {
    id: m.id, chat: m.chat, ts: m.ts, from_me: m.fromMe,
    sender: { id: m.sender.id, name: m.sender.name },
    kind: m.kind, text: m.text, transcript: m.transcript, quoted_id: m.quotedId,
    status: m.status, edited: m.edited, deleted: m.deleted,
    media: m.media === null ? null : { type: m.media.type, cached: m.media.cached },
  };
}
```

Key order matters for nothing functionally, but the **`{ next_cursor, items }` envelope must keep
serialising `next_cursor` first** — it is deliberately ahead of `items` so a truncated page still
shows the cursor. `jsonResult`, `textResult`, `errorResult`, `failedResult` and `describeError` move
verbatim; `describeError` is what renders SDK errors into model-visible text, which is why Task 2
pinned their `name` values.

- [ ] **Step 1: Write the failing test** — assert `presentMessage` output deep-equals a golden object
  captured from the current implementation, field for field.
- [ ] **Step 2–4: fail → implement → pass.**
- [ ] **Step 5: Commit** — `feat(mcp): result shaping over SDK domain types`

---

### Task 14: The 14 tools, over the SDK client

**Files:**
- Create: `packages/mcp/src/tools/{reads,media,writes}.ts`, `packages/mcp/src/server.ts`
- Test: covered by Task 15's ported suite

**Interfaces — Produces:**
`registerReadTools(server, ctx)`, `registerMediaTools(server, ctx)`, `registerWriteTools(server, ctx)`,
`buildMcpServer(ctx, caps: Capabilities): McpServer`.

Every tool's Zod input schema is **copied verbatim** from
`packages/api/src/mcp/tools/*.ts` — including every `.describe()` string, `limitSchema`'s
`.max(200).default(50)`, and the fact that `whatsapp_react`'s `emoji` has **no** `.min(1)` because an
empty string is how a reaction is removed. Do not "improve" a description; the tests and the README
both pin them.

Tool → SDK call mapping:

| tool | call |
| --- | --- |
| `whatsapp_health` | `getHealth()` + reachability (Task 12) |
| `whatsapp_chats_list` / `groups_list` / `contacts_search` | `listChats` / `listGroups` / `listContacts` |
| `whatsapp_messages_list` / `messages_search` | `listMessages` / `searchMessages` |
| `whatsapp_download_media` | `getMessage` + one `fetchMedia` by kind |
| `whatsapp_transcribe` | `transcribe` |
| the six writes | the matching write routes |

`whatsapp_download_media` branches by media kind, exactly as today, each branch calling the one
media route that serves it. Every branch must be able to reproduce `summaryOf`'s **unconditional**
`mimetype` and `bytes` fields, which is what dictates the calls below — several branches need
`fetchMediaMeta` purely for those two, and leaving it out makes them unreachable:

| branch | calls | why |
| --- | --- | --- |
| image / sticker | `fetchMediaJpeg` | carries `source.bytes`/`source.mimetype` + `width`/`height` |
| video | `fetchMediaKeyframes` | same, plus `durationSec`; transcript comes from `MessageDetail.transcript` — **not** a second `fetchMediaTranscript` call, which would be a redundant round trip and a second source of truth for the same value |
| audio, transcript cached | `fetchMediaTranscript` **+ `fetchMediaMeta`** | `/transcript` carries no `bytes`; without `/meta` the summary loses it |
| audio, no transcript | `fetchMediaMeta` | `duration_sec`, `bytes`, `mimetype` |
| PDF | `fetchMediaText` **+ `fetchMediaLink`** | `/text` carries only `{ text, truncated }`; `/link` supplies `url`, `mimeType` and `bytes` — and point 1 below requires the PDF branch to carry `url` too |
| any other document | `fetchMediaLink` | `url`, `mimeType`, `bytes` |

"One call per branch" was the earlier framing and it was too strong — three branches genuinely need
two calls to reproduce today's fields. What still holds is the rule behind it: **never fetch raw
bytes in order to inspect them.** Two small metadata calls are fine; pulling a 20 MB video to read
its dimensions is not.

Three details that are easy to get wrong, each of which would silently change output:

1. **The `path` → `url` change covers *both* document sub-branches, not just one.** `summaryOf` is
   called with `{ path: subject.file.path }` **unconditionally**, before the PDF test — so today the
   PDF branch carries the same on-disk path the non-PDF one does. Both become `url`. The
   extraction-failure note must be rewritten too: it currently reads "The document itself is intact
   and cached at the path in the summary above", which would point at a field that no longer exists.
   This is all one exception, not two — spec §7.1's exception 1, stated more precisely than the spec
   stated it.
2. **The audio branch takes only `.text`.** `fetchMediaTranscript` returns
   `{ text, model, language }`, but today's `audioAnswer` puts only the transcript text in a text
   block and only `transcribed: boolean` in the summary. Discard `model` and `language`; leaking them
   into the summary changes the shape.
3. **The untranscribed-audio pointer text is a fixed string** and must be reproduced byte for byte,
   along with `duration_sec` from `fetchMediaMeta`.

`buildMcpServer` registers reads and media always, writes only when `!caps.readOnly`. Capabilities
come from the API per session, so flipping the API to read-only takes effect on the next client
connect with no MCP restart.

Read tools must map `ApiUnreachableError` to a message that says the backend is unreachable, distinct
from `ConnectionUnavailableError`'s "WhatsApp connection unavailable".

- [ ] **Step 1: Write the tools** (tests land in Task 15, which ports the existing suite wholesale —
  writing new assertions here would compete with them).
- [ ] **Step 2: Typecheck** — `pnpm --filter whatsapp-mcp typecheck`.
- [ ] **Step 3: Commit** — `feat(mcp): the 14 tools over the SDK client`

---

### Task 15: Port the tool suite, and prove the pair with an end-to-end test

**Files:**
- Create: `packages/mcp/src/tools/harness.ts`, `packages/mcp/src/tools/reads.test.ts`,
  `packages/mcp/src/server.test.ts`, `packages/api/tests/e2e/fake-socket.ts`,
  `packages/api/tests/e2e/mcp-over-api.test.ts`
- Delete: `packages/api/src/mcp/tools/{harness,reads.test,...}` as they are superseded

**The harness is the crux.** Today's `harness()` builds real SQLite repos, a real `McpServer`, and a
linked in-memory MCP `Client`, then stubs `conn`/`sender`/`media`/`transcriber`. Tests touch it only
through `h.client.callTool`, `h.client.listTools`, `h.client.getServerVersion` and the three helpers
`resultText`/`resultJson`/`resultPage`. **Preserve exactly those affordances**, so the ported tests'
assertions do not change:

```ts
export type HarnessOptions = {
  readOnly?: boolean; state?: ConnectionState; transcriptionAvailable?: boolean;
  seed?: (fake: FakeApi) => void;          // was: (ctx: ToolContext) => void
  overrides?: Partial<FakeApi>;            // was: Partial<ToolContext>
};
```

`FakeApi` is an in-memory implementation of `WhatsAppApiClient` — the same interface the real client
satisfies. The `seed` path writes rows into it; the `overrides` path replaces individual methods.
The stubs keep their deliberate quirks: the sender echoes `"c"` rather than the caller's input, so a
tool leaking the caller's literal string instead of the resolved id is still caught.

**The end-to-end test is the only defence against stub drift** and is not optional. Both suites can
stay green while the pair is broken; nothing else catches it.

The socket seam already exists: `ConnectionDeps.makeSocket` is an injectable Baileys factory,
documented "injectable so tests never open a websocket". Three *partial* fake sockets already live in
`connection.test.ts`, `send.test.ts` and `ingest.test.ts` — `fake-socket.ts` is their union, not new
design. What is genuinely new is driving `connection.update`, `ev.on("messages.upsert")` **and**
`sendMessage`/`readMessages` off one object. Feed it the `WAMessage` builders in
`whatsapp/fixtures.ts` (which are message data only, not a socket).

```ts
void test("the real MCP tools answer through the real SDK client against the real API", async () => {
  const api = await bootTestApi({ makeSocket: fakeSocket({ messages: [textMessage({ id: "M1" })] }) });
  const client = createClient({ baseUrl: api.url, token: "t" });
  const mcp = await bootTestMcp({ client });

  const page = resultPage(await mcp.client.callTool({ name: "whatsapp_messages_list", arguments: { limit: 10 } }));
  assert.equal(page.items[0]!["id"], "M1");
  assert.equal(page.items[0]!["sender"]!["name"], "Alice");   // denormalised by the API
});

void test("a read-only API makes the MCP advertise eight tools", async () => {
  const api = await bootTestApi({ readOnly: true });
  const mcp = await bootTestMcp({ client: createClient({ baseUrl: api.url }) });
  assert.equal((await mcp.client.listTools()).tools.length, 8);
});
```

- [ ] **Step 1: Write `fake-socket.ts`.** Start from the union of the three existing partial fakes
  (`connection.test.ts`, `send.test.ts`, `ingest.test.ts`), then add what none of them has:
  **`updateMediaMessage`**. `MediaStore.fetch` passes it to Baileys' `downloadMediaMessage` to retry
  an expired URL, so it is on the cache-miss path that `whatsapp_download_media` exercises — the
  union alone leaves the most interesting media path untestable. Also confirm the one combination no
  existing fake provides: driving `connection.update`, `ev.on("messages.upsert")` **and**
  `sendMessage`/`readMessages` off a single object.
- [ ] **Step 2: Write the e2e test, see it fail.**
- [ ] **Step 3: Write the harness and port the suites.** Assertions may change **only** where Global
  Constraint 2's documented exceptions apply. Make that mechanical rather than a matter of care:

```bash
# Every assertion that changed must be one you can name.
git show HEAD:src/mcp/tools/reads.test.ts | grep -o 'assert\.[a-zA-Z]*(.*' | sort > /tmp/before.txt
grep -o 'assert\.[a-zA-Z]*(.*' packages/mcp/src/tools/reads.test.ts | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt   # every line of output needs a documented reason
```

  This check exists because the two worst defects hardening found in this plan — a changed
  `whatsapp_health.ok` semantic and a dropped reaction array — were both invisible assertion-level
  drift that a green suite would have happily reported as success.
- [ ] **Step 4: Run everything in the container, see it pass.**
- [ ] **Step 5: Commit** — `test: port the tool suite and prove the API/MCP pair end to end`

---

### Task 16: Cutover — remove the in-process MCP

**Files:**
- Delete: `packages/api/src/mcp/**`, `packages/api/src/http.ts` (the Streamable-HTTP one)
- Modify: `packages/api/src/main.ts`, `packages/api/src/config.ts`,
  `packages/api/src/media/convert.ts` (drop `imageBlock`/`videoKeyframes`, now unused),
  `packages/api/src/media/convert.test.ts` (**imports both symbols directly at lines 19-27 and has
  8 tests exercising them at :121-:222 — deleting the exports without touching this file is a
  compile error that reddens the whole package suite**). Before deleting those 8 tests, confirm
  Task 5's `imageJpeg`/`keyframes` tests cover what they covered: WebP decoding, a missing input
  file, and the size loop terminating on an unreachable cap. If they do not, port those cases
  across rather than losing them,
  `packages/api/tsconfig.build.json` (drop the `harness.ts` exclusion if still present)

**Only start this once Task 15 is green.** Clean cutover: no shims, no re-exports, no deprecated
paths. Remove `@modelcontextprotocol/sdk` from `packages/api`'s dependencies, and every MCP-only
config field (`mcpToken`, `httpPath` if unused by REST, `maxResultChars`).

- [ ] **Step 1: Delete and unwire.**
- [ ] **Step 2: Verify nothing references the removed modules** —
  `grep -rn "modelcontextprotocol" packages/api/src` prints nothing.
- [ ] **Step 3: Full container run, green.**
- [ ] **Step 4: Commit** — `refactor(api): remove the in-process MCP surface`

---

### Task 17: Two images, and CI

**Files:**
- Create: `packages/api/Dockerfile`, `packages/mcp/Dockerfile`
- Delete: root `Dockerfile`
- Modify: `.dockerignore`, `.github/workflows/ci.yml`, `.github/workflows/docker.yml`

Both Dockerfiles use `context: .` (the workspace root — a workspace install needs the root lockfile,
`pnpm-workspace.yaml` and every package manifest) and differ by `-f`. **The SDK is built from
workspace source, never installed from a registry**: a registry dependency at image-build time
reintroduces exactly the version-bump dance the monorepo exists to avoid.

`packages/api/Dockerfile` keeps `apt-get install ffmpeg poppler-utils ca-certificates`.
`packages/mcp/Dockerfile` has **no `apt-get` line at all** — that is the split's headline
simplification and is worth asserting in review.

`.dockerignore` becomes workspace-aware: `**/node_modules`, `**/dist`.

`ci.yml`: `pnpm check` / `pnpm test` become the recursive root scripts from Task 1. Keep the apt
install of ffmpeg + poppler after `check` and before `test` (fast gate fails first).

`docker.yml`: the single `build` job becomes a matrix over `[api, mcp]` with distinct
`file:` and image names. Keep `platforms: linux/amd64` — changing the published architecture is out
of scope for this split — but fix the stale comment, which currently blames whisper.cpp, a
dependency that no longer exists.

**Both Dockerfiles must carry a `HEALTHCHECK`.** These are written from scratch, and the current
root Dockerfile's `HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3` polling
`/health` is easy to simply not retype — silently losing the restart signal every orchestrator
relies on. Each image polls **its own** `/health` on its own port, with the same parameters.

Slim each runtime image with `pnpm deploy --filter <pkg> --prod <dir>`, which resolves one package's
production closure out of the workspace. Do not reach for `pnpm prune --prod`: it is not
workspace-recursive.

**Ship a worked `docker-compose.yml`** for the split topology, because there is no longer a
single-container option and the volume is the account:

```yaml
services:
  api:
    image: ghcr.io/spare-cycles/whatsapp-mcp-api
    volumes: [whatsapp-data:/data/whatsapp]     # unchanged path, unchanged contents
    environment: [WHATSAPP_API_TOKEN, WHATSAPP_PHONE_NUMBER]
  mcp:
    image: ghcr.io/spare-cycles/whatsapp-mcp
    depends_on: [api]
    environment:
      WHATSAPP_API_URL: http://api:8080
      WHATSAPP_API_TOKEN: ${WHATSAPP_API_TOKEN}   # the same secret on both sides
      WHATSAPP_MCP_TOKEN: ${WHATSAPP_MCP_TOKEN}
volumes: { whatsapp-data: }
```

- [ ] **Step 1: Write both Dockerfiles and the workflow changes.**
- [ ] **Step 2: Build both images locally.**

```bash
docker build -f packages/api/Dockerfile -t wa-api:t .
docker build -f packages/mcp/Dockerfile -t wa-mcp:t .
docker run --rm wa-mcp:t sh -c 'command -v ffmpeg || echo "no ffmpeg — correct"'
```
Expected: both build; the MCP image reports no ffmpeg.

- [ ] **Step 3: Commit** — `build: two images, workspace-aware ignore, matrixed publish`

---

### Task 18: Docs and smoke

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `smoke.mjs`
- Create: `packages/api/CLAUDE.md`, `packages/mcp/CLAUDE.md`

`CLAUDE.md` splits by package. The JID grep retargets to `packages/api/src/`, and `packages/mcp`
gains a **stricter** rule with no exemptions — no `canonicalId` import, no JID literal anywhere,
tests included:

```bash
grep -rn '@lid\|@s\.whatsapp\.net\|@g\.us\|canonicalId' packages/mcp/src/    # must print nothing
```

The `node:sqlite` / Node-24 compatibility note is `packages/api`-specific and moves there.

**`README.md` must state the guarantee this split weakens.** Spec §8 asks for it explicitly: "Read
tools work in every connection state" becomes "whenever the API is reachable", trading a
process-local guarantee for a network one. It cannot be said in the tool descriptions — Task 14
copies those verbatim, and `reads.ts`'s `OFFLINE` constant still says "answers offline, while the
WhatsApp connection is down", which stays true of the *API*. So `README.md` and
`packages/mcp/CLAUDE.md` are the only homes for it: name `api_unreachable` as a first-class,
expected failure mode, and say plainly that an unreachable API now fails reads that used to succeed.
Leave it out and the one real cost of this architecture is documented nowhere.

**`README.md` gains an upgrade section**, and it is the highest-stakes paragraph in the docs. An
existing deployment is one container with one volume, and that volume holds credentials that cannot
be recovered without re-pairing the account. State plainly: the volume attaches to the **api**
container unchanged, at the same `/data/whatsapp` path, and needs no migration; the old single image
tag is superseded by two new ones; and a new `WHATSAPP_API_TOKEN` must be generated and given to
both containers. Anyone who guesses at this can lose an account.

`smoke.mjs` gains an API-only mode (`--api`) hitting `/health` and `GET /v1/chats` with
`WHATSAPP_API_TOKEN`. **The existing MCP-mode assertions must not change** — tool count 14/8, every
name matching `/^whatsapp_/`, `whatsapp_chats_list` — because they are the migration's own proof.

- [ ] **Step 1: Update docs, add the smoke mode.**
- [ ] **Step 2: Run the enforcement greps**, expect empty output.
- [ ] **Step 3: Commit** — `docs: split the guides per package, add an API smoke mode`

---

## Testing strategy

- Tests under `db/`, `whatsapp/`, `media/` move **unchanged** in Task 1. If one needs an edit, the
  split is leaking — stop and say so rather than editing the test.
- Per-package suites run via `pnpm -r run test`, each package keeping the verbatim
  `node --import tsx --test 'src/**/*.test.ts'` glob relative to its own root.
- The authoritative run is the container from the Baseline section. The host cannot run the media or
  server suites at all.
- `smoke.mjs` stays manual and outside every gate.

## Risks

| Risk | Handling |
| --- | --- |
| **Host baseline is already red** (103 failures, no libwebp; Node 26 vs 24) | Verify only in `node:24-slim` + ffmpeg + poppler. Never claim green from a host run. |
| **Error text drift changes what the model sees** | Task 2 pins each SDK error's `name`/`message` to the legacy in-process values; Task 13's golden-object test pins the row shapes. |
| **Stub drift** — MCP suite green against a fake client, real pair broken | Task 15's end-to-end test. It is the only defence and is not optional. |
| **N+1 over HTTP** — 50 `displayName` round trips per page | Denormalised at the API (Task 7); asserted by a one-query-per-page test. |
| **`projectService` fatals** on any file no tsconfig includes | Per-package `eslint.config.js` with its own `tsconfigRootDir`; `pnpm -r run lint` must be clean before Task 1 is done. |
| **`baileys` reachable from mcp via hoisting** | Task 1 Step 3 asserts `pnpm --filter whatsapp-mcp why baileys` is empty. |
| **`packageExtensions` silently dropped** when splitting manifests | Global Constraint 13; it goes in `pnpm-workspace.yaml`, verified by a clean `pnpm install`. |
| **`linkIdentity` spans four tables in one transaction** | Out of scope. It stays intact behind one `Db` in `packages/api`. Do not decompose it. |
| **Async `buildServer` leaks a session on rejection** | Task 12: the await and the transport construction move inside the `try`, **and** the `finally` guards on `transport` being bound. No bug exists today — this change creates the hazard. |
| **Signed links leak conversation content** | Task 6: payload keyed on sha256 (never a JID), fixed verification order, indistinguishable failures, short TTL, never logged. |

## Assumptions recorded for handoff

These were resolved without the human, who was unavailable, and should be reviewed:

1. Schema **V3** adds `transcript_language`. Note this is *not* a free choice: spec §5.1 requires
   `{ text, model, language }` for the transcript representation, so dropping the field would itself
   violate the spec. V3 closes a pre-existing implementation gap rather than deviating from anything.
2. Docker builds the SDK **from workspace source**, not from a registry.
3. Directory names **flatten** inside each package (`packages/mcp/src/tools/`, not `src/mcp/tools/`).
4. Build ordering uses **pnpm's topological `-r`**, not TypeScript project references.
5. ESLint uses a **shared base plus a per-package config**, not one root config.
6. `packages/api` gets a `whatsapp-api` `bin`, symmetric with the MCP's.
7. Published image architecture stays **amd64-only**; only the stale comment is fixed.
8. **Spec §5.1's single `?as=` media endpoint became seven sub-path routes.** Forced by the type
   system, not preference: one route carrying both a JSON and a binary response makes
   `HandlerResult<R>` resolve to `never`. The representations and their payloads are unchanged.

## Deferred, deliberately

Named here so they are visible omissions rather than oversights:

1. **The SDK release workflow.** `packages/sdk` is made *publishable* in Task 1 (manifest fields), but
   no CI publish job and no versioning policy are in scope. Spec §2 leans on registry publication to
   justify the monorepo, so this needs a follow-up before an external consumer exists.
2. **Deployment migration for existing installs.** The volume is the account, and this split changes
   the process topology. No task covers upgrading a live deployment from one container to two.
3. **Published image architecture.** Stays amd64-only; only the stale whisper.cpp comment is fixed.
4. **An event stream (SSE/webhooks).** Spec §1 already lists it as a non-goal; a web UI will want it.
