// ServerMind MCP server (stdio).
//
// The `claude` CLI launches this as a subprocess and talks to it over stdio.
// It exposes ServerMind's safe, whitelisted tools as MCP tools named
// `mcp__servermind__<tool>`. All validation lives in the tool implementations,
// so even with permissions skipped Claude can only do what these tools allow.
//
// IMPORTANT: nothing may be written to stdout except the MCP protocol — stray
// console.log() would corrupt the stream. Diagnostics go to stderr only.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOL_SPECS, dispatchTool } from "./tools/index.ts";

const server = new McpServer({ name: "servermind", version: "1.0.0" });

for (const spec of TOOL_SPECS) {
  server.tool(spec.name, spec.description, spec.schema, async (input: Record<string, unknown>) => {
    const result = await dispatchTool(spec.name, input, {
      allowMutations: process.env.SERVERMIND_ALLOW_MUTATIONS === "1",
    });
    return {
      content: [{ type: "text", text: result.content }],
      isError: result.isError,
    };
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[servermind-mcp] ready over stdio");
