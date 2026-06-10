import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "server.ts"],
  env: { ...process.env, WACLI_BIN: process.env.WACLI_BIN },
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const doctor = await client.callTool({ name: "wacli_doctor", arguments: {} });
console.log("DOCTOR:", doctor.content[0].text.slice(0, 300));

const chats = await client.callTool({ name: "wacli_chats_list", arguments: { limit: 1 } });
console.log("CHATS:", chats.content[0].text.slice(0, 200));

await client.close();
console.log("SMOKE_OK");
