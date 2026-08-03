/**
 * The ledger, and specifically the two things about it that are easy to get quietly wrong:
 * the cold-burst charge, and surviving a restart.
 *
 * Both matter because the failure mode is silent. A ledger that under-counts reports a few cents
 * while the RunPod console reports eighty dollars a month, and a ledger that forgets its total on
 * restart turns a cap into a suggestion — every crash resets it, and a crash loop removes it
 * entirely.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, type Config } from "../config.js";
import { closeDb, openDb } from "../db/client.js";
import { makeMetaRepo, type MetaRepo } from "../db/meta.js";
import { silentLogger } from "../logger.js";
import { makeBudgetLedger, utcDay } from "./budget.js";

/** Round numbers, so a charge can be reasoned about rather than merely asserted to be non-zero. */
const PRICE = "0.001";
const IDLE = "100";

function configWith(env: Record<string, string> = {}): Config {
  return loadConfig({
    RUNPOD_PRICE_PER_SECOND: PRICE,
    RUNPOD_IDLE_TIMEOUT_SECONDS: IDLE,
    WHATSAPP_AUTOTRANSCRIBE_DAILY_BUDGET_USD: "1",
    ...env,
  });
}

/** An in-memory `meta` table, which is all the ledger touches. */
function memoryMeta(): { meta: MetaRepo; close: () => void } {
  const db = openDb(":memory:");
  return {
    meta: makeMetaRepo(db),
    close: () => {
      closeDb(db);
    },
  };
}

void test("a cold burst is charged the whole idle tail on top of its own wall time", (t) => {
  const { meta, close } = memoryMeta();
  t.after(close);
  const now = Date.parse("2026-08-03T10:00:00Z");
  const ledger = makeBudgetLedger({ config: configWith(), meta, logger: silentLogger(), now: () => now });

  // 10 s of wall time, with nothing completed before it, so RunPod had to start a worker.
  ledger.record({ submittedAtMs: now, completedAtMs: now + 10_000 });

  // 10 s × $0.001 = $0.01, plus 100 s of idle tail × $0.001 = $0.10. The tail dominates, which is
  // the entire point: `infer_s` would have reported the $0.01 and missed the rest.
  assert.equal(Number(ledger.spentUsd().toFixed(4)), 0.11);
});

void test("a job inside the idle window shares the tail rather than paying for a second one", (t) => {
  const { meta, close } = memoryMeta();
  t.after(close);
  const now = Date.parse("2026-08-03T10:00:00Z");
  const ledger = makeBudgetLedger({ config: configWith(), meta, logger: silentLogger(), now: () => now });

  ledger.record({ submittedAtMs: now, completedAtMs: now + 10_000 });
  // Submitted 50 s after the first completed, well inside the 100 s idle timeout: the worker was
  // still up, so no new tail is ours.
  ledger.record({ submittedAtMs: now + 60_000, completedAtMs: now + 70_000 });

  // $0.11 + $0.01, not $0.22. Clustered notes really do cost far less than isolated ones.
  assert.equal(Number(ledger.spentUsd().toFixed(4)), 0.12);
});

void test("a job past the idle window is a fresh cold burst", (t) => {
  const { meta, close } = memoryMeta();
  t.after(close);
  const now = Date.parse("2026-08-03T10:00:00Z");
  const ledger = makeBudgetLedger({ config: configWith(), meta, logger: silentLogger(), now: () => now });

  ledger.record({ submittedAtMs: now, completedAtMs: now + 10_000 });
  // 200 s after the first completed — the worker has long since scaled away.
  ledger.record({ submittedAtMs: now + 210_000, completedAtMs: now + 220_000 });

  assert.equal(Number(ledger.spentUsd().toFixed(4)), 0.22);
});

void test("🔴 the ledger survives a restart", (t) => {
  // The cap is meaningless if a crash resets it, and a crash loop would remove it entirely.
  const { meta, close } = memoryMeta();
  t.after(close);
  const now = Date.parse("2026-08-03T10:00:00Z");
  const deps = { config: configWith(), meta, logger: silentLogger(), now: () => now };

  makeBudgetLedger(deps).record({ submittedAtMs: now, completedAtMs: now + 900_000 });
  // A whole new ledger over the same store, exactly as a restarted process builds.
  const after = makeBudgetLedger(deps);

  assert.ok(after.exhausted(), `spent ${after.spentUsd()}`);
});

void test("the ledger rolls over at UTC midnight, not local midnight", (t) => {
  const { meta, close } = memoryMeta();
  t.after(close);
  let now = Date.parse("2026-08-03T23:59:00Z");
  const ledger = makeBudgetLedger({ config: configWith(), meta, logger: silentLogger(), now: () => now });

  ledger.record({ submittedAtMs: now, completedAtMs: now + 900_000 });
  assert.ok(ledger.exhausted());

  now = Date.parse("2026-08-04T00:01:00Z");
  // UTC on purpose: the container runs UTC and the runbook asks an operator to compare this against
  // the RunPod console's own daily figures, which would be off by the local offset otherwise.
  assert.equal(ledger.snapshot().day, "2026-08-04");
  assert.equal(ledger.spentUsd(), 0);
  assert.ok(!ledger.exhausted());
});

void test("the breach notice fires once, not on every job after it", (t) => {
  const { meta, close } = memoryMeta();
  t.after(close);
  const now = Date.parse("2026-08-03T10:00:00Z");
  const notices: string[] = [];
  const ledger = makeBudgetLedger({
    config: configWith(),
    meta,
    logger: silentLogger(),
    now: () => now,
    notify: (title) => notices.push(title),
  });

  for (let i = 0; i < 5; i += 1) ledger.record({ submittedAtMs: now, completedAtMs: now + 900_000 });

  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /budget/i);
});

void test("a corrupt ledger reads as a fresh day rather than as an exhausted budget", (t) => {
  const { meta, close } = memoryMeta();
  t.after(close);
  meta.set("transcribe.budget", "{not json at all");
  const ledger = makeBudgetLedger({ config: configWith(), meta, logger: silentLogger() });

  // Failing open is the right way round: the rate ceiling, the recency window and the duration gate
  // all still bound the damage, whereas failing closed would silently stop background transcription
  // with no error anywhere for someone to find.
  assert.equal(ledger.spentUsd(), 0);
  assert.ok(!ledger.exhausted());
});

void test("a zero budget means stop, not unlimited", (t) => {
  const { meta, close } = memoryMeta();
  t.after(close);
  // What the rollout's verification step sets, to prove the hard stop works before trusting it.
  const ledger = makeBudgetLedger({
    config: configWith({ WHATSAPP_AUTOTRANSCRIBE_DAILY_BUDGET_USD: "0" }),
    meta,
    logger: silentLogger(),
  });
  assert.ok(ledger.exhausted());
});

void test("utcDay is the calendar date of an instant in UTC", () => {
  assert.equal(utcDay(Date.parse("2026-08-03T23:59:59Z")), "2026-08-03");
  assert.equal(utcDay(Date.parse("2026-08-04T00:00:00Z")), "2026-08-04");
});
