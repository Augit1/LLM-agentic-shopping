export type NormalizedVariant = {
  upid?: string;
  variantGid?: string;
  variantId?: number;
  title: string;
  shopUrl?: string;
  priceUsd?: number;
  currency?: string;
  options?: Record<string, string>;
  variantUrl?: string;
  checkoutUrl?: string;
};

type ShopifySearchPayload = { offers?: any[] };

function parseShopifyMcpPayload(raw: any): ShopifySearchPayload {
  // Shopify MCP returns: { content: [ { type:"text", text:"{...json...}" } ], isError?: boolean }
  const isError = raw?.isError ?? raw?.result?.isError;
  if (isError) {
    const content = raw?.content ?? raw?.result?.content;
    const msg =
      Array.isArray(content) ? content.map((c: any) => c?.text).filter(Boolean).join("\n") : "MCP returned isError=true";
    throw new Error(msg || "MCP returned isError=true");
  }

  const content = raw?.content ?? raw?.result?.content;
  const firstText = Array.isArray(content) ? content?.[0]?.text : undefined;
  if (!firstText) return { offers: [] };

  try {
    return JSON.parse(firstText) as ShopifySearchPayload;
  } catch {
    return { offers: [] };
  }
}

export function normalizeSearchResult(raw: any, limitProducts = 3, limitVariants = 3) {
  const payload = parseShopifyMcpPayload(raw);
  const offers = payload?.offers ?? [];

  const out: Array<{ title: string; upid?: string; variants: NormalizedVariant[] }> = [];

  for (const offer of offers.slice(0, limitProducts)) {
    const title = offer.title ?? "Untitled product";
    const upid = offer.id;

    const variants = (offer.variants ?? [])
      .slice(0, limitVariants)
      .map((v: any) => {
        const options: Record<string, string> = {};
        for (const o of v.options ?? []) options[o.name] = o.value;

        return {
          upid,
          variantGid: v.id,
          variantId: extractVariantId(v.id),
          title: v.displayName ?? title,
          shopUrl: v.shop?.onlineStoreUrl,
          priceUsd: typeof v.price?.amount === "number" ? v.price.amount / 100 : undefined,
          currency: v.price?.currency,
          options,
          variantUrl: v.variantUrl,
          checkoutUrl: v.checkoutUrl,
        };
      });

    out.push({ title, upid, variants });
  }

  return out;
}

function extractVariantId(gid?: string): number | undefined {
  if (!gid) return;
  const m = String(gid).match(/ProductVariant\/(\d+)/);
  return m ? Number(m[1]) : undefined;
}
