import { afterEach, describe, expect, it, vi } from "vitest";

import { getFearGreedIndex } from "./cnn.js";

afterEach(() => vi.unstubAllGlobals());

describe("getFearGreedIndex", () => {
  it("normalizes CNN's current reading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            fear_and_greed: {
              score: 43.542857,
              rating: "Fear",
              timestamp: "2026-07-14T15:45:14+00:00",
            },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(getFearGreedIndex()).resolves.toEqual({
      score: 43.542857,
      rating: "fear",
      asOf: 1784043914000,
      source: "cnn",
    });
  });

  it("rejects an invalid score", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            fear_and_greed: { score: 101, rating: "greed", timestamp: 1 },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(getFearGreedIndex()).rejects.toThrow("missing or invalid score");
  });
});
