// src/shopify/tools.ts
import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";

import type { McpClient } from "../mcp/types.js";
import { Env, AUTO_OPEN_CHECKOUT } from "../env.js";
import { normalizeSearchResult, type NormalizedVariant } from "../normalize.js";
import { normalizeShipsTo } from "../utils/shipping.js";
import { mcpErrorMessage } from "../utils/mcp.js";
import { clampQuantity } from "../utils/quantity.js";
import { withQuantityInCheckoutUrl, openUrl } from "../utils/url.js";
import { toOptionCard } from "./cards.js";

const makeStructuredTool = (cfg: any) => new (DynamicStructuredTool as any)(cfg) as any;

export function buildShopifyTools(opts: { catalog: McpClient }) {
  const { catalog } = opts;

  // --------------------
  // open_in_browser
  // --------------------
  const OpenInBrowserInput = z.object({
    url: z.string().min(1),
  });

  const open_in_browser = makeStructuredTool({
    name: "open_in_browser",
    description:
      "Open a URL in the user's default browser. Only use this after the user explicitly asked to open it, or after they chose an option and asked to proceed.",
    schema: OpenInBrowserInput,
    func: async (input: { url: string }) => {
      const url = input.url.trim();
      if (!AUTO_OPEN_CHECKOUT) {
        return JSON.stringify({ ok: false, message: "AUTO_OPEN_CHECKOUT is disabled." });
      }
      openUrl(url);
      return JSON.stringify({ ok: true });
    },
  });

  // --------------------
  // shopify_search
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

  const shopify_search = makeStructuredTool({
    name: "shopify_search",
    description:
      "Search Shopify global catalog for products available to ship to a country. Use when the user wants to buy something or asks for product availability/prices. Returns concise option cards including checkout_url (internal).",
    schema: ShopifySearchInput,
    func: async (input: z.infer<typeof ShopifySearchInput>) => {
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
      const cards = flat.map((v, idx) => toOptionCard(v, idx + 1));

      return JSON.stringify({
        ok: true,
        ships_to: shipsTo,
        query: input.query,
        options: cards,
      });
    },
  });

  // --------------------
  // adjust_checkout_quantity
  // --------------------
  const CheckoutLinkInput = z.object({
    checkout_url: z.string().min(1),
    quantity: z.number().int().min(1).optional(),
  });

  const adjust_checkout_quantity = makeStructuredTool({
    name: "adjust_checkout_quantity",
    description:
      "Adjust a Shopify checkout/cart URL to set the desired quantity (best-effort). Use when the user asks for 2+ items and you already have a checkout_url.",
    schema: CheckoutLinkInput,
    func: async (input: z.infer<typeof CheckoutLinkInput>) => {
      const qty = clampQuantity(input.quantity ?? 1, 1);
      return JSON.stringify({
        ok: true,
        checkout_url: withQuantityInCheckoutUrl(input.checkout_url, qty),
        quantity: qty,
      });
    },
  });

  return {
    schemas: { ShopifySearchInput, CheckoutLinkInput, OpenInBrowserInput },
    tools: { shopify_search, adjust_checkout_quantity, open_in_browser },
  };
}
