/**
 * Toss-only quote orchestrator for real-money order gating.
 */

import {
  fetchToss,
  fetchTossExchangeRate,
  fetchTossOrderBook,
  tossConfigured,
  type ExchangeRate,
  type OrderBook,
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

export interface OrderBookResult extends OrderBook {
  /** Per-provider trace so the caller can see what was tried and why. */
  attempts: Attempt[];
}

export interface ExchangeRateResult extends ExchangeRate {
  attempts: Attempt[];
}

type Provider = {
  source: "toss";
  fetchQuote: (symbol: string) => Promise<Quote>;
  fetchOrderBook: (symbol: string) => Promise<OrderBook>;
  available: () => boolean;
};

const CHAIN: Provider[] = [
  {
    source: "toss",
    fetchQuote: fetchToss,
    fetchOrderBook: fetchTossOrderBook,
    available: tossConfigured,
  },
];

function normalizeSymbol(symbol: string): string {
  const sym = symbol.trim().toUpperCase();
  if (!sym || !/^[A-Z0-9.\-]{1,20}$/.test(sym)) {
    throw new Error(`invalid symbol: '${symbol}'`);
  }
  return sym;
}

function failureMessage(kind: string, symbol: string, attempts: Attempt[]): string {
  const detail = attempts
    .map((a) =>
      a.skipped ? `${a.source}: skipped` : `${a.source}: ${a.error ?? "failed"}`,
    )
    .join("; ");
  return `all ${kind} providers failed for ${symbol} — ${detail}`;
}

/**
 * Try the Toss provider, returning the quote along with the attempt trace.
 * Throws when Toss is not configured or fails.
 */
export async function getQuote(symbol: string): Promise<QuoteResult> {
  const sym = normalizeSymbol(symbol);

  const attempts: Attempt[] = [];
  for (const provider of CHAIN) {
    if (!provider.available()) {
      attempts.push({ source: provider.source, ok: false, skipped: true });
      continue;
    }
    try {
      const quote = await provider.fetchQuote(sym);
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

  throw new Error(failureMessage("price", sym, attempts));
}

/**
 * Try the Toss provider, returning the order book along with the attempt trace.
 * Throws when Toss is not configured or fails.
 */
export async function getOrderBook(symbol: string): Promise<OrderBookResult> {
  const sym = normalizeSymbol(symbol);

  const attempts: Attempt[] = [];
  for (const provider of CHAIN) {
    if (!provider.available()) {
      attempts.push({ source: provider.source, ok: false, skipped: true });
      continue;
    }
    try {
      const orderBook = await provider.fetchOrderBook(sym);
      attempts.push({ source: provider.source, ok: true });
      return { ...orderBook, attempts };
    } catch (err) {
      attempts.push({
        source: provider.source,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new Error(failureMessage("order book", sym, attempts));
}

/** Get the current Toss reference rate for 1 USD in KRW. */
export async function getExchangeRate(): Promise<ExchangeRateResult> {
  if (!tossConfigured()) {
    throw new Error("all exchange-rate providers failed — toss: skipped");
  }
  try {
    const rate = await fetchTossExchangeRate();
    return { ...rate, attempts: [{ source: "toss", ok: true }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`all exchange-rate providers failed — toss: ${message}`);
  }
}
