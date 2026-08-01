/**
 * The one health payload. `wa_health` returns it and Task 14's `/health` route returns it, because
 * two hand-written health payloads drift within a week.
 *
 * `HealthReport` is a **closed record**, never a spread of `Config`. That is what keeps
 * `WA_MCP_TOKEN` and `NTFY_TOKEN` out of an endpoint that is, by design, reachable without them
 * (Global Constraint 9): adding a config field can never widen this response by accident.
 */

import type { ConnectionState } from "../wa/connection.js";
import type { ToolContext } from "./context.js";

export type HealthReport = {
  ok: boolean;
  connection: ConnectionState;
  needs_pairing: boolean;
  last_event_age_sec: number;
  last_connected_at: number | null;
  self_id: string | null;
  counts: { chats: number; messages: number; contacts: number };
  schema_version: number;
  transcription_available: boolean;
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

  return {
    ok: snap.state !== "logged_out",
    connection: snap.state,
    needs_pairing: snap.needsPairing,
    // Clamped at zero: `lastEventAt` comes from the same clock, but a step backwards (NTP, a
    // suspended container) would otherwise report a negative age, which reads as a broken server.
    last_event_age_sec: Math.max(0, nowSec - snap.lastEventAt),
    last_connected_at: snap.lastConnectedAt,
    self_id: snap.selfId,
    counts: { chats: ctx.chats.count(), messages: ctx.messages.count(), contacts: ctx.contacts.count() },
    schema_version: ctx.meta.schemaVersion(),
    transcription_available: await ctx.transcriber.available(),
    read_only: ctx.config.readOnly,
  };
}
