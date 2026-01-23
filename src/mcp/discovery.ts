// src/mcp/discovery.ts
import type { McpClient } from "./types.js";

type ToolsListResult = {
  tools?: Array<{ name: string }>;
};

export async function resolveToolName(
  client: McpClient,
  candidates: string[],
): Promise<string | null> {
  let res: any;
  try {
    res = await client.listTools();
  } catch {
    return null;
  }

  // Many MCPs return { tools: [{ name }] } but keep this tolerant.
  const tools: string[] =
    (res?.tools ?? res?.result?.tools ?? [])
      .map((t: any) => t?.name)
      .filter((n: any) => typeof n === "string");

  if (!tools.length) return null;

  // Exact match first
  for (const c of candidates) {
    if (tools.includes(c)) return c;
  }

  // Fuzzy contains match (e.g. "web_search" vs "search_web")
  const lower = tools.map((n) => n.toLowerCase());
  for (const c of candidates) {
    const idx = lower.findIndex((n) => n.includes(c.toLowerCase()));
    if (idx >= 0) return tools[idx];
  }

  return null;
}
