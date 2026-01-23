// src/agent/run.ts
import { ChatOllama } from "@langchain/ollama";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { z } from "zod";

import { Env, DEBUG } from "../env.js";
import { ShopifyTokenManager } from "../token.js";
import { makeCli, typewriterPrint } from "../cli/io.js";

import { createShopifyMcpClients } from "../shopify/mcp.js";
import { buildShopifyTools } from "../shopify/tools.js";

import { buildSearchTools } from "../search/tools.js";

import { createBrowserMcpClient } from "../browser/mcp.js";
import { buildBrowserTools } from "../browser/tools.js";

import { systemPrompt } from "./prompt.js";

function toolResultToString(x: unknown): string {
  if (typeof x === "string") return x;
  if (x && typeof x === "object" && "content" in x) {
    const c = (x as any).content;
    return typeof c === "string" ? c : JSON.stringify(c);
  }
  return JSON.stringify(x);
}

type ToolEntry = {
  parse?: (args: any) => any;
  invoke: (args: any) => Promise<any>;
};

function plannerPrompt() {
  return [
    "You are a tool planner for a local CLI shopping assistant.",
    "Decide which tools (if any) should be called BEFORE answering the user.",
    "",
    "Output ONLY valid JSON. No markdown. No extra text.",
    "",
    "Tools and required arguments:",
    "- web_search(args): { query: string, limit?: number (1-10), depth?: 'basic'|'advanced' }",
    "- shopify_search(args): { query: string, ships_to: string }",
    "- browser_read(args): { url: string }",
    "- browser_open(args): { url: string }",
    "",
    "Rules:",
    "- Plan at most 2 tool calls (0, 1, or 2).",
    "- Use tools only if they genuinely help.",
    "- If the user is asking for advice, comparisons, latest/recent info, or verification: web_search is often helpful.",
    "- If the user wants buyable options/prices/variants: shopify_search is helpful.",
    "- If the user provided a specific URL (or asked 'what does this page say'): browser_read is helpful.",
    "- If shopify_search is needed but ships_to is unknown, do NOT call it yet; instead plan 0 tools.",
    "",
    "IMPORTANT: Never plan transactional tools like checkout/opening checkout links. Planning is for information gathering only.",
    "",
    "Return JSON with this exact shape:",
    '{ "tool_calls": [ { "name": "tool_name", "args": { } } ], "rationale": "short reason" }',
  ].join("\n");
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

const PlannedCallSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.any()).default({}),
});

const PlanSchema = z.object({
  tool_calls: z.array(PlannedCallSchema).max(2).default([]),
  rationale: z.string().optional(),
});

function isShippingKnownFromText(userText: string): boolean {
  // Very lightweight: accepts common country codes or "us"/"usa"/"united states"
  const t = userText.trim().toLowerCase();
  if (t === "us" || t === "usa" || t.includes("united states")) return true;
  // If user wrote something like "I'm in FR/GB/CA/DE..." keep it permissive:
  if (/\b[a-z]{2}\b/i.test(userText)) return true;
  return false;
}

export async function runAgent() {
  // --- Shopify token manager ---
  const tokenMgr = new ShopifyTokenManager({
    cachePath: Env.TOKEN_CACHE_PATH,
    refreshSkewMs: 2 * 60 * 1000,
  });

  const CHAR_DELAY_MS = Number(process.env.OUTPUT_CHAR_DELAY_MS ?? "0");

  // --- MCP clients ---
  const { catalog } = await createShopifyMcpClients(tokenMgr);
  const browserClient = Env.BROWSER_MCP_URL ? await createBrowserMcpClient() : null;

  // --- Tools ---
  const shopify = buildShopifyTools({ catalog });
  const search = Env.TAVILY_API_KEY ? await buildSearchTools() : null;

  // Note: if your Browser MCP is streamable/202 Accepted, ensure browser/tools.ts
  // does NOT call tools/list. (You already fixed that.)
  const browser = browserClient ? await buildBrowserTools({ browser: browserClient }) : null;

  // --- Bind tools to main LLM ---
  const allTools = [
    ...Object.values(shopify.tools),
    ...(search ? Object.values(search.tools) : []),
    ...(browser ? Object.values(browser.tools) : []),
  ];

  const llm = new ChatOllama({
    baseUrl: Env.OLLAMA_URL,
    model: Env.OLLAMA_MODEL,
    temperature: 0.3,
  }).bindTools(allTools);

  // Planner LLM (no tools; JSON-only)
  const plannerLlm = new ChatOllama({
    baseUrl: Env.OLLAMA_URL,
    model: Env.OLLAMA_MODEL,
    temperature: 0.0,
  });

  // --- Tool registry ---
  const toolRegistry = new Map<string, ToolEntry>();

  // Shopify tools
  toolRegistry.set("shopify_search", {
    parse: (args) => shopify.schemas.ShopifySearchInput.parse(args),
    invoke: (args) => shopify.tools.shopify_search.invoke(args),
  });
  toolRegistry.set("adjust_checkout_quantity", {
    parse: (args) => shopify.schemas.CheckoutLinkInput.parse(args),
    invoke: (args) => shopify.tools.adjust_checkout_quantity.invoke(args),
  });
  toolRegistry.set("open_in_browser", {
    parse: (args) => shopify.schemas.OpenInBrowserInput.parse(args),
    invoke: (args) => shopify.tools.open_in_browser.invoke(args),
  });

  // Search tool
  if (search) {
    toolRegistry.set("web_search", {
      parse: (args) => search.schemas.WebSearchInput.parse(args),
      invoke: (args) => search.tools.web_search.invoke(args),
    });
  }

  // Browser tools
  if (browser) {
    toolRegistry.set("browser_read", {
      parse: (args) => browser.schemas.BrowserReadInput.parse(args),
      invoke: (args) => browser.tools.browser_read.invoke(args),
    });
    toolRegistry.set("browser_open", {
      parse: (args) => browser.schemas.BrowserOpenInput.parse(args),
      invoke: (args) => browser.tools.browser_open.invoke(args),
    });
  }

  // Planner allowlist: information-gathering tools only
  const plannerAllowed = new Set<string>([
    "web_search",
    "shopify_search",
    "browser_read",
    "browser_open",
  ]);

  const { ask } = makeCli();
  const messages: BaseMessage[] = [new SystemMessage(systemPrompt())];

  console.log("Local agent ready. Ask me anything.\n");

  while (true) {
    const user = await ask("> ");
    if (!user) continue;

    messages.push(new HumanMessage(user));

    // -------------------------
    // (A) Planner pass (model decides info-gathering tools)
    // -------------------------
    try {
      const planMsg = await plannerLlm.invoke([
        new SystemMessage(plannerPrompt()),
        new HumanMessage(user),
      ]);

      const planText =
        typeof planMsg.content === "string" ? planMsg.content : JSON.stringify(planMsg.content);

      const jsonText = extractJsonObject(planText);
      if (jsonText) {
        const parsed = PlanSchema.parse(JSON.parse(jsonText));

        // Filter: only known + allowed tools
        let planned = parsed.tool_calls
          .filter((c) => plannerAllowed.has(c.name))
          .filter((c) => toolRegistry.has(c.name))
          .slice(0, 2);

        // Extra guard: don’t allow shopify_search if shipping not known from conversation/user turn.
        // (Still model-driven; we just prevent an invalid call that will fail and waste a turn.)
        const shippingKnown = isShippingKnownFromText(user);
        planned = planned.filter((c) => {
          if (c.name !== "shopify_search") return true;
          return shippingKnown || typeof (c.args as any)?.ships_to === "string";
        });

        if (DEBUG) {
          console.log("[planner] raw:", planText.slice(0, 600));
          console.log(
            "[planner] parsed:",
            planned,
            parsed.rationale ? `rationale=${parsed.rationale}` : "",
          );
          console.log();
        }

        // Execute planned tools and inject results as SystemMessage context (no fake tool_calls -> no warning)
        for (const call of planned) {
          const entry = toolRegistry.get(call.name)!;
          let result: string;

          try {
            if (entry.parse) entry.parse(call.args);

            if (DEBUG) console.log("[planned tool] call:", call.name, "args:", call.args);

            const raw = await entry.invoke(call.args);
            result = toolResultToString(raw);

            if (DEBUG) {
              console.log("[planned tool] ok:", call.name);
              console.log("[planned tool] result head:", result.slice(0, 300));
              console.log();
            }
          } catch (e: any) {
            result = JSON.stringify({ ok: false, error: e?.message ?? String(e) });

            if (DEBUG) {
              console.log("[planned tool] fail:", call.name);
              console.log("[planned tool] error:", e?.message ?? String(e));
              console.log();
            }
          }

          // Give the main model clean, reliable context without relying on tool_call plumbing
          messages.push(
            new SystemMessage(
              `Context from planned tool "${call.name}" (JSON): ${result}`,
            ),
          );
        }
      } else if (DEBUG) {
        console.log("[planner] no JSON found in:", planText.slice(0, 300));
        console.log();
      }
    } catch (e: any) {
      // Planner failures should not block the chat
      if (DEBUG) {
        console.log("[planner] failed:", e?.message ?? String(e));
        console.log();
      }
    }

    // -------------------------
    // (B) Main tool-using loop
    // -------------------------
    const MAX_STEPS = 6;
    let finalText: string | null = null;

    for (let step = 0; step < MAX_STEPS; step++) {
      const ai = await llm.invoke(messages);

      const toolCalls = (ai as any).tool_calls as
        | Array<{ id: string; name: string; args: any }>
        | undefined;

      if (toolCalls && toolCalls.length > 0) {
        messages.push(ai);

        for (const call of toolCalls) {
          const entry = toolRegistry.get(call.name);

          let result: string;
          if (!entry) {
            result = JSON.stringify({ ok: false, error: `Unknown tool: ${call.name}` });
            if (DEBUG) console.log("[tool] unknown:", call.name, "args:", call.args);
          } else {
            try {
              if (entry.parse) entry.parse(call.args);

              if (DEBUG) console.log("[tool] call:", call.name, "args:", call.args);

              const raw = await entry.invoke(call.args);
              result = toolResultToString(raw);

              if (DEBUG) {
                console.log("[tool] ok:", call.name);
                console.log("[tool] result head:", result.slice(0, 300));
                console.log();
              }
            } catch (e: any) {
              result = JSON.stringify({ ok: false, error: e?.message ?? String(e) });
              if (DEBUG) {
                console.log("[tool] fail:", call.name);
                console.log("[tool] error:", e?.message ?? String(e));
                console.log();
              }
            }
          }

          messages.push(new ToolMessage({ content: result, tool_call_id: call.id }));
        }

        continue;
      }

      finalText = typeof ai.content === "string" ? ai.content : JSON.stringify(ai.content);
      messages.push(ai);
      break;
    }

    if (!finalText) finalText = "I got stuck. Can you rephrase what you want?";

    await typewriterPrint(finalText, CHAR_DELAY_MS);
  }
}
