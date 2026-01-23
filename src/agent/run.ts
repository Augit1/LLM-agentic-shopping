// src/agent/run.ts
import { ChatOllama } from "@langchain/ollama";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

import { Env, DEBUG } from "../env.js";
import { ShopifyTokenManager } from "../token.js";
import { cleanToken, tokenFingerprint } from "../utils/auth.js";
import { makeCli, typewriterPrint } from "../cli/io.js";
import { createShopifyMcpClients } from "../shopify/mcp.js";
import { buildShopifyTools } from "../shopify/tools.js";
import { systemPrompt } from "./prompt.js";

import { buildSearchTools } from "../search/tools.js";

import { createBrowserMcpClient } from "../browser/mcp.js";
import { buildBrowserTools } from "../browser/tools.js";


function toolResultToString(x: unknown): string {
  if (typeof x === "string") return x;
  if (x && typeof x === "object" && "content" in x) {
    const c = (x as any).content;
    return typeof c === "string" ? c : JSON.stringify(c);
  }
  return JSON.stringify(x);
}

export async function runAgent() {
  // Keep your bearer logic exactly (auto-refresh via token manager)
  // --- MCP clients ---
  const tokenMgr = new ShopifyTokenManager({
    cachePath: Env.TOKEN_CACHE_PATH,
    refreshSkewMs: 2 * 60 * 1000,
  });
  
  const CHAR_DELAY_MS = Number(process.env.OUTPUT_CHAR_DELAY_MS ?? "0");
  
  const { catalog } = await createShopifyMcpClients(tokenMgr);
  
  // Optional MCPs (only enabled if URL exists)
  const searchClient = Env.TAVILY_API_URL
    ? await buildSearchTools()
    : null;
  
  const browserClient = Env.BROWSER_MCP_URL
    ? await createBrowserMcpClient()
    : null;
  
  // --- Tool builders ---
  const shopify = buildShopifyTools({ catalog });
  
  const search = Env.TAVILY_API_KEY
	? await buildSearchTools()
	: null;
  
  const browser = browserClient
    ? await buildBrowserTools({ browser: browserClient })
    : null;
  
  // --- Bind all tools ---
  const allTools = [
    ...Object.values(shopify.tools),
    ...(search ? Object.values(search.tools) : []),
    ...(browser ? Object.values(browser.tools) : []),
  ];
  
  // --- LLM ---
  const llm = new ChatOllama({
    baseUrl: Env.OLLAMA_URL,
    model: Env.OLLAMA_MODEL,
    temperature: 0.3,
  }).bindTools(allTools);

  const { ask } = makeCli();

  const messages: BaseMessage[] = [new AIMessage(systemPrompt())];

  console.log("Local agent ready. Ask me anything.\n");

  while (true) {
    const user = await ask("> ");
    if (!user) continue;

    messages.push(new HumanMessage(user));

    const MAX_STEPS = 6;
    let finalText: string | null = null;

    for (let step = 0; step < MAX_STEPS; step++) {
      const ai = await llm.invoke(messages);

      const toolCalls = (ai as any).tool_calls as Array<{ id: string; name: string; args: any }> | undefined;

      if (toolCalls && toolCalls.length > 0) {
        messages.push(ai);

        for (const call of toolCalls) {
          let result = "";
          try {
            if (call.name === "shopify_search") {
              shopify.schemas.ShopifySearchInput.parse(call.args);
              result = toolResultToString(await shopify.tools.shopify_search.invoke(call.args));
            } else if (call.name === "adjust_checkout_quantity") {
              shopify.schemas.CheckoutLinkInput.parse(call.args);
              result = toolResultToString(await shopify.tools.adjust_checkout_quantity.invoke(call.args));
            } else if (call.name === "open_in_browser") {
              shopify.schemas.OpenInBrowserInput.parse(call.args);
              result = toolResultToString(await shopify.tools.open_in_browser.invoke(call.args));
            } else {
              result = JSON.stringify({ ok: false, error: `Unknown tool: ${call.name}` });
            }
          } catch (e: any) {
            result = JSON.stringify({ ok: false, error: e?.message ?? String(e) });
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
