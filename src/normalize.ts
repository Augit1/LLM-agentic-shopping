export type NormalizedVariant = {
  upid?: string;
  variantGid?: string;
  /**
   * Use string for safety:
   * Shopify IDs can exceed JS safe integer range and may be compared as strings.
   */
  variantId?: string;
  title: string;
  shopDomain?: string; // onlineStoreUrl
  priceUsd?: number;
  currency?: string;
  options?: Record<string, string>;
  variantUrl?: string;
  checkoutUrl?: string;
};

type NormalizedProduct = {
  title: string;
  upid?: string;
  variants: NormalizedVariant[];
};

export function normalizeSearchResult(raw: any, limitProducts = 3, limitVariants = 3): NormalizedProduct[] {
  const offers = extractOffers(raw);
  const out: NormalizedProduct[] = [];

  for (const offer of offers.slice(0, limitProducts)) {
    const title = offer?.title ?? "Untitled product";
    const upid = offer?.id;

    const variants = (offer?.variants ?? [])
      .slice(0, limitVariants)
      .map((v: any): NormalizedVariant => {
        // v.options may be array of {name,value}, or missing
        const options: Record<string, string> = {};
        if (Array.isArray(v?.options)) {
          for (const o of v.options) {
            if (o?.name && o?.value != null) options[String(o.name)] = String(o.value);
          }
        } else if (v?.options && typeof v.options === "object") {
          // Sometimes tools already normalize options into an object
          for (const [k, val] of Object.entries(v.options)) options[String(k)] = String(val);
        }

        const priceAmount = v?.price?.amount;
        const priceUsd = typeof priceAmount === "number" ? priceAmount / 100 : undefined;

        return {
          upid,
          variantGid: v?.id,
          variantId: extractVariantId(v?.id),
          title: v?.displayName ?? title,
          shopDomain: v?.shop?.onlineStoreUrl,
          priceUsd,
          currency: v?.price?.currency,
          options,
          variantUrl: v?.variantUrl,
          checkoutUrl: v?.checkoutUrl,
        };
      })
      .filter((v: NormalizedVariant) => !!v.variantGid); // keep sane entries

    out.push({ title, upid, variants });
  }

  return out;
}

/**
 * Shopify MCP HTTP responses typically look like:
 *   { content: [ { type:"text", text:"{\"offers\":[...], ...}" } ], isError:false }
 *
 * But depending on client/wrapping you might also get:
 *   { result: { content: [...] } }
 * or already-parsed:
 *   { offers: [...] }
 *
 * This function extracts offers robustly from all those shapes.
 */
function extractOffers(raw: any): any[] {
  if (!raw) return [];

  // If already parsed
  if (Array.isArray(raw.offers)) return raw.offers;

  // Some clients return { result: { content: [...] } }
  const content = raw?.content ?? raw?.result?.content;
  if (Array.isArray(content)) {
    const textItem = content.find((c: any) => c?.type === "text" && typeof c?.text === "string");
    if (textItem?.text) {
      const parsed = tryParseJson(textItem.text);
      if (parsed && Array.isArray(parsed.offers)) return parsed.offers;
    }
  }

  // Some code mistakenly passes raw.content[0].text as object — handle just in case
  const maybeText = raw?.content?.[0]?.text;
  if (typeof maybeText === "string") {
    const parsed = tryParseJson(maybeText);
    if (parsed && Array.isArray(parsed.offers)) return parsed.offers;
  }
  if (maybeText && typeof maybeText === "object" && Array.isArray((maybeText as any).offers)) {
    return (maybeText as any).offers;
  }

  return [];
}

function tryParseJson(s: string): any | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Extracts the numeric variant id from a GID string:
 *   gid://shopify/ProductVariant/50244839964988?shop=27870602
 *
 * Returns a string id to avoid JS integer precision issues.
 */
function extractVariantId(gid?: string): string | undefined {
  if (!gid) return;
  const m = String(gid).match(/ProductVariant\/(\d+)/);
  return m ? m[1] : undefined;
}
