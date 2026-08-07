import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createClient } from "./client.js";
import { ApiError } from "./errors.js";
import { routes, type BinaryPayload, type Route } from "./routes.js";
import { implement, type Handlers, type RawRequest, type RawResponse } from "./server.js";

// --- fixtures -------------------------------------------------------------------------------------

const health = {
  ok: true,
  connection: "connected",
  needs_pairing: false,
  last_event_age_sec: 3,
  last_connected_at: 1_700_000_000,
  last_message_at: 1_700_000_100,
  self_id: "33600000000@s.whatsapp.net",
  counts: { chats: 2, messages: 9, contacts: 4 },
  schema_version: 3,
  transcription_available: true,
  auto_transcribe: null,
  read_only: false,
} as const;

const capabilities = {
  apiVersion: "1.0.0",
  contractVersion: 1,
  readOnly: false,
  maxUploadBytes: 90_000_000,
  features: { transcription: true, autoTranscribe: false, mediaLinks: true },
} as const;

const message = {
  id: "M1",
  chat: "33600000000@s.whatsapp.net",
  ts: 1_700_000_000,
  fromMe: false,
  sender: { id: "33600000000@s.whatsapp.net", name: "Marie" },
  kind: "text",
  text: "hi",
  transcript: null,
  quotedId: null,
  status: null,
  edited: false,
  deleted: false,
  media: null,
  reactionCount: 0,
} as const;

const source = { bytes: 1024, mimetype: "image/jpeg" } as const;
const sent = { chat: "33600000000@s.whatsapp.net", messageId: "M1" } as const;
const bytes: BinaryPayload = { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg" };

/**
 * What every handler was called with, so a test can assert on the *parsed* input rather than only on
 * what came back out.
 */
let lastInput: { params: unknown; query: unknown; body: unknown } | undefined;

function record<T>(result: T): (input: { params: unknown; query: unknown; body: unknown }) => Promise<T> {
  return (input) => {
    lastInput = input;
    return Promise.resolve(result);
  };
}

/**
 * A complete handler map.
 *
 * Written out in full rather than generated, because writing it out is the test: `Handlers` is an
 * exhaustive mapped type over `Routes`, so this object compiling at all is the guarantee that every
 * operation in the table has an implementation of the right shape. `Promise.resolve` rather than
 * `async` throughout, for no reason beyond `require-await`.
 */
const handlers: Handlers = {
  getHealth: record(health),
  fetchSignedMedia: record(bytes),
  capabilities: record(capabilities),
  listChats: record({ nextCursor: null, items: [] }),
  listGroups: record({ nextCursor: null, items: [] }),
  listContacts: record({ nextCursor: null, items: [] }),
  listMessages: record({ nextCursor: null, items: [] }),
  searchMessages: record({ nextCursor: null, items: [] }),
  getMessage: record({ ...message, reactions: [] }),
  fetchMedia: record(bytes),
  fetchMediaJpeg: record({ data: "AAAA", mimeType: "image/jpeg", width: 4, height: 3, source }),
  fetchMediaLink: record({
    url: "https://api.example/media/dl/v1.abc",
    expiresAt: 1_700_000_900,
    mimeType: "image/jpeg",
    bytes: 1024,
    filename: "photo.jpg",
  }),
  fetchMediaKeyframes: record({ durationSec: 6, width: 4, height: 3, frames: [], source }),
  fetchMediaText: record({ text: "hello", truncated: false }),
  fetchMediaTranscript: record(null),
  fetchMediaMeta: record({
    mimetype: "image/jpeg",
    bytes: 1024,
    width: 4,
    height: 3,
    durationSec: null,
    hasTranscript: false,
    sha256: "a".repeat(64),
  }),
  sendText: record(sent),
  sendFile: record(sent),
  editMessage: record(sent),
  deleteMessage: record(sent),
  react: record(sent),
  transcribe: record({ text: "bonjour", model: "whisper-1", language: "fr" }),
  markRead: record(sent),
  resolveRecipient: record({ candidates: [] }),
};

/** A minimal `RawResponse` that records what a binding wrote. */
function capture(): {
  res: RawResponse;
  written: { status?: number; headers: Record<string, string>; body?: unknown };
} {
  const written: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
  const res: RawResponse = {
    status: (code) => {
      written.status = code;
      return res;
    },
    header: (name, value) => {
      written.headers[name] = value;
      return res;
    },
    json: (body) => {
      written.body = body;
    },
    send: (body) => {
      written.body = body;
    },
  };
  return { res, written };
}

function request(over: Partial<RawRequest> = {}): RawRequest {
  return { params: {}, query: {}, body: undefined, ...over };
}

const bindings = implement(handlers);

function binding(path: string, method = "GET") {
  const found = bindings.find((b) => b.path === path && b.method === method);
  assert.ok(found, `no binding for ${method} ${path}`);
  return found;
}

// --- what implement() hands back --------------------------------------------------------------------

void test("implement returns one binding per route, carrying the method, path and gate verbatim", () => {
  assert.equal(bindings.length, Object.keys(routes).length);
  assert.deepEqual(
    bindings.map((b) => `${b.method} ${b.path} ${b.auth}`).toSorted(),
    Object.values(routes)
      .map((r) => `${r.method} ${r.path} ${r.auth}`)
      .toSorted(),
  );
});

void test("auth reaches the binding, because the mount order is partitioned on it and not hand-written", () => {
  const ungated = bindings.filter((b) => b.auth !== "bearer").map((b) => b.path);
  assert.deepEqual(ungated.toSorted(), ["/health", "/media/dl/:token"]);
});

// --- parsing --------------------------------------------------------------------------------------

void test("a query arrives coerced, because Express hands over strings and the handler wants values", async () => {
  const { res } = capture();
  // Exactly what `req.query` looks like for `?limit=25&archived=false&unread=true`.
  await binding("/v1/chats").handle(request({ query: { limit: "25", archived: "false", unread: "true" } }), res);
  assert.deepEqual(lastInput?.query, { limit: 25, archived: false, unread: true });
});

void test("archived=false is false, which z.coerce.boolean would have read as true", async () => {
  const { res } = capture();
  await binding("/v1/chats").handle(request({ query: { archived: "false" } }), res);
  assert.deepEqual(lastInput?.query, { archived: false });
});

void test("a route that declares nothing hands the handler undefined, not an empty object", async () => {
  const { res } = capture();
  await binding("/health").handle(request({ query: { stray: "1" } }), res);
  assert.deepEqual(lastInput, { params: undefined, query: undefined, body: undefined });
});

void test("params and body are parsed with the route's own schemas", async () => {
  const { res } = capture();
  await binding("/v1/messages/:chat/:id/reaction", "POST").handle(
    request({ params: { chat: "c@s.whatsapp.net", id: "M1" }, body: { emoji: "" } }),
    res,
  );
  assert.deepEqual(lastInput, {
    params: { chat: "c@s.whatsapp.net", id: "M1" },
    // The empty string survives: it is how WhatsApp models removing a reaction.
    query: undefined,
    body: { emoji: "" },
  });
});

void test("an invalid query is bad_request/400 named Error, not an unrecognised throw the API reports as 500", async () => {
  const { res } = capture();
  await assert.rejects(
    () => binding("/v1/chats").handle(request({ query: { limit: "500" } }), res),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "bad_request");
      assert.equal(err.status, 400);
      // The name every bare validation throw in this codebase renders as today.
      assert.equal(err.name, "Error");
      assert.match(err.message, /^invalid query: limit: /);
      return true;
    },
  );
});

void test("a refusal names the failing field and never the value it carried", async () => {
  const { res } = capture();
  await assert.rejects(
    () => binding("/v1/messages", "POST").handle(request({ body: { recipient: "", text: "s3cret-draft" } }), res),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.match(err.message, /recipient/);
      assert.doesNotMatch(err.message, /s3cret-draft/);
      return true;
    },
  );
});

// --- writing --------------------------------------------------------------------------------------

void test("a JSON route answers 200 with the handler's object", async () => {
  const { res, written } = capture();
  await binding("/v1/capabilities").handle(request(), res);
  assert.equal(written.status, 200);
  assert.deepEqual(written.body, capabilities);
});

void test("a binary route answers bytes under the payload's own content type", async () => {
  const { res, written } = capture();
  await binding("/v1/media/:chat/:id").handle(request({ params: { chat: "c", id: "M1" } }), res);
  assert.equal(written.status, 200);
  assert.equal(written.headers["content-type"], "image/jpeg");
  assert.deepEqual(written.body, bytes.bytes);
});

void test("a filename with no disposition is served attachment, never inline", async () => {
  const named: Handlers = { ...handlers, fetchMedia: record({ ...bytes, filename: 'in"voice.pdf' }) };
  const { res, written } = capture();
  const one = implement(named).find((b) => b.path === "/v1/media/:chat/:id");
  assert.ok(one);
  await one.handle(request({ params: { chat: "c", id: "M1" } }), res);
  // The quote is stripped from the quoted parameter — it would otherwise end the string early —
  // and the real name rides along in the extended one, which is not re-parsed for parameters.
  assert.equal(
    written.headers["content-disposition"],
    `attachment; filename="invoice.pdf"; filename*=UTF-8''in%22voice.pdf`,
  );
});

void test("a route with no filename and no disposition sets no content-disposition at all", async () => {
  const { res, written } = capture();
  await binding("/v1/media/:chat/:id").handle(request({ params: { chat: "c", id: "M1" } }), res);
  assert.equal(written.headers["content-disposition"], undefined);
});

// --- the exhaustiveness that makes the whole design worth having --------------------------------------
//
// Compile-time, and enforced by `pnpm --filter whatsapp-api-sdk typecheck` rather than by the test
// runner, which strips types without checking them. An unnecessary `@ts-expect-error` is itself an
// error, so each of these fails the build if the type it guards ever stops rejecting.

void test("a handler map missing one operation is not a Handlers", () => {
  const { getHealth: _dropped, ...missingOne } = handlers;
  // @ts-expect-error Handlers is exhaustive over Routes: a map without getHealth is not one
  const incomplete: Handlers = missingOne;
  assert.ok(incomplete);
});

void test("a handler answering the wrong shape is not a Handlers either", () => {
  // @ts-expect-error listChats answers a page of chats, not a message
  const wrongShape: Handlers = { ...handlers, listChats: record(message) };
  // @ts-expect-error a binary route's handler answers bytes, not JSON
  const wrongKind: Handlers = { ...handlers, fetchMedia: record({ nextCursor: null, items: [] }) };
  assert.ok(wrongShape);
  assert.ok(wrongKind);
});

void test("a handler reads the parsed parts its route declares, and undefined for the rest", async () => {
  let seen: { limit: number | undefined; params: undefined } | undefined;
  const typed: Handlers = {
    ...handlers,
    listChats: (input) => {
      // `params` and `body` are `undefined` here — the route declares neither — while `query` is the
      // parsed `ChatQuery`. Reading a field the route does not declare is a compile error, which is
      // what makes a filter rename fail the build instead of the request.
      seen = { limit: input.query.limit, params: input.params };
      return Promise.resolve({ nextCursor: null, items: [] });
    },
  };
  const one = implement(typed).find((b) => b.path === "/v1/chats");
  assert.ok(one);
  const { res } = capture();
  await one.handle(request({ query: { limit: "7" } }), res);
  assert.deepEqual(seen, { limit: 7, params: undefined });
});

// --- the status a create answers with -----------------------------------------------------------------

void test("the two creates answer 201 and every other write answers 200", async () => {
  const statusOf = async (path: string, method: string, body?: unknown): Promise<number | undefined> => {
    const { res, written } = capture();
    await binding(path, method).handle(request({ params: { chat: "c@s.whatsapp.net", id: "M1" }, body }), res);
    return written.status;
  };
  // The table is the single source of truth for this, not a status hand-written next to a mount.
  assert.equal(await statusOf("/v1/messages", "POST", { recipient: "Marie", text: "hi" }), 201);
  assert.equal(await statusOf("/v1/messages/file", "POST", { recipient: "Marie", path: "/tmp/a.pdf" }), 201);
  assert.equal(await statusOf("/v1/messages/:chat/:id", "PATCH", { text: "fixed" }), 200);
  assert.equal(await statusOf("/v1/messages/:chat/:id", "DELETE"), 200);
  assert.equal(await statusOf("/v1/messages/:chat/:id/transcribe", "POST"), 200);
  assert.equal(await statusOf("/v1/chats", "GET"), 200);
});

void test("every route in the table declares a status implement() can actually write", () => {
  // `successStatus` is narrower than the plan's `number` on purpose: `implement()` always writes a
  // body, and a 204 would be a no-content status carrying content. So the three writable statuses
  // are named rather than a 2xx range asserted — a range admits the 204 this exists to exclude, and
  // a guard that stays green under the mutation it guards against reports nothing.
  const table: Record<string, Route> = routes;
  for (const [key, route] of Object.entries(table)) {
    const status = route.successStatus ?? 200;
    assert.ok([200, 201, 202].includes(status), `${key} answers ${status}`);
  }
});

// --- what the header carries, and what the client reads back out of it ----------------------------------

/** The `content-disposition` a binary route writes for a given filename. */
async function dispositionFor(filename: string): Promise<string | undefined> {
  const named: Handlers = { ...handlers, fetchMedia: record({ ...bytes, filename }) };
  const one = implement(named).find((b) => b.path === "/v1/media/:chat/:id");
  assert.ok(one);
  const { res, written } = capture();
  await one.handle(request({ params: { chat: "c", id: "M1" } }), res);
  return written.headers["content-disposition"];
}

void test("a backslash is stripped, because inside a quoted string it escapes the next character", async () => {
  // `\` is printable ASCII, so the non-ASCII sweep left it. A trailing one escaped the closing
  // quote outright and a strict parser read `back\slash.pdf` as `backslash.pdf` — and the filename
  // is chosen by the WhatsApp sender. It is not carried in the extended parameter either: a `\` is
  // a path separator, so the name it would preserve is one no consumer should be handed.
  assert.equal(await dispositionFor("back\\slash.pdf"), 'attachment; filename="backslash.pdf"');
  assert.equal(await dispositionFor("evil\\"), 'attachment; filename="evil"');
});

void test("a name the quoted parameter cannot carry is carried by the extended one instead", async () => {
  // Stripping is lossy and `;` now has to go — it separates one parameter from the next, so leaving
  // it inside the quoted value is what let a sender-chosen name smuggle a `filename*=` of its own.
  // Dropping the character silently would just lose the name a different way, so the real one goes
  // into the parameter that is percent-encoded and therefore cannot be re-read as parameters.
  assert.equal(await dispositionFor("a;b.pdf"), `attachment; filename="ab.pdf"; filename*=UTF-8''a%3Bb.pdf`);
  assert.equal(await dispositionFor("été.pdf"), `attachment; filename="_t_.pdf"; filename*=UTF-8''%C3%A9t%C3%A9.pdf`);
  // A name that is not a name is preserved nowhere, and one that is nothing at all names nothing.
  assert.equal(await dispositionFor("../../etc/passwd"), 'attachment; filename="....etcpasswd"');
  assert.equal(await dispositionFor(".."), "attachment");
});

/** The filename `createClient()` reads back out of the header `implement()` wrote for `filename`. */
async function roundTrip(filename: string): Promise<string | undefined> {
  const header = await dispositionFor(filename);
  assert.ok(header);
  const client = createClient({
    baseUrl: "http://x",
    fetch: () =>
      Promise.resolve(
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-disposition": header },
        }),
      ),
  });
  return (await client.fetchMedia({ params: { chat: "c", id: "M1" }, query: {} })).filename;
}

void test("what implement() writes into the header is what createClient() reads back out", async () => {
  // The two halves of the contract disagreeing is what made a `%` in a filename throw `URIError`
  // after a 200. Only a round trip catches that again: the client's own suite pins the parse, this
  // pins that the parse is of what this package actually emits.
  for (const name of ["photo.jpg", "50% off invoice.pdf", "100%.png", "a;b.pdf", "rapport (final).pdf", "été.pdf"]) {
    assert.equal(await roundTrip(name), name, name);
  }
});

void test("a filename that smuggles a second parameter round-trips as data, not as a parameter", async () => {
  // The sender picks this string. `headerSafe` did not strip `;`, the client's `filename*=` search
  // was not scoped to a parameter boundary and its result won unconditionally, so the header below
  // was written with the payload inside the quoted value and read back out percent-decoded:
  // `../../etc/passwd`, an embedded quote, a CR/LF and a NUL, all of them characters the write side
  // removes precisely because they are not the sender's to choose. Both sides are fixed, so both
  // are asserted: nothing inside the quoted value can be read as a parameter, and the name that
  // comes back is the one that went in.
  for (const payload of ["%2E%2E%2F%2E%2E%2Fetc%2Fpasswd", "%22evil%22.exe", "line%0Ainjected", "nul%00.pdf"]) {
    const name = `a; filename*=UTF-8''${payload}`;
    const header = await dispositionFor(name);
    assert.ok(header);
    assert.match(header, /^attachment; filename="[^";]*"; filename\*=UTF-8''[^";]+$/);
    assert.equal(await roundTrip(name), name, header);
  }
});

// --- the refusal that must not echo what it refused -------------------------------------------------------

void test("an enum refusal names the options the schema allows, never the value it received", async () => {
  const { res } = capture();
  await assert.rejects(
    () =>
      binding("/v1/media/:chat/:id").handle(
        request({ params: { chat: "c", id: "M1" }, query: { disposition: "sideways-s3cret-value" } }),
        res,
      ),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      // Zod's own `invalid_enum_value` message ends "…, received 'sideways-s3cret-value'". Every
      // other issue kind describes a shape; this one quotes the input, and a query can carry a
      // search term.
      assert.doesNotMatch(err.message, /sideways-s3cret-value/);
      assert.match(err.message, /disposition: expected one of inline \| attachment/);
      return true;
    },
  );
});

// --- the response check that is off by default --------------------------------------------------------------

void test("a millisecond timestamp is written straight out by default, and refused when asked for", async () => {
  const drifted: Handlers = {
    ...handlers,
    // A `number`, so `tsc` is happy; `epochSeconds`'s lt(1e11) is the only thing that says otherwise.
    listChats: record({
      nextCursor: null,
      items: [
        {
          id: "c",
          name: null,
          isGroup: false,
          lastMessageTs: 1_700_000_000_000,
          unreadCount: 0,
          archived: false,
          mutedUntil: null,
          participantCount: null,
        },
      ],
    }),
  };

  const lenient = implement(drifted).find((b) => b.path === "/v1/chats");
  assert.ok(lenient);
  const { res: out, written } = capture();
  await lenient.handle(request({ query: {} }), out);
  // The default: the API answers 200 and the client one process away raises the ZodError.
  assert.equal(written.status, 200);

  const checked = implement(drifted, { validateResponses: true }).find((b) => b.path === "/v1/chats");
  assert.ok(checked);
  const { res: strict } = capture();
  await assert.rejects(
    () => checked.handle(request({ query: {} }), strict),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      // A plain Error, so the middleware reports internal/500: the handler is at fault, not the caller.
      assert.ok(!(err instanceof ApiError));
      assert.match(err.message, /the handler for listChats/);
      assert.match(err.message, /items\.0\.lastMessageTs/);
      return true;
    },
  );
});

void test("the checked path writes the handler's own result, not the parsed one", async () => {
  const { res, written } = capture();
  const one = implement(handlers, { validateResponses: true }).find((b) => b.path === "/v1/capabilities");
  assert.ok(one);
  await one.handle(request(), res);
  // Same object identity: a schema that strips unknown keys cannot make the response differ
  // between the two settings.
  assert.equal(written.body, capabilities);
  assert.equal(written.status, 200);
});
