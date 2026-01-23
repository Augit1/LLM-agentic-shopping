// src/utils/shipping.ts
export function normalizeShipsTo(x: string) {
  const v = (x ?? "").trim().toUpperCase();
  if (v === "FRANCE" || v === "FRA") return "FR";
  if (v === "UNITED STATES" || v === "UNITED STATES OF AMERICA" || v === "USA") return "US";
  if (v === "UK" || v === "UNITED KINGDOM" || v === "GREAT BRITAIN") return "GB";
  return v;
}
