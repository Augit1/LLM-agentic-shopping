// src/agent/run.ts
import { ChatOllama } from "@langchain/ollama";
import {
  HumanMessage,
  ToolMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { Env, DEBUG } from "../env.js";
import { ShopifyTokenManager } from "../token.js";
import { makeCli, typewriterPrint } from "../cli/io.js";

import { createShopifyMcpClients } from "../shopify/mcp.js";
import { buildShopifyTools } from "../shopify/tools.js";
import { buildSearchTools } from "../search/tools.js";
import { createBrowserMcpClient } from "../browser/mcp.js";
import { buildBrowserTools } from "../browser/tools.js";

import { systemPrompt } from "./prompt.js";

import { session } from "./session/state.js";
import { updateSessionFromShopifyResult } from "./session/shopifyState.js";

import { parseOptionChoice, parseQuantity } from "./intent/parse.js";

import { toolResultToString } from "./tools/result.js";
import type { ToolEntry } from "./tools/registry.js";

import { buildPlannerContext } from "./planner/context.js";
import { getPlanWithRepair, plannerSystemPrompt } from "./planner/index.js";

import { tryAutoCheckout } from "./checkout/autoCheckout.js";
import { isBuyIntentModel } from "./intent/buyIntentModel.js";

function isLikelyCheckoutUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // Very common shopify checkout/cart patterns
    const path = u.pathname.toLowerCase();
    const qs = u.search.toLowerCase();
    return (
      path.includes("/cart/") ||
      qs.includes("payment=shop_pay") ||
      qs.includes("checkout")
    );
  } catch {
    return false;
  }
}

function lastAssistantText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any;
    if (m?._getType?.() === "ai" || m?.constructor?.name === "AIMessage") {
      const c = m.content;
      return typeof c === "string" ? c : JSON.stringify(c);
    }
  }
  return "";
}

export async function runAgent() {
  const tokenMgr = new ShopifyTokenManager({
    cachePath: Env.TOKEN_CACHE_PATH,
    refreshSkewMs: 2 * 60 * 1000,
  });

  const CHAR_DELAY_MS = Number(process.env.OUTPUT_CHAR_DELAY_MS ?? "0");

  const { catalog } = await createShopifyMcpClients(tokenMgr);
  const browserClient = Env.BROWSER_MCP_URL ? await createBrowserMcpClient() : null;

  const shopify = buildShopifyTools({ catalog });
  const search = Env.TAVILY_API_KEY ? await buildSearchTools() : null;
  const browser = browserClient ? await buildBrowserTools({ browser: browserClient }) : null;

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

  // Planner + classifier LLM
  const plannerLlm = new ChatOllama({
    baseUrl: Env.OLLAMA_URL,
    model: Env.OLLAMA_MODEL,
    temperature: 0.0,
  });

  // Tool registry (invoke/validate)
  const toolRegistry = new Map<string, ToolEntry>();

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

  if (search) {
    toolRegistry.set("web_search", {
      parse: (args) => search.schemas.WebSearchInput.parse(args),
      invoke: (args) => search.tools.web_search.invoke(args),
    });
  }

  // Browser MCP: keep only read (open is streamable 202 Accepted and breaks JSON clients)
  if (browser) {
    toolRegistry.set("browser_read", {
      parse: (args) => browser.schemas.BrowserReadInput.parse(args),
      invoke: (args) => browser.tools.browser_read.invoke(args),
    });
  }

  // Planner allowed tools (info gathering only)
  const plannerAllowed = new Set(["web_search", "shopify_search", "browser_read"]);
  const toolNamesForPlanner = Array.from(toolRegistry.keys()).filter((n) => plannerAllowed.has(n));
  const plannerPrompt = plannerSystemPrompt(toolNamesForPlanner);

  const { ask } = makeCli();
  const messages: BaseMessage[] = [new SystemMessage(systemPrompt())];

  console.log("Local agent ready. Ask me anything.\n");

  while (true) {
    const user = await ask("> ");
    if (!user) continue;

    messages.push(new HumanMessage(user));

    // Update selection state
    const chosen = parseOptionChoice(user);
    if (chosen) session.selectedOptionIndex = chosen;

    const qty = parseQuantity(user);
    if (qty) session.selectedQuantity = qty;

    // Model-based buy intent (language-agnostic)
    const buy = await isBuyIntentModel({
      llm: plannerLlm,
      userText: user,
      lastAssistantText: lastAssistantText(messages),
      hasSelectedOption: !!session.selectedOptionIndex,
      hasQuantity: !!session.selectedQuantity,
      hasCheckoutUrl: !!session.selectedCheckoutUrl,
      debug: DEBUG,
    });

    // Auto checkout if user wants to buy and option+qty are known
    const auto = await tryAutoCheckout({
      session,
      userText: user,
      // IMPORTANT: no regex anymore
      isBuyIntent: async () => buy,
      openInBrowser: (args) => shopify.tools.open_in_browser.invoke(args),
      adjustCheckoutQuantity: (args) => shopify.tools.adjust_checkout_quantity.invoke(args),
      debug: DEBUG,
    });

    if (auto.didOpen) {
      await typewriterPrint(auto.message ?? "Opening checkout now.", CHAR_DELAY_MS);
      continue;
    }

    // -------- Planner pass --------
    try {
      const ctx = buildPlannerContext({ session, messages });
      const plan = await getPlanWithRepair({
        plannerLlm,
        systemPrompt: plannerPrompt,
        context: ctx,
        user,
        debug: DEBUG,
      });

      if (plan) {
        let planned = (plan.tool_calls ?? [])
          .filter((c) => plannerAllowed.has(c.name))
          .filter((c) => toolRegistry.has(c.name))
          .slice(0, 2);

        // Auto-fill ships_to from session when missing
        planned = planned.map((c) => {
          if (c.name !== "shopify_search") return c;
          const args = { ...(c.args ?? {}) } as any;
          if (!args.ships_to && session.lastShipsTo) args.ships_to = session.lastShipsTo;
          // Guard: if model gives "España", keep only ISO2 if possible
          if (typeof args.ships_to === "string" && args.ships_to.length > 2) {
            // best-effort normalization; prefer ES/US/FR/GB etc
            const t = args.ships_to.trim().toUpperCase();
            if (t.includes("SPAIN") || t.includes("ESPA")) args.ships_to = "ES";
            else if (t.includes("UNITED STATES") || t === "USA") args.ships_to = "US";
          }
          return { ...c, args };
        });

        // Execute planned tools and inject as context
        for (const call of planned) {
          const entry = toolRegistry.get(call.name)!;

          let result: string;
          try {
            if (entry.parse) entry.parse(call.args);
            const raw = await entry.invoke(call.args);
            result = toolResultToString(raw);
          } catch (e: any) {
            result = JSON.stringify({ ok: false, error: e?.message ?? String(e) });
          }

          if (call.name === "shopify_search") {
            updateSessionFromShopifyResult(session, result);
          }

          messages.push(new SystemMessage(`Context from planned tool "${call.name}" (JSON): ${result}`));
        }
      }
    } catch (e: any) {
      if (DEBUG) console.log("[planner] failed:", e?.message ?? String(e));
    }

    // -------- Main tool loop --------
    const MAX_STEPS = 6;
    let finalText: string | null = null;

    for (let step = 0; step < MAX_STEPS; step++) {
      const ai = await llm.invoke(messages);
      const toolCalls = (ai as any).tool_calls as Array<{ id: string; name: string; args: any }> | undefined;

      if (toolCalls && toolCalls.length > 0) {
        messages.push(ai);

        for (const call of toolCalls) {
          // Guardrail:
          // If model tries browser_read on checkout/cart url, override to open_in_browser.
          if (
            call.name === "browser_read" &&
            call.args?.url &&
            typeof call.args.url === "string" &&
            isLikelyCheckoutUrl(call.args.url)
          ) {
            const url = call.args.url;
            const raw = await shopify.tools.open_in_browser.invoke({ url });
            const result = toolResultToString(raw);
            messages.push(new ToolMessage({ content: result, tool_call_id: call.id }));
            continue;
          }

          const entry = toolRegistry.get(call.name);

          let result: string;
          if (!entry) {
            result = JSON.stringify({ ok: false, error: `Unknown tool: ${call.name}` });
          } else {
            try {
              if (entry.parse) entry.parse(call.args);
              const raw = await entry.invoke(call.args);
              result = toolResultToString(raw);
            } catch (e: any) {
              result = JSON.stringify({ ok: false, error: e?.message ?? String(e) });
            }
          }

          if (call.name === "shopify_search") {
            updateSessionFromShopifyResult(session, result);
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
