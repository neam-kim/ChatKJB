#!/usr/bin/env node
/**
 * price-feed-mcp — independent MCP server for near-real-time US stock quotes.
 *
 * Tool: get_quote(symbol) -> { price, currency, source, delaySeconds, asOf, attempts }
 *
 * Source preference (internal code fallback): toss -> yahoo -> google.
 * Toss self-skips until TOSS_APP_KEY / TOSS_APP_SECRET / TOSS_API_BASE are set,
 * so the chain is wired now and "just works" the moment 어르신's keys land.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getQuote } from "./feed.js";
import { tossConfigured } from "./providers.js";

const server = new McpServer({
  name: "price-feed",
  version: "0.1.0",
});

server.registerTool(
  "get_quote",
  {
    title: "Get stock quote",
    description:
      "Get a near-real-time US stock quote. Tries Toss Securities first (when " +
      "keys are provisioned), then falls back to Yahoo, then Google/Stooq. " +
      "Returns price, currency, source, and the data delay in seconds so the " +
      "caller can set a safe LIMIT price. Usage: { \"symbol\": \"AAPL\" }.",
    inputSchema: {
      symbol: z
        .string()
        .min(1)
        .max(12)
        .describe("US ticker symbol, e.g. AAPL"),
    },
  },
  async ({ symbol }) => {
    try {
      const result = await getQuote(symbol);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${message}` }],
      };
    }
  },
);

server.registerTool(
  "feed_status",
  {
    title: "Price feed status",
    description:
      "Report which quote providers are currently available, especially " +
      "whether the Toss Open API keys are provisioned yet.",
    inputSchema: {},
  },
  async () => {
    const status = {
      providers: {
        toss: tossConfigured()
          ? "configured"
          : "dormant (keys not provisioned)",
        yahoo: "available (Yahoo query1, ~15min delayed)",
        google: "available (Yahoo query2 backup host, ~15min delayed)",
      },
      fallbackOrder: ["toss", "yahoo", "google"],
      note:
        "The 'google' slot currently uses Yahoo's secondary host because " +
        "Google Finance / Stooq scraping was unreliable. Source labels in " +
        "get_quote reflect which upstream actually answered.",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("price-feed-mcp fatal:", err);
  process.exit(1);
});
