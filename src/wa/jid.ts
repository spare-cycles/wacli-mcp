/**
 * The only module in this codebase allowed to interpret a raw JID: split it on
 * `@`/`:`, or contain the substrings `@lid`, `@s.whatsapp.net`, `@g.us`. Every
 * other module goes through the functions exported here (Global Constraint 11).
 *
 * Pure: no I/O, no database, no imports.
 */

export type JidKind = "user" | "lid" | "group" | "broadcast" | "newsletter" | "unknown";

const SERVER_KIND: Record<string, JidKind> = {
  "s.whatsapp.net": "user",
  lid: "lid",
  "g.us": "group",
  broadcast: "broadcast",
  newsletter: "newsletter",
};

/** Split a raw JID into its local part and server, splitting on the *last* `@`. */
function splitJid(jid: string): { local: string; server: string } | undefined {
  const at = jid.lastIndexOf("@");
  if (at === -1) return undefined;
  return { local: jid.slice(0, at), server: jid.slice(at + 1) };
}

/** Strip a trailing `:<digits>` device suffix from a local part. */
function stripDevice(local: string): string {
  return local.replace(/:\d+$/, "");
}

/** Strip a trailing `_<digits>` agent suffix from a local part. */
function stripAgent(local: string): string {
  return local.replace(/_\d+$/, "");
}

/**
 * Strip device/agent suffixes to a fixed point. A single pass only peels one layer, so a
 * local part carrying a chained or repeated suffix-shaped substring (malformed input; real
 * WhatsApp JIDs never chain) would otherwise keep changing on repeated application. Looping
 * until the string stops changing makes the strip — and therefore `normalizeJid` and
 * `canonicalId` — idempotent on any input. Terminates because each iteration either shortens
 * the string or leaves it unchanged, which ends the loop.
 */
function stripSuffixes(local: string): string {
  let prev: string;
  let current = local;
  do {
    prev = current;
    current = stripAgent(stripDevice(current));
  } while (current !== prev);
  return current;
}

export function jidKind(jid: string): JidKind {
  const parts = splitJid(jid);
  if (!parts) return "unknown";
  return SERVER_KIND[parts.server.toLowerCase()] ?? "unknown";
}

export function isUserJid(jid: string): boolean {
  return jidKind(jid) === "user";
}

export function isLidJid(jid: string): boolean {
  return jidKind(jid) === "lid";
}

export function isGroupJid(jid: string): boolean {
  return jidKind(jid) === "group";
}

/**
 * Strip the device (`:12`) and agent (`_1`) suffixes from the local part, lowercase the
 * server. Never changes the server itself, and never throws: malformed input (no `@`) is
 * returned unchanged.
 */
export function normalizeJid(jid: string): string {
  const parts = splitJid(jid);
  if (!parts) return jid;
  const local = stripSuffixes(parts.local);
  return `${local}@${parts.server.toLowerCase()}`;
}

/** The local part of a user JID, i.e. the phone number. undefined for anything else. */
export function phoneFromJid(jid: string): string | undefined {
  const normalized = normalizeJid(jid);
  const parts = splitJid(normalized);
  if (!parts || SERVER_KIND[parts.server] !== "user") return undefined;
  return parts.local;
}

/** The local part of a LID JID. undefined for anything else. */
export function lidFromJid(jid: string): string | undefined {
  const normalized = normalizeJid(jid);
  const parts = splitJid(normalized);
  if (!parts || SERVER_KIND[parts.server] !== "lid") return undefined;
  return parts.local;
}

/** Build a user JID from an E.164 number without `+`. */
export function userJid(phone: string): string {
  return `${phone}@s.whatsapp.net`;
}

export type IdentityLookup = { pnForLid: (lid: string) => string | undefined };

/**
 * The canonical store id for a JID. Policy: a group/broadcast/newsletter is itself;
 * a user JID is itself; a LID is resolved to its phone JID when the mapping is known,
 * and stays a LID when it is not. Normalizes first, and never throws: malformed input
 * comes back as its normalized form, unchanged by policy.
 */
export function canonicalId(jid: string, lookup?: IdentityLookup): string {
  const normalized = normalizeJid(jid);
  if (jidKind(normalized) !== "lid") return normalized;
  const lid = lidFromJid(normalized);
  if (lid === undefined || lookup === undefined) return normalized;
  const resolved = lookup.pnForLid(lid);
  return resolved === undefined ? normalized : normalizeJid(resolved);
}
