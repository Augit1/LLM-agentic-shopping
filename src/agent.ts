import readline from "node:readline";
import { Env, REQUIRE_YES } from "./env.js";
import { HttpMcpClient } from "./mcp/httpClient.js";
import { StdioMcpClient } from "./mcp/stdioClient.js";
import type { McpClient } from "./mcp/types.js";
import { ollamaChat } from "./ollama.js";
import { normalizeSearchResult } from "./normalize.js";
import { enforcePolicy } from "./policy.js";

type Intent =
  | { intent: "SEARCH"; query: string; ships_to: string; max_price?: number }
  | { intent: "CHOOSE_VARIANT"; upid?: string; variant_id?: string; quantity: number }
  | { intent: "CONFIRM"; yes: boolean }
  | { intent: "ASK_CLARIFICATION"; question: string }
  | { intent: "CANCEL" };

function systemPrompt() {
  return `You are a shopping assistant running locally. Output ONLY valid JSON.
Allowed intents:
- SEARCH {query, ships_to, max_price?}
- CHOOSE_VARIANT {variant_id or upid, quantity}
- CONFIRM {yes}
- ASK_CLARIFICATION {question}
- CANCEL

Rules:
- Never invent IDs.
- If user request lacks ships_to country code, ask clarification.
- Keep results to 3 options.
- Always ask for confirmation before generating checkout link.`;
}

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
  process.exit(1);
});

async function createMcp(urlOrCmd: string, jwt: string, kind: "catalog" | "checkout"): Promise<McpClient> {
  const headers = { Authorization: `Bearer ${jwt}` };

  if (Env.MCP_TRANSPORT === "http") {
    if (!urlOrCmd) throw new Error(`${kind} MCP URL missing`);
    return new HttpMcpClient(urlOrCmd, headers);
  } else {
    // For stdio servers, pass token in env if needed; otherwise you can ignore
    return new StdioMcpClient(urlOrCmd, { BEARER_TOKEN: jwt, SHOPIFY_ACCESS_TOKEN: jwt });
  }
}

function parseIntent(s: string): Intent {
  const trimmed = s.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return { intent: "ASK_CLARIFICATION", question: "I couldn't parse that. Please rephrase." };
  }
}

async function main() {
  const catalog = await createMcp(Env.CATALOG_MCP_URL ?? Env.CATALOG_MCP_CMD ?? "", Env.BEARER_TOKEN, "catalog");
  const checkout = await createMcp(Env.CHECKOUT_MCP_URL ?? Env.CHECKOUT_MCP_CMD ?? "", Env.BEARER_TOKEN, "checkout");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  let memory: Array<{ role: string; content: string }> = [{ role: "system", content: systemPrompt() }];

  // POC state
  let lastShortlist: any[] | null = null;
  let selected: { title: string; variant_id?: number; checkoutUrl?: string; priceUsd?: number; shipsTo: string } | null = null;

  console.log("Local agent ready. Ask me to find and buy something.\n");

  while (true) {
    const user = await ask("> ");
    if (!user) continue;

    memory.push({ role: "user", content: user });
    const out = await ollamaChat(memory);
    const intent = parseIntent(out);

    if (intent.intent === "CANCEL") {
      console.log("Cancelled.");
      selected = null;
      lastShortlist = null;
      memory.push({ role: "assistant", content: JSON.stringify(intent) });
      continue;
    }

    if (intent.intent === "ASK_CLARIFICATION") {
      console.log(intent.question);
      memory.push({ role: "assistant", content: JSON.stringify(intent) });
      continue;
    }

    if (intent.intent === "SEARCH") {
      const context = Env.DEFAULT_CONTEXT || "Buyer is price-sensitive. Provide best value.";
      const raw = await catalog.callTool("search_global_products", {
        query: intent.query,
        ships_to: intent.ships_to,
        max_price: intent.max_price,
        limit: 10,
        available_for_sale: true,
        include_secondhand: false,
        context,
      });

      const shortlist = normalizeSearchResult(raw, 3, 3);
      lastShortlist = shortlist;

      const optionsText = shortlist
        .flatMap((p, i) =>
          p.variants.map((v, j) => {
            const opt = v.options ? Object.entries(v.options).map(([k, val]) => `${k}:${val}`).join(", ") : "";
            return `#${i + 1}.${j + 1} ${v.title} - ${v.shopDomain ?? ""} - ${v.priceUsd ?? "?"} ${v.currency ?? ""} - variant_id=${v.variantId ?? "?"} (${opt})`;
          }),
        )
        .join("\n");

      const assistantMsg = `Here are options:\n${optionsText}\n\nChoose one by providing variant_id and quantity=1.`;
      console.log(assistantMsg);

      memory.push({ role: "assistant", content: assistantMsg });
      continue;
    }

    if (intent.intent === "CHOOSE_VARIANT") {
      if (!lastShortlist) {
        console.log("No shortlist yet. Ask me to search first.");
        continue;
      }
      const variantId = intent.variant_id?.trim();
      if (!variantId) {
        console.log("Please provide a variant_id from the results.");
        continue;
      }

      // Find it in shortlist
      const found = lastShortlist
        .flatMap((p: any) => p.variants)
        .find((v: any) => String(v.variantId) === variantId);

      if (!found) {
        console.log("variant_id not found in shortlist. Search again.");
        continue;
      }

      // Policy check (item price only here; totals may change with shipping/tax later)
      enforcePolicy({ shipsTo: "US", totalUsd: found.priceUsd ?? 0, quantity: 1 });

      selected = {
        title: found.title,
        variant_id: variantId,
        checkoutUrl: found.checkoutUrl,
        priceUsd: found.priceUsd,
        shipsTo: "US",
      };

      const recap = `Selected: ${found.title} (${found.shopDomain}) price ~${found.priceUsd} ${found.currency}
I can generate a checkout link. Type YES to confirm.`;
      console.log(recap);
      memory.push({ role: "assistant", content: recap });
      continue;
    }

    if (intent.intent === "CONFIRM") {
      if (!selected) {
        console.log("Nothing selected yet.");
        continue;
      }
      if (!intent.yes) {
        console.log("Not confirmed. You can choose another option or cancel.");
        continue;
      }

      if (REQUIRE_YES) {
        // additionally require literal YES from user for safety
        // (since model can output yes=true too easily)
        const raw = await ask("Type YES to proceed: ");
        if (raw.trim().toUpperCase() !== "YES") {
          console.log("Aborted.");
          continue;
        }
      }

      // If you have Checkout MCP tools, you would:
      // - checkout.callTool("create_checkout", ...)
      // - loop update/complete
      // But since we don't know your exact checkout tool names yet, we fall back to checkoutUrl.
      if (selected.checkoutUrl) {
        console.log(`Checkout link:\n${selected.checkoutUrl}\n\nOpen it in your browser to pay. Reply 'done' after payment if you want to continue.`);
      } else {
        console.log("No checkoutUrl available. Try get_global_product_details for this variant_id.");
      }

      // OPTIONAL: if your Checkout MCP exposes create/complete tools, you can wire them here once we know names.
      continue;
    }

    // fallback
    console.log("Unhandled intent. Try again.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
