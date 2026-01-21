import { Env } from "../env.js";
import { McpClient, JsonRpcRequest, JsonRpcResponse } from "./types.js";

const DEBUG = (process.env.MCP_DEBUG ?? "").trim() === "1";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function redact(headers: Record<string, string>) {
  const out: Record<string, string> = { ...headers };
  const k = Object.keys(out).find((x) => x.toLowerCase() === "authorization");
  if (k && out[k]) out[k] = out[k].replace(/Bearer\s+.*/i, "Bearer ***");
  return out;
}

function asCurl(url: string, headers: Record<string, string>, body: any) {
  const h = Object.entries(headers)
    .map(([k, v]) => `-H "${k}: ${String(v).replace(/"/g, '\\"')}"`)
    .join(" ");
  const b = JSON.stringify(body).replace(/'/g, `'\\''`);
  return `curl -sS "${url}" ${h} -d '${b}'`;
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

export class HttpMcpClient implements McpClient {
  private id = 1;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  private async rpc(method: string, params?: any) {
    const req: JsonRpcRequest = { jsonrpc: "2.0", id: this.id++, method, params };

    // Force lowercase authorization header key (matches your successful curl)
    const authValue =
      this.headers.authorization ??
      (this.headers as any).Authorization ??
      (this.headers as any).AUTHORIZATION;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(authValue ? { authorization: authValue } : {}),
      ...Object.fromEntries(Object.entries(this.headers).filter(([k]) => k.toLowerCase() !== "authorization")),
    };

    const maxRetries = Env.MCP_RETRIES ?? 2;
    const timeoutMs = Env.MCP_TIMEOUT_MS ?? 15000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        if (DEBUG) {
          console.log("[MCP->] url:", this.url);
          console.log("[MCP->] headers:", redact(headers));
          console.log("[MCP->] method:", method);
          console.log("[MCP->] params:", JSON.stringify(params));
          console.log("\n[MCP CURL]\n" + asCurl(this.url, headers, req) + "\n");
        }

        const res = await fetch(this.url, {
          method: "POST",
          headers,
          body: JSON.stringify(req),
          signal: controller.signal,
        });

        const text = await res.text();

        if (DEBUG) {
          console.log("[MCP<-] status:", res.status, res.statusText);
          console.log("[MCP<-] body:", text.slice(0, 2000));
        }

        let json: JsonRpcResponse;
        try {
          json = JSON.parse(text) as JsonRpcResponse;
        } catch {
          // Retry parsing failures only if HTTP status is retryable (rare)
          if (!res.ok && isRetryableStatus(res.status) && attempt < maxRetries) {
            await sleep(250 * Math.pow(2, attempt));
            continue;
          }
          throw new Error(`MCP HTTP ${res.status}: non-JSON response: ${text.slice(0, 300)}`);
        }

        if (!res.ok) {
          if (isRetryableStatus(res.status) && attempt < maxRetries) {
            await sleep(250 * Math.pow(2, attempt));
            continue;
          }
          const msg = json.error?.message ?? `HTTP ${res.status} ${res.statusText}`;
          throw new Error(`MCP HTTP error: ${msg}`);
        }

        if (json.error) {
          throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
        }

        return json.result;
      } catch (e: any) {
        const isAbort = e?.name === "AbortError";
        const retryable = isAbort || /ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed/i.test(String(e?.message ?? e));

        if (attempt < maxRetries && retryable) {
          if (DEBUG) console.log(`[MCP] retrying after error (attempt ${attempt + 1}/${maxRetries})`, e?.message ?? e);
          await sleep(250 * Math.pow(2, attempt));
          continue;
        }

        throw e;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error("MCP request failed after retries");
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
