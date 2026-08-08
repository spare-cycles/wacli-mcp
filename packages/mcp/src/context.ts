/**
 * Everything a tool handler is allowed to reach: config, a logger, and the typed API client.
 *
 * Three fields, down from the thirteen the in-process server needed — and the collapse *is* the
 * split. There are no repositories here, no connection, no sender, no media store and no
 * transcriber, because none of those things exist in this process. A tool that needs data does not
 * grow a context field; it grows an SDK call (Global Constraint 12), and if the route it wants is
 * not in the table then the contract is what has to change, in one place, for both sides at once.
 *
 * Nothing may be added to this type. The temptation is a cache, a clock or a capabilities snapshot,
 * and each of those is state — the MCP is stateless by design, and per-session state belongs to the
 * `McpServer` the session was built with, not to a record every tool shares.
 *
 * It is a plain record on purpose. Tools receive it, they do not construct it: `main.ts` is the
 * single place the real client is wired, and every test builds the same shape over a fake.
 */

import type { Logger } from "pino";
import type { WhatsAppApiClient } from "whatsapp-api-sdk";

import type { McpConfig } from "./config.js";

export type ToolContext = { config: McpConfig; logger: Logger; client: WhatsAppApiClient };
