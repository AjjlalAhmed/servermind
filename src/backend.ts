// AI backend router. Picks the engine based on AI_BACKEND and forwards to it.
// Both backends share the same runChat signature + StreamEvent shape, so the
// rest of the app (routes, UI) is backend-agnostic.

import { getAI } from "./settings.ts";
import { runChat as runClaudeCode } from "./claude.ts";
import { runChat as runOpenAI } from "./ai/openai.ts";

export type { ChatMessage, StreamEvent, ChatOptions } from "./claude.ts";

export function runChat(...args: Parameters<typeof runClaudeCode>): Promise<void> {
  return getAI().backend === "openai" ? runOpenAI(...args) : runClaudeCode(...args);
}

export function backendLabel(): string {
  return getAI().backend === "openai" ? `openai (${getAI().model || "unconfigured"})` : "claude-code";
}
