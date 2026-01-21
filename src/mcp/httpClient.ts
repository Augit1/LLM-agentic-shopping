import { McpClient, JsonRpcRequest, JsonRpcResponse } from "./types.js";

export class HttpMcpClient implements McpClient {
  private id = 1;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  private async rpc(method: string, params?: any) {
    const req: JsonRpcRequest = { jsonrpc: "2.0", id: this.id++, method, params };

    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(req),
    });

    const text = await res.text();

    let json: JsonRpcResponse;
    try {
      json = JSON.parse(text) as JsonRpcResponse;
    } catch (e) {
      throw new Error(
        `MCP HTTP ${res.status} ${res.statusText}: failed to parse JSON response.\n` +
          `Response body:\n${text}`,
      );
    }

    if (!res.ok) {
      // Sometimes servers still respond with JSON-RPC error structure; include both.
      const msg =
        (json as any)?.error?.message ??
        `HTTP ${res.status} ${res.statusText}`;
      throw new Error(`MCP request failed: ${msg}\nResponse body:\n${text}`);
    }

    if ((json as any).error) {
      const err = (json as any).error;
      throw new Error(`MCP error ${err.code}: ${err.message}`);
    }

    return (json as any).result;
  }

  async listTools() {
    return this.rpc("tools/list");
  }

  async callTool(name: string, args: Record<string, any>) {
    return this.rpc("tools/call", { name, arguments: args });
  }

  async close() {
    // no-op for HTTP
  }
}
