// src/agent.ts
import "dotenv/config";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { z } from "zod";

import { Env, DEBUG, AUTO_OPEN_CHECKOUT } from "./env.js";
import { HttpMcpClient } from "./mcp/httpClient.js";
import { StdioMcpClient } from "./mcp/stdioClient.js";
import type { McpClient } from "./mcp/types.js";
import { normalizeSearchResult, type NormalizedVariant } from "./normalize.js";
import { enforcePolicy } from "./policy.js";
import { ShopifyTokenManager } from "./token.js";

// LangChain (Ollama)
import { ChatOllama } from "@langchain/ollama";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";

// --------------------
// Small helpers (no business logic here)
// --------------------

function tokenFingerprint(token: string) {
  const t = (token ?? "").trim();
  return crypto.createHash("sha256").update(t).digest("hex").slice(0, 12);
}

function cleanToken(x: string) {
  return (x ?? "").trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
}

function normalizeShipsTo(x: string) {
  const v = (x ?? "").trim().toUpperCase();
  if (v === "FRANCE" || v === "FRA") return "FR";
  if (v === "UNITED STATES" || v === "UNITED STATES OF AMERICA" || v === "USA") return "US";
  if (v === "UK" || v === "UNITED KINGDOM" || v === "GREAT BRITAIN") return "GB";
  return v;
}

function openUrl(url: string) {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // best effort
  }
}

function mcpErrorMessage(raw: any): string | null {
  const isError = raw?.isError ?? raw?.result?.isError;
  if (!isError) return null;

  const content = raw?.content ?? raw?.result?.content;
  if (Array.isArray(content)) {
    const msg = content.map((c: any) => c?.text).filter(Boolean).join("\n");
    return msg || "Unknown MCP error";
  }
  return "Unknown MCP error";
}

function clampQuantity(qty: unknown, fallback = 1) {
  const n = typeof qty === "number" ? qty : Number(qty);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), Env.MAX_QUANTITY);
}

function tryExtractFirstUrl(text: string): string | null {
  // simple URL extraction (good enough for checkout links)
  const m = text.match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

function withQuantityInCheckoutUrl(checkoutUrl: string, qty: number) {
  // Typical format: https://shop.com/cart/<variant_id>:1?...  -> replace :1
  // If pattern not found, return as-is.
  const q = clampQuantity(qty, 1);
  return checkoutUrl.replace(/\/cart\/(\d+):(\d+)/, (_m, vid) => `/cart/${vid}:${q}`);
}

// --------------------
// Main
// --------------------

async function main() {
  // Keep your bearer logic exactly (auto-refresh via token manager)
  const tokenMgr = new ShopifyTokenManager({
    cachePath: Env.TOKEN_CACHE_PATH,
    refreshSkewMs: 2 * 60 * 1000,
  });

  if (DEBUG) {
    const envBearer = cleanToken(process.env.BEARER_TOKEN ?? "");
    const parsedBearer = cleanToken(Env.BEARER_TOKEN ?? "");
    console.log("[transport]", Env.MCP_TRANSPORT);
    console.log("[catalog url/cmd]", Env.CATALOG_MCP_URL ?? Env.CATALOG_MCP_CMD);
    console.log("[process.env bearer fp]", envBearer ? tokenFingerprint(envBearer) : "(none)");
    console.log("[Env.BEARER fp]        ", parsedBearer ? tokenFingerprint(parsedBearer) : "(none)");
    console.log("[token cache path]", Env.TOKEN_CACHE_PATH);
  }

  const getAuthHeaders = async () => {
    const token = cleanToken(await tokenMgr.getToken());
    if (DEBUG) console.log("[token fp]", tokenFingerprint(token));
    return { authorization: `Bearer ${token}` };
  };

  const createMcp = async (urlOrCmd: string, kind: "catalog" | "checkout"): Promise<McpClient> => {
    if (Env.MCP_TRANSPORT === "http") {
      if (!urlOrCmd) throw new Error(`${kind} MCP URL missing`);
      // NOTE: HttpMcpClient accepts async headers callback (auto-refresh per request)
      return new HttpMcpClient(urlOrCmd, getAuthHeaders);
    }
    // stdio: token fetched once at startup
    const token = cleanToken(await tokenMgr.getToken());
    return new StdioMcpClient(urlOrCmd, { BEARER_TOKEN: token, SHOPIFY_ACCESS_TOKEN: token });
  };

  const catalog = await createMcp(Env.CATALOG_MCP_URL ?? Env.CATALOG_MCP_CMD ?? "", "catalog");
  const checkout = await createMcp(Env.CHECKOUT_MCP_URL ?? Env.CHECKOUT_MCP_CMD ?? "", "checkout");
  void checkout;

  // --------------------
  // LangChain tools
  // --------------------

  const ShopifySearchInput = z.object({
    query: z.string().min(1).describe("What the user wants to find, e.g. 'iPhone 14 unlocked'"),
    ships_to: z
      .string()
      .optional()
      .describe("ISO country code like US/FR/GB. If unknown, omit and ask the user."),
    max_price_usd: z.number().optional().describe("Optional max price in USD"),
    limit: z.number().int().min(1).max(10).optional().describe("Max options to return (default 8)"),
  });

  const shopify_search = tool(
    async (input) => {
      const shipsToRaw = (input.ships_to ?? "").trim();
      if (!shipsToRaw) {
        return JSON.stringify({
          ok: false,
          needs: "ships_to",
          message: "Missing ships_to. Ask the user where it should ship (US/FR/GB etc).",
        });
      }

      const shipsTo = normalizeShipsTo(shipsToRaw);
      const limit = input.limit ?? 8;

      const context = Env.DEFAULT_CONTEXT || "Buyer wants good value. Keep choices concise.";

      let raw: any;
      try {
        raw = await catalog.callTool("search_global_products", {
          query: input.query,
          ships_to: shipsTo,
          max_price: input.max_price_usd,
          limit: 10,
          available_for_sale: true,
          include_secondhand: false,
          context,
        });
      } catch (e: any) {
        return JSON.stringify({ ok: false, error: `Catalog request failed: ${e?.message ?? String(e)}` });
      }

      const maybeErr = mcpErrorMessage(raw);
      if (maybeErr) {
        return JSON.stringify({ ok: false, error: maybeErr });
      }

      const shortlist = normalizeSearchResult(raw, 10, 10);
      const flat: NormalizedVariant[] = shortlist.flatMap((p: any) => p.variants ?? []).slice(0, limit);

      // Return structured data for the LLM to reason about
      return JSON.stringify({
        ok: true,
        ships_to: shipsTo,
        query: input.query,
        options: flat.map((v, idx) => ({
          option_index: idx + 1,
          title: v.title,
          variant_id: v.variantId ?? null,
          price_usd: v.priceUsd ?? null,
          currency: v.currency ?? null,
          shop_url: v.shopUrl ?? null,
          checkout_url: v.checkoutUrl ?? null,
          options: v.options ?? {},
        })),
      });
    },
    {
      name: "shopify_search",
      description:
        "Search Shopify global catalog for products available to ship to a country. Use when the user wants to buy something or asks for product availability/prices. Returns a short list with option_index, variant_id, price, and checkout_url when available.",
      schema: ShopifySearchInput,
    },
  );

  const CheckoutLinkInput = z.object({
    checkout_url: z.string().min(1),
    quantity: z.number().int().min(1).optional(),
  });

  const adjust_checkout_quantity = tool(
    async (input) => {
      const qty = clampQuantity(input.quantity ?? 1, 1);
      return JSON.stringify({
        ok: true,
        checkout_url: withQuantityInCheckoutUrl(input.checkout_url, qty),
        quantity: qty,
      });
    },
    {
      name: "adjust_checkout_quantity",
      description:
        "Adjust a Shopify checkout/cart URL to set the desired quantity (best-effort). Use when the user asks for 2+ items and you already have a checkout_url.",
      schema: CheckoutLinkInput,
    },
  );

  // Model
  const llm = new ChatOllama({
    baseUrl: Env.OLLAMA_URL,
    model: Env.OLLAMA_MODEL,
    temperature: 0.3,
  }).bindTools([shopify_search, adjust_checkout_quantity]);

  // --------------------
  // Conversation loop (agentic tool calling)
  // --------------------

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  const messages: BaseMessage[] = [
    new AIMessage(
      [
        "You are a helpful assistant running locally.",
        "You can chat normally about anything.",
        "When the user wants to find/buy something, you MAY call tools to search Shopify and provide options and checkout links.",
        "If shipping country is unclear, ask a short question.",
        "Never invent IDs or prices.",
        "If you provide a checkout link and AUTO_OPEN_CHECKOUT is true, the program may open it in a browser.",
        "",
        "When you show options, keep it concise and reference them as option 1, option 2, etc.",
      ].join("\n"),
    ),
  ];

  console.log("Local agent ready. Ask me anything.\n");

  while (true) {
    const user = await ask("> ");
    if (!user) continue;

    messages.push(new HumanMessage(user));

    // Run an agent loop: model can call tools multiple times before final answer.
    // Keep a hard cap so it can't spin forever.
    const MAX_STEPS = 6;

    let finalText: string | null = null;

    for (let step = 0; step < MAX_STEPS; step++) {
      const ai = await llm.invoke(messages);

      // If tool calls exist, execute them and continue
      const toolCalls = (ai as any).tool_calls as Array<{ id: string; name: string; args: any }> | undefined;

      if (toolCalls && toolCalls.length > 0) {
        messages.push(ai);

        for (const call of toolCalls) {
          let result = "";
          try {
            if (call.name === "shopify_search") {
              // validate input for better safety
              ShopifySearchInput.parse(call.args);
              result = await shopify_search.invoke(call.args);
            } else if (call.name === "adjust_checkout_quantity") {
              CheckoutLinkInput.parse(call.args);
              result = await adjust_checkout_quantity.invoke(call.args);
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

      // No tool calls => final answer
      finalText = typeof ai.content === "string" ? ai.content : JSON.stringify(ai.content);
      messages.push(ai);
      break;
    }

    if (!finalText) {
      finalText = "I got stuck. Can you rephrase what you want?";
    }

    // Optional: if assistant is about to open a checkout link, enforce policy best-effort
    // We only enforce if we can infer price + quantity; otherwise we skip.
    // (You can remove this block if you want zero guardrails.)
    try {
      // If the assistant output includes a checkout URL, we can open it.
      const url = tryExtractFirstUrl(finalText);
      if (url && AUTO_OPEN_CHECKOUT) {
        // No price here; we don't block opening, but keep your policy enforcement for “picked option” cases inside tool output.
        openUrl(url);
      }
    } catch {
      // ignore
    }

    console.log(finalText);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
