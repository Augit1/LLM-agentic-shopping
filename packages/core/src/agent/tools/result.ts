// packages/core/src/agent/tools/result.ts

/**
 * Normalize tool outputs to a string so they can be safely injected into:
 * - SystemMessage context
 * - ToolMessage content
 *
 * This is intentionally tolerant because different tool wrappers can return:
 * - string
 * - ToolResult-like objects { ok, data/error }
 * - MCP raw payload objects
 */
export function toolResultToString(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;

  // Some tools might return { content: "..."} etc.
  try {
    return JSON.stringify(raw);
  } catch {
    // last resort
    return String(raw);
  }
}
