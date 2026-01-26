// src/agent/checkout/autoCheckout.ts
import type { AgentSession } from "../session/state.js";
import { getCheckoutUrlForOption, tryParseJson } from "../session/shopifyState.js";
import { toolResultToString } from "../tools/result.js";

type BuyIntentFn =
  | ((userText: string) => boolean | Promise<boolean>)
  | ((args: { userText: string; lastAssistantText?: string; session: any }) => boolean | Promise<boolean>);

async function evalBuyIntent(fn: BuyIntentFn, args: { userText: string; lastAssistantText?: string; session: any }) {
  try {
    // Support both shapes: fn("text") OR fn({userText,...})
    if (fn.length <= 1) {
      return await (fn as any)(args.userText);
    }
    return await (fn as any)(args);
  } catch {
    return false;
  }
}

export async function tryAutoCheckout(args: {
  session: AgentSession;
  userText: string;
  lastAssistantText?: string;
  isBuyIntent: BuyIntentFn;
  openInBrowser: (args: { url: string }) => Promise<any>;
  adjustCheckoutQuantity: (args: { url: string; quantity: number }) => Promise<any>;
  debug?: boolean;
}): Promise<{ didOpen: boolean; message?: string }> {
  const {
    session,
    userText,
    lastAssistantText,
    isBuyIntent,
    openInBrowser,
    adjustCheckoutQuantity,
    debug,
  } = args;

  const buy = await evalBuyIntent(isBuyIntent, { userText, lastAssistantText, session });
  if (!buy) return { didOpen: false };

  // If an option is selected but no quantity was specified, default to 1.
  if (session.selectedOptionIndex && !session.selectedQuantity) {
    session.selectedQuantity = 1;
  }

  if (!session.selectedOptionIndex || !session.selectedQuantity) return { didOpen: false };

  const checkoutUrl = getCheckoutUrlForOption(session, session.selectedOptionIndex);
  if (!checkoutUrl) return { didOpen: false };

  try {
    const adjustedRaw = await adjustCheckoutQuantity({
      url: checkoutUrl,
      quantity: session.selectedQuantity,
    });

    const adjustedText = toolResultToString(adjustedRaw);
    const adjustedObj = tryParseJson(adjustedText);
    const finalUrl = adjustedObj?.url ?? checkoutUrl;

    await openInBrowser({ url: finalUrl });

    return {
      didOpen: true,
      message: `Opening checkout now for Option ${session.selectedOptionIndex} (qty ${session.selectedQuantity}).`,
    };
  } catch (e: any) {
    if (debug) console.log("[auto-checkout] failed:", e?.message ?? String(e));
    return { didOpen: false };
  }
}
