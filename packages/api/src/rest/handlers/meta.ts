/**
 * The two routes that describe the deployment rather than its contents.
 *
 * `/health` is the container healthcheck; `/v1/capabilities` is what a client compares against at
 * session build. Both are **closed records**, built field by field and never a spread of `Config` —
 * that is what keeps `WHATSAPP_API_TOKEN` and `NTFY_TOKEN` out of a response that is, in `/health`'s
 * case, reachable without either (Global Constraint 9). Adding a config field can never widen one by
 * accident: the return type is the SDK's, so a field the contract does not declare is a compile
 * error here rather than a secret on the wire.
 */

import { CONTRACT_VERSION, type Handlers, type HealthReport } from "whatsapp-api-sdk";

import { VERSION } from "../../version.js";
import type { RestDeps } from "../server.js";

/** The slice of the handler map this module owns. Tasks 8-10 own the other three. */
export type MetaHandlers = Pick<Handlers, "getHealth" | "capabilities">;

/**
 * `ok` is false **only** when the socket is logged out.
 *
 * A logged-out server is permanently dead until someone re-pairs it, and a health check that keeps
 * answering `ok: true` makes that look fine forever. Every other state — `disconnected` mid-backoff
 * included — is `ok: true`: the read routes genuinely still work, and a transient reconnect must not
 * flap the container's health.
 */
async function buildHealth(deps: RestDeps): Promise<HealthReport> {
  const snap = deps.conn.snapshot();
  const nowSec = Math.floor(Date.now() / 1000);
  const auto = deps.autoTranscriber?.snapshot();

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
    last_message_at: deps.messages.newestTs(),
    self_id: snap.selfId,
    counts: { chats: deps.chats.count(), messages: deps.messages.count(), contacts: deps.contacts.count() },
    schema_version: deps.meta.schemaVersion(),
    transcription_available: await deps.transcriber.available(),
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
    read_only: deps.config.readOnly,
  };
}

export function metaHandlers(deps: RestDeps): MetaHandlers {
  return {
    getHealth: () => buildHealth(deps),

    capabilities: async () => ({
      apiVersion: VERSION,
      // The SDK's own number, not a copy: both images publish the value they were built against and
      // a mismatch is caught once, at session build, instead of as a pile of parse errors later.
      contractVersion: CONTRACT_VERSION,
      readOnly: deps.config.readOnly,
      // Reported so a client can refuse an oversized upload against the API's real limit rather
      // than a second copy of the number that can drift out of step with it.
      maxUploadBytes: deps.config.maxUploadBytes,
      features: {
        // A probe, TTL-cached by the transcriber, and the same one `/health` reports — a capability
        // that disagreed with the health report about the same fact would be worse than neither.
        transcription: await deps.transcriber.available(),
        // The lane's own opinion of itself, not `config.autoTranscribe.enabled`: a deployment that
        // configured it but wired no transcriber runs no lane, and `/health` says so too.
        autoTranscribe: deps.autoTranscriber?.snapshot().enabled ?? false,
        // The signer is not optional on `RestDeps`, so a link can always be minted.
        mediaLinks: true,
      },
    }),
  };
}
