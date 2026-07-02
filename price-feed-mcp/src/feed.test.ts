import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./providers.js", () => ({
  fetchToss: vi.fn(),
  tossConfigured: vi.fn(),
}));

const providers = (await import("./providers.js")) as unknown as {
  fetchToss: ReturnType<typeof vi.fn>;
  tossConfigured: ReturnType<typeof vi.fn>;
};
const { getQuote } = await import("./feed.js");

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

beforeEach(() => {
  providers.fetchToss.mockReset();
  providers.tossConfigured.mockReset();
});

describe("getQuote Toss-only chain", () => {
  it("fails closed when toss is not configured", async () => {
    providers.tossConfigured.mockReturnValue(false);

    await expect(getQuote("AAPL")).rejects.toThrow("all price providers failed");
    expect(providers.fetchToss).not.toHaveBeenCalled();
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
