// packages/integrations-browser/src/tools.ts
import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { McpClient } from "../../core/src/mcp/types.js";
import { mcpErrorMessage } from "../../core/src/utils/mcp.js";
import { parseMcpJsonText } from "../../core/src/utils/mcpContent.js";
import { resolveToolName } from "../../core/src/mcp/discovery.js";

type ReadPagePayload = {
  url?: string;
  title?: string;
  text?: string;
  markdown?: string;
  content?: string;
};

export async function buildBrowserTools(opts: { browser: McpClient }) {
  const { browser } = opts;

  // 🔎 Discover the server's actual "read page" tool name.
  // Different MCP servers expose different tool ids.
  const READ_TOOL =
    (await resolveToolName(browser, [
      "read_page",
      "browser_read",
      "read",
      "fetch",
      "get_page",
      "page_read",
      "open_page",
    ])) ?? null;

  const BrowserReadInput = z.object({
    url: z.string().url(),
  });

  const browser_read = new DynamicStructuredTool({
    name: "browser_read",
    description:
      "Fetch and extract readable content from a URL (for summarizing / answering questions about a page).",
    schema: BrowserReadInput as any,
    func: async (input: any): Promise<string> => {
      if (!READ_TOOL) {
        // Make the error self-diagnosing
        let listed: any = null;
        try {
          listed = await browser.listTools();
        } catch {}
        return JSON.stringify({
          ok: false,
          error:
            "Browser MCP has no compatible read tool (expected something like read_page/read/fetch).",
          tools_list: listed ?? null,
        });
      }

      let raw: any;
      try {
        raw = await browser.callTool(READ_TOOL, { url: input.url });
      } catch (e: any) {
        return JSON.stringify({
          ok: false,
          error: `Browser MCP failed calling "${READ_TOOL}": ${e?.message ?? String(e)}`,
        });
      }

      const maybeErr = mcpErrorMessage(raw);
      if (maybeErr) return JSON.stringify({ ok: false, error: maybeErr });

      const parsed = parseMcpJsonText<ReadPagePayload>(raw) ?? {};
      const text = parsed.markdown ?? parsed.text ?? parsed.content ?? null;

      return JSON.stringify({
        ok: true,
        tool_used: READ_TOOL,
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
