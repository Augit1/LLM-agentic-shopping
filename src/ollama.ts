import { Env } from "./env.js";

type ChatMessage = { role: string; content: string };

export async function ollamaChat(messages: ChatMessage[]) {
  // Add a tiny guardrail message at the end to reduce "not valid JSON" outputs.
  // This does not replace your system prompt; it just reinforces strict JSON.
  const guarded: ChatMessage[] = [
    ...messages,
    {
      role: "system",
      content:
        "Reminder: Output ONLY a single valid JSON object. No markdown, no backticks, no extra text.",
    },
  ];

  const res = await fetch(`${Env.OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: Env.OLLAMA_MODEL,
      messages: guarded,
      stream: false,
      // If the model supports it, this greatly improves structured JSON output.
      // If unsupported, Ollama will ignore it.
      format: "json",
      options: {
        temperature: 0.2,
        // Helps reduce rambling / non-JSON completions.
        num_predict: 256,
      },
    }),
  });

  const bodyText = await res.text();
  if (!res.ok) throw new Error(`Ollama error: ${res.status} ${bodyText}`);

  let json: any;
  try {
    json = JSON.parse(bodyText);
  } catch {
    // Some setups/proxies might not return JSON here; fail loudly with body.
    throw new Error(`Ollama response was not valid JSON:\n${bodyText}`);
  }

  const content = (json?.message?.content ?? "") as string;

  // Defensive: trim whitespace
  return content.trim();
}
