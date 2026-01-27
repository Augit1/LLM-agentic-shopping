// src/agent/utils/urls.ts
export function extractUrls(text: string): string[] {
  const re = /\bhttps?:\/\/[^\s)<>"']+/gi;
  const found = text.match(re) ?? [];
  // de-dupe preserving order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of found) {
    const clean = u.replace(/[.,;:!?]+$/g, "");
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}
