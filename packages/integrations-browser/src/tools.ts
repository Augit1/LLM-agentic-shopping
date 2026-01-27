// src/browser/tools.ts
import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { McpClient } from "../../core/src/mcp/types.js";
import { mcpErrorMessage } from "../../core/src/utils/mcp.js";
import { parseMcpJsonText } from "../../core/src/utils/mcpContent.js";

type ReadPagePayload = {
  url?: string;
  title?: string;
  text?: string;
  markdown?: string;
  content?: string;
};

export async function buildBrowserTools(opts: { browser: McpClient }) {
  const { browser } = opts;

  const READ_TOOL = "read_page";

  const BrowserReadInput = z.object({
    url: z.string().url(),
  });

  const browser_read = new DynamicStructuredTool({
    name: "browser_read",
    description: "Fetch and extract readable content from a URL (for summarizing / answering questions about a page).",
    schema: BrowserReadInput as any,
    func: async (input: any): Promise<string> => {
      let raw: any;
      try {
        raw = await browser.callTool(READ_TOOL, { url: input.url });
      } catch (e: any) {
        return JSON.stringify({ ok: false, error: `Browser MCP failed: ${e?.message ?? String(e)}` });
      }

      const maybeErr = mcpErrorMessage(raw);
      if (maybeErr) return JSON.stringify({ ok: false, error: maybeErr });

      const parsed = parseMcpJsonText<ReadPagePayload>(raw) ?? {};
      const text = parsed.markdown ?? parsed.text ?? parsed.content ?? null;

      return JSON.stringify({
        ok: true,
        url: parsed.url ?? input.url,
        title: parsed.title ?? null,
        text,
      });
    },
  });

  return {
    schemas: { BrowserReadInput },
    tools: { browser_read },
  };
}
