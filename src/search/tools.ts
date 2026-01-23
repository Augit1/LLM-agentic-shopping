// src/search/tools.ts
import { z } from "zod";
import { createTavilyClient } from "./client.js";

export async function buildSearchTools() {
  const tavily = createTavilyClient();

  const WebSearchInput = z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(10).optional(),
    depth: z.enum(["basic", "advanced"]).optional(),
  });

  const web_search = {
    name: "web_search",
    description:
      "Search the web for up-to-date information. Use when the user asks for comparisons, sources, recent info, or you need to verify something.",
    schema: WebSearchInput,
    async invoke(args: unknown) {
      const input = WebSearchInput.parse(args);
      const limit = input.limit ?? 5;

      try {
        const out = await tavily.search({
          query: input.query,
          max_results: limit,
          search_depth: input.depth ?? "basic",
          include_answer: true,
          include_raw_content: false,
        });

        const results = (out.results ?? []).slice(0, limit).map((r) => ({
          title: r.title ?? null,
          url: r.url ?? null,
          snippet: r.content ?? null,
        }));

        return JSON.stringify({
          ok: true,
          query: input.query,
		  answer: out.answer ?? null,
          results: (out.results ?? []).slice(0, limit).map(r => ({
    		title: r.title ?? null,
    		url: r.url ?? null,
    		snippet: r.content ?? null,
    		score: r.score ?? null,
		  })),
        });
      } catch (e: any) {
        return JSON.stringify({ ok: false, error: e?.message ?? String(e) });
      }
    },
  };

  return {
    schemas: { WebSearchInput },
    tools: { web_search },
  };
}
