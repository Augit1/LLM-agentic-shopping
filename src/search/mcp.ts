// src/search/mcp.ts
import type { McpClient } from "../mcp/types.js";
import { Env, DEBUG } from "../env.js";
import { HttpMcpClient } from "../mcp/httpClient.js";

function redact(s?: string) {
  if (!s) return "(none)";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

export async function createSearchMcpClient(): Promise<McpClient> {
  const url = Env.TAVILY_API_URL ?? "";
  if (!url) throw new Error("Missing TAVILY_API_KEY in .env");

  const getHeaders = async () => {
    const h: Record<string, string> = {};
    const key = (Env.TAVILY_API_KEY ?? "").trim();
    if (key) h["authorization"] = `Bearer ${key}`;
    return h;
  };

  if (DEBUG) {
    console.log("[search mcp url]", url);
    console.log("[search mcp key]", redact((Env.TAVILY_API_KEY ?? "").trim()));
  }

  return new HttpMcpClient(url, getHeaders);
}
