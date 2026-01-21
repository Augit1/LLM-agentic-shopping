import { z } from "zod";

const McpTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const McpCallResultSchema = z.object({
  content: z.array(McpTextContentSchema).default([]),
  isError: z.boolean().optional(),
});

const JsonRpcWrapperSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.number(), z.string()]).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

function isObject(x: unknown): x is Record<string, any> {
  return typeof x === "object" && x !== null;
}

export function parseMcpJsonContent<T>(input: unknown): T {
  // Accept JSON-RPC wrapper or direct result
  let candidate: unknown = input;

  const wrapperParsed = JsonRpcWrapperSchema.safeParse(input);
  if (wrapperParsed.success && wrapperParsed.data.result !== undefined) {
    candidate = wrapperParsed.data.result;
  }

  // If it already looks like a parsed object with offers, return directly
  if (isObject(candidate) && ("offers" in candidate || "instructions" in candidate)) {
    return candidate as T;
  }

  const parsed = McpCallResultSchema.parse(candidate);

  const first = parsed.content[0];
  if (!first) throw new Error("MCP result.content is empty");

  try {
    return JSON.parse(first.text) as T;
  } catch (e) {
    throw new Error(`Failed to JSON.parse MCP content[0].text: ${(e as Error).message}`);
  }
}
