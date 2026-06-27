# Design — send arbitrary file *content* over MCP (`wacli_send_file_bytes`)

**Date:** 2026-06-27
**Status:** Approved (pre-implementation)
**Component:** `server.ts` (+ new `send-file.ts`, `send-file.test.ts`)

## Problem

`wacli-mcp` runs in production as a **remote** Docker container (HTTP transport,
behind Cloudflare Access; store `/data/wacli`, UID 1000). The current
`wacli_send_file` tool shells out to `wacli send file --file <path>`, reading the
path from the **container's** filesystem. A remote client therefore cannot send a
local file: the path doesn't exist server-side and there is no upload channel.

## Goal

Let a client send an arbitrary file whose **content** it supplies, with no
pre-existing server-side path.

## Decisions (settled during brainstorming)

1. **Two separate tools**, not one extended tool with a XOR param:
   - `wacli_send_file` is **renamed** to `wacli_send_file_path` (path-based,
     otherwise unchanged). This is a **breaking rename** — clients referencing
     `wacli_send_file` must update; called out in the README.
   - New `wacli_send_file_bytes` takes base64 content. No `file`/`content_base64`
     mutual-exclusion logic anywhere; `filename`-required is enforced by the zod
     schema itself.
2. **Temp dir:** `WACLI_UPLOAD_DIR`, default `os.tmpdir()`.
3. **Size cap:** `WACLI_MAX_UPLOAD_BYTES`, default 64 MiB, clamped 1 B…256 MiB via
   the existing `envInt`.
4. **HTTP body limit is derived from the upload cap** (not a separate magic
   number) so the two can't silently disagree.
5. **Logic lives in a focused, env-free `send-file.ts` module** so a unit test can
   import it without triggering `server.ts`'s top-level bootstrap.
6. **Tests:** `node:test` run via `tsx` (`pnpm test`); zero new dependencies.

## Tool surface

Both tools remain registered only inside `if (!READONLY)` (read-only mode hides
them, exactly as today).

### `wacli_send_file_path` (renamed from `wacli_send_file`, unchanged behaviour)

| param | type | notes |
|---|---|---|
| `to` | `string` (req) | recipient: JID, phone, or contact/group/chat name |
| `file` | `string` (req) | absolute path **on the container** filesystem |
| `caption` | `string?` | |
| `filename` | `string?` | display name (defaults to basename) |
| `pick` | `int>0 ?` | disambiguate an ambiguous `to` name |
| `reply_to` | `string?` | message ID to quote |

Implementation identical to the current tool — only the registered name changes.

### `wacli_send_file_bytes` (new)

| param | type | notes |
|---|---|---|
| `to` | `string` (req) | resolves like `wacli_send_file_path` |
| `content_base64` | `string` (req) | base64-encoded file content |
| `filename` | `string` (req, `.min(1)`) | basename + extension → WhatsApp infers MIME |
| `caption` | `string?` | |
| `pick` | `int>0 ?` | |
| `reply_to` | `string?` | |

Every field uses `.describe(...)` per file convention.

## `send-file.ts` (the testable unit)

Pure, env-free, no module-level side effects:

```ts
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
export function prepareSendFileBytes(
  input: SendFileBytesInput,
  opts: { uploadDir: string; maxUploadBytes: number },
): PreparedSend;
```

Steps, in this exact order so **nothing is written to disk before every check
passes**:

1. `base = path.basename(input.filename)`. Reject `""`, `"."`, `".."`.
   `path.basename` already strips any `../` segments and absolute prefixes, so
   there is no path traversal — the temp file always lands directly in
   `uploadDir`.
2. Strip whitespace from `content_base64`; validate
   `^[A-Za-z0-9+/]*={0,2}$` **and** `length % 4 === 0`; else throw
   "content_base64 is not valid base64".
3. Decode to a `Buffer`. Reject empty (decoded length 0). Reject
   `length > maxUploadBytes` with an explicit "exceeds max upload size
   (N > M bytes)" message. (The decoded check is the authoritative cap; the HTTP
   body limit below is the outer guard.)
4. `mkdirSync(uploadDir, { recursive: true })`;
   `tmp = path.join(uploadDir, ` `${randomUUID()}-${base}` `)`;
   `writeFileSync(tmp, buf)`.
5. `argv = ["send","file","--to",to,"--file",tmp,"--filename",base]` then append
   `--caption`, `--pick`, `--reply-to` when present. `--filename` is **always**
   `base` (never the UUID-prefixed temp name) so WhatsApp shows the real name.
6. `cleanup = () => { try { unlinkSync(tmp); } catch { /* best-effort */ } }`.

`filename` is guaranteed non-empty by the zod schema before this function is
called; the basename re-check defends against `filename` being only path
separators (e.g. `"/"` → basename `""`).

## Handler wiring in `server.ts`

```ts
({ to, content_base64, filename, caption, pick, reply_to }) => {
  let prepared: PreparedSend;
  try {
    prepared = prepareSendFileBytes(
      { to, content_base64, filename, caption, pick, reply_to },
      { uploadDir: UPLOAD_DIR, maxUploadBytes: MAX_UPLOAD_BYTES },
    );
  } catch (e) {
    return asResult(Promise.reject(e instanceof Error ? e : new Error(String(e))));
  }
  const { argv, cleanup } = prepared;
  return asResult(runWacli(argv).finally(cleanup));
}
```

`.finally(cleanup)` removes the temp file on **success and failure** while
propagating the original result/error. Validation failures surface through
`asResult`'s rejection path as the normal `{success:false,error}` envelope — the
same pattern as the existing `has_media`/`type=text` guard (server.ts:426).

New env-derived constants in `server.ts` (next to the existing ones):

```ts
const UPLOAD_DIR = process.env["WACLI_UPLOAD_DIR"] || os.tmpdir();
const MAX_UPLOAD_BYTES = envInt(
  process.env["WACLI_MAX_UPLOAD_BYTES"], 64 * 1024 * 1024, 1, 256 * 1024 * 1024,
);
```

(`import os from "node:os"` added.)

## HTTP body limit reconciliation

`express.json({ limit: "16mb" })` (server.ts:627) is replaced by a value derived
from the upload cap so a large upload isn't rejected with a 413 before reaching
the handler:

```ts
const HTTP_BODY_LIMIT_BYTES = Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 1024 * 1024;
// ...
app.use(express.json({ limit: HTTP_BODY_LIMIT_BYTES }));
```

At the 64 MiB default this allows an ~86 MiB body. Base64 inflates bytes by 4/3;
the +1 MiB covers JSON envelope overhead. Trade-off: non-upload request bodies are
also allowed up to this size — acceptable for this private, Access-gated server.

## Tests — `send-file.test.ts`

`node:test` + `node:assert`, importing only `prepareSendFileBytes` (no `runWacli`,
no real `wacli`). Each test uses a throwaway `uploadDir` under `os.tmpdir()`.

- **(a) happy path:** valid base64 + `filename` → assert argv equals
  `["send","file","--to",to,"--file",<tmp>,"--filename",<base>, …]`; assert
  `existsSync(tmp) === true`; call `cleanup()`; assert `existsSync(tmp) === false`.
- **(b) oversize:** `maxUploadBytes` tiny, content larger → throws; assert
  `readdirSync(uploadDir).length === 0` (no leaked temp).
- **(c) invalid base64** (e.g. `"not_base64!!"`) → throws.
- **(d) empty content** (`""` or decodes to 0 bytes) → throws.
- **(e) traversal-safe filename:** `filename = "../../etc/passwd"` → temp path's
  basename is `passwd` (no `..`), file lands inside `uploadDir`, `--filename`
  argv value is `passwd`.

`smoke.mjs` is unchanged (it lists tools + calls read tools; the renamed/new send
tools need no authed-store exercise there).

## Docs & gate

- **README.md:** rename the tool-table row to `wacli_send_file_path`, add a
  `wacli_send_file_bytes` row, note the breaking rename, and add
  `WACLI_UPLOAD_DIR` / `WACLI_MAX_UPLOAD_BYTES` to the env-var table (mentioning
  the body-limit linkage).
- **server.ts:** update the header env-doc block (lines 10–21) with the two new
  env vars; write `.describe(...)` text for the new tool.
- **tsconfig.json** `include`: add `send-file.ts` and `send-file.test.ts` (keeps
  them in the strict gate, per CLAUDE.md — runtime/test scripts go through `tsc`,
  not raw `.mjs`).
- **package.json:** add `"test"` script (`node --import tsx --test send-file.test.ts`,
  exact form finalized during implementation).

## Verification before concluding

- `pnpm check` (format + lint + typecheck) green.
- `pnpm test` green.
- Show the user the `server.ts` diff + a choices summary (new tool name, temp dir,
  default limits). **No commit/push until the user approves.**

## Out of scope (YAGNI)

- No streaming/chunked upload protocol — single base64 payload bounded by the body
  limit.
- No retention/GC of `WACLI_UPLOAD_DIR` beyond per-call cleanup (each call removes
  its own temp; nothing else writes there).
- No change to `wacli_send_file_path`'s behaviour beyond the rename.
