// src/utils/url.ts
import { spawn } from "node:child_process";
import { clampQuantity } from "./quantity.js";

export function openUrl(url: string) {
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

export function hostFromUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function withQuantityInCheckoutUrl(checkoutUrl: string, qty: number) {
  const q = clampQuantity(qty, 1);
  return checkoutUrl.replace(/\/cart\/(\d+):(\d+)/, (_m, vid) => `/cart/${vid}:${q}`);
}
