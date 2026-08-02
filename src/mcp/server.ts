/**
 * The assembled MCP server: fourteen tools, or eight when the deployment is read-only.
 *
 * This is the single place tool registration happens, which is what makes the read-only gate a
 * property of the server rather than of each handler. A read-only server does not advertise
 * `whatsapp_send_text` and refuse it — it does not advertise it at all, so a model never plans around a
 * tool that cannot work.
 *
 * The media tools are registered in both modes deliberately. Neither one changes anything on
 * WhatsApp: `whatsapp_download_media` reads an attachment and `whatsapp_transcribe` writes a transcript into the
 * local store. `WHATSAPP_MCP_READONLY` is about not touching other people's conversations, not about never
 * writing a byte.
 *
 * It takes a fully-built `ToolContext` and constructs nothing: `main.ts` owns wiring, so a test can
 * build the same server over stubs by handing this function a context of its own.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../version.js";
import type { ToolContext } from "./context.js";
import { registerMediaTools } from "./tools/media.js";
import { registerReadTools } from "./tools/reads.js";
import { registerWriteTools } from "./tools/writes.js";

export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "whatsapp-mcp", version: VERSION });
  registerReadTools(server, ctx);
  registerMediaTools(server, ctx);
  if (!ctx.config.readOnly) registerWriteTools(server, ctx);
  return server;
}
