import crypto from "node:crypto";
import readline from "node:readline";
import { z } from "zod";
import { spawn } from "node:child_process";

import { Env, REQUIRE_YES, AUTO_OPEN_CHECKOUT, DEBUG } from "./env.js";
import { HttpMcpClient } from "./mcp/httpClient.js";
import { StdioMcpClient } from "./mcp/stdioClient.js";
import type { McpClient } from "./mcp/types.js";
import { ollamaChat } from "./ollama.js";
import { normalizeSearchResult } from "./normalize.js";
import { enforcePolicy } from "./policy.js";

type State =
  | { mode: "IDLE" }
  | { mode: "HAVE_RESULTS"; shipsTo: string; shortlist: any[]; lastQuery: string }
  | {
      mode: "HAVE_SELECTION";
      shipsTo: string;
      shortlist: any[];
      lastQuery: string;
      selection: {
        title: string;
        variantId: string;
        checkoutUrl?: string;
        priceUsd?: number;
        currency?: string;
        shopUrl?: string;
        quantity: number;
      };
    }
  | { mode: "CHECKOUT_SHOWN"; lastUrl: string };

type Intent =
  | { intent: "SEARCH"; query: string; ships_to: string; max_price?: number }
  | { intent: "CHOOSE_VARIANT"; variant_id: string; quantity: number }
  | { intent: "CONFIRM"; yes: boolean }
  | { intent: "ASK_CLARIFICATION"; question: string }
  | { intent: "CANCEL" };

const IntentSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("SEARCH"), query: z.string(), ships_to: z.string(), max_price: z.number().optional() }),
  z.object({ intent: z.literal("CHOOSE_VARIANT"), variant_id: z.string(), quantity: z.number().default(1) }),
  z.object({ intent: z.literal("CONFIRM"), yes: z.boolean() }),
  z.object({ intent: z.literal("ASK_CLARIFICATION"), question: z.string() }),
  z.object({ intent: z.literal("CANCEL") }),
]);

function systemPrompt() {
  return `You are a friendly shopping assistant running locally. Output ONLY valid JSON.

Allowed intents:
- SEARCH {query, ships_to, max_price?}
- CHOOSE_VARIANT {variant_id, quantity}
- CONFIRM {yes}
- ASK_CLARIFICATION {question}
- CANCEL

Rules:
- Never invent IDs.
- ships_to MUST be ISO 3166-1 alpha-2 (e.g. FR, US, GB). If missing, ASK_CLARIFICATION.
- If user provides a long numeric ID that looks like a variant id, output CHOOSE_VARIANT.
- If user picks by number (e.g. "the first one"), output CHOOSE_VARIANT using the variant_id from the shown list.
- Keep results to 3 options.
- Always ask for confirmation before generating checkout link.`;
}

function tokenFingerprint(token: string) {
  const t = (token ?? "").trim();
  return crypto.createHash("sha256").update(t).digest("hex").slice(0, 12);
}

function cleanToken(x: string) {
  return (x ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function normalizeShipsTo(x: string) {
  const v = (x ?? "").trim().toUpperCase();
  if (v === "FRANCE" || v === "FRA") return "FR";
  if (v === "UNITED STATES" || v === "UNITED STATES OF AMERICA" || v === "USA") return "US";
  if (v === "UK" || v === "UNITED KINGDOM" || v === "GREAT BRITAIN") return "GB";
  return v;
}

function openUrl(url: string) {
  // Use spawn (not shell) to avoid injection risks
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      // start is a shell built-in; safest approach is cmd /c start
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // Best-effort only; no noisy error.
  }
}

function extractJsonObject(text: string): unknown {
  const s = text.trim();
  if (s.startsWith("{") && s.endsWith("}")) return JSON.parse(s);
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
  throw new Error("No JSON object found in model output");
}

function parseIntentFromModel(modelOut: string): Intent {
  try {
    const obj = extractJsonObject(modelOut);
    return IntentSchema.parse(obj) as Intent;
  } catch {
    return { intent: "ASK_CLARIFICATION", question: "Sorry—can you rephrase that?" };
  }
}

/**
 * Deterministic intent parsing from raw user message, independent of LLM.
 * - Handles: variant_id paste, “12345 2”, yes/no/cancel
 * - Keeps assistant feeling responsive and non-brittle.
 */
function parseIntentFromUserFast(userText: string): Intent | null {
  const s = userText.trim();

  // Cancel
  if (/^(cancel|stop|never mind|nevermind|quit|exit)\b/i.test(s)) return { intent: "CANCEL" };

  // Yes/no (NOTE: deliberately NOT treating "ok" as yes globally)
  if (/^(yes|yep|yeah|confirm|go ahead|proceed|do it)\b/i.test(s)) return { intent: "CONFIRM", yes: true };
  if (/^(no|nope|nah|don'?t|do not|stop)\b/i.test(s)) return { intent: "CONFIRM", yes: false };

  // Variant id + quantity
  const vid = s.match(/\b(\d{8,})\b/);
  if (vid) {
    // quantity patterns: "123... 2" OR "qty 2" OR "quantity 2" OR "just one"
    const justOne = /\b(one|just one|single)\b/i.test(s);
    const inlineQty = s.match(/\b\d{8,}\s+([1-9]\d*)\b/);
    const labeledQty = s.match(/\b(qty|quantity)\s*([1-9]\d*)\b/i);
    const quantity = justOne ? 1 : labeledQty ? Number(labeledQty[2]) : inlineQty ? Number(inlineQty[1]) : 1;

    return { intent: "CHOOSE_VARIANT", variant_id: vid[1], quantity };
  }

  return null;
}

/**
 * Extract a compact query + ships_to from a natural message.
 * Example: "find me an ipad shipped to france" -> query="ipad", ships_to="FR"
 * This should not override selection behavior if we already have results.
 */
function inferSearchFromUser(userText: string): { query?: string; ships_to?: string } {
  const s = userText.trim();

  let ships: string | undefined;
  if (/\b(france|to france|ship(ped|ping)?\s+to\s+france)\b/i.test(s)) ships = "FR";
  else if (/\b(us|usa|united states|to the us|ship(ped|ping)?\s+to\s+(the\s+)?us)\b/i.test(s)) ships = "US";
  else if (/\b(uk|united kingdom|to the uk|ship(ped|ping)?\s+to\s+(the\s+)?uk)\b/i.test(s)) ships = "GB";

  const cleaned = s
    .replace(/ship(ped|ping)?\s+to\s+[a-z\s]+/gi, "")
    .replace(/\b(to\s+(france|us|usa|united states|uk|united kingdom))\b/gi, "")
    .replace(/\b(i want|i need|find me|look for|search for|buy|get me|i'm looking for)\b/gi, "")
    .trim();

  const query = cleaned.length >= 2 ? cleaned : undefined;
  return { query, ships_to: ships };
}

/**
 * Resolve "first one / option 2 / #1.2 / the one from X / the one that says Y"
 * against the currently displayed shortlist.
 *
 * Production standard:
 * - No hard-coded brands.
 * - Uses numeric references + generic phrase matching.
 */
function resolveVariantFromReference(userText: string, shortlist: any[]): { variantId: string; quantity: number } | null {
  const s = userText.trim().toLowerCase();
  const flat = shortlist.flatMap((p: any) => p.variants ?? []);
  if (flat.length === 0) return null;

  // Quantity hint in the same message
  const justOne = /\b(one|just one|single)\b/i.test(userText);
  const labeledQty = userText.match(/\b(qty|quantity)\s*([1-9]\d*)\b/i);
  const inlineQty = userText.match(/\b([1-9]\d*)\b/);
  // Don't accidentally treat "option 2" as qty=2: we only use qty patterns or "one"
  const quantity = justOne ? 1 : labeledQty ? Number(labeledQty[2]) : 1;

  // "#1.2" refers to product/variant grid
  const grid = userText.match(/#\s*(\d+)\s*\.\s*(\d+)/);
  if (grid) {
    const i = Number(grid[1]) - 1;
    const j = Number(grid[2]) - 1;
    const v = shortlist?.[i]?.variants?.[j];
    if (v?.variantId) return { variantId: String(v.variantId), quantity };
  }

  // "option 2" / "number 3" / "the 1st one"
  const opt = userText.match(/\b(option|number|#)\s*(\d+)\b/i);
  if (opt) {
    const n = Number(opt[2]);
    if (Number.isFinite(n) && n >= 1 && n <= flat.length) {
      const v = flat[n - 1];
      if (v?.variantId) return { variantId: String(v.variantId), quantity };
    }
  }

  const ord =
    s.includes("first") ? 1 :
    s.includes("second") ? 2 :
    s.includes("third") ? 3 :
    s.includes("fourth") ? 4 :
    s.includes("fifth") ? 5 :
    null;

  if (ord != null && ord >= 1 && ord <= flat.length) {
    const v = flat[ord - 1];
    if (v?.variantId) return { variantId: String(v.variantId), quantity };
  }

  // Phrase matching: "the one from X", "the one that says Y", quoted text
  const fromMatch = userText.match(/\bfrom\s+(.+?)\s*$/i);
  const saysMatch = userText.match(/\b(that says|with|named|called)\s+(.+?)\s*$/i);
  const quotedMatch = userText.match(/["“](.+?)["”]/);

  const candidates: string[] = [];
  if (quotedMatch?.[1]) candidates.push(quotedMatch[1]);
  if (saysMatch?.[2]) candidates.push(saysMatch[2]);
  if (fromMatch?.[1]) candidates.push(fromMatch[1]);

  // Also: "the Disney one" style where keyword appears in sentence
  // We'll extract meaningful tokens (length>=3) excluding stopwords.
  const stop = new Set([
    "the","a","an","one","this","that","these","those","option","number","first","second","third","fourth","fifth",
    "from","with","named","called","says","please","i","want","take","choose","pick","buy",
  ]);
  const tokens = s
    .split(/[^a-z0-9]+/g)
    .map(t => t.trim())
    .filter(t => t.length >= 3 && !stop.has(t));

  // Prefer explicit phrases; otherwise use tokens
  const searchTerms = [...candidates.map(c => c.trim()).filter(Boolean)];
  if (searchTerms.length === 0 && tokens.length > 0) {
    // Use up to 4 tokens to avoid overly broad matches
    searchTerms.push(tokens.slice(0, 4).join(" "));
  }

  if (searchTerms.length > 0) {
    const term = searchTerms[0].toLowerCase();
    const v = flat.find((x: any) => String(x.title ?? "").toLowerCase().includes(term));
    if (v?.variantId) return { variantId: String(v.variantId), quantity };
  }

  return null;
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

async function createMcp(urlOrCmd: string, jwt: string, kind: "catalog" | "checkout"): Promise<McpClient> {
  const token = cleanToken(jwt);
  const headers = { authorization: `Bearer ${token}` };

  if (DEBUG) console.log(`[${kind}] token fp:`, tokenFingerprint(token));

  if (Env.MCP_TRANSPORT === "http") {
    if (!urlOrCmd) throw new Error(`${kind} MCP URL missing`);
    return new HttpMcpClient(urlOrCmd, headers);
  } else {
    return new StdioMcpClient(urlOrCmd, { BEARER_TOKEN: token, SHOPIFY_ACCESS_TOKEN: token });
  }
}

function friendlyNeedMoreInfo(state: State) {
  if (state.mode === "IDLE" || state.mode === "CHECKOUT_SHOWN") {
    return "Tell me what you want to buy, and where it should ship (e.g. “iPad to France”).";
  }
  if (state.mode === "HAVE_RESULTS") {
    return "Which option do you want? You can paste the variant_id or say “option 2”.";
  }
  if (state.mode === "HAVE_SELECTION") {
    return "Do you want me to generate the checkout link? (yes/no)";
  }
  return "Tell me what you want to buy.";
}

async function main() {
  if (DEBUG) {
    console.log("[process.env BEARER fp]", tokenFingerprint(cleanToken(process.env.BEARER_TOKEN ?? "")));
    console.log("[Env.BEARER fp]        ", tokenFingerprint(cleanToken(Env.BEARER_TOKEN ?? "")));
    console.log("[transport]", Env.MCP_TRANSPORT);
    console.log("[catalog url]", Env.CATALOG_MCP_URL);
  }

  const catalog = await createMcp(Env.CATALOG_MCP_URL ?? Env.CATALOG_MCP_CMD ?? "", Env.BEARER_TOKEN, "catalog");
  const checkout = await createMcp(Env.CHECKOUT_MCP_URL ?? Env.CHECKOUT_MCP_CMD ?? "", Env.BEARER_TOKEN, "checkout");
  void checkout;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  let memory: Array<{ role: string; content: string }> = [{ role: "system", content: systemPrompt() }];
  let state: State = { mode: "IDLE" };

  console.log("Local agent ready. Tell me what you want to buy.\n");

  while (true) {
    const user = await ask("> ");
    if (!user) continue;

    // If checkout already shown, treat common acknowledgements as normal chat
    if (state.mode === "CHECKOUT_SHOWN" && /^(ok|okay|thanks|thx|done|cool|great)\b/i.test(user.trim())) {
      console.log("Perfect. If you want to buy something else, just tell me what you’re looking for.");
      state = { mode: "IDLE" };
      continue;
    }

    // 1) Deterministic parsing
    let intent: Intent | null = parseIntentFromUserFast(user);

    // 2) If we have results and user references an option, resolve locally (no re-search)
    if (!intent && state.mode === "HAVE_RESULTS") {
      const ref = resolveVariantFromReference(user, state.shortlist);
      if (ref) {
        intent = { intent: "CHOOSE_VARIANT", variant_id: ref.variantId, quantity: ref.quantity };
      }
    }

    // 3) If still nothing deterministic, try infer a SEARCH from natural language
    //    (but ONLY if we are not already choosing from a displayed list)
    if (!intent && (state.mode === "IDLE" || state.mode === "CHECKOUT_SHOWN")) {
      const inferred = inferSearchFromUser(user);
      if (inferred.query && inferred.ships_to) {
        intent = { intent: "SEARCH", query: inferred.query, ships_to: inferred.ships_to };
      }
    }

    // 4) Last resort: ask the model
    if (!intent) {
      memory.push({ role: "user", content: user });
      const out = await ollamaChat(memory);
      intent = parseIntentFromModel(out);
    }

    if (intent.intent === "CANCEL") {
      console.log("Okay — cancelled.");
      state = { mode: "IDLE" };
      continue;
    }

    if (intent.intent === "ASK_CLARIFICATION") {
      console.log(intent.question || friendlyNeedMoreInfo(state));
      continue;
    }

    if (intent.intent === "SEARCH") {
      const query = (intent.query ?? "").trim();
      const shipsTo = normalizeShipsTo(intent.ships_to);

      if (!query || query.length < 2) {
        console.log("What should I search for? (Example: “iPad Air 256GB”)");
        continue;
      }
      if (!shipsTo || shipsTo.length !== 2) {
        console.log("Where should it ship to? (Example: FR, US, GB)");
        continue;
      }

      // Respect your allowed ships_to
      if (Env.ALLOWED_SHIPS_TO && Env.ALLOWED_SHIPS_TO.length > 0) {
        // Env exports ALLOWED_SHIPS_TO set in env.ts, but we keep this lightweight here:
        // If you want strict enforcement here, import ALLOWED_SHIPS_TO from env.ts and check it.
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
        console.log(`Hmm — I couldn’t reach the catalog right now. (${e?.message ?? String(e)})`);
        continue;
      }

      const maybeErr = mcpErrorMessage(raw);
      if (maybeErr) {
        console.log(`Catalog error: ${maybeErr}`);
        continue;
      }

      const shortlist = normalizeSearchResult(raw, 3, 3);
      const totalVariants = shortlist.reduce((acc: number, p: any) => acc + (p?.variants?.length ?? 0), 0);

      if (totalVariants === 0) {
        console.log(`I didn’t find options for "${query}" shipping to ${shipsTo}. Try a more specific search.`);
        state = { mode: "IDLE" };
        continue;
      }

      state = { mode: "HAVE_RESULTS", shipsTo, shortlist, lastQuery: query };

      const optionsText = shortlist
        .flatMap((p: any, i: number) =>
          (p.variants ?? []).map((v: any, j: number) => {
            const opt = v.options ? Object.entries(v.options).map(([k, val]) => `${k}: ${val}`).join(", ") : "";
            const pricePart = v.priceUsd != null ? `${v.priceUsd}` : "?";
            const curPart = v.currency ?? "";
            const shop = v.shopUrl ?? "";
            return `#${i + 1}.${j + 1} ${v.title} - ${shop} - ${pricePart} ${curPart} - variant_id=${v.variantId ?? "?"}${opt ? ` (${opt})` : ""}`;
          }),
        )
        .join("\n");

      console.log(`Here are a few options:\n${optionsText}\n\nPick one by saying “option 2” or pasting the variant_id.`);
      continue;
    }

    if (intent.intent === "CHOOSE_VARIANT") {
      if (state.mode !== "HAVE_RESULTS") {
        console.log("I don’t have a list yet. " + friendlyNeedMoreInfo(state));
        continue;
      }

      const variantId = intent.variant_id?.trim();
      if (!variantId) {
        console.log("Which one do you want? Paste the variant_id or say “option 2”.");
        continue;
      }

      const found = state.shortlist
        .flatMap((p: any) => p.variants ?? [])
        .find((v: any) => String(v.variantId) === variantId);

      if (!found) {
        console.log("I can’t find that option in the current list — want me to search again?");
        continue;
      }

      const qty = intent.quantity && intent.quantity > 0 ? intent.quantity : 1;

      try {
        enforcePolicy({ shipsTo: state.shipsTo, totalUsd: found.priceUsd ?? 0, quantity: qty });
      } catch (e: any) {
        console.log(String(e?.message ?? e));
        console.log(`Tip: raise MAX_TOTAL_USD in .env if you want to allow higher totals (current ${Env.MAX_TOTAL_USD}).`);
        continue;
      }

      state = {
        mode: "HAVE_SELECTION",
        shipsTo: state.shipsTo,
        shortlist: state.shortlist,
        lastQuery: state.lastQuery,
        selection: {
          title: found.title,
          variantId,
          checkoutUrl: found.checkoutUrl,
          priceUsd: found.priceUsd,
          currency: found.currency,
          shopUrl: found.shopUrl,
          quantity: qty,
        },
      };

      const price = state.selection.priceUsd != null ? `${state.selection.priceUsd} ${state.selection.currency ?? ""}` : "an unknown price";
      console.log(`Got it — ${state.selection.title} (${price}). Want me to generate the checkout link? (yes/no)`);
      continue;
    }

    if (intent.intent === "CONFIRM") {
      if (state.mode !== "HAVE_SELECTION") {
        console.log("Nothing selected yet. " + friendlyNeedMoreInfo(state));
        continue;
      }

      if (!intent.yes) {
        console.log("No worries. Pick a different option or tell me what you want to search for.");
        state = { mode: "HAVE_RESULTS", shipsTo: state.shipsTo, shortlist: state.shortlist, lastQuery: state.lastQuery };
        continue;
      }

      if (REQUIRE_YES) {
        const raw = await ask("Type YES to proceed: ");
        if (raw.trim().toUpperCase() !== "YES") {
          console.log("Aborted.");
          continue;
        }
      }

      const url = state.selection.checkoutUrl;
      if (!url) {
        console.log("I don’t have a checkout URL for that item. (Next step: wire checkout MCP tools.)");
        continue;
      }

      console.log(`Checkout link:\n${url}\n`);

      if (AUTO_OPEN_CHECKOUT) {
        openUrl(url);
        console.log("I opened it in your browser.");
      } else {
        console.log("Open it in your browser to pay.");
      }

      state = { mode: "CHECKOUT_SHOWN", lastUrl: url };
      continue;
    }

    // Fallback
    console.log(friendlyNeedMoreInfo(state));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
