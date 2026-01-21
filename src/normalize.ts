import { parseMcpJsonContent } from "./mcp/parseContent.js";

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

type ShopifySearchPayload = {
  offers?: any[];
};

export function normalizeSearchResult(raw: any, limitProducts = 3, limitVariants = 3) {
  const payload = parseMcpJsonContent<ShopifySearchPayload>(raw);
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
