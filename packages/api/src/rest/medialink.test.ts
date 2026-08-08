import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Logger } from "pino";
import { ApiError } from "whatsapp-api-sdk";

import { makeMediaLinkSigner } from "./medialink.js";

const SHA = "a".repeat(64);

/**
 * What `verify` promises on every failure, and the only thing a caller may branch on.
 *
 * The brief's own drafts asserted `/not_found/` against the thrown error, which node matches
 * against `String(err)` — so it would have forced the wire *code* into the human-readable message.
 * The contract is the class and its code; the message is prose, and pinning prose to a machine
 * contract is how the next wording improvement silently breaks a security test.
 */
const isRefusal = (err: unknown): boolean => err instanceof ApiError && err.code === "not_found";

/** Everything a caller can observe about a refusal, as one comparable string. */
function observed(run: () => unknown): string {
  try {
    run();
    return "no refusal at all";
  } catch (err) {
    if (!(err instanceof ApiError)) return String(err);
    return JSON.stringify({
      name: err.name,
      code: err.code,
      status: err.status,
      message: err.message,
      details: err.details ?? null,
    });
  }
}

/** `version.body`, without a non-null assertion — the lint config forbids one and is right to. */
function split(token: string): { version: string; body: string } {
  const [version = "", body = ""] = token.split(".");
  return { version, body };
}

/** A copy of `buf` with the byte at `index` inverted. */
function flip(buf: Buffer, index: number): Buffer {
  const out = Buffer.from(buf);
  out.writeUInt8(out.readUInt8(index) ^ 0xff, index);
  return out;
}

type Line = { level: string; arg: unknown; msg: string | undefined };

/**
 * A logger that records instead of writing, shaped like `silentLogger` in `../logger.ts` and cast
 * the same way: pino's `Logger` is far wider than the six methods anything here calls.
 */
function captureLogger(sink: Line[]): Logger {
  const at =
    (level: string) =>
    (arg: unknown, msg?: string): void => {
      sink.push({ level, arg, msg });
    };
  const self = {
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    debug: at("debug"),
    trace: at("trace"),
    fatal: at("fatal"),
    level: "info",
  };
  return { ...self, child: () => self } as unknown as Logger;
}

// --- the token as a credential -------------------------------------------------------------

void test("a tampered token is refused, wherever the tampering lands", () => {
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 900 });
  const { token } = s.mint({ s: SHA, r: "raw", m: "image/jpeg", f: "x.jpg" });
  const { version, body } = split(token);
  const raw = Buffer.from(body, "base64url");

  // The IV, the first ciphertext byte, and the last byte of the GCM tag. A scheme that authenticated
  // only part of the record would survive one of the three.
  for (const index of [0, 12, raw.length - 1]) {
    const forged = `${version}.${flip(raw, index).toString("base64url")}`;
    assert.throws(() => s.verify(forged), isRefusal, `byte ${index}`);
  }
  // The untampered original still verifies, so the loop above is refusing the tampering and not
  // something incidental about how this test rebuilds the token.
  assert.equal(s.verify(`${version}.${raw.toString("base64url")}`).s, SHA);
});

void test("an expired token and a forged token are indistinguishable", () => {
  let now = 1000;
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 10, now: () => now });
  const { token } = s.mint({ s: SHA, r: "raw", m: "image/jpeg", f: "x.jpg" });
  now = 5000;

  const stale = observed(() => s.verify(token));
  assert.equal(
    stale,
    observed(() => s.verify("v1.aaaaaaaaaaaaaaaaaaaaaaaa")),
  );
  // Without this the assertion above would also pass if both calls had *succeeded*.
  assert.notEqual(stale, "no refusal at all");
});

void test("every way a token can fail produces one identical error, so redemption is no oracle", () => {
  let now = 1000;
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 10, now: () => now });
  const other = makeMediaLinkSigner({ apiToken: "k2", ttlSec: 10, now: () => now });
  const { token } = s.mint({ s: SHA, r: "raw", m: "image/jpeg", f: "x.jpg" });
  const { version, body } = split(token);
  const raw = Buffer.from(body, "base64url");
  now = 5000;

  const cases: Record<string, string> = {
    expired: token,
    "tag flipped": `${version}.${flip(raw, raw.length - 1).toString("base64url")}`,
    "ciphertext flipped": `${version}.${flip(raw, 12).toString("base64url")}`,
    "iv flipped": `${version}.${flip(raw, 0).toString("base64url")}`,
    "minted under another key": other.mint({ s: SHA, r: "raw", m: "image/jpeg", f: "x.jpg" }).token,
    "unknown version": `v2.${body}`,
    "no version at all": body,
    empty: "",
    "just a dot": ".",
    "not base64 at all": "v1.****",
    "too short to hold an iv and a tag": `v1.${Buffer.alloc(20).toString("base64url")}`,
    "all zeroes": `v1.${Buffer.alloc(64).toString("base64url")}`,
    truncated: `${version}.${raw.subarray(0, raw.length - 4).toString("base64url")}`,
  };

  const [first = ""] = Object.values(cases).map((t) => observed(() => s.verify(t)));
  assert.notEqual(first, "no refusal at all");
  for (const [name, t] of Object.entries(cases)) {
    assert.equal(
      observed(() => s.verify(t)),
      first,
      name,
    );
    assert.throws(() => s.verify(t), isRefusal, name);
  }
  // That shared error is the one the REST layer turns into a 404, and it carries no `details` for
  // a caller to read a cause out of.
  const shape = JSON.parse(first) as Record<string, unknown>;
  assert.equal(shape["name"], "NotFoundError");
  assert.equal(shape["code"], "not_found");
  assert.equal(shape["status"], 404);
  assert.equal(shape["details"], null);
  assert.ok(typeof shape["message"] === "string" && shape["message"].length > 0);
});

void test("verification checks the tag before the clock, so a forgery never reaches the expiry test", () => {
  // The order is not observable from the errors — that is the point of the test above. It is
  // observable from the clock: an implementation that asked "is this expired?" first would consult
  // `now` for a token whose tag never verified.
  let calls = 0;
  let t = 1000;
  const now = (): number => {
    calls += 1;
    return t;
  };
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 10, now });
  const { token } = s.mint({ s: SHA, r: "raw", m: "image/jpeg", f: "x.jpg" });
  t = 5000;

  const afterMint = calls;
  assert.throws(() => s.verify(`v1.${Buffer.alloc(40).toString("base64url")}`), isRefusal);
  assert.equal(calls, afterMint, "a token that fails the GCM tag must never be compared against the clock");

  assert.throws(() => s.verify(token), isRefusal);
  assert.equal(calls, afterMint + 1, "an authentic token is the only kind that reaches the expiry check");
});

void test("the token is opaque — the payload is not readable from it", () => {
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 900 });
  const { token } = s.mint({ s: SHA, r: "raw", m: "image/jpeg", f: "settlement.pdf" });
  const { body } = split(token);
  const raw = Buffer.from(body, "base64url").toString("latin1");
  // Encryption, not encoding: neither the hash, nor the filename, nor the mimetype, nor the field
  // names of the record survive in the ciphertext.
  assert.doesNotMatch(raw, /settlement/);
  assert.doesNotMatch(raw, /image\/jpeg/);
  assert.doesNotMatch(token, /settlement/);
  assert.ok(!raw.includes(SHA));
  assert.ok(!raw.includes('"s":'));
});

void test("a token round-trips to exactly what was minted", () => {
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 900, now: () => 1000 });
  const p = { s: "b".repeat(64), r: "jpeg" as const, m: "image/jpeg", f: "photo.jpg" };
  assert.deepEqual(s.verify(s.mint(p).token), { ...p, e: 1900 });
});

void test("a filename the sender chose survives the round trip byte for byte", () => {
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 900 });
  const f = "été 📎 «devis».pdf";
  const { token } = s.mint({ s: SHA, r: "raw", m: "application/pdf", f });
  assert.equal(s.verify(token).f, f);
});

void test("mint reports the expiry it actually baked into the token", () => {
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 60, now: () => 4242 });
  const { token, expiresAt } = s.mint({ s: SHA, r: "raw", m: "image/jpeg", f: "x.jpg" });
  assert.equal(expiresAt, 4302);
  assert.equal(s.verify(token).e, expiresAt);
});

void test("a link is dead the instant it expires, not a second later", () => {
  let t = 1000;
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 10, now: () => t });
  const { token } = s.mint({ s: SHA, r: "raw", m: "image/jpeg", f: "x.jpg" });
  t = 1009;
  assert.equal(s.verify(token).e, 1010);
  t = 1010;
  assert.throws(() => s.verify(token), isRefusal);
});

void test("every token gets its own IV, so two links to the same file are not the same string", () => {
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 900, now: () => 1000 });
  const p = { s: SHA, r: "raw" as const, m: "image/jpeg", f: "x.jpg" };
  const a = s.mint(p).token;
  const b = s.mint(p).token;
  assert.notEqual(a, b);
  assert.deepEqual(s.verify(a), s.verify(b));
  // 12 bytes of IV, 16 of GCM tag, and a ciphertext exactly as long as the JSON record.
  const raw = Buffer.from(split(a).body, "base64url");
  assert.equal(split(a).version, "v1");
  assert.ok(raw.length > 12 + 16);
  assert.match(a, /^v1\.[A-Za-z0-9_-]+$/);
});

void test("a re-encoded token is not the same token: base64url is checked for canonical form", () => {
  // `Buffer.from(s, "base64url")` skips characters it does not recognise and ignores padding, so
  // `<token>=`, `<token>!` and ` <token>` all decode to the same bytes. Without a canonical check
  // one link would have unboundedly many spellings, and anything Task 9 keys on the token string —
  // a rate-limit bucket, a revocation list — would be trivially evadable.
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 900 });
  const { token } = s.mint({ s: SHA, r: "raw", m: "image/jpeg", f: "x.jpg" });
  const { version, body } = split(token);
  for (const variant of [`${body}=`, `${body}==`, `${body}!`, ` ${body}`, `${body}\n`]) {
    assert.equal(Buffer.from(variant, "base64url").equals(Buffer.from(body, "base64url")), true, variant);
    assert.throws(() => s.verify(`${version}.${variant}`), isRefusal, variant);
  }
});

// --- what may travel in the payload --------------------------------------------------------

void test("only the two binary representations are link-mintable", () => {
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 900 });
  const isCallerBug = (err: unknown): boolean => err instanceof Error && err.name === "ZodError";

  // Compile-time first, enforced by `typecheck` rather than by the runner: an unnecessary
  // `@ts-expect-error` is itself an error, so this line starts failing the build the day
  // `LinkableRepresentation` widens to a representation that answers JSON.
  assert.throws(
    // @ts-expect-error `text` is a JSON representation: LinkableRepresentation is narrower on purpose
    () => s.mint({ s: SHA, r: "text", m: "text/plain", f: "x.txt" }),
    isCallerBug,
  );

  // And at runtime, for a caller that defeats the type — a route handler forwarding a string it
  // parsed out of a query. The refusal is a caller bug, not a `not_found`: nobody redeemed anything.
  for (const r of ["text", "transcript", "meta", "keyframes", "link", "", "RAW"]) {
    assert.throws(() => s.mint({ s: SHA, r: r as "raw", m: "text/plain", f: "x.txt" }), isCallerBug, r);
  }
});

void test("the payload names a sha256 and cannot be made to name a chat", () => {
  const s = makeMediaLinkSigner({ apiToken: "k", ttlSec: 900, now: () => 1000 });
  const isCallerBug = (err: unknown): boolean => err instanceof Error && err.name === "ZodError";

  // A chat id is a phone number and this URL exists to be shared. The field is a content hash, and
  // nothing that is not one can be put in it — including the JIDs someone would reach for first.
  for (const s2 of [
    "33612345678@s.whatsapp.net",
    "120363000000000000@g.us",
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    `${"a".repeat(63)}@`,
  ]) {
    assert.throws(() => s.mint({ s: s2, r: "raw", m: "image/jpeg", f: "x.jpg" }), isCallerBug, JSON.stringify(s2));
  }

  // Defence in depth on the shape as a whole. A caller spreading a database row into the payload is
  // the likeliest way a JID would ever get near this token, so the record is built field by field
  // from the schema: anything else is dropped before encryption rather than carried and ignored.
  const smuggled = { s: SHA, r: "raw" as const, m: "image/jpeg", f: "x.jpg", chat: "33612345678@s.whatsapp.net" };
  const { token } = s.mint(smuggled);
  assert.deepEqual(Object.keys(s.verify(token)).sort(), ["e", "f", "m", "r", "s"]);
  assert.ok(!Buffer.from(split(token).body, "base64url").toString("latin1").includes("33612345678"));
  assert.ok(!token.includes("33612345678"));
});

// --- keys ------------------------------------------------------------------------------------

void test("rotating the API token invalidates outstanding links", () => {
  const a = makeMediaLinkSigner({ apiToken: "k1", ttlSec: 900 });
  const b = makeMediaLinkSigner({ apiToken: "k2", ttlSec: 900 });
  const { token } = a.mint({ s: "c".repeat(64), r: "raw", m: "image/jpeg", f: "x.jpg" });
  assert.throws(() => b.verify(token), isRefusal);
});

void test("changing only the TTL keeps outstanding links redeemable", () => {
  // The key derives from the API token alone. A restart that shortens WHATSAPP_MEDIA_LINK_TTL must
  // not revoke every link already handed out — each one carries the expiry it was minted with.
  const a = makeMediaLinkSigner({ apiToken: "k", ttlSec: 900, now: () => 1000 });
  const b = makeMediaLinkSigner({ apiToken: "k", ttlSec: 60, now: () => 1000 });
  const { token } = a.mint({ s: SHA, r: "raw", m: "image/jpeg", f: "x.jpg" });
  assert.equal(b.verify(token).e, 1900);
});

void test("with no API token configured, links do not survive a restart", () => {
  const lines: Line[] = [];
  const boot = makeMediaLinkSigner({ apiToken: undefined, ttlSec: 900, logger: captureLogger(lines) });
  const reboot = makeMediaLinkSigner({ apiToken: undefined, ttlSec: 900, logger: captureLogger([]) });
  const { token } = boot.mint({ s: SHA, r: "raw", m: "image/jpeg", f: "x.jpg" });

  assert.equal(boot.verify(token).s, SHA);
  assert.throws(() => reboot.verify(token), isRefusal);

  // Logged once at boot, so an operator can tell "links keep breaking" from a bug.
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.level, "info");
  assert.match(JSON.stringify(lines[0]), /restart/);
});

void test("an empty API token is no token: it must not become a key every deployment shares", () => {
  const lines: Line[] = [];
  const a = makeMediaLinkSigner({ apiToken: "", ttlSec: 900, logger: captureLogger(lines) });
  const b = makeMediaLinkSigner({ apiToken: "", ttlSec: 900, logger: captureLogger([]) });
  const { token } = a.mint({ s: SHA, r: "raw", m: "image/jpeg", f: "x.jpg" });
  assert.throws(() => b.verify(token), isRefusal);
  assert.equal(lines.length, 1);
});

// --- secret hygiene ----------------------------------------------------------------------------

void test("nothing about a token is ever logged, and no secret reaches the refusal", () => {
  const lines: Line[] = [];
  const s = makeMediaLinkSigner({ apiToken: "s3cret-api-token", ttlSec: 900, logger: captureLogger(lines) });
  const { token } = s.mint({ s: SHA, r: "raw", m: "image/jpeg", f: "settlement.pdf" });
  s.verify(token);
  const refusal = observed(() =>
    s.verify(`${split(token).version}.${flip(Buffer.from(split(token).body, "base64url"), 0).toString("base64url")}`),
  );

  // A configured key means nothing is logged at all: the one line this module ever writes is the
  // ephemeral-key notice, and there is no ephemeral key here.
  assert.deepEqual(lines, []);

  // The token is a credential and the filename is conversation content. Neither is in the refusal,
  // and neither is the API token that keys it.
  for (const secret of [token, split(token).body, "s3cret-api-token", "settlement.pdf", SHA]) {
    assert.ok(!refusal.includes(secret), secret.slice(0, 24));
  }
});
