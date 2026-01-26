import { NextRequest, NextResponse } from "next/server";
import { runAgentMessage } from "@/lib/agent-bridge";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { message, history } = body;

    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    // Call the agent bridge to process the message
    const result = await runAgentMessage(message, history || []);

    return NextResponse.json({
      message: result.message,
      productOptions: result.productOptions,
    });
  } catch (error: any) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

