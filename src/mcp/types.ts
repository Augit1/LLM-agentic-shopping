export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: any;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
};

export interface McpClient {
  listTools(): Promise<any>;
  callTool(name: string, args: Record<string, any>): Promise<any>;
  close(): Promise<void>;
}
