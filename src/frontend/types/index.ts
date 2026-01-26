export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
};

export type ProductOption = {
  option_index: number;
  title: string;
  variant_id: number | string;
  price: string;
  currency?: string;
  seller?: string;
  bullets?: string[];
  checkout_url?: string;
};

export type ChatRequest = {
  message: string;
  history: Message[];
};

export type ChatResponse = {
  message: string;
  productOptions?: ProductOption[];
};

