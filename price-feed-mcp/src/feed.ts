/**
 * Fallback orchestrator. The fallback chain lives here in code, exactly as
 * 어르신 requested: the quote *lookup* is its own MCP server, and the
 * toss -> yahoo -> google fallback is internal code, not a separate system.
 */

import {
  fetchToss,
  fetchYahoo,
  fetchGoogle,
  tossConfigured,
  type Quote,
} from "./providers.js";

export interface Attempt {
  source: "toss" | "yahoo" | "google";
  ok: boolean;
  error?: string;
  skipped?: boolean;
}

export interface QuoteResult extends Quote {
  /** Per-provider trace so the caller can see what was tried and why. */
  attempts: Attempt[];
}

type Provider = {
  source: "toss" | "yahoo" | "google";
  fetch: (symbol: string) => Promise<Quote>;
  available: () => boolean;
};

const CHAIN: Provider[] = [
  { source: "toss", fetch: fetchToss, available: tossConfigured },
  { source: "yahoo", fetch: fetchYahoo, available: () => true },
  { source: "google", fetch: fetchGoogle, available: () => true },
];

/**
 * Try each provider in order, returning the first success along with the
 * full attempt trace. Throws only if every provider fails.
 */
export async function getQuote(symbol: string): Promise<QuoteResult> {
  const sym = symbol.trim().toUpperCase();
  if (!sym || !/^[A-Z.\-]{1,12}$/.test(sym)) {
    throw new Error(`invalid symbol: '${symbol}'`);
  }

  const attempts: Attempt[] = [];
  for (const provider of CHAIN) {
    if (!provider.available()) {
      attempts.push({ source: provider.source, ok: false, skipped: true });
      continue;
    }
    try {
      const quote = await provider.fetch(sym);
      attempts.push({ source: provider.source, ok: true });
      return { ...quote, attempts };
    } catch (err) {
      attempts.push({
        source: provider.source,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const detail = attempts
    .map((a) =>
      a.skipped ? `${a.source}: skipped` : `${a.source}: ${a.error ?? "failed"}`,
    )
    .join("; ");
  throw new Error(`all price providers failed for ${sym} — ${detail}`);
}
