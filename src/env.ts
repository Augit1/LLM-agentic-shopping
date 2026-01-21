import "dotenv/config";
import { z } from "zod";

export const Env = z
  .object({
    // Ollama
    OLLAMA_URL: z.string().default("http://localhost:11434"),
    OLLAMA_MODEL: z.string().default("qwen2.5:7b-instruct"),

    // Bearer: optional now (can be auto-generated)
    BEARER_TOKEN: z.string().optional(),

    // Auto-token generation (client credentials)
    SHOPIFY_CLIENT_ID: z.string().optional(),
    SHOPIFY_CLIENT_SECRET: z.string().optional(),

    // Token cache file (recommended)
    TOKEN_CACHE_PATH: z.string().default(".cache/shopify_token.json"),

    // MCP transport
    MCP_TRANSPORT: z.enum(["http", "stdio"]).default("http"),
    CATALOG_MCP_URL: z.string().optional(),
    CHECKOUT_MCP_URL: z.string().optional(),
    CATALOG_MCP_CMD: z.string().optional(),
    CHECKOUT_MCP_CMD: z.string().optional(),

    // Safety / policy
    MAX_TOTAL_USD: z.coerce.number().default(50),
    ALLOWED_SHIPS_TO: z.string().default("US"),
    REQUIRE_YES: z.string().default("true"),
    DEFAULT_CONTEXT: z.string().default(""),
	MAX_QUANTITY: z.coerce.number().default(5),

    // Logs
    MCP_DEBUG: z.string().default("0"),

    // UX
    AUTO_OPEN_CHECKOUT: z.string().default("true"),
  })
  .parse(process.env);

export const REQUIRE_YES = Env.REQUIRE_YES.toLowerCase() === "true";
export const DEBUG = Env.MCP_DEBUG === "1" || Env.MCP_DEBUG.toLowerCase() === "true";
export const AUTO_OPEN_CHECKOUT = Env.AUTO_OPEN_CHECKOUT.toLowerCase() === "true";

export const ALLOWED_SHIPS_TO = new Set(
  Env.ALLOWED_SHIPS_TO.split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);
