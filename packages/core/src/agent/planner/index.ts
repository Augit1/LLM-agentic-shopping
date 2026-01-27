// packages/core/src/agent/planner/index.ts
import { ChatOllama } from "@langchain/ollama";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { PlanSchema, extractJsonObject, safeJsonParse, type Plan } from "./schema.js";

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
    "- Plan at most 3 tool calls.",
    "- Prefer at most ONE web_search (combine needs into one query).",
    "- Use tools only if they genuinely help.",
    "",
    "Grounding rules:",
    "- If the user is selecting among already-presented shop options, do NOT call web_search.",
    "- If the user wants to buy/checkout/open a checkout link for an already-presented option, plan 0 tools.",
    "- Use shopify_search when you need buyable options/prices/variants.",
    "- Use web_search for up-to-date advice ONLY outside selection/checkout flow.",
    "",
    "Exact-match rule (IMPORTANT):",
    "- If user asks for the EXACT same item as something in news/photos/speech (e.g., 'the exact glasses he wore'),",
    "  you MUST plan web_search first to identify the exact brand/model/name.",
    "  Then plan shopify_search using that exact model/name.",
    "  If a page URL is available and verification helps, plan browser_read on the most relevant page to confirm details.",
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
    "Example with 3 tools (VALID):",
    "{\"tool_calls\":[",
    "  {\"name\":\"web_search\",\"args\":{\"query\":\"exact brand/model of Macron glasses recent speech\",\"limit\":5,\"depth\":\"advanced\"}},",
    "  {\"name\":\"browser_read\",\"args\":{\"url\":\"https://example.com/article\"}},",
    "  {\"name\":\"shopify_search\",\"args\":{\"query\":\"Brand Model sunglasses\",\"ships_to\":\"US\"}}",
    "],\"rationale\":\"Need exact ID then buyable matches.\"}",
  ].join("\n");
}

function fixCommonPlannerJsonMistakes(jsonText: string): string {
  let t = jsonText;
  t = t.replace(/\}\s*,\s*"name"\s*:/g, "},{\"name\":");
  t = t.replace(/\]\s*,\s*"name"\s*:/g, ",{\"name\":");
  return t;
}

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
    "- Keep at most 3 tool calls.",
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

  const obj1 = safeJsonParse(jsonText);
  if (obj1) {
    try {
      return PlanSchema.parse(obj1);
    } catch {}
  }

  const fixed = fixCommonPlannerJsonMistakes(jsonText);
  const obj2 = safeJsonParse(fixed);
  if (obj2) {
    try {
      return PlanSchema.parse(obj2);
    } catch {}
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
