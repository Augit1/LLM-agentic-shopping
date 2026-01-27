// src/agent/intent/parse.ts
export function parseQuantity(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (t === "one" || t === "1" || t.includes("just one")) return 1;

  const m = t.match(/\b(\d{1,2})\b/);
  if (!m) return null;

  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 20) return null;
  return n;
}

export function parseOptionChoice(text: string): number | null {
  const t = text.toLowerCase();

  const m1 = t.match(/option\s+(\d{1,2})\b/);
  if (m1) return Number(m1[1]);

  if (t.includes("first")) return 1;
  if (t.includes("second")) return 2;
  if (t.includes("third")) return 3;
  if (t.includes("fourth")) return 4;
  if (t.includes("fifth")) return 5;

  const m2 = t.match(/^\s*(\d{1,2})\s*$/);
  if (m2) return Number(m2[1]);

  return null;
}
