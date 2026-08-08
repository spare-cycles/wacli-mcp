/**
 * The two routes that describe the deployment rather than its contents.
 *
 * `/health` is the container healthcheck and `whatsapp_health`'s payload; `/v1/capabilities` is what
 * a client compares against at session build. Both are **closed records**, built field by field and
 * never a spread of `Config` — that is what keeps `WHATSAPP_API_TOKEN` and `NTFY_TOKEN` out of a
 * response that is, in `/health`'s case, reachable without either (Global Constraint 9). Adding a
 * config field can never widen one by accident.
 */

import { CONTRACT_VERSION, type Handlers } from "whatsapp-api-sdk";

import { buildHealth } from "../../mcp/health.js";
import { VERSION } from "../../version.js";
import type { RestDeps } from "../server.js";

/** The slice of the handler map this module owns. Tasks 8-10 own the other three. */
export type MetaHandlers = Pick<Handlers, "getHealth" | "capabilities">;

export function metaHandlers(deps: RestDeps): MetaHandlers {
  return {
    /**
     * Today's report, unchanged.
     *
     * `buildHealth` takes the in-process MCP's `ToolContext`, which `RestDeps` satisfies
     * structurally — deliberately, so the two surfaces cannot answer a healthcheck differently
     * while they run side by side. Task 16 moves the function when the MCP half goes.
     */
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
