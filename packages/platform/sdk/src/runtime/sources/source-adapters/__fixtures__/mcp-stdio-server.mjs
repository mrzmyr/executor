import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const server = new McpServer(
  { name: "mcp-stdio-test-server", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

server.registerTool(
  "echo_stdio",
  {
    title: "Echo Stdio",
    description: "Echo a value over stdio",
    inputSchema: {
      value: z.string(),
    },
  },
  async ({ value }) => ({
    content: [{ type: "text", text: "stdio:" + value }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
setInterval(() => {}, 1 << 30);
