// src/agent/tools/result.ts
export function toolResultToString(x: unknown): string {
  if (typeof x === "string") return x;
  if (x && typeof x === "object" && "content" in x) {
    const c = (x as any).content;
    return typeof c === "string" ? c : JSON.stringify(c);
  }
  return JSON.stringify(x);
}
