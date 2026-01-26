// src/agent/tools/registry.ts
import type { McpClient } from "../mcp/types.js"; // not used directly but ok if you want to type things later

export type ToolEntry = {
  parse?: (args: any) => any;
  invoke: (args: any) => Promise<any>;
};

export type ToolRegistry = Map<string, ToolEntry>;
