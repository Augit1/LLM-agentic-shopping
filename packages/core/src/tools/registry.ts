import type { ToolSpec } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, ToolSpec<any, any>>();

  register(tool: ToolSpec<any, any>) {
    if (this.tools.has(tool.id)) throw new Error(`Tool already registered: ${tool.id}`);
    this.tools.set(tool.id, tool);
  }

  registerMany(tools: ToolSpec<any, any>[]) {
    for (const t of tools) this.register(t);
  }

  get(id: string) {
    return this.tools.get(id);
  }

  list() {
    return [...this.tools.values()];
  }
}
