// packages/core/src/agent/tools/registry.ts

export type ToolEntry = {
  /**
   * Optional validator/parser for tool args (typically a zod schema parse)
   */
  parse?: (args: unknown) => any;

  /**
   * Executes the tool. Should return anything; caller will stringify via toolResultToString.
   */
  invoke: (args: unknown) => Promise<any>;
};
