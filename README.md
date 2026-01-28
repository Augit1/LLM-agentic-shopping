# Agentic Commerce CLI (LLM + MCP)

A local, command-line, agentic shopping assistant built on Ollama, LangChain, and the Model Context Protocol (MCP).

The assistant can:
- Understand natural language shopping requests
- Plan tool usage autonomously (model-driven)
- Search a Shopify-style catalog via MCP
- Optionally use web search and browser tools for freshness and verification
- Present concise product options
- Let the user select an option and quantity
- Safely open a real checkout link in the browser (runtime-only)

This project is designed as a clean foundation for real-world agentic systems, not a demo bot.


## Core Principles

- Model-driven reasoning (no hardcoded product logic)
- Runtime-only side effects (LLM never opens URLs)
- MCP-based integrations
- Strong typing and validation (Zod)
- CLI-first, transparent execution
- Safety over convenience (no fake links, no hallucinated checkouts)


## High-Level Architecture

```bash
User
  |
  v
CLI (app-cli)
  |
  v
Agent Runtime (core)
  - Intent detection
  - Planner (LLM)
  - Tool execution loop
  - Session state
  - Checkout guardrails
  |
  v
Tools (via MCP or local actions)
  - Shopify catalog search (MCP)
  - Web search (Tavily or similar)
  - Browser read (MCP)
  - Core actions (open browser, adjust checkout quantity)
```

The LLM decides WHAT to do.
The runtime decides IF it is allowed.


## Monorepo Structure

```bash
packages/
  app-cli/
    src/
      main.ts
      cli.ts
      runtime/runAgent.ts

  core/
    src/
      agent/
        planner/
        intent/
        checkout/
        session/
        utils/
      tools/
        actions.ts
      mcp/
      env.ts

  integrations-shopify/
    src/
      tools.ts
      mcp.ts
      normalize.ts

  integrations-search/
    src/
      tools.ts

  integrations-browser/
    src/
      tools.ts
      mcp.ts
```


## Tool Model

Two categories of tools exist:

Information tools (LLM-callable):
- shopify_search
- web_search
- browser_read

Action tools (runtime-only):
- open_in_browser
- adjust_checkout_quantity

The LLM may REQUEST actions, but only the runtime executes them after validation.


## Planner (Model-Driven)

The planner LLM:
- Receives user input + session context
- Outputs a JSON plan describing tool calls
- Is not allowed to execute side effects
- Is automatically repaired if it outputs invalid JSON

Example planner output:

```json
{
  "tool_calls": [
    { "name": "web_search", "args": { "query": "Macron sunglasses Davos" } },
    { "name": "shopify_search", "args": { "query": "Henry Jullien Pacific S 01", "ships_to": "US" } }
  ],
  "rationale": "Identify exact model, then find buyable options."
}
```

## Agent Loop (Simplified)

1. Read user input
2. Classify intent (buy / explore)
3. Planner decides which tools to use
4. Tools execute with validation and spinners
5. Model produces a response
6. Runtime optionally opens checkout link (if allowed)

Each step shows progress in the CLI.


## What Works Today

- Shopify catalog search via MCP
- Consistent option card formatting
- User selection of option and quantity
- Safe checkout URL handling
- Model-driven planning
- Modular tool system
- Debug-friendly logging


## Known Issues / Work in Progress

### Search integration
- Tavily or other web search must be correctly wired:
  - Either via a proper MCP adapter
  - Or via a direct REST-based tool
- Ensure the tool actually appears in tools/list
- Ensure the planner is encouraged to use it for fresh info

### Browser MCP
- Some browser MCP servers require sessionId handling
- Client may need to create and persist a session
- Tools/list should be validated manually

### Prompt refinement
- Planner should stay flexible, not over-templated
- Natural interaction while preserving safety rules


## Running the Project

Requirements:
- Node.js 18+
- pnpm
- Ollama running locally
- MCP servers available (Shopify, Browser, Search)

Install:

```bash
pnpm install
```

Run:

```bash
pnpm dev
```

You should see:

```bash
Local agent ready. Ask me anything.
>
```


## Environment Variables

```env
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3

TAVILY_API_KEY=...

BROWSER_MCP_URL=http://localhost:4444/mcp

AUTO_OPEN_CHECKOUT=true
TOKEN_CACHE_PATH=.cache/shopify_token.json
```


## Current Goal

Make web search and browser tools reliably usable so the agent:
- Knows about recent events and products
- Can verify exact models before shopping
- Combines catalog data with fresh web knowledge

Once this is stable, new MCPs (reviews, local inventory, pricing) can be added with minimal effort.


## One-Sentence Summary

This is a modular, model-driven CLI shopping agent that safely combines LLM reasoning with real product catalogs and controlled real-world actions via MCP.


## License

This project is licensed under the **MIT License**.

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
