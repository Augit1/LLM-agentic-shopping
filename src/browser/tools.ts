// src/browser/tools.ts
import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { McpClient } from "../mcp/types.js";
import { resolveToolName } from "../mcp/discovery.js";
import { mcpErrorMessage } from "../utils/mcp.js";
import { parseMcpJsonText } from "../utils/mcpContent.js";

type ReadPagePayload = {
  url?: string;
  title?: string;
  text?: string;
  markdown?: string;
  content?: string;
};

export async function buildBrowserTools(opts: { browser: McpClient }) {
  const { browser } = opts;

  const readToolName =
    (await resolveToolName(browser, ["read_page", "page_read", "extract_text", "read", "content"])) ?? "read_page";

  const openToolName =
    (await resolveToolName(browser, ["goto", "open", "navigate"])) ?? null;

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
        raw = await browser.callTool(readToolName, { url: input.url });
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

  const BrowserOpenInput = z.object({
    url: z.string().url(),
  });

  const browser_open: any = new DynamicStructuredTool({
    name: "browser_open",
    description:
      "Open/navigate to a URL in the browser MCP session (if supported). Usually used before further interactions.",
    schema: BrowserOpenInput as any,
    func: async (input: any): Promise<string> => {
      if (!openToolName) {
        return JSON.stringify({ ok: false, error: "Browser MCP does not expose an open/goto tool." });
      }
      try {
        const raw = await browser.callTool(openToolName, { url: input.url });
        const maybeErr = mcpErrorMessage(raw);
        if (maybeErr) return JSON.stringify({ ok: false, error: maybeErr });
        return JSON.stringify({ ok: true, url: input.url });
      } catch (e: any) {
        return JSON.stringify({ ok: false, error: `Browser MCP failed: ${e?.message ?? String(e)}` });
      }
    },
  });

  return {
    schemas: { BrowserReadInput, BrowserOpenInput },
    tools: { browser_read, browser_open },
    meta: { readToolName, openToolName },
  };
}
