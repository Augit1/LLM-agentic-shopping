// src/utils/auth.ts
import crypto from "node:crypto";

export function tokenFingerprint(token: string) {
  const t = (token ?? "").trim();
  return crypto.createHash("sha256").update(t).digest("hex").slice(0, 12);
}

export function cleanToken(x: string) {
  return (x ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}
