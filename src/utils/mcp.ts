// src/utils/mcp.ts
export function mcpErrorMessage(raw: any): string | null {
  const isError = raw?.isError ?? raw?.result?.isError;
  if (!isError) return null;

  const content = raw?.content ?? raw?.result?.content;
  if (Array.isArray(content)) {
    const msg = content.map((c: any) => c?.text).filter(Boolean).join("\n");
    return msg || "Unknown MCP error";
  }
  return "Unknown MCP error";
}
