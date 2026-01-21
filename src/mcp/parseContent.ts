import { z } from "zod";

const McpTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const McpCallResultSchema = z.object({
  content: z.array(McpTextContentSchema).default([]),
  isError: z.boolean().optional(),
});

export function parseMcpJsonContent<T>(result: unknown): T {
  const parsed = McpCallResultSchema.parse(result);

  const first = parsed.content[0];
  if (!first) {
    throw new Error("MCP result.content is empty");
  }

  try {
    return JSON.parse(first.text) as T;
  } catch (e) {
    throw new Error(
      `Failed to JSON.parse MCP content[0].text: ${(e as Error).message}`
    );
  }
}
