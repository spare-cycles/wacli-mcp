/**
 * What transcription has cost today, and the hard stop that follows from it.
 *
 * **RunPod bills worker wall time, and a job's response cannot see most of it.** The `infer_s` a
 * worker reports is the model's time alone: it excludes the cold start that preceded it and the
 * whole idle tail that follows, and the idle tail is what dominates the steady state — thirty
 * isolated voice notes a day at a 120 s idle timeout is an hour of billed GPU whether each one took
 * six seconds or sixty. A ledger built on `infer_s` would report a few cents while the console
 * reported eighty dollars a month.
 *
 * So this charges, per job:
 *
 *     spend += (t_complete − t_submit) × pricePerSecond          // the client's own wall time
 *            + idleTimeoutSeconds × pricePerSecond               // once per cold burst
 *
 * where a **cold burst** is a job submitted with no other job completed within `idleTimeout` before
 * it — the condition under which RunPod has to spin a worker up, and under which the tail after it
 * is genuinely ours. Clustered notes share one tail and are charged one.
 *
 * **This deliberately over-counts**, in three ways at once: client wall time includes network and
 * queueing the worker was not billed for, the full idle timeout is charged even when the next job
 * arrives before it expires, and nothing here nets off the workers another client kept warm. That
 * is the correct direction for a spending cap. If the console ever reads *higher* than the ledger,
 * something is wrong with the model of the world above — not with the arithmetic.
 *
 * ⚠️ **The cap bounds this client's spend, not the endpoint's.** The endpoint is multi-consumer by
 * design (`workers_max: 3`), so no single client can see the total. Endpoint-wide spend is watched
 * in the RunPod console; this is a per-client guard rail.
 */

import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { MetaRepo } from "../db/meta.js";

/** The `meta` key the ledger lives under. One row, rewritten in place. */
const META_KEY = "transcribe.budget";

type LedgerState = {
  /** UTC date, `YYYY-MM-DD`. Rolls the ledger over. */
  day: string;
  spentUsd: number;
  /** When the last job completed, so the next one can be classified cold or warm. */
  lastCompletedAtMs: number | null;
  /** Whether the breach has already been announced today; the notice is worth sending once. */
  alerted: boolean;
};

export type JobTiming = { submittedAtMs: number; completedAtMs: number };

export type BudgetLedger = {
  /** Charge one completed RunPod job. Never throws — a ledger failure must not fail a transcript. */
  record: (timing: JobTiming) => void;
  /** True once today's charges have reached the cap. */
  exhausted: () => boolean;
  spentUsd: () => number;
  /** Everything the health payload and the runbook want to see at once. */
  snapshot: () => { day: string; spentUsd: number; budgetUsd: number; exhausted: boolean };
};

export type BudgetDeps = {
  config: Config;
  meta: MetaRepo;
  logger: Logger;
  /**
   * Published when the cap is first breached in a day. Optional so a test — and a deployment with
   * no ntfy configured — can run without one.
   */
  notify?: ((title: string, message: string) => void) | undefined;
  /** Seam: tests need a clock they can move. */
  now?: (() => number) | undefined;
};

/**
 * The UTC date of an instant.
 *
 * UTC rather than local time, and it matters: the container runs UTC, and a ledger that rolled over
 * at local midnight would disagree with the RunPod console's own daily figures by however many
 * hours the offset happens to be — which is exactly the comparison the runbook asks an operator to
 * make.
 */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseState(raw: string | undefined, day: string): LedgerState {
  const fresh: LedgerState = { day, spentUsd: 0, lastCompletedAtMs: null, alerted: false };
  if (raw === undefined) return fresh;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return fresh;
    const state = parsed as Partial<LedgerState>;
    // A ledger from another day is not this day's spend. Rolling over here rather than on a timer
    // means a pod that was down over midnight comes back with a clean day, which is what the cap
    // means, instead of resuming a stale total.
    if (state.day !== day) return fresh;
    return {
      day,
      spentUsd: typeof state.spentUsd === "number" && Number.isFinite(state.spentUsd) ? state.spentUsd : 0,
      lastCompletedAtMs: typeof state.lastCompletedAtMs === "number" ? state.lastCompletedAtMs : null,
      alerted: state.alerted === true,
    };
  } catch {
    // A corrupt ledger reads as a fresh day rather than as an exhausted budget. Failing open is the
    // right way round: the rate ceiling and the recency window still bound the damage, whereas
    // failing closed would silently stop auto-transcription with no error anywhere.
    return fresh;
  }
}

export function makeBudgetLedger(deps: BudgetDeps): BudgetLedger {
  const { config, meta, logger } = deps;
  const now = deps.now ?? Date.now;
  const budgetUsd = config.autoTranscribe.dailyBudgetUsd;
  const idleTimeoutMs = config.runpodIdleTimeoutSeconds * 1000;

  /** Always re-read: the ledger is small, and holding it in memory would lose a concurrent write. */
  function read(): LedgerState {
    return parseState(meta.get(META_KEY), utcDay(now()));
  }

  function write(state: LedgerState): void {
    meta.set(META_KEY, JSON.stringify(state));
  }

  function record(timing: JobTiming): void {
    try {
      const state = read();
      const wallSeconds = Math.max(0, (timing.completedAtMs - timing.submittedAtMs) / 1000);
      // A burst is cold when nothing completed inside the idle window before it was submitted —
      // exactly when RunPod had to start a worker, and so exactly when the tail after it is ours.
      const cold = state.lastCompletedAtMs === null || timing.submittedAtMs - state.lastCompletedAtMs > idleTimeoutMs;
      const charge =
        wallSeconds * config.runpodPricePerSecond +
        (cold ? config.runpodIdleTimeoutSeconds * config.runpodPricePerSecond : 0);

      const next: LedgerState = {
        ...state,
        spentUsd: state.spentUsd + charge,
        lastCompletedAtMs: timing.completedAtMs,
      };

      if (!next.alerted && budgetUsd > 0 && next.spentUsd >= budgetUsd) {
        next.alerted = true;
        logger.warn({ spentUsd: next.spentUsd, budgetUsd }, "transcribe: the daily budget is spent");
        deps.notify?.(
          "Transcription budget spent",
          `whatsapp-mcp has charged $${next.spentUsd.toFixed(2)} of its $${budgetUsd.toFixed(2)} daily ` +
            "transcription budget. Background transcription is stopped until UTC midnight; " +
            "whatsapp_transcribe still works on demand.",
        );
      }

      write(next);
      logger.debug({ charge, cold, wallSeconds, spentUsd: next.spentUsd }, "transcribe: charged a job");
    } catch (err) {
      // Never fatal. The transcript is already produced and stored; losing the accounting for one
      // job is strictly better than throwing it away over bookkeeping.
      logger.warn({ err }, "transcribe: could not record a job against the budget");
    }
  }

  function spentUsd(): number {
    return read().spentUsd;
  }

  function exhausted(): boolean {
    // A budget of zero is a deliberate "stop the background lane entirely", which is what the
    // rollout's verification step sets it to. It is not "unlimited".
    return read().spentUsd >= budgetUsd;
  }

  function snapshot(): { day: string; spentUsd: number; budgetUsd: number; exhausted: boolean } {
    const state = read();
    return {
      day: state.day,
      spentUsd: Number(state.spentUsd.toFixed(4)),
      budgetUsd,
      exhausted: state.spentUsd >= budgetUsd,
    };
  }

  return { record, exhausted, spentUsd, snapshot };
}
