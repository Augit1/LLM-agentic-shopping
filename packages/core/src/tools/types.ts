import { z } from "zod";

export type ToolId = string;

export type ToolResult<T = unknown> =
  | { ok: true; data: T; meta?: Record<string, any> }
  | { ok: false; error: { code: string; message: string; details?: any } };

export type ToolContext = {
  // shared runtime deps
  env: Record<string, string | undefined>;
  session: any; // or AgentSession type
  debug?: boolean;
};

export type ToolSpec<I extends z.ZodTypeAny, O = unknown> = {
  id: ToolId;
  description: string;
  input: I; // zod schema
  run(ctx: ToolContext, input: z.infer<I>): Promise<ToolResult<O>>;
};
