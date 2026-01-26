# LLM Agentic Payment Assistant

A modern AI-powered shopping and payment assistant with a beautiful web interface.

## Features

- 🤖 **AI-Powered Assistant**: Uses Ollama LLM for natural language understanding
- 🛍️ **Shopify Integration**: Search and browse products from Shopify stores
- 💳 **Smart Checkout**: Automatically opens checkout when you're ready to buy
- 🌐 **Web Search**: Integrated web search capabilities for product research
- 🎨 **Modern UI**: Clean, responsive interface built with Next.js 15 and Tailwind CSS

## Prerequisites

- Node.js 18+ and pnpm
- Ollama running locally (default: `http://localhost:11434`)
- Environment variables configured (see `.env.example`)

## Installation

1. Install dependencies:
```bash
pnpm install
```

2. Set up your environment variables. Create a `.env` file with:
```env
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b-instruct
# Add your Shopify and other API keys as needed
```

3. Start the development server:
```bash
pnpm dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

### Web Interface (Recommended)

1. Start the Next.js dev server: `pnpm dev`
2. Open the browser and start chatting with the assistant
3. Ask for products, compare options, and checkout seamlessly

### CLI Interface

If you prefer the command-line interface:

```bash
pnpm dev:cli
```

## Project Structure

```
├── app/              # Symlink to src/frontend/app (Next.js app directory)
├── src/
│   ├── frontend/     # Frontend code
│   │   ├── app/      # Next.js app directory
│   │   │   ├── api/  # API routes
│   │   │   ├── page.tsx      # Main chat interface
│   │   │   └── layout.tsx    # Root layout
│   │   ├── components/       # React components
│   │   │   ├── ChatMessage.tsx
│   │   │   ├── ChatInput.tsx
│   │   │   └── ProductOptions.tsx
│   │   ├── lib/              # Server-side utilities
│   │   │   └── agent-bridge.ts  # Bridge between Next.js and agent
│   │   └── types/            # TypeScript type definitions
│   ├── agent/        # Agent implementation
│   ├── shopify/      # Shopify integration
│   ├── search/       # Web search integration
│   └── browser/      # Browser automation
```

## Tech Stack

- **Frontend**: Next.js 15, React 18, Tailwind CSS
- **Backend**: Node.js, LangChain, Ollama
- **Styling**: Tailwind CSS with custom design system
- **Type Safety**: TypeScript

## Development

- `pnpm dev` - Start Next.js development server
- `pnpm dev:cli` - Start CLI interface
- `pnpm build` - Build for production
- `pnpm typecheck` - Run TypeScript type checking

## License

ISC

