# wa-mcp — one Node process: Baileys + SQLite/FTS5 + a 14-tool MCP surface over HTTP

`README.md` is the reference (tools, env vars, pairing, Docker). This file is the list of things that
are non-obvious enough to get broken by an edit that looks correct.

- **All raw JID interpretation lives in `src/wa/jid.ts`.** No other production module may contain
  `@lid`, `@s.whatsapp.net` or `@g.us`, or split a JID on `@` or `:`. WhatsApp hands the same human
  two identities — a phone JID and a LID — and folding them is the difference between one
  conversation and two half-empty ones. Every layer above calls `canonicalId(jid, contacts)` and
  treats the result as an opaque key. The enforcing check, which must print nothing:
  ```bash
  grep -rn '@lid\|@s\.whatsapp\.net\|@g\.us' src/ --include='*.ts' \
    | grep -v '\.test\.ts:' | grep -v 'src/wa/jid\.ts:' | grep -v 'src/wa/fixtures\.ts:'
  ```
  Test files and `src/wa/fixtures.ts` are excluded because they carry JID *literals as data* — a
  test for identity folding has to name a LID. The same scoping applies to the "no `wacli`/`WACLI`"
  rule: `src/config.test.ts` names the old variables solely to assert they are ignored.

- **`getMessage` makes the store load-bearing for the protocol, not just for reads.** Baileys calls
  it to re-encrypt a message a peer failed to decrypt, and to build a quote. It is wired in
  `src/main.ts` to `messages.getRaw(...)`, which returns the stored protobuf envelope — so the `raw`
  BLOB column is not a debugging convenience, and a change that stops persisting it silently breaks
  retries and replies rather than failing a test. It is typed to return the **inner** `proto.IMessage`,
  not the `WebMessageInfo` envelope.

- **FTS5 is an external-content table** (`content='messages'`, `content_rowid='rowid'`), kept in sync
  by three triggers in `src/db/schema.ts` — insert, delete, and an update that deletes-then-inserts.
  An external-content FTS index stores no copy of the text, so a write that bypasses those triggers
  leaves the index wrong forever with no error. In particular `setTranscript` writes through the
  repository *because* the UPDATE trigger is what puts transcribed speech into the search index.

- **Which FTS column matched is read from the `snippet()` markers, never from a snippet being empty.**
  `snippet()` returns unmarked leading text for a column that took no part in the match, so "empty
  means no match" mislabels the common case — a captioned video whose caption does not contain the
  query but whose transcript does — as a text hit. `src/db/messages.ts` asks for `char(1)`/`char(2)`
  delimiters and tests for those markers.

- **Baileys is pinned exactly: `"baileys": "7.0.0-rc14"`.** No caret, no tilde. It is a prerelease
  and rc→rc has broken APIs before. Bumping it is a task with a test run, not a dependency refresh.
  Related: `src/mcp/tools/*` must not import from `baileys` — Baileys types stop at the `wa/` and
  `media/` boundary.

- **`whisper-cli` is dynamically linked against libraries that live beside it.** `libwhisper.so.1`,
  `libggml.so.0`, `libggml-base.so.0`, `libggml-cpu.so.0` all sit in the same directory, plus
  `libgomp.so.1` from the system, which `node:*-slim` does not ship. Hence the Dockerfile copying the
  whole `/app/build/bin` directory, `ENV LD_LIBRARY_PATH=/opt/whisper/bin`, and `libgomp1` in the
  apt line. Copying just the binary produces a loader error at the first transcription, not at build
  time. Verify after any image change:
  ```bash
  docker build -t wa-mcp:test . && docker run --rm wa-mcp:test /opt/whisper/bin/whisper-cli --help | head -3
  ```
  The whisper stage is pinned **by digest** — `:main` moves — and is amd64-only, which is why
  `docker.yml` builds `linux/amd64` and nothing else.

- **`node:sqlite` is experimental, so the Node version is a compatibility decision.** `engines.node`
  is `">=24"` and the image is `node:24-slim`; a Node major bump is a deliberate check that FTS5,
  external-content tables and the `run()`/`get()` shapes still behave, never a routine upgrade. The
  suite is the check — run it on the new major before changing anything.

- **HTTP transport only, with bearer auth.** No stdio transport and no `StdioServerTransport` import.
  Middleware order in `src/http.ts` is load-bearing: `/health` is registered **before** the bearer
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
  wrong. Cross-field rules go in the handler (`fileSource` in `src/mcp/tools/writes.ts`) and in the
  description. Same class of trap: a discriminated union renders as a top-level `anyOf`, which
  several clients present badly.

- **Read tools must work in every connection state** — they query SQLite and never touch the socket.
  Only write tools and a media *cache miss* may require a live connection.

- **Timestamps are integer Unix seconds, UTC, everywhere in the store.** `Number(m.messageTimestamp)`
  at the boundary, because protobuf may hand back a `Long` that fails silently in comparisons.
  Anything from `Date.now()` divides by 1000 and floors; the only milliseconds in the codebase carry
  `Ms` in the name.

- **The gate is `pnpm check` (prettier + eslint + tsc) and `pnpm test`, both green before a commit.**
  Full TS strict set, ESLint `strictTypeChecked` + `stylisticTypeChecked` at zero warnings; do not
  weaken a compiler option to make code compile. `smoke.mjs` is listed in `eslint.config.js`'s
  `ignores` — being outside `src/` is *not* enough, because `projectService` fatals on any file no
  tsconfig includes. Symmetrically, `src/mcp/tools/harness.ts` and `src/wa/fixtures.ts` are named
  one by one in `tsconfig.build.json`'s `exclude`: both are test scaffolding, neither is a
  `*.test.ts` file, so that glob catches neither and anything left out compiles into `dist/` and
  ships in the image as dead code. Any new non-`*.test.ts` scaffolding needs a line there too.

- **`WA_SEND_FILE_DIR` is unset by default and that is a security decision.** `wa_send_file`'s `path`
  argument is an arbitrary-file-read primitive that would hand `/proc/self/environ` to a WhatsApp
  conversation; it is disabled entirely unless that variable names a directory, and refusals never
  echo the path they were asked to read. `WA_MCP_TOKEN` and `NTFY_TOKEN` appear in no log line, no
  error message and not in `/health`, which returns a closed record rather than a spread of `Config`.

- **The media cache is never evicted** (v1 scope, documented in `README.md`). `WA_MEDIA_DIR` grows
  monotonically, one sha256-named file per distinct attachment.

- **`smoke.mjs` is the only coverage whisper and the 574 MB model download get.** It is manual, needs
  a running server against a paired store, and is excluded from every gate. Run
  `node smoke.mjs --transcribe <chat> <messageId>` after any change to the image or the media
  pipeline.
