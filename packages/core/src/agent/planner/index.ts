// packages/core/src/agent/planner/index.ts
import { ChatOllama } from "@langchain/ollama";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { PlanSchema, extractJsonObject, safeJsonParse, type Plan } from "./schema.js";

/**
 * Planner prompt tuned to reduce malformed multi-call arrays.
 * Key changes:
 * - Explicitly defines that tool_calls is an ARRAY OF OBJECTS only.
 * - Adds a correct 2-tool-call example.
 * - Removes ambiguity that causes model to "continue" JSON with stray keys.
 */
export function plannerSystemPrompt(toolNames: string[]) {
  return [
    "You are a tool planner for a local CLI assistant.",
    "Decide which tools (if any) should be called BEFORE answering the user.",
    "",
    "You MUST output ONLY one valid JSON object. No markdown. No commentary. No extra keys.",
    "",
    "Available tools:",
    ...toolNames.map((t) => `- ${t}`),
    "",
    "Tool argument contracts:",
    "- web_search(args): { query: string, limit?: number (1-10), depth?: \"basic\"|\"advanced\" }",
    "- shopify_search(args): { query: string, ships_to: string (ISO 2-letter country code like US/ES/FR/GB) }",
    "- browser_read(args): { url: string }",
    "",
    "CRITICAL JSON RULES:",
    "- Quote ALL keys and ALL string values.",
    "- Do NOT use single quotes.",
    "- Do NOT include trailing commas.",
    "",
    "CRITICAL SHAPE RULE:",
    "- tool_calls MUST be an array of OBJECTS.",
    "- Each element MUST be exactly: {\"name\":\"...\",\"args\":{...}}",
    "- Never put \"name\" or \"args\" directly inside the array without braces.",
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
    "Return JSON with this EXACT shape:",
    "{\"tool_calls\":[{\"name\":\"tool_name\",\"args\":{}}],\"rationale\":\"short reason\"}",
    "",
    "Example with 0 tools:",
    "{\"tool_calls\":[],\"rationale\":\"No tools needed.\"}",
    "",
    "Example with 2 tools (VALID):",
    "{\"tool_calls\":[",
    "  {\"name\":\"web_search\",\"args\":{\"query\":\"best Russian novels\",\"limit\":5,\"depth\":\"basic\"}},",
    "  {\"name\":\"shopify_search\",\"args\":{\"query\":\"The Idiot French edition\",\"ships_to\":\"FR\"}}",
    "],\"rationale\":\"Need recommendations and buyable options.\"}",
  ].join("\n");
}

/**
 * Fix common malformed planner JSON where a tool_calls array element
 * is missing curly braces around {"name":...,"args":...}.
 *
 * Example broken:
 * {"tool_calls":[{"name":"web_search","args":{...}},"name":"shopify_search","args":{...}],"rationale":"..."}
 *
 * We try to convert:
 * ... }, "name": ...  -> ... }, {"name": ...
 */
function fixCommonPlannerJsonMistakes(jsonText: string): string {
  let t = jsonText;

  // 1) Missing object wrapper for 2nd tool call:
  // ... },"name":"shopify_search" ...  => ... },{"name":"shopify_search" ...
  // This is the exact pattern you showed.
  t = t.replace(/\}\s*,\s*"name"\s*:/g, "},{\"name\":");

  // 2) Sometimes it becomes: ... }], "name": ... (wrong nesting) after model glitches.
  // Try to fix: tool_calls:[{...}] , "name":"x" => tool_calls:[{...},{"name":"x"
  t = t.replace(/\]\s*,\s*"name"\s*:/g, ",{\"name\":");

  return t;
}

/**
 * Dedicated "repair bot" prompt: takes invalid JSON and returns valid JSON.
 * This is stronger than "your previous output was invalid JSON" because we feed the invalid output.
 */
async function repairPlanJsonWithLlm(args: {
  plannerLlm: ChatOllama;
  systemPrompt: string;
  context: string;
  user: string;
  invalidText: string;
}): Promise<string> {
  const { plannerLlm, systemPrompt, context, user, invalidText } = args;

  const repairSys = [
    "You are a JSON repair bot.",
    "You will be given INVALID JSON that was supposed to follow a required schema.",
    "Your job: output ONLY a single VALID JSON object that conforms exactly to the schema.",
    "",
    "Schema required:",
    "{\"tool_calls\":[{\"name\":\"tool_name\",\"args\":{}}],\"rationale\":\"string\"}",
    "",
    "Rules:",
    "- Output ONLY JSON. No markdown. No explanations.",
    "- Quote all keys and string values.",
    "- tool_calls must be an array of OBJECTS. Each object: {\"name\":\"...\",\"args\":{...}}",
    "- Keep tool names only from the available tools listed in the system prompt.",
    "- Keep at most 2 tool calls.",
  ].join("\n");

  const repairHuman = [
    "SYSTEM PROMPT (tools + rules):",
    systemPrompt,
    "",
    "CONTEXT:",
    context,
    "",
    "USER MESSAGE:",
    user,
    "",
    "INVALID JSON TO REPAIR:",
    invalidText,
  ].join("\n");

  const res = await plannerLlm.invoke([new SystemMessage(repairSys), new HumanMessage(repairHuman)]);
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
}

async function parsePlanFromText(text: string): Promise<Plan | null> {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;

  // First attempt: parse as-is
  const obj1 = safeJsonParse(jsonText);
  if (obj1) {
    try {
      return PlanSchema.parse(obj1);
    } catch {
      // fallthrough
    }
  }

  // Second attempt: apply heuristic fixer then parse
  const fixed = fixCommonPlannerJsonMistakes(jsonText);
  const obj2 = safeJsonParse(fixed);
  if (obj2) {
    try {
      return PlanSchema.parse(obj2);
    } catch {
      // fallthrough
    }
  }

  return null;
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
  const firstText = typeof first.content === "string" ? first.content : JSON.stringify(first.content);

  let plan = await parsePlanFromText(firstText);

  if (!plan) {
    // Repair attempt 1: strict "regenerate valid JSON" without showing invalid output
    const regen = await plannerLlm.invoke([
      new SystemMessage(systemPrompt),
      new SystemMessage(context),
      new SystemMessage(
        "Your previous output was invalid JSON. Output ONLY valid JSON in the required shape. " +
          "tool_calls must be an array of objects. Quote all keys and all string values."
      ),
      new HumanMessage(user),
    ]);
    const regenText = typeof regen.content === "string" ? regen.content : JSON.stringify(regen.content);

    plan = await parsePlanFromText(regenText);

    // Repair attempt 2 (best): show the invalid JSON and ask a repair-bot to fix it
    if (!plan) {
      const repairedText = await repairPlanJsonWithLlm({
        plannerLlm,
        systemPrompt,
        context,
        user,
        invalidText: regenText || firstText,
      });

      plan = await parsePlanFromText(repairedText);

      if (debug && !plan) {
        console.log("[planner] invalid JSON (after repair bot). raw head:", repairedText.slice(0, 400));
      }
    } else if (debug) {
      console.log("[planner] recovered with regen repair.");
    }
  }

  if (debug && plan) {
    console.log("[planner] plan:", plan);
  }

  return plan;
}
