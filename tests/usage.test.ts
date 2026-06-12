import { describe, expect, it } from "vitest";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import {
  AGENT_SDK_CREDIT_START_AT,
  formatUsageSnapshot,
  mergeUsageSnapshots,
  snapshotFromRateLimitInfo,
  snapshotFromUsageResponse
} from "../src/usage.js";

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

  it("shows subscription windows before June 15", () => {
    const snapshot = snapshotFromUsageResponse({
      session: {
        total_cost_usd: 1,
        total_api_duration_ms: 1,
        total_duration_ms: 1,
        total_lines_added: 0,
        total_lines_removed: 0,
        model_usage: {}
      },
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 55, resets_at: "2026-06-12T08:00:00.000Z" }
      },
      behaviors: null
    });

    expect(formatUsageSnapshot(snapshot, AGENT_SDK_CREDIT_START_AT - 1))
      .toContain("5시간 한도: 55% 사용");
  });

  it("warns before starting more long work near the five-hour limit", () => {
    const text = formatUsageSnapshot({
      capturedAt: Date.now(),
      subscriptionType: "pro",
      rateLimitsAvailable: true,
      fiveHour: { utilization: 85, resetsAt: null }
    }, AGENT_SDK_CREDIT_START_AT - 1);

    expect(text).toContain("긴 작업을 추가 실행하면");
  });

  it("shows the monthly Agent SDK credit when the server exposes it", () => {
    const response = {
      session: {
        total_cost_usd: 1,
        total_api_duration_ms: 1,
        total_duration_ms: 1,
        total_lines_added: 0,
        total_lines_removed: 0,
        model_usage: {}
      },
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: null,
      behaviors: null,
      agent_sdk_credit: {
        utilization: 25,
        used_credits: 25,
        monthly_limit: 100,
        currency: "USD",
        resets_at: "2026-07-01T00:00:00.000Z"
      }
    } as unknown as SDKControlGetUsageResponse;
    const snapshot = snapshotFromUsageResponse(response);

    expect(formatUsageSnapshot(snapshot, AGENT_SDK_CREDIT_START_AT))
      .toContain("월간 Agent SDK 크레딧: 25% 사용");
    expect(formatUsageSnapshot(snapshot, AGENT_SDK_CREDIT_START_AT))
      .toContain("$25.00 / $100.00");
  });

  it("does not invent monthly credit usage when the server omits it", () => {
    const text = formatUsageSnapshot({
      capturedAt: Date.now(),
      subscriptionType: "pro",
      rateLimitsAvailable: true
    }, AGENT_SDK_CREDIT_START_AT);

    expect(text).toContain("공식 사용량 정보 미제공");
  });

  it("warns from credit amounts and keeps server-provided subscription windows visible", () => {
    const text = formatUsageSnapshot({
      capturedAt: Date.now(),
      subscriptionType: "max",
      rateLimitsAvailable: true,
      fiveHour: { utilization: 35, resetsAt: null },
      agentSdkCredit: {
        utilization: null,
        resetsAt: null,
        usedCredits: 85,
        monthlyLimit: 100,
        currency: "USD"
      }
    }, AGENT_SDK_CREDIT_START_AT);

    expect(text).toContain("월간 크레딧이 80% 이상");
    expect(text).toContain("Claude 구독 5시간 한도 (참고)");
  });
});
