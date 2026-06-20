import { describe, expect, it } from "vitest";
import { TokenPool } from "../src/token-pool.js";
import type { UsageSnapshot } from "../src/types.js";

const A = "sk-ant-oat01-a";
const B = "sk-ant-oat01-b";

function snapshot(window: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    capturedAt: 0,
    subscriptionType: null,
    rateLimitsAvailable: true,
    ...window
  };
}

describe("TokenPool", () => {
  it("requires at least one token and de-duplicates", () => {
    expect(() => new TokenPool([])).toThrow();
    expect(() => new TokenPool(["  "])).toThrow();
    const pool = new TokenPool([A, A, B]);
    expect(pool.size).toBe(2);
  });

  it("prefers the first token while it is healthy", () => {
    const pool = new TokenPool([A, B]);
    expect(pool.select()).toBe(A);
  });

  it("fails over to the next token when a window hits 100%", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    const resetsAt = new Date(now + 3_600_000).toISOString();
    pool.observe(A, snapshot({ fiveHour: { utilization: 100, resetsAt } }), now);

    expect(pool.isExhausted(A, now)).toBe(true);
    expect(pool.select(now)).toBe(B);
  });

  it("recovers the first token after its reset time passes", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    const resetsAt = new Date(now + 3_600_000).toISOString();
    pool.observe(A, snapshot({ fiveHour: { utilization: 100, resetsAt } }), now);

    expect(pool.select(now)).toBe(B);
    // 초기화 시각 이후에는 다시 1순위 토큰을 사용한다.
    expect(pool.select(now + 3_600_001)).toBe(A);
  });

  it("treats an exhausted Agent SDK weekly window as exhausted", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    pool.observe(
      A,
      snapshot({
        agentSdkWeekly: { utilization: 100, resetsAt: null }
      }),
      now
    );
    expect(pool.isExhausted(A, now)).toBe(true);
    // resetsAt가 없으면 기본 백오프(1시간) 동안 봉인.
    expect(pool.select(now)).toBe(B);
    expect(pool.select(now + 3_600_001)).toBe(A);
  });

  it("marks a token exhausted from a rate-limit error with default backoff", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    pool.noteRateLimited(A, now);
    expect(pool.select(now)).toBe(B);
  });

  it("preserves an exact reset time when a later error has no reset metadata", () => {
    const pool = new TokenPool([A, B], { defaultBackoffMs: 3_600_000 });
    const now = 1_000_000;
    const exactReset = now + 60_000;
    pool.observe(
      A,
      snapshot({
        fiveHour: {
          utilization: 100,
          resetsAt: new Date(exactReset).toISOString()
        }
      }),
      now
    );

    pool.noteRateLimited(A, now + 1_000);

    expect(pool.recoversAt(now)).toBeNull();
    pool.noteRateLimited(B, now, exactReset + 60_000);
    expect(pool.recoversAt(now)).toBe(exactReset);
  });

  it("returns the soonest-recovering token when all are exhausted", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    pool.noteRateLimited(A, now, now + 5_000);
    pool.noteRateLimited(B, now, now + 10_000);
    // 둘 다 소진이면 더 빨리 회복되는 A를 시도.
    expect(pool.select(now)).toBe(A);
  });

  it("reports no recovery wait while any token is still healthy", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    pool.noteRateLimited(A, now, now + 5_000);
    // B는 아직 살아있으므로 기다릴 필요가 없다.
    expect(pool.recoversAt(now)).toBeNull();
  });

  it("reports the soonest reset time when every token is exhausted", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    pool.noteRateLimited(A, now, now + 8_000);
    pool.noteRateLimited(B, now, now + 3_000);
    // 둘 다 소진이면 더 빨리 회복되는 B의 시각을 돌려준다.
    expect(pool.recoversAt(now)).toBe(now + 3_000);
    // 그 시각이 지나면 다시 살아있는 토큰이 생겨 대기가 필요 없다.
    expect(pool.recoversAt(now + 3_001)).toBeNull();
  });

  it("does not fail over below the exhaustion threshold", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    const resetsAt = new Date(now + 3_600_000).toISOString();
    pool.observe(A, snapshot({ fiveHour: { utilization: 99, resetsAt } }), now);
    expect(pool.isExhausted(A, now)).toBe(false);
    expect(pool.select(now)).toBe(A);
  });
});
