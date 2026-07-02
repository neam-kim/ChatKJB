import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./providers.js", () => ({
  fetchToss: vi.fn(),
  fetchTossOrderBook: vi.fn(),
  tossConfigured: vi.fn(),
}));

const providers = (await import("./providers.js")) as unknown as {
  fetchToss: ReturnType<typeof vi.fn>;
  fetchTossOrderBook: ReturnType<typeof vi.fn>;
  tossConfigured: ReturnType<typeof vi.fn>;
};
const { getOrderBook, getQuote } = await import("./feed.js");

function quote(price: number) {
  return {
    symbol: "AAPL",
    price,
    currency: "USD",
    source: "toss",
    delaySeconds: 1,
    asOf: 1_700_000_000_000,
  };
}

function orderBook() {
  return {
    symbol: "AAPL",
    currency: "USD",
    source: "toss",
    timestamp: "2026-03-25T22:30:00.456+09:00",
    asks: [{ price: 185.75, volume: 250, rawPrice: "185.75", rawVolume: "250" }],
    bids: [{ price: 185.65, volume: 180, rawPrice: "185.65", rawVolume: "180" }],
    bestAsk: 185.75,
    bestBid: 185.65,
    spread: 0.1,
    delaySeconds: 0,
    asOf: 1_700_000_000_000,
  };
}

beforeEach(() => {
  providers.fetchToss.mockReset();
  providers.fetchTossOrderBook.mockReset();
  providers.tossConfigured.mockReset();
});

describe("getQuote Toss-only chain", () => {
  it("fails closed when toss is not configured", async () => {
    providers.tossConfigured.mockReturnValue(false);

    await expect(getQuote("AAPL")).rejects.toThrow("all price providers failed");
    expect(providers.fetchToss).not.toHaveBeenCalled();
    expect(providers.fetchTossOrderBook).not.toHaveBeenCalled();
  });

  it("uses toss when configured and it succeeds", async () => {
    providers.tossConfigured.mockReturnValue(true);
    providers.fetchToss.mockResolvedValue(quote(145));

    const result = await getQuote("AAPL");

    expect(result.source).toBe("toss");
    expect(result.price).toBe(145);
    expect(result.attempts).toEqual([{ source: "toss", ok: true }]);
  });

  it("throws when toss fails", async () => {
    providers.tossConfigured.mockReturnValue(true);
    providers.fetchToss.mockRejectedValue(new Error("toss down"));

    await expect(getQuote("AAPL")).rejects.toThrow("all price providers failed");
  });

  it("rejects invalid symbols", async () => {
    await expect(getQuote("")).rejects.toThrow("invalid symbol");
    await expect(getQuote("123###")).rejects.toThrow("invalid symbol");
  });
});

describe("getOrderBook Toss-only chain", () => {
  it("fails closed when toss is not configured", async () => {
    providers.tossConfigured.mockReturnValue(false);

    await expect(getOrderBook("AAPL")).rejects.toThrow(
      "all order book providers failed",
    );
    expect(providers.fetchTossOrderBook).not.toHaveBeenCalled();
  });

  it("uses toss when configured and it succeeds", async () => {
    providers.tossConfigured.mockReturnValue(true);
    providers.fetchTossOrderBook.mockResolvedValue(orderBook());

    const result = await getOrderBook("AAPL");

    expect(result.source).toBe("toss");
    expect(result.bestAsk).toBe(185.75);
    expect(result.bestBid).toBe(185.65);
    expect(result.attempts).toEqual([{ source: "toss", ok: true }]);
  });

  it("throws when toss fails", async () => {
    providers.tossConfigured.mockReturnValue(true);
    providers.fetchTossOrderBook.mockRejectedValue(new Error("toss down"));

    await expect(getOrderBook("AAPL")).rejects.toThrow(
      "all order book providers failed",
    );
  });

  it("allows numeric Korean symbols and rejects invalid symbols", async () => {
    providers.tossConfigured.mockReturnValue(true);
    providers.fetchTossOrderBook.mockResolvedValue({
      ...orderBook(),
      symbol: "005930",
      currency: "KRW",
    });

    await expect(getOrderBook("005930")).resolves.toMatchObject({
      symbol: "005930",
      source: "toss",
    });
    await expect(getOrderBook("")).rejects.toThrow("invalid symbol");
    await expect(getOrderBook("123###")).rejects.toThrow("invalid symbol");
  });
});
