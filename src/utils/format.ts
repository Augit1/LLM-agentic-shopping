// src/utils/format.ts
export function formatMoney(amount: number | null | undefined, currency?: string | null) {
  if (amount == null || !Number.isFinite(amount)) return null;
  const cur = (currency ?? "USD").toUpperCase();
  return cur === "USD" ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${cur}`;
}

export function inferCondition(title: string, options: Record<string, any>) {
  const t = (title ?? "").toLowerCase();
  const optText = Object.entries(options ?? {})
    .map(([k, v]) => `${k}:${v}`.toLowerCase())
    .join(" ");

  if (t.includes("refurb") || optText.includes("refurb")) return "Refurbished";
  if (t.includes("open box") || optText.includes("open box")) return "Open box";
  if (t.includes("used") || optText.includes("used")) return "Used";
  if (t.includes("new") || optText.includes("new")) return "New";
  return null;
}

export function pickKeyBullets(options: Record<string, any>) {
  const preferredKeys = [
    "storage",
    "color",
    "grade",
    "condition",
    "style",
    "size",
    "model",
    "capacity",
    "cover option",
    "cosmetic condition",
  ];

  const entries = Object.entries(options ?? {});
  const normalized: ReadonlyArray<readonly [string, string]> = entries.map(([k, v]) => [
    String(k).trim(),
    String(v).trim(),
  ] as const);
     
  const picked: Array<readonly [string, string]> = [];
  for (const pk of preferredKeys) {
    const found = normalized.find(([k]) => k.toLowerCase() === pk.toLowerCase());
    if (found) picked.push(found);
    if (picked.length >= 3) break;
  }

  if (picked.length === 0) {
    for (const kv of normalized.slice(0, 2)) picked.push(kv);
  }

  return picked
    .filter(([k, v]) => k && v)
    .map(([k, v]) => `${k}: ${v}`);
}
