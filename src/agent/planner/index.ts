// src/agent/planner/index.ts
import { ChatOllama } from "@langchain/ollama";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { PlanSchema, extractJsonObject, safeJsonParse, type Plan } from "./schema.js";

export function plannerSystemPrompt(toolNames: string[]) {
  return [
    "You are a tool planner for a local CLI assistant.",
    "Decide which tools (if any) should be called BEFORE answering the user.",
    "",
    "Output ONLY valid JSON. No markdown. No extra text.",
    "",
    "Available tools:",
    ...toolNames.map((t) => `- ${t}`),
    "",
    "Tool argument contracts:",
    "- web_search(args): { query: string, limit?: number (1-10), depth?: \"basic\"|\"advanced\" }",
    "- shopify_search(args): { query: string, ships_to: string (ISO 2-letter country code like US/ES/FR/GB) }",
    "- browser_read(args): { url: string }",
    "",
    "CRITICAL JSON RULES (must follow):",
    "- Quote ALL keys and ALL string values.",
    "- Do NOT use single quotes.",
    "- Example valid args: {\"query\":\"...\",\"limit\":3,\"depth\":\"advanced\"}",
    "- Example INVALID args: { query: \"...\", limit: 3, depth: advanced }",
    "",
    "Rules:",
    "- Plan at most 2 tool calls.",
    "- Prefer at most ONE web_search (combine needs into one query).",
    "- Use tools only if they genuinely help.",
    "",
    "Grounding rules:",
    "- If the user is selecting among already-presented shop options, do NOT call web_search.",
    "- If the user wants to buy/checkout/open a checkout link for an already-presented option, plan 0 tools.",
    "- Use shopify_search when you need buyable options/prices/variants.",
    "- Use web_search for up-to-date advice ONLY outside selection/checkout flow.",
    "",
    "Browser tool rule:",
    "- browser_read is ONLY for reading page text (summarize/analyze). Never use it to open a checkout/cart link.",
    "",
    "Return JSON with this exact shape:",
    "{\"tool_calls\":[{\"name\":\"tool_name\",\"args\":{}}],\"rationale\":\"short reason\"}",
  ].join("\n");
}

async function parsePlanFromText(text: string): Promise<Plan | null> {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;
  const obj = safeJsonParse(jsonText);
  if (!obj) return null;
  return PlanSchema.parse(obj);
}

export async function getPlanWithRepair(args: {
  plannerLlm: ChatOllama;
  systemPrompt: string;
  context: string;
  user: string;
  debug?: boolean;
}): Promise<Plan | null> {
  const { plannerLlm, systemPrompt, context, user, debug } = args;

  const first = await plannerLlm.invoke([
    new SystemMessage(systemPrompt),
    new SystemMessage(context),
    new HumanMessage(user),
  ]);
  const firstText =
    typeof first.content === "string" ? first.content : JSON.stringify(first.content);

  let plan = await parsePlanFromText(firstText);

  if (!plan) {
    const repair = await plannerLlm.invoke([
      new SystemMessage(systemPrompt),
      new SystemMessage(context),
      new SystemMessage(
        "Your previous output was invalid JSON. Output ONLY valid JSON in the required shape. Quote all keys and all string values."
      ),
      new HumanMessage(user),
    ]);
    const repairText =
      typeof repair.content === "string" ? repair.content : JSON.stringify(repair.content);

    plan = await parsePlanFromText(repairText);

    if (debug && !plan) {
      console.log("[planner] invalid JSON (after repair). raw head:", repairText.slice(0, 250));
    }
  }

  if (debug && plan) {
    console.log("[planner] plan:", plan);
  }

  return plan;
}
