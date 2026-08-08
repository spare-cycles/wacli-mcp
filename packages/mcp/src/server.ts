/**
 * The assembled MCP server: fourteen tools, or eight when the API says the deployment is read-only.
 *
 * This is the single place tool registration happens, which is what makes the read-only gate a
 * property of the server rather than of each handler. A read-only server does not advertise
 * `whatsapp_send_text` and refuse it — it does not advertise it at all, so a model never plans
 * around a tool that cannot work.
 *
 * **The flag is the API's answer, not this process's configuration**, and that is the change the
 * split makes here. `WHATSAPP_MCP_READONLY` is gone; `GET /v1/capabilities` is asked once per
 * session, so flipping the API to read-only takes effect on the next client connect with no MCP
 * restart and no second copy of the setting to drift. It is a courtesy layered on the real gate:
 * the API refuses a write with `read_only` whether or not the tool was ever advertised.
 *
 * The media tools are registered in both modes deliberately. Neither one changes anything on
 * WhatsApp: `whatsapp_download_media` reads an attachment and `whatsapp_transcribe` writes a
 * transcript into the API's local store. Read-only is about not touching other people's
 * conversations, not about never writing a byte.
 *
 * It takes a fully-built `ToolContext` and constructs nothing but the server: `main.ts` owns
 * wiring, so a test can build the same server over a fake client by handing this a context of its
 * own — which is exactly what `tools/harness.ts` does.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONTRACT_VERSION, type Capabilities } from "whatsapp-api-sdk";

import type { ToolContext } from "./context.js";
import { registerMediaTools } from "./tools/media.js";
import { registerReadTools } from "./tools/reads.js";
import { registerWriteTools } from "./tools/writes.js";
import { VERSION } from "./version.js";

/**
 * The two builds do not speak the same contract.
 *
 * Its own class so the failure is greppable in a log stream and distinguishable from an API that
 * merely failed to answer. It is never rendered to a model: a session that cannot be built is a
 * failed `initialize`, which the client sees as a refused connection rather than as a tool result.
 */
export class ContractVersionError extends Error {
  override name = "ContractVersionError";
}

/**
 * Refuse a session against an API that speaks a different revision of the contract.
 *
 * Caught **once, at session build**, rather than as a pile of Zod parse errors at the boundary
 * later: a field that changed shape surfaces as "the API answered something `Message` cannot parse"
 * on whichever tool a model happened to call first, which is noise about fields nobody asked about.
 * One sentence naming both numbers is the whole diagnosis.
 *
 * The message names no URL. It does not need one — an operator reading this line knows which MCP
 * wrote it — and `WHATSAPP_API_URL` is a value this process is careful never to put into an error
 * (Global Constraint 8), so the safest way not to leak it is to have no site that could.
 */
export function requireContractMatch(caps: Capabilities): void {
  if (caps.contractVersion === CONTRACT_VERSION) return;
  throw new ContractVersionError(
    `contract version mismatch: this MCP was built against contract v${CONTRACT_VERSION} and the API answers ` +
      `v${caps.contractVersion}; the two images are deployed as a pair and must be upgraded together`,
  );
}

export function buildMcpServer(ctx: ToolContext, caps: Capabilities): McpServer {
  const server = new McpServer({ name: "whatsapp-mcp", version: VERSION });
  registerReadTools(server, ctx);
  registerMediaTools(server, ctx);
  if (!caps.readOnly) registerWriteTools(server, ctx);
  return server;
}

/**
 * One session: ask the API what it can do, check the two builds agree, and register accordingly.
 *
 * This is what `startHttp`'s `buildServer` is handed, and it is why that seam is async. A rejection
 * here opens no session and is answered as a failed initialize — which is the right outcome for
 * both of its causes. An unreachable API cannot be papered over by advertising fourteen tools that
 * will all fail; a version skew cannot be papered over at all.
 *
 * Asked per session rather than once at boot, deliberately. The MCP must start whether or not the
 * API is up — a container that refuses to boot because its backend is slow to come up is a
 * dependency-ordering problem dressed as a crash — and a capability answered at boot would be a
 * snapshot that goes stale the moment the API is redeployed.
 */
export async function buildSession(ctx: ToolContext): Promise<McpServer> {
  const caps = await ctx.client.capabilities();
  requireContractMatch(caps);
  ctx.logger.info(
    { readOnly: caps.readOnly, apiVersion: caps.apiVersion, contractVersion: caps.contractVersion },
    "mcp: building a session",
  );
  return buildMcpServer(ctx, caps);
}
