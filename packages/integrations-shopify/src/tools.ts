// packages/integrations-shopify/src/tools.ts
import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";

import type { McpClient } from "../../core/src/mcp/types";
import { normalizeShipsTo } from "../../core/src/utils/shipping";
import { mcpErrorMessage } from "../../core/src/utils/mcp";

import { Env } from "../../core/src/env";
import { normalizeSearchResult } from "./normalize";
import { toOptionCard } from "./cards";

export function buildShopifyTools(args: { catalog: McpClient }) {
  const ShopifySearchInput = z.object({
    query: z.string().min(1),
    ships_to: z.string().optional(),
    max_price_usd: z.number().optional(),
    limit: z.number().int().min(1).max(10).optional(),
  });

  const shopify_search = new DynamicStructuredTool({
    name: "shopify_search",
    description:
      "Search Shopify global catalog for products available to ship to a country. Returns buyable options with prices.",
    schema: ShopifySearchInput as any,
    func: async (input: any): Promise<string> => {
      const shipsToRaw = (input.ships_to ?? "").trim();
      if (!shipsToRaw) {
        return JSON.stringify({
          ok: false,
          error: { code: "MISSING_SHIPS_TO", message: "Missing ships_to." },
        });
      }

      const shipsTo = normalizeShipsTo(shipsToRaw);
      const limit = input.limit ?? 8;

      let raw: any;
      try {
        raw = await args.catalog.callTool("search_global_products", {
          query: input.query,
          ships_to: shipsTo,
          max_price: input.max_price_usd,
          limit: 10,
          available_for_sale: true,
          include_secondhand: false,
          context: Env.DEFAULT_CONTEXT ?? "",
        });
      } catch (e: any) {
        return JSON.stringify({
          ok: false,
          error: { code: "MCP_CALL_FAILED", message: e?.message ?? String(e) },
        });
      }

      const maybeErr = mcpErrorMessage(raw);
      if (maybeErr) {
        return JSON.stringify({ ok: false, error: { code: "MCP_ERROR", message: maybeErr } });
      }

      const shortlist = normalizeSearchResult(raw, 10, 10);
      const flat = shortlist.flatMap((p: any) => p.variants ?? []).slice(0, limit);
      const cards = flat.map((v: any, idx: number) => toOptionCard(v, idx + 1));

      return JSON.stringify({
        ok: true,
        data: { ships_to: shipsTo, query: input.query, options: cards },
      });
    },
  });

  return {
    schemas: { ShopifySearchInput },
    tools: { shopify_search },
  };
}
