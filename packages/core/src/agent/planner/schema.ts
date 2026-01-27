// packages/core/src/agent/planner/schema.ts
import { z } from "zod";

export const PlannedCallSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.any()).default({}),
});

export const PlanSchema = z.object({
  // was max(2)
  tool_calls: z.array(PlannedCallSchema).max(3).default([]),
  rationale: z.string().optional(),
});

export type Plan = z.infer<typeof PlanSchema>;

export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

export function safeJsonParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
