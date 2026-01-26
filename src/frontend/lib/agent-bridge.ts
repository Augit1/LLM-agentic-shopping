import { ChatOllama } from "@langchain/ollama";
import {
  HumanMessage,
  ToolMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Env, DEBUG } from "../../env.js";
import { ShopifyTokenManager } from "../../token.js";
import { createShopifyMcpClients } from "../../shopify/mcp.js";
import { buildShopifyTools } from "../../shopify/tools.js";
import { buildSearchTools } from "../../search/tools.js";
import { createBrowserMcpClient } from "../../browser/mcp.js";
import { buildBrowserTools } from "../../browser/tools.js";
import { systemPrompt } from "../../agent/prompt.js";
import { session } from "../../agent/session/state.js";
import { updateSessionFromShopifyResult } from "../../agent/session/shopifyState.js";
import { parseOptionChoice, parseQuantity } from "../../agent/intent/parse.js";
import { toolResultToString } from "../../agent/tools/result.js";
import type { ToolEntry } from "../../agent/tools/registry.js";
import { buildPlannerContext } from "../../agent/planner/context.js";
import { getPlanWithRepair, plannerSystemPrompt } from "../../agent/planner/index.js";
import { tryAutoCheckout } from "../../agent/checkout/autoCheckout.js";
import { isBuyIntentModel } from "../../agent/intent/buyIntent.js";
import { getCheckoutUrlForOption } from "../../agent/session/shopifyState.js";
import type { Message, ProductOption } from "../types/index.js";

// Global agent state (initialized once)
let agentInitialized = false;
let llm: ReturnType<ChatOllama["bindTools"]> | null = null;
let plannerLlm: ChatOllama | null = null;
let toolRegistry: Map<string, ToolEntry> | null = null;
let shopifyTools: ReturnType<typeof buildShopifyTools> | null = null;
let plannerPrompt: string | null = null;
let messages: BaseMessage[] = [];

function isLikelyCheckoutUrl(url: string): boolean {
  try {
    const u = new URL(url);
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

async function initializeAgent() {
  if (agentInitialized) return;

  const tokenMgr = new ShopifyTokenManager({
    cachePath: Env.TOKEN_CACHE_PATH,
    refreshSkewMs: 2 * 60 * 1000,
  });

  const { catalog } = await createShopifyMcpClients(tokenMgr);
  const browserClient = Env.BROWSER_MCP_URL ? await createBrowserMcpClient() : null;

  shopifyTools = buildShopifyTools({ catalog });
  const search = Env.TAVILY_API_KEY ? await buildSearchTools() : null;
  const browser = browserClient ? await buildBrowserTools({ browser: browserClient }) : null;

  const allTools = [
    ...Object.values(shopifyTools.tools),
    ...(search ? Object.values(search.tools) : []),
    ...(browser ? Object.values(browser.tools) : []),
  ];

  llm = new ChatOllama({
    baseUrl: Env.OLLAMA_URL,
    model: Env.OLLAMA_MODEL,
    temperature: 0.3,
  }).bindTools(allTools);

  plannerLlm = new ChatOllama({
    baseUrl: Env.OLLAMA_URL,
    model: Env.OLLAMA_MODEL,
    temperature: 0.0,
  });

  toolRegistry = new Map<string, ToolEntry>();

  toolRegistry.set("shopify_search", {
    parse: (args) => shopifyTools!.schemas.ShopifySearchInput.parse(args),
    invoke: (args) => shopifyTools!.tools.shopify_search.invoke(args),
  });
  toolRegistry.set("adjust_checkout_quantity", {
    parse: (args) => shopifyTools!.schemas.CheckoutLinkInput.parse(args),
    invoke: (args) => shopifyTools!.tools.adjust_checkout_quantity.invoke(args),
  });
  toolRegistry.set("open_in_browser", {
    parse: (args) => shopifyTools!.schemas.OpenInBrowserInput.parse(args),
    invoke: (args) => shopifyTools!.tools.open_in_browser.invoke(args),
  });

  if (search) {
    toolRegistry.set("web_search", {
      parse: (args) => search.schemas.WebSearchInput.parse(args),
      invoke: (args) => search.tools.web_search.invoke(args),
    });
  }

  if (browser) {
    toolRegistry.set("browser_read", {
      parse: (args) => browser.schemas.BrowserReadInput.parse(args),
      invoke: (args) => browser.tools.browser_read.invoke(args),
    });
  }

  const plannerAllowed = new Set(["web_search", "shopify_search", "browser_read"]);
  const toolNamesForPlanner = Array.from(toolRegistry.keys()).filter((n) =>
    plannerAllowed.has(n)
  );
  plannerPrompt = plannerSystemPrompt(toolNamesForPlanner);

  messages = [new SystemMessage(systemPrompt())];

  agentInitialized = true;
}

function extractProductOptions(text: string): ProductOption[] | null {
  // Try to extract product options from the assistant's response
  // This is a simplified parser - you might want to enhance this
  const optionRegex = /Option\s+(\d+)\s*—\s*([^—]+)\s*—\s*([^\n]+)/g;
  const options: ProductOption[] = [];
  let match;

  while ((match = optionRegex.exec(text)) !== null) {
    const optionIndex = parseInt(match[1]);
    const title = match[2].trim();
    const price = match[3].trim();

    // Try to extract bullets (lines starting with -)
    const bullets: string[] = [];
    const textAfter = text.substring(match.index + match[0].length);
    const bulletLines = textAfter.split("\n").slice(0, 5);
    for (const line of bulletLines) {
      const bulletMatch = line.match(/^-\s*(.+)$/);
      if (bulletMatch) {
        bullets.push(bulletMatch[1].trim());
      } else if (line.trim() && !line.match(/^Option\s+\d+/)) {
        break;
      }
    }

    options.push({
      option_index: optionIndex,
      title,
      variant_id: optionIndex, // Use option_index as fallback
      price,
      bullets: bullets.length > 0 ? bullets : undefined,
    });
  }

  // Also check session for options
  if (session.lastShopifyOptions && session.lastShopifyOptions.length > 0) {
    return session.lastShopifyOptions.map((opt) => ({
      option_index: opt.option_index,
      title: opt.title,
      variant_id: opt.variant_id,
      price: opt.price,
      currency: opt.currency,
      seller: opt.seller,
      bullets: opt.bullets,
      checkout_url: opt.checkout_url,
    }));
  }

  return options.length > 0 ? options : null;
}

export async function runAgentMessage(
  userMessage: string,
  history: Message[]
): Promise<{ message: string; productOptions?: ProductOption[] }> {
  await initializeAgent();

  if (!llm || !plannerLlm || !toolRegistry || !shopifyTools || !plannerPrompt) {
    throw new Error("Agent not initialized");
  }

  messages.push(new HumanMessage(userMessage));

  // Update selection state
  const chosen = parseOptionChoice(userMessage);
  if (chosen) session.selectedOptionIndex = chosen;

  const qty = parseQuantity(userMessage);
  if (qty) session.selectedQuantity = qty;

  // Model-based buy intent
  const selectedCheckoutUrl = session.selectedOptionIndex
    ? getCheckoutUrlForOption(session, session.selectedOptionIndex)
    : null;
  const buy = await isBuyIntentModel({
    llm: plannerLlm,
    userText: userMessage,
    lastAssistantText: lastAssistantText(messages),
    hasSelectedOption: !!session.selectedOptionIndex,
    hasQuantity: !!session.selectedQuantity,
    hasCheckoutUrl: !!selectedCheckoutUrl,
    debug: DEBUG,
  });

  // Auto checkout if user wants to buy
  const auto = await tryAutoCheckout({
    session,
    userText: userMessage,
    isBuyIntent: async (args: { userText: string; lastAssistantText?: string; session: any }) => {
      return await isBuyIntentModel({
        llm: plannerLlm!,
        userText: args.userText,
        lastAssistantText: args.lastAssistantText || "",
        hasSelectedOption: !!args.session.selectedOptionIndex,
        hasQuantity: !!args.session.selectedQuantity,
        hasCheckoutUrl: !!getCheckoutUrlForOption(args.session, args.session.selectedOptionIndex),
        debug: DEBUG,
      });
    },
    openInBrowser: (args) => shopifyTools!.tools.open_in_browser.invoke(args),
    adjustCheckoutQuantity: (args) =>
      shopifyTools!.tools.adjust_checkout_quantity.invoke(args),
    debug: DEBUG,
  });

  if (auto.didOpen) {
    return {
      message: auto.message ?? "Opening checkout now.",
    };
  }

  // Planner pass
  try {
    const ctx = buildPlannerContext({ session, messages });
    const plan = await getPlanWithRepair({
      plannerLlm,
      systemPrompt: plannerPrompt,
      context: ctx,
      user: userMessage,
      debug: DEBUG,
    });

    if (plan) {
      const plannerAllowed = new Set(["web_search", "shopify_search", "browser_read"]);
      let planned = (plan.tool_calls ?? [])
        .filter((c) => plannerAllowed.has(c.name))
        .filter((c) => toolRegistry!.has(c.name))
        .slice(0, 2);

      planned = planned.map((c) => {
        if (c.name !== "shopify_search") return c;
        const args = { ...(c.args ?? {}) } as any;
        if (!args.ships_to && session.lastShipsTo) args.ships_to = session.lastShipsTo;
        if (typeof args.ships_to === "string" && args.ships_to.length > 2) {
          const t = args.ships_to.trim().toUpperCase();
          if (t.includes("SPAIN") || t.includes("ESPA")) args.ships_to = "ES";
          else if (t.includes("UNITED STATES") || t === "USA") args.ships_to = "US";
        }
        return { ...c, args };
      });

      for (const call of planned) {
        const entry = toolRegistry!.get(call.name)!;

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

        messages.push(
          new SystemMessage(`Context from planned tool "${call.name}" (JSON): ${result}`)
        );
      }
    }
  } catch (e: any) {
    if (DEBUG) console.log("[planner] failed:", e?.message ?? String(e));
  }

  // Main tool loop
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
        if (
          call.name === "browser_read" &&
          call.args?.url &&
          typeof call.args.url === "string" &&
          isLikelyCheckoutUrl(call.args.url)
        ) {
          const url = call.args.url;
          const raw = await shopifyTools.tools.open_in_browser.invoke({ url });
          const result = toolResultToString(raw);
          messages.push(new ToolMessage({ content: result, tool_call_id: call.id }));
          continue;
        }

        const entry = toolRegistry!.get(call.name);

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

  // Extract product options
  const productOptions = extractProductOptions(finalText);

  return {
    message: finalText,
    productOptions: productOptions || undefined,
  };
}

