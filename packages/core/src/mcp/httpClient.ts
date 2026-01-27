import { JsonRpcRequest, JsonRpcResponse, McpClient } from "./types.js";
import { DEBUG } from "../env.js";

type HeadersLike = Record<string, string> | (() => Promise<Record<string, string>>);

function redactAuth(headers: Record<string, string>) {
  const out: Record<string, string> = { ...headers };
  for (const k of Object.keys(out)) {
    if (k.toLowerCase() === "authorization") out[k] = "Bearer ***";
  }
  return out;
}

export class HttpMcpClient implements McpClient {
  private id = 1;

  constructor(
    private readonly url: string,
    private readonly headers: HeadersLike,
  ) {}

  private async getHeaders(): Promise<Record<string, string>> {
    if (typeof this.headers === "function") return this.headers();
    return this.headers;
  }

  private async rpc(method: string, params?: any) {
    const req: JsonRpcRequest = { jsonrpc: "2.0", id: this.id++, method, params };
    const headers = await this.getHeaders();

    if (DEBUG) {
      console.log(`[MCP->] url: ${this.url}`);
      console.log(`[MCP->] headers:`, redactAuth({ "content-type": "application/json", ...headers }));
      console.log(`[MCP->] method: ${method}`);
      console.log(`[MCP->] params:`, JSON.stringify(params ?? {}));
      console.log();
    }

    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(req),
    });

    const text = await res.text();
    let json: JsonRpcResponse;
    try {
      json = JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new Error(`MCP non-JSON response: ${res.status} ${text.slice(0, 400)}`);
    }

    if (DEBUG) {
      console.log(`[MCP<-] status: ${res.status} ${res.statusText}`);
      console.log(`[MCP<-] body: ${text.slice(0, 1200)}${text.length > 1200 ? "..." : ""}`);
      console.log();
    }

    if (json.error) throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
    return json.result;
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
