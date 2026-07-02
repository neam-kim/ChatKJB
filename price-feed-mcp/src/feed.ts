/**
 * Toss-only quote orchestrator. This MCP server intentionally avoids public
 * Yahoo/Google-style fallback feeds for real-money order gating.
 */

import {
  fetchToss,
  tossConfigured,
  type Quote,
} from "./providers.js";

export interface Attempt {
  source: "toss";
  ok: boolean;
  error?: string;
  skipped?: boolean;
}

export interface QuoteResult extends Quote {
  /** Per-provider trace so the caller can see what was tried and why. */
  attempts: Attempt[];
}

type Provider = {
  source: "toss";
  fetch: (symbol: string) => Promise<Quote>;
  available: () => boolean;
};

const CHAIN: Provider[] = [
  { source: "toss", fetch: fetchToss, available: tossConfigured },
];

/**
 * Try the Toss provider, returning the quote along with the attempt trace.
 * Throws when Toss is not configured or fails.
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
