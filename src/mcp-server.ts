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
import { TOOL_SPECS, dispatchTool, isMutatingCall } from "./tools/index.ts";
// Importing settings runs its load() (side effect) so the custom-tool registry
// is populated before we enumerate customToolSpecs() below.
import "./settings.ts";
import { customToolSpecs } from "./tools/custom.ts";

const server = new McpServer({ name: "servermind", version: "1.0.0" });

// Mutations are allowed only while the arm window (an absolute epoch passed by
// the parent) is still open AND no mutation has been consumed yet in this chat.
// Re-checking the epoch per call honours the 10-min TTL live; the single-use
// flag stops prompt injection from chaining several mutations in one chat.
let mutationConsumed = false;
function mutationsAllowed(): boolean {
  const until = Number(process.env.SERVERMIND_ARMED_UNTIL || "0");
  return !mutationConsumed && Date.now() < until;
}

// Built-in tools plus user-defined custom tools (read at startup; the CLI spawns
// a fresh subprocess per chat, so newly added tools appear without a restart).
for (const spec of [...TOOL_SPECS, ...customToolSpecs()]) {
  server.tool(spec.name, spec.description, spec.schema, async (input: Record<string, unknown>) => {
    const allowMutations = mutationsAllowed();
    const result = await dispatchTool(spec.name, input, { allowMutations });
    if (allowMutations && !result.isError && isMutatingCall(spec.name, input)) mutationConsumed = true;
    return {
      content: [{ type: "text", text: result.content }],
      isError: result.isError,
    };
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[servermind-mcp] ready over stdio");
