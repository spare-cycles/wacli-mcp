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
   exceptions (Task 15: document branch returns a link not a path; Task 12: `whatsapp_health` merges
   API health with MCP reachability; `WHATSAPP_SEND_FILE_DIR` now names a directory on the API host).
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
12. **`getMessage` is load-bearing for the Baileys protocol, not just for reads.** It stays wired to
    `messages.getRaw` inside `packages/api` and never crosses the package boundary. The `raw` BLOB
    column must keep being persisted.
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
  src/schemas/media.ts              MediaRepresentation, KeyframeStrip, MediaMeta, MediaLink, PdfText
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
any route can be written against them. Tasks 6–10 implement the API. Task 10 mounts REST *alongside*
the still-working in-process MCP, so the product never stops working. Tasks 11–14 build the MCP
consumer. Task 15 is the e2e proof. Only Task 16, once that proof is green, removes the in-process
MCP. Tasks 17–18 ship.

---

### Task 1: Workspace scaffold, code moved unchanged

**Files:**
- Create: `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.base.js`,
  `packages/{api,sdk,mcp}/package.json`, `packages/{api,sdk,mcp}/tsconfig.json`,
  `packages/{api,mcp}/tsconfig.build.json`, `packages/{api,sdk,mcp}/eslint.config.js`
- Modify: `package.json` (root), `.dockerignore`
- Move: all of `src/**` → `packages/api/src/**` (contents unchanged), `smoke.mjs` stays at root
- Delete: root `tsconfig.json`, root `tsconfig.build.json`, root `eslint.config.js`

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

Root `package.json`: drop `bin`, drop `dependencies` entirely, keep shared devDeps
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

Dependency split: `baileys`, `jimp`, `express`, `pino`, `@hapi/boom` (dev), `@types/express` (dev) →
`packages/api`. `@modelcontextprotocol/sdk`, `express`, `pino` → `packages/mcp`. `zod` →
`packages/sdk` as its only runtime dependency; `api` and `mcp` get `zod` too because they author
schemas against it.

`packages/api/tsconfig.build.json` keeps **only** the `fixtures.ts` exclusion; the `harness.ts`
exclusion moves to `packages/mcp` in Task 11. Do not duplicate both lists into both packages:

```json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "src/whatsapp/fixtures.ts"]
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

- [ ] **Step 2: Verify the gate is still green, in the container**

Run: the container command from the Baseline section.
Expected: 379 pass / 103 fail — **identical to the recorded host baseline in count and file
distribution is NOT expected**; in the container the 103 ffmpeg failures disappear, so expect
**482 pass / 0 fail**. If any test fails in the container, the move broke something.

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
export class ApiUnreachableError extends ApiError {}       // client-side only, never on the wire

export function errorFromWire(status: number, body: unknown): ApiError;
export function errorToWire(err: unknown): { status: number; body: z.infer<typeof wireError> };
```

**This is the highest-risk detail in the whole plan.** `packages/mcp`'s `describeError` renders
`` `${err.name}: ${err.message}` `` straight into the model's context, and the existing tests assert
on that text. So each subclass's `name` and `message` must reproduce today's in-process error
exactly. Concretely, `NotConnectedError` must carry
`WhatsApp connection unavailable: current state is "<state>"` and — because the current class is
named `ConnectionUnavailableError` — the SDK class must set `this.name = "ConnectionUnavailableError"`
despite the class being called `NotConnectedError`. Verify against
`packages/api/src/whatsapp/connection.ts:46-52` and the assertion at `server.test.ts:229`.

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
export const Reaction = z.object({ emoji: z.string(), from: z.object({ id: z.string(), name: z.string() }) });
export const Page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ nextCursor: z.string().nullable(), items: z.array(item) });
```

`Chat.name` uses the same fallback logic as today's `chatName()` — a DM with no chat name falls back
to the contact's display name, and reports `null` rather than echoing the JID.

`Health` mirrors `HealthReport` exactly (snake_case → camelCase at this boundary; the MCP renames
back in Task 13). `Capabilities` is `{ readOnly: boolean, apiVersion: string, features: { transcription: boolean, autoTranscribe: boolean, mediaLinks: boolean } }`.

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

/** One typed client method per route; the argument object omits the parts the route does not declare. */
export type ClientMethod<R extends Route> = (input: {
  params?: R["params"] extends z.ZodTypeAny ? z.infer<R["params"]> : never;
  query?:  R["query"]  extends z.ZodTypeAny ? z.infer<R["query"]>  : never;
  body?:   R["body"]   extends z.ZodTypeAny ? z.infer<R["body"]>   : never;
}) => Promise<HandlerResult<R>>;

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

The full route list (17 operations) is spec §4. Every one must appear in `routes.ts`.

**Client behaviour:**
- Request bodies and queries are validated before send.
- A non-2xx response is parsed with `wireError` and thrown via `errorFromWire`.
- A `fetch` rejection (DNS, ECONNREFUSED, timeout) becomes `ApiUnreachableError`, never
  `NotConnectedError` — those two mean different things and the MCP surfaces them differently.
- `timeoutMs` uses `AbortSignal.timeout`.

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
  `mcp/tools/media.ts` call sites), `packages/api/src/mcp/health.ts` (`schema_version` assertion)
- Test: `packages/api/src/db/messages.test.ts`, `packages/api/src/db/client.test.ts`

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
5. The token is never logged.

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

**Middleware order is load-bearing** and mirrors today's `http.ts`:
1. `GET /health` — before the bearer gate, so a container healthcheck needs no secret.
2. `GET /v1/media/dl/:token` — before the gate; signed tokens are its authentication.
3. Bearer gate on `/v1` (constant-time compare, `WWW-Authenticate: Bearer` on 401).
4. `express.json` mounted **on `/v1` behind the gate**, so an anonymous `POST /anything` cannot make
   the server buffer and parse ~90 MB. Limit is `maxUploadBytes` + base64 overhead + 1 MiB.
5. Route bindings from `implement()`.
6. Four-argument error middleware last — arity is how Express identifies it. Map `ApiError` → its
   status + `errorToWire`; anything else → 500 `internal`. Log `errorDetail(err)`, never the raw
   error object (Global Constraint 6).

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
**Produces:** `GET /v1/media/:chat/:id` (representation-selected) and `GET /v1/media/dl/:token`.

Representation → response, exactly as spec §5.1:

| `as` | response | produced by |
| --- | --- | --- |
| `raw` (default) | binary, `disposition=attachment\|inline` | `MediaStore.fetch` |
| `link` | JSON `{ url, expiresAt, mimeType, bytes, filename }` | Task 6 signer |
| `jpeg` | binary | `imageJpeg` |
| `keyframes` | JSON `{ durationSec, frames: [{ index, atSec, mimeType, data }] }` | `keyframes`, base64 |
| `text` | JSON `{ text, truncated }` | `pdfExtract` |
| `transcript` | JSON `{ text, model, language } \| null` | `MessageRow` (Task 4) |
| `meta` | JSON | row + `probeDimensions`/`probeDuration` |

`as=link` **must resolve and cache the attachment at mint time**, so a link that cannot be produced
fails in front of the caller rather than 404-ing for whoever it was sent to. That is also what lets
the token key on a sha256 instead of a chat id.

`as=transcript` reads cache only and never spends money. Triggering transcription is a separate
write route (Task 10) — that is what preserves the two-lane rule, since the lane is a property of
the call site.

`maxBytes` / `maxEdge` / `frames` are optional; the API's configured values are both the defaults
and the ceilings, so a client cannot request a 4K strip.

- [ ] **Step 1: Write the failing test**

```ts
void test("a signed link round-trips to the bytes, without a bearer token", async () => {
  const { url } = await api.getJson(`/v1/media/${CHAT}/${MSG}?as=link`);
  const res = await fetch(url);                      // no Authorization header
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
});

void test("as=keyframes returns indexed frames, not one binary blob", async () => {
  const body = await api.getJson(`/v1/media/${CHAT}/${VIDEO}?as=keyframes&frames=3`);
  assert.equal(body.frames.length, 3);
  assert.deepEqual(body.frames.map((f) => f.index), [0, 1, 2]);
});

void test("as=transcript never triggers transcription", async () => {
  const { calls } = transcriberSpy();
  await api.getJson(`/v1/media/${CHAT}/${AUDIO}?as=transcript`);
  assert.equal(calls, 0);
});

void test("a cache miss with the socket down is media_unavailable, not a hang", async () => {
  const api = await testApi({ connectionState: "disconnected" });
  const res = await api.get(`/v1/media/${CHAT}/${UNCACHED}?as=raw`);
  assert.equal(res.status, 503);
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

- [ ] **Step 1: Write the failing test** — assert both surfaces answer and share one store.
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
  httpPath: string; port: number; sessionTtlMs: number; maxResultChars: number; requestTimeoutMs: number;
};
```

`ToolContext` collapses from thirteen fields to three. Nothing else may be added to it — a tool that
needs data grows an SDK call, not a context field.

**`http.ts` is ported near-verbatim** from `packages/api/src/http.ts` with one change:
`HttpDeps.buildServer` becomes `() => Promise<McpServer>`. The scout identified the exact trap —
today's `finally` block unconditionally assumes both `server` and `transport` exist, which a
rejecting async build breaks. So **both the `await buildServer()` call and the subsequent
`StreamableHTTPServerTransport` construction move inside the `try`**, and a build rejection gets its
own error response rather than falling through to `closeSession`. Everything else — `/health` before
the gate, `express.json` on the MCP path behind it, the session map, the unref'd sweeper, the
four-argument error middleware, `closeAllConnections` on shutdown — is unchanged.

`health.ts` merges the API's `/health` with the MCP's own reachability:

```ts
export type McpHealthReport = HealthReport & {
  api: { reachable: boolean; latencyMs: number | null; url: string; error: string | null };
};
```

`api.url` must be the configured base URL with any credentials stripped, and `api.error` a
`describeError` string, never a raw error.

- [ ] **Step 1: Write the failing test**

```ts
void test("a rejecting buildServer answers with an error and leaks no session", async () => {
  const h = await startHttp({ ...deps, buildServer: () => Promise.reject(new Error("boom")) });
  const res = await fetch(`${h.url}/mcp`, { method: "POST", body: initializeBody(), headers: initHeaders() });
  assert.equal(res.status, 500);
  assert.equal(h.sessionCount(), 0);
  await h.close();
});

void test("/health reports the API unreachable rather than throwing", async () => {
  const ctx = ctxWith({ fetch: () => Promise.reject(new TypeError("fetch failed")) });
  const report = await buildHealth(ctx);
  assert.equal(report.api.reachable, false);
  assert.equal(report.ok, false);
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

`whatsapp_download_media` branches by media kind, exactly as today: image → `as=jpeg` → one image
block; video → `as=keyframes` (already base64) plus `as=transcript`; audio → `as=transcript` else
`as=meta` with the same fixed pointer text; PDF → `as=text`; anything else → `as=link`. **The
document branch is the one deliberate output change**: `extra.path` becomes `extra.url`. One SDK
call per branch — never fetch bytes to inspect them.

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

- [ ] **Step 1: Write `fake-socket.ts`** by unioning the three existing partial fakes.
- [ ] **Step 2: Write the e2e test, see it fail.**
- [ ] **Step 3: Write the harness and port the suites**, changing assertions only where Global
  Constraint 2's three documented exceptions apply.
- [ ] **Step 4: Run everything in the container, see it pass.**
- [ ] **Step 5: Commit** — `test: port the tool suite and prove the API/MCP pair end to end`

---

### Task 16: Cutover — remove the in-process MCP

**Files:**
- Delete: `packages/api/src/mcp/**`, `packages/api/src/http.ts` (the Streamable-HTTP one)
- Modify: `packages/api/src/main.ts`, `packages/api/src/config.ts`,
  `packages/api/src/media/convert.ts` (drop `imageBlock`/`videoKeyframes`, now unused),
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
| **Async `buildServer` leaks a session on rejection** | Task 12 moves both the await and the transport construction inside the `try`, with a test. |
| **Signed links leak conversation content** | Task 6: payload keyed on sha256 (never a JID), fixed verification order, indistinguishable failures, short TTL, never logged. |

## Assumptions recorded for handoff

These were resolved without the human, who was unavailable, and should be reviewed:

1. Schema **V3** adds `transcript_language` rather than dropping `language` from the contract.
2. Docker builds the SDK **from workspace source**, not from a registry.
3. Directory names **flatten** inside each package (`packages/mcp/src/tools/`, not `src/mcp/tools/`).
4. Build ordering uses **pnpm's topological `-r`**, not TypeScript project references.
5. ESLint uses a **shared base plus a per-package config**, not one root config.
6. `packages/api` gets a `whatsapp-api` `bin`, symmetric with the MCP's.
7. Published image architecture stays **amd64-only**; only the stale comment is fixed.
