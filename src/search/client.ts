// src/search/client.ts
import { Env, DEBUG } from "../env.js";

function redact(s?: string) {
  if (!s) return "(none)";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

export type TavilySearchParams = {
  query: string;
  max_results?: number;
  search_depth?: "basic" | "advanced";
  include_answer?: boolean;
  include_raw_content?: boolean;
  include_domains?: string[];
  exclude_domains?: string[];
};

export type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
};

export type TavilyResponse = {
  answer?: string;
  results?: TavilyResult[];
};

export function createTavilyClient() {
  const apiKey = (Env.TAVILY_API_KEY ?? "").trim();
  const url = (Env.TAVILY_API_URL ?? "https://api.tavily.com/search").trim();

  if (!apiKey) throw new Error("Missing TAVILY_API_KEY in .env");
  if (!url) throw new Error("Missing TAVILY_API_URL in .env");

  if (DEBUG) {
    console.log("[tavily url]", url);
    console.log("[tavily key]", redact(apiKey));
  }

  return {
    async search(params: TavilySearchParams): Promise<TavilyResponse> {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query: params.query,
          max_results: params.max_results ?? 5,
          search_depth: params.search_depth ?? "basic",
          include_answer: params.include_answer ?? true,
          include_raw_content: params.include_raw_content ?? false,
          include_domains: params.include_domains,
          exclude_domains: params.exclude_domains,
        }),
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Tavily HTTP ${res.status}: ${text.slice(0, 400)}`);
      }

      try {
        return JSON.parse(text) as TavilyResponse;
      } catch {
        throw new Error(`Tavily non-JSON response: ${text.slice(0, 400)}`);
      }
    },
  };
}
