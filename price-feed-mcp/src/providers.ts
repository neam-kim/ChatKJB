import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Quote providers. Each provider returns normalized market data or throws.
 *
 * Design notes for 어르신's safety requirements:
 * - Every result carries its `source` and `delaySeconds` so the caller can
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

export interface ExchangeRate {
  baseCurrency: "USD";
  quoteCurrency: "KRW";
  /** Toss reference buy rate: 1 USD = rate KRW. */
  rate: number;
  midRate: number;
  source: "toss";
  asOf: number;
}

export interface OrderBookLevel {
  price: number;
  volume: number;
  rawPrice: string;
  rawVolume: string;
}

export interface OrderBook {
  symbol: string;
  currency: string;
  source: "toss";
  /** Provider-reported timestamp string when available. */
  timestamp: string | null;
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
  bestAsk?: number;
  bestBid?: number;
  spread?: number;
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
const DEFAULT_TOSS_API_BASE = "https://openapi.tossinvest.com";
const LOCAL_TOSS_KEY_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../Toss_API_KEY.yaml",
);

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
      const text = await res.text();
      const detail = text.trim().slice(0, 500);
      throw new ProviderError(
        provider,
        detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`,
      );
    }
    const text = await res.text();
    return JSON.parse(text) as unknown;
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

function numericField(obj: Record<string, unknown>, key: string): number {
  const raw = obj[key];
  const n = typeof raw === "string" ? Number(raw) : (raw as number);
  if (!Number.isFinite(n)) throw new Error(`field '${key}' is not numeric`);
  return n;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const raw = obj[key];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`field '${key}' is missing`);
  }
  return raw;
}

function timestampMs(timestamp: unknown): number {
  if (typeof timestamp === "string" && timestamp.trim()) {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function normalizeCredentialKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

let localTossCredentials: Record<string, string> | null | undefined;

function readLocalTossCredentials(): Record<string, string> | null {
  if (localTossCredentials !== undefined) return localTossCredentials;
  if (!existsSync(LOCAL_TOSS_KEY_FILE)) {
    localTossCredentials = null;
    return localTossCredentials;
  }

  const parsed: Record<string, string> = {};
  for (const line of readFileSync(LOCAL_TOSS_KEY_FILE, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([^:=\s][^:=]*?)\s*[:=]\s*(.*?)\s*$/);
    if (!match) continue;
    const key = normalizeCredentialKey(match[1]);
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && value) parsed[key] = value;
  }
  localTossCredentials = parsed;
  return localTossCredentials;
}

function configValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }

  const local = readLocalTossCredentials();
  if (!local) return undefined;
  for (const name of names) {
    const value = local[normalizeCredentialKey(name)]?.trim();
    if (value) return value;
  }
  return undefined;
}

function tossClientId(): string | undefined {
  return configValue(
    "TOSS_API_KEY",
    "TOSS_APP_KEY",
    "TOSS_CLIENT_ID",
    "TOSSINVEST_CLIENT_ID",
  );
}

function tossClientSecret(): string | undefined {
  return configValue(
    "TOSS_SECRET_KEY",
    "TOSS_APP_SECRET",
    "TOSS_CLIENT_SECRET",
    "TOSSINVEST_CLIENT_SECRET",
  );
}

function tossApiBase(): string {
  return (
    configValue("TOSS_API_BASE", "TOSSINVEST_API_BASE_URL") ??
    DEFAULT_TOSS_API_BASE
  ).replace(/\/+$/, "");
}

function tossApiUrl(path: string): string {
  return `${tossApiBase()}${path.startsWith("/") ? path : `/${path}`}`;
}

/* ---------------------------------------------------------------- Toss --- */

/**
 * Toss Securities Open API.
 *
 * Official OpenAPI spec checked live on 2026-07-02:
 *   https://openapi.tossinvest.com/openapi-docs/latest/openapi.json
 *
 * Auth:
 *   POST /oauth2/token with application/x-www-form-urlencoded
 *   grant_type=client_credentials, client_id, client_secret
 *
 * Market data:
 *   GET /api/v1/prices?symbols=AAPL
 *   GET /api/v1/orderbook?symbol=AAPL
 *
 * Credentials may come from environment variables or ChatKJB/Toss_API_KEY.yaml:
 *   TOSS_API_KEY / TOSS_SECRET_KEY
 */
export function tossConfigured(): boolean {
  return Boolean(tossClientId() && tossClientSecret());
}

let tossToken: { value: string; expiresAt: number } | null = null;

async function tossAccessToken(): Promise<string> {
  const now = Date.now();
  if (tossToken && tossToken.expiresAt > now + 30_000) return tossToken.value;

  const clientId = tossClientId();
  const clientSecret = tossClientSecret();
  if (!clientId || !clientSecret) {
    throw new ProviderError("toss", "not configured (missing credentials)");
  }

  const tokenPath = configValue("TOSS_TOKEN_PATH") ?? "/oauth2/token";
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const body = await fetchJson(tossApiUrl(tokenPath), "toss", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const rec = asRecord(body);
  const token = rec.access_token;
  if (typeof token !== "string") {
    throw new ProviderError("toss", "no access_token in token response");
  }
  const ttl = Number(rec.expires_in ?? 3600);
  tossToken = { value: token, expiresAt: now + ttl * 1000 };
  return token;
}

async function fetchTossApi(path: string): Promise<unknown> {
  const token = await tossAccessToken();
  return fetchJson(tossApiUrl(path), "toss", {
    headers: { authorization: `Bearer ${token}` },
  });
}

export async function fetchToss(symbol: string): Promise<Quote> {
  if (!tossConfigured()) {
    throw new ProviderError("toss", "not configured (keys not provisioned)");
  }
  const params = new URLSearchParams({ symbols: symbol });
  const body = await fetchTossApi(`/api/v1/prices?${params.toString()}`);
  const result = asRecord(body).result;
  if (!Array.isArray(result) || result.length < 1) {
    throw new ProviderError("toss", "no result in prices response");
  }
  const matching =
    result.find((item) => {
      try {
        return stringField(asRecord(item), "symbol").toUpperCase() === symbol;
      } catch {
        return false;
      }
    }) ?? result[0];
  const rec = asRecord(matching);
  const timestamp = rec.timestamp;
  return {
    symbol,
    price: numericField(rec, "lastPrice"),
    currency: stringField(rec, "currency"),
    source: "toss",
    delaySeconds: Number(configValue("TOSS_DELAY_SECONDS") ?? 0),
    asOf: timestampMs(timestamp),
  };
}

export async function fetchTossExchangeRate(): Promise<ExchangeRate> {
  if (!tossConfigured()) {
    throw new ProviderError("toss", "not configured (keys not provisioned)");
  }
  const params = new URLSearchParams({ baseCurrency: "USD", quoteCurrency: "KRW" });
  const body = await fetchTossApi(`/api/v1/exchange-rate?${params.toString()}`);
  const result = asRecord(asRecord(body).result);
  const baseCurrency = stringField(result, "baseCurrency");
  const quoteCurrency = stringField(result, "quoteCurrency");
  if (baseCurrency !== "USD" || quoteCurrency !== "KRW") {
    throw new ProviderError("toss", "unexpected exchange-rate currency pair");
  }
  return {
    baseCurrency: "USD",
    quoteCurrency: "KRW",
    rate: numericField(result, "rate"),
    midRate: numericField(result, "midRate"),
    source: "toss",
    asOf: timestampMs(result.validFrom),
  };
}

function parseOrderBookLevels(value: unknown, side: "asks" | "bids"): OrderBookLevel[] {
  if (!Array.isArray(value)) {
    throw new Error(`field '${side}' is not an array`);
  }
  return value.map((entry) => {
    const rec = asRecord(entry);
    const rawPrice = stringField(rec, "price");
    const rawVolume = stringField(rec, "volume");
    const price = Number(rawPrice);
    const volume = Number(rawVolume);
    if (!Number.isFinite(price)) {
      throw new Error(`field '${side}.price' is not numeric`);
    }
    if (!Number.isFinite(volume)) {
      throw new Error(`field '${side}.volume' is not numeric`);
    }
    return { price, volume, rawPrice, rawVolume };
  });
}

export async function fetchTossOrderBook(symbol: string): Promise<OrderBook> {
  if (!tossConfigured()) {
    throw new ProviderError("toss", "not configured (keys not provisioned)");
  }
  const params = new URLSearchParams({ symbol });
  const body = await fetchTossApi(`/api/v1/orderbook?${params.toString()}`);
  const result = asRecord(asRecord(body).result);
  const timestamp = result.timestamp;
  const timestampString = typeof timestamp === "string" ? timestamp : null;
  const asks = parseOrderBookLevels(result.asks, "asks");
  const bids = parseOrderBookLevels(result.bids, "bids");
  const bestAsk = asks[0]?.price;
  const bestBid = bids[0]?.price;
  const spread =
    bestAsk !== undefined && bestBid !== undefined ? bestAsk - bestBid : undefined;

  return {
    symbol,
    currency: stringField(result, "currency"),
    source: "toss",
    timestamp: timestampString,
    asks,
    bids,
    bestAsk,
    bestBid,
    spread,
    delaySeconds: Number(configValue("TOSS_DELAY_SECONDS") ?? 0),
    asOf: timestampMs(timestamp),
  };
}
