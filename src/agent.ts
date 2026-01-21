import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";

import { Env, REQUIRE_YES, DEBUG, AUTO_OPEN_CHECKOUT, ALLOWED_SHIPS_TO } from "./env.js";
import { HttpMcpClient } from "./mcp/httpClient.js";
import { StdioMcpClient } from "./mcp/stdioClient.js";
import type { McpClient } from "./mcp/types.js";
import { ollamaChat } from "./ollama.js";
import { normalizeSearchResult } from "./normalize.js";
import { enforcePolicy } from "./policy.js";
import { ShopifyTokenManager } from "./token.js";

type Intent =
  | { intent: "SEARCH"; query: string; ships_to?: string; max_price?: number }
  | { intent: "CHOOSE_VARIANT"; variant_id?: string; quantity: number }
  | { intent: "CONFIRM"; yes: boolean }
  | { intent: "ASK_CLARIFICATION"; question: string }
  | { intent: "CANCEL" };

function systemPrompt() {
  return `You are a friendly shopping assistant running locally. Output ONLY valid JSON.
Allowed intents:
- SEARCH {query, ships_to?, max_price?}
- CHOOSE_VARIANT {variant_id, quantity}
- CONFIRM {yes}
- ASK_CLARIFICATION {question}
- CANCEL

Rules:
- Never invent IDs.
- ships_to MUST be ISO 3166-1 alpha-2 (e.g. FR, US, GB). DO NOT guess.
- If user doesn't provide ships_to and it's not known from context, ASK_CLARIFICATION.
- Keep results to 3 options.
- Always ask for confirmation before generating checkout link.`;
}

function tokenFingerprint(token: string) {
  const t = (token ?? "").trim();
  return crypto.createHash("sha256").update(t).digest("hex").slice(0, 12);
}

function cleanToken(x: string) {
  return (x ?? "").trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
}

function normalizeShipsTo(x: string) {
  const v = (x ?? "").trim().toUpperCase();
  if (v === "FRANCE" || v === "FRA") return "FR";
  if (v === "UNITED STATES" || v === "UNITED STATES OF AMERICA" || v === "USA") return "US";
  if (v === "UK" || v === "UNITED KINGDOM" || v === "GREAT BRITAIN") return "GB";
  return v;
}

function parseIntent(s: string): Intent {
  const trimmed = s.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return { intent: "ASK_CLARIFICATION", question: "Sorry—can you rephrase that?" };
  }
}

function mcpErrorMessage(raw: any): string | null {
  const isError = raw?.isError ?? raw?.result?.isError;
  if (!isError) return null;
  const content = raw?.content ?? raw?.result?.content;
  if (Array.isArray(content)) {
    const msg = content.map((c: any) => c?.text).filter(Boolean).join("\n");
    return msg || "Unknown MCP error";
  }
  return "Unknown MCP error";
}

function openUrl(url: string) {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // best effort
  }
}

async function main() {
  const tokenMgr = new ShopifyTokenManager({
    cachePath: Env.TOKEN_CACHE_PATH,
    refreshSkewMs: 2 * 60 * 1000, // refresh if <2min left
  });

  if (DEBUG) {
    const envBearer = cleanToken(process.env.BEARER_TOKEN ?? "");
    const parsedBearer = cleanToken(Env.BEARER_TOKEN ?? "");
    console.log("[transport]", Env.MCP_TRANSPORT);
    console.log("[catalog url]", Env.CATALOG_MCP_URL);
    console.log("[process.env bearer fp]", envBearer ? tokenFingerprint(envBearer) : "(none)");
    console.log("[Env.BEARER fp]        ", parsedBearer ? tokenFingerprint(parsedBearer) : "(none)");
    console.log("[token cache path]", Env.TOKEN_CACHE_PATH);
  }

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
    // stdio: we fetch a token once at startup (stdio servers won’t auto-refresh unless restarted)
    const token = cleanToken(await tokenMgr.getToken());
    return new StdioMcpClient(urlOrCmd, { BEARER_TOKEN: token, SHOPIFY_ACCESS_TOKEN: token });
  };

  const catalog = await createMcp(Env.CATALOG_MCP_URL ?? Env.CATALOG_MCP_CMD ?? "", "catalog");
  const checkout = await createMcp(Env.CHECKOUT_MCP_URL ?? Env.CHECKOUT_MCP_CMD ?? "", "checkout");
  void checkout;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  let memory: Array<{ role: string; content: string }> = [{ role: "system", content: systemPrompt() }];

  let lastShortlist: any[] | null = null;
  let lastShipsTo: string | null = null;

  let selected:
    | { title: string; variant_id?: string; checkoutUrl?: string; priceUsd?: number; currency?: string; shopUrl?: string; quantity: number; shipsTo: string }
    | null = null;

  console.log("Local agent ready. Tell me what you want to buy.\n");

  while (true) {
    const user = await ask("> ");
    if (!user) continue;

    memory.push({ role: "user", content: user });
    const out = await ollamaChat(memory);
    const intent = parseIntent(out);

    if (intent.intent === "CANCEL") {
      console.log("Okay — cancelled.");
      selected = null;
      lastShortlist = null;
      lastShipsTo = null;
      continue;
    }

    if (intent.intent === "ASK_CLARIFICATION") {
      console.log(intent.question);
      continue;
    }

    if (intent.intent === "SEARCH") {
      const query = (intent.query ?? "").trim();
      if (!query) {
        console.log("What are you looking for?");
        continue;
      }

      const shipsTo = normalizeShipsTo(intent.ships_to ?? lastShipsTo ?? "");
      if (!shipsTo) {
        console.log("Where should it ship? (Example: FR, US, GB)");
        continue;
      }
      if (!ALLOWED_SHIPS_TO.has(shipsTo)) {
        console.log(`Policy: ships_to ${shipsTo} not allowed`);
        continue;
      }

      const context = Env.DEFAULT_CONTEXT || "Buyer wants good value. Keep choices to 3.";

      let raw: any;
      try {
        raw = await catalog.callTool("search_global_products", {
          query,
          ships_to: shipsTo,
          max_price: intent.max_price,
          limit: 10,
          available_for_sale: true,
          include_secondhand: false,
          context,
        });
      } catch (e: any) {
        console.log(`Catalog request failed: ${e?.message ?? String(e)}`);
        continue;
      }

      const maybeErr = mcpErrorMessage(raw);
      if (maybeErr) {
        console.log(`Catalog error: ${maybeErr}`);
        continue;
      }

      const shortlist = normalizeSearchResult(raw, 3, 3);
      lastShortlist = shortlist;
      lastShipsTo = shipsTo;

      const totalVariants = shortlist.reduce((acc: number, p: any) => acc + (p?.variants?.length ?? 0), 0);
      if (totalVariants === 0) {
        console.log(`I didn’t find anything for “${query}” shipping to ${shipsTo}. Want to try a broader term?`);
        continue;
      }

      const flatVariants = shortlist.flatMap((p: any) => p.variants ?? []);
      const optionsText = flatVariants
        .slice(0, 9)
        .map((v: any, idx: number) => {
          const opt = v.options ? Object.entries(v.options).map(([k, val]) => `${k}: ${val}`).join(", ") : "";
          const pricePart = v.priceUsd != null ? `${v.priceUsd}` : "?";
          const curPart = v.currency ?? "";
          const shop = v.shopUrl ?? "";
          return `#${idx + 1} ${v.title} - ${shop} - ${pricePart} ${curPart} - variant_id=${v.variantId ?? "?"}${opt ? ` (${opt})` : ""}`;
        })
        .join("\n");

      console.log(`Here are a few options:\n${optionsText}\n\nPick one by pasting the variant_id (and quantity if not 1).`);
      continue;
    }

    if (intent.intent === "CHOOSE_VARIANT") {
      if (!lastShortlist || !lastShipsTo) {
        console.log("Tell me what you want to buy, and where it should ship (e.g. “iPad to France”).");
        continue;
      }

      const variantId = intent.variant_id?.trim();
      if (!variantId) {
        console.log("Please paste the variant_id from the list.");
        continue;
      }

      const found = lastShortlist.flatMap((p: any) => p.variants ?? []).find((v: any) => String(v.variantId) === variantId);
      if (!found) {
        console.log("I can’t find that option in the current list — want me to search again?");
        continue;
      }

      const qty = intent.quantity && intent.quantity > 0 ? intent.quantity : 1;

      try {
        enforcePolicy({ shipsTo: lastShipsTo, totalUsd: found.priceUsd ?? 0, quantity: qty });
      } catch (e: any) {
        console.log(String(e?.message ?? e));
        console.log(`Tip: adjust MAX_TOTAL_USD in .env if you want to allow higher totals (current ${Env.MAX_TOTAL_USD}).`);
        continue;
      }

      selected = {
        title: found.title,
        variant_id: String(found.variantId),
        checkoutUrl: found.checkoutUrl,
        priceUsd: found.priceUsd,
        currency: found.currency,
        shopUrl: found.shopUrl,
        quantity: qty,
        shipsTo: lastShipsTo,
      };

      const price = selected.priceUsd != null ? `${selected.priceUsd} ${selected.currency ?? ""}` : "unknown price";
      console.log(`Got it — ${selected.title} (${price}). Want me to generate the checkout link? (yes/no)`);
      continue;
    }

    if (intent.intent === "CONFIRM") {
      if (!selected) {
        console.log("Nothing selected yet.");
        continue;
      }
      if (!intent.yes) {
        console.log("No problem. Want a different option or a new search?");
        continue;
      }

      if (REQUIRE_YES) {
        const raw = await ask("Type YES to proceed: ");
        if (raw.trim().toUpperCase() !== "YES") {
          console.log("Aborted.");
          continue;
        }
      }

      if (selected.checkoutUrl) {
        console.log(`Checkout link:\n${selected.checkoutUrl}\n`);
        if (AUTO_OPEN_CHECKOUT) {
          openUrl(selected.checkoutUrl);
          console.log("I opened it in your browser.");
        } else {
          console.log("Open it in your browser to pay.");
        }
      } else {
        console.log("No checkoutUrl available for that option.");
      }

      selected = null;
      continue;
    }

    console.log("Sorry—can you rephrase that?");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
