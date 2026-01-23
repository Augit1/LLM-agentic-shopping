// src/browser/mcp.ts
import type { McpClient } from "../mcp/types.js";
import { Env, DEBUG } from "../env.js";
import { HttpMcpClient } from "../mcp/httpClient.js";

function redact(s?: string) {
  if (!s) return "(none)";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

function withSessionId(url: string, sessionId: string) {
  const u = new URL(url);
  u.searchParams.set("sessionId", sessionId);
  return u.toString();
}

/**
 * Try to establish a sessionId for MCP servers that require it as a query parameter.
 * Many "streamable HTTP" MCP servers expose an SSE endpoint that returns a sessionId.
 *
 * This function tries a few common endpoints and extracts sessionId from the first SSE data payload.
 */
async function tryGetSessionId(
  baseMcpUrl: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const base = new URL(baseMcpUrl);

  // Try common SSE endpoints derived from the MCP URL
  const candidates: string[] = [];

  // 1) Same URL (some servers do GET /mcp for SSE)
  candidates.push(base.toString());

  // 2) /sse next to /mcp
  {
    const u = new URL(base.toString());
    u.pathname = u.pathname.replace(/\/mcp\/?$/, "/sse");
    candidates.push(u.toString());
  }

  // 3) /events next to /mcp (seen in some servers)
  {
    const u = new URL(base.toString());
    u.pathname = u.pathname.replace(/\/mcp\/?$/, "/events");
    candidates.push(u.toString());
  }

  // 4) /stream next to /mcp
  {
    const u = new URL(base.toString());
    u.pathname = u.pathname.replace(/\/mcp\/?$/, "/stream");
    candidates.push(u.toString());
  }

  // SSE parsing helper: find sessionId in SSE "data:" lines (JSON or plain text)
  async function readSessionIdFromSse(url: string): Promise<string | null> {
    const ctrl = new AbortController();
    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...headers,
        accept: "text/event-stream",
      },
      signal: ctrl.signal,
    });

    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE events are line based. Look for "data:" lines.
        // We’ll scan quickly and stop as soon as sessionId appears.
        const matchJson = buf.match(/"sessionId"\s*:\s*"([^"]+)"/);
        if (matchJson?.[1]) {
          ctrl.abort();
          return matchJson[1];
        }

        const matchDataLine = buf.match(/^data:\s*(.+)$/m);
        if (matchDataLine?.[1]) {
          const data = matchDataLine[1].trim();
          // If data is plain JSON, parse it
          try {
            const parsed = JSON.parse(data);
            if (parsed?.sessionId && typeof parsed.sessionId === "string") {
              ctrl.abort();
              return parsed.sessionId;
            }
          } catch {
            // If it’s not JSON, see if it looks like a UUID-ish token
            const token = data.replace(/^"|"$/g, "");
            if (token.length >= 8) {
              ctrl.abort();
              return token;
            }
          }
        }

        // Prevent unbounded growth
        if (buf.length > 64_000) buf = buf.slice(-16_000);
      }
    } finally {
      try {
        ctrl.abort();
      } catch {}
    }

    return null;
  }

  for (const url of candidates) {
    try {
      if (DEBUG) console.log("[browser mcp] trying SSE for sessionId:", url);
      const sid = await readSessionIdFromSse(url);
      if (sid) return sid;
    } catch {
      // ignore and continue
    }
  }

  return null;
}

export async function createBrowserMcpClient(): Promise<McpClient> {
  const url = (Env.BROWSER_MCP_URL ?? "").trim();
  if (!url) throw new Error("Missing BROWSER_MCP_URL in .env");

  const getHeaders = async () => {
    const h: Record<string, string> = {};
    const key = (Env.BROWSER_MCP_API_KEY ?? "").trim();
    if (key) h["authorization"] = `Bearer ${key}`;
    return h;
  };

  const headers = await getHeaders();

  if (DEBUG) {
    console.log("[browser mcp url]", url);
    console.log("[browser mcp key]", redact((Env.BROWSER_MCP_API_KEY ?? "").trim()));
  }

  // Prefer explicit session ID (most reliable)
  const explicitSessionId = (process.env.BROWSER_MCP_SESSION_ID ?? "").trim();
  let sessionId = explicitSessionId || null;

  if (!sessionId) {
    sessionId = await tryGetSessionId(url, headers);
  }

  if (!sessionId) {
    // Do not hard-crash your whole agent; just fail browser tool setup clearly.
    // run.ts already guards browser tools with browserClient existence.
    throw new Error(
      "Browser MCP requires sessionId query parameter. " +
        "Set BROWSER_MCP_SESSION_ID in .env (recommended), or run a Browser MCP server that doesn't require sessions.",
    );
  }

  const sessionUrl = withSessionId(url, sessionId);

  if (DEBUG) {
    console.log("[browser mcp sessionId]", redact(sessionId));
    console.log("[browser mcp session url]", sessionUrl);
    console.log();
  }

  return new HttpMcpClient(sessionUrl, async () => headers);
}
