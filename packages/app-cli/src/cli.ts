// src/cli/io.ts
import readline from "node:readline";

export function makeCli() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  return { rl, ask };
}

export async function typewriterPrint(text: string, delayMs: number) {
  if (!delayMs || delayMs <= 0) {
    process.stdout.write(text + "\n");
    return;
  }
  for (const ch of text) {
    process.stdout.write(ch);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  process.stdout.write("\n");
}
