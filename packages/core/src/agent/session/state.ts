// packages/core/src/agent/session/state.ts
export type ShopifyOption = {
  option_index: number;
  title: string;
  variant_id: number | string;
  price: string;
  currency?: string;
  seller?: string;
  bullets?: string[];
  product_url?: string;   // <-- NEW
  checkout_url?: string;
};

export type ShopifySearchResult = {
  ok: boolean;
  ships_to?: string;
  query?: string;
  options?: ShopifyOption[];
  needs?: string;
  message?: string;
};

export type AgentSession = {
  lastShipsTo: string | null;
  lastShopifyOptions: ShopifyOption[] | null;
  lastShopifyQuery: string | null;

  selectedOptionIndex: number | null;
  selectedQuantity: number | null;
};

export const session: AgentSession = {
  lastShipsTo: null,
  lastShopifyOptions: null,
  lastShopifyQuery: null,

  selectedOptionIndex: null,
  selectedQuantity: null,
};
