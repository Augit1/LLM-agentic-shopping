// src/agent/planner/linkOpen.ts
import { ChatOllama } from "@langchain/ollama";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export async function decideLinkOpen(args: {
  plannerLlm: ChatOllama;
  userText: string;
  assistantDraft: string;
  urls: string[];
}): Promise<{ open: boolean; urls: string[] }> {
  const { plannerLlm, userText, assistantDraft, urls } = args;
  if (!urls.length) return { open: false, urls: [] };

  const sys = [
    "You decide whether the app should open URLs in the user's browser now.",
    "Return ONLY valid JSON. No markdown.",
    "Rules:",
    "- If the user explicitly asks to open links/pages, open=true.",
    "- If the assistant provided URLs as a recommended next step to read/act, open=true.",
    "- Otherwise open=false.",
    "- Open at most 2 URLs.",
    "",
    'Return JSON: {"open": boolean, "urls": string[]}',
  ].join("\n");

  const msg = [
    `User message: ${userText}`,
    "",
    `Assistant draft: ${assistantDraft}`,
    "",
    `URLs: ${JSON.stringify(urls)}`,
  ].join("\n");

  const res = await plannerLlm.invoke([new SystemMessage(sys), new HumanMessage(msg)]);
  const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);

  // very small safe parse
  try {
    const obj = JSON.parse(text);
    const picked = Array.isArray(obj.urls) ? obj.urls.slice(0, 2) : [];
    return { open: !!obj.open, urls: picked };
  } catch {
    // fallback: if user asked "open" in any language, we let the model handle it elsewhere;
    // here we default to not auto-opening.
    return { open: false, urls: [] };
  }
}
