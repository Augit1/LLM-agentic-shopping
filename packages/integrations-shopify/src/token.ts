import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Env, DEBUG } from "../../core/src/env.js";

type TokenCache = {
  access_token: string;
  expires_at_ms: number; // epoch ms
  token_type?: string;
  scope?: string;
};

function fp(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

async function readCache(cachePath: string): Promise<TokenCache | null> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as TokenCache;
    if (!parsed?.access_token || !parsed?.expires_at_ms) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, cache: TokenCache): Promise<void> {
  const dir = path.dirname(cachePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8");
}

function nowMs() {
  return Date.now();
}

function isExpiringSoon(expiresAtMs: number, skewMs: number) {
  return expiresAtMs - nowMs() <= skewMs;
}

export class ShopifyTokenManager {
  private inMemory: TokenCache | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly opts: {
      cachePath: string;
      refreshSkewMs: number; // refresh if token expires within this window
    },
  ) {}

  async getToken(): Promise<string> {
    // Prefer explicit BEARER_TOKEN if user provided one (manual override)
    const manual = (Env.BEARER_TOKEN ?? "").trim();
    if (manual) return cleanToken(manual);

    // De-dupe concurrent refreshes
    if (this.inflight) return this.inflight;

    this.inflight = this._getTokenInner().finally(() => {
      this.inflight = null;
    });

    return this.inflight;
  }

  private async _getTokenInner(): Promise<string> {
    // 1) in-memory cache
    if (this.inMemory && !isExpiringSoon(this.inMemory.expires_at_ms, this.opts.refreshSkewMs)) {
      return this.inMemory.access_token;
    }

    // 2) file cache
    const disk = await readCache(this.opts.cachePath);
    if (disk && !isExpiringSoon(disk.expires_at_ms, this.opts.refreshSkewMs)) {
      this.inMemory = disk;
      if (DEBUG) console.log(`[token] using cached token fp=${fp(disk.access_token)}`);
      return disk.access_token;
    }

    // 3) fetch a new one
    const fresh = await fetchNewToken();
    this.inMemory = fresh;
    await writeCache(this.opts.cachePath, fresh);

    if (DEBUG) {
      const ttl = Math.max(0, Math.floor((fresh.expires_at_ms - nowMs()) / 1000));
      console.log(`[token] fetched new token fp=${fp(fresh.access_token)} ttl=${ttl}s scope=${fresh.scope ?? ""}`);
    }

    return fresh.access_token;
  }
}

function cleanToken(x: string) {
  return (x ?? "").trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
}

async function fetchNewToken(): Promise<TokenCache> {
  const clientId = (Env.SHOPIFY_CLIENT_ID ?? "").trim();
  const clientSecret = (Env.SHOPIFY_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET in .env (required when BEARER_TOKEN is not set).",
    );
  }

  const res = await fetch("https://api.shopify.com/auth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Token request failed: ${res.status} ${txt}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    expires_in?: number; // seconds
    token_type?: string;
    scope?: string;
  };

  if (!json?.access_token) throw new Error("Token response missing access_token");

  // Shopify typically returns expires_in; if absent, assume 1 hour (safe default)
  const expiresInSec = typeof json.expires_in === "number" ? json.expires_in : 3600;
  const expiresAtMs = nowMs() + expiresInSec * 1000;

  return {
    access_token: json.access_token,
    expires_at_ms: expiresAtMs,
    token_type: json.token_type,
    scope: json.scope,
  };
}
