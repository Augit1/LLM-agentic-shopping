// src/browser/mcp.ts
import type { McpClient } from "../mcp/types.js";
import { Env, DEBUG } from "../env.js";
import { HttpMcpClient } from "../mcp/httpClient.js";

function redact(s?: string) {
  if (!s) return "(none)";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

export async function createBrowserMcpClient(): Promise<McpClient> {
  const url = Env.BROWSER_MCP_URL ?? "";
  if (!url) throw new Error("Missing BROWSER_MCP_URL in .env");

  const getHeaders = async () => {
    const h: Record<string, string> = {};
    const key = (Env.BROWSER_MCP_API_KEY ?? "").trim();
    if (key) h["authorization"] = `Bearer ${key}`;
    return h;
  };

  if (DEBUG) {
    console.log("[browser mcp url]", url);
    console.log("[browser mcp key]", redact((Env.BROWSER_MCP_API_KEY ?? "").trim()));
  }

  return new HttpMcpClient(url, getHeaders);
}
