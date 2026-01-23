// src/browser/tools.ts
import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { McpClient } from "../mcp/types.js";
import { mcpErrorMessage } from "../utils/mcp.js";
import { parseMcpJsonText } from "../utils/mcpContent.js";

/**
 * IMPORTANT:
 * Streamable HTTP Browser MCPs (202 Accepted + SSE)
 * do NOT support synchronous tools/list.
 *
 * Therefore we DO NOT call resolveToolName here.
 * We assume standard tool names.
 */

type ReadPagePayload = {
  url?: string;
  title?: string;
  text?: string;
  markdown?: string;
  content?: string;
};

export async function buildBrowserTools(opts: { browser: McpClient }) {
  const { browser } = opts;

  // Hard-coded tool names (correct for most browser MCPs)
  const READ_TOOL = "read_page";
  const OPEN_TOOL = "open";

  const BrowserReadInput = z.object({
    url: z.string().url(),
  });

  const browser_read = new DynamicStructuredTool({
    name: "browser_read",
    description:
      "Fetch and extract readable content from a web page for summarization or analysis.",
    schema: BrowserReadInput as any,
    func: async (input: any): Promise<string> => {
      let raw: any;
      try {
        raw = await browser.callTool(READ_TOOL, { url: input.url });
      } catch (e: any) {
        return JSON.stringify({ ok: false, error: e?.message ?? String(e) });
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

  const browser_open = new DynamicStructuredTool({
    name: "browser_open",
    description: "Open or navigate to a URL in the browser session.",
    schema: BrowserOpenInput as any,
    func: async (input: any): Promise<string> => {
      try {
        const raw = await browser.callTool(OPEN_TOOL, { url: input.url });
        const maybeErr = mcpErrorMessage(raw);
        if (maybeErr) return JSON.stringify({ ok: false, error: maybeErr });
        return JSON.stringify({ ok: true, url: input.url });
      } catch (e: any) {
        return JSON.stringify({ ok: false, error: e?.message ?? String(e) });
      }
    },
  });

  return {
    schemas: { BrowserReadInput, BrowserOpenInput },
    tools: { browser_read, browser_open },
  };
}
