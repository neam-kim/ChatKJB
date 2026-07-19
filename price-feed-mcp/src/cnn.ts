/** Read-only CNN Fear & Greed API client. */

const CNN_FEAR_GREED_URL =
  "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
const TIMEOUT_MS = 8000;

export interface FearGreedIndex {
  score: number;
  rating: string;
  /** CNN-reported update time in milliseconds since epoch. */
  asOf: number;
  source: "cnn";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error("missing or invalid timestamp");
}

/**
 * Fetch CNN's current Fear & Greed reading.
 *
 * CNN's public chart endpoint rejects generic HTTP clients, so these headers
 * identify the expected page context. No credentials are sent or required.
 */
export async function getFearGreedIndex(): Promise<FearGreedIndex> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(CNN_FEAR_GREED_URL, {
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain, */*",
        referer: "https://www.cnn.com/markets/fear-and-greed",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) price-feed-mcp/0.1",
      },
    });
    if (!response.ok) {
      throw new Error(`CNN Fear & Greed API returned HTTP ${response.status}`);
    }

    const fearAndGreed = asRecord(asRecord(await response.json()).fear_and_greed);
    const score = Number(fearAndGreed.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error("missing or invalid score");
    }
    if (typeof fearAndGreed.rating !== "string" || !fearAndGreed.rating.trim()) {
      throw new Error("missing or invalid rating");
    }

    return {
      score,
      rating: fearAndGreed.rating.toLowerCase(),
      asOf: parseTimestamp(fearAndGreed.timestamp),
      source: "cnn",
    };
  } finally {
    clearTimeout(timer);
  }
}
