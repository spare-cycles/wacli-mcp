/**
 * The token behind `GET /media/dl/:token`: minted here, redeemed here, opaque everywhere else.
 *
 * That route is unauthenticated by design — that is what makes a link shareable, downloadable by a
 * browser and usable from an `<img>` without leaking a bearer token into the DOM — and it is the
 * only unauthenticated route in this service that serves conversation content. The token is
 * therefore the entire access-control decision, and it is *encrypted*, not merely signed.
 *
 * A MAC verifies data but does not carry it, so the payload has to travel inside the token; and
 * once it travels, base64url is encoding, not secrecy. A signed-and-readable token would hand
 * anyone holding the URL the file's sha256, its mimetype and its **filename** — and a filename is
 * frequently the most sensitive part of an attachment. AES-256-GCM is authenticated encryption, so
 * it replaces the separate HMAC rather than adding to it: a tampered token fails the tag and never
 * decrypts to anything at all.
 *
 * What the token is *not*: a bearer credential for the API, a session, or anything a caller may
 * mint. It is a capability for exactly one content hash, in exactly one representation, until
 * exactly one instant. It is still a credential, so it is never logged.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import type { Logger } from "pino";
import { LinkTarget, NotFoundError } from "whatsapp-api-sdk";
import { z } from "zod";

import { logger as processLogger } from "../logger.js";

/**
 * Only the two binary representations are link-mintable, and this is narrower than
 * `MediaRepresentation` for two reasons that point the same way: `text`, `transcript`, `meta` and
 * `keyframes` answer JSON, and a caller that can parse JSON can just as easily send an
 * `Authorization` header; and a token minted for one of them would have no defined redemption at a
 * route that answers bytes.
 *
 * Aliased from the SDK's `LinkTarget` rather than restated as `"raw" | "jpeg"`, so the wire schema
 * that validates `?for=` and the payload that records the answer cannot drift apart.
 */
export type LinkableRepresentation = LinkTarget;

/**
 * The plaintext record, one letter per field because every byte of it is a byte of URL.
 *
 * `s` is a sha256 and nothing else may be put there. A chat id is a phone number, and this URL
 * exists to be shared; keying on the content hash carries no identity. The payload is unreadable
 * from outside now, so the regex is defence in depth rather than the only barrier — but it is the
 * barrier that survives someone later deciding the token should be a signed JWT.
 *
 * The same schema guards both directions, which is what keeps the two from disagreeing. On the way
 * out a violation is a *caller* bug and throws `ZodError`: this process built the value and the
 * stack points at the line that did (the SDK's `createClient` documents the same split). On the way
 * back in a violation is indistinguishable from any other bad token and answers `not_found`.
 */
const Payload = z.object({
  s: z.string().regex(/^[0-9a-f]{64}$/),
  r: LinkTarget,
  m: z.string(),
  f: z.string(),
  e: z.number().int(),
});

export type LinkPayload = z.infer<typeof Payload>;

export type MediaLinkSigner = {
  mint: (p: Omit<LinkPayload, "e">) => { token: string; expiresAt: number };
  /** Throws `NotFoundError` (`code: "not_found"`) on every failure, with one message for all. */
  verify: (token: string) => LinkPayload;
};

/**
 * `v1` is both the token prefix and part of the HKDF info string, which is what binds the two: a
 * body minted under this version cannot verify under a future one, because v2 will derive a
 * different key from the same API token. Nothing else has to authenticate the prefix.
 */
const VERSION = "v1";

/** AES-256-GCM: a fresh 96-bit IV per token, the standard 128-bit tag. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * RFC 5869 makes the salt optional and defaults it to HashLen zeroes; a constant baked into the
 * source would be no more secret and no more separating than the info string already is.
 */
const HKDF_SALT = "";
const HKDF_INFO = `whatsapp-api/media-link/${VERSION}`;

/**
 * One message for a bad tag, a bad version, malformed base64 and an expired token alike.
 *
 * Written for a human and deliberately incurious about the cause: distinguishing "expired" from
 * "forged" would hand an attacker a free oracle telling them when they have guessed a token shape
 * that once existed. Callers branch on `code`, never on this text.
 */
const REFUSAL = "this media link is invalid or expired";

/**
 * Every failure path goes through here, which is what makes them one failure as far as a caller
 * can tell. Nothing else in this module throws.
 */
const refuse = (): never => {
  throw new NotFoundError(REFUSAL);
};

/**
 * The 256-bit key, and the only place the API token is touched.
 *
 * Rotating `WHATSAPP_API_TOKEN` rotates this key and so invalidates every outstanding link, which
 * is the behaviour an operator rotating a leaked secret expects. With no token configured the key
 * is 32 random bytes generated here, so links die with the process rather than being derived from
 * a constant every deployment of this image would share — an empty string counts as no token for
 * exactly that reason.
 */
function deriveKey(apiToken: string | undefined, log: Logger): Buffer {
  const configured = apiToken !== undefined && apiToken.length > 0;
  if (!configured) {
    log.info(
      "media links: no API token is configured, so download links are keyed to this process and stop working after a restart",
    );
  }
  const ikm = configured ? Buffer.from(apiToken, "utf8") : randomBytes(KEY_BYTES);
  return Buffer.from(hkdfSync("sha256", ikm, HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

export function makeMediaLinkSigner(deps: {
  /** `WHATSAPP_API_TOKEN`. Absent or empty means an ephemeral key, and a line in the log saying so. */
  apiToken: string | undefined;
  /** `config.mediaLinkTtlSec`. Baked into each token, so changing it never revokes an outstanding one. */
  ttlSec: number;
  /** Epoch *seconds*. Injected only by tests; production reads the wall clock. */
  now?: (() => number) | undefined;
  /**
   * Only ever written to at construction, and only to report an ephemeral key. Optional so the
   * signer can be built in a test without one; nothing on the mint or verify path logs anything,
   * because everything on those paths is either a credential or conversation content.
   */
  logger?: Logger | undefined;
}): MediaLinkSigner {
  const { apiToken, ttlSec } = deps;
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
  const key = deriveKey(apiToken, deps.logger ?? processLogger);

  return {
    mint(p) {
      const record = Payload.parse({ ...p, e: now() + ttlSec });
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
      const body = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url");
      return { token: `${VERSION}.${body}`, expiresAt: record.e };
    },

    verify(token) {
      const dot = token.indexOf(".");
      if (dot === -1 || token.slice(0, dot) !== VERSION) return refuse();
      const body = token.slice(dot + 1);

      const raw = Buffer.from(body, "base64url");
      // Node's base64 decoder skips characters it does not recognise and ignores padding, so
      // `<body>=`, `<body>!` and ` <body>` all decode to the same bytes. Re-encoding and comparing
      // is what makes a token one string rather than unboundedly many, which anything keyed on the
      // token — a rate-limit bucket, a revocation list — depends on.
      if (raw.length < IV_BYTES + TAG_BYTES || raw.toString("base64url") !== body) return refuse();

      let plaintext: string;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
        decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
        const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        // `final()` throws when the tag does not match. Nothing decrypted, so there is nothing to
        // report but the refusal itself — in particular no OpenSSL message, which would name the
        // failure mode this whole design is hiding.
        return refuse();
      }

      let record: unknown;
      try {
        record = JSON.parse(plaintext) as unknown;
      } catch {
        return refuse();
      }
      const parsed = Payload.safeParse(record);
      if (!parsed.success) return refuse();

      // The clock, last. Reaching it at all means the tag verified, which is why an expired token
      // and a forged one are indistinguishable: the forged one never gets here. Expiry is exclusive
      // at the boundary, as in RFC 7519 — a token is dead at `e`, not after it.
      if (parsed.data.e <= now()) return refuse();
      return parsed.data;
    },
  };
}
