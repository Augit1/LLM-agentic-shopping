import { spawn } from "node:child_process";
import readline from "node:readline";
import { McpClient, JsonRpcRequest, JsonRpcResponse } from "./types.js";

export class StdioMcpClient implements McpClient {
  private id = 1;
  private proc;
  private rl;
  private pending = new Map<number, (res: JsonRpcResponse) => void>();

  constructor(command: string, env: Record<string, string>) {
    const [cmd, ...args] = splitCmd(command);
    this.proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });

    this.rl.on("line", (line) => {
      line = line.trim();
      if (!line) return;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (typeof msg?.id === "number" && this.pending.has(msg.id)) {
          const resolve = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        // ignore non-JSON logs
      }
    });
  }

  private rpc(method: string, params?: any) {
    const id = this.id++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const payload = JSON.stringify(req);
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, (res) => {
        if (res.error) reject(new Error(`MCP error ${res.error.code}: ${res.error.message}`));
        else resolve(res.result);
      });
      this.proc.stdin.write(payload + "\n");
    });
  }

  async listTools() {
    return this.rpc("tools/list");
  }

  async callTool(name: string, args: Record<string, any>) {
    return this.rpc("tools/call", { name, arguments: args });
  }

  async close() {
    this.rl.close();
    this.proc.kill();
  }
}

function splitCmd(s: string): string[] {
  // simple split, assumes no quotes; good enough for POC
  return s.split(" ").filter(Boolean);
}
