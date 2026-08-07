import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { createClient } from "./client.js";
import {
  AmbiguousRecipientError,
  ApiError,
  ApiUnreachableError,
  BadRequestError,
  MessageNotFoundError,
  NotConnectedError,
} from "./errors.js";
import { routes } from "./routes.js";

// --- a fetch that records what it was asked for -----------------------------------------------------

type Call = { url: string; method: string; headers: Headers; body: string | undefined };

function recorder(respond: (call: Call) => Response): { calls: Call[]; fetch: typeof globalThis.fetch } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const call: Call = {
        url: input instanceof Request ? input.url : input.toString(),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      return Promise.resolve(respond(call));
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const emptyPage = { nextCursor: null, items: [] };

// --- the brief's two ---------------------------------------------------------------------------------

void test("the client parses a page and returns typed rows", async () => {
  const client = createClient({ baseUrl: "http://x", token: "t", fetch: () => Promise.resolve(json(emptyPage)) });
  const page = await client.listChats({ query: { limit: 5 } });
  assert.deepEqual(page, { nextCursor: null, items: [] });
});

void test("a transport failure is ApiUnreachableError, not NotConnectedError", async () => {
  const client = createClient({ baseUrl: "http://x", fetch: () => Promise.reject(new TypeError("fetch failed")) });
  await assert.rejects(
    () => client.listChats({ query: {} }),
    (e: unknown) => e instanceof ApiUnreachableError,
  );
});

// --- parsing on the way in ----------------------------------------------------------------------------

void test("a page comes back as rows the caller can read, not as unvalidated JSON", async () => {
  const chat = {
    id: "33600000000@s.whatsapp.net",
    name: "Marie",
    isGroup: false,
    lastMessageTs: 1_700_000_000,
    unreadCount: 2,
    archived: false,
    mutedUntil: null,
    participantCount: null,
  };
  const client = createClient({
    baseUrl: "http://x",
    fetch: () => Promise.resolve(json({ nextCursor: "b2Zmc2V0OjUw", items: [chat] })),
  });
  const page = await client.listChats({ query: { limit: 1 } });
  assert.equal(page.nextCursor, "b2Zmc2V0OjUw");
  assert.equal(page.items[0]?.name, "Marie");
});

void test("a field the API stops sending is a parse error at the boundary, not an undefined three layers away", async () => {
  const client = createClient({
    baseUrl: "http://x",
    // `unreadCount` gone: exactly what a half-deployed API looks like.
    fetch: () =>
      Promise.resolve(
        json({
          nextCursor: null,
          items: [
            {
              id: "c",
              name: null,
              isGroup: false,
              lastMessageTs: null,
              archived: false,
              mutedUntil: null,
              participantCount: null,
            },
          ],
        }),
      ),
  });
  await assert.rejects(() => client.listChats({ query: {} }), /unreadCount/);
});

void test("a binary route answers bytes, its mime type, and the two fields the disposition carries", async () => {
  const client = createClient({
    baseUrl: "http://x",
    fetch: () =>
      Promise.resolve(
        new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-disposition": 'inline; filename="photo.jpg"' },
        }),
      ),
  });
  const file = await client.fetchMedia({ params: { chat: "c@s.whatsapp.net", id: "M1" }, query: {} });
  assert.deepEqual([...file.bytes], [0xff, 0xd8, 0xff]);
  assert.equal(file.mimeType, "image/jpeg");
  assert.equal(file.filename, "photo.jpg");
  assert.equal(file.disposition, "inline");
});

void test("a binary response with no disposition omits the fields rather than inventing them", async () => {
  const client = createClient({
    baseUrl: "http://x",
    fetch: () => Promise.resolve(new Response(new Uint8Array([1]), { status: 200 })),
  });
  const file = await client.fetchSignedMedia({ params: { token: "v1.abc" } });
  assert.equal(file.filename, undefined);
  assert.equal(file.disposition, undefined);
  // No `content-type` at all is a real answer from a bare proxy; guessing an image type would be worse.
  assert.equal(file.mimeType, "application/octet-stream");
});

// --- errors on the way in -----------------------------------------------------------------------------

void test("a non-2xx becomes the typed error its code names, with the wire's own name and details", async () => {
  const client = createClient({
    baseUrl: "http://x",
    fetch: () =>
      Promise.resolve(
        json(
          {
            error: {
              code: "ambiguous_recipient",
              name: "AmbiguousRecipientError",
              message: "several chats match Marie",
              details: { candidates: [{ index: 1, id: "a", label: "Marie D", exact: false }] },
            },
          },
          409,
        ),
      ),
  });
  await assert.rejects(
    () => client.sendText({ body: { recipient: "Marie", text: "hi" } }),
    (err: unknown) => {
      assert.ok(err instanceof AmbiguousRecipientError);
      assert.equal(err.status, 409);
      assert.equal(err.name, "AmbiguousRecipientError");
      assert.deepEqual(err.details?.["candidates"], [{ index: 1, id: "a", label: "Marie D", exact: false }]);
      return true;
    },
  );
});

void test("a 404 message_not_found narrows to its own class, not to the sibling that shares its status", async () => {
  const client = createClient({
    baseUrl: "http://x",
    fetch: () =>
      Promise.resolve(json({ error: { code: "message_not_found", name: "MessageNotFoundError", message: "no" } }, 404)),
  });
  await assert.rejects(
    () => client.getMessage({ params: { chat: "c", id: "M1" } }),
    (err: unknown) => err instanceof MessageNotFoundError,
  );
});

void test("an HTML error page from a proxy is still an ApiError, not a SyntaxError about a stray angle bracket", async () => {
  const client = createClient({
    baseUrl: "http://x",
    fetch: () => Promise.resolve(new Response("<html>502 Bad Gateway</html>", { status: 502 })),
  });
  await assert.rejects(
    () => client.capabilities(),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 502);
      assert.equal(err.code, "internal");
      return true;
    },
  );
});

void test("an unreachable API is never reported as a downed WhatsApp socket", async () => {
  const client = createClient({
    baseUrl: "http://x",
    fetch: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:8080")),
  });
  await assert.rejects(
    () => client.getHealth(),
    (err: unknown) => {
      assert.ok(err instanceof ApiUnreachableError);
      assert.ok(!(err instanceof NotConnectedError));
      assert.equal(err.code, "api_unreachable");
      // No HTTP exchange happened, so there is no status to report.
      assert.equal(err.status, 0);
      return true;
    },
  );
});

void test("the unreachable message names the API without naming a credential in its URL", async () => {
  const client = createClient({
    baseUrl: "http://someone:hunter2@api.internal:8080/",
    fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND api.internal")),
  });
  await assert.rejects(
    () => client.getHealth(),
    (err: unknown) => {
      assert.ok(err instanceof ApiUnreachableError);
      assert.doesNotMatch(err.message, /hunter2/);
      assert.doesNotMatch(err.message, /someone/);
      assert.match(err.message, /api\.internal:8080/);
      return true;
    },
  );
});

void test("a timeout is a transport failure, because AbortSignal.timeout rejects the fetch", async () => {
  const client = createClient({
    baseUrl: "http://x",
    timeoutMs: 5,
    // A fetch slower than the deadline. `AbortSignal.timeout` fires, `throwIfAborted` raises the
    // real `AbortError`, and the client has to read that as "no answer" rather than as an API reply.
    fetch: async (_input, init) => {
      await delay(50);
      init?.signal?.throwIfAborted();
      return json(emptyPage);
    },
  });
  await assert.rejects(
    () => client.getHealth(),
    (err: unknown) => err instanceof ApiUnreachableError,
  );
});

// --- what goes out ------------------------------------------------------------------------------------

void test("validation happens before the request, so a refused body never reaches the network", async () => {
  const rec = recorder(() => json(emptyPage));
  const client = createClient({ baseUrl: "http://x", fetch: rec.fetch });
  await assert.rejects(() => client.sendText({ body: { recipient: "c", text: "" } }));
  assert.equal(rec.calls.length, 0);
});

void test("path params are substituted and percent-encoded, and the query is appended", async () => {
  const rec = recorder(() => json({ text: "x", truncated: false }));
  const client = createClient({ baseUrl: "http://x/", fetch: rec.fetch });
  await client.fetchMediaText({ params: { chat: "33600000000@s.whatsapp.net", id: "3EB0/1" } });
  // The `@` and the `/` both survive as data rather than as path structure — an id carrying a slash
  // would otherwise address a different route entirely.
  assert.equal(rec.calls[0]?.url, "http://x/v1/media/33600000000%40s.whatsapp.net/3EB0%2F1/text");
});

void test("an omitted filter is omitted from the query string, not sent empty", async () => {
  const rec = recorder(() => json(emptyPage));
  const client = createClient({ baseUrl: "http://x", fetch: rec.fetch });
  await client.listChats({ query: { limit: 25, archived: false } });
  // `?archived=` would be a different request, and one the schema refuses.
  assert.equal(rec.calls[0]?.url, "http://x/v1/chats?limit=25&archived=false");
});

void test("every request carries an x-request-id, so two log streams can be joined after the fact", async () => {
  const rec = recorder(() => json(emptyPage));
  const client = createClient({ baseUrl: "http://x", fetch: rec.fetch });
  await client.listChats({ query: {} });
  await client.listChats({ query: {} });
  const ids = rec.calls.map((c) => c.headers.get("x-request-id"));
  assert.equal(ids.length, 2);
  for (const id of ids) assert.match(id ?? "", /^[0-9a-f-]{36}$/);
  assert.notEqual(ids[0], ids[1]);
});

void test("the bearer token rides on the request when there is one, and nothing does when there is not", async () => {
  const withToken = recorder(() => json(emptyPage));
  await createClient({ baseUrl: "http://x", token: "secret", fetch: withToken.fetch }).listChats({ query: {} });
  assert.equal(withToken.calls[0]?.headers.get("authorization"), "Bearer secret");

  const without = recorder(() => json(emptyPage));
  await createClient({ baseUrl: "http://x", fetch: without.fetch }).listChats({ query: {} });
  assert.equal(without.calls[0]?.headers.get("authorization"), null);
});

void test("a write sends its validated body as JSON, under the method the table names", async () => {
  const rec = recorder(() => json({ chat: "c@s.whatsapp.net", messageId: "M1" }));
  const client = createClient({ baseUrl: "http://x", fetch: rec.fetch });
  const result = await client.editMessage({ params: { chat: "c@s.whatsapp.net", id: "M1" }, body: { text: "fixed" } });
  const call = rec.calls[0];
  assert.ok(call);
  assert.equal(call.method, "PATCH");
  assert.equal(call.headers.get("content-type"), "application/json");
  assert.equal(call.body, '{"text":"fixed"}');
  assert.deepEqual(result, { chat: "c@s.whatsapp.net", messageId: "M1" });
});

void test("a GET sends no body and no content-type", async () => {
  const rec = recorder(() => json(emptyPage));
  await createClient({ baseUrl: "http://x", fetch: rec.fetch }).listChats({ query: {} });
  const call = rec.calls[0];
  assert.ok(call);
  assert.equal(call.body, undefined);
  assert.equal(call.headers.get("content-type"), null);
});

// --- the filename the server actually wrote -------------------------------------------------------------
//
// `implement()` writes the name verbatim into `filename="…"` — its doc says so — so the client must
// read it verbatim. Only the extended `filename*=` parameter is percent-encoded. `server.test.ts`
// pins the other half of this: the same names, round-tripped through a real binding.

/** What the client reads back out of a `content-disposition` header. */
async function readBack(header: string): Promise<string | undefined> {
  const client = createClient({
    baseUrl: "http://x",
    fetch: () =>
      Promise.resolve(
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "application/pdf", "content-disposition": header },
        }),
      ),
  });
  return (await client.fetchMedia({ params: { chat: "c", id: "M1" }, query: {} })).filename;
}

void test("a plain filename is read verbatim, percent signs and semicolons included", async () => {
  // `50% off invoice.pdf` threw `URIError: URI malformed` after a 200 with the bytes already in
  // hand, and `a;b.pdf` came back as `a`. Filenames come from the WhatsApp sender, so both were
  // externally reachable — one loudly, as an error nothing downstream can classify, one silently.
  assert.equal(await readBack('attachment; filename="photo.jpg"'), "photo.jpg");
  assert.equal(await readBack('attachment; filename="50% off invoice.pdf"'), "50% off invoice.pdf");
  assert.equal(await readBack('attachment; filename="100%.png"'), "100%.png");
  assert.equal(await readBack('attachment; filename="a;b.pdf"'), "a;b.pdf");
  assert.equal(await readBack('inline; filename="rapport (final).pdf"'), "rapport (final).pdf");
});

void test("an unquoted filename is read to the end of the parameter and trimmed", async () => {
  assert.equal(await readBack("attachment; filename=photo.jpg"), "photo.jpg");
  assert.equal(await readBack("attachment; filename= photo.jpg ; size=12"), "photo.jpg");
  assert.equal(await readBack('attachment; filename=""'), undefined);
});

void test("the RFC 5987 parameter is the one that is percent-decoded, and it wins", async () => {
  assert.equal(await readBack(`attachment; filename="fallback.pdf"; filename*=UTF-8''50%25%20off.pdf`), "50% off.pdf");
  assert.equal(await readBack(`attachment; filename*=UTF-8'en'%C3%A9t%C3%A9.pdf`), "été.pdf");
});

void test("a malformed filename* falls back rather than throwing on a download that succeeded", async () => {
  // A stray `%` in the extended parameter — a third-party proxy rewriting the header — throws the
  // same `URIError` the plain parameter used to. Losing the name beats losing the bytes.
  assert.equal(await readBack(`attachment; filename="ok.pdf"; filename*=UTF-8''bad%zz.pdf`), "ok.pdf");
  assert.equal(await readBack(`attachment; filename*=UTF-8''bad%zz.pdf`), undefined);
});

// --- a deadline that fires after the headers ------------------------------------------------------------
//
// `AbortSignal.timeout` aborts the body stream as well as the connect, so these need a real socket:
// a stub that rejects before returning a `Response` cannot tell the two phases apart, which is
// exactly how the first version of this suite missed the bug.

/** A server that answers with headers and then never finishes — or never sends — the body. */
function stalling(write: (res: ServerResponse) => void): Promise<{ url: string; close: () => void }> {
  const server = createServer((_req, res) => {
    write(res);
  });
  // The executor form because `lib` is ES2023 and `Promise.withResolvers` landed in ES2024.
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address !== null && typeof address === "object");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

/**
 * A `fetch` that hands the client its `Response` only once the deadline has already fired.
 *
 * The headers are in by the time `fetch` resolves, and the `abort` event is awaited rather than
 * slept through, so the ordering this test depends on — headers first, then the abort — is a fact
 * rather than a guess about how fast a loopback socket is. Reading the body then rejects with the
 * abort reason, which is the failure the client has to convert.
 */
const afterTheDeadline: typeof globalThis.fetch = async (input, init) => {
  const res = await fetch(input, init);
  const signal = init?.signal;
  assert.ok(signal);
  if (!signal.aborted) await once(signal, "abort");
  return res;
};

void test("a timeout during the body stream is an unreachable API, not a raw TimeoutError", async () => {
  const server = await stalling((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    // A body that starts and never finishes: exactly what a hung API looks like mid-answer.
    res.write('{"nextCursor":');
  });
  try {
    const client = createClient({ baseUrl: server.url, timeoutMs: 20, fetch: afterTheDeadline });
    await assert.rejects(
      () => client.listChats({ query: {} }),
      (err: unknown) => {
        assert.ok(err instanceof ApiUnreachableError, `got ${(err as Error).name}`);
        assert.equal(err.code, "api_unreachable");
        return true;
      },
    );
  } finally {
    server.close();
  }
});

void test("a timeout during a binary download is an unreachable API too", async () => {
  const server = await stalling((res) => {
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": "1024" });
    res.write(Buffer.from([0xff, 0xd8, 0xff]));
  });
  try {
    const client = createClient({ baseUrl: server.url, timeoutMs: 20, fetch: afterTheDeadline });
    await assert.rejects(
      () => client.fetchMedia({ params: { chat: "c", id: "M1" }, query: {} }),
      (err: unknown) => err instanceof ApiUnreachableError,
    );
  } finally {
    server.close();
  }
});

void test("a body truncated after the headers is an unreachable API, on the error path as well", async () => {
  let cut: (() => void) | undefined;
  const server = await stalling((res) => {
    res.writeHead(500, { "content-type": "application/json", "content-length": "1024" });
    res.write('{"error":');
    cut = () => res.socket?.destroy();
  });
  try {
    const client = createClient({
      baseUrl: server.url,
      // The socket dies once the client holds the `Response` and not before: cutting it in the same
      // tick would reject the `fetch` itself, which is the case the old catch already covered.
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        cut?.();
        return res;
      },
    });
    await assert.rejects(
      () => client.listChats({ query: {} }),
      (err: unknown) => {
        // Not the 500 it started as: nothing legible arrived, and claiming the API reported an
        // error with no message would describe a reply that never finished.
        assert.ok(err instanceof ApiUnreachableError, `got ${(err as Error).name}: ${(err as Error).message}`);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

void test("a response the schema refuses is still a ZodError, because the peer broke the contract", async () => {
  const client = createClient({
    baseUrl: "http://x",
    fetch: () => Promise.resolve(json({ nextCursor: null })),
  });
  await assert.rejects(
    () => client.listChats({ query: {} }),
    (err: unknown) => {
      // The one throw the body guard must not swallow: conflating it with an unreachable API would
      // report a contract violation as a downed backend and hide a real bug.
      assert.ok(!(err instanceof ApiError));
      assert.equal((err as Error).name, "ZodError");
      return true;
    },
  );
});

void test("a 200 carrying HTML is an ApiError, not a SyntaxError about a stray angle bracket", async () => {
  const client = createClient({
    baseUrl: "http://x",
    fetch: () =>
      Promise.resolve(
        new Response("<html>captive portal</html>", { status: 200, headers: { "content-type": "text/html" } }),
      ),
  });
  await assert.rejects(
    () => client.listChats({ query: {} }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "internal");
      assert.equal(err.status, 200);
      // The body itself is chat content on every other route, so it is never quoted back.
      assert.doesNotMatch(err.message, /captive portal/);
      return true;
    },
  );
});

// --- the correlation id -----------------------------------------------------------------------------------

void test("a caller's own request id is what goes out, and what comes back on the error", async () => {
  const rec = recorder(() => json({ error: { code: "internal", name: "Error", message: "boom" } }, 500));
  const client = createClient({ baseUrl: "http://x", fetch: rec.fetch, requestIdFactory: () => "corr-1" });
  await assert.rejects(
    () => client.listChats({ query: {} }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      // The whole point: the id the API logged is on the error the MCP will log.
      assert.equal(err.requestId, "corr-1");
      return true;
    },
  );
  assert.equal(rec.calls[0]?.headers.get("x-request-id"), "corr-1");
});

void test("an unreachable API carries its request id too, though no body ever came back", async () => {
  const client = createClient({
    baseUrl: "http://x",
    fetch: () => Promise.reject(new Error("connect ECONNREFUSED")),
    requestIdFactory: () => "corr-2",
  });
  await assert.rejects(
    () => client.getHealth(),
    (err: unknown) => {
      assert.ok(err instanceof ApiUnreachableError);
      assert.equal(err.requestId, "corr-2");
      return true;
    },
  );
});

// --- per-route deadlines ------------------------------------------------------------------------------------

void test("transcribe gets its own deadline, and the shared one still applies to everything else", async () => {
  const slow: typeof globalThis.fetch = async (_input, init) => {
    await delay(40);
    init?.signal?.throwIfAborted();
    return json({ text: "bonjour", model: "whisper-1", language: "fr" });
  };
  const client = createClient({
    baseUrl: "http://x",
    fetch: slow,
    timeoutMs: 5,
    // The API's own transcribeTimeoutMs is three times the ceiling on requestTimeoutMs, so one
    // number for all 24 routes either abandons a running transcription or hangs every listing.
    timeoutMsByRoute: { transcribe: 60_000 },
  });
  const transcript = await client.transcribe({ params: { chat: "c", id: "M1" } });
  assert.equal(transcript.text, "bonjour");
  await assert.rejects(
    () => client.listChats({ query: {} }),
    (err: unknown) => err instanceof ApiUnreachableError,
  );
});

// --- a caller bug stays a caller bug --------------------------------------------------------------------------

void test("a query value a URL cannot carry is refused as a caller bug, never as an unreachable API", async () => {
  // No query schema in the table declares a non-primitive today, so this is the reviewer's probe
  // made permanent: give one an array for the length of this test. The trap fires the day someone
  // adds a repeated filter, and it fires as the one misclassification the taxonomy exists to
  // prevent — a caller's bad argument reported as a downed backend.
  const swappable = routes.listChats as unknown as { query: z.ZodTypeAny };
  const original = swappable.query;
  swappable.query = z.object({ kinds: z.array(z.string()) });
  const rec = recorder(() => json(emptyPage));
  // The runtime shape of every generated method, which is what lets this call the swapped schema.
  const listChats = createClient({ baseUrl: "http://x", fetch: rec.fetch }).listChats as unknown as (input: {
    query: unknown;
  }) => Promise<unknown>;
  try {
    await assert.rejects(
      () => listChats({ query: { kinds: ["a", "b"] } }),
      (err: unknown) => {
        assert.ok(err instanceof BadRequestError, `got ${(err as Error).name}`);
        assert.ok(!(err instanceof ApiUnreachableError));
        return true;
      },
    );
  } finally {
    swappable.query = original;
  }
  assert.equal(rec.calls.length, 0);
});

// --- the shape of the generated methods -----------------------------------------------------------------
//
// Compile-time, enforced by `typecheck` rather than by the runner. An unnecessary `@ts-expect-error`
// is itself an error, so each negative below fails the build the day the type stops rejecting it.

void test("a route that declares nothing takes no argument at all", async () => {
  const health = {
    ok: true,
    connection: "connected",
    needs_pairing: false,
    last_event_age_sec: 1,
    last_connected_at: 1_700_000_000,
    last_message_at: null,
    self_id: null,
    counts: { chats: 0, messages: 0, contacts: 0 },
    schema_version: 3,
    transcription_available: false,
    auto_transcribe: null,
    read_only: false,
  };
  const client = createClient({ baseUrl: "http://x", fetch: () => Promise.resolve(json(health)) });
  // Zero arguments — `Declared<R>` has no keys, so `ClientMethod<R>` is `() => …`. Task 14 calls it
  // exactly like this.
  assert.equal((await client.getHealth()).connection, "connected");
});

void test("a route that declares a body will not compile without one", () => {
  const client = createClient({ baseUrl: "http://x", fetch: () => Promise.resolve(json(emptyPage)) });
  // @ts-expect-error sendText declares a body, so an empty input is missing a required part
  const noBody = () => client.sendText({});
  // @ts-expect-error the body itself is checked, not merely present: `text` is required
  const badBody = () => client.sendText({ body: { recipient: "c" } });
  // @ts-expect-error getHealth declares nothing, so it takes no argument
  const overSupplied = () => client.getHealth({});
  // @ts-expect-error a param the route does not declare is not silently ignored
  const strayParam = () => client.listChats({ query: {}, params: { chat: "c" } });
  assert.equal(typeof noBody, "function");
  assert.equal(typeof badBody, "function");
  assert.equal(typeof overSupplied, "function");
  assert.equal(typeof strayParam, "function");
});
