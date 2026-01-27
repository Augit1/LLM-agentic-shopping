// src/utils/quantity.ts
import { Env } from "../env.js";

export function clampQuantity(qty: unknown, fallback = 1) {
  const n = typeof qty === "number" ? qty : Number(qty);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), Env.MAX_QUANTITY);
}
