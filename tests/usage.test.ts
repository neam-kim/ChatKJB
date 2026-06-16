import { describe, expect, it } from "vitest";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import {
  formatUsageSnapshot,
  mergeUsageSnapshots,
  snapshotFromRateLimitInfo,
  snapshotFromUsageResponse
} from "../src/usage.js";

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
});
