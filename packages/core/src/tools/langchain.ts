import { DynamicStructuredTool } from "@langchain/core/tools";
import type { ToolSpec, ToolContext } from "./types.js";

export function toLangChainTool(spec: ToolSpec<any, any>, ctx: ToolContext) {
  return new DynamicStructuredTool({
    name: spec.id,
    description: spec.description,
    schema: spec.input as any,
    func: async (input: any) => {
      const parsed = spec.input.parse(input);
      const out = await spec.run(ctx, parsed);
      return JSON.stringify(out);
    },
  });
}
