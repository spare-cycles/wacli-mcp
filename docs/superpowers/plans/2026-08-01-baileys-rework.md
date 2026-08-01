# wa-mcp — Baileys Rewrite Implementation Plan

**Goal:** Replace the entire `wacli` subprocess architecture with one always-on TypeScript process built on Baileys that owns the WhatsApp connection, a SQLite+FTS5 store, a 14-tool MCP surface over Streamable HTTP, and a media pipeline that turns every inbound attachment into something a language model can actually consume.

**Architecture:** A single Node process. Baileys holds one WhatsApp websocket; an ingest layer maps its events into SQLite repositories; MCP tool handlers read those repositories and call a send layer; a lazy media pipeline downloads, converts and transcribes attachments on demand. Nothing shells out except `ffmpeg` and `whisper-cli`. There is no second process, no store lock, no IPC.

**Tech Stack:** TypeScript 5.6 (ESM), Node 24, `baileys@7.0.0-rc14`, `node:sqlite` (FTS5), `@modelcontextprotocol/sdk`, Express 5, Zod 3, `jimp`, `pino`, ffmpeg, whisper.cpp.

**Source spec:** `docs/superpowers/specs/2026-08-01-baileys-rework-design.md`

---

## Global Constraints

Every task's requirements implicitly include this section. Copied verbatim from the spec and from the Phase-1 grounding; these are the lens every task reviewer is handed.

1. **Node 24.** `engines.node` is `">=24"`; the image is `node:24-slim` (Debian 12 bookworm, glibc 2.36). `node:sqlite` is experimental — a Node major bump is a deliberate compatibility check, never a routine upgrade.
2. **ESM only.** `"type": "module"`. Every relative import **must** carry an explicit `.js` extension (e.g. `import { openDb } from "./db/client.js"`), because the compiled output runs on Node's ESM resolver.
3. **The full TypeScript strict set stays on,** exactly as in the existing `tsconfig.json`: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `isolatedModules`. Do not weaken a compiler option to make code compile.
4. **ESLint `strictTypeChecked` + `stylisticTypeChecked` must pass with zero errors and zero warnings.** No `eslint-disable` without a comment naming the specific reason.
5. **Prettier:** `printWidth: 120`, semicolons, double quotes, `trailingComma: "all"`.
6. **`pnpm check` and `pnpm test` must both pass at the end of every task.** A task is not done with a red tree.
7. **No native npm modules in the *runtime* dependency tree.** Storage is `node:sqlite` (built in). Image work is `jimp` (pure JS). `whatsapp-rust-bridge`, pulled in by baileys, is Rust→WebAssembly and is fine. Do not add `sharp`, `better-sqlite3`, or any runtime package with a compile or prebuild step. This constraint is scoped to `dependencies` deliberately: `devDependencies` already contain `tsx`, which ships prebuilt esbuild binaries, and that is fine — it never enters the image, which installs with `pnpm prune --prod`.
8. **Baileys is pinned exactly:** `"baileys": "7.0.0-rc14"` — no caret, no tilde. It is a prerelease and rc→rc has broken APIs before.
9. **Naming:** every MCP tool is `wa_*`; the package is `wa-mcp`.
10. **No `WACLI_` in production code.** Not an env var read, not an identifier, not a string, not a comment, in any non-test file that survives. **Test files may name the old variables** for the single purpose of asserting they are *ignored* — `src/config.test.ts`'s "no WACLI_ variable is consulted" is the intended and only such use. Scoped the same way as Constraint 11, and for the same reason: the constraint is about behaviour, and a test that pins the absence of a behaviour has to name it. The check is therefore:
    ```bash
    grep -rn 'WACLI\|wacli' src/ --include='*.ts' | grep -v '\.test\.ts:'
    ```
    Expected: nothing.
11. **All raw JID interpretation lives in `src/wa/jid.ts`.** No other **production** module may contain the substrings `@lid`, `@s.whatsapp.net`, or `@g.us`, or split a JID on `@` or `:`. This is the single most important structural rule in the codebase — see Risk 1.

    Scoped to non-test files, exactly as Constraint 10 is, and for the same reason: the rule bans *interpreting* a JID, and test files plus `src/wa/fixtures.ts` necessarily contain JID **literals as data** — a test for identity folding has to name a LID. The enforcing check is the one in Task 3 step 5, which excludes `*.test.ts`, `src/wa/jid.ts` and `src/wa/fixtures.ts`. If the wording and that command ever disagree again, the command governs.
12. **`src/mcp/tools/*` must not import from `baileys`.** Tool handlers talk to repositories, `wa/send.ts`, and `media/*`. Baileys types stop at the `wa/` and `media/` boundary.
13. **Read tools work in every connection state.** They query SQLite and must never touch the socket. Only write tools and the media pipeline may require a live connection.
14. **Secrets are never logged.** `WA_MCP_TOKEN` and `NTFY_TOKEN` must not appear in any log line, error message, or `/health` response.
15. **HTTP transport only.** No stdio transport, no `StdioServerTransport` import.
16. **Tests are `node:test`,** run via `node --import tsx --test`. No test framework is added.
17. **Every timestamp in the store is integer Unix *seconds*, UTC.** `ts`, `edited_ts`, `deleted_ts`, `muted_until`, `last_message_ts`, and `meta`'s timestamps. This matches Baileys' `messageTimestamp` and the retired supervisor's heartbeat, and it is the single most divergence-prone unspecified detail in the plan — half a codebase in milliseconds sorts and filters wrongly forever, and it is nearly invisible in tests that use small made-up numbers. Two consequences:
    - Convert at the boundary with `Number(m.messageTimestamp)`; protobuf may hand back a `Long`, not a `number`, and `Long` fails silently in arithmetic comparisons.
    - Anything derived from `Date.now()` divides by 1000 and floors. Durations exposed to callers (`last_event_age_sec`) are seconds too; the only milliseconds in the codebase are timer arguments and `sessionTtlMs`, both of which carry `Ms` in the name.
18. **Repository rows map snake_case columns to camelCase fields, at the repository boundary and nowhere else.** Every repo exports row types in camelCase (`chatId`, `fromMe`, `lastMessageTs`); no layer above `src/db/` ever sees a snake_case key. SQLite integers `0`/`1` become real booleans in the same step. Four repositories doing this four different ways is how the tool layer ends up with `from_me` in one result shape and `fromMe` in another.
19. **Every factory-returned interface declares its members as function properties, not method shorthand,** and its implementation closes over local functions rather than reaching through `this`:
    ```ts
    export type MetaRepo = { get: (key: string) => string | undefined };   // yes
    export type MetaRepo = { get(key: string): string | undefined };       // no
    ```
    Two reasons, one of which is enforced. `@typescript-eslint/unbound-method` keys off the **type declaration**, so method shorthand makes any destructuring of the repo (`const { get } = makeMetaRepo(db)`) a lint error — and every repository in this plan is consumed by destructuring somewhere. And a method reaching `this` inside an object literal returned from a factory silently breaks when destructured or passed as a callback, with no compile-time warning.

    **The interface blocks written in Tasks 4, 5, 10, 11 and 12 use method shorthand — that is a plan-wide typo, and this constraint governs.** Translate them to function-property syntax as you implement; the parameter and return types are unchanged. Established while fixing Task 2.

---

## Verified environment facts

Established during Phase 1/2 grounding by running the commands, not from recall. Tasks may rely on these without re-verifying.

1. `baileys@7.0.0-rc14` is `"type": "module"`, `main: lib/index.js`, no `exports` map, `engines.node >= 20`.
2. Its runtime deps include `whatsapp-rust-bridge@0.5.4`, which is **Rust→WebAssembly** — no native addon, no platform binary, no compile step.
3. `sharp` and `jimp` are both **optional at runtime** despite `sharp` being absent from `peerDependenciesMeta`: `lib/Utils/messages-media.js:18` does `Promise.all([import('jimp').catch(()=>{}), import('sharp').catch(()=>{})])` and prefers whichever resolved. Installing `jimp` alone is sufficient and keeps the tree free of native modules.
4. `node:sqlite` on Node 24.18.1 provides SQLite **3.53.1** with FTS5, including external-content tables (`content=`, `content_rowid=`), unflagged. Verified by running an external-content `MATCH` query.
5. `node:24-slim` is Debian 12 bookworm, glibc 2.36. It does **not** ship `libgomp.so.1`.
6. `ghcr.io/ggml-org/whisper.cpp:main` is Ubuntu 22.04 (glibc 2.35 — older than the runtime, so forward-compatible) and **amd64-only**. Its binary is `/app/build/bin/whisper-cli`, **dynamically linked** against `libwhisper.so.1`, `libggml.so.0`, `libggml-base.so.0`, `libggml-cpu.so.0`, all in that same directory, plus `libgomp.so.1` from the system.
   Digest at time of planning: `sha256:375cf0e9e4b5598454493878ce09c4de72ed3e4ed8f41e77a25e1acd9b4112b5`.
7. The deployment target is **amd64** (confirmed with Loup), so the prebuilt-copy path is valid and no compile stage is needed.
8. `ggerganov/whisper.cpp` on Hugging Face serves `ggml-large-v3-turbo-q5_0.bin` (574 MB) at
   `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin`.
9. `@modelcontextprotocol/sdk@1.30.0` depends on `express@^5.2.1` and accepts `zod@^3.25 || ^4.0`. The current lockfile already resolves both `express@4.22.2` (ours) and `express@5.2.1` (the SDK's). Consolidating our own dependency on Express 5 removes the duplicate major. Its `exports` map is `[".", "./client", "./server", "./validation", "./validation/ajv", "./validation/cfworker", "./experimental", "./experimental/tasks", "./*"]` — the trailing wildcard is what lets `server/mcp.js` and `inMemory.js` resolve.
10. Baileys v7 API points this plan relies on, each read from the shipped `.d.ts`:
    `DisconnectReason.loggedOut = 401`, `restartRequired = 515` (`lib/Types/index.d.ts:31,33`);
    `makeCacheableSignalKeyStore`, `initAuthCreds` (`lib/Utils/auth-utils.d.ts:9,23`);
    `BufferJSON` (`lib/Utils/generics.d.ts:5`); `Browsers` (`lib/Utils/browser-utils.d.ts:2`);
    `downloadMediaMessage(message, type, options, ctx?)` (`lib/Utils/messages.d.ts:87`);
    `getContentType`, `normalizeMessageContent` (`lib/Utils/messages.d.ts:27,34`);
    `sock.readMessages(keys)`, `sock.updateMediaMessage(msg)`, `sock.requestPairingCode(phone, custom?)` (`lib/Socket/business.d.ts:37,53,203`);
    `getMessage` is typed `(key: WAMessageKey) => Promise<proto.IMessage | undefined>` (`lib/Types/Socket.d.ts:131`) — the **inner** message, not the `WebMessageInfo` envelope.
11. `node:sqlite` behaviours verified by running them on Node 24.18.1: a `STRICT` table may declare `rowid INTEGER PRIMARY KEY` explicitly and serve as FTS5 external content; `run()` returns `{changes, lastInsertRowid}` and reports `changes: 1` for **both** branches of an `ON CONFLICT … DO UPDATE`; `BLOB` round-trips as `Uint8Array`; named `:params` work; `snippet(fts, <col>, …)` returns `NULL` for a column that did not match; `ORDER BY rank` and `NULLS LAST` both parse.
12. `LIDMappingStore.getPNForLID(lid)` and `.getLIDForPN(pn)` are **async** (`lib/Signal/lid-mapping.d.ts:12,15`). This plan therefore does *not* read Baileys' mapping store on the ingest path — the synchronous `contacts.pnForLid` is the lookup, populated from the `lid-mapping.update` event.

---

## File structure

Everything moves under `src/`. The repo is currently flat, with `tsconfig.json` listing files explicitly.

| File | Responsibility | Task |
| --- | --- | --- |
| `src/config.ts` | Env → one validated `Config`. Throws `ConfigError` at boot on bad input. | 1 |
| `src/logger.ts` | The single pino instance; redaction of secret fields. | 1 |
| `src/db/schema.ts` | DDL, FTS5 triggers, versioned migration list. | 2 |
| `src/db/client.ts` | Open the database, apply pragmas, run migrations. | 2 |
| `src/wa/jid.ts` | JID parsing, normalization, LID↔PN canonicalization. | 3 |
| `src/db/contacts.ts` | Contacts repository + identity linking. | 4 |
| `src/db/chats.ts` | Chats repository. | 4 |
| `src/db/messages.ts` | Messages repository, FTS search, `getMessage` backing. | 5 |
| `src/db/reactions.ts` | Reactions repository. | 5 |
| `src/db/auth-state.ts` | Baileys `AuthenticationState` over SQLite. | 6 |
| `src/wa/connection.ts` | Socket lifecycle, state machine, pairing, backoff. | 7 |
| `src/wa/ingest.ts` | Baileys events → repositories. | 8 |
| `src/wa/send.ts` | Outbound operations, re-ingesting what they produce. | 9 |
| `src/media/store.ts` | Content-addressed download cache. | 10 |
| `src/media/convert.ts` | jimp downscale, ffmpeg keyframes/audio, PDF text. | 10 |
| `src/media/transcribe.ts` | whisper.cpp invocation + model provisioning. | 11 |
| `src/mcp/context.ts` | The `ToolContext` every tool handler receives. | 12 |
| `src/mcp/result.ts` | Result shaping, truncation, MCP content blocks. | 12 |
| `src/mcp/tools/reads.ts` | `wa_health`, `wa_chats_list`, `wa_messages_list`, `wa_messages_search`, `wa_contacts_search`, `wa_groups_list`. | 12 |
| `src/mcp/tools/writes.ts` | `wa_send_text`, `wa_send_file`, `wa_react`, `wa_mark_read`, `wa_edit_message`, `wa_delete_message`. | 13 |
| `src/mcp/tools/media.ts` | `wa_download_media`, `wa_transcribe`. | 13 |
| `src/mcp/server.ts` | `McpServer` construction + tool registration. | 13 |
| `src/alerts.ts` | ntfy publishing driven by connection state. | 14 |
| `src/http.ts` | Express 5: `/mcp`, `/health`, bearer auth. | 14 |
| `src/main.ts` | Wiring and bootstrap. | 14 |
| `Dockerfile`, `.github/workflows/*`, `README.md`, `CLAUDE.md`, `smoke.mjs` | Image, CI, docs. | 15 |

**Deleted in Task 1:** `server.ts`, `sync-supervisor.ts`, `send-file.ts`, `send-file.test.ts`, `smoke.mjs`.

Tests live beside their subject as `*.test.ts` (matching the existing `send-file.test.ts` convention).

---

## Risks

1. **Identity fragmentation (highest).** WhatsApp emits both `1234@lid` and `33612345678@s.whatsapp.net` for the same person; which one arrives depends on the event, the chat type, and whether the contact is in your address book. If canonicalization is inconsistent, the store holds one human as two contacts and two half-conversations — and it fails *quietly*, looking like a working system with sparse data. Mitigated by Constraint 11, by Task 3 being pure and heavily tested, and by Task 4's `linkIdentity` recording every PN↔LID pair the socket reveals.
2. **Baileys is a pinned prerelease.** The API can move between release candidates. Mitigated by the exact pin (Constraint 8) and by confining every Baileys import to `src/wa/**` and `src/media/store.ts` (Constraint 12), so an upgrade has a bounded blast radius.
3. **`getMessage` is required by the socket, not optional.** If `messages.raw` is not populated correctly and byte-faithfully, message retries and poll-vote decryption break in ways that only show up against live WhatsApp. Task 5 stores the protobuf-encoded bytes, not a JSON re-serialization, precisely for this.
4. **FTS5 external-content tables do not track their source.** An `UPDATE` or `DELETE` on `messages` that does not first issue the FTS `'delete'` command with the **old** column values leaves orphaned index entries, and search starts returning rows that no longer match. Task 2 handles this in triggers so no repository has to remember.
5. **whisper.cpp is a copied binary with a shared-library trail.** Copying only `whisper-cli` yields a runtime loader error. Task 15 copies the whole `/app/build/bin` directory, installs `libgomp1`, and sets `LD_LIBRARY_PATH`.
6. **Transcription is slow enough to break MCP clients.** `large-v3-turbo` keeps the full 32-layer encoder; a multi-minute voice note can exceed a client's tool timeout. Task 11 caps input duration, streams progress to the log, and returns a clear error rather than hanging.
7. **The initial history sync can be large.** `messaging-history.set` may deliver thousands of messages at once. Task 8 wraps it in a single transaction and batches, rather than one statement per message.
8. **Express 5 is a major bump from the code being replaced.** Router and error-handling semantics changed. Our surface is three routes and a JSON body parser, so the exposure is small, but Task 14 must not assume Express 4 behaviour.

---

### Task 1: Toolchain, skeleton, config

Establishes the `src/` layout, retires the wacli-era files, repoints every config file, and lands the first module. Everything after this assumes `pnpm check` and `pnpm test` work against `src/`.

**Files:**
- Delete: `server.ts`, `sync-supervisor.ts`, `send-file.ts`, `send-file.test.ts`, `smoke.mjs`
- Modify: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `.dockerignore`
- Create: `src/config.ts`, `src/config.test.ts`, `src/logger.ts`

**Interfaces:**
- Produces:
  ```ts
  export type NtfyConfig = { baseUrl: string; topic: string; token: string };
  export type Config = {
    dataDir: string;          // WA_DATA_DIR, default "/data/wa"
    dbPath: string;           // `${dataDir}/wa.db`
    mediaDir: string;         // WA_MEDIA_DIR, default `${dataDir}/media`
    phoneNumber: string | undefined;  // WA_PHONE_NUMBER, digits only, 8..15
    port: number;             // PORT, default 8080, clamped [1, 65535]
    httpPath: string;         // MCP_HTTP_PATH, default "/mcp"
    mcpToken: string | undefined;     // WA_MCP_TOKEN
    readOnly: boolean;        // WA_MCP_READONLY, truthy = 1/true/yes/on
    whisperBin: string;       // WA_WHISPER_BIN, default "whisper-cli"
    whisperModel: string;     // WA_WHISPER_MODEL, default "large-v3-turbo-q5_0"
    whisperThreads: number;   // WA_WHISPER_THREADS, default max(1, cpus-1)
    whisperMaxSeconds: number;// WA_WHISPER_MAX_SECONDS, default 900
    maxImageBytes: number;    // WA_MAX_IMAGE_BYTES, default 5 MiB
    videoKeyframes: number;   // WA_VIDEO_KEYFRAMES, default 4, clamped [1, 16]
    maxResultChars: number;   // WA_MCP_MAX_RESULT_CHARS, default 200_000
    sessionTtlMs: number;     // fixed 30 * 60_000
    ntfy: NtfyConfig | undefined;
  };
  export class ConfigError extends Error {}
  export function loadConfig(env: NodeJS.ProcessEnv): Config;
  ```
  and from `src/logger.ts`:
  ```ts
  import type { Logger } from "pino";
  export function makeLogger(level?: string): Logger;
  export const logger: Logger;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/config.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ConfigError, loadConfig } from "./config.js";

const base = { WA_DATA_DIR: "/tmp/wa" } satisfies NodeJS.ProcessEnv;

test("defaults are applied", () => {
  const c = loadConfig({ ...base });
  assert.equal(c.dataDir, "/tmp/wa");
  assert.equal(c.dbPath, "/tmp/wa/wa.db");
  assert.equal(c.mediaDir, "/tmp/wa/media");
  assert.equal(c.port, 8080);
  assert.equal(c.httpPath, "/mcp");
  assert.equal(c.readOnly, false);
  assert.equal(c.whisperModel, "large-v3-turbo-q5_0");
  assert.equal(c.videoKeyframes, 4);
  assert.equal(c.maxResultChars, 200_000);
  assert.equal(c.ntfy, undefined);
  assert.equal(c.phoneNumber, undefined);
});

test("readOnly accepts wacli-era truthy spellings", () => {
  for (const v of ["1", "true", "YES", "on"]) {
    assert.equal(loadConfig({ ...base, WA_MCP_READONLY: v }).readOnly, true, v);
  }
  for (const v of ["0", "false", "", "no"]) {
    assert.equal(loadConfig({ ...base, WA_MCP_READONLY: v }).readOnly, false, v);
  }
});

test("phone number must be E.164 digits without +", () => {
  assert.equal(loadConfig({ ...base, WA_PHONE_NUMBER: "33612345678" }).phoneNumber, "33612345678");
  assert.throws(() => loadConfig({ ...base, WA_PHONE_NUMBER: "+33612345678" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, WA_PHONE_NUMBER: "33 6 12" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, WA_PHONE_NUMBER: "123" }), ConfigError);
});

test("numeric vars fall back on garbage and clamp on range", () => {
  assert.equal(loadConfig({ ...base, PORT: "not-a-number" }).port, 8080);
  assert.equal(loadConfig({ ...base, PORT: "0" }).port, 8080);
  assert.equal(loadConfig({ ...base, WA_VIDEO_KEYFRAMES: "999" }).videoKeyframes, 16);
  assert.equal(loadConfig({ ...base, WA_VIDEO_KEYFRAMES: "2" }).videoKeyframes, 2);
});

test("ntfy is all-or-nothing", () => {
  assert.equal(loadConfig({ ...base, NTFY_BASE_URL: "https://n.example" }).ntfy, undefined);
  const c = loadConfig({ ...base, NTFY_BASE_URL: "https://n.example", NTFY_TOPIC: "alerts" });
  assert.deepEqual(c.ntfy, { baseUrl: "https://n.example", topic: "alerts", token: "" });
});

test("no WACLI_ variable is consulted", () => {
  const c = loadConfig({ ...base, WACLI_MCP_READONLY: "1", WACLI_STORE_DIR: "/old" });
  assert.equal(c.readOnly, false);
  assert.equal(c.dataDir, "/tmp/wa");
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `pnpm test`
Expected: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 3: Retire the wacli-era files and repoint the toolchain**

```bash
git rm server.ts sync-supervisor.ts send-file.ts send-file.test.ts smoke.mjs
```

`package.json` — rename, re-point, re-declare dependencies. `bin` becomes `wa-mcp`; add `engines`; drop the wacli-era `@types/express@4`:

```jsonc
{
  "name": "wa-mcp",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.0",
  "description": "MCP server for WhatsApp, built on Baileys",
  "engines": { "node": ">=24" },
  "bin": { "wa-mcp": "dist/main.js" },
  "scripts": {
    "dev": "tsx src/main.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "node --import tsx --test 'src/**/*.test.ts'",
    "check": "npm run format:check && npm run lint && npm run typecheck"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "baileys": "7.0.0-rc14",
    "express": "^5.2.1",
    "jimp": "^1.6.1",
    "pino": "^9.6.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@eslint/js": "^9.13.0",
    "@types/express": "^5.0.0",
    "@types/node": "^24.0.0",
    "eslint": "^9.13.0",
    "eslint-config-prettier": "^9.1.0",
    "prettier": "^3.3.3",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "typescript-eslint": "^8.10.0"
  }
}
```

`pino` is `^9.6.0` deliberately: baileys depends on `pino@^9.6`, and matching the major keeps one copy in the tree.

`tsconfig.json` — change `rootDir` and `include` only; leave every compiler option exactly as it is:

```jsonc
    "outDir": "dist",
    "rootDir": "src",
    ...
  },
  "include": ["src/**/*.ts"]
```

`tsconfig.build.json`:

```jsonc
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

`eslint.config.js` — the ignore list loses `smoke.mjs`:

```js
  { ignores: ["dist/", "node_modules/", "eslint.config.js"] },
```

`.dockerignore` — drop the `smoke.mjs` line, add `docs`.

Then install:

```bash
pnpm install
```

- [ ] **Step 4: Write `src/logger.ts`**

```ts
import { pino, type Logger } from "pino";

/** Field names that must never reach a log line, whatever object they appear on. */
const REDACT = ["token", "mcpToken", "ntfy.token", "*.token", "authorization", "req.headers.authorization"];

export function makeLogger(level = process.env["LOG_LEVEL"] || "info"): Logger {
  return pino({ level, redact: { paths: REDACT, censor: "[redacted]" } });
}

export const logger: Logger = makeLogger();
```

- [ ] **Step 5: Write `src/config.ts`**

Implement `loadConfig` against the test. Required behaviours, all covered above:

- `envInt(raw, fallback, min, max)` — non-finite or `<= 0` falls back, otherwise clamps into range. Port through from the old `server.ts:39` implementation; it was correct.
- `envTruthy(raw)` — `1|true|yes|on`, case-insensitive, trimmed.
- `WA_PHONE_NUMBER` — must match `/^[1-9]\d{7,14}$/`; anything else throws `ConfigError` naming the variable and the expected form. Absent is fine (only first pairing needs it).
- `ntfy` is `undefined` unless **both** `NTFY_BASE_URL` and `NTFY_TOPIC` are non-empty; `NTFY_TOKEN` defaults to `""`.
- `whisperThreads` defaults to `Math.max(1, os.cpus().length - 1)`.
- `ConfigError extends Error` with `name = "ConfigError"`.

Read env only through the `env` parameter, never `process.env` directly — that is what makes the module testable.

- [ ] **Step 6: Run the test, see it pass**

Run: `pnpm test`
Expected: PASS, 6 tests.

- [ ] **Step 7: Verify the gate is green and nothing wacli survives**

```bash
pnpm check
grep -rn "WACLI\|wacli" --include="*.ts" --include="*.json" --include="*.js" src/ package.json tsconfig.json tsconfig.build.json eslint.config.js
```
Expected: `pnpm check` passes; the grep prints nothing.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(skeleton): move to src/, retire the wacli subprocess layer, add config + logger"
```

---

### Task 2: Database client, schema, migrations

The store every later task writes to. FTS5 correctness lives here, in triggers, so no repository has to remember it (Risk 4).

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `src/db/client.test.ts`, `src/db/meta.ts`

`src/db/meta.ts` is a three-method repository over the `meta` table — `get(key): string | undefined`, `set(key, value): void`, `schemaVersion(): number` — exported as `makeMetaRepo(db: Db): MetaRepo`. It exists because Task 12's health report needs `schema_version` and nothing else gives the tool layer read access to `meta`. Add it to `ToolContext` in Task 12.

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // src/db/client.ts
  import type { DatabaseSync } from "node:sqlite";
  export type Db = DatabaseSync;
  export function openDb(path: string): Db;   // applies pragmas, runs migrations
  export function closeDb(db: Db): void;
  // src/db/schema.ts
  export const SCHEMA_VERSION = 1;
  export type Migration = { version: number; sql: string };
  export const MIGRATIONS: readonly Migration[];
  export function migrate(db: Db): number;    // returns the version now applied
  ```

- [ ] **Step 1: Write the failing test**

Create `src/db/client.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeDb, openDb } from "./client.js";
import { SCHEMA_VERSION } from "./schema.js";

const dir = mkdtempSync(join(tmpdir(), "wa-db-"));
after(() => { rmSync(dir, { recursive: true, force: true }); });

function fresh(name: string) {
  return openDb(join(dir, `${name}.db`));
}

test("opens in WAL and records the schema version", () => {
  const db = fresh("wal");
  assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
  assert.equal(Number(row.value), SCHEMA_VERSION);
  closeDb(db);
});

test("migrations are idempotent across reopen", () => {
  const path = join(dir, "idem.db");
  closeDb(openDb(path));
  const db = openDb(path); // must not throw
  assert.equal(Number((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
  closeDb(db);
});

test("FTS indexes inserted message text", () => {
  const db = fresh("fts-insert");
  db.prepare("INSERT INTO chats (id, is_group) VALUES (?, 0)").run("a@s.whatsapp.net");
  db.prepare(
    "INSERT INTO messages (chat_id, id, sender_id, ts, from_me, kind, text) VALUES (?,?,?,?,?,?,?)",
  ).run("a@s.whatsapp.net", "M1", "a@s.whatsapp.net", 1000, 0, "text", "bonjour le monde");
  const hits = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("monde");
  assert.equal(hits.length, 1);
  closeDb(db);
});

test("FTS follows an edit and drops a delete", () => {
  const db = fresh("fts-edit");
  db.prepare("INSERT INTO chats (id, is_group) VALUES (?, 0)").run("c");
  db.prepare("INSERT INTO messages (chat_id, id, sender_id, ts, from_me, kind, text) VALUES (?,?,?,?,?,?,?)")
    .run("c", "M1", "s", 1, 0, "text", "premier texte");

  db.prepare("UPDATE messages SET text = ? WHERE chat_id = ? AND id = ?").run("second texte", "c", "M1");
  assert.equal(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("premier").length, 0);
  assert.equal(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("second").length, 1);

  db.prepare("DELETE FROM messages WHERE chat_id = ? AND id = ?").run("c", "M1");
  assert.equal(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("second").length, 0);
  closeDb(db);
});

test("transcripts are searchable alongside text", () => {
  const db = fresh("fts-transcript");
  db.prepare("INSERT INTO chats (id, is_group) VALUES (?, 0)").run("c");
  db.prepare("INSERT INTO messages (chat_id, id, sender_id, ts, from_me, kind) VALUES (?,?,?,?,?,?)")
    .run("c", "V1", "s", 1, 0, "audio");
  assert.equal(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("rendez").length, 0);
  db.prepare("UPDATE messages SET transcript = ? WHERE chat_id = ? AND id = ?").run("on se voit au rendez-vous", "c", "V1");
  assert.equal(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("rendez").length, 1);
  closeDb(db);
});

test("a message is unique per (chat_id, id)", () => {
  const db = fresh("unique");
  db.prepare("INSERT INTO chats (id, is_group) VALUES (?, 0)").run("c");
  const ins = db.prepare("INSERT INTO messages (chat_id, id, sender_id, ts, from_me, kind) VALUES (?,?,?,?,?,?)");
  ins.run("c", "M1", "s", 1, 0, "text");
  assert.throws(() => { ins.run("c", "M1", "s", 2, 0, "text"); });
  closeDb(db);
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `pnpm test`
Expected: FAIL — `Cannot find module './client.js'`.

- [ ] **Step 3: Write `src/db/schema.ts`**

One migration at version 1. The exact DDL:

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE chats (
  id                TEXT PRIMARY KEY,
  name              TEXT,
  is_group          INTEGER NOT NULL DEFAULT 0,
  last_message_ts   INTEGER,
  unread_count      INTEGER NOT NULL DEFAULT 0,
  archived          INTEGER NOT NULL DEFAULT 0,
  muted_until       INTEGER,
  participant_count INTEGER,
  raw               TEXT
) STRICT;
CREATE INDEX chats_last_message_ts ON chats (last_message_ts DESC);
CREATE INDEX chats_is_group ON chats (is_group, last_message_ts DESC);

CREATE TABLE messages (
  rowid       INTEGER PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  sender_id   TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  from_me     INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL,
  text        TEXT,
  transcript  TEXT,
  quoted_id   TEXT,
  status      TEXT,
  edited_ts   INTEGER,
  deleted_ts  INTEGER,
  media_type  TEXT,
  media_sha   TEXT,
  raw         BLOB
) STRICT;
CREATE UNIQUE INDEX messages_chat_id_id ON messages (chat_id, id);
CREATE INDEX messages_chat_ts ON messages (chat_id, ts DESC);
CREATE INDEX messages_ts ON messages (ts DESC);
CREATE INDEX messages_sender ON messages (sender_id, ts DESC);

CREATE VIRTUAL TABLE messages_fts USING fts5 (
  text, transcript, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text, transcript) VALUES (new.rowid, new.text, new.transcript);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text, transcript) VALUES ('delete', old.rowid, old.text, old.transcript);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text, transcript) VALUES ('delete', old.rowid, old.text, old.transcript);
  INSERT INTO messages_fts (rowid, text, transcript) VALUES (new.rowid, new.text, new.transcript);
END;

CREATE TABLE contacts (
  id           TEXT PRIMARY KEY,
  phone_number TEXT,
  lid          TEXT,
  name         TEXT,
  notify       TEXT,
  raw          TEXT
) STRICT;
CREATE INDEX contacts_phone ON contacts (phone_number);
CREATE INDEX contacts_lid ON contacts (lid);

CREATE TABLE reactions (
  chat_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_id  TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id, sender_id)
) STRICT;

CREATE TABLE auth_creds (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE auth_keys (type TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (type, id)) STRICT;
```

The `messages_au` trigger fires on **every** update, including ones that touch neither indexed column. That is deliberate: it is always correct, and the alternative (`WHEN old.text IS NOT new.text OR old.transcript IS NOT new.transcript`) is an optimization that is easy to get subtly wrong. Keep it simple.

`migrate(db)` reads `meta.schema_version` (absent = 0), applies every migration with a higher version inside one transaction each, and writes the new version. Return the final version.

- [ ] **Step 4: Write `src/db/client.ts`**

```ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./schema.js";

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function closeDb(db: Db): void {
  db.close();
}
```

- [ ] **Step 5: Run the test, see it pass**

Run: `pnpm test`
Expected: PASS, all 6 database tests plus Task 1's config tests.

- [ ] **Step 6: Commit**

```bash
git add src/db package.json
git commit -m "feat(db): SQLite schema, FTS5 triggers, versioned migrations"
```

---

### Task 3: JID normalization and identity

Pure functions, no I/O, no database. The single chokepoint named in Constraint 11 and Risk 1. Test it harder than anything else in the codebase.

**Files:**
- Create: `src/wa/jid.ts`, `src/wa/jid.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type JidKind = "user" | "lid" | "group" | "broadcast" | "newsletter" | "unknown";
  export function jidKind(jid: string): JidKind;
  export function isGroupJid(jid: string): boolean;
  export function isLidJid(jid: string): boolean;
  export function isUserJid(jid: string): boolean;
  /** Strip the device (`:12`) and agent suffixes, lowercase the domain. Never changes the server. */
  export function normalizeJid(jid: string): string;
  /** The local part of a user JID, i.e. the phone number. undefined for anything else. */
  export function phoneFromJid(jid: string): string | undefined;
  /** The local part of a LID JID. undefined for anything else. */
  export function lidFromJid(jid: string): string | undefined;
  /** Build a user JID from an E.164 number without `+`. */
  export function userJid(phone: string): string;
  export type IdentityLookup = { pnForLid(lid: string): string | undefined };
  /**
   * The canonical store id for a JID. Policy: a group/broadcast/newsletter is itself;
   * a user JID is itself; a LID is resolved to its phone JID when the mapping is known,
   * and stays a LID when it is not.
   */
  export function canonicalId(jid: string, lookup?: IdentityLookup): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/wa/jid.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  canonicalId, isGroupJid, isLidJid, isUserJid, jidKind, lidFromJid, normalizeJid, phoneFromJid, userJid,
} from "./jid.js";

test("classifies each server", () => {
  assert.equal(jidKind("33612345678@s.whatsapp.net"), "user");
  assert.equal(jidKind("123456789@lid"), "lid");
  assert.equal(jidKind("120363000000000000@g.us"), "group");
  assert.equal(jidKind("status@broadcast"), "broadcast");
  assert.equal(jidKind("abc@newsletter"), "newsletter");
  assert.equal(jidKind("nonsense"), "unknown");
  assert.equal(jidKind(""), "unknown");
});

test("predicates agree with jidKind", () => {
  assert.equal(isUserJid("33612345678@s.whatsapp.net"), true);
  assert.equal(isUserJid("123@lid"), false);
  assert.equal(isLidJid("123@lid"), true);
  assert.equal(isGroupJid("120363@g.us"), true);
  assert.equal(isGroupJid("33612345678@s.whatsapp.net"), false);
});

test("normalize strips device and agent suffixes", () => {
  assert.equal(normalizeJid("33612345678:12@s.whatsapp.net"), "33612345678@s.whatsapp.net");
  assert.equal(normalizeJid("33612345678_1:5@s.whatsapp.net"), "33612345678@s.whatsapp.net");
  assert.equal(normalizeJid("123456:3@lid"), "123456@lid");
  assert.equal(normalizeJid("33612345678@S.WHATSAPP.NET"), "33612345678@s.whatsapp.net");
  assert.equal(normalizeJid("120363@g.us"), "120363@g.us");
});

test("normalize is idempotent", () => {
  for (const j of ["33612345678:12@s.whatsapp.net", "1@lid", "120363@g.us", "status@broadcast", "junk"]) {
    assert.equal(normalizeJid(normalizeJid(j)), normalizeJid(j), j);
  }
});

test("local-part extractors only fire on the right server", () => {
  assert.equal(phoneFromJid("33612345678@s.whatsapp.net"), "33612345678");
  assert.equal(phoneFromJid("33612345678:9@s.whatsapp.net"), "33612345678");
  assert.equal(phoneFromJid("123@lid"), undefined);
  assert.equal(lidFromJid("123@lid"), "123");
  assert.equal(lidFromJid("33612345678@s.whatsapp.net"), undefined);
  assert.equal(userJid("33612345678"), "33612345678@s.whatsapp.net");
});

test("canonicalId resolves a LID to its phone JID when the mapping is known", () => {
  const lookup = { pnForLid: (lid: string) => (lid === "999" ? "33612345678@s.whatsapp.net" : undefined) };
  assert.equal(canonicalId("999@lid", lookup), "33612345678@s.whatsapp.net");
  assert.equal(canonicalId("999:4@lid", lookup), "33612345678@s.whatsapp.net");
});

test("canonicalId keeps an unmapped LID as a LID", () => {
  const lookup = { pnForLid: () => undefined };
  assert.equal(canonicalId("999@lid", lookup), "999@lid");
  assert.equal(canonicalId("999@lid"), "999@lid");
});

test("canonicalId never rewrites a group, broadcast or user jid", () => {
  const lookup = { pnForLid: () => "33612345678@s.whatsapp.net" };
  assert.equal(canonicalId("120363@g.us", lookup), "120363@g.us");
  assert.equal(canonicalId("status@broadcast", lookup), "status@broadcast");
  assert.equal(canonicalId("33699999999@s.whatsapp.net", lookup), "33699999999@s.whatsapp.net");
});

test("canonicalId is idempotent and normalizes on the way", () => {
  const lookup = { pnForLid: (l: string) => (l === "999" ? "33612345678@s.whatsapp.net" : undefined) };
  const once = canonicalId("999:4@lid", lookup);
  assert.equal(canonicalId(once, lookup), once);
  assert.equal(canonicalId("120363:2@g.us", lookup), "120363@g.us");
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `pnpm test`
Expected: FAIL — `Cannot find module './jid.js'`.

- [ ] **Step 3: Write `src/wa/jid.ts`**

Implement against the test. Notes that matter:

- Split on the **last** `@`, not the first — WhatsApp servers do not contain `@`, but splitting on the first is a habit that breaks on malformed input. Everything before it is the local part, everything after is the server.
- The device suffix is `:<digits>` on the local part; the agent suffix is `_<digits>`. Strip the device first, then the agent, so `33612345678_1:5` reduces correctly. **Strip to a fixed point, not once.** A single pass is not idempotent for a local part carrying a repeated suffix-shaped substring — `123:5:6@s.whatsapp.net` reduces to `123:5@…` on the first call and `123@…` on the second, which breaks `canonicalId`'s defining property. Loop until the string stops changing; it terminates because every iteration either shortens the string or stops. Real WhatsApp JIDs do not chain suffixes, but this module is the chokepoint every other module trusts, and its contract is idempotency on *any* input. Found by review during Task 3.
- Lowercase the **server only**. LID local parts are digits, but do not assume that when lowercasing.
- Servers: `s.whatsapp.net` → `user`, `lid` → `lid`, `g.us` → `group`, `broadcast` → `broadcast`, `newsletter` → `newsletter`, anything else (including a string with no `@`) → `unknown`.
- `canonicalId` normalizes first, then applies the policy. It must never throw on malformed input — return the normalized string unchanged.

This module imports nothing. If you find yourself needing the database here, the design is wrong: the caller passes an `IdentityLookup`.

- [ ] **Step 4: Run the test, see it pass**

Run: `pnpm test`
Expected: PASS, 9 JID tests.

- [ ] **Step 5: Verify the chokepoint holds**

```bash
grep -rln '@lid\|@s\.whatsapp\.net\|@g\.us' src/ --include='*.ts' \
  | grep -v -e '\.test\.ts$' -e 'src/wa/jid\.ts$' -e 'src/wa/fixtures\.ts$'
```
Expected: prints nothing.

The exclusions are deliberate and not a loophole. Constraint 11 is about *interpreting* a JID — splitting it, matching its server, deciding what it means — and only `src/wa/jid.ts` may do that. Test files and `src/wa/fixtures.ts` contain JID **literals** as data, which is unavoidable: a test for identity folding has to name a LID. What the check would catch is production code parsing a JID behind `jid.ts`'s back.

- [ ] **Step 6: Commit**

```bash
git add src/wa
git commit -m "feat(jid): JID parsing, normalization and LID/PN canonicalization"
```

---

### Task 4: Contacts and chats repositories

**Files:**
- Create: `src/db/contacts.ts`, `src/db/contacts.test.ts`, `src/db/chats.ts`, `src/db/chats.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/db/client.js`; `canonicalId`, `isLidJid`, `lidFromJid`, `phoneFromJid` from `src/wa/jid.js`.
- Produces:
  ```ts
  // contacts.ts
  export type ContactRow = {
    id: string; phoneNumber: string | null; lid: string | null;
    name: string | null; notify: string | null;
  };
  export type ContactInput = {
    id: string; phoneNumber?: string | undefined; lid?: string | undefined;
    name?: string | undefined; notify?: string | undefined; raw?: unknown;
  };
  export type ContactsRepo = {
    upsert(c: ContactInput): void;
    upsertMany(cs: readonly ContactInput[]): void;
    get(id: string): ContactRow | undefined;
    search(query: string, limit: number, offset: number): ContactRow[];
    /** Best display name: name, then notify, then the phone number, then the id. */
    displayName(id: string): string;
    /** Record that a LID and a phone JID are the same person. Idempotent, order-independent. */
    linkIdentity(lidJid: string, phoneJid: string): void;
    /** Backing for jid.ts's IdentityLookup. */
    pnForLid(lid: string): string | undefined;
    count(): number;
  };
  export function makeContactsRepo(db: Db): ContactsRepo;

  // chats.ts
  export type ChatRow = {
    id: string; name: string | null; isGroup: boolean; lastMessageTs: number | null;
    unreadCount: number; archived: boolean; mutedUntil: number | null; participantCount: number | null;
  };
  export type ChatPatch = {
    name?: string | undefined; isGroup?: boolean | undefined; unreadCount?: number | undefined;
    archived?: boolean | undefined; mutedUntil?: number | null | undefined;
    participantCount?: number | undefined; raw?: unknown;
  };
  export type ChatListFilter = {
    query?: string | undefined; isGroup?: boolean | undefined;
    archived?: boolean | undefined; unreadOnly?: boolean | undefined;
  };
  export type ChatsRepo = {
    /** Create the row if absent; never clobbers a known name with null. */
    ensure(id: string, isGroup: boolean): void;
    patch(id: string, p: ChatPatch): void;
    get(id: string): ChatRow | undefined;
    list(filter: ChatListFilter, limit: number, offset: number): ChatRow[];
    /** Advance last_message_ts only forwards, so out-of-order history can't rewind a chat. */
    touch(id: string, ts: number): void;
    bumpUnread(id: string, by: number): void;
    clearUnread(id: string): void;
    count(): number;
  };
  export function makeChatsRepo(db: Db): ChatsRepo;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/db/contacts.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openDb } from "./client.js";
import { makeContactsRepo } from "./contacts.js";

const dir = mkdtempSync(join(tmpdir(), "wa-contacts-"));
after(() => { rmSync(dir, { recursive: true, force: true }); });
let n = 0;
const repo = () => makeContactsRepo(openDb(join(dir, `c${n++}.db`)));

test("upsert merges rather than overwriting with nulls", () => {
  const r = repo();
  r.upsert({ id: "33612345678@s.whatsapp.net", phoneNumber: "33612345678", name: "Alice" });
  r.upsert({ id: "33612345678@s.whatsapp.net", notify: "alice-notify" });
  const c = r.get("33612345678@s.whatsapp.net");
  assert.equal(c?.name, "Alice", "an update without a name must not erase it");
  assert.equal(c?.notify, "alice-notify");
});

test("displayName falls back name -> notify -> phone -> id", () => {
  const r = repo();
  r.upsert({ id: "a@s.whatsapp.net", phoneNumber: "331", name: "Alice", notify: "al" });
  assert.equal(r.displayName("a@s.whatsapp.net"), "Alice");
  r.upsert({ id: "b@s.whatsapp.net", phoneNumber: "332", notify: "bob" });
  assert.equal(r.displayName("b@s.whatsapp.net"), "bob");
  r.upsert({ id: "c@s.whatsapp.net", phoneNumber: "333" });
  assert.equal(r.displayName("c@s.whatsapp.net"), "333");
  assert.equal(r.displayName("unknown@s.whatsapp.net"), "unknown@s.whatsapp.net");
});

test("linkIdentity makes pnForLid resolve, and is idempotent", () => {
  const r = repo();
  r.linkIdentity("999@lid", "33612345678@s.whatsapp.net");
  r.linkIdentity("999@lid", "33612345678@s.whatsapp.net");
  assert.equal(r.pnForLid("999"), "33612345678@s.whatsapp.net");
  assert.equal(r.pnForLid("998"), undefined);
});

test("linkIdentity folds a LID-only contact into the phone contact", () => {
  const r = repo();
  r.upsert({ id: "999@lid", lid: "999", notify: "Mystery" });
  r.upsert({ id: "33612345678@s.whatsapp.net", phoneNumber: "33612345678" });
  r.linkIdentity("999@lid", "33612345678@s.whatsapp.net");
  const merged = r.get("33612345678@s.whatsapp.net");
  assert.equal(merged?.lid, "999");
  assert.equal(merged?.notify, "Mystery", "the LID row's name must survive the merge");
  assert.equal(r.get("999@lid"), undefined, "the LID row is folded away, not left as a duplicate");
  assert.equal(r.count(), 1);
});

test("search matches name, notify and phone, case-insensitively", () => {
  const r = repo();
  r.upsert({ id: "a@s.whatsapp.net", phoneNumber: "33611111111", name: "Alice Martin" });
  r.upsert({ id: "b@s.whatsapp.net", phoneNumber: "33622222222", notify: "Bob" });
  assert.equal(r.search("alice", 10, 0).length, 1);
  assert.equal(r.search("MARTIN", 10, 0).length, 1);
  assert.equal(r.search("3362", 10, 0).length, 1);
  assert.equal(r.search("zzz", 10, 0).length, 0);
});

test("search escapes LIKE wildcards in the query", () => {
  const r = repo();
  r.upsert({ id: "a@s.whatsapp.net", name: "Alice" });
  assert.equal(r.search("%", 10, 0).length, 0, "a bare % must not match everything");
  assert.equal(r.search("_", 10, 0).length, 0);
});
```

Create `src/db/chats.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeChatsRepo } from "./chats.js";
import { openDb } from "./client.js";

const dir = mkdtempSync(join(tmpdir(), "wa-chats-"));
after(() => { rmSync(dir, { recursive: true, force: true }); });
let n = 0;
const repo = () => makeChatsRepo(openDb(join(dir, `h${n++}.db`)));

test("ensure is idempotent and does not clobber a known name", () => {
  const r = repo();
  r.ensure("c@s.whatsapp.net", false);
  r.patch("c@s.whatsapp.net", { name: "Alice" });
  r.ensure("c@s.whatsapp.net", false);
  assert.equal(r.get("c@s.whatsapp.net")?.name, "Alice");
  assert.equal(r.count(), 1);
});

test("touch only moves last_message_ts forwards", () => {
  const r = repo();
  r.ensure("c", false);
  r.touch("c", 500);
  r.touch("c", 200);
  assert.equal(r.get("c")?.lastMessageTs, 500, "an older history message must not rewind the chat");
  r.touch("c", 900);
  assert.equal(r.get("c")?.lastMessageTs, 900);
});

test("list orders by recency and honours filters", () => {
  const r = repo();
  r.ensure("dm", false); r.touch("dm", 100); r.patch("dm", { name: "Alice" });
  r.ensure("grp", true); r.touch("grp", 200); r.patch("grp", { name: "Team" });
  r.ensure("old", false); r.touch("old", 50); r.patch("old", { archived: true });

  assert.deepEqual(r.list({}, 10, 0).map((c) => c.id), ["grp", "dm", "old"]);
  assert.deepEqual(r.list({ isGroup: true }, 10, 0).map((c) => c.id), ["grp"]);
  assert.deepEqual(r.list({ archived: false }, 10, 0).map((c) => c.id), ["grp", "dm"]);
  assert.deepEqual(r.list({ query: "ali" }, 10, 0).map((c) => c.id), ["dm"]);
});

test("unread counters", () => {
  const r = repo();
  r.ensure("c", false);
  r.bumpUnread("c", 1); r.bumpUnread("c", 2);
  assert.equal(r.get("c")?.unreadCount, 3);
  assert.deepEqual(r.list({ unreadOnly: true }, 10, 0).map((c) => c.id), ["c"]);
  r.clearUnread("c");
  assert.equal(r.get("c")?.unreadCount, 0);
  assert.equal(r.list({ unreadOnly: true }, 10, 0).length, 0);
});

test("limit and offset paginate", () => {
  const r = repo();
  for (let i = 0; i < 5; i++) { r.ensure(`c${i}`, false); r.touch(`c${i}`, i * 10); }
  assert.deepEqual(r.list({}, 2, 0).map((c) => c.id), ["c4", "c3"]);
  assert.deepEqual(r.list({}, 2, 2).map((c) => c.id), ["c2", "c1"]);
});
```

- [ ] **Step 2: Run the tests, see them fail**

Run: `pnpm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/db/contacts.ts`**

Implementation notes that the tests pin down:

- **Merge semantics.** Every `upsert` is `INSERT … ON CONFLICT(id) DO UPDATE SET col = COALESCE(excluded.col, col)`. A field the caller omitted must never null out a field already stored — Baileys sends partial contact updates constantly.
- **`linkIdentity(lidJid, phoneJid)`** runs in a transaction and must handle the case where *neither* row exists yet, which is the common one — `lid-mapping.update` routinely arrives before any message from that person. Steps: `ensure` the phone contact row exists (insert with just `id` and `phone_number` if absent); copy any non-null `name`/`notify` from the LID row onto it with `COALESCE`, phone row winning where both are set; set the phone row's `lid`; delete the LID row. Idempotent because a second call finds no LID row and only re-sets `lid` to the same value. Writing this as "copy from the LID row onto the phone row" without the `ensure` silently does nothing when both are missing, and `pnForLid` then never resolves.

- **`linkIdentity` must also re-point the conversation, not just the contact.** This is the completion of Risk 1 and the one place the identity design can still fail quietly. If messages were already ingested under `888@lid` and a later `lid-mapping.update` reveals `888 → 33612345678`, folding only the *contact* leaves the old chat and its messages under the LID id while every subsequent message lands under the phone id — one human, two conversations, which is precisely the failure Risk 1 names. So `linkIdentity` also, inside the same transaction:

  1. If a `chats` row exists under the LID id, merge it into the phone id: `ensure` the phone chat, take `MAX(last_message_ts)`, sum `unread_count`, keep the non-null `name`, then delete the LID chat row.
  2. Re-point its messages: `UPDATE messages SET chat_id = :phone WHERE chat_id = :lid`, and the same for `reactions`. The FTS update trigger fires per row and keeps the index consistent for free.
  3. Re-point senders too — **in both tables**: `UPDATE messages SET sender_id = :phone WHERE sender_id = :lid` and `UPDATE reactions SET sender_id = :phone WHERE sender_id = :lid`. Group messages carry the participant, so the same person can appear as a LID sender in a group whose chat id was never a LID. Missing the `reactions` half leaves a reaction attributed to a contact row this very transaction deletes, with nothing to self-heal it — `sender_id` is not a foreign key, so no CASCADE catches it. (Found by review during Task 4, after an earlier draft of this step named only `messages`.)
  4. A `(chat_id, id)` collision is possible if the same message somehow landed under both ids: use `UPDATE OR IGNORE` and then delete whatever is left under the LID id, rather than letting the unique index abort the whole merge.

  Order matters: re-point messages **before** deleting the LID chat row, or the foreign key drops them.

  **This test belongs in Task 5, not Task 4.** It imports `makeMessagesRepo`, which Task 5 creates — a Task 4 implementer working from Task 4 alone cannot write it. So: Task 4 implements the re-pointing SQL inside `linkIdentity` (it is raw SQL against table names, so it compiles fine before `messages.ts` exists) and covers the contact-only half; Task 5 adds this cross-table test to `src/db/messages.test.ts` once both repositories exist. Verified working against SQLite 3.53.1, including the collision path and FTS consistency.

  ```ts
  test("linkIdentity re-points an existing LID conversation onto the phone identity", () => {
    const db = openDb(join(dir, "merge.db"));
    const contacts = makeContactsRepo(db), chats = makeChatsRepo(db), messages = makeMessagesRepo(db);
    chats.ensure("888@lid", false);
    chats.touch("888@lid", 500);
    messages.upsert({ chatId: "888@lid", id: "M1", senderId: "888@lid", ts: 500, fromMe: false, kind: "text", text: "avant" });

    contacts.linkIdentity("888@lid", "33612345678@s.whatsapp.net");

    assert.equal(chats.get("888@lid"), undefined, "the LID chat must not survive the merge");
    assert.equal(chats.get("33612345678@s.whatsapp.net")?.lastMessageTs, 500);
    assert.equal(messages.get("33612345678@s.whatsapp.net", "M1")?.text, "avant");
    assert.equal(messages.get("33612345678@s.whatsapp.net", "M1")?.senderId, "33612345678@s.whatsapp.net");
    assert.equal(messages.search("avant", {}, 10, 0)[0]?.chatId, "33612345678@s.whatsapp.net");
  });
  ```

  This makes `contacts.ts` depend on the `chats`/`messages`/`reactions` tables, which is a layering compromise. Take it deliberately: the merge must be atomic, and splitting it across repositories would either need a transaction spanning them or leave a window where the conversation is half-merged. Do it with direct SQL inside `contacts.ts`, and say so in a comment naming this decision.
- **`pnForLid(lid)`** is `SELECT id FROM contacts WHERE lid = ? AND phone_number IS NOT NULL`.
- **`search`** uses `LIKE` with an explicit `ESCAPE '\'` and escapes `%`, `_` and `\` in the query before interpolating. `LOWER()` both sides. Match against `name`, `notify` and `phone_number`.
- Prepare every statement once at repo construction, not per call.

- [ ] **Step 4: Write `src/db/chats.ts`**

- `ensure` is `INSERT … ON CONFLICT(id) DO NOTHING`, so it can be called on every inbound message for free.
- `patch` builds its `SET` clause from only the keys actually present in the patch object. Under `exactOptionalPropertyTypes`, distinguish "key absent" from "value undefined" with `Object.hasOwn`.
- `touch` is `UPDATE chats SET last_message_ts = MAX(COALESCE(last_message_ts, 0), ?) WHERE id = ?`.
- `list` composes a `WHERE` from the filter, always ends `ORDER BY last_message_ts DESC NULLS LAST, id ASC` — the `id` tiebreak makes pagination stable — and applies `LIMIT ? OFFSET ?`.

The `NULLS LAST` clause requires SQLite 3.30+; we verified 3.53.1.

- [ ] **Step 5: Run the tests, see them pass**

Run: `pnpm test`
Expected: PASS, 6 contacts + 5 chats tests.

- [ ] **Step 6: Commit**

```bash
git add src/db
git commit -m "feat(db): contacts and chats repositories with identity folding"
```

---

### Task 5: Messages and reactions repositories

The heaviest repository, and the one the socket itself depends on (`getMessage`, Risk 3).

**Files:**
- Create: `src/db/messages.ts`, `src/db/messages.test.ts`, `src/db/reactions.ts`, `src/db/reactions.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/db/client.js`.
- Produces:
  ```ts
  export type MessageKind = "text" | "image" | "video" | "audio" | "document" | "sticker" | "location" | "contact" | "system" | "other";
  export type MessageRow = {
    rowid: number; chatId: string; id: string; senderId: string; ts: number; fromMe: boolean;
    kind: MessageKind; text: string | null; transcript: string | null; quotedId: string | null;
    status: string | null; editedTs: number | null; deletedTs: number | null;
    mediaType: string | null; mediaSha: string | null;
  };
  export type MessageInput = {
    chatId: string; id: string; senderId: string; ts: number; fromMe: boolean; kind: MessageKind;
    text?: string | undefined; quotedId?: string | undefined; status?: string | undefined;
    mediaType?: string | undefined; raw?: Uint8Array | undefined;
  };
  export type MessageListFilter = {
    chatId?: string | undefined; senderId?: string | undefined; fromMe?: boolean | undefined;
    before?: number | undefined; after?: number | undefined; includeDeleted?: boolean | undefined;
  };
  export type SearchHit = MessageRow & { matchedTranscript: boolean; snippet: string };
  export type MessagesRepo = {
    /** Returns true when the row was newly inserted, false when it updated an existing one.
     *  Task 8 depends on this to avoid double-counting unread on a redelivery. */
    upsert(m: MessageInput): boolean;
    upsertMany(ms: readonly MessageInput[]): void;   // one transaction
    get(chatId: string, id: string): MessageRow | undefined;
    /** The protobuf bytes stored at ingest. Backs the socket's getMessage contract. */
    getRaw(chatId: string, id: string): Uint8Array | undefined;
    list(filter: MessageListFilter, limit: number, offset: number): MessageRow[];
    search(query: string, opts: { chatId?: string | undefined }, limit: number, offset: number): SearchHit[];
    markEdited(chatId: string, id: string, text: string, ts: number): void;
    markDeleted(chatId: string, id: string, ts: number): void;
    setStatus(chatId: string, id: string, status: string): void;
    setTranscript(chatId: string, id: string, transcript: string): void;
    setMedia(chatId: string, id: string, sha: string, mediaType: string): void;
    count(): number;
  };
  export function makeMessagesRepo(db: Db): MessagesRepo;

  // reactions.ts
  export type ReactionRow = { chatId: string; messageId: string; senderId: string; emoji: string; ts: number };
  export type ReactionsRepo = {
    /** An empty emoji removes the reaction. Same (chat, message, sender) replaces. */
    set(r: ReactionRow): void;
    forMessage(chatId: string, messageId: string): ReactionRow[];
    count(): number;
  };
  export function makeReactionsRepo(db: Db): ReactionsRepo;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/db/messages.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeChatsRepo } from "./chats.js";
import { openDb } from "./client.js";
import { makeMessagesRepo, type MessageInput } from "./messages.js";

const dir = mkdtempSync(join(tmpdir(), "wa-msg-"));
after(() => { rmSync(dir, { recursive: true, force: true }); });
let n = 0;
function repo() {
  const db = openDb(join(dir, `m${n++}.db`));
  const chats = makeChatsRepo(db);
  chats.ensure("c", false);
  chats.ensure("c2", false);
  return makeMessagesRepo(db);
}
const msg = (over: Partial<MessageInput> = {}): MessageInput => ({
  chatId: "c", id: "M1", senderId: "s@s.whatsapp.net", ts: 1000, fromMe: false, kind: "text", text: "hello", ...over,
});

test("upsert then get round-trips", () => {
  const r = repo();
  r.upsert(msg());
  const m = r.get("c", "M1");
  assert.equal(m?.text, "hello");
  assert.equal(m?.fromMe, false);
  assert.equal(m?.kind, "text");
  assert.equal(m?.deletedTs, null);
});

test("upsert is idempotent on (chat, id) and updates in place", () => {
  const r = repo();
  r.upsert(msg());
  r.upsert(msg({ text: "hello again", status: "delivered" }));
  assert.equal(r.count(), 1);
  assert.equal(r.get("c", "M1")?.text, "hello again");
  assert.equal(r.get("c", "M1")?.status, "delivered");
});

test("the same message id in two chats is two rows", () => {
  const r = repo();
  r.upsert(msg({ chatId: "c" }));
  r.upsert(msg({ chatId: "c2" }));
  assert.equal(r.count(), 2);
});

test("getRaw returns the exact bytes stored", () => {
  const r = repo();
  const raw = new Uint8Array([0x0a, 0x00, 0xff, 0x7f, 0x80]);
  r.upsert(msg({ raw }));
  assert.deepEqual(r.getRaw("c", "M1"), raw);
  assert.equal(r.getRaw("c", "nope"), undefined);
});

test("markEdited sets text and edited_ts, keeping the row", () => {
  const r = repo();
  r.upsert(msg());
  r.markEdited("c", "M1", "corrected", 2000);
  const m = r.get("c", "M1");
  assert.equal(m?.text, "corrected");
  assert.equal(m?.editedTs, 2000);
  assert.equal(r.search("corrected", {}, 10, 0).length, 1);
  assert.equal(r.search("hello", {}, 10, 0).length, 0, "the pre-edit text must leave the index");
});

test("markDeleted tombstones: row kept, text cleared, dropped from search", () => {
  const r = repo();
  r.upsert(msg());
  r.markDeleted("c", "M1", 3000);
  const m = r.get("c", "M1");
  assert.ok(m, "the row must survive so threads stay coherent");
  assert.equal(m?.text, null);
  assert.equal(m?.deletedTs, 3000);
  assert.equal(r.search("hello", {}, 10, 0).length, 0);
});

test("list excludes deleted by default and orders newest first", () => {
  const r = repo();
  r.upsert(msg({ id: "M1", ts: 100 }));
  r.upsert(msg({ id: "M2", ts: 300 }));
  r.upsert(msg({ id: "M3", ts: 200 }));
  r.markDeleted("c", "M3", 400);
  assert.deepEqual(r.list({ chatId: "c" }, 10, 0).map((m) => m.id), ["M2", "M1"]);
  assert.deepEqual(r.list({ chatId: "c", includeDeleted: true }, 10, 0).map((m) => m.id), ["M2", "M3", "M1"]);
});

test("list filters compose", () => {
  const r = repo();
  r.upsert(msg({ id: "A", ts: 100, fromMe: true, senderId: "me" }));
  r.upsert(msg({ id: "B", ts: 200, fromMe: false, senderId: "other" }));
  r.upsert(msg({ id: "C", ts: 300, fromMe: false, senderId: "other" }));
  assert.deepEqual(r.list({ chatId: "c", fromMe: true }, 10, 0).map((m) => m.id), ["A"]);
  assert.deepEqual(r.list({ chatId: "c", senderId: "other" }, 10, 0).map((m) => m.id), ["C", "B"]);
  assert.deepEqual(r.list({ chatId: "c", after: 150, before: 250 }, 10, 0).map((m) => m.id), ["B"]);
});

test("search finds transcripts and flags them", () => {
  const r = repo();
  r.upsert(msg({ id: "V1", kind: "audio", text: undefined }));
  r.setTranscript("c", "V1", "on se retrouve demain");
  const hits = r.search("demain", {}, 10, 0);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.matchedTranscript, true);
  assert.equal(hits[0]?.id, "V1");
});

test("search can be scoped to one chat", () => {
  const r = repo();
  r.upsert(msg({ chatId: "c", id: "M1", text: "orange" }));
  r.upsert(msg({ chatId: "c2", id: "M2", text: "orange" }));
  assert.equal(r.search("orange", {}, 10, 0).length, 2);
  assert.equal(r.search("orange", { chatId: "c2" }, 10, 0).length, 1);
});

test("search survives FTS5 operator characters in user input", () => {
  const r = repo();
  r.upsert(msg({ text: "a quoted \"thing\" and a (paren)" }));
  for (const q of ['"', "(", "*", "NEAR", "AND OR", "^foo", "a OR"]) {
    assert.doesNotThrow(() => r.search(q, {}, 10, 0), `query ${JSON.stringify(q)} must not throw`);
  }
  assert.equal(r.search("quoted", {}, 10, 0).length, 1);
});

test("upsertMany is atomic", () => {
  const r = repo();
  r.upsertMany([msg({ id: "A" }), msg({ id: "B" }), msg({ id: "C" })]);
  assert.equal(r.count(), 3);
});
```

Create `src/db/reactions.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openDb } from "./client.js";
import { makeReactionsRepo } from "./reactions.js";

const dir = mkdtempSync(join(tmpdir(), "wa-react-"));
after(() => { rmSync(dir, { recursive: true, force: true }); });
let n = 0;
const repo = () => makeReactionsRepo(openDb(join(dir, `r${n++}.db`)));

test("one reaction per sender per message, replaced on change", () => {
  const r = repo();
  r.set({ chatId: "c", messageId: "M1", senderId: "s1", emoji: "👍", ts: 1 });
  r.set({ chatId: "c", messageId: "M1", senderId: "s1", emoji: "❤️", ts: 2 });
  const all = r.forMessage("c", "M1");
  assert.equal(all.length, 1);
  assert.equal(all[0]?.emoji, "❤️");
});

test("different senders accumulate", () => {
  const r = repo();
  r.set({ chatId: "c", messageId: "M1", senderId: "s1", emoji: "👍", ts: 1 });
  r.set({ chatId: "c", messageId: "M1", senderId: "s2", emoji: "👍", ts: 2 });
  assert.equal(r.forMessage("c", "M1").length, 2);
});

test("an empty emoji removes the reaction", () => {
  const r = repo();
  r.set({ chatId: "c", messageId: "M1", senderId: "s1", emoji: "👍", ts: 1 });
  r.set({ chatId: "c", messageId: "M1", senderId: "s1", emoji: "", ts: 2 });
  assert.equal(r.forMessage("c", "M1").length, 0);
});
```

- [ ] **Step 2: Run the tests, see them fail**

Run: `pnpm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/db/messages.ts`**

- `upsert` is `INSERT … ON CONFLICT(chat_id, id) DO UPDATE SET` with `COALESCE(excluded.col, col)` for every optional column, same merge discipline as contacts. `raw` is written as a `Uint8Array` into the `BLOB` column and returned as one — do **not** round-trip it through a string. (Verified: `node:sqlite` returns a `BLOB` as a `Uint8Array`.)
- **`upsert` returns whether the row was newly inserted, and it must not derive that from `run()`.** Verified on Node 24: an `ON CONFLICT … DO UPDATE` reports `changes: 1` on *both* the insert and the update path, so `result.changes` cannot distinguish them. Use an existence probe inside the same statement pair:
  ```ts
  const existed = this.has.get(m.chatId, m.id) !== undefined;  // SELECT 1 FROM messages WHERE chat_id=? AND id=?
  this.ins.run(/* … */);
  return !existed;
  ```
  Both statements hit the `messages_chat_id_id` unique index, so the probe is cheap. Task 8's unread accounting depends on this being right — get it wrong and every redelivered message double-counts.
- `markDeleted` sets `text = NULL, transcript = NULL, deleted_ts = ?`. The FTS update trigger handles index removal; the repository must not touch `messages_fts` directly.
- `list` composes its `WHERE` from the filter, appends `AND deleted_ts IS NULL` unless `includeDeleted`, orders `ts DESC, rowid DESC`, and paginates.
- **`search` must not let user input reach the FTS5 query parser as syntax.** Wrap the whole query as a single quoted FTS5 string: double every `"` in the input, then surround the result with `"`. That turns every operator character into a literal. Verified on Node 24 that `"`, `(`, `*`, `NEAR`, `a OR` and `^x` all survive this treatment without throwing.
- **Determining `matchedTranscript` uses two per-column snippets, not a column MATCH.** FTS5 does not allow `messages_fts.transcript MATCH …` — an fts5 table matches as a whole. What does work, verified: `snippet(messages_fts, 0, …)` returns the snippet for `text` and `snippet(messages_fts, 1, …)` for `transcript`, and **the one whose column did not match comes back `NULL`**. So:
  ```sql
  SELECT m.rowid, m.chat_id, m.id, m.sender_id, m.ts, m.from_me, m.kind, m.text, m.transcript,
         m.quoted_id, m.status, m.edited_ts, m.deleted_ts, m.media_type, m.media_sha,
         snippet(messages_fts, 0, '[', ']', '…', 12) AS snip_text,
         snippet(messages_fts, 1, '[', ']', '…', 12) AS snip_transcript
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
   WHERE messages_fts MATCH :q AND m.deleted_ts IS NULL
   ORDER BY rank
   LIMIT :limit OFFSET :offset
  ```
  Then in TypeScript: `matchedTranscript = row.snip_text === null && row.snip_transcript !== null`, and `snippet = row.snip_text ?? row.snip_transcript ?? ""`. A hit that matched both columns counts as a text hit, which is the useful default.
  Do not `SELECT m.*` — the join would shadow `rowid` ambiguously; list the columns.
- `setTranscript` writes the column; the update trigger re-indexes it. Nothing else needed for the "transcripts join the index" requirement.

- [ ] **Step 4: Write `src/db/reactions.ts`**

`set` with a non-empty emoji is `INSERT … ON CONFLICT(chat_id, message_id, sender_id) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts`. With an empty emoji it is a `DELETE`. Both in one method because that is exactly how WhatsApp models it — a reaction removal is a reaction event with empty text.

- [ ] **Step 5: Run the tests, see them pass**

Run: `pnpm test`
Expected: PASS, 12 messages + 3 reactions tests.

- [ ] **Step 6: Commit**

```bash
git add src/db
git commit -m "feat(db): messages repository with FTS search, tombstones and raw-bytes getMessage backing"
```

---

### Task 6: SQLite-backed Baileys auth state

Replaces `useMultiFileAuthState`, which Baileys' own documentation forbids in production. Must carry the three v7 key types.

**Files:**
- Create: `src/db/auth-state.ts`, `src/db/auth-state.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/db/client.js`.
- Produces:
  ```ts
  import type { AuthenticationState } from "baileys";
  export type AuthStore = {
    state: AuthenticationState;
    saveCreds(): void;
    /** Wipe credentials and signal keys — used on loggedOut so the next boot re-pairs cleanly. */
    clear(): void;
  };
  export function makeAuthStore(db: Db): AuthStore;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/db/auth-state.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeAuthStore } from "./auth-state.js";
import { openDb } from "./client.js";

const dir = mkdtempSync(join(tmpdir(), "wa-auth-"));
after(() => { rmSync(dir, { recursive: true, force: true }); });

test("fresh creds are generated and survive a reopen", () => {
  const path = join(dir, "a.db");
  const first = makeAuthStore(openDb(path));
  const id = first.state.creds.me?.id;
  first.saveCreds();
  const second = makeAuthStore(openDb(path));
  assert.deepEqual(second.state.creds.registrationId, first.state.creds.registrationId);
  assert.equal(second.state.creds.me?.id, id);
});

test("signal keys round-trip as Buffers, not as JSON-mangled objects", async () => {
  const store = makeAuthStore(openDb(join(dir, "b.db")));
  const key = Buffer.from([1, 2, 3, 250, 255]);
  await store.state.keys.set({ "pre-key": { "7": { public: key, private: key } } });
  const got = await store.state.keys.get("pre-key", ["7"]);
  assert.ok(Buffer.isBuffer(got["7"]?.public), "a Buffer must come back as a Buffer");
  assert.deepEqual(Buffer.from(got["7"]!.public), key);
});

test("the v7 key types are storable", async () => {
  const store = makeAuthStore(openDb(join(dir, "c.db")));
  // Shapes taken verbatim from baileys' SignalDataTypeMap (lib/Types/Auth.d.ts:68-85):
  //   'lid-mapping': string        'device-list': string[]
  //   tctoken: { token: Buffer; timestamp?: string; senderTimestamp?: number }
  // Getting these wrong fails the strictTypeChecked gate rather than a runtime assertion.
  await store.state.keys.set({ "lid-mapping": { "999": "33612345678" } });
  await store.state.keys.set({ "device-list": { d1: ["33612345678:1", "33612345678:2"] } });
  await store.state.keys.set({ tctoken: { t1: { token: Buffer.from([9, 9]), timestamp: "1700" } } });
  assert.equal((await store.state.keys.get("lid-mapping", ["999"]))["999"], "33612345678");
  assert.deepEqual((await store.state.keys.get("device-list", ["d1"]))["d1"], ["33612345678:1", "33612345678:2"]);
  assert.ok(Buffer.isBuffer((await store.state.keys.get("tctoken", ["t1"]))["t1"]?.token));
});

test("setting a key to null deletes it", async () => {
  const store = makeAuthStore(openDb(join(dir, "d.db")));
  await store.state.keys.set({ "pre-key": { "1": Buffer.from([1]) } });
  await store.state.keys.set({ "pre-key": { "1": null } });
  assert.equal((await store.state.keys.get("pre-key", ["1"]))["1"], undefined);
});

test("get tolerates unknown ids", async () => {
  const store = makeAuthStore(openDb(join(dir, "e.db")));
  assert.deepEqual(await store.state.keys.get("session", ["nope"]), {});
});

test("clear wipes creds and keys", async () => {
  const path = join(dir, "f.db");
  const store = makeAuthStore(openDb(path));
  await store.state.keys.set({ "pre-key": { "1": Buffer.from([1]) } });
  store.saveCreds();
  store.clear();
  const reopened = makeAuthStore(openDb(path));
  assert.deepEqual(await reopened.state.keys.get("pre-key", ["1"]), {});
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `pnpm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/db/auth-state.ts`**

The shape mirrors Baileys' own `useMultiFileAuthState` but stores rows instead of files:

```ts
import { BufferJSON, initAuthCreds, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from "baileys";
```

- Serialize with `JSON.stringify(value, BufferJSON.replacer)` and read back with `JSON.parse(raw, BufferJSON.reviver)`. That is what preserves `Buffer`s across the round trip and is the single most important detail in this module — a plain `JSON.stringify` turns a Buffer into `{type:"Buffer",data:[…]}` and Signal fails later with opaque decryption errors.
- `creds` are loaded from `auth_creds` under the key `"creds"`, or created with `initAuthCreds()` when absent.
- `keys.get(type, ids)` selects `WHERE type = ? AND id IN (…)` and returns an object keyed by id, omitting misses. Baileys expects the `app-state-sync-key` type to come back as a `proto.Message.AppStateSyncKeyData` — follow `useMultiFileAuthState`'s precedent and pass those through `proto.Message.AppStateSyncKeyData.fromObject` before returning.
- `keys.set(data)` walks `type → id → value`, deleting where the value is null and upserting otherwise, all inside one transaction.
- `saveCreds()` writes the current `creds` object.
- `clear()` deletes every row from both auth tables.

Both `get` and `set` are declared `async` to satisfy Baileys' `SignalKeyStore` interface even though `node:sqlite` is synchronous.

- [ ] **Step 4: Run the test, see it pass**

Run: `pnpm test`
Expected: PASS, 6 auth tests.

- [ ] **Step 5: Commit**

```bash
git add src/db
git commit -m "feat(auth): SQLite-backed Baileys auth state with v7 key types"
```

---

### Task 7: Connection lifecycle and state machine

**Files:**
- Create: `src/wa/connection.ts`, `src/wa/connection.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1), `Logger` (Task 1), `AuthStore` (Task 6), `MessagesRepo.getRaw` (Task 5).
- Produces:
  ```ts
  import type { WAMessageKey, WASocket } from "baileys";
  export type ConnectionState = "disconnected" | "connecting" | "pairing" | "connected" | "logged_out";
  export type ConnectionSnapshot = {
    state: ConnectionState; lastEventAt: number; lastConnectedAt: number | null;
    attempts: number; needsPairing: boolean; selfId: string | null;
  };
  export type ConnectionDeps = {
    config: Config; logger: Logger; auth: AuthStore;
    /** Backs the socket's required getMessage contract. */
    loadMessage(key: WAMessageKey): Promise<Uint8Array | undefined>;
    /** Called with each freshly created socket so ingest can attach its listeners. */
    onSocket(sock: WASocket): void;
    /** Baileys factory, injectable so tests never open a websocket. */
    makeSocket?: typeof import("baileys").makeWASocket | undefined;
  };
  export type WaConnection = {
    snapshot(): ConnectionSnapshot;
    /** The live socket, or throws a ConnectionUnavailableError naming the current state. */
    requireSocket(): WASocket;
    start(): Promise<void>;
    stop(): Promise<void>;
    onStateChange(cb: (s: ConnectionState) => void): void;
  };
  export class ConnectionUnavailableError extends Error {
    readonly state: ConnectionState;
  }
  /** Exported for testing: the delay before retry N, capped and jittered. */
  export function backoffMs(attempt: number, random?: () => number): number;
  export function makeConnection(deps: ConnectionDeps): WaConnection;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/wa/connection.test.ts`. It drives the state machine through a fake socket — no network:

```ts
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { backoffMs, ConnectionUnavailableError, makeConnection, type ConnectionDeps } from "./connection.js";

function fakeSocket() {
  const ev = new EventEmitter();
  return {
    ev: { on: ev.on.bind(ev), off: ev.off.bind(ev) },
    emit: ev.emit.bind(ev),
    requestPairingCode: async (n: string) => `CODE-${n.slice(-4)}`,
    logout: async () => {},
    end: () => {},
    user: { id: "33612345678:1@s.whatsapp.net" },
  };
}

function deps(over: Partial<ConnectionDeps> = {}) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const base = {
    config: { phoneNumber: "33612345678" },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    auth: { state: { creds: {} }, saveCreds() {}, clear() {} },
    loadMessage: async () => undefined,
    onSocket: () => {},
    makeSocket: () => { const s = fakeSocket(); sockets.push(s); return s; },
  } as unknown as ConnectionDeps;
  return { deps: { ...base, ...over } as ConnectionDeps, sockets };
}

test("starts disconnected, moves to connecting on start", async () => {
  const { deps: d, sockets } = deps();
  const c = makeConnection(d);
  assert.equal(c.snapshot().state, "disconnected");
  await c.start();
  assert.equal(c.snapshot().state, "connecting");
  assert.equal(sockets.length, 1);
});

test("reaches connected on connection.update open", async () => {
  const { deps: d, sockets } = deps();
  const c = makeConnection(d);
  await c.start();
  sockets[0]!.emit("connection.update", { connection: "open" });
  assert.equal(c.snapshot().state, "connected");
  assert.equal(c.snapshot().attempts, 0, "a successful connect resets the backoff counter");
});

test("requireSocket throws with the state named when not connected", async () => {
  const { deps: d } = deps();
  const c = makeConnection(d);
  assert.throws(() => c.requireSocket(), (e: unknown) => {
    assert.ok(e instanceof ConnectionUnavailableError);
    assert.equal(e.state, "disconnected");
    assert.match(e.message, /disconnected/);
    return true;
  });
});

test("a qr with no session requests a pairing code and enters pairing", async () => {
  const { deps: d, sockets } = deps();
  const c = makeConnection(d);
  const seen: string[] = [];
  c.onStateChange((s) => seen.push(s));
  await c.start();
  sockets[0]!.emit("connection.update", { qr: "some-qr-payload" });
  await new Promise((r) => setImmediate(r));
  assert.equal(c.snapshot().state, "pairing");
  assert.equal(c.snapshot().needsPairing, true);
  assert.ok(seen.includes("pairing"));
});

test("a pairing code is requested exactly once per socket", async () => {
  const { deps: d, sockets } = deps();
  let calls = 0;
  const c = makeConnection({ ...d, makeSocket: () => {
    const s = fakeSocket();
    s.requestPairingCode = async () => { calls++; return "ABCD1234"; };
    sockets.push(s);
    return s;
  } } as unknown as ConnectionDeps);
  await c.start();
  sockets[0]!.emit("connection.update", { qr: "a" });
  sockets[0]!.emit("connection.update", { qr: "b" });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, "a rotating QR must not spam requestPairingCode");
});

test("loggedOut is terminal: no reconnect, creds cleared", async () => {
  const { deps: d, sockets } = deps();
  let cleared = false;
  const c = makeConnection({ ...d, auth: { ...d.auth, clear: () => { cleared = true; } } } as ConnectionDeps);
  await c.start();
  sockets[0]!.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 } } },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(c.snapshot().state, "logged_out");
  assert.equal(cleared, true);
  assert.equal(sockets.length, 1, "a logged-out connection must not be retried");
});

test("restartRequired recreates the socket immediately", async () => {
  const { deps: d, sockets } = deps();
  const c = makeConnection(d);
  await c.start();
  sockets[0]!.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 515 } } },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(sockets.length, 2, "restartRequired is expected after pairing, not a failure");
  assert.equal(c.snapshot().state, "connecting");
});

test("backoff grows, caps, and is jittered", () => {
  assert.ok(backoffMs(0, () => 0.5) >= 500);
  assert.ok(backoffMs(1, () => 0.5) > backoffMs(0, () => 0.5));
  assert.ok(backoffMs(50, () => 0.5) <= 300_000);
  assert.notEqual(backoffMs(3, () => 0), backoffMs(3, () => 0.99));
});

test("stop() prevents any further reconnect", async () => {
  const { deps: d, sockets } = deps();
  const c = makeConnection(d);
  await c.start();
  await c.stop();
  sockets[0]!.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 500 } } } });
  await new Promise((r) => setImmediate(r));
  assert.equal(sockets.length, 1);
  assert.equal(c.snapshot().state, "disconnected");
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `pnpm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/wa/connection.ts`**

Socket construction:

```ts
const sock = makeSocket({
  auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, logger) },
  logger,
  printQRInTerminal: false,
  markOnlineOnConnect: false,           // Constraint: ban-risk mitigation from the spec
  browser: Browsers.macOS("Desktop"),   // a plausible browser identity, same reason
  syncFullHistory: false,
  generateHighQualityLinkPreview: false,
  getMessage: async (key) => {
    const bytes = await loadMessage(key);
    // We store the encoded WebMessageInfo (Task 8 step 6), but getMessage is typed
    // `(key) => Promise<proto.IMessage | undefined>` — the INNER message, not the envelope.
    // Decoding these bytes as proto.Message would silently produce garbage and break
    // every message retry and poll-vote decrypt. Unwrap the envelope:
    return bytes ? (proto.WebMessageInfo.decode(bytes).message ?? undefined) : undefined;
  },
});
```

State machine rules, each pinned by a test above:

1. `start()` sets `connecting` and builds a socket; `onSocket(sock)` is called before any listener of ours, so ingest sees every event.
2. `connection.update` with `connection === "open"` → `connected`, `attempts = 0`, `lastConnectedAt = now`.
3. `connection.update` carrying a `qr` → if `config.phoneNumber` is set and we have not yet requested a code **for this socket**, call `requestPairingCode(phoneNumber)` and log the result prominently (`logger.info({ pairingCode }, "…")`, and a plain `console.log` banner so it is unmissable in Portainer). Set `pairing`. Guard per-socket — the QR rotates every ~20 s and each rotation re-emits.

   **If `config.phoneNumber` is NOT set, log an error naming the variable, once per socket.** Decision 5 chose pairing-by-code and deliberately renders no QR, so an operator who deploys without `WA_PHONE_NUMBER` otherwise gets a server that sits in `pairing` forever with nothing to act on and no diagnostic — the QR string is received and discarded. The message must say plainly that pairing requires `WA_PHONE_NUMBER` (E.164, no `+`) and that the server will keep waiting until it is set. Do not log the QR payload itself: it is a live credential that would let anyone reading the logs link their own device. (Found by review during Task 7.)
4. `connection.update` with `connection === "close"`: read `statusCode` from `(lastDisconnect?.error as Boom)?.output?.statusCode`.
   - `DisconnectReason.loggedOut` (401) → `logged_out`, `auth.clear()`, **no** retry.
   - `DisconnectReason.restartRequired` (515) → recreate the socket immediately, staying at `connecting`, without incrementing `attempts`.
   - anything else → `disconnected`, increment `attempts`, schedule a retry after `backoffMs(attempts)`.
5. `stop()` sets a `stopped` flag checked before every reconnect, clears the pending timer, and ends the socket. It moves to `disconnected` **unless the state is already `logged_out`**, which is terminal and must survive shutdown — otherwise a stop during logout erases the one piece of information an operator needs.
6. Every handled event updates `lastEventAt`.
7. **`needsPairing` is `state === "pairing" || state === "logged_out"`** — those are exactly the two states a human must act on. Define it once, as a getter on the snapshot, so Task 12's health report and Task 12's test harness cannot drift from it.
8. If `makeSocket` itself throws synchronously in `start()` (bad auth blob, unusable config), treat it as an ordinary failed attempt: log at error, go to `disconnected`, increment `attempts`, and schedule the backoff retry. It must not reject `start()` and take the process down — the read tools are still perfectly serviceable.

`backoffMs(attempt, random = Math.random)` is `min(300_000, 1000 * 2 ** attempt)` multiplied by a jitter factor in `[0.5, 1.5)`, floored at 500 ms.

Register `creds.update` → `auth.saveCreds()` on each socket.

- [ ] **Step 4: Run the test, see it pass**

Run: `pnpm test`
Expected: PASS, 9 connection tests.

- [ ] **Step 5: Commit**

```bash
git add src/wa
git commit -m "feat(wa): connection state machine with pairing code, backoff and terminal logout"
```

---

### Task 8: Event ingest

The only place Baileys events become rows. Everything it writes goes through the repositories; everything it reads about identity goes through `jid.ts`.

**Files:**
- Create: `src/wa/ingest.ts`, `src/wa/ingest.test.ts`, `src/wa/fixtures.ts`

**Interfaces:**
- Consumes: all four repositories (Tasks 4–5), `canonicalId`/`normalizeJid`/`isGroupJid` (Task 3), `Logger`.
- Produces:
  ```ts
  import type { WAMessage, WASocket } from "baileys";
  export type IngestDeps = {
    chats: ChatsRepo; contacts: ContactsRepo; messages: MessagesRepo; reactions: ReactionsRepo;
    logger: Logger;
    /** The account's own canonical id, for from_me and self-name resolution. */
    selfId(): string | null;
  };
  export type Ingest = {
    /** Wire every listener onto a freshly created socket. */
    attach(sock: WASocket): void;
    /** Ingest one message. Exported so send.ts can re-ingest what it produced. */
    ingestMessage(m: WAMessage): void;
    ingestMessages(ms: readonly WAMessage[]): void;
  };
  export function makeIngest(deps: IngestDeps): Ingest;
  /** Exported for tests and for send.ts: classify a Baileys message into our MessageKind. */
  export function classify(m: WAMessage): MessageKind;
  /** Exported for tests: the displayable text of a message, across every content wrapper. */
  export function extractText(m: WAMessage): string | undefined;
  ```
  `src/wa/fixtures.ts` exports hand-built `WAMessage`-shaped objects used by this task's tests and reused by Tasks 9 and 12: `textMessage`, `imageMessage`, `audioMessage`, `videoMessage`, `documentMessage`, `stickerMessage`, `extendedTextReply`, `groupMessage`, `lidMessage`.

- [ ] **Step 1: Write the failing test**

Create `src/wa/ingest.test.ts`. It builds a real database, attaches no socket, and calls `ingestMessage` directly:

```ts
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeChatsRepo } from "../db/chats.js";
import { openDb } from "../db/client.js";
import { makeContactsRepo } from "../db/contacts.js";
import { makeMessagesRepo } from "../db/messages.js";
import { makeReactionsRepo } from "../db/reactions.js";
import * as fx from "./fixtures.js";
import { classify, extractText, makeIngest } from "./ingest.js";

const dir = mkdtempSync(join(tmpdir(), "wa-ingest-"));
after(() => { rmSync(dir, { recursive: true, force: true }); });
let n = 0;
function harness() {
  const db = openDb(join(dir, `i${n++}.db`));
  const repos = {
    chats: makeChatsRepo(db), contacts: makeContactsRepo(db),
    messages: makeMessagesRepo(db), reactions: makeReactionsRepo(db),
  };
  const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
  const ingest = makeIngest({ ...repos, logger, selfId: () => "33600000000@s.whatsapp.net" });
  return { ...repos, ingest };
}

test("a text message creates the chat and the message", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.textMessage({ chat: "33612345678@s.whatsapp.net", id: "M1", text: "salut", ts: 1700 }));
  assert.equal(h.chats.get("33612345678@s.whatsapp.net")?.lastMessageTs, 1700);
  const m = h.messages.get("33612345678@s.whatsapp.net", "M1");
  assert.equal(m?.text, "salut");
  assert.equal(m?.kind, "text");
  assert.equal(m?.fromMe, false);
});

test("raw protobuf bytes are stored so getMessage can work", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.textMessage({ id: "M1" }));
  const raw = h.messages.getRaw("33612345678@s.whatsapp.net", "M1");
  assert.ok(raw && raw.byteLength > 0, "every ingested message must carry its encoded bytes");
});

test("a group message records the participant as sender, not the group", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.groupMessage({ chat: "120363@g.us", participant: "33612345678@s.whatsapp.net", id: "G1" }));
  const m = h.messages.get("120363@g.us", "G1");
  assert.equal(m?.senderId, "33612345678@s.whatsapp.net");
  assert.equal(h.chats.get("120363@g.us")?.isGroup, true);
});

test("a DM records the chat itself as sender", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.textMessage({ chat: "33612345678@s.whatsapp.net", id: "M1" }));
  assert.equal(h.messages.get("33612345678@s.whatsapp.net", "M1")?.senderId, "33612345678@s.whatsapp.net");
});

test("device suffixes are normalized away", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.textMessage({ chat: "33612345678:12@s.whatsapp.net", id: "M1" }));
  assert.ok(h.chats.get("33612345678@s.whatsapp.net"), "the chat id must be normalized");
  assert.equal(h.chats.get("33612345678:12@s.whatsapp.net"), undefined);
});

test("fromMe is derived from the key, and marks the chat read", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.textMessage({ id: "M1", fromMe: true }));
  assert.equal(h.messages.get("33612345678@s.whatsapp.net", "M1")?.fromMe, true);
  assert.equal(h.chats.get("33612345678@s.whatsapp.net")?.unreadCount, 0);
});

test("an inbound message bumps unread, an outbound one does not", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.textMessage({ id: "A", fromMe: false }));
  h.ingest.ingestMessage(fx.textMessage({ id: "B", fromMe: false }));
  assert.equal(h.chats.get("33612345678@s.whatsapp.net")?.unreadCount, 2);
  h.ingest.ingestMessage(fx.textMessage({ id: "C", fromMe: true }));
  assert.equal(h.chats.get("33612345678@s.whatsapp.net")?.unreadCount, 0);
});

test("classify covers every media wrapper", () => {
  assert.equal(classify(fx.textMessage({})), "text");
  assert.equal(classify(fx.imageMessage({})), "image");
  assert.equal(classify(fx.videoMessage({})), "video");
  assert.equal(classify(fx.audioMessage({})), "audio");
  assert.equal(classify(fx.documentMessage({})), "document");
  assert.equal(classify(fx.stickerMessage({})), "sticker");
});

test("extractText reads conversation, extendedText and media captions", () => {
  assert.equal(extractText(fx.textMessage({ text: "plain" })), "plain");
  assert.equal(extractText(fx.extendedTextReply({ text: "quoted reply" })), "quoted reply");
  assert.equal(extractText(fx.imageMessage({ caption: "a caption" })), "a caption");
  assert.equal(extractText(fx.audioMessage({})), undefined);
});

test("a reply records the quoted message id", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.extendedTextReply({ id: "R1", quotedId: "M0", text: "re" }));
  assert.equal(h.messages.get("33612345678@s.whatsapp.net", "R1")?.quotedId, "M0");
});

test("an ingested media message records its media type but downloads nothing", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.imageMessage({ id: "I1" }));
  const m = h.messages.get("33612345678@s.whatsapp.net", "I1");
  assert.equal(m?.kind, "image");
  assert.equal(m?.mediaSha, null, "ingest must stay lazy — no download at ingest time");
});

test("a LID-addressed message is canonicalized when the mapping is known", () => {
  const h = harness();
  h.contacts.linkIdentity("999@lid", "33612345678@s.whatsapp.net");
  h.ingest.ingestMessage(fx.lidMessage({ chat: "999@lid", id: "L1" }));
  assert.ok(h.chats.get("33612345678@s.whatsapp.net"), "a known LID must fold into the phone identity");
  assert.equal(h.chats.get("999@lid"), undefined);
});

test("an unknown LID is kept as-is rather than dropped", () => {
  const h = harness();
  h.ingest.ingestMessage(fx.lidMessage({ chat: "888@lid", id: "L2" }));
  assert.ok(h.chats.get("888@lid"));
});

test("ingesting the same message twice is idempotent", () => {
  const h = harness();
  const m = fx.textMessage({ id: "M1" });
  h.ingest.ingestMessage(m);
  h.ingest.ingestMessage(m);
  assert.equal(h.messages.count(), 1);
  assert.equal(h.chats.get("33612345678@s.whatsapp.net")?.unreadCount, 1, "a redelivery must not double-count unread");
});

test("ingestMessages is atomic and handles a history batch", () => {
  const h = harness();
  h.ingest.ingestMessages([fx.textMessage({ id: "A", ts: 1 }), fx.textMessage({ id: "B", ts: 2 })]);
  assert.equal(h.messages.count(), 2);
});

test("a malformed message is logged and skipped, not thrown", () => {
  const h = harness();
  assert.doesNotThrow(() => { h.ingest.ingestMessage({ key: {} } as never); });
  assert.equal(h.messages.count(), 0);
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `pnpm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/wa/fixtures.ts`**

Plain object literals shaped like `WAMessage`, each taking an overrides object with sensible defaults (`chat: "33612345678@s.whatsapp.net"`, `id: "M1"`, `ts: 1700000000`, `fromMe: false`). Example:

```ts
export function textMessage(o: { chat?: string; id?: string; text?: string; ts?: number; fromMe?: boolean } = {}): WAMessage {
  return {
    key: { remoteJid: o.chat ?? "33612345678@s.whatsapp.net", id: o.id ?? "M1", fromMe: o.fromMe ?? false },
    messageTimestamp: o.ts ?? 1_700_000_000,
    message: { conversation: o.text ?? "hello" },
  } as WAMessage;
}
```

The `as WAMessage` cast is acceptable **in fixtures only** — these are deliberately partial. Do not cast in production code.

**`classify` and `extractText` must build on Baileys' own helpers, not a hand-rolled switch.** Both `getContentType(content: proto.IMessage): keyof proto.IMessage | undefined` and `normalizeMessageContent(content): WAMessageContent | undefined` are exported (`lib/Utils/messages.d.ts:27,34`). `normalizeMessageContent` unwraps the `ephemeralMessage` / `viewOnceMessage` / `viewOnceMessageV2` / `documentWithCaptionMessage` envelopes that WhatsApp routinely wraps real content in; a switch over `m.message` directly sees the *wrapper* and classifies a view-once photo as `other`, storing no text and no media kind. So:

```
const content = normalizeMessageContent(m.message);
const type = getContentType(content);         // "imageMessage" | "conversation" | …
```
and map `type` onto our `MessageKind`. `extractText` reads, in order: `content.conversation`, `content.extendedTextMessage?.text`, then the `caption` of whichever media wrapper `type` names.

- [ ] **Step 4: Write `src/wa/ingest.ts`**

`attach(sock)` registers:

| Event | Handling |
| --- | --- |
| `messages.upsert` | `ingestMessages(payload.messages)`. |
| `messages.update` | For each: a `status` change → `setStatus`; a `protocolMessage` edit → `markEdited`; a revoke → `markDeleted`. |
| `messages.delete` | **Also** a revoke path — the payload is either `{ keys: WAMessageKey[] }` or `{ jid, all: true }`. Handle the `keys` form with `markDeleted` per key; ignore the `all` form (we keep history deliberately). Verified present in `BaileysEventMap` (`lib/Types/Events.d.ts:58`); a revoke can arrive on either this event or `messages.update`, so both must tombstone or deletions are silently missed. |
| `messages.reaction` | `reactions.set(...)` with the canonical sender; an empty `text` removes. |
| `message-receipt.update` | `setStatus` only; never creates a row. |
| `chats.upsert` / `chats.update` | `chats.ensure` + `chats.patch`. |
| `chats.delete` | Ignored — we keep history deliberately (forward-only store). |
| `contacts.upsert` / `contacts.update` | `contacts.upsertMany`. |
| `messaging-history.set` | Batch: contacts, then chats, then messages — **in chunks of 500, one transaction per chunk**, not one transaction for the whole payload. A single history sync can carry thousands of messages; wrapping all of them in one transaction means a single malformed message rolls back the entire sync, and the event never comes again (Risk 7). Per-chunk transactions bound the loss, and `ingestMessage`'s own try/catch bounds it further to the one bad message. Log the chunk count and total at info — a large initial sync otherwise looks like a hang. |
| `lid-mapping.update` | `contacts.linkIdentity` for each pair. |

`ingestMessage(m)` steps, in order:

1. Read `key.remoteJid`; skip and log at debug if absent. Skip `status@broadcast` entirely.
2. `chatId = canonicalId(remoteJid, { pnForLid })` — the lookup is `contacts.pnForLid`.
3. `isGroup = isGroupJid(chatId)`; `chats.ensure(chatId, isGroup)`.
4. `senderId` = for a group, `canonicalId(key.participant)`; for a DM, `key.fromMe ? selfId() : chatId`.
5. `kind = classify(m)`, `text = extractText(m)`, `quotedId` from `contextInfo.stanzaId`.
6. `raw = proto.WebMessageInfo.encode(m).finish()`. Task 7's `getMessage` unwraps this envelope back to the inner `message` — keep the two in step.
7. `messages.upsert({...})`.
8. `chats.touch(chatId, ts)`; if `!fromMe` **and the message was newly inserted**, `chats.bumpUnread(chatId, 1)`; if `fromMe`, `chats.clearUnread(chatId)`.

Step 8's "newly inserted" condition is what makes the idempotency test pass: have `messages.upsert` return a boolean `inserted` (add it to the `MessagesRepo` signature in Task 5 — `upsert(m): boolean`) rather than counting blind. **Update Task 5's interface accordingly; this is the one cross-task signature to keep in sync.**

**Step 8's unread bump is suppressed on the history path.** `messaging-history.set` carries the server-authoritative `Chat.unreadCount`, which the chat half of the batch has already written. Bumping again per inbound message on top of it makes a chat WhatsApp reports as fully read surface an unread count equal to its inbound history depth — visible directly in `wa_chats_list`. So `ingestMessages` takes an option (`{ bumpUnread: false }`) that the history path passes and the live `messages.upsert` path does not; `chats.touch` and `clearUnread` still run either way. The live path keeps the unconditional bump because it covers both `notify` and the offline `append` drain, which really are unread. (Found by review during Task 8.)

A consequence worth stating: a `messaging-history.set` whose `chats` array omits a chat that its `messages` array mentions leaves that chat at `unreadCount = 0`, because the history path no longer bumps and no server count arrived to write. That is the intended reading of "the server's count is authoritative" — the alternative, falling back to counting inbound rows, is exactly the inflation this rule removes.

**The per-chunk transaction needs a test that fails when it is removed.** It is the sole justification for handing `IngestDeps` the raw `db`, and neither a row count nor the per-message try/catch observes it — both stay green if `inTransaction`'s body is replaced by a bare `fn()`. Cover it with a failure raised *outside* `ingestMessage`'s own catch (a repo stub that throws on the 501st row) asserting chunk 1 survived and chunk 2 did not.

Wrap the whole body in try/catch; on error log `{ err, messageId }` at warn and return.

- [ ] **Step 5: Run the test, see it pass**

Run: `pnpm test`
Expected: PASS, 16 ingest tests.

- [ ] **Step 6: Commit**

```bash
git add src/wa
git commit -m "feat(wa): event ingest mapping Baileys events onto the repositories"
```

---

### Task 9: Send operations

**Files:**
- Create: `src/wa/send.ts`, `src/wa/send.test.ts`

**Interfaces:**
- Consumes: `WaConnection` (Task 7), `Ingest` (Task 8), `MessagesRepo` (Task 5), `canonicalId` (Task 3).
- Produces:
  ```ts
  export type SendRef = { chatId: string; messageId: string };
  export type FileSource = { kind: "path"; path: string } | { kind: "data"; base64: string };
  export type SendFileOptions = {
    filename?: string | undefined; mimetype?: string | undefined; caption?: string | undefined;
    replyTo?: string | undefined; asVoiceNote?: boolean | undefined;
  };
  export type Sender = {
    sendText(chat: string, text: string, replyTo?: string): Promise<SendRef>;
    sendFile(chat: string, src: FileSource, opts: SendFileOptions): Promise<SendRef>;
    react(chat: string, messageId: string, emoji: string): Promise<void>;
    markRead(chat: string, messageId: string): Promise<void>;
    editMessage(chat: string, messageId: string, text: string): Promise<void>;
    deleteMessage(chat: string, messageId: string): Promise<void>;
  };
  export type SendDeps = {
    conn: WaConnection; ingest: Ingest; messages: MessagesRepo; contacts: ContactsRepo;
    maxUploadBytes: number;
  };
  export class NotFoundError extends Error {}
  export class NotOwnMessageError extends Error {}
  export function makeSender(deps: SendDeps): Sender;
  ```

- [ ] **Step 1: Write the failing test**

`src/wa/send.test.ts` uses a fake connection whose `requireSocket()` returns a recording stub:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeSender, NotFoundError, NotOwnMessageError, type SendDeps } from "./send.js";

function harness(rows: Record<string, { fromMe: boolean }> = {}) {
  const calls: { jid: string; content: unknown; options: unknown }[] = [];
  const sock = {
    sendMessage: async (jid: string, content: unknown, options: unknown) => {
      calls.push({ jid, content, options });
      return { key: { remoteJid: jid, id: "SENT1", fromMe: true }, messageTimestamp: 1, message: {} };
    },
    readMessages: async () => {},
  };
  const ingested: unknown[] = [];
  const deps = {
    conn: { requireSocket: () => sock },
    ingest: { ingestMessage: (m: unknown) => ingested.push(m) },
    messages: { get: (_c: string, id: string) => (rows[id] ? { id, ...rows[id] } : undefined) },
    contacts: { pnForLid: () => undefined },
    maxUploadBytes: 1024,
  } as unknown as SendDeps;
  return { sender: makeSender(deps), calls, ingested, sock };
}

test("sendText sends and re-ingests the produced message", async () => {
  const h = harness();
  const ref = await h.sender.sendText("33612345678@s.whatsapp.net", "salut");
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0]?.content, { text: "salut" });
  assert.equal(ref.messageId, "SENT1");
  assert.equal(h.ingested.length, 1, "a sent message must take the inbound path");
});

test("sendText with replyTo attaches the quoted message", async () => {
  const h = harness({ M0: { fromMe: false } });
  await h.sender.sendText("c@s.whatsapp.net", "re", "M0");
  assert.ok((h.calls[0]?.options as { quoted?: unknown }).quoted, "replyTo must become a quoted option");
});

test("replyTo pointing at an unknown message fails loudly", async () => {
  const h = harness();
  await assert.rejects(() => h.sender.sendText("c@s.whatsapp.net", "re", "GHOST"), NotFoundError);
});

test("the chat argument is canonicalized before sending", async () => {
  const h = harness();
  await h.sender.sendText("33612345678:12@s.whatsapp.net", "hi");
  assert.equal(h.calls[0]?.jid, "33612345678@s.whatsapp.net");
});

test("sendFile from base64 rejects oversize payloads before sending", async () => {
  const h = harness();
  const big = Buffer.alloc(2048).toString("base64");
  await assert.rejects(() => h.sender.sendFile("c@s.whatsapp.net", { kind: "data", base64: big }, {}), /exceeds/i);
  assert.equal(h.calls.length, 0);
});

test("sendFile picks the content key from the mimetype", async () => {
  const h = harness();
  const data = Buffer.from("x").toString("base64");
  await h.sender.sendFile("c@s.whatsapp.net", { kind: "data", base64: data }, { mimetype: "image/png", caption: "cap" });
  assert.ok(Object.hasOwn(h.calls[0]?.content as object, "image"));
  await h.sender.sendFile("c@s.whatsapp.net", { kind: "data", base64: data }, { mimetype: "application/pdf", filename: "a.pdf" });
  assert.ok(Object.hasOwn(h.calls[1]?.content as object, "document"));
});

test("asVoiceNote sends audio with ptt set", async () => {
  const h = harness();
  const data = Buffer.from("x").toString("base64");
  await h.sender.sendFile("c@s.whatsapp.net", { kind: "data", base64: data }, { mimetype: "audio/ogg", asVoiceNote: true });
  const content = h.calls[0]?.content as { audio?: unknown; ptt?: boolean };
  assert.ok(content.audio);
  assert.equal(content.ptt, true);
});

test("react sends a reaction keyed to the target message", async () => {
  const h = harness({ M1: { fromMe: false } });
  await h.sender.react("c@s.whatsapp.net", "M1", "👍");
  const content = h.calls[0]?.content as { react?: { text: string; key: { id: string } } };
  assert.equal(content.react?.text, "👍");
  assert.equal(content.react?.key.id, "M1");
});

test("an empty emoji is a valid reaction removal", async () => {
  const h = harness({ M1: { fromMe: false } });
  await h.sender.react("c@s.whatsapp.net", "M1", "");
  assert.equal((h.calls[0]?.content as { react: { text: string } }).react.text, "");
});

test("edit and delete refuse messages that are not ours", async () => {
  const h = harness({ THEIRS: { fromMe: false }, MINE: { fromMe: true } });
  await assert.rejects(() => h.sender.editMessage("c@s.whatsapp.net", "THEIRS", "nope"), NotOwnMessageError);
  await assert.rejects(() => h.sender.deleteMessage("c@s.whatsapp.net", "THEIRS"), NotOwnMessageError);
  await h.sender.editMessage("c@s.whatsapp.net", "MINE", "ok");
  await h.sender.deleteMessage("c@s.whatsapp.net", "MINE");
  assert.equal(h.calls.length, 2);
});

test("markRead calls readMessages with the target key", async () => {
  const h = harness({ M1: { fromMe: false } });
  let seen: unknown = null;
  h.sock.readMessages = async (keys: unknown) => { seen = keys; };
  await h.sender.markRead("c@s.whatsapp.net", "M1");
  assert.ok(Array.isArray(seen) && seen.length === 1);
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `pnpm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/wa/send.ts`**

- Every method starts with `const jid = canonicalId(chat, { pnForLid: deps.contacts.pnForLid })` and `const sock = deps.conn.requireSocket()`. `requireSocket` throwing is exactly the "fail fast with the state named" behaviour the spec calls for — do not catch it.
- `replyTo` resolution: `messages.get(jid, replyTo)`; missing → `NotFoundError`. Build the `quoted` option from the stored row's raw bytes decoded back to a `WAMessage`.
- `sendFile`: decode base64 (or `readFile` the path), enforce `maxUploadBytes` on the **decoded** length before doing anything else, then choose the content key by mimetype prefix — `image/*` → `image`, `video/*` → `video`, `audio/*` → `audio` (with `ptt: true` when `asVoiceNote`), everything else → `document` (which requires `fileName`). Default the mimetype from the filename extension, and fall back to `application/octet-stream`.
- `editMessage` / `deleteMessage`: load the row, reject with `NotOwnMessageError` unless `fromMe`. Edit is `sendMessage(jid, { text, edit: key })`; delete is `sendMessage(jid, { delete: key })`.
- **`markRead` is "up to and including", and the contract has to say so.** Baileys' `readMessages(keys)` marks exactly the keys it is given (`lib/Socket/business.d.ts:37`) — there is no "mark everything older" primitive. The tool is described as marking a chat read up to a message, so the sender must expand it: select every non-`from_me` message in the chat with `ts <=` the target's `ts` and `deleted_ts IS NULL`, rebuild a `WAMessageKey` for each, and pass the batch to `readMessages`. Cap the expansion at 500 keys, newest first, so a chat with a decade of backlog does not build an unbounded array. Then `chats.clearUnread(jid)` locally.
  Add to `MessagesRepo` (Task 5) the query this needs:
  ```ts
  /** Non-from_me, non-deleted messages at or before `ts`, newest first. Backs markRead's expansion. */
  unreadKeysUpTo(chatId: string, ts: number, limit: number): { id: string; senderId: string }[];
  ```
  and a test in `send.test.ts`:
  ```ts
  test("markRead expands to every older unread message, not just the target", async () => {
    const h = harness({ M1: { fromMe: false }, /* rows at ts 1,2,3 */ });
    let keys: unknown[] = [];
    h.sock.readMessages = async (k: unknown[]) => { keys = k; };
    await h.sender.markRead("c@s.whatsapp.net", "M3");
    assert.equal(keys.length, 3, "marking M3 read must also mark M1 and M2");
  });
  ```
- Every mutating call re-ingests: `if (sent) deps.ingest.ingestMessage(sent)`. This is Invariant 2 and it is why sent messages never need their own mapping.

- [ ] **Step 4: Run the test, see it pass**

Run: `pnpm test`
Expected: PASS, 11 send tests.

- [ ] **Step 5: Commit**

```bash
git add src/wa
git commit -m "feat(wa): send operations with quoting, reactions, edits, deletes and re-ingest"
```

---

### Task 10: Media store and conversion

**Files:**
- Create: `src/media/store.ts`, `src/media/convert.ts`, `src/media/convert.test.ts`, `src/media/store.test.ts`

**Interfaces:**
- Consumes: `MessagesRepo` (Task 5), `WaConnection` (Task 7), `Config` (Task 1).
- Produces:
  ```ts
  export type MediaFile = { path: string; sha256: string; bytes: number; mimetype: string };
  export type MediaStore = {
    /** Download (or return the cached copy of) a message's media. Throws MediaUnavailableError. */
    fetch(chatId: string, messageId: string): Promise<MediaFile>;
    pathFor(sha256: string): string;
  };
  export class MediaUnavailableError extends Error {}
  export function makeMediaStore(deps: { dir: string; messages: MessagesRepo; conn: WaConnection; logger: Logger }): MediaStore;

  // convert.ts — every function shells out to ffmpeg or uses jimp; none touch Baileys.
  export type ImageBlock = { data: string; mimeType: string };
  /** Re-encode to JPEG and downscale until under maxBytes. Returns base64. */
  export function imageBlock(path: string, maxBytes: number): Promise<ImageBlock>;
  /** N evenly spaced keyframes as JPEG image blocks. */
  export function videoKeyframes(path: string, count: number, maxBytes: number): Promise<ImageBlock[]>;
  /** 16 kHz mono WAV, the only format whisper.cpp accepts. Returns the output path. */
  export function toWav16k(path: string, outPath: string): Promise<void>;
  /** Duration in seconds via ffprobe. */
  export function probeDuration(path: string): Promise<number | undefined>;
  export function pdfText(path: string, maxChars: number): Promise<string>;
  export class ConversionError extends Error {}
  ```

- [ ] **Step 1: Write the failing tests**

`src/media/store.test.ts` covers caching with a stubbed downloader; `src/media/convert.test.ts` covers real conversions against tiny generated fixtures (ffmpeg is available in the dev container and the CI image):

```ts
// convert.test.ts — excerpt
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { imageBlock, probeDuration, toWav16k, videoKeyframes } from "./convert.js";

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "wa-conv-"));
after(() => { rmSync(dir, { recursive: true, force: true }); });

const png = join(dir, "in.png");
const mp4 = join(dir, "in.mp4");
const wav = join(dir, "in.wav");

before(async () => {
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:duration=1", "-frames:v", "1", png]);
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-t", "3", mp4]);
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", wav]);
});

test("imageBlock returns base64 JPEG under the cap", async () => {
  const b = await imageBlock(png, 20_000);
  assert.equal(b.mimeType, "image/jpeg");
  assert.ok(Buffer.from(b.data, "base64").byteLength <= 20_000);
});

test("a small image is not needlessly upscaled or corrupted", async () => {
  const b = await imageBlock(png, 5_000_000);
  assert.ok(Buffer.from(b.data, "base64").byteLength > 0);
});

test("videoKeyframes returns the requested number of distinct frames", async () => {
  const frames = await videoKeyframes(mp4, 3, 100_000);
  assert.equal(frames.length, 3);
  assert.notEqual(frames[0]?.data, frames[2]?.data, "frames must be sampled across the video, not duplicated");
});

test("toWav16k produces a 16 kHz mono wav", async () => {
  const out = join(dir, "out.wav");
  await toWav16k(wav, out);
  assert.ok(statSync(out).size > 0);
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=sample_rate,channels",
    "-of", "default=noprint_wrappers=1:nokey=1", out]);
  assert.match(stdout, /16000/);
  assert.match(stdout.trim().split("\n")[1] ?? "", /^1$/);
});

test("probeDuration reads a duration", async () => {
  const d = await probeDuration(wav);
  assert.ok(d && d > 1.5 && d < 2.5, `expected ~2s, got ${String(d)}`);
});

test("a conversion failure raises ConversionError rather than hanging", async () => {
  await assert.rejects(() => imageBlock(join(dir, "does-not-exist.png"), 1000));
});
```

- [ ] **Step 2: Run the tests, see them fail**

Run: `pnpm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/media/convert.ts`**

- A single `runTool(bin, args, timeoutMs)` helper wrapping `execFile` with a timeout, `maxBuffer`, and `ConversionError` on non-zero exit including the tail of stderr. Reuse the process-group kill idea from the retired `server.ts:131` — ffmpeg spawns no children here, so a plain `kill` suffices, but the timeout is mandatory.
- `imageBlock` uses **jimp** (Constraint 7). The v1 API — confirmed against jimp 1.6.1 and against baileys' own use of it in `lib/Utils/messages-media.js:116-123` — is:
  ```ts
  import { Jimp } from "jimp";
  const img = await Jimp.read(path);            // img.width, img.height
  img.resize({ w: targetWidth });               // object arg in v1, NOT resize(w, h)
  const buf = await img.getBuffer("image/jpeg", { quality: 80 });
  ```
  Loop: while the encoded JPEG exceeds `maxBytes`, halve the longest edge (floor 320 px) and re-encode at quality 80, then 60. Return the first result under the cap, or the smallest attempt with a logged warning. Note jimp 1.x is ESM-first with a `"."` export only — import from `"jimp"`, never a deep path.
- `videoKeyframes` calls `probeDuration`, picks `count` evenly spaced timestamps skipping the first and last 5 %, and extracts each with `ffmpeg -ss <t> -i <path> -frames:v 1 -q:v 4`. Run them sequentially — parallel ffmpeg on a NAS is a false economy.
- `toWav16k` is `ffmpeg -i <in> -ar 16000 -ac 1 -c:a pcm_s16le <out>`.
- `pdfText` shells out to `pdftotext` when present and returns a clear `ConversionError` naming the missing tool otherwise. **`poppler-utils` must be added to the runtime image in Task 15.**

- [ ] **Step 4: Write `src/media/store.ts`**

- `fetch` reads the message row, throws `MediaUnavailableError` if the row has no media kind.
- If `media_sha` is set and `pathFor(sha)` exists, return it without touching the network.
- Otherwise decode `raw` back to a `WAMessage` and call Baileys' `downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage })`, hash the bytes with `node:crypto` `sha256`, write to `dir/<sha>` atomically (write to `<sha>.tmp`, then `rename`), and `messages.setMedia(chatId, id, sha, mimetype)`.
- A download failure becomes `MediaUnavailableError` with a message that says WhatsApp media URLs expire and the message is likely too old — that is the common case and it deserves a comprehensible error.
- **A cache hit must not touch the connection; a cache miss requires it.** `fetch` reads the row and returns the cached file *before* calling `conn.requireSocket()`, so previously-downloaded media stays readable while the socket is down. On a miss with no live socket, let `ConnectionUnavailableError` propagate — the tool layer turns it into an `errorResult` naming the state, which is the honest answer ("this was never downloaded and I cannot reach WhatsApp right now"). Do not swallow it into `MediaUnavailableError`; the two mean different things and the caller's next action differs (wait vs. give up).
- The store never deletes anything. Cache eviction is out of scope for v1; note it in the README as a known growth area.

- [ ] **Step 5: Run the tests, see them pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/media
git commit -m "feat(media): content-addressed download cache and ffmpeg/jimp conversions"
```

---

### Task 11: Transcription

**Files:**
- Create: `src/media/transcribe.ts`, `src/media/transcribe.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1), `toWav16k`/`probeDuration` (Task 10), `MessagesRepo.setTranscript` (Task 5).
- Produces:
  ```ts
  export type Transcriber = {
    /** Ensure the model file exists locally, downloading it once. */
    ensureModel(): Promise<string>;
    /** Transcribe an audio or video file. Throws TranscriptionError. */
    transcribeFile(path: string): Promise<string>;
    available(): Promise<boolean>;
  };
  export class TranscriptionError extends Error {}
  export function makeTranscriber(deps: {
    config: Config; logger: Logger;
    fetchImpl?: typeof fetch | undefined;   // injectable for tests
  }): Transcriber;
  /** Exported for tests: strip whisper.cpp's `[00:00:00.000 --> …]` timestamps and join lines. */
  export function cleanTranscript(raw: string): string;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cleanTranscript } from "./transcribe.js";

test("cleanTranscript strips timestamps and joins lines", () => {
  const raw = [
    "[00:00:00.000 --> 00:00:03.000]   Bonjour, comment ça va ?",
    "[00:00:03.000 --> 00:00:05.500]   Très bien merci.",
  ].join("\n");
  assert.equal(cleanTranscript(raw), "Bonjour, comment ça va ? Très bien merci.");
});

test("cleanTranscript drops whisper's non-speech annotations and blank lines", () => {
  const raw = "[00:00:00.000 --> 00:00:02.000]   [MUSIQUE]\n\n[00:00:02.000 --> 00:00:04.000]   Salut.";
  assert.equal(cleanTranscript(raw), "Salut.");
});

test("cleanTranscript is a no-op on already-clean text", () => {
  assert.equal(cleanTranscript("Juste du texte."), "Juste du texte.");
});

test("cleanTranscript collapses runs of whitespace", () => {
  assert.equal(cleanTranscript("a\n\n   b\t\tc"), "a b c");
});
```

Model download and the whisper subprocess are **not** unit-tested — they need a 574 MB file and a binary that is not present in the dev environment. They are covered by the manual smoke script in Task 15. Say so in a comment at the top of the test file so the gap is deliberate and visible rather than an oversight.

- [ ] **Step 2: Run the test, see it fail**

Run: `pnpm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/media/transcribe.ts`**

- `ensureModel()` resolves `${config.dataDir}/models/ggml-${config.whisperModel}.bin`. If absent, download from
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin` to a `.part` file, then rename. Log start and completion at info with the byte count — a silent 574 MB download looks like a hang. Serialize concurrent calls behind a single in-flight promise so two simultaneous transcribe requests do not both download.

  A 574 MB fetch over an unreliable link is the most failure-prone step in the whole system, so spell the handling out rather than leaving it to the implementer:

  1. **Always delete a stale `.part` before starting.** A previous crash leaves one behind; appending to it silently produces a corrupt model, and whisper's failure on a corrupt model is unintelligible. Never resume — restart.
  2. **Non-2xx is a hard error** naming the status and the URL. A 404 means the model name is wrong; say so, and list that `WA_WHISPER_MODEL` is the knob.
  3. **Stall timeout, not a total timeout.** Fail if no bytes arrive for 60 s; do not cap total duration, because a slow link legitimately takes many minutes.
  4. **Verify the size before renaming.** Compare the written byte count against `Content-Length` when the server sent one, and reject a mismatch — a truncated model otherwise looks installed forever.
  5. **`ENOSPC` is reported as itself**, not as a generic download failure. 574 MB into a full volume is a realistic first-run failure on a NAS.
  6. On any failure, unlink the `.part` and clear the in-flight promise so the next call retries cleanly rather than awaiting a rejected promise forever.

  These are the only network-fetch semantics in the codebase; do not reach for a retry library.
- `transcribeFile(path)`:
  1. `probeDuration`; if it exceeds `config.whisperMaxSeconds`, throw `TranscriptionError` naming the limit and the actual duration. This is Risk 6.
  2. `toWav16k` into a temp file under `config.dataDir/tmp`.
  3. `execFile(config.whisperBin, ["-m", model, "-f", wav, "-t", String(threads), "-nt", "-l", "auto"])` with a generous timeout (duration × 10, floor 60 s).
  4. `cleanTranscript(stdout)`; empty output throws `TranscriptionError` ("no speech detected").
  5. Always remove the temp wav in a `finally`.
- `available()` runs the binary with `--help` and returns whether it exited cleanly, so `wa_health` can report transcription readiness without attempting a transcription.
- `-nt` suppresses timestamps, but `cleanTranscript` still strips them defensively — whisper.cpp's flags have changed across versions and a regex is cheaper than a version check.

- [ ] **Step 4: Run the test, see it pass**

Run: `pnpm test`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/media
git commit -m "feat(media): whisper.cpp transcription with lazy model provisioning"
```

---

### Task 12: MCP plumbing and the six read tools

**Files:**
- Create: `src/mcp/context.ts`, `src/mcp/result.ts`, `src/mcp/result.test.ts`, `src/mcp/tools/reads.ts`, `src/mcp/tools/reads.test.ts`

**Interfaces:**
- Consumes: every repository, `WaConnection`, `Transcriber`, `Config`.
- Produces:
  ```ts
  // context.ts
  export type ToolContext = {
    config: Config; logger: Logger;
    chats: ChatsRepo; contacts: ContactsRepo; messages: MessagesRepo; reactions: ReactionsRepo;
    conn: WaConnection; sender: Sender; media: MediaStore; transcriber: Transcriber;
  };
  // result.ts
  export type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
  export type ToolResult = { content: Block[]; isError?: boolean };
  /** JSON, pretty-printed, truncated to config.maxResultChars with an explicit note. */
  export function jsonResult(data: unknown, maxChars: number): ToolResult;
  export function textResult(text: string): ToolResult;
  export function errorResult(err: unknown): ToolResult;
  /** A message row shaped for the model: resolved sender, reactions, media flags. */
  export function presentMessage(m: MessageRow, ctx: ToolContext): Record<string, unknown>;
  export function presentChat(c: ChatRow, ctx: ToolContext): Record<string, unknown>;
  // tools/reads.ts
  export function registerReadTools(server: McpServer, ctx: ToolContext): void;
  ```

- [ ] **Step 1: Write the failing tests**

`src/mcp/result.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { errorResult, jsonResult, textResult } from "./result.js";

test("jsonResult pretty-prints", () => {
  const r = jsonResult({ a: 1 }, 1000);
  assert.equal(r.content[0]?.type, "text");
  assert.match((r.content[0] as { text: string }).text, /"a": 1/);
});

test("jsonResult truncates with a note naming the real size", () => {
  const r = jsonResult({ big: "x".repeat(5000) }, 200);
  const text = (r.content[0] as { text: string }).text;
  assert.ok(text.length < 600);
  assert.match(text, /truncated/i);
  assert.match(text, /5\d{3}/, "the note must state the true total length");
});

test("errorResult marks isError and never leaks a stack", () => {
  const r = errorResult(new Error("boom"));
  assert.equal(r.isError, true);
  const text = (r.content[0] as { text: string }).text;
  assert.match(text, /boom/);
  assert.doesNotMatch(text, /at .*\.ts:/, "a stack trace is noise in a model's context");
});

test("errorResult handles non-Error throwables", () => {
  assert.match((errorResult("plain string").content[0] as { text: string }).text, /plain string/);
  assert.ok(errorResult(undefined).isError);
});

test("textResult passes text through", () => {
  assert.equal((textResult("hi").content[0] as { text: string }).text, "hi");
});
```

`src/mcp/tools/reads.test.ts` registers the tools on a real `McpServer`, then invokes handlers through an in-memory MCP client pair and asserts both the schemas and the results. **Write this harness first — Task 13 imports it**, so put it in `src/mcp/tools/harness.ts` (not a `.test.ts` file, so it is importable without running its tests):

```ts
// src/mcp/tools/harness.ts — test-only helper. It is NOT a .test.ts file, so tsconfig.build.json's
// "src/**/*.test.ts" exclusion does not cover it: add this path to that exclude array explicitly
// (Task 12 step 3), or test scaffolding ships in dist/.
//
// Import paths verified against @modelcontextprotocol/sdk@1.30.0: its exports map is
// [".", "./client", "./server", "./validation", "./validation/*", "./experimental", "./*"] —
// the trailing "./*" wildcard is what makes the deep paths below resolve.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConnectionUnavailableError } from "../../wa/connection.js";
import { buildMcpServer } from "../server.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeChatsRepo } from "../../db/chats.js";
import { openDb } from "../../db/client.js";
import { makeContactsRepo } from "../../db/contacts.js";
import { makeMessagesRepo } from "../../db/messages.js";
import { makeReactionsRepo } from "../../db/reactions.js";
import type { ToolContext } from "../context.js";

export type HarnessOptions = {
  readOnly?: boolean;
  state?: "disconnected" | "connected" | "logged_out";
  seed?: (ctx: ToolContext) => void;
  overrides?: Partial<ToolContext>;
};

/** Build a real store, a real McpServer, and a linked in-memory client. */
export async function harness(opts: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wa-mcp-"));
  const db = openDb(join(dir, "t.db"));
  const state = opts.state ?? "connected";
  const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
  const transcribeCalls = { n: 0 };

  const ctx = {
    config: { readOnly: opts.readOnly ?? false, maxResultChars: 200_000, videoKeyframes: 2, maxImageBytes: 5_000_000 },
    logger,
    chats: makeChatsRepo(db),
    contacts: makeContactsRepo(db),
    messages: makeMessagesRepo(db),
    reactions: makeReactionsRepo(db),
    conn: {
      snapshot: () => ({ state, lastEventAt: Date.now(), lastConnectedAt: null, attempts: 0,
                         needsPairing: state === "logged_out", selfId: "33600000000@s.whatsapp.net" }),
      requireSocket: () => { throw new ConnectionUnavailableError(state); },
      onStateChange: () => {},
    },
    sender: {
      sendText: async () => ({ chatId: "c", messageId: "S1" }),
      sendFile: async () => ({ chatId: "c", messageId: "S2" }),
      react: async () => {}, markRead: async () => {},
      editMessage: async () => {}, deleteMessage: async () => {},
    },
    media: { fetch: async () => ({ path: "/dev/null", sha256: "abc", bytes: 1, mimetype: "image/jpeg" }),
             pathFor: (s: string) => `/tmp/${s}` },
    transcriber: {
      ensureModel: async () => "/models/x.bin",
      transcribeFile: async () => { transcribeCalls.n++; return "transcrit"; },
      available: async () => true,
    },
    ...opts.overrides,
  } as unknown as ToolContext;

  opts.seed?.(ctx);

  const server = buildMcpServer(ctx);          // Task 13; for Task 12's own tests, register only reads
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, ctx, transcribeCalls, close: async () => { await client.close(); await server.close(); } };
}
```

Add `"src/mcp/tools/harness.ts"` to `tsconfig.build.json`'s `exclude` array alongside `src/**/*.test.ts`, so test scaffolding never ships in `dist/`.

Task 12's own tests register only the read tools; pass an option or call `registerReadTools` directly until Task 13 exists.

```ts
test("wa_health reports the connection state and row counts without a socket", async () => {
  const { client } = await harness({ state: "disconnected" });
  const res = await client.callTool({ name: "wa_health", arguments: {} });
  const data = JSON.parse((res.content as [{ text: string }])[0].text) as Record<string, unknown>;
  assert.equal(data["connection"], "disconnected");
  assert.equal(typeof data["counts"], "object");
});

test("every read tool works while the connection is down", async () => {
  const { client } = await harness({ state: "disconnected" });
  for (const name of ["wa_chats_list", "wa_messages_list", "wa_contacts_search", "wa_groups_list"]) {
    const res = await client.callTool({ name, arguments: name === "wa_contacts_search" ? { query: "a" } : {} });
    assert.notEqual(res.isError, true, `${name} must not require a socket`);
  }
});

test("wa_messages_search returns transcript hits labelled as such", async () => { /* … */ });
test("wa_messages_list resolves sender names rather than returning bare jids", async () => { /* … */ });
test("cursor pagination is stable across pages", async () => { /* … */ });
test("a limit above the cap is rejected by the schema", async () => { /* … */ });
```

- [ ] **Step 2: Run the tests, see them fail**

Run: `pnpm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/mcp/result.ts` and `src/mcp/context.ts`**

`jsonResult` reuses the truncation shape from the retired `server.ts:311` — that wording was good and the model reads it well. `presentMessage` returns `{ id, chat, ts, from_me, sender: { id, name }, kind, text, transcript, quoted_id, status, edited, deleted, media: { type, available } , reactions: [...] }`. Resolving the name costs one indexed lookup per row; that is acceptable at the page sizes involved, and `presentMessage` is the only place it happens.

- [ ] **Step 4: Write `src/mcp/tools/reads.ts`**

Register the six tools with Zod schemas. Shared conventions:

- `limit` is `z.number().int().positive().max(200).default(50)`.
- **Pagination is a round trip, so the response carries the next cursor.** A `cursor` input with no `next_cursor` output is unusable — the caller has no way to build page 2. Put both halves in `src/mcp/cursor.ts` so all six tools share one implementation:
  ```ts
  export function encodeCursor(offset: number): string;          // base64url of {"o":<n>}
  export function decodeCursor(c: string | undefined): number;   // 0 when absent; throws CursorError on malformed
  export class CursorError extends Error {}
  ```
  Every paginated tool returns `{ items: [...], next_cursor: string | null }` — `null` when the page came back shorter than `limit`, meaning there is no more. Never return a `next_cursor` that would yield an empty page. A malformed cursor is an `errorResult`, not a silent reset to offset 0.
- **`presentMessage` does not embed reactions.** Doing so costs one query per row — 50 extra queries for a default page — and the reaction shape is not something a list view needs. Reactions appear only in single-message contexts (`wa_download_media`, and any future single-message tool), shaped `{ emoji: string, from: { id, name } }[]`. List and search results instead carry `reaction_count: number`, filled for the whole page by one grouped query:
  `SELECT message_id, COUNT(*) c FROM reactions WHERE chat_id = ? AND message_id IN (…) GROUP BY message_id`.
- Every description states plainly what the tool reads and that it works offline, because that is the property a model needs to know when the socket is down.
- **`wa_health` and `/health` are the same function.** Two hand-written health payloads drift within a week, and Task 14's `startHttp` already takes a `health: () => Record<string, unknown>` callback. Define it once, in `src/mcp/health.ts`:
  ```ts
  export type HealthReport = {
    ok: boolean; connection: ConnectionState; needs_pairing: boolean;
    last_event_age_sec: number; last_connected_at: number | null; self_id: string | null;
    counts: { chats: number; messages: number; contacts: number };
    schema_version: number; transcription_available: boolean; read_only: boolean;
  };
  export function buildHealth(ctx: ToolContext): HealthReport;
  ```
  `wa_health` returns `jsonResult(buildHealth(ctx))`; `main.ts` passes `() => buildHealth(ctx)` into `startHttp`. **Neither may contain the bearer token or the ntfy token** (Constraint 14), which is why the type is a closed record rather than a spread of `Config`.
- **`ok` is false when `connection === "logged_out"`,** and true in every other state. A logged-out server is permanently dead until someone re-pairs it, and a `/health` that keeps reporting `ok: true` makes it look fine forever. Every other state — including `disconnected` mid-backoff — is `ok: true`, because the read tools genuinely still work and a transient reconnect must not flap the container's health.
- `schema_version` comes from a new `MetaRepo` (`src/db/meta.ts`, Task 2): `get(key): string | undefined`, `set(key, value): void`, `schemaVersion(): number`. Add it to `ToolContext`. Nothing else in the plan gave the tool layer a way to read `meta`.

- [ ] **Step 5: Run the tests, see them pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp
git commit -m "feat(mcp): tool context, result shaping, and the six read tools"
```

---

### Task 13: Write tools, media tools, server assembly

**Files:**
- Create: `src/mcp/tools/writes.ts`, `src/mcp/tools/media.ts`, `src/mcp/server.ts`, `src/mcp/server.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function registerWriteTools(server: McpServer, ctx: ToolContext): void;
  export function registerMediaTools(server: McpServer, ctx: ToolContext): void;
  export function buildMcpServer(ctx: ToolContext): McpServer;
  ```

- [ ] **Step 1: Write the failing test**

`src/mcp/server.test.ts`, driven through a linked in-memory client:

```ts
test("read-only mode hides every write tool", async () => {
  const { client } = await harness({ readOnly: true });
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ["wa_send_text", "wa_send_file", "wa_react", "wa_mark_read", "wa_edit_message", "wa_delete_message"]) {
    assert.ok(!names.includes(n), `${n} must not be advertised in read-only mode`);
  }
  assert.ok(names.includes("wa_chats_list"));
});

test("all fourteen tools are advertised in normal mode", async () => {
  const { client } = await harness({ readOnly: false });
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "wa_chats_list", "wa_contacts_search", "wa_delete_message", "wa_download_media", "wa_edit_message",
    "wa_groups_list", "wa_health", "wa_mark_read", "wa_messages_list", "wa_messages_search",
    "wa_react", "wa_send_file", "wa_send_text", "wa_transcribe",
  ]);
});

test("every tool name is wa_-prefixed", async () => {
  const { client } = await harness({});
  for (const t of (await client.listTools()).tools) assert.match(t.name, /^wa_/);
});

test("a write tool fails with the connection state named when the socket is down", async () => {
  const { client } = await harness({ state: "disconnected" });
  const res = await client.callTool({ name: "wa_send_text", arguments: { chat: "c@s.whatsapp.net", text: "hi" } });
  assert.equal(res.isError, true);
  assert.match((res.content as [{ text: string }])[0].text, /disconnected/);
});

test("wa_send_file rejects a request carrying neither path nor data", async () => {
  const { client } = await harness({});
  const res = await client.callTool({ name: "wa_send_file", arguments: { chat: "c@s.whatsapp.net" } });
  assert.equal(res.isError, true);
});

test("wa_download_media returns image blocks for an image message", async () => { /* stubbed MediaStore */ });
test("wa_download_media returns the cached transcript for an audio message", async () => { /* … */ });
test("wa_transcribe caches: a second call does not re-run whisper", async () => { /* counts transcriber calls */ });
```

- [ ] **Step 2: Run the test, see it fail**

Run: `pnpm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the write tools**

Six tools, each thin: validate with Zod, call `ctx.sender`, return `jsonResult`. Catch `ConnectionUnavailableError`, `NotFoundError` and `NotOwnMessageError` and turn them into `errorResult` — a tool must return `isError`, never throw through the SDK.

`wa_send_file`'s input is a Zod object with optional `path` and `data`, refined so exactly one is present. A discriminated union would be cleaner in TypeScript but produces a JSON Schema that several MCP clients render poorly; the refinement keeps the schema flat.

**`path` must be confined to a configured directory.** As written this is an arbitrary-file-read primitive: the caller names any path *inside the container* and the server sends its contents to a WhatsApp conversation. `/proc/self/environ` alone would exfiltrate `WA_MCP_TOKEN` and `NTFY_TOKEN`; `${WA_DATA_DIR}/wa.db` would exfiltrate every message ever received. Bearer auth does not fix this — it is a privilege escalation from "can call tools" to "can read the filesystem".

Add to Task 1's `Config`:

```ts
sendFileDir: string | undefined;   // WA_SEND_FILE_DIR — unset disables path-based sending entirely
```

Default **unset**, meaning `wa_send_file` accepts `data` only and rejects `path` with a message naming the variable. When set, `send.ts` resolves the candidate with `realpath` and rejects anything that does not sit under the equally-realpathed `sendFileDir` — resolve both sides, then compare with a trailing separator, so a symlink out and a `..` sibling-prefix (`/data/uploads-evil` against `/data/uploads`) are both refused. Reject before reading the file, and never echo the resolved path back in the error.

This is the right default because the deployment is a container serving a *remote* client: a server-side path has no legitimate caller. It exists at all only for a future bind-mounted upload directory.

Add these cases to `src/wa/send.test.ts` (Task 9), where the enforcement lives:

```ts
test("path sending is refused when no directory is configured", async () => {
  const h = harness({ sendFileDir: undefined });
  await assert.rejects(() => h.sender.sendFile("c@s.whatsapp.net", { kind: "path", path: "/etc/passwd" }, {}),
    /WA_SEND_FILE_DIR/);
});

test("path sending refuses traversal, symlink escape and sibling-prefix paths", async () => {
  const h = harness({ sendFileDir: "/data/uploads" });
  for (const p of ["/etc/passwd", "/data/uploads/../../etc/passwd", "/data/uploads-evil/x", "/proc/self/environ"]) {
    await assert.rejects(() => h.sender.sendFile("c@s.whatsapp.net", { kind: "path", path: p }, {}), /outside/i, p);
  }
});
```

- [ ] **Step 4: Write the media tools**

`wa_download_media(chat, message_id)`:

1. Load the row; unknown → `errorResult`.
2. `ctx.media.fetch(...)`.
3. Dispatch on `kind`:
   - `image` / `sticker` → one image block from `imageBlock`, plus a text block naming dimensions and size.
   - `video` → `config.videoKeyframes` image blocks, plus a text block with duration and dimensions, plus the transcript if one is cached.
   - `audio` → cached transcript as text if present; otherwise a text block giving the duration and telling the model to call `wa_transcribe`.
   - `document` → PDF becomes extracted text; anything else returns the cache path plus size and mimetype.
4. Never return more than `config.videoKeyframes + 1` image blocks in one result.

`wa_transcribe(chat, message_id)`:

1. If `messages.get(...)?.transcript` is set, return it immediately — this is the cache and it is checked first, which is what the caching test asserts.
2. Otherwise `media.fetch`, then `transcriber.transcribeFile`, then `messages.setTranscript` (which re-indexes into FTS through the trigger), then return the text.
3. `TranscriptionError` becomes an `errorResult` carrying the reason verbatim.

- [ ] **Step 5: Write `src/mcp/server.ts`**

```ts
export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "wa-mcp", version: VERSION });
  registerReadTools(server, ctx);
  registerMediaTools(server, ctx);
  if (!ctx.config.readOnly) registerWriteTools(server, ctx);
  return server;
}
```

`VERSION` is read from `package.json` at build time via a small `src/version.ts` constant — do not `readFileSync` package.json at runtime, since `dist/` does not sit next to it in the image.

- [ ] **Step 6: Run the tests, see them pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp
git commit -m "feat(mcp): write and media tools, server assembly with read-only gating"
```

---

### Task 14: HTTP transport, alerts, bootstrap

**Files:**
- Create: `src/http.ts`, `src/http.test.ts`, `src/alerts.ts`, `src/alerts.test.ts`, `src/main.ts`, `src/version.ts`

**Interfaces:**
- Produces:
  ```ts
  // http.ts
  export type HttpDeps = { config: Config; logger: Logger; buildServer: () => McpServer; health: () => Record<string, unknown> };
  export type HttpHandle = { close(): Promise<void>; port: number };
  export function startHttp(deps: HttpDeps): Promise<HttpHandle>;
  // alerts.ts
  export type Alerter = { onState(s: ConnectionState): void; selfTest(): Promise<void>; stop(): void };
  export function makeAlerter(deps: { config: Config; logger: Logger; fetchImpl?: typeof fetch }): Alerter;
  ```

- [ ] **Step 1: Write the failing tests**

`src/http.test.ts` starts the server on port 0 and drives it with `fetch`:

```ts
test("/health is public and returns the snapshot", async () => {
  const h = await start({ mcpToken: "secret" });
  const res = await fetch(`http://127.0.0.1:${h.port}/health`);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body["ok"], true);
});

test("/health never contains a token", async () => {
  const h = await start({ mcpToken: "super-secret-value", ntfy: { baseUrl: "u", topic: "t", token: "ntfy-secret" } });
  const text = await (await fetch(`http://127.0.0.1:${h.port}/health`)).text();
  assert.doesNotMatch(text, /super-secret-value|ntfy-secret/);
});

test("/mcp without a bearer token is 401 when a token is configured", async () => {
  const h = await start({ mcpToken: "secret" });
  const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(res.status, 401);
});

test("/mcp with the wrong bearer token is 401", async () => {
  const h = await start({ mcpToken: "secret" });
  const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
    method: "POST", body: "{}",
    headers: { "content-type": "application/json", authorization: "Bearer nope" },
  });
  assert.equal(res.status, 401);
});

test("token comparison is constant-time and length-safe", async () => {
  const h = await start({ mcpToken: "secret" });
  for (const t of ["", "s", "secret-plus-more"]) {
    const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: "POST", body: "{}", headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
    });
    assert.equal(res.status, 401, `token ${JSON.stringify(t)}`);
  }
});

test("with no token configured /mcp is open and a warning was logged at boot", async () => { /* … */ });
test("an unknown session id is rejected with a JSON-RPC error, not a crash", async () => { /* … */ });
test("a full initialize handshake succeeds and returns a session id", async () => { /* … */ });
```

`src/alerts.test.ts` injects a fake `fetch` and asserts the debounce:

```ts
test("no alert before the grace period elapses", () => { /* … */ });
test("a down alert fires once, then re-alerts on the configured cadence", () => { /* … */ });
test("recovery sends exactly one notice and resets the state", () => { /* … */ });
test("logged_out alerts immediately, without waiting for the grace", () => { /* … */ });
test("alerts are a no-op when ntfy is unconfigured", () => { /* … */ });
test("the ntfy token is sent as a Bearer header and never logged", () => { /* … */ });
```

- [ ] **Step 2: Run the tests, see them fail**

Run: `pnpm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/http.ts`**

Port the session handling from the retired `server.ts:713-776` — it was correct and battle-tested — with three changes:

1. **Express 5** (Risk 8): `express.json()` still applies, but error middleware must be `(err, req, res, next)` with four parameters and registered last. Async handlers still need the `wrap()` helper; Express 5 does forward rejected promises, but the explicit wrapper keeps the 500 shape ours.
2. **Bearer auth** in front of `/mcp` only. Compare with `crypto.timingSafeEqual` over `Buffer`s, guarding unequal lengths first (that is what the length-safe test pins). No token configured → log one warning at boot and allow.
3. **No stateless mode.** `WACLI_MCP_STATELESS` is gone (Constraint 15 and the Phase-1 decision); one code path, sessions always.

Keep: the 30-minute idle sweeper with `unref()`, the `Mcp-Session-Id` handling, the JSON-RPC error envelopes, and the "only an initialize request may open a session" rule.

- [ ] **Step 4: Write `src/alerts.ts`**

Port the debounce logic from the retired `sync-supervisor.ts`, driven by `onState` rather than by polling a heartbeat file:

- `connected` → if we were alerting, publish a recovery notice and reset.
- `disconnected`/`connecting` → start (or continue) a grace timer of `SYNC_STALE_SEC`-equivalent; on expiry publish "down", then re-publish every `REALERT_SEC`.
- `logged_out` → publish immediately at high priority; this needs a human and no grace period helps.
- Publishing is `POST` to `NTFY_BASE_URL` with a JSON body and `Authorization: Bearer` when a token is set. Failures are logged at warn and never propagate — an alerting failure must not take down the server.

Timer handles are `unref()`d so they never hold the process open.

- [ ] **Step 5: Write `src/main.ts`**

Wiring only, in this order, with no logic of its own:

```ts
const config = loadConfig(process.env);
const db = openDb(config.dbPath);
const repos = { chats: …, contacts: …, messages: …, reactions: … };
const auth = makeAuthStore(db);
const ingest = makeIngest({ ...repos, logger, selfId: () => conn.snapshot().selfId });
const conn = makeConnection({ config, logger, auth, loadMessage, onSocket: ingest.attach });
const sender = makeSender({ conn, ingest, messages: repos.messages, contacts: repos.contacts, maxUploadBytes });
const media = makeMediaStore({ dir: config.mediaDir, messages: repos.messages, conn, logger });
const transcriber = makeTranscriber({ config, logger });
const alerter = makeAlerter({ config, logger });
conn.onStateChange(alerter.onState);
const ctx: ToolContext = { config, logger, ...repos, conn, sender, media, transcriber };
const http = await startHttp({ config, logger, buildServer: () => buildMcpServer(ctx), health });
await conn.start();
```

The `ingest`/`conn` cycle is broken with a `let` and a lazy `selfId` closure — resolve it that way rather than introducing a container.

Signal handling: on `SIGINT`/`SIGTERM`, close the HTTP server, stop the connection, stop the alerter, close the database, exit `130`/`143`. `uncaughtException` and `unhandledRejection` are logged and **do not exit** — this is a long-lived HTTP server and one bad request must not drop the WhatsApp connection for everything else. That inverts the retired stdio behaviour deliberately, because there is no stdio mode any more.

- [ ] **Step 6: Run the tests, see them pass**

Run: `pnpm test` then `pnpm check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src
git commit -m "feat(server): Express 5 transport with bearer auth, ntfy alerting, bootstrap wiring"
```

---

### Task 15: Image, CI, documentation, smoke test

**Files:**
- Modify: `Dockerfile`, `.github/workflows/docker.yml`, `README.md`, `CLAUDE.md`
- Create: `.github/workflows/ci.yml`, `smoke.mjs`

- [ ] **Step 1: Rewrite the `Dockerfile`**

Three stages. The whisper stage is a pure copy — no compiler anywhere in this file:

```dockerfile
# ── 1) whisper.cpp binaries (prebuilt, amd64) ────────────────────────────────
# Pinned by digest: the :main tag moves. Ubuntu 22.04/glibc 2.35 -> bookworm/2.36 is forward-compatible.
FROM ghcr.io/ggml-org/whisper.cpp@sha256:375cf0e9e4b5598454493878ce09c4de72ed3e4ed8f41e77a25e1acd9b4112b5 AS whisper

# ── 2) Build the server ──────────────────────────────────────────────────────
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# ── 3) Runtime ───────────────────────────────────────────────────────────────
FROM node:24-slim
# ffmpeg: keyframes, wav conversion, voice notes. poppler-utils: pdftotext.
# libgomp1: required by whisper-cli, absent from node:*-slim.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg poppler-utils libgomp1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# whisper-cli is dynamically linked against libwhisper/libggml* living beside it — copy the directory.
COPY --from=whisper /app/build/bin /opt/whisper/bin
ENV LD_LIBRARY_PATH=/opt/whisper/bin
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data/wa && chown -R node:node /data/wa
ENV NODE_ENV=production \
    WA_DATA_DIR=/data/wa \
    WA_WHISPER_BIN=/opt/whisper/bin/whisper-cli \
    PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>r.json()).then(b=>process.exit(b.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
```

Verify the copy actually works before moving on:

```bash
docker build -t wa-mcp:test .
docker run --rm wa-mcp:test /opt/whisper/bin/whisper-cli --help | head -3
```
Expected: whisper's usage text, not a loader error. If it reports a missing shared object, the `LD_LIBRARY_PATH` or the copied directory is wrong.

- [ ] **Step 2: Add `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
      - run: sudo apt-get update && sudo apt-get install -y ffmpeg
      - run: pnpm test
```

ffmpeg is installed because Task 10's conversion tests genuinely exercise it. Installing it after `pnpm check` keeps the fast gate first.

- [ ] **Step 3: Update `.github/workflows/docker.yml`**

Delete the `WACLI_REF` build-arg, the `workflow_dispatch` input that fed it, and the comment about pinning a wacli release. `env.IMAGE` stays `ghcr.io/${{ github.repository }}` — it follows the repository rename automatically.

**Gate the image build on the quality gate, by moving the `check` job into `docker.yml` as a second job** — one file, one `needs: check` edge, no `workflow_call` indirection. `ci.yml` from Step 2 keeps running on pull requests (where no image is built); `docker.yml` runs `check` then `build` on `main` and tags. Pick this shape and no other: two workflows that both define `check` is the kind of divergence that leaves one of them silently unmaintained.

- [ ] **Step 4: Rewrite `smoke.mjs`**

A manual end-to-end script against a running server, documented as requiring a paired store. It should: hit `/health`, open an MCP session, list tools and assert there are 14, call `wa_chats_list`, and — when given `--transcribe <chat> <messageId>` — call `wa_transcribe` and print the result. This is the only coverage whisper and the model download get (noted deliberately in Task 11), so it must actually exercise them.

Keep it out of the lint/type gate exactly as before: it is `.mjs` and `eslint.config.js` no longer needs to name it since it now lives outside `src/`.

- [ ] **Step 5: Rewrite `README.md`**

Full replacement. Sections: what it is, the 14 tools in a table, prerequisites, first-run pairing (the `WA_PHONE_NUMBER` flow and where to read the code), configuration table (every var from Task 1's `Config`), Docker usage, the quality gate, testing, and two honest notes — that Baileys is an unofficial client with real ban risk, and that the media cache is never evicted in v1.

- [ ] **Step 6: Rewrite `CLAUDE.md`**

Every current bullet describes the wacli architecture and is now false. Replace with the new gotchas, which are: the identity chokepoint in `src/wa/jid.ts` (Constraint 11); `getMessage` making the store load-bearing; FTS5 external-content triggers; the pinned Baileys prerelease; the whisper binary's shared-library trail and `LD_LIBRARY_PATH`; `node:sqlite` being experimental so a Node bump is deliberate; and HTTP-only transport with bearer auth.

- [ ] **Step 7: Full verification**

```bash
pnpm check && pnpm test && pnpm build
docker build -t wa-mcp:test .
grep -rn "wacli\|WACLI" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=docs
```
Expected: all green; the grep prints nothing outside `docs/` (the spec and this plan keep their historical references, which is correct).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(ops): Node 24 image with prebuilt whisper.cpp, CI gate, rewritten docs"
```

---

## Definition of done

1. `pnpm check`, `pnpm test`, and `pnpm build` all pass.
2. `docker build` succeeds and `whisper-cli --help` runs inside the image.
3. All 14 tools are advertised, `wa_`-prefixed, and the 6 write tools disappear under `WA_MCP_READONLY=1`.
4. No `wacli`/`WACLI` identifier, env var, or string survives outside `docs/`.
5. The Constraint-11 check from Task 3 step 5 — the same command, excluding `*.test.ts`, `src/wa/jid.ts` and `src/wa/fixtures.ts` — prints nothing.
6. Read tools return results with the connection down.
7. `wa_send_file` refuses a `path` argument when `WA_SEND_FILE_DIR` is unset, and refuses traversal when it is set.
8. A `lid-mapping.update` for a LID that already has a conversation leaves exactly one chat, carrying the earlier messages, searchable under the phone identity.

