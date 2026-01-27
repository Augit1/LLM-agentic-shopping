// packages/integrations-shopify/src/tools.ts
import { z } from "zod";

import type { McpClient } from "../../core/src/mcp/types.js";
import type { ToolSpec, ToolContext, ToolResult } from "../../core/src/tools/types.js";

import { normalizeShipsTo } from "../../core/src/utils/shipping.js";
import { mcpErrorMessage } from "../../core/src/utils/mcp.js";
import { openUrl, withQuantityInCheckoutUrl } from "../../core/src/utils/url.js";
import { clampQuantity } from "../../core/src/utils/quantity.js";

import { normalizeSearchResult } from "./normalize.js";
import { toOptionCard } from "./cards.js";

type ShopifySearchOut = {
  ships_to: string;
  query: string;
  options: any[];
};

type AdjustQtyOut = {
  checkout_url: string;
  quantity: number;
};

function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string, details?: any): ToolResult<never> {
  return { ok: false, error: { code, message, details } };
}

function envBool(ctx: ToolContext, key: string, fallback: boolean) {
  const v = (ctx.env?.[key] ?? "").toString().trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "y";
}

export function shopifyTools(args: { catalog: McpClient }): ToolSpec<any, any>[] {
  // --------------------
  // shopify_search
  // --------------------
  const ShopifySearchInput = z.object({
    query: z.string().min(1),
    ships_to: z.string().optional(),
    max_price_usd: z.number().optional(),
    limit: z.number().int().min(1).max(10).optional(),
  });

  const shopify_search: ToolSpec<typeof ShopifySearchInput, ShopifySearchOut> = {
    id: "shopify_search",
    description:
      "Search Shopify global catalog for products available to ship to a country.",
    input: ShopifySearchInput,
    async run(ctx, input) {
      const shipsToRaw = (input.ships_to ?? "").trim();
      if (!shipsToRaw) {
        return fail("MISSING_SHIPS_TO", "Missing ships_to. Ask user where it should ship (US/FR/GB/etc).");
      }

      const shipsTo = normalizeShipsTo(shipsToRaw);
      const limit = input.limit ?? 8;
      const context = (ctx.env?.DEFAULT_CONTEXT ?? "").toString();

      let raw: any;
      try {
        raw = await args.catalog.callTool("search_global_products", {
          query: input.query,
          ships_to: shipsTo,
          max_price: input.max_price_usd,
          limit: 10,
          available_for_sale: true,
          include_secondhand: false,
          context,
        });
      } catch (e: any) {
        return fail("MCP_CALL_FAILED", e?.message ?? String(e));
      }

      const maybeErr = mcpErrorMessage(raw);
      if (maybeErr) return fail("MCP_ERROR", maybeErr);

      const shortlist = normalizeSearchResult(raw, 10, 10);
      const flat = shortlist.flatMap((p: any) => p.variants ?? []).slice(0, limit);
      const cards = flat.map((v: any, idx: number) => toOptionCard(v, idx + 1));

      return ok({
        ships_to: shipsTo,
        query: input.query,
        options: cards,
      });
    },
  };

  // --------------------
  // adjust_checkout_quantity
  // --------------------
  const CheckoutLinkInput = z.object({
    checkout_url: z.string().min(1),
    quantity: z.number().int().min(1).optional(),
  });

  const adjust_checkout_quantity: ToolSpec<typeof CheckoutLinkInput, AdjustQtyOut> = {
    id: "adjust_checkout_quantity",
    description:
      "Adjust a Shopify checkout/cart URL to set the desired quantity (best-effort). Use when user wants 2+ items and you already have a checkout_url.",
    input: CheckoutLinkInput,
    async run(ctx, input) {
      const qty = clampQuantity(input.quantity ?? 1, 1);
      return ok({
        checkout_url: withQuantityInCheckoutUrl(input.checkout_url, qty),
        quantity: qty,
      });
    },
  };

  // --------------------
  // open_in_browser
  // --------------------
  const OpenInBrowserInput = z.object({
    url: z.string().min(1),
  });

  const open_in_browser: ToolSpec<typeof OpenInBrowserInput, { opened: boolean }> = {
    id: "open_in_browser",
    description:
      "Open a URL in the user's default browser. Use only after user asks to open it, or after user chose an option and asked to proceed.",
    input: OpenInBrowserInput,
    async run(ctx, input) {
      const allow = envBool(ctx, "AUTO_OPEN_CHECKOUT", true);
      if (!allow) return fail("AUTO_OPEN_DISABLED", "AUTO_OPEN_CHECKOUT is disabled.");

      try {
        openUrl(input.url.trim());
      } catch {
        // best-effort open; still return ok=false only if you want strictness
      }
      return ok({ opened: true });
    },
  };

  return [shopify_search, adjust_checkout_quantity, open_in_browser];
}
