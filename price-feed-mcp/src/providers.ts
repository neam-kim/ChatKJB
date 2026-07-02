/**
 * Quote providers. Each provider returns a normalized Quote or throws.
 *
 * Design notes for 어르신's safety requirements:
 * - Every quote carries its `source` and `delaySeconds` so the caller can
 *   decide whether the value is usable for an IBKR order gate.
 * - Toss is the only external stock-price provider wired here.
 */

export interface Quote {
  symbol: string;
  /** Last traded / current price in the quote currency. */
  price: number;
  currency: string;
  /** Which upstream produced this value. */
  source: "toss";
  /** Approximate data delay in seconds (0 = real-time, 900 = 15 min). */
  delaySeconds: number;
  /** Provider-reported timestamp (ms epoch) when available, else fetch time. */
  asOf: number;
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
  }
}

const DEFAULT_TIMEOUT_MS = 8000;

async function fetchJson(
  url: string,
  provider: string,
  init?: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        // A UA avoids some endpoints returning 403 to header-less clients.
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) price-feed-mcp/0.1",
        accept: "application/json,text/plain,*/*",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new ProviderError(provider, `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new ProviderError(provider, reason);
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

/* ---------------------------------------------------------------- Toss --- */

/**
 * Toss Securities Open API.
 *
 * As of 2026-06 the official spec is REST-only (no public WebSocket yet) and
 * the key issuance is gated behind the not-yet-general-availability period.
 * So this provider is fully wired but stays dormant until the env keys exist.
 *
 * Endpoint/field paths below are intentionally read from env so they can be
 * corrected the moment 어르신's keys + final docs land, without code edits:
 *   TOSS_API_BASE      e.g. https://openapi.tossinvest.com
 *   TOSS_QUOTE_PATH    e.g. /v1/overseas/quote   ({symbol} placeholder)
 *   TOSS_PRICE_FIELD   dot-path to the price, e.g. "result.price"
 *   TOSS_APP_KEY / TOSS_APP_SECRET  (OAuth client credentials)
 */
export function tossConfigured(): boolean {
  return Boolean(
    process.env.TOSS_APP_KEY &&
      process.env.TOSS_APP_SECRET &&
      process.env.TOSS_API_BASE,
  );
}

function digFloat(obj: unknown, dotPath: string): number {
  let cur: unknown = obj;
  for (const key of dotPath.split(".")) {
    cur = asRecord(cur)[key];
  }
  const n = typeof cur === "string" ? Number(cur) : (cur as number);
  if (!Number.isFinite(n)) throw new Error(`field '${dotPath}' is not numeric`);
  return n;
}

let tossToken: { value: string; expiresAt: number } | null = null;

async function tossAccessToken(): Promise<string> {
  const now = Date.now();
  if (tossToken && tossToken.expiresAt > now + 30_000) return tossToken.value;

  const base = process.env.TOSS_API_BASE!;
  const tokenPath = process.env.TOSS_TOKEN_PATH ?? "/oauth/token";
  const body = await fetchJson(`${base}${tokenPath}`, "toss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: process.env.TOSS_APP_KEY,
      appsecret: process.env.TOSS_APP_SECRET,
    }),
  });
  const rec = asRecord(body);
  const token = rec.access_token ?? rec.accessToken;
  if (typeof token !== "string") {
    throw new ProviderError("toss", "no access_token in token response");
  }
  const ttl = Number(rec.expires_in ?? rec.expiresIn ?? 3600);
  tossToken = { value: token, expiresAt: now + ttl * 1000 };
  return token;
}

export async function fetchToss(symbol: string): Promise<Quote> {
  if (!tossConfigured()) {
    throw new ProviderError("toss", "not configured (keys not provisioned)");
  }
  const base = process.env.TOSS_API_BASE!;
  const quotePath = (process.env.TOSS_QUOTE_PATH ?? "/v1/overseas/quote").replace(
    "{symbol}",
    encodeURIComponent(symbol),
  );
  const url = quotePath.includes(encodeURIComponent(symbol))
    ? `${base}${quotePath}`
    : `${base}${quotePath}?symbol=${encodeURIComponent(symbol)}`;
  const token = await tossAccessToken();
  const body = await fetchJson(url, "toss", {
    headers: { authorization: `Bearer ${token}` },
  });
  const priceField = process.env.TOSS_PRICE_FIELD ?? "result.price";
  const price = digFloat(body, priceField);
  return {
    symbol,
    price,
    currency: process.env.TOSS_CURRENCY ?? "USD",
    source: "toss",
    delaySeconds: Number(process.env.TOSS_DELAY_SECONDS ?? 1),
    asOf: Date.now(),
  };
}
