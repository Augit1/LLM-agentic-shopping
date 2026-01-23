// src/shopify/mcp.ts
import type { McpClient } from "../mcp/types.js";
import { Env, DEBUG } from "../env.js";
import { HttpMcpClient } from "../mcp/httpClient.js";
import { StdioMcpClient } from "../mcp/stdioClient.js";
import { ShopifyTokenManager } from "../token.js";
import { cleanToken, tokenFingerprint } from "../utils/auth.js";

export async function createShopifyMcpClients(tokenMgr: ShopifyTokenManager) {
  const getAuthHeaders = async () => {
    const token = cleanToken(await tokenMgr.getToken());
    if (DEBUG) console.log("[token fp]", tokenFingerprint(token));
    return { authorization: `Bearer ${token}` };
  };

  const createMcp = async (urlOrCmd: string, kind: "catalog" | "checkout"): Promise<McpClient> => {
    if (Env.MCP_TRANSPORT === "http") {
      if (!urlOrCmd) throw new Error(`${kind} MCP URL missing`);
      return new HttpMcpClient(urlOrCmd, getAuthHeaders);
    }
    const token = cleanToken(await tokenMgr.getToken());
    return new StdioMcpClient(urlOrCmd, { BEARER_TOKEN: token, SHOPIFY_ACCESS_TOKEN: token });
  };

  const catalog = await createMcp(Env.CATALOG_MCP_URL ?? Env.CATALOG_MCP_CMD ?? "", "catalog");
  const checkout = await createMcp(Env.CHECKOUT_MCP_URL ?? Env.CHECKOUT_MCP_CMD ?? "", "checkout");
  void checkout;

  return { catalog, checkout };
}
