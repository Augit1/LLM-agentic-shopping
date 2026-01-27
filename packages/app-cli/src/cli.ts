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

/**
 * Minimal CLI spinner (no deps).
 * - Does not break readline input because it's used while you await async work.
 * - Call stop() in finally.
 */
export function startSpinner(label = "Thinking") {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let i = 0;
  let stopped = false;

  // Hide cursor (best effort)
  try { process.stdout.write("\x1B[?25l"); } catch {}

  const render = () => {
    const frame = frames[i++ % frames.length];
    process.stdout.write(`\r${frame} ${label}...`);
  };

  render();
  const timer = setInterval(render, 80);

  const stop = (finalText?: string) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);

    // Clear line
    process.stdout.write("\r\x1b[2K");

    if (finalText) process.stdout.write(finalText + "\n");

    // Show cursor
    try { process.stdout.write("\x1B[?25h"); } catch {}
  };

  return { stop };
}

/**
 * Convenience: wraps a promise with a spinner.
 */
export async function withSpinner<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: { okText?: string }
) {
  const sp = startSpinner(label);
  try {
    const out = await fn();
    sp.stop(opts?.okText ?? `✅ ${label}`);
    return out;
  } catch (e) {
    sp.stop(`❌ ${label}`);
    throw e;
  }
}
