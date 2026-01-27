// packages/core/src/agent/session/shopifyState.ts
import type { AgentSession, ShopifyOption, ShopifySearchResult } from "./state.js";

export function tryParseJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unwrapToolSpecResult(obj: any): any {
  // ToolSpec returns { ok: true, data: {...} }
  if (obj && typeof obj === "object" && obj.ok === true && obj.data && typeof obj.data === "object") {
    return { ok: true, ...obj.data };
  }
  return obj;
}

export function tryParseShopifySearchResult(text: string): ShopifySearchResult | null {
  const raw = tryParseJson(text);
  if (!raw || typeof raw !== "object") return null;

  const obj = unwrapToolSpecResult(raw);
  if (!obj || typeof obj !== "object") return null;

  if (typeof (obj as any).ok !== "boolean") return null;
  return obj as ShopifySearchResult;
}

function optionKeyForDedupe(o: ShopifyOption): string {
  const bullets = (o.bullets ?? []).slice(0, 2).join("|");
  const seller = (o as any).seller ?? "";
  return [
    (o.title ?? "").trim().toLowerCase(),
    (o.price ?? "").trim().toLowerCase(),
    String(seller).trim().toLowerCase(),
    bullets.trim().toLowerCase(),
  ].join("::");
}

export function summarizeOptionsForPlanner(options: ShopifyOption[] | null): string {
  if (!options || options.length === 0) return "(none)";

  const seen = new Set<string>();
  const unique: ShopifyOption[] = [];

  for (const o of options) {
    const key = optionKeyForDedupe(o);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(o);
    if (unique.length >= 8) break;
  }

  return unique
    .map((o) => {
      const bullets = (o.bullets ?? []).slice(0, 2).join("; ");
      const seller = (o as any).seller ? ` — seller: ${(o as any).seller}` : "";
      return `Option ${o.option_index}: ${o.title} — ${o.price}${seller}${bullets ? ` — ${bullets}` : ""}`;
    })
    .join("\n");
}

export function updateSessionFromShopifyResult(session: AgentSession, resultText: string) {
  const parsed = tryParseShopifySearchResult(resultText);
  if (!parsed?.ok || !Array.isArray(parsed.options)) return;

  session.lastShopifyOptions = parsed.options;
  session.lastShopifyQuery = parsed.query ?? null;
  if (parsed.ships_to) session.lastShipsTo = parsed.ships_to;

  // new options reset selection
  session.selectedOptionIndex = null;
  session.selectedQuantity = null;
}

export function getCheckoutUrlForOption(session: AgentSession, optionIndex: number | null): string | null {
  if (!optionIndex || !session.lastShopifyOptions) return null;
  const opt = session.lastShopifyOptions.find((o) => o.option_index === optionIndex);
  return opt?.checkout_url ?? null;
}
