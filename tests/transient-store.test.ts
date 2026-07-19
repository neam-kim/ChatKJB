import { describe, expect, it, vi } from "vitest";
import { TransientMap } from "../src/bot/transient-store.js";

describe("TransientMap", () => {
  it("expires abandoned entries without per-entry timers", () => {
    let now = 1_000;
    const map = new TransientMap<string, number>({
      ttlMs: 100,
      maxEntries: 3,
      cleanupIntervalMs: 1_000,
      now: () => now
    });

    map.set("pending", 1);
    now = 1_101;

    expect(map.get("pending")).toBeUndefined();
    expect(map.size).toBe(0);
    map.dispose();
  });

  it("evicts the oldest entry when the size limit is reached", () => {
    const map = new TransientMap<string, number>({
      ttlMs: 60_000,
      maxEntries: 2
    });

    map.set("first", 1);
    map.set("second", 2);
    map.set("third", 3);

    expect([...map.keys()]).toEqual(["second", "third"]);
    map.dispose();
  });

  it("stops its cleanup timer when disposed", () => {
    vi.useFakeTimers();
    const map = new TransientMap<string, number>({
      ttlMs: 100,
      maxEntries: 2,
      cleanupIntervalMs: 50
    });
    map.set("pending", 1);

    map.dispose();
    vi.advanceTimersByTime(200);

    expect(map.size).toBe(0);
    vi.useRealTimers();
  });
});
