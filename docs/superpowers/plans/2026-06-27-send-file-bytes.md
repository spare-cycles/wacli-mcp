# `wacli_send_file_bytes` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a remote MCP client send an arbitrary file by supplying its base64 *content*, with no pre-existing server-side path.

**Architecture:** A new env-free, unit-tested module `send-file.ts` validates+decodes base64, writes a uniquely-named temp file under a writable dir, and returns the `wacli send file` argv plus a cleanup closure. `server.ts` exposes it as a new `wacli_send_file_bytes` tool (cleanup runs in `.finally`), renames the existing path-based tool to `wacli_send_file_path`, and derives the HTTP body limit from the upload cap.

**Tech Stack:** TypeScript (strict), `@modelcontextprotocol/sdk`, zod, express; `node:test` via `tsx` for unit tests; pnpm.

## Global Constraints

- Strict TS gate: `pnpm check` (format + lint + typecheck) must stay green. New `.ts` files MUST be added to `tsconfig.json` `include` (per CLAUDE.md — runtime/test scripts go through `tsc`, not raw `.mjs`).
- tsconfig is maximally strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`. Array index access yields `T | undefined`; guard before use. Local ESM imports MUST use the `.js` extension (e.g. `"./send-file.js"`) — tsc emits ESM and does not rewrite extensions.
- The send tools (both path and bytes) MUST remain registered only inside `if (!READONLY)` so read-only mode keeps hiding them.
- Never pass user content through a shell: argv stays an array passed to `spawn` (already the case via `runWacli`).
- **Git:** work on branch `feat/send-file-bytes`. Commits stay **local; never push**. Per the user's standing instruction ("ne commit/push que si je valide"), the executor MUST present the `server.ts` diff + a choices summary (new tool name, temp dir, default limits) and obtain explicit approval before the final commit. The per-task `Commit` steps below are local commits on this branch; the user reviews at each checkpoint.
- Env defaults: `WACLI_UPLOAD_DIR` → `os.tmpdir()`; `WACLI_MAX_UPLOAD_BYTES` → `67108864` (64 MiB), clamped `[1, 268435456]` (256 MiB) via the existing `envInt`.

---

## File Structure

- **Create `send-file.ts`** — pure logic: `prepareSendFileBytes(input, {uploadDir, maxUploadBytes}) → {argv, cleanup}`. No env reads, no `runWacli`, no module-level side effects (so the test can import it without booting the server).
- **Create `send-file.test.ts`** — `node:test` unit tests for `prepareSendFileBytes`.
- **Modify `server.ts`** — import the module + `node:os`; add `UPLOAD_DIR` / `MAX_UPLOAD_BYTES` / `HTTP_BODY_LIMIT_BYTES` constants; rename `wacli_send_file` → `wacli_send_file_path`; register `wacli_send_file_bytes`; derive `express.json` limit; update the header env-doc block.
- **Modify `tsconfig.json`** — add the two new files to `include`.
- **Modify `package.json`** — add a `test` script.
- **Modify `README.md`** — rename the tool row, add the bytes row, add the two env vars.

---

## Task 1: `send-file.ts` module + unit tests + test tooling

**Files:**
- Create: `send-file.ts`
- Test: `send-file.test.ts`
- Modify: `tsconfig.json` (`include`), `package.json` (`scripts.test`)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (Task 3 relies on these exact names/types):
  - `interface SendFileBytesInput { to: string; content_base64: string; filename: string; caption?: string; pick?: number; reply_to?: string }`
  - `interface PreparedSend { argv: string[]; cleanup: () => void }`
  - `function prepareSendFileBytes(input: SendFileBytesInput, opts: { uploadDir: string; maxUploadBytes: number }): PreparedSend`

- [ ] **Step 1: Add the `test` script and include the new files in the gate**

In `package.json`, add to `"scripts"` (after `"format:check"`):

```json
    "test": "node --import tsx --test send-file.test.ts",
```

In `tsconfig.json`, change the `include` line to:

```json
  "include": ["server.ts", "sync-supervisor.ts", "send-file.ts", "send-file.test.ts"]
```

- [ ] **Step 2: Write the failing test**

Create `send-file.test.ts`:

```ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareSendFileBytes } from "./send-file.js";

/** Read a flag's value out of an argv array, asserting both the flag and its value exist
 *  (keeps the test type-safe under noUncheckedIndexedAccess). */
function flagValue(argv: string[], flag: string): string {
  const i = argv.indexOf(flag);
  assert.ok(i >= 0, `argv missing ${flag}`);
  const v = argv[i + 1];
  assert.ok(v !== undefined, `argv missing value for ${flag}`);
  return v;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "wacli-upload-test-"));
}

test("decodes base64, writes a temp file, builds argv, and cleans up", () => {
  const dir = freshDir();
  try {
    const content = Buffer.from("hello world").toString("base64");
    const { argv, cleanup } = prepareSendFileBytes(
      { to: "123@s.whatsapp.net", content_base64: content, filename: "note.txt", caption: "hi" },
      { uploadDir: dir, maxUploadBytes: 1024 },
    );
    assert.equal(argv[0], "send");
    assert.equal(argv[1], "file");
    assert.equal(flagValue(argv, "--to"), "123@s.whatsapp.net");
    const tmp = flagValue(argv, "--file");
    assert.ok(tmp.startsWith(dir), "temp must live inside uploadDir");
    assert.equal(flagValue(argv, "--filename"), "note.txt");
    assert.equal(flagValue(argv, "--caption"), "hi");
    assert.ok(existsSync(tmp), "temp file should exist after prepare");
    cleanup();
    assert.ok(!existsSync(tmp), "temp file should be gone after cleanup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects content larger than maxUploadBytes without leaving a temp file", () => {
  const dir = freshDir();
  try {
    const content = Buffer.from("x".repeat(100)).toString("base64");
    assert.throws(
      () =>
        prepareSendFileBytes(
          { to: "t", content_base64: content, filename: "big.bin" },
          { uploadDir: dir, maxUploadBytes: 10 },
        ),
      /exceeds max upload size/,
    );
    assert.equal(readdirSync(dir).length, 0, "no temp file should be written on oversize");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects invalid base64", () => {
  const dir = freshDir();
  try {
    assert.throws(
      () =>
        prepareSendFileBytes(
          { to: "t", content_base64: "not_base64!!", filename: "x.txt" },
          { uploadDir: dir, maxUploadBytes: 1024 },
        ),
      /not valid base64/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects content that decodes to zero bytes", () => {
  const dir = freshDir();
  try {
    assert.throws(
      () =>
        prepareSendFileBytes(
          { to: "t", content_base64: "", filename: "x.txt" },
          { uploadDir: dir, maxUploadBytes: 1024 },
        ),
      /0 bytes/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strips path traversal from filename (basename only)", () => {
  const dir = freshDir();
  try {
    const content = Buffer.from("data").toString("base64");
    const { argv, cleanup } = prepareSendFileBytes(
      { to: "t", content_base64: content, filename: "../../etc/passwd" },
      { uploadDir: dir, maxUploadBytes: 1024 },
    );
    const tmp = flagValue(argv, "--file");
    assert.ok(tmp.startsWith(dir), "temp must stay inside uploadDir");
    assert.ok(!tmp.includes(".."), "temp path must not contain ..");
    assert.equal(flagValue(argv, "--filename"), "passwd");
    cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `Cannot find module './send-file.js'` (the module doesn't exist yet).

- [ ] **Step 4: Write the implementation**

Create `send-file.ts`:

```ts
/**
 * Prepare a `wacli send file` invocation from client-supplied base64 content.
 *
 * Kept env-free and side-effect-free at module scope so it is unit-testable in
 * isolation (server.ts has a top-level bootstrap that would start the MCP server
 * on import). The caller owns the env-derived `uploadDir` / `maxUploadBytes` and
 * is responsible for invoking `cleanup()` once the send completes (success or not).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface SendFileBytesInput {
  to: string;
  content_base64: string;
  filename: string;
  caption?: string;
  pick?: number;
  reply_to?: string;
}

export interface PreparedSend {
  argv: string[];
  cleanup: () => void;
}

// Canonical base64: the standard alphabet with 0–2 trailing '=' pad chars only.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function prepareSendFileBytes(
  input: SendFileBytesInput,
  opts: { uploadDir: string; maxUploadBytes: number },
): PreparedSend {
  // Only ever use the basename: path.basename strips any "../" segments and absolute
  // prefixes, so the temp file always lands directly in uploadDir (no traversal).
  const base = basename(input.filename);
  if (base === "" || base === "." || base === "..") {
    throw new Error(`invalid filename ${JSON.stringify(input.filename)}: must reduce to a basename`);
  }

  // Tolerate wrapped base64 (clients may insert newlines), then validate strictly.
  const b64 = input.content_base64.replace(/\s/g, "");
  if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw new Error("content_base64 is not valid base64");
  }

  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) {
    throw new Error("content_base64 decoded to 0 bytes");
  }
  if (buf.length > opts.maxUploadBytes) {
    throw new Error(`file exceeds max upload size (${buf.length} > ${opts.maxUploadBytes} bytes)`);
  }

  // All checks passed — only now touch disk.
  mkdirSync(opts.uploadDir, { recursive: true });
  const tmp = join(opts.uploadDir, `${randomUUID()}-${base}`);
  writeFileSync(tmp, buf);

  // --filename is always the real basename (never the UUID-prefixed temp name) so
  // WhatsApp shows the right name and infers the MIME type from the extension.
  const argv = ["send", "file", "--to", input.to, "--file", tmp, "--filename", base];
  if (input.caption !== undefined) argv.push("--caption", input.caption);
  if (input.pick !== undefined) argv.push("--pick", String(input.pick));
  if (input.reply_to !== undefined) argv.push("--reply-to", input.reply_to);

  const cleanup = (): void => {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort: file may already be gone */
    }
  };

  return { argv, cleanup };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all 5 tests green (`# pass 5`, `# fail 0`).

- [ ] **Step 6: Run the strict gate on the new files**

Run: `pnpm check`
Expected: PASS (format, lint, typecheck all clean). If prettier flags formatting, run `pnpm format` and re-run.

- [ ] **Step 7: Commit (local, on `feat/send-file-bytes`)**

```bash
git checkout -b feat/send-file-bytes 2>/dev/null || git checkout feat/send-file-bytes
git add send-file.ts send-file.test.ts tsconfig.json package.json
git commit -m "Add send-file.ts: prepare wacli send-file argv from base64 content"
```

---

## Task 2: Rename `wacli_send_file` → `wacli_send_file_path`

**Files:**
- Modify: `server.ts:518-533` (the existing `wacli_send_file` registration)
- Modify: `README.md:16` (tool table row)

**Interfaces:**
- Consumes: nothing.
- Produces: a tool named `wacli_send_file_path` with identical behaviour to the old `wacli_send_file` (path-based send).

- [ ] **Step 1: Rename the tool registration**

In `server.ts`, change the registration name only (line ~519). Replace:

```ts
    server.registerTool(
      "wacli_send_file",
      {
        description: "Send a file (image/video/audio/document) from a local path. `to` resolves like wacli_send_text.",
```

with:

```ts
    server.registerTool(
      "wacli_send_file_path",
      {
        description:
          "Send a file (image/video/audio/document) from a path on THIS server's filesystem. For a remote client without server-side files, use wacli_send_file_bytes instead. `to` resolves like wacli_send_text.",
```

Leave the `inputSchema` and the handler body unchanged.

- [ ] **Step 2: Update the README tool row**

In `README.md`, replace line 16:

```md
| `wacli_send_file` | Send a file (hidden in read-only mode). |
```

with:

```md
| `wacli_send_file_path` | Send a file from a path on the server's filesystem (hidden in read-only mode). Renamed from `wacli_send_file`. |
```

- [ ] **Step 3: Verify the gate passes**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit (local)**

```bash
git add server.ts README.md
git commit -m "Rename wacli_send_file -> wacli_send_file_path (path-based send)"
```

---

## Task 3: Add `wacli_send_file_bytes` tool, env knobs, and HTTP body limit

**Files:**
- Modify: `server.ts` — imports; env constants (near line 80); new tool registration (after the renamed tool, inside `if (!READONLY)`); `express.json` limit (line 627); header env-doc block (lines 10–21)
- Modify: `README.md` — add the bytes tool row (near line 16) and the two env vars (near line 150)

**Interfaces:**
- Consumes (from Task 1): `prepareSendFileBytes`, `PreparedSend` from `./send-file.js`.
- Produces: a `wacli_send_file_bytes` tool; constants `UPLOAD_DIR`, `MAX_UPLOAD_BYTES`, `HTTP_BODY_LIMIT_BYTES`.

- [ ] **Step 1: Add the imports**

In `server.ts`, add to the import block (after the `node:fs` import on line 24):

```ts
import { tmpdir } from "node:os";
```

and add (grouping with the other local-ish imports, after the SDK/express/zod imports near line 32):

```ts
import { prepareSendFileBytes, type PreparedSend } from "./send-file.js";
```

- [ ] **Step 2: Add the env constants**

In `server.ts`, after the `SYNC_STALE_SEC` constant (line 80), add:

```ts
// Where wacli_send_file_bytes writes its short-lived temp files (removed after each send).
const UPLOAD_DIR = process.env["WACLI_UPLOAD_DIR"] || tmpdir();
// Max decoded upload size for wacli_send_file_bytes. Default 64 MiB; clamped to [1 B, 256 MiB].
const MAX_UPLOAD_BYTES = envInt(process.env["WACLI_MAX_UPLOAD_BYTES"], 64 * 1024 * 1024, 1, 256 * 1024 * 1024);
// Base64 inflates bytes by 4/3; allow that plus ~1 MiB of JSON-envelope overhead so a within-cap
// upload isn't rejected with a 413 before reaching the handler. Derived from MAX_UPLOAD_BYTES so the
// wire limit and the decoded cap can never silently disagree.
const HTTP_BODY_LIMIT_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 1024 * 1024;
```

- [ ] **Step 3: Update the header env-doc block**

In `server.ts`, inside the top doc comment (after the `WACLI_MCP_LOCK_WAIT` lines, ~line 20), add:

```
 *   WACLI_UPLOAD_DIR            dir for temp files written by wacli_send_file_bytes (default: os.tmpdir())
 *   WACLI_MAX_UPLOAD_BYTES      max decoded size accepted by wacli_send_file_bytes (default 67108864 = 64 MiB)
```

- [ ] **Step 4: Register the new tool**

In `server.ts`, inside the `if (!READONLY)` block, immediately after the `wacli_send_file_path` registration closes (after line ~533, before the closing `}` of the block), add:

```ts
    server.registerTool(
      "wacli_send_file_bytes",
      {
        description:
          "Send a file whose content the client supplies as base64 — no server-side path needed (use this from a remote client). The bytes are written to a temp file and removed after the send. `to` resolves like wacli_send_text.",
        inputSchema: {
          to: z.string().min(1).describe("recipient: JID, phone number, or contact/group/chat name"),
          content_base64: z.string().min(1).describe("file content, base64-encoded"),
          filename: z
            .string()
            .min(1)
            .describe("display name incl. extension (only the basename is used; sets the WhatsApp MIME type)"),
          caption: z.string().optional(),
          pick: z.number().int().positive().optional(),
          reply_to: z.string().optional().describe("message ID to quote/reply to"),
        },
      },
      ({ to, content_base64, filename, caption, pick, reply_to }) => {
        let prepared: PreparedSend;
        try {
          prepared = prepareSendFileBytes(
            { to, content_base64, filename, caption, pick, reply_to },
            { uploadDir: UPLOAD_DIR, maxUploadBytes: MAX_UPLOAD_BYTES },
          );
        } catch (e) {
          // Surface validation failures through asResult's rejection path as the normal
          // {success:false,error} envelope (same pattern as the has_media guard above).
          return asResult(Promise.reject(e instanceof Error ? e : new Error(String(e))));
        }
        const { argv, cleanup } = prepared;
        // Remove the temp file whether the send succeeds or fails, while propagating the result.
        return asResult(runWacli(argv).finally(cleanup));
      },
    );
```

Note on `exactOptionalPropertyTypes`: the destructured optionals (`caption`, `pick`, `reply_to`) are `T | undefined` and assign cleanly to `SendFileBytesInput`'s `caption?: T` fields. No change needed.

- [ ] **Step 5: Derive the HTTP body limit**

In `server.ts`, replace line 627:

```ts
  app.use(express.json({ limit: "16mb" }));
```

with:

```ts
  app.use(express.json({ limit: HTTP_BODY_LIMIT_BYTES }));
```

- [ ] **Step 6: Update the README (tool row + env vars)**

In `README.md`, add after the `wacli_send_file_path` row (line ~16):

```md
| `wacli_send_file_bytes` | Send a file from client-supplied base64 content — no server-side path (hidden in read-only mode). |
```

In `README.md`, add after the `WACLI_MCP_LOCK_WAIT` row (line ~150):

```md
| `WACLI_UPLOAD_DIR` | `os.tmpdir()` | Dir where `wacli_send_file_bytes` writes its short-lived temp files (removed after each send). |
| `WACLI_MAX_UPLOAD_BYTES` | `67108864` (64 MiB) | Max **decoded** size accepted by `wacli_send_file_bytes`; clamped to [1, 268435456]. The HTTP body limit is derived from this (`ceil(× 4/3) + 1 MiB`) so a within-cap upload isn't rejected with a 413. |
```

- [ ] **Step 7: Verify the gate passes**

Run: `pnpm check`
Expected: PASS (format, lint, typecheck). Run `pnpm format` first if prettier complains, then re-run.

- [ ] **Step 8: Verify wiring end-to-end (smoke)**

Requires an authed store (per CLAUDE.md). Run:

```bash
WACLI_BIN=../wacli-latest/dist/wacli node smoke.mjs
```

Expected: the `TOOLS:` line lists both `wacli_send_file_path` and `wacli_send_file_bytes` (and no `wacli_send_file`), and the run ends with `SMOKE_OK`.

If no authed store is available, `pnpm check` from Step 7 plus `pnpm test` from Task 1 are the minimum gate; note that wiring wasn't smoke-tested.

- [ ] **Step 9: Present the diff for approval, then commit (local)**

Per the user's standing instruction, show the `server.ts` diff and a one-paragraph choices summary (new tool name `wacli_send_file_bytes`, temp dir = `WACLI_UPLOAD_DIR`/`os.tmpdir()`, default cap 64 MiB, derived HTTP body limit) and wait for approval. After approval:

```bash
git add server.ts README.md
git commit -m "Add wacli_send_file_bytes: send client-supplied base64 content"
```

Do **not** push.

---

## Self-Review

**Spec coverage:**
- Mutually-exclusive `file`/`content_base64` → superseded by user decision: two separate tools (`wacli_send_file_path` + `wacli_send_file_bytes`), no XOR. `filename` required via zod `.min(1)`. ✓ (Tasks 2, 3)
- Decode → temp file under writable dir, `WACLI_UPLOAD_DIR` default `os.tmpdir()`, unique name, basename-only (no traversal) → `prepareSendFileBytes`. ✓ (Task 1)
- Existing flow `wacli send file --file <tmp>` with `to/caption/filename/pick/reply_to`, temp removed in `finally` → argv build + `.finally(cleanup)`. ✓ (Tasks 1, 3)
- Max size `WACLI_MAX_UPLOAD_BYTES` default 64 MiB with explicit error; invalid base64 rejected; no shell injection (argv array) → ✓ (Tasks 1, 3)
- Conventions: `asResult` envelope, zod `.describe`, existing timeouts/caps → ✓ (Task 3 handler mirrors the existing send tools)
- README tool table + env table updated; tool description updated → ✓ (Tasks 2, 3)
- Read-only mode unchanged (tools stay inside `if (!READONLY)`) → ✓
- Tests proving (a) write+argv+cleanup, (b) size cap, plus invalid base64 / empty / traversal → ✓ (Task 1). [The "both/neither of file/content_base64" error case from the original spec no longer applies under the two-tool design.]
- HTTP body limit reconciled with upload cap → ✓ (Task 3, Step 5)

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command has expected output. ✓

**Type consistency:** `prepareSendFileBytes` / `SendFileBytesInput` / `PreparedSend` names and signatures are identical between Task 1 (definition) and Task 3 (consumption). The `flagValue` helper guards `noUncheckedIndexedAccess`. ✓
