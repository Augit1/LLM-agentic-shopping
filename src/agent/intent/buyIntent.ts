// src/agent/intent/buyIntentModel.ts
import { ChatOllama } from "@langchain/ollama";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

type BuyIntentResult = { buy: boolean; confidence: number };

function safeParseJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function isBuyIntentModel(args: {
  llm: ChatOllama;
  userText: string;
  lastAssistantText: string;
  hasSelectedOption: boolean;
  hasQuantity: boolean;
  hasCheckoutUrl: boolean;
  debug?: boolean;
}): Promise<boolean> {
  const {
    llm,
    userText,
    lastAssistantText,
    hasSelectedOption,
    hasQuantity,
    hasCheckoutUrl,
    debug,
  } = args;

  const sys = [
    "You are a classifier for a shopping assistant.",
    "Return ONLY valid JSON: {\"buy\": boolean, \"confidence\": number}.",
    "",
    "Decide if the user wants to proceed to checkout NOW.",
    "Use context:",
    "- user message",
    "- last assistant message (may contain checkout link or questions like 'open it now?')",
    "- whether an option + quantity + checkoutUrl are already known",
    "",
    "Guidelines:",
    "- If the user confirms (yes/ok/go ahead/si/oui/etc.) right after assistant asked to open checkout, that's buy=true.",
    "- If the user asks to buy/checkout/pay/open the checkout, buy=true.",
    "- If the user is still choosing options or asking questions, buy=false.",
    "",
    "Be language-agnostic.",
  ].join("\n");

  const human = [
    `USER: ${userText}`,
    `LAST_ASSISTANT: ${lastAssistantText || "(none)"}`,
    `STATE: selectedOption=${hasSelectedOption} quantity=${hasQuantity} checkoutUrl=${hasCheckoutUrl}`,
  ].join("\n");

  const res = await llm.invoke([new SystemMessage(sys), new HumanMessage(human)]);
  const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);

  const obj = safeParseJson(text) as BuyIntentResult | null;
  if (!obj || typeof obj.buy !== "boolean") {
    if (debug) console.log("[buy-intent] invalid JSON:", text.slice(0, 200));
    return false;
  }

  if (debug) console.log("[buy-intent] result:", obj);
  return obj.buy === true && (obj.confidence ?? 0) >= 0.4;
}
