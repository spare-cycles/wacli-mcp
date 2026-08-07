/**
 * Term extraction, and the cap.
 *
 * Biasing may turn out to do nothing on the self-hosted path — that is what the worker's three
 * modes and its bench are for — but the list itself either contains the names in the conversation
 * or it does not, and that is testable regardless of whether any model reads it.
 *
 * The two properties worth pinning are the ones a plausible refactor would break: **ranking**, so
 * the 100-term cap drops mined words rather than the people in the chat, and **case**, because the
 * entire point of a hint is to say how a name is spelled.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeContactsRepo } from "../db/contacts.js";
import { closeDb, openDb, type Db } from "../db/client.js";
import { makeMessagesRepo, type MessagesRepo } from "../db/messages.js";
import { biasTermsFor, MAX_BIAS_TERMS } from "./bias.js";

const CHAT = "33600000000@s.whatsapp.net";
const OTHER = "33611111111@s.whatsapp.net";

function rig(): { db: Db; messages: MessagesRepo; terms: () => string[]; close: () => void } {
  const db = openDb(":memory:");
  const messages = makeMessagesRepo(db);
  const contacts = makeContactsRepo(db);
  db.prepare("INSERT INTO chats (id, is_group) VALUES (?, 1)").run(CHAT);
  return {
    db,
    messages,
    terms: () => biasTermsFor(CHAT, { messages, contacts }),
    close: () => {
      closeDb(db);
    },
  };
}

let seq = 0;
/** Store one message and hand back its id — `seq` is module-wide, so no test may assume `m1`. */
function say(messages: MessagesRepo, text: string, senderId = OTHER): string {
  seq += 1;
  const id = `m${seq}`;
  messages.upsert({ chatId: CHAT, id, senderId, ts: 1_800_000_000 + seq, fromMe: false, kind: "text", text });
  return id;
}

void test("a participant's contact name is a term, spelled as the contact card spells it", (t) => {
  const r = rig();
  t.after(r.close);
  r.db.prepare("INSERT INTO contacts (id, name) VALUES (?, ?)").run(OTHER, "Thibault Fèvre");
  say(r.messages, "coucou");

  const terms = r.terms();

  assert.ok(terms.includes("Thibault"), terms.join(","));
  // Accented, and kept that way: a French corpus is the whole point, and `Fevre` is a different
  // spelling from `Fèvre`.
  assert.ok(terms.includes("Fèvre"), terms.join(","));
});

void test("a display name is split into words rather than biased toward whole", (t) => {
  // A push-name is routinely `Marie | Studio` or `Marie 🌻`; the model hears one word at a time, so
  // biasing toward the whole string helps nothing.
  const r = rig();
  t.after(r.close);
  r.db.prepare("INSERT INTO contacts (id, notify) VALUES (?, ?)").run(OTHER, "Marie | Studio Grenoble");
  say(r.messages, "coucou");

  const terms = r.terms();

  assert.ok(terms.includes("Marie"));
  assert.ok(terms.includes("Studio"));
  assert.ok(!terms.some((term) => term.includes("|")));
});

void test("a capitalised word the chat really uses becomes a term once it recurs", (t) => {
  const r = rig();
  t.after(r.close);
  say(r.messages, "on se retrouve à Chambéry");
  say(r.messages, "Chambéry ou Annecy ?");

  const terms = r.terms();

  assert.ok(terms.includes("Chambéry"), terms.join(","));
  // Seen once: every sentence starts with a capital, so one occurrence is not evidence of a name.
  assert.ok(!terms.includes("Annecy"), terms.join(","));
});

void test("sentence-opening pleasantries are not mistaken for names", (t) => {
  const r = rig();
  t.after(r.close);
  for (let i = 0; i < 5; i += 1) {
    say(r.messages, "Bonjour, ça va ?");
    say(r.messages, "Merci beaucoup");
  }

  const terms = r.terms();

  assert.ok(!terms.includes("Bonjour"), terms.join(","));
  assert.ok(!terms.includes("Merci"), terms.join(","));
});

void test("a transcript is mined too, so names learned by ear reinforce themselves", (t) => {
  const r = rig();
  t.after(r.close);
  const id = say(r.messages, "ok");
  r.messages.setTranscript(CHAT, id, "salut c'est Ludivine, on se voit chez Ludivine demain", "voxtral");

  assert.ok(r.terms().includes("Ludivine"));
});

void test("participants outrank mined words, so the cap drops the right ones", (t) => {
  const r = rig();
  t.after(r.close);
  r.db.prepare("INSERT INTO contacts (id, name) VALUES (?, ?)").run(OTHER, "Ziggy");
  // Far more mined candidates than the cap allows. Letters, not `Mot${i}`: digits are not
  // `\p{L}`, so a numbered fixture would collapse into the single term "Mot".
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < MAX_BIAS_TERMS + 50; i += 1) {
    const word = `M${letters[Math.floor(i / 26) % 26]}${letters[i % 26]}zz`;
    say(r.messages, `${word} ${word}`);
  }

  const terms = r.terms();

  assert.equal(terms.length, MAX_BIAS_TERMS);
  // Insertion order is the ranking: a name from a contact card is a far better hint than a word
  // that happened to appear twice, so it must survive the truncation.
  assert.ok(terms.includes("Ziggy"), "the participant's name was truncated away");
});

void test("a term is never repeated, whatever case it appeared in", (t) => {
  const r = rig();
  t.after(r.close);
  r.db.prepare("INSERT INTO contacts (id, name) VALUES (?, ?)").run(OTHER, "Marie");
  say(r.messages, "Marie arrive");
  say(r.messages, "Marie est là");

  const terms = r.terms();

  assert.equal(terms.filter((term) => term.toLowerCase() === "marie").length, 1);
});

void test("very short tokens are dropped", (t) => {
  const r = rig();
  t.after(r.close);
  say(r.messages, "JR JR OK OK");
  say(r.messages, "JR OK");

  // Initials and two-letter acronyms are noise; nothing is gained by spending a slot on them.
  assert.deepEqual(r.terms(), []);
});

void test("a chat with nothing in it produces no terms rather than failing", (t) => {
  const r = rig();
  t.after(r.close);
  assert.deepEqual(r.terms(), []);
});

void test("a repository that throws produces an empty list, not an exception", () => {
  // Biasing is a hint on a transcription. A chat whose contacts cannot be resolved should produce a
  // worse transcript, not a failed one.
  const messages = {
    list: () => {
      throw new Error("db is gone");
    },
  } as unknown as MessagesRepo;
  const contacts = { get: () => undefined } as unknown as ReturnType<typeof makeContactsRepo>;
  assert.deepEqual(biasTermsFor(CHAT, { messages, contacts }), []);
});
