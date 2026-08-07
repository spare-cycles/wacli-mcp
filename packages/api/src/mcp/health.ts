/**
 * The one health payload. `whatsapp_health` returns it and Task 14's `/health` route returns it, because
 * two hand-written health payloads drift within a week.
 *
 * `HealthReport` is a **closed record**, never a spread of `Config`. That is what keeps
 * `WHATSAPP_MCP_TOKEN` and `NTFY_TOKEN` out of an endpoint that is, by design, reachable without them
 * (Global Constraint 9): adding a config field can never widen this response by accident.
 */

import type { ConnectionState } from "../whatsapp/connection.js";
import type { ToolContext } from "./context.js";

export type HealthReport = {
  ok: boolean;
  connection: ConnectionState;
  needs_pairing: boolean;
  last_event_age_sec: number;
  last_connected_at: number | null;
  /** Unix seconds of the newest message in the store, or `null` if it holds none. */
  last_message_at: number | null;
  self_id: string | null;
  counts: { chats: number; messages: number; contacts: number };
  schema_version: number;
  transcription_available: boolean;
  /**
   * The background transcription lane, or `null` when the deployment does not run one.
   *
   * `null` rather than an all-zero object on purpose: "nothing queued" and "the feature is off" are
   * different answers, and only one of them means an empty queue is worth investigating. The budget
   * figures are here because a cap that has been hit is invisible from anywhere else — the tool
   * still works, and only the background lane has quietly stopped.
   */
  auto_transcribe: {
    enabled: boolean;
    queued: number;
    in_flight: number;
    transcribed_last_hour: number;
    budget_day: string;
    budget_spent_usd: number;
    budget_usd: number;
    budget_exhausted: boolean;
  } | null;
  read_only: boolean;
};

/**
 * `ok` is false **only** when the socket is logged out.
 *
 * A logged-out server is permanently dead until someone re-pairs it, and a health check that keeps
 * answering `ok: true` makes that look fine forever. Every other state — `disconnected` mid-backoff
 * included — is `ok: true`: the read tools genuinely still work, and a transient reconnect must not
 * flap the container's health.
 */
export async function buildHealth(ctx: ToolContext): Promise<HealthReport> {
  const snap = ctx.conn.snapshot();
  const nowSec = Math.floor(Date.now() / 1000);
  const auto = ctx.autoTranscriber?.snapshot();

  return {
    ok: snap.state !== "logged_out",
    connection: snap.state,
    needs_pairing: snap.needsPairing,
    // Clamped at zero: `lastEventAt` comes from the same clock, but a step backwards (NTP, a
    // suspended container) would otherwise report a negative age, which reads as a broken server.
    last_event_age_sec: Math.max(0, nowSec - snap.lastEventAt),
    last_connected_at: snap.lastConnectedAt,
    // The only field here that reports INGESTION rather than the socket's opinion of itself.
    // `last_event_age_sec` moves on `connection.update` and nothing else, so a socket that is
    // connected and receiving nothing is indistinguishable from a healthy quiet one without this —
    // which is precisely how a 44-hour outage went unnoticed on the retired stack. A watchdog
    // outside the process compares it against its own clock; nothing in here decides what is stale,
    // because "quiet" is a property of the conversation, not of the server.
    last_message_at: ctx.messages.newestTs(),
    self_id: snap.selfId,
    counts: { chats: ctx.chats.count(), messages: ctx.messages.count(), contacts: ctx.contacts.count() },
    schema_version: ctx.meta.schemaVersion(),
    transcription_available: await ctx.transcriber.available(),
    auto_transcribe:
      auto === undefined
        ? null
        : {
            enabled: auto.enabled,
            queued: auto.queued,
            in_flight: auto.inFlight,
            transcribed_last_hour: auto.transcribedLastHour,
            budget_day: auto.budget.day,
            budget_spent_usd: auto.budget.spentUsd,
            budget_usd: auto.budget.budgetUsd,
            budget_exhausted: auto.budget.exhausted,
          },
    read_only: ctx.config.readOnly,
  };
}
