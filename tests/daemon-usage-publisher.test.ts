import { describe, expect, it } from "vitest";
import { nextUsagePublishDelayMs } from "../src/daemon-usage-publisher.js";

describe("nextUsagePublishDelayMs", () => {
  it("15분 기준 조회를 10~20분 사이로 무작위 분산한다", () => {
    const base = 15 * 60_000;
    expect(nextUsagePublishDelayMs(base, () => 0)).toBe(10 * 60_000);
    expect(nextUsagePublishDelayMs(base, () => 0.5)).toBe(15 * 60_000);
    expect(nextUsagePublishDelayMs(base, () => 1)).toBe(20 * 60_000);
  });

  it("잘못 주입된 난수에도 음수 지연을 만들지 않는다", () => {
    expect(nextUsagePublishDelayMs(1_000, () => -1)).toBe(1_000);
  });
});
