// packages/app-cli/src/runtime/runAgent.ts
import { ChatOllama } from "@langchain/ollama";
import {
  HumanMessage,
  ToolMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";

// core
import { Env, DEBUG } from "../../../core/src/env.js";
import { systemPrompt } from "../../../core/src/agent/prompt.js";
import { session } from "../../../core/src/agent/session/state.js";
import {
  updateSessionFromShopifyResult,
  getCheckoutUrlForOption,
} from "../../../core/src/agent/session/shopifyState.js";

import { parseOptionChoice, parseQuantity } from "../../../core/src/agent/intent/parse.js";
import { buildPlannerContext } from "../../../core/src/agent/planner/context.js";
import { getPlanWithRepair, plannerSystemPrompt } from "../../../core/src/agent/planner/index.js";
import { tryAutoCheckout } from "../../../core/src/agent/checkout/autoCheckout.js";
import { isBuyIntentModel } from "../../../core/src/agent/intent/buyIntentModel.js";
import { extractUrls } from "../../../core/src/agent/utils/urls.js";
import { decideLinkOpen } from "../../../core/src/agent/planner/linkOpen.js";

// new tool system
import { ToolRegistry } from "../../../core/src/tools/registry.js";
import { toLangChainTool } from "../../../core/src/tools/langchain.js";
import type { ToolContext, ToolSpec } from "../../../core/src/tools/types.js";

// app-cli local
import { makeCli, typewriterPrint } from "../cli.js";

// integrations
import { ShopifyTokenManager } from "../../../integrations-shopify/src/token.js";
import { createShopifyMcpClients } from "../../../integrations-shopify/src/mcp.js";
import { shopifyTools } from "../../../integrations-shopify/src/tools.js";

import { buildSearchTools } from "../../../integrations-search/src/tools.js";

import { createBrowserMcpClient } from "../../../integrations-browser/src/mcp.js";
import { buildBrowserTools } from "../../../integrations-browser/src/tools.js";

type InvokableEntry = {
  parse?: (args: any) => any;
  invoke: (args: any) => Promise<any>;
};

function toolResultToString(x: unknown): string {
  if (typeof x === "string") return x;
  return JSON.stringify(x);
}

function isLikelyCheckoutUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    const qs = u.search.toLowerCase();
    return path.includes("/cart/") || qs.includes("payment=shop_pay") || qs.includes("checkout");
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

  // Tool context (what ToolSpecs receive)
  const ctx: ToolContext = {
    env: process.env,
    session,
    debug: DEBUG,
  };

  // --- Shopify ToolSpecs -> ToolRegistry -> LangChain tools
  const registry = new ToolRegistry();
  const shopifySpecs: ToolSpec<any, any>[] = shopifyTools({ catalog });
  registry.registerMany(shopifySpecs);

  const shopifyLangChainTools = registry.list().map((s) => toLangChainTool(s, ctx));

  // --- Search + Browser are still LangChain-native (for now)
  const search = Env.TAVILY_API_KEY ? await buildSearchTools() : null;
  const browser = browserClient ? await buildBrowserTools({ browser: browserClient }) : null;

  const allTools = [
    ...shopifyLangChainTools,
    ...(search ? Object.values(search.tools) : []),
    ...(browser ? Object.values(browser.tools) : []),
  ] as any[];

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

  // Unified invokable map for planner execution + tool loop execution
  const invokables = new Map<string, InvokableEntry>();

  // Register ToolSpecs (shopify tools)
  for (const spec of registry.list()) {
    invokables.set(spec.id, {
      parse: (args: any) => spec.input.parse(args),
      invoke: async (args: any) => {
        const parsed = spec.input.parse(args);
        return spec.run(ctx, parsed);
      },
    });
  }

  // Register search/browser tools (langchain tools)
  if (search) {
    invokables.set("web_search", {
      parse: (args: any) => search.schemas.WebSearchInput.parse(args),
      invoke: (args: any) => search.tools.web_search.invoke(args),
    });
  }
  if (browser) {
    invokables.set("browser_read", {
      parse: (args: any) => browser.schemas.BrowserReadInput.parse(args),
      invoke: (args: any) => browser.tools.browser_read.invoke(args),
    });
  }

  // Planner allowed tools (info gathering only)
  const plannerAllowed = new Set(["web_search", "shopify_search", "browser_read"]);
  const toolNamesForPlanner = [...invokables.keys()].filter((n) => plannerAllowed.has(n));
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

    // Buy intent
    const buy = await isBuyIntentModel({
      llm: plannerLlm,
      userText: user,
      lastAssistantText: lastAssistantText(messages),
      hasSelectedOption: !!session.selectedOptionIndex,
      hasQuantity: !!session.selectedQuantity,
      hasCheckoutUrl: !!getCheckoutUrlForOption(session, session.selectedOptionIndex ?? null),
      debug: DEBUG,
    });

    // Auto checkout (uses ToolSpec IDs)
    const auto = await tryAutoCheckout({
      session,
      userText: user,
      isBuyIntent: async () => buy,
      openInBrowser: (args: any) => invokables.get("open_in_browser")!.invoke(args),
      adjustCheckoutQuantity: (args: any) => invokables.get("adjust_checkout_quantity")!.invoke(args),
      debug: DEBUG,
    });

    if (auto.didOpen) {
      await typewriterPrint(auto.message ?? "Opening checkout now.", CHAR_DELAY_MS);
      continue;
    }

    // -------- Planner pass --------
    try {
      const ctxText = buildPlannerContext({ session, messages });
      const plan = await getPlanWithRepair({
        plannerLlm,
        systemPrompt: plannerPrompt,
        context: ctxText,
        user,
        debug: DEBUG,
      });

      if (plan) {
        let planned = (plan.tool_calls ?? [])
          .filter((c) => plannerAllowed.has(c.name))
          .filter((c) => invokables.has(c.name))
          .slice(0, 2);

        // Auto-fill ships_to from session when missing
        planned = planned.map((c) => {
          if (c.name !== "shopify_search") return c;
          const args = { ...(c.args ?? {}) } as any;
          if (!args.ships_to && session.lastShipsTo) args.ships_to = session.lastShipsTo;
          return { ...c, args };
        });

        for (const call of planned) {
          const entry = invokables.get(call.name)!;

          let resultText: string;
          try {
            if (entry.parse) entry.parse(call.args);
            const raw = await entry.invoke(call.args);
            resultText = toolResultToString(raw);
          } catch (e: any) {
            resultText = JSON.stringify({ ok: false, error: e?.message ?? String(e) });
          }

          if (call.name === "shopify_search") {
            updateSessionFromShopifyResult(session, resultText);
          }

          messages.push(new SystemMessage(`Context from planned tool "${call.name}" (JSON): ${resultText}`));
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
          // Guardrail: prevent browser_read on checkout url
          if (
            call.name === "browser_read" &&
            call.args?.url &&
            typeof call.args.url === "string" &&
            isLikelyCheckoutUrl(call.args.url)
          ) {
            const raw = await invokables.get("open_in_browser")!.invoke({ url: call.args.url });
            const result = toolResultToString(raw);
            messages.push(new ToolMessage({ content: result, tool_call_id: call.id }));
            continue;
          }

          const entry = invokables.get(call.name);

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

    const urls = extractUrls(finalText);

    const decision = await decideLinkOpen({
      plannerLlm,
      userText: user,
      assistantDraft: finalText,
      urls,
    });

    if (decision.open && decision.urls.length > 0) {
      for (const url of decision.urls) {
        try {
          await invokables.get("open_in_browser")!.invoke({ url });
        } catch (e: any) {
          if (DEBUG) console.log("[auto-open-url] failed:", e?.message ?? String(e));
        }
      }
    }

    await typewriterPrint(finalText, CHAR_DELAY_MS);
  }
}
