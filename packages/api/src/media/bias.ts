/**
 * The proper nouns a recording is likely to contain, taken from the conversation it arrived in.
 *
 * **Why bother.** Proper nouns are where casual-speech WER accumulates: a model that hears every
 * ordinary word correctly will still write *Thibaut* for *Thibault* and *Grenoble* for *Grenoblois*,
 * and those are exactly the words a search later fails on. This server already knows who is in the
 * chat and what they talk about, so the candidate list is free to build.
 *
 * **Why it may do nothing.** Context biasing is a *hypothesis* on the self-hosted path, not a
 * feature. `mistral_common`'s transcription request carries no bias field at all; vLLM exposes a
 * `hotwords` parameter whose effect on Voxtral is unmeasured; and Mistral's own `context_bias`,
 * which is real, is documented as optimized for English on a workload that is 98 % French. The
 * worker implements three modes and the bench picks one. This module builds the list either way —
 * it costs one indexed query, and the bench cannot measure biasing without something to bias with.
 *
 * The list is therefore best-effort by construction. Nothing downstream requires it, and every
 * backend is free to ignore it.
 */

import type { ContactsRepo } from "../db/contacts.js";
import type { MessagesRepo } from "../db/messages.js";

/** Mistral's cap on `context_bias`, and what the worker's contract documents. One number, here. */
export const MAX_BIAS_TERMS = 100;

/** How much recent conversation to mine for names. Enough to catch a running topic, not a year of it. */
const RECENT_MESSAGES = 200;

/** A term shorter than this is noise — an initial, an article, a stray capital after a full stop. */
const MIN_TERM_LENGTH = 3;

/**
 * How often a capitalised word must appear before it counts as a name rather than a sentence start.
 *
 * Two, not one. Every sentence begins with a capital, so a threshold of one would fill the list
 * with `Bonjour`, `Merci` and `Demain` and push the actual names past the cap.
 */
const MIN_OCCURRENCES = 2;

/**
 * Words that are capitalised constantly and are never worth biasing toward.
 *
 * Kept deliberately short. This is a cheap filter over an already-weak signal, not a stop-word list
 * for French — anything it misses costs one slot out of a hundred, and the frequency threshold
 * above is what does the real work.
 */
const COMMON = new Set([
  "bonjour",
  "bonsoir",
  "salut",
  "merci",
  "coucou",
  "oui",
  "non",
  "ok",
  "hello",
  "demain",
  "aujourd",
  "hier",
  "voilà",
  "alors",
  "donc",
  "mais",
  "https",
  "http",
]);

/**
 * Capitalised words, in original case.
 *
 * `\p{Lu}\p{L}+` rather than `[A-Z][a-z]+`: the corpus is French, so `Émilie` and `Ångström` have
 * to match, and an ASCII class would silently skip exactly the words most worth spelling right.
 */
const CAPITALISED_RE = /\b\p{Lu}\p{L}+/gu;

export type BiasDeps = { messages: MessagesRepo; contacts: ContactsRepo };

/**
 * The usable terms inside a free-text name field, in original case.
 *
 * A push-name is routinely `Marie Dupont`, `Marie | Studio` or `Marie 🌻`, and biasing toward the
 * whole string helps nothing — the model hears one word at a time. Splitting on separators and
 * discarding the short pieces is what turns a display name into hints.
 *
 * Case is preserved on purpose: the point is to tell a model how a name is *spelled*, and a
 * lower-cased `thibault` is a worse hint than none.
 */
function partsOf(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  return raw
    .split(/[\s,/|·]+/)
    .map((part) => part.trim())
    .filter((term) => term.length >= MIN_TERM_LENGTH && !COMMON.has(term.toLowerCase()));
}

/**
 * Up to `MAX_BIAS_TERMS` terms for a chat: participant names first, then frequent capitalised words.
 *
 * Order is the ranking. Participant names are the highest-value hints and are added first so that
 * the cap, when it bites, drops mined words rather than the people in the conversation.
 *
 * Never throws. This is a hint on a transcription, and a chat whose contacts cannot be resolved
 * should produce a worse transcript, not a failed one.
 */
export function biasTermsFor(chatId: string, deps: BiasDeps): string[] {
  try {
    // Keyed case-insensitively so `Marie` and `marie` share one slot; the value is the first
    // spelling seen, and participants are read first so a contact card outranks somebody's typing.
    const spellings = new Map<string, string>();
    const counts = new Map<string, number>();
    /** Insertion order *is* the ranking, so the cap drops mined words before it drops people. */
    const ranked = new Set<string>();

    const recent = deps.messages.list({ chatId, includeDeleted: false }, RECENT_MESSAGES, 0);

    // 1. The people in this conversation, by whatever name the store knows them under.
    for (const senderId of new Set(recent.map((row) => row.senderId))) {
      const contact = deps.contacts.get(senderId);
      for (const term of [...partsOf(contact?.name), ...partsOf(contact?.notify)]) {
        const key = term.toLowerCase();
        if (!spellings.has(key)) spellings.set(key, term);
        ranked.add(key);
      }
    }

    // 2. Capitalised words the chat actually uses — where place names, project names and the
    //    nicknames that are in nobody's contact card come from.
    for (const row of recent) {
      for (const text of [row.text, row.transcript]) {
        if (text == null) continue;
        for (const match of text.matchAll(CAPITALISED_RE)) {
          const term = match[0];
          if (term.length < MIN_TERM_LENGTH || COMMON.has(term.toLowerCase())) continue;
          const key = term.toLowerCase();
          if (!spellings.has(key)) spellings.set(key, term);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }

    for (const [key] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      if ((counts.get(key) ?? 0) >= MIN_OCCURRENCES) ranked.add(key);
    }

    return [...ranked].map((key) => spellings.get(key) ?? key).slice(0, MAX_BIAS_TERMS);
  } catch {
    // Swallowed on purpose: see the doc comment. A hint that cannot be built is not an error.
    return [];
  }
}
