/**
 * Turning what a caller *called* someone into the chat id the store keys on.
 *
 * A model reading a conversation has a JID for every chat it saw, and for those this module is a
 * pass-through. It exists for the other case — "send this to Marie" — which the old server supported
 * and which is how a person actually names a recipient. Losing it would have made every send a
 * two-step dance through `wa_contacts_search`, and a model that skipped the first step would send to
 * whatever it guessed.
 *
 * Two rules shape it:
 *
 * 1. **Ambiguity is refused, never guessed.** Two people named Marie is the normal case, and picking
 *    one sends a private message to the wrong person — the single most damaging thing this server can
 *    do. The refusal names the candidates so the caller can retry with `pick`, which is the same
 *    contract the old server's `--pick` had.
 * 2. **The order of candidates is stable.** `pick: 2` has to mean the same row on the retry as it did
 *    in the refusal that suggested it, so the list is sorted by a total order over the data rather
 *    than left in whatever sequence two queries happened to return.
 *
 * No JID is interpreted here (Global Constraint 11): `parseRecipient` and `canonicalId` in
 * `wa/jid.ts` do that, and this module works with the opaque ids they return.
 */

import type { ChatsRepo } from "../db/chats.js";
import type { ContactsRepo } from "../db/contacts.js";
import { canonicalId, parseRecipient } from "./jid.js";

export type RecipientDeps = { chats: ChatsRepo; contacts: ContactsRepo };

/** Nothing in the store answers to that name. Distinct from ambiguity: there is nothing to pick. */
export class RecipientNotFoundError extends Error {
  override name = "RecipientNotFoundError";
}

/** Several chats or contacts answer to that name, and no `pick` said which. */
export class AmbiguousRecipientError extends Error {
  override name = "AmbiguousRecipientError";
}

/** How many rows each of the two queries contributes before the merge. */
const CANDIDATE_LIMIT = 25;

/** How many candidates an ambiguity refusal names. Enough to choose from, short enough to read. */
const LISTED_CANDIDATES = 10;

export type RecipientCandidate = { id: string; label: string; exact: boolean };

/**
 * Every chat or contact whose name matches, merged and ordered.
 *
 * Both sides are consulted because they answer different questions: `chats` knows groups and the
 * conversations that exist, `contacts` knows people whose number is in the address book but who have
 * never been messaged from this account. A person in both must appear once, which is what the id
 * dedupes on — otherwise every contact you have also messaged would be a two-way ambiguity.
 *
 * The `canonicalId` call is uniformity rather than a fix for a reachable bug: `linkIdentity` re-keys
 * both repositories when a LID mapping arrives, so neither is expected to hand back a LID that has a
 * phone JID. It stays because every id crossing a boundary in this codebase goes through it, and an
 * exception here would be the thing a later change quietly relies on.
 */
function candidatesFor(name: string, deps: RecipientDeps): RecipientCandidate[] {
  const wanted = name.toLowerCase();
  const byId = new Map<string, RecipientCandidate>();

  const add = (rawId: string, label: string | null): void => {
    const id = canonicalId(rawId, deps.contacts);
    const shown = label === null || label === "" ? id : label;
    // First writer wins, so a chat's own name beats the contact-derived one for the same person.
    if (!byId.has(id)) byId.set(id, { id, label: shown, exact: shown.toLowerCase() === wanted });
  };

  for (const chat of deps.chats.list({ query: name }, CANDIDATE_LIMIT, 0)) add(chat.id, chat.name);
  for (const contact of deps.contacts.search(name, CANDIDATE_LIMIT, 0)) add(contact.id, contact.name ?? contact.notify);

  // Exact matches first — "Marie" must not be ambiguous merely because "Marie-Claire" also matched
  // the substring — then a total order on the data so `pick` means the same thing on every retry.
  return [...byId.values()].sort(
    (a, b) => Number(b.exact) - Number(a.exact) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
}

/** Numbered `<n>) <label> · <chat id>` lines for a refusal, capped so the message stays readable. */
function describeCandidates(candidates: readonly RecipientCandidate[]): string {
  const shown = candidates.slice(0, LISTED_CANDIDATES).map((c, i) => `${String(i + 1)}) ${c.label} · ${c.id}`);
  const rest = candidates.length - shown.length;
  return shown.join("\n") + (rest > 0 ? `\n… and ${String(rest)} more; narrow the name instead of picking` : "");
}

/**
 * The chat id to send to.
 *
 * A JID or a phone number resolves without touching the store. A name is looked up, and `pick`
 * — 1-indexed, as the refusal numbers them — selects among several. An out-of-range `pick` is an
 * error rather than a clamp: clamping would send to the last candidate whenever the list shrank
 * between the refusal and the retry.
 */
export function resolveRecipient(to: string, pick: number | undefined, deps: RecipientDeps): string {
  const form = parseRecipient(to);
  if (form.kind !== "name") {
    if (pick !== undefined) {
      throw new Error("`pick` only applies when the recipient is named by name; it is not needed for a JID or number");
    }
    return canonicalId(form.jid, deps.contacts);
  }

  const name = to.trim();
  const candidates = candidatesFor(name, deps);
  if (candidates.length === 0) {
    throw new RecipientNotFoundError(
      `no chat, group or contact is named "${name}" — search with wa_contacts_search or wa_chats_list, ` +
        "or give a JID or phone number",
    );
  }

  if (pick !== undefined) {
    const chosen = candidates[pick - 1];
    if (chosen === undefined) {
      throw new RecipientNotFoundError(
        `pick=${String(pick)} is out of range: "${name}" matches ${String(candidates.length)}:\n` +
          describeCandidates(candidates),
      );
    }
    return chosen.id;
  }

  const first = candidates[0];
  // Unreachable — the length was just checked — but narrowing it here keeps the assertion out of the
  // hot path below, where a wrong one would send to the wrong person.
  if (first === undefined) throw new RecipientNotFoundError(`no chat, group or contact is named "${name}"`);

  // One candidate, or exactly one *exact* name match among several: an unambiguous answer either way.
  const exactCount = candidates.filter((c) => c.exact).length;
  if (candidates.length === 1 || exactCount === 1) {
    return exactCount === 1 ? (candidates.find((c) => c.exact) ?? first).id : first.id;
  }

  throw new AmbiguousRecipientError(
    `"${name}" matches ${String(candidates.length)} chats or contacts; re-send with pick set to one of:\n` +
      describeCandidates(candidates),
  );
}
