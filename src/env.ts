import "dotenv/config";
import { z } from "zod";

export const Env = z.object({
  OLLAMA_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("qwen2.5:7b-instruct"),

  BEARER_TOKEN: z.string().min(10),

  MCP_TRANSPORT: z.enum(["http", "stdio"]).default("http"),

  CATALOG_MCP_URL: z.string().optional(),
  CHECKOUT_MCP_URL: z.string().optional(),

  CATALOG_MCP_CMD: z.string().optional(),
  CHECKOUT_MCP_CMD: z.string().optional(),

  MAX_TOTAL_USD: z.coerce.number().default(50),
  ALLOWED_SHIPS_TO: z.string().default("US"),
  REQUIRE_YES: z.string().default("true"),
  DEFAULT_CONTEXT: z.string().default(""),
}).parse(process.env);

export const REQUIRE_YES = Env.REQUIRE_YES.toLowerCase() === "true";
export const ALLOWED_SHIPS_TO = new Set(
  Env.ALLOWED_SHIPS_TO.split(",").map((s) => s.trim()).filter(Boolean),
);
