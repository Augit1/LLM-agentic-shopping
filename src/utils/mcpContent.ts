// src/utils/mcpContent.ts
export function parseMcpJsonText<T>(raw: any): T | null {
  const isError = raw?.isError ?? raw?.result?.isError;
  if (isError) return null;

  const content = raw?.content ?? raw?.result?.content;
  const firstText = Array.isArray(content) ? content?.[0]?.text : undefined;
  if (!firstText || typeof firstText !== "string") return null;

  try {
    return JSON.parse(firstText) as T;
  } catch {
    return null;
  }
}
