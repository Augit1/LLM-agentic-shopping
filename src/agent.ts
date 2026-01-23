import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { z } from "zod";

import { Env, REQUIRE_YES, DEBUG, AUTO_OPEN_CHECKOUT, ALLOWED_SHIPS_TO } from "./env.js";
import { HttpMcpClient } from "./mcp/httpClient.js";
import { StdioMcpClient } from "./mcp/stdioClient.js";
import type { McpClient } from "./mcp/types.js";
import { normalizeSearchResult, type NormalizedVariant } from "./normalize.js";
import { enforcePolicy } from "./policy.js";
import { ShopifyTokenManager } from "./token.js";

// LangChain (Ollama)
import { ChatOllama } from "@langchain/ollama";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { StructuredOutputParser } from "@langchain/core/output_parsers";

// --------------------
// Helpers
// --------------------

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

function parseQuantityFromText(text: string): number | null {
  const t = text.toLowerCase().trim();

  // "x2", "2x", "qty 2", "2 of them", "2"
  const m = t.match(/\bqty\s*[:=]?\s*(\d+)\b|\bx\s*(\d+)\b|\b(\d+)\s*(x|pcs|pieces|of them)?\b/);
  const n = m ? Number(m[1] ?? m[2] ?? m[3]) : NaN;
  if (Number.isFinite(n) && n > 0) return n;

  if (/\btwo\b/.test(t)) return 2;
  if (/\bthree\b/.test(t)) return 3;
  if (/\bfour\b/.test(t)) return 4;
  if (/\bfive\b/.test(t)) return 5;

  return null;
}

function parseOptionIndexFromText(text: string): number | null {
  const t = text.toLowerCase().trim();

  // "option 4"
  let m = t.match(/\boption\s+(\d+)\b/);
  if (m) return Number(m[1]);

  // "#4"
  m = t.match(/#\s*(\d+)\b/);
  if (m) return Number(m[1]);

  // "4th"
  m = t.match(/\b(\d+)(st|nd|rd|th)\b/);
  if (m) return Number(m[1]);

  if (/\bfirst\b/.test(t)) return 1;
  if (/\bsecond\b/.test(t)) return 2;
  if (/\bthird\b/.test(t)) return 3;
  if (/\bfourth\b/.test(t)) return 4;
  if (/\bfifth\b/.test(t)) return 5;
  if (/\bsixth\b/.test(t)) return 6;
  if (/\bseventh\b/.test(t)) return 7;
  if (/\beighth\b/.test(t)) return 8;

  // Bare number "4"
  if (/^\d+$/.test(t)) return Number(t);

  // "the 4"
  m = t.match(/\bthe\s+(\d+)\b/);
  if (m) return Number(m[1]);

  return null;
}

function parseVariantIdFromText(text: string): string | null {
  const t = text.trim();

  // If user pasted a big integer, assume variant_id
  if (/^\d{6,}$/.test(t)) return t;

  // "variant_id=123"
  const m = t.match(/variant[_\s-]*id\s*[:=]\s*(\d{6,})/i);
  return m ? m[1] : null;
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

function formatOptionsForPrompt(options: NormalizedVariant[]) {
  // Keep short; this is for LLM context, not user display.
  return options
    .slice(0, 10)
    .map((v, i) => {
      const price = v.priceUsd != null ? `${v.priceUsd} ${v.currency ?? ""}` : "?";
      const shop = v.shopUrl ?? "";
      const vid = v.variantId ?? "?";
      return `#${i + 1} | variant_id=${vid} | ${v.title} | ${price} | ${shop}`;
    })
    .join("\n");
}

// --------------------
// LangChain Intent Schema
// --------------------

const IntentSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("SEARCH"),
    query: z.string().min(1),
    ships_to: z.string().optional(), // may be missing; we’ll ask
    max_price: z.number().optional(),
  }),
  z.object({
    intent: z.literal("CHOOSE"),
    // prefer option_index if user says “option 4”
    option_index: z.number().int().positive().optional(),
    variant_id: z.union([z.string(), z.number()]).optional(),
    quantity: z.number().int().positive().optional(),
  }),
  z.object({
    intent: z.literal("CONFIRM"),
    yes: z.boolean(),
  }),
  z.object({
    intent: z.literal("CLARIFY"),
    question: z.string().min(1),
  }),
  z.object({
    intent: z.literal("CANCEL"),
  }),
]);

type Intent = z.infer<typeof IntentSchema>;

// --------------------
// Main
// --------------------

async function main() {
  // Token manager stays exactly as you have it
  const tokenMgr = new ShopifyTokenManager({
    cachePath: Env.TOKEN_CACHE_PATH,
    refreshSkewMs: 2 * 60 * 1000,
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
    // stdio: token fetched once at startup
    const token = cleanToken(await tokenMgr.getToken());
    return new StdioMcpClient(urlOrCmd, { BEARER_TOKEN: token, SHOPIFY_ACCESS_TOKEN: token });
  };

  const catalog = await createMcp(Env.CATALOG_MCP_URL ?? Env.CATALOG_MCP_CMD ?? "", "catalog");
  const checkout = await createMcp(Env.CHECKOUT_MCP_URL ?? Env.CHECKOUT_MCP_CMD ?? "", "checkout");
  void checkout;

  // CLI
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  // LangChain model
  const llm = new ChatOllama({
    baseUrl: Env.OLLAMA_URL,
    model: Env.OLLAMA_MODEL,
    temperature: 0.2,
  });

  const parser = StructuredOutputParser.fromZodSchema(IntentSchema);

  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      [
        "You are a local shopping assistant.",
        "Return ONLY JSON that matches the given schema instructions.",
        "",
        "Important behaviors:",
        "- If user is just greeting, ask what they want to buy and where to ship.",
        "- If user says something like 'option 4' or 'the fourth one', output intent=CHOOSE with option_index.",
        "- If user provides a variant_id, output intent=CHOOSE with variant_id.",
        "- quantity defaults to 1 when not stated.",
        "- ships_to must be ISO alpha-2 (FR/US/GB etc). If missing, ask a short clarification question.",
        "- Never invent IDs.",
        "",
        "Context:",
        "last_ships_to: {last_ships_to}",
        "last_options:\n{last_options}",
        "",
        "Output schema instructions:\n{format_instructions}",
      ].join("\n"),
    ],
    new MessagesPlaceholder("history"),
    ["human", "{input}"],
  ]);

  const chain = prompt.pipe(llm).pipe(parser);

  // State
  type Pending = { query: string; max_price?: number } | null;
  let pending: Pending = null;

  let history: Array<HumanMessage | AIMessage> = [];
  let lastShipsTo: string | null = null;
  let lastOptions: NormalizedVariant[] = [];
  let selected:
    | {
        title: string;
        variant_id: string;
        checkoutUrl?: string;
        priceUsd?: number;
        currency?: string;
        shopUrl?: string;
        quantity: number;
        shipsTo: string;
      }
    | null = null;

  console.log("Local agent ready. Tell me what you want to buy.\n");

  while (true) {
    const user = await ask("> ");
    if (!user) continue;

    // 1) If we are waiting for ships_to after a search request
    if (pending) {
      const shipsTo = normalizeShipsTo(user);
      if (!shipsTo) {
        console.log("Where should it ship? (Example: FR, US, GB)");
        continue;
      }
      if (!ALLOWED_SHIPS_TO.has(shipsTo)) {
        console.log(`Policy: ships_to ${shipsTo} not allowed`);
        continue;
      }

      // Execute the pending search
      const context = Env.DEFAULT_CONTEXT || "Buyer wants good value. Keep choices concise.";
      let raw: any;
      try {
        raw = await catalog.callTool("search_global_products", {
          query: pending.query,
          ships_to: shipsTo,
          max_price: pending.max_price,
          limit: 10,
          available_for_sale: true,
          include_secondhand: false,
          context,
        });
      } catch (e: any) {
        console.log(`Catalog request failed: ${e?.message ?? String(e)}`);
        pending = null;
        continue;
      }

      const maybeErr = mcpErrorMessage(raw);
      if (maybeErr) {
        console.log(`Catalog error: ${maybeErr}`);
        pending = null;
        continue;
      }

      const shortlist = normalizeSearchResult(raw, 3, 3);
      const flat = shortlist.flatMap((p: any) => p.variants ?? []).slice(0, 9);

      if (flat.length === 0) {
        console.log(`I didn’t find anything for “${pending.query}” shipping to ${shipsTo}. Want to try a broader term?`);
        pending = null;
        continue;
      }

      lastShipsTo = shipsTo;
      lastOptions = flat;
      pending = null;

      const optionsText = lastOptions
        .map((v, idx) => {
          const opt = v.options ? Object.entries(v.options).map(([k, val]) => `${k}: ${val}`).join(", ") : "";
          const pricePart = v.priceUsd != null ? `${v.priceUsd}` : "?";
          const curPart = v.currency ?? "";
          const shop = v.shopUrl ?? "";
          return `#${idx + 1} ${v.title} - ${shop} - ${pricePart} ${curPart} - variant_id=${v.variantId ?? "?"}${opt ? ` (${opt})` : ""}`;
        })
        .join("\n");

      console.log(`Here are a few options:\n${optionsText}\n\nPick one by saying “option 4” / “x2”, or paste the variant_id.`);
      continue;
    }

    // 2) Fast-path: user chooses from lastOptions without LLM
    if (lastOptions.length > 0) {
      const directVariantId = parseVariantIdFromText(user);
      const directOptionIndex = parseOptionIndexFromText(user);
      const directQty = parseQuantityFromText(user) ?? 1;

      let found: NormalizedVariant | undefined;
      if (directVariantId) {
        found = lastOptions.find((o) => String(o.variantId) === String(directVariantId));
      } else if (directOptionIndex != null && directOptionIndex >= 1 && directOptionIndex <= lastOptions.length) {
        found = lastOptions[directOptionIndex - 1];
      }

      if (found && lastShipsTo) {
        try {
          enforcePolicy({
            shipsTo: lastShipsTo,
            totalUsd: found.priceUsd ?? 0,
            quantity: directQty,
          });
        } catch (e: any) {
          console.log(String(e?.message ?? e));
          console.log(`Tip: adjust MAX_TOTAL_USD / MAX_QUANTITY in .env if you want to allow more.`);
          continue;
        }

        selected = {
          title: found.title,
          variant_id: String(found.variantId),
          checkoutUrl: found.checkoutUrl,
          priceUsd: found.priceUsd,
          currency: found.currency,
          shopUrl: found.shopUrl,
          quantity: directQty,
          shipsTo: lastShipsTo,
        };

        const price = selected.priceUsd != null ? `${selected.priceUsd} ${selected.currency ?? ""}` : "unknown price";
        console.log(`Got it — ${selected.title} (${price}) x${selected.quantity}. Want me to generate the checkout link? (yes/no)`);
        continue;
      }
    }

    // 3) LangChain intent extraction
    let intent: Intent;
    try {
      intent = await chain.invoke({
        input: user,
        history,
        last_ships_to: lastShipsTo ?? "",
        last_options: formatOptionsForPrompt(lastOptions),
        format_instructions: parser.getFormatInstructions(),
      });
    } catch {
      // fallback: don't be robotic
      console.log("Sorry — I didn’t catch that. What do you want to buy, and where should it ship?");
      history.push(new HumanMessage(user));
      history.push(new AIMessage("Sorry — I didn’t catch that. What do you want to buy, and where should it ship?"));
      continue;
    }

    history.push(new HumanMessage(user));

    if (intent.intent === "CANCEL") {
      selected = null;
      lastOptions = [];
      lastShipsTo = null;
      pending = null;
      console.log("Okay — cancelled.");
      history.push(new AIMessage("Okay — cancelled."));
      continue;
    }

    if (intent.intent === "CLARIFY") {
      console.log(intent.question);
      history.push(new AIMessage(intent.question));
      continue;
    }

    if (intent.intent === "CONFIRM") {
      if (!selected) {
        console.log("Nothing selected yet. Tell me what you want to buy.");
        history.push(new AIMessage("Nothing selected yet. Tell me what you want to buy."));
        continue;
      }

      if (!intent.yes) {
        console.log("No problem. Want a different option or a new search?");
        history.push(new AIMessage("No problem. Want a different option or a new search?"));
        continue;
      }

      if (REQUIRE_YES) {
        const raw = await ask("Type YES to proceed: ");
        if (raw.trim().toUpperCase() !== "YES") {
          console.log("Aborted.");
          history.push(new AIMessage("Aborted."));
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
      history.push(new AIMessage("Checkout link generated."));
      continue;
    }

    if (intent.intent === "CHOOSE") {
      if (!lastShipsTo || lastOptions.length === 0) {
        console.log("Tell me what you want to buy, and where it should ship (e.g. “iPhone to US”).");
        history.push(new AIMessage("Tell me what you want to buy, and where it should ship (e.g. “iPhone to US”)."));
        continue;
      }

      const qty =
        (typeof intent.quantity === "number" && intent.quantity > 0 ? intent.quantity : null) ??
        parseQuantityFromText(user) ??
        1;

      let found: NormalizedVariant | undefined;

      if (intent.variant_id != null && String(intent.variant_id).trim() !== "") {
        const vid = String(intent.variant_id).trim();
        found = lastOptions.find((v) => String(v.variantId) === vid);
      } else if (typeof intent.option_index === "number") {
        const idx = intent.option_index;
        if (idx >= 1 && idx <= lastOptions.length) found = lastOptions[idx - 1];
      }

      if (!found) {
        console.log(`Which one do you mean? Say “option 1–${lastOptions.length}” or paste the variant_id.`);
        history.push(new AIMessage(`Which one do you mean? Say “option 1–${lastOptions.length}” or paste the variant_id.`));
        continue;
      }

      try {
        enforcePolicy({ shipsTo: lastShipsTo, totalUsd: found.priceUsd ?? 0, quantity: qty });
      } catch (e: any) {
        console.log(String(e?.message ?? e));
        console.log(`Tip: adjust MAX_TOTAL_USD / MAX_QUANTITY in .env if you want to allow more.`);
        history.push(new AIMessage("Policy blocked that choice."));
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
      const msg = `Got it — ${selected.title} (${price}) x${selected.quantity}. Want me to generate the checkout link? (yes/no)`;
      console.log(msg);
      history.push(new AIMessage(msg));
      continue;
    }

    if (intent.intent === "SEARCH") {
      const query = (intent.query ?? "").trim();
      if (!query) {
        console.log("What are you looking for?");
        history.push(new AIMessage("What are you looking for?"));
        continue;
      }

      const shipsToRaw = intent.ships_to ?? lastShipsTo ?? "";
      const shipsTo = normalizeShipsTo(shipsToRaw);

      if (!shipsTo) {
        // Store pending query, ask ships_to
        pending = { query, max_price: intent.max_price };
        console.log("Where should it ship? (Example: FR, US, GB)");
        history.push(new AIMessage("Where should it ship? (Example: FR, US, GB)"));
        continue;
      }

      if (!ALLOWED_SHIPS_TO.has(shipsTo)) {
        console.log(`Policy: ships_to ${shipsTo} not allowed`);
        history.push(new AIMessage(`Policy: ships_to ${shipsTo} not allowed`));
        continue;
      }

      const context = Env.DEFAULT_CONTEXT || "Buyer wants good value. Keep choices concise.";

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
        history.push(new AIMessage(`Catalog request failed.`));
        continue;
      }

      const maybeErr = mcpErrorMessage(raw);
      if (maybeErr) {
        console.log(`Catalog error: ${maybeErr}`);
        history.push(new AIMessage(`Catalog error.`));
        continue;
      }

      const shortlist = normalizeSearchResult(raw, 3, 3);
      const flat = shortlist.flatMap((p: any) => p.variants ?? []).slice(0, 9);

      if (flat.length === 0) {
        const msg = `I didn’t find anything for “${query}” shipping to ${shipsTo}. Want to try a broader term?`;
        console.log(msg);
        history.push(new AIMessage(msg));
        continue;
      }

      lastShipsTo = shipsTo;
      lastOptions = flat;

      const optionsText = lastOptions
        .map((v, idx) => {
          const opt = v.options ? Object.entries(v.options).map(([k, val]) => `${k}: ${val}`).join(", ") : "";
          const pricePart = v.priceUsd != null ? `${v.priceUsd}` : "?";
          const curPart = v.currency ?? "";
          const shop = v.shopUrl ?? "";
          return `#${idx + 1} ${v.title} - ${shop} - ${pricePart} ${curPart} - variant_id=${v.variantId ?? "?"}${opt ? ` (${opt})` : ""}`;
        })
        .join("\n");

      console.log(`Here are a few options:\n${optionsText}\n\nPick one by saying “option 4” / “x2”, or paste the variant_id.`);
      history.push(new AIMessage("Options shown."));
      continue;
    }

    // Fallback
    console.log("Sorry—can you rephrase that?");
    history.push(new AIMessage("Sorry—can you rephrase that?"));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
