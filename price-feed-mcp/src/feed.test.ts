import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./providers.js", () => ({
  fetchToss: vi.fn(),
  fetchYahoo: vi.fn(),
  fetchGoogle: vi.fn(),
  tossConfigured: vi.fn(),
}));

const providers = (await import("./providers.js")) as unknown as {
  fetchToss: ReturnType<typeof vi.fn>;
  fetchYahoo: ReturnType<typeof vi.fn>;
  fetchGoogle: ReturnType<typeof vi.fn>;
  tossConfigured: ReturnType<typeof vi.fn>;
};
const { getQuote } = await import("./feed.js");

function quote(source: "toss" | "yahoo" | "google", price: number) {
  return {
    symbol: "AAPL",
    price,
    currency: "USD",
    source,
    delaySeconds: source === "toss" ? 1 : 900,
    asOf: 1_700_000_000_000,
  };
}

beforeEach(() => {
  providers.fetchToss.mockReset();
  providers.fetchYahoo.mockReset();
  providers.fetchGoogle.mockReset();
  providers.tossConfigured.mockReset();
});

describe("getQuote fallback chain", () => {
  it("skips toss when not configured, then uses yahoo", async () => {
    providers.tossConfigured.mockReturnValue(false);
    providers.fetchYahoo.mockResolvedValue(quote("yahoo", 150));

    const result = await getQuote("AAPL");

    expect(result.source).toBe("yahoo");
    expect(result.price).toBe(150);
    expect(result.attempts[0]).toMatchObject({ source: "toss", skipped: true });
    expect(result.attempts[1]).toMatchObject({ source: "yahoo", ok: true });
    expect(providers.fetchToss).not.toHaveBeenCalled();
  });

  it("uses toss when configured and it succeeds", async () => {
    providers.tossConfigured.mockReturnValue(true);
    providers.fetchToss.mockResolvedValue(quote("toss", 145));

    const result = await getQuote("AAPL");

    expect(result.source).toBe("toss");
    expect(providers.fetchYahoo).not.toHaveBeenCalled();
  });

  it("falls back to google when yahoo throws", async () => {
    providers.tossConfigured.mockReturnValue(false);
    providers.fetchYahoo.mockRejectedValue(new Error("yahoo down"));
    providers.fetchGoogle.mockResolvedValue(quote("google", 155));

    const result = await getQuote("AAPL");

    expect(result.source).toBe("google");
    expect(result.attempts).toEqual([
      { source: "toss", ok: false, skipped: true },
      { source: "yahoo", ok: false, error: "yahoo down" },
      { source: "google", ok: true },
    ]);
  });

  it("throws when every provider fails", async () => {
    providers.tossConfigured.mockReturnValue(false);
    providers.fetchYahoo.mockRejectedValue(new Error("yahoo down"));
    providers.fetchGoogle.mockRejectedValue(new Error("google down"));

    await expect(getQuote("AAPL")).rejects.toThrow("all price providers failed");
  });

  it("rejects invalid symbols", async () => {
    await expect(getQuote("")).rejects.toThrow("invalid symbol");
    await expect(getQuote("123###")).rejects.toThrow("invalid symbol");
  });
});
