import dotenv from "dotenv";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, "..", ".env");

if (!fs.existsSync(envPath)) {
  throw new Error(`.env not found at expected path: ${envPath}`);
}

// IMPORTANT: override shell env so .env wins (prevents “mystery bearer” issues)
dotenv.config({ path: envPath, override: true });

function decodeJwtPayload(jwt: string): any | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function requireNotExpired(jwt: string, skewSeconds = 120) {
  const payload = decodeJwtPayload(jwt);
  const exp = payload?.exp;
  if (typeof exp !== "number") return;
  const now = Math.floor(Date.now() / 1000);
  if (exp <= now + skewSeconds) {
    throw new Error(`BEARER_TOKEN expired/expiring soon. exp=${exp} (${new Date(exp * 1000).toISOString()})`);
  }
}

function requireScope(jwt: string, scope: string) {
  const payload = decodeJwtPayload(jwt);
  const scopes = String(payload?.scopes ?? "");
  if (!scopes.includes(scope)) {
    throw new Error(`BEARER_TOKEN missing required scope "${scope}". token.scopes="${scopes}"`);
  }
}

export const Env = z
  .object({
    // Ollama
    OLLAMA_URL: z.string().default("http://localhost:11434"),
    OLLAMA_MODEL: z.string().default("qwen2.5:7b-instruct"),

    // Shopify JWT (Bearer)
    BEARER_TOKEN: z.string().min(10),

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

    // Reliability / UX
    AUTO_OPEN_CHECKOUT: z.string().default("false"),

    // Debug
    MCP_DEBUG: z.string().optional(),

    // Optional tuning
    MCP_TIMEOUT_MS: z.coerce.number().default(15000),
    MCP_RETRIES: z.coerce.number().default(2),
  })
  .parse(process.env);

export const DEBUG = (Env.MCP_DEBUG ?? "").trim() === "1";
export const REQUIRE_YES = Env.REQUIRE_YES.toLowerCase() === "true";
export const AUTO_OPEN_CHECKOUT = Env.AUTO_OPEN_CHECKOUT.toLowerCase() === "true";

export const ALLOWED_SHIPS_TO = new Set(
  Env.ALLOWED_SHIPS_TO.split(",").map((s) => s.trim()).filter(Boolean),
);

// Validate transport config
if (Env.MCP_TRANSPORT === "http") {
  if (!Env.CATALOG_MCP_URL) throw new Error("MCP_TRANSPORT=http but CATALOG_MCP_URL is missing");
} else {
  if (!Env.CATALOG_MCP_CMD) throw new Error("MCP_TRANSPORT=stdio but CATALOG_MCP_CMD is missing");
}

// Validate token early
const token = Env.BEARER_TOKEN.trim();
requireNotExpired(token);
requireScope(token, "read_global_api_catalog_search");

// DEBUG-only diagnostics (never prints full token)
if (DEBUG) {
  const payload = decodeJwtPayload(token);
  const expIso = payload?.exp ? new Date(payload.exp * 1000).toISOString() : "unknown";
  console.log("[dotenv path]", envPath);
  console.log("[token len]", token.length, "[token tail]", token.slice(-8));
  console.log("[token exp]", expIso);
  console.log("[token scopes]", payload?.scopes ?? "unknown");
}
