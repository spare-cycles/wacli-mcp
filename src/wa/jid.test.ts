import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  canonicalId,
  isGroupJid,
  isLidJid,
  isUserJid,
  jidKind,
  lidFromJid,
  normalizeJid,
  phoneFromJid,
  userJid,
} from "./jid.js";

void test("classifies each server", () => {
  assert.equal(jidKind("33612345678@s.whatsapp.net"), "user");
  assert.equal(jidKind("123456789@lid"), "lid");
  assert.equal(jidKind("120363000000000000@g.us"), "group");
  assert.equal(jidKind("status@broadcast"), "broadcast");
  assert.equal(jidKind("abc@newsletter"), "newsletter");
  assert.equal(jidKind("nonsense"), "unknown");
  assert.equal(jidKind(""), "unknown");
});

void test("predicates agree with jidKind", () => {
  assert.equal(isUserJid("33612345678@s.whatsapp.net"), true);
  assert.equal(isUserJid("123@lid"), false);
  assert.equal(isLidJid("123@lid"), true);
  assert.equal(isGroupJid("120363@g.us"), true);
  assert.equal(isGroupJid("33612345678@s.whatsapp.net"), false);
});

void test("normalize strips device and agent suffixes", () => {
  assert.equal(normalizeJid("33612345678:12@s.whatsapp.net"), "33612345678@s.whatsapp.net");
  assert.equal(normalizeJid("33612345678_1:5@s.whatsapp.net"), "33612345678@s.whatsapp.net");
  assert.equal(normalizeJid("123456:3@lid"), "123456@lid");
  assert.equal(normalizeJid("33612345678@S.WHATSAPP.NET"), "33612345678@s.whatsapp.net");
  assert.equal(normalizeJid("120363@g.us"), "120363@g.us");
});

void test("normalize is idempotent", () => {
  for (const j of ["33612345678:12@s.whatsapp.net", "1@lid", "120363@g.us", "status@broadcast", "junk"]) {
    assert.equal(normalizeJid(normalizeJid(j)), normalizeJid(j), j);
  }
});

void test("local-part extractors only fire on the right server", () => {
  assert.equal(phoneFromJid("33612345678@s.whatsapp.net"), "33612345678");
  assert.equal(phoneFromJid("33612345678:9@s.whatsapp.net"), "33612345678");
  assert.equal(phoneFromJid("123@lid"), undefined);
  assert.equal(lidFromJid("123@lid"), "123");
  assert.equal(lidFromJid("33612345678@s.whatsapp.net"), undefined);
  assert.equal(userJid("33612345678"), "33612345678@s.whatsapp.net");
});

void test("canonicalId resolves a LID to its phone JID when the mapping is known", () => {
  const lookup = { pnForLid: (lid: string) => (lid === "999" ? "33612345678@s.whatsapp.net" : undefined) };
  assert.equal(canonicalId("999@lid", lookup), "33612345678@s.whatsapp.net");
  assert.equal(canonicalId("999:4@lid", lookup), "33612345678@s.whatsapp.net");
});

void test("canonicalId keeps an unmapped LID as a LID", () => {
  const lookup = { pnForLid: () => undefined };
  assert.equal(canonicalId("999@lid", lookup), "999@lid");
  assert.equal(canonicalId("999@lid"), "999@lid");
});

void test("canonicalId never rewrites a group, broadcast or user jid", () => {
  const lookup = { pnForLid: () => "33612345678@s.whatsapp.net" };
  assert.equal(canonicalId("120363@g.us", lookup), "120363@g.us");
  assert.equal(canonicalId("status@broadcast", lookup), "status@broadcast");
  assert.equal(canonicalId("33699999999@s.whatsapp.net", lookup), "33699999999@s.whatsapp.net");
});

void test("canonicalId is idempotent and normalizes on the way", () => {
  const lookup = { pnForLid: (l: string) => (l === "999" ? "33612345678@s.whatsapp.net" : undefined) };
  const once = canonicalId("999:4@lid", lookup);
  assert.equal(canonicalId(once, lookup), once);
  assert.equal(canonicalId("120363:2@g.us", lookup), "120363@g.us");
});
