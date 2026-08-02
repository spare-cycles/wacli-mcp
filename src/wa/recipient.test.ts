import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeChatsRepo } from "../db/chats.js";
import { openDb } from "../db/client.js";
import { makeContactsRepo } from "../db/contacts.js";
import { AmbiguousRecipientError, RecipientNotFoundError, resolveRecipient } from "./recipient.js";

const dir = mkdtempSync(join(tmpdir(), "wa-recipient-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ALICE = "33611111111@s.whatsapp.net";
const ALICIA = "33622222222@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";

/** The error a call threw. `assert.throws` returns undefined, so it cannot check the message too. */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof Error, "expected an Error");
    return err;
  }
  assert.fail("expected the call to throw");
}

let n = 0;
function deps(): { chats: ReturnType<typeof makeChatsRepo>; contacts: ReturnType<typeof makeContactsRepo> } {
  const db = openDb(join(dir, `r${n++}.db`));
  return { chats: makeChatsRepo(db), contacts: makeContactsRepo(db) };
}

void test("a JID resolves without consulting the store at all", () => {
  const d = deps();
  assert.equal(resolveRecipient(ALICE, undefined, d), ALICE);
  assert.equal(resolveRecipient(GROUP, undefined, d), GROUP);
  // Device and agent suffixes are still normalized away, exactly as before this layer existed.
  assert.equal(resolveRecipient("33611111111:12@s.whatsapp.net", undefined, d), ALICE);
});

void test("a LID still folds onto the phone identity it is mapped to", () => {
  const d = deps();
  d.contacts.linkIdentity("5551234@lid", ALICE);
  assert.equal(resolveRecipient("5551234@lid", undefined, d), ALICE);
});

void test("a phone number written any of the usual ways becomes the same user JID", () => {
  const d = deps();
  for (const written of ["33611111111", "+33611111111", "+33 6 11 11 11 11", "(336) 111-11111"]) {
    assert.equal(resolveRecipient(written, undefined, d), ALICE, `"${written}" must resolve to ${ALICE}`);
  }
});

void test("a name with one match resolves to it, from either the chats or the contacts side", () => {
  const d = deps();
  d.chats.ensure(GROUP, true);
  d.chats.patch(GROUP, { name: "Les Copains" });
  // A contact with no chat: someone in the address book who has never been messaged from here.
  d.contacts.upsert({ id: ALICE, name: "Marie Dupont", phoneNumber: "33611111111" });

  assert.equal(resolveRecipient("Les Copains", undefined, d), GROUP);
  assert.equal(resolveRecipient("les copains", undefined, d), GROUP, "matching is case-insensitive");
  assert.equal(resolveRecipient("Marie Dupont", undefined, d), ALICE);
  assert.equal(resolveRecipient("Dupont", undefined, d), ALICE, "a substring is enough when it is unambiguous");
});

void test("a person who is both a chat and a contact is one candidate, not two", () => {
  const d = deps();
  d.chats.ensure(ALICE, false);
  d.chats.patch(ALICE, { name: "Marie" });
  d.contacts.upsert({ id: ALICE, name: "Marie", phoneNumber: "33611111111" });
  // Two rows, one human: if the dedupe were missing this would refuse as ambiguous between a chat
  // and a contact that are the same conversation — the most confusing possible refusal.
  assert.equal(resolveRecipient("Marie", undefined, d), ALICE);
});

void test("a contact known only by a LID resolves by name to that LID, unfolded", () => {
  const d = deps();
  const lid = "5551234@lid";
  d.contacts.upsert({ id: lid, name: "Marie", lid: "5551234" });
  // No mapping yet, so the LID *is* the identity — the same policy `canonicalId` applies to a JID a
  // caller passes in. Once `linkIdentity` runs, both repositories re-key onto the phone JID and the
  // name resolves there instead, which the test above covers.
  assert.equal(resolveRecipient("Marie", undefined, d), lid);
  d.contacts.linkIdentity(lid, ALICE);
  assert.equal(resolveRecipient("Marie", undefined, d), ALICE);
});

void test("an ambiguous name is refused, listing the candidates rather than guessing one", () => {
  const d = deps();
  d.contacts.upsert({ id: ALICE, name: "Marie Dupont", phoneNumber: "33611111111" });
  d.contacts.upsert({ id: ALICIA, name: "Marie Curie", phoneNumber: "33622222222" });

  const err = thrown(() => resolveRecipient("Marie", undefined, d));
  assert.ok(err instanceof AmbiguousRecipientError, `expected AmbiguousRecipientError, got ${err.name}`);
  assert.match(err.message, /matches 2/);
  assert.match(err.message, /Marie Curie/);
  assert.match(err.message, /Marie Dupont/);
  assert.match(err.message, /pick/, "the refusal has to say how to resolve it");
});

void test("pick chooses among the candidates, in the order the refusal numbered them", () => {
  const d = deps();
  d.contacts.upsert({ id: ALICE, name: "Marie Dupont", phoneNumber: "33611111111" });
  d.contacts.upsert({ id: ALICIA, name: "Marie Curie", phoneNumber: "33622222222" });

  // Sorted by label, so Curie is 1 and Dupont is 2 — and the refusal above prints that same order.
  assert.equal(resolveRecipient("Marie", 1, d), ALICIA);
  assert.equal(resolveRecipient("Marie", 2, d), ALICE);
});

void test("an exact name match wins over the longer names it is a prefix of", () => {
  const d = deps();
  d.contacts.upsert({ id: ALICE, name: "Marie", phoneNumber: "33611111111" });
  d.contacts.upsert({ id: ALICIA, name: "Marie-Claire", phoneNumber: "33622222222" });
  // Without this, having a "Marie-Claire" in the address book would make every "send to Marie"
  // ambiguous — which is the common case, not an edge one.
  assert.equal(resolveRecipient("Marie", undefined, d), ALICE);
  // But an exact match does not silently override an explicit pick.
  assert.equal(resolveRecipient("Marie", 2, d), ALICIA);
});

void test("two exact matches stay ambiguous — sameness of name is not a tie-break", () => {
  const d = deps();
  d.contacts.upsert({ id: ALICE, name: "Marie", phoneNumber: "33611111111" });
  d.contacts.upsert({ id: ALICIA, name: "Marie", phoneNumber: "33622222222" });
  assert.throws(() => resolveRecipient("Marie", undefined, d), AmbiguousRecipientError);
});

void test("a name nothing answers to is refused, and says where to look instead", () => {
  const d = deps();
  const err = thrown(() => resolveRecipient("Nobody", undefined, d));
  assert.ok(err instanceof RecipientNotFoundError, `expected RecipientNotFoundError, got ${err.name}`);
  assert.match(err.message, /wa_contacts_search/);
});

void test("an out-of-range pick is refused rather than clamped to the last candidate", () => {
  const d = deps();
  d.contacts.upsert({ id: ALICE, name: "Marie Dupont", phoneNumber: "33611111111" });
  d.contacts.upsert({ id: ALICIA, name: "Marie Curie", phoneNumber: "33622222222" });
  // Clamping would send to whoever happens to be last whenever the candidate list shrinks between
  // the refusal and the retry — i.e. silently, to the wrong person.
  const err = thrown(() => resolveRecipient("Marie", 9, d));
  assert.ok(err instanceof RecipientNotFoundError, `expected RecipientNotFoundError, got ${err.name}`);
  assert.match(err.message, /out of range/);
});

void test("pick alongside a JID is refused, because it cannot mean anything there", () => {
  const d = deps();
  assert.throws(() => resolveRecipient(ALICE, 2, d), /only applies when the recipient is named by name/);
});

void test("a short numeric nickname is a name, not a phone number", () => {
  const d = deps();
  d.chats.ensure(GROUP, true);
  d.chats.patch(GROUP, { name: "2024" });
  assert.equal(resolveRecipient("2024", undefined, d), GROUP);
});
