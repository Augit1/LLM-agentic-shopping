// packages/core/src/tools/actions.ts
import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";

import { Env } from "../env";
import { openUrl, withQuantityInCheckoutUrl } from "../utils/url";
import { clampQuantity } from "../utils/quantity";

export function buildCoreActionTools() {
  const OpenInBrowserInput = z.object({
    url: z.string().min(1),
  });

  const open_in_browser = new DynamicStructuredTool({
    name: "open_in_browser",
    description:
      "Open a URL in the user's default browser. Use when user asks to open a page, or when user confirmed checkout.",
    schema: OpenInBrowserInput as any,
    func: async (input: any): Promise<string> => {
      const url = String(input?.url ?? "").trim();
      if (!url) return JSON.stringify({ ok: false, error: "Missing url" });

      // Respect AUTO_OPEN_CHECKOUT flag (still model-driven; this is just a runtime guard)
      const allow = Env.AUTO_OPEN_CHECKOUT.toLowerCase() === "true";
      if (!allow) {
        return JSON.stringify({
          ok: false,
          error: "AUTO_OPEN_CHECKOUT is disabled.",
        });
      }

      try {
        openUrl(url);
      } catch {
        // best effort
      }

      return JSON.stringify({ ok: true, opened: true, url });
    },
  });

  const CheckoutLinkInput = z.object({
    url: z.string().min(1),
    quantity: z.number().int().min(1).optional(),
  });

  const adjust_checkout_quantity = new DynamicStructuredTool({
    name: "adjust_checkout_quantity",
    description:
      "Adjust a Shopify cart/checkout URL to set the desired quantity (best-effort). Use when user wants 2+ items and you already have a checkout URL.",
    schema: CheckoutLinkInput as any,
    func: async (input: any): Promise<string> => {
      const url = String(input?.url ?? "").trim();
      if (!url) return JSON.stringify({ ok: false, error: "Missing url" });

      const qty = clampQuantity(input?.quantity ?? 1, 1);
      const adjusted = withQuantityInCheckoutUrl(url, qty);

      return JSON.stringify({
        ok: true,
        url: adjusted,
        quantity: qty,
      });
    },
  });

  return {
    schemas: { OpenInBrowserInput, CheckoutLinkInput },
    tools: { open_in_browser, adjust_checkout_quantity },
  };
}
