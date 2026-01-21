import { ALLOWED_SHIPS_TO, Env } from "./env.js";

export function enforcePolicy(args: { shipsTo: string; totalUsd: number; quantity: number }) {
  const shipsTo = (args.shipsTo ?? "").trim().toUpperCase();
  const qty = Number(args.quantity);

  if (!ALLOWED_SHIPS_TO.has(shipsTo)) {
    throw new Error(`Policy: ships_to ${shipsTo} not allowed`);
  }

  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`Policy: quantity must be a positive integer`);
  }

  if (qty > Env.MAX_QUANTITY) {
    throw new Error(`Policy: quantity ${qty} exceeds MAX_QUANTITY=${Env.MAX_QUANTITY}`);
  }

  const total = Number(args.totalUsd) * qty;
  if (!Number.isFinite(total)) {
    throw new Error(`Policy: invalid total`);
  }

  if (total > Env.MAX_TOTAL_USD) {
    throw new Error(`Policy: total ${total.toFixed(2)} exceeds MAX_TOTAL_USD=${Env.MAX_TOTAL_USD}`);
  }
}
