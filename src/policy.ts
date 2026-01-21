import { Env, ALLOWED_SHIPS_TO } from "./env.js";

export function enforcePolicy(input: {
  shipsTo: string;
  totalUsd: number;
  quantity: number;
}) {
  if (!ALLOWED_SHIPS_TO.has(input.shipsTo)) {
    throw new Error(`Policy: ships_to ${input.shipsTo} not allowed`);
  }
  if (input.quantity < 1 || input.quantity > 1) {
    throw new Error(`Policy: quantity must be 1 for POC`);
  }
  if (input.totalUsd > Env.MAX_TOTAL_USD) {
    throw new Error(`Policy: total ${input.totalUsd} exceeds MAX_TOTAL_USD=${Env.MAX_TOTAL_USD}`);
  }
}
