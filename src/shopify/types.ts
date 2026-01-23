// src/shopify/types.ts
export type OptionCard = {
  option_index: number;
  title: string;
  variant_id: number | null;
  price: string | null;
  currency: string | null;
  seller: string | null;
  bullets: string[];
  checkout_url: string | null; // internal only (LLM can use it later)
};
