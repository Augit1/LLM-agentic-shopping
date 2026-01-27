// src/agent/planner/context.ts
import type { BaseMessage } from "@langchain/core/messages";
import type { AgentSession } from "../session/state.js";
import { summarizeOptionsForPlanner } from "../session/shopifyState.js";

export function lastConversationSnippet(messages: BaseMessage[], maxChars = 900): string {
  const picked: string[] = [];
  for (let i = messages.length - 1; i >= 0 && picked.join("\n").length < maxChars; i--) {
    const m = messages[i] as any;
    const role = m?.getType?.() ?? m?._getType?.() ?? m?.type;
    if (role === "tool" || role === "system") continue;

    const content = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
    if (!content.trim()) continue;

    picked.push(`${String(role).toUpperCase()}: ${content}`);
    if (picked.length >= 6) break;
  }
  return picked.reverse().join("\n").slice(-maxChars);
}

export function buildPlannerContext(args: {
  session: AgentSession;
  messages: BaseMessage[];
}): string {
  const { session, messages } = args;

  return [
    "PLANNER CONTEXT:",
    `- Known ships_to: ${session.lastShipsTo ?? "(unknown)"}`,
    `- Last shopify query: ${session.lastShopifyQuery ?? "(none)"}`,
    "- Last shopify options (summary):",
    summarizeOptionsForPlanner(session.lastShopifyOptions),
    "",
    "Recent conversation (most recent last):",
    lastConversationSnippet(messages),
  ].join("\n");
}
