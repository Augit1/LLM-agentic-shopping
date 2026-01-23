// src/shopify/cards.ts
import type { NormalizedVariant } from "../normalize.js";
import type { OptionCard } from "./types.js";
import { hostFromUrl } from "../utils/url.js";
import { formatMoney, inferCondition, pickKeyBullets } from "../utils/format.js";

export function toOptionCard(v: NormalizedVariant, optionIndex: number): OptionCard {
  const seller = hostFromUrl(v.shopUrl) ?? null;
  const money = formatMoney(v.priceUsd ?? null, v.currency ?? "USD");
  const condition = inferCondition(v.title, v.options ?? {}) ?? ((v.options as any)?.Condition ?? null);

  const bullets = pickKeyBullets(v.options ?? {});
  if (condition && !bullets.some((b) => b.toLowerCase().startsWith("condition:"))) {
    bullets.unshift(`Condition: ${condition}`);
  }

  return {
    option_index: optionIndex,
    title: v.title,
    variant_id: v.variantId ?? null,
    price: money,
    currency: v.currency ?? null,
    seller,
    bullets: bullets.slice(0, 3),
    checkout_url: v.checkoutUrl ?? null,
  };
}
