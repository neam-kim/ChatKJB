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
  it("supports a disabled empty pool and de-duplicates configured tokens", () => {
    const empty = new TokenPool([]);
    expect(empty.size).toBe(0);
    expect(() => empty.select()).toThrow("Claude OAuth 인증이 없어");
    expect(new TokenPool(["  "]).size).toBe(0);
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

  it("stays on the failed-over token even after the first token recovers (sticky)", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    const resetsAt = new Date(now + 3_600_000).toISOString();
    pool.observe(A, snapshot({ fiveHour: { utilization: 100, resetsAt } }), now);

    expect(pool.select(now)).toBe(B);
    // sticky: A가 회복돼도 1순위로 되돌아가지 않고, 마지막에 쓰던 B를 계속 사용한다.
    expect(pool.select(now + 3_600_001)).toBe(B);
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
    // sticky: 백오프가 지나 A가 회복돼도 마지막에 쓰던 B를 계속 사용한다.
    expect(pool.select(now + 3_600_001)).toBe(B);
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

  it("keeps returning the same token across calls while it is healthy (sticky)", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    expect(pool.select(now)).toBe(A);
    expect(pool.select(now)).toBe(A);
    expect(pool.select(now)).toBe(A);
  });

  it("moves to the next token when the current one is exhausted and then sticks to it", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    expect(pool.select(now)).toBe(A);
    // A 소진 → B로 이동하고 이후 B를 고수한다.
    pool.noteRateLimited(A, now, now + 5_000);
    expect(pool.select(now)).toBe(B);
    expect(pool.select(now)).toBe(B);
  });

  it("fails over back from B to A when B becomes exhausted", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    pool.noteRateLimited(A, now, now + 5_000);
    expect(pool.select(now)).toBe(B);
    // B도 소진되고 A는 이미 회복된 시점이면 다시 A로 넘어간다.
    pool.noteRateLimited(B, now + 6_000, now + 20_000);
    expect(pool.select(now + 6_000)).toBe(A);
    expect(pool.select(now + 6_000)).toBe(A);
  });

  it("keeps sticky token selection separately per model scope", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;

    expect(pool.select(now, "claude-opus-4-8")).toBe(A);
    pool.noteRateLimited(A, now, now + 5_000);
    expect(pool.select(now, "claude-opus-4-8")).toBe(B);

    // A가 회복된 뒤 Opus는 마지막에 쓰던 B를 계속 유지한다.
    expect(pool.select(now + 6_000, "claude-opus-4-8")).toBe(B);
    // Sonnet은 별도 scope이므로 자기 첫 선택으로 A를 쓴다.
    expect(pool.select(now + 6_000, "claude-sonnet-4-6")).toBe(A);
  });

  it("does not fail over below the exhaustion threshold", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    const resetsAt = new Date(now + 3_600_000).toISOString();
    pool.observe(A, snapshot({ fiveHour: { utilization: 99, resetsAt } }), now);
    expect(pool.isExhausted(A, now)).toBe(false);
    expect(pool.select(now)).toBe(A);
  });

  it("statuses() exposes a stable 16-char hex fingerprint and never the raw token", () => {
    const pool = new TokenPool([A, B]);
    const statuses = pool.statuses();
    expect(statuses).toHaveLength(2);
    expect(statuses[0]!.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(statuses[1]!.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(statuses[0]!.fingerprint).not.toBe(statuses[1]!.fingerprint);
    // 토큰 원문(비밀)은 영속 상태에 절대 노출되지 않는다.
    const json = JSON.stringify(statuses);
    expect(json).not.toContain(A);
    expect(json).not.toContain(B);
    expect(statuses[0]!.exhaustedUntil).toBeNull();
    expect(statuses[1]!.exhaustedUntil).toBeNull();
  });

  it("statuses() reflects exhaustedUntil after noteRateLimited", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    pool.noteRateLimited(A, now, now + 5_000);
    const statuses = pool.statuses();
    expect(statuses[0]!.exhaustedUntil).toBe(now + 5_000);
    expect(statuses[1]!.exhaustedUntil).toBeNull();
  });

  it("fires onExhaustionChange when noteRateLimited changes state", () => {
    let calls = 0;
    const pool = new TokenPool([A, B], { onExhaustionChange: () => { calls += 1; } });
    const now = 1_000_000;
    pool.noteRateLimited(A, now, now + 5_000);
    expect(calls).toBe(1);
  });

  it("does not fire onExhaustionChange when observe stays below the threshold", () => {
    let calls = 0;
    const pool = new TokenPool([A, B], { onExhaustionChange: () => { calls += 1; } });
    const now = 1_000_000;
    const resetsAt = new Date(now + 3_600_000).toISOString();
    pool.observe(A, snapshot({ fiveHour: { utilization: 99, resetsAt } }), now);
    expect(calls).toBe(0);
  });

  it("does not fire onExhaustionChange again when the exhaustion time is unchanged", () => {
    let calls = 0;
    const pool = new TokenPool([A, B], { onExhaustionChange: () => { calls += 1; } });
    const now = 1_000_000;
    pool.noteRateLimited(A, now, now + 5_000);
    // 더 이른 until은 Math.max로 무시되어 상태가 바뀌지 않으므로 콜백도 다시 울리지 않는다.
    pool.noteRateLimited(A, now, now + 3_000);
    expect(calls).toBe(1);
  });

  it("round-trips exhaustion across pools via fingerprint without firing the restore callback", () => {
    const now = 1_000_000;
    const pool1 = new TokenPool([A, B]);
    pool1.noteRateLimited(A, now, now + 5_000);
    const statusA = pool1.statuses()[0]!;

    // 재시작을 흉내: 같은 토큰 구성의 새 풀에 지문으로 소진 상태를 복원한다.
    let restoreCalls = 0;
    const pool2 = new TokenPool([A, B], { onExhaustionChange: () => { restoreCalls += 1; } });
    pool2.restoreExhaustion(statusA.fingerprint, statusA.exhaustedUntil!, now);

    expect(pool2.isExhausted(A, now)).toBe(true);
    expect(pool2.select(now + 1_000)).toBe(B);
    // 복원은 콜백을 울리지 않는다(되먹임 영속 쓰기 방지).
    expect(restoreCalls).toBe(0);
  });

  it("clears a window's seal when a later authoritative read reports it healthy (self-heal)", () => {
    const pool = new TokenPool([A, B]);
    const now = 1_000_000;
    const resetsAt = new Date(now + 7 * 86_400_000).toISOString(); // 일주일 뒤(주간 리셋)
    pool.observe(A, snapshot({ sevenDay: { utilization: 100, resetsAt } }), now);
    expect(pool.isExhausted(A, now)).toBe(true);

    // 아직 리셋 전이지만, 최신 권위 읽기에서 주간 창이 다시 정상(50%)으로 보고되면
    // 리셋 시각을 기다리지 않고 그 창의 봉인을 해제한다.
    pool.observe(A, snapshot({ sevenDay: { utilization: 50, resetsAt } }), now + 60_000);
    expect(pool.isExhausted(A, now + 60_000)).toBe(false);
  });

  it("clears a restored (restart) seal when the next authoritative read shows no exhausted window", () => {
    const now = 1_000_000;
    const staleUntil = now + 3 * 86_400_000; // 3일 뒤로 잘못 남은 봉인
    let calls = 0;
    const pool = new TokenPool([A, B], { onExhaustionChange: () => { calls += 1; } });
    const fpA = pool.statuses()[0]!.fingerprint;

    // 재시작 복원: 창 정보가 유실된 잠정 봉인.
    pool.restoreExhaustion(fpA, staleUntil, now);
    expect(pool.isExhausted(A, now)).toBe(true);
    expect(calls).toBe(0); // 복원은 콜백을 울리지 않는다

    // 소진 창을 하나도 담지 않은 권위 있는 사용량 읽기가 오면 stale 봉인이 풀린다.
    pool.observe(A, snapshot({ fiveHour: { utilization: 10, resetsAt: null } }), now + 60_000);
    expect(pool.isExhausted(A, now + 60_000)).toBe(false);
    expect(calls).toBe(1); // 해제로 상태가 바뀌었으므로 영속화 콜백이 울린다
  });

  it("keeps a restored seal when the authoritative read still shows an exhausted window", () => {
    const now = 1_000_000;
    const staleUntil = now + 3 * 86_400_000;
    const pool = new TokenPool([A, B]);
    const fpA = pool.statuses()[0]!.fingerprint;
    pool.restoreExhaustion(fpA, staleUntil, now);

    // 5시간 창이 여전히 소진이면, 그 창의 리셋 시각으로 다시 봉인된다(해제되지 않음).
    const fiveHourReset = now + 4 * 3_600_000;
    pool.observe(
      A,
      snapshot({ fiveHour: { utilization: 100, resetsAt: new Date(fiveHourReset).toISOString() } }),
      now + 60_000
    );
    expect(pool.isExhausted(A, now + 60_000)).toBe(true);
    expect(pool.statuses()[0]!.exhaustedUntil).toBe(fiveHourReset);
  });

  it("does not clear seals from a non-authoritative snapshot (no windows reported)", () => {
    const now = 1_000_000;
    const staleUntil = now + 3 * 86_400_000;
    const pool = new TokenPool([A, B]);
    const fpA = pool.statuses()[0]!.fingerprint;
    pool.restoreExhaustion(fpA, staleUntil, now);

    // 창을 하나도 담지 않은 스냅샷은 권위가 없으므로 봉인을 건드리지 않는다.
    pool.observe(A, snapshot({ rateLimitsAvailable: false }), now + 60_000);
    expect(pool.isExhausted(A, now + 60_000)).toBe(true);
  });

  it("restoreExhaustion ignores unknown fingerprints and already-recovered times", () => {
    let calls = 0;
    const pool = new TokenPool([A, B], { onExhaustionChange: () => { calls += 1; } });
    const now = 1_000_000;
    const fpA = pool.statuses()[0]!.fingerprint;
    pool.restoreExhaustion("0".repeat(16), now + 5_000, now); // 모르는 지문
    pool.restoreExhaustion(fpA, now - 1_000, now);            // 이미 회복된 시각
    expect(pool.isExhausted(A, now)).toBe(false);
    expect(calls).toBe(0);
  });
});
