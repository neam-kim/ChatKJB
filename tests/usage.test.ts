import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../src/types.js";
import {
  formatAgyAccountUsage,
  formatClineAccountUsage,
  isClineSubscriptionProvider,
  parseStoredClineUsage,
  formatCodexAccountUsage,
  formatGrokUsage,
  formatUsageSnapshot,
  mergeUsageSnapshots,
  snapshotFromRateLimitInfo,
  snapshotFromUsageResponse
} from "../src/usage.js";

function agySession(agyUsage: string | null, provider: SessionRecord["provider"] = "agy"): SessionRecord {
  return { provider, agyUsage } as unknown as SessionRecord;
}

function usageResponse(
  rateLimits: SDKControlGetUsageResponse["rate_limits"],
  subscriptionType = "pro"
): SDKControlGetUsageResponse {
  return {
    session: {
      total_cost_usd: 1,
      total_api_duration_ms: 1,
      total_duration_ms: 1,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {}
    },
    subscription_type: subscriptionType,
    rate_limits_available: true,
    rate_limits: rateLimits,
    behaviors: null
  } as unknown as SDKControlGetUsageResponse;
}

describe("usage limits", () => {
  it("normalizes SDK rate-limit event utilization", () => {
    expect(snapshotFromRateLimitInfo({
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 0.72,
      resetsAt: Date.parse("2026-06-12T08:00:00.000Z")
    }).fiveHour).toEqual({
      utilization: 72,
      resetsAt: "2026-06-12T08:00:00.000Z"
    });
  });

  it("treats a rejected event without utilization as exhausted", () => {
    expect(snapshotFromRateLimitInfo({
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: 1_781_854_800
    }, 123).fiveHour).toEqual({
      utilization: 100,
      resetsAt: "2026-06-19T07:40:00.000Z"
    });
  });

  it("merges partial rate-limit events without dropping other windows", () => {
    const previous = {
      capturedAt: 1,
      subscriptionType: "pro",
      rateLimitsAvailable: true,
      fiveHour: { utilization: 20, resetsAt: null }
    };
    const next = snapshotFromRateLimitInfo({
      status: "allowed",
      rateLimitType: "seven_day",
      utilization: 0.4,
      resetsAt: Date.parse("2026-06-19T00:00:00.000Z")
    }, 2);

    expect(mergeUsageSnapshots(previous, next)).toMatchObject({
      capturedAt: 2,
      subscriptionType: "pro",
      fiveHour: { utilization: 20 },
      sevenDay: { utilization: 40 }
    });
  });

  it("always shows the five-hour and weekly windows from the usage endpoint", () => {
    const snapshot = snapshotFromUsageResponse(usageResponse({
      five_hour: { utilization: 55, resets_at: "2026-06-16T18:00:00.000Z" },
      seven_day: { utilization: 30, resets_at: "2026-06-21T00:00:00.000Z" }
    }));

    const text = formatUsageSnapshot(snapshot);
    expect(text).toContain("5시간 한도: 55% 사용");
    expect(text).toContain("주간 한도: 30% 사용");
  });

  it("reports the Agent SDK weekly window when the server returns it", () => {
    const snapshot = snapshotFromUsageResponse(usageResponse({
      seven_day_oauth_apps: { utilization: 12, resets_at: "2026-06-21T00:00:00.000Z" }
    }));

    expect(formatUsageSnapshot(snapshot)).toContain("Agent SDK 주간 한도: 12% 사용");
  });

  it("shows overage credits only when extra usage is enabled", () => {
    const enabled = snapshotFromUsageResponse(usageResponse({
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100,
        used_credits: 30,
        utilization: 30,
        currency: "USD"
      }
    }));
    const enabledText = formatUsageSnapshot(enabled);
    expect(enabledText).toContain("추가 사용(overage): 30% 사용");
    expect(enabledText).toContain("$30.00 / $100.00");

    const disabled = snapshotFromUsageResponse(usageResponse({
      five_hour: { utilization: 10, resets_at: null },
      extra_usage: {
        is_enabled: false,
        monthly_limit: 100,
        used_credits: 0,
        utilization: 0,
        currency: "USD"
      }
    }));
    expect(formatUsageSnapshot(disabled)).not.toContain("overage");
  });

  it("warns when the five-hour window is near its limit", () => {
    const text = formatUsageSnapshot({
      capturedAt: Date.now(),
      subscriptionType: "pro",
      rateLimitsAvailable: true,
      fiveHour: { utilization: 85, resetsAt: null }
    });

    expect(text).toContain("5시간 한도가 80% 이상");
  });

  it("does not invent any monthly Agent SDK credit line", () => {
    const text = formatUsageSnapshot({
      capturedAt: Date.now(),
      subscriptionType: "pro",
      rateLimitsAvailable: true,
      fiveHour: { utilization: 35, resetsAt: null }
    });

    expect(text).not.toContain("Agent SDK 크레딧");
    expect(text).not.toContain("공식 사용량 정보 미제공");
  });

  it("falls back to a clear message when no windows are available", () => {
    expect(formatUsageSnapshot({
      capturedAt: Date.now(),
      subscriptionType: null,
      rateLimitsAvailable: false
    })).toContain("구독 OAuth 세션에서만");
  });

  it("shows live Codex account limits when available", () => {
    const text = formatCodexAccountUsage([
      {
        accountIndex: 1,
        available: true,
        exhaustedUntil: null,
        latestUsage: null,
        liveUsage: {
          capturedAt: Date.parse("2026-07-05T10:40:00.000Z"),
          planType: "plus",
          primary: {
            usedPercent: 51,
            windowDurationMins: 300,
            resetsAt: "2026-07-05T15:45:02.000Z"
          },
          secondary: {
            usedPercent: 8,
            windowDurationMins: 10080,
            resetsAt: "2026-07-12T15:45:02.000Z"
          },
          resetCreditsAvailable: 0,
          creditsBalance: "0",
          rateLimitReachedType: null,
          lifetimeTokens: 1_554_437_700,
          peakDailyTokens: 97_052_768,
          currentStreakDays: 8
        },
        liveUsageError: null
      }
    ]);

    expect(text).toContain("5시간 한도: 51% 사용");
    expect(text).toContain("주간 한도: 8% 사용");
    expect(text).toContain("사용 가능 reset: 0");
    expect(text).toContain("누적 토큰: 1,554,437,700");
    expect(text).toContain("원천: Codex app-server 실시간 조회");
  });
});

describe("agy/grok usage in global /usage", () => {
  it("sums stored agy usage across agy sessions", () => {
    const text = formatAgyAccountUsage([
      agySession(JSON.stringify({
        promptTokenCount: 100,
        cachedContentTokenCount: 10,
        candidatesTokenCount: 40,
        thoughtsTokenCount: 5,
        totalTokenCount: 150
      })),
      agySession(JSON.stringify({
        promptTokenCount: 200,
        cachedContentTokenCount: null,
        candidatesTokenCount: 60,
        thoughtsTokenCount: 15,
        totalTokenCount: 275
      })),
      agySession(null),
      agySession(JSON.stringify({ totalTokenCount: 999 }), "claude")
    ]);

    expect(text).toContain("2개 세션 합계");
    expect(text).toContain("전체: 425");
    expect(text).toContain("입력(prompt): 300");
    expect(text).not.toContain("999");
  });

  it("reports when no agy session has measured usage", () => {
    const text = formatAgyAccountUsage([agySession(null), agySession(null, "codex")]);
    expect(text).toContain("측정된 세션이 없습니다");
  });

  it("renders grok credit limits from the billing snapshot", () => {
    const text = formatGrokUsage({
      snapshot: {
        capturedAt: Date.UTC(2026, 6, 14),
        creditUsagePercent: 61,
        periodType: "USAGE_PERIOD_TYPE_WEEKLY",
        periodStart: "2026-07-11T04:24:10Z",
        periodEnd: "2026-07-18T04:24:10Z",
        productUsage: [
          { product: "GrokBuild", usagePercent: 59 },
          { product: "Api", usagePercent: 88 },
          // 사용률이 없는 제품은 이번 주기에 쓰지 않은 것이라 출력에서 빠져야 한다.
          { product: "GrokChat", usagePercent: null }
        ],
        onDemandCap: 100,
        onDemandUsed: 25,
        prepaidBalance: 12
      },
      error: null
    });
    expect(text).toContain("Grok 구독 사용량");
    expect(text).toContain("구독 크레딧: 61% 사용");
    expect(text).toContain("주간 주기");
    expect(text).toContain("GrokBuild 59%");
    expect(text).not.toContain("GrokChat");
    expect(text).not.toContain("Api 88%");
    expect(text).not.toContain("온디맨드");
    expect(text).not.toContain("선불 잔액");
    expect(text).toContain("API 키 사용량 제외");
  });

  it("warns when grok credits are nearly exhausted", () => {
    const text = formatGrokUsage({
      snapshot: {
        capturedAt: 0,
        creditUsagePercent: 92,
        periodType: null,
        periodStart: null,
        periodEnd: null,
        productUsage: [],
        onDemandCap: null,
        onDemandUsed: null,
        prepaidBalance: null
      },
      error: null
    });
    expect(text).toContain("80% 이상");
  });

  it("surfaces the reason when the grok billing lookup fails", () => {
    const text = formatGrokUsage({ snapshot: null, error: "인증 만료 (`grok login` 필요)" });
    expect(text).toContain("조회 실패");
    expect(text).toContain("grok login");
  });
});

describe("Cline usage", () => {
  const stored = JSON.stringify({
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalCost: 5 },
    aggregateUsage: {
      inputTokens: 304792, outputTokens: 9383,
      cacheReadTokens: 269568, cacheWriteTokens: 0, totalCost: 0.32728
    }
  });
  const clineSession = (clineUsage: string | null, clineProviderId = "anthropic"): SessionRecord =>
    ({ provider: "cline", clineUsage, clineProviderId }) as unknown as SessionRecord;

  it("prefers aggregateUsage over the per-turn usage block", () => {
    expect(parseStoredClineUsage(stored)).toEqual({
      inputTokens: 304792, outputTokens: 9383,
      cacheReadTokens: 269568, cacheWriteTokens: 0, totalCost: 0.32728
    });
  });

  it("returns null for missing, malformed, or empty usage", () => {
    expect(parseStoredClineUsage(null)).toBeNull();
    expect(parseStoredClineUsage("not json")).toBeNull();
    expect(parseStoredClineUsage("{}")).toBeNull();
  });

  it("summarizes only cline sessions and marks cache as included in input", () => {
    const text = formatClineAccountUsage([
      clineSession(stored),
      clineSession(null),
      ({ provider: "agy", agyUsage: null }) as unknown as SessionRecord
    ]);
    expect(text).toContain("1개 세션 합계");
    expect(text).toContain("입력(캐시 포함)");
    expect(text).toContain("$0.3273");
  });

  it("explains the empty case instead of printing zeros", () => {
    expect(formatClineAccountUsage([])).toContain("측정된 세션이 없습니다");
  });

  // ClinePass는 구독제라 종량 청구가 없다. SDK의 totalCost는 제공자와 무관하게 단가표로
  // 로컬 계산한 정가 환산액이므로, 구독 제공자에서 "비용"으로 읽히면 오표기가 된다.
  it("labels the dollar figure as a list-price equivalent under ClinePass", () => {
    const text = formatClineAccountUsage([clineSession(stored, "cline-pass")]);
    expect(text).toContain("정가 환산: $0.3273");
    expect(text).toContain("청구액 아님");
    expect(text).not.toContain("비용: $");
    expect(text).toContain("ClinePass 구독");
  });

  it("keeps the plain cost label for metered bring-your-own-key providers", () => {
    const text = formatClineAccountUsage([clineSession(stored, "anthropic")]);
    expect(text).toContain("비용: $0.3273");
    expect(text).not.toContain("정가 환산");
  });

  it("treats a mixed set as subscription so no total reads as an amount billed", () => {
    const text = formatClineAccountUsage([
      clineSession(stored, "anthropic"),
      clineSession(stored, "cline-pass")
    ]);
    expect(text).toContain("정가 환산");
    expect(text).not.toContain("비용: $");
  });

  it("recognizes ClinePass provider ids only", () => {
    expect(isClineSubscriptionProvider("cline-pass")).toBe(true);
    expect(isClineSubscriptionProvider("anthropic")).toBe(false);
    expect(isClineSubscriptionProvider(null)).toBe(false);
    expect(isClineSubscriptionProvider(undefined)).toBe(false);
  });
});
