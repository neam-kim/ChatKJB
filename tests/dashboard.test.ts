import { describe, expect, it } from "vitest";
import {
  buildDashboardCards,
  formatDashboardCard,
  inferNextAction,
  inferWaitingReason
} from "../src/dashboard.js";
import type { SessionRecord } from "../src/types.js";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = Date.now();
  return {
    id: "session-1",
    sdkSessionId: null,
    chatId: -100123,
    topicId: 456,
    projectName: "ChatKJB",
    cwd: "/tmp",
    title: "Orca식 dashboard 구현",
    status: "running",
    permissionMode: "auto",
    provider: "codex",
    model: null,
    thinking: null,
    claudeEffort: null,
    codexModel: "gpt-5-codex",
    codexReasoning: "medium",
    codexThreadId: null,
    agyModel: null,
    agyThinkingLevel: null,
    agyConversationId: null,
    agyUsage: null,
    grokUsage: null,
    handoffSummary: null,
    goalCondition: null,
    leanMode: true,
    usageSnapshot: {
      capturedAt: now,
      subscriptionType: null,
      rateLimitsAvailable: true,
      fiveHour: {
        utilization: 42,
        resetsAt: "2026-07-07T23:00:00.000Z"
      }
    },
    createdAt: now - 1000,
    updatedAt: now,
    ...overrides
  };
}

describe("dashboard cards", () => {
  it("formats agent, project, usage, waiting reason, next action, and topic link", () => {
    const now = Date.now();
    const cards = buildDashboardCards({
      sessions: [session()],
      inspections: [{
        sessionId: "session-1",
        startedAt: now - 90_000,
        pendingTurns: 1,
        codexInFlight: false,
        codexElapsedMs: null
      }],
      now
    });

    expect(cards).toHaveLength(1);
    const text = formatDashboardCard(cards[0]!, now);
    expect(text).toContain("[RUNNING] Codex · ChatKJB");
    expect(text).toContain("작업: Orca식 dashboard 구현");
    expect(text).toContain("모델: gpt-5-codex");
    expect(text).toContain("대기 턴: 1");
    expect(text).toContain("사용량:");
    expect(text).toContain("대기 사유: 응답 생성 중");
    expect(text).toContain("다음 액션: 완료 대기 또는 /steer");
    expect(text).toContain("https://t.me/c/123/456");
  });

  it("maps waiting statuses to actionable reasons", () => {
    expect(inferWaitingReason("waiting_approval", false)).toBe("사용자 승인 필요");
    expect(inferNextAction("waiting_approval", false)).toBe("토픽에서 승인 또는 거절");
    expect(inferWaitingReason("waiting_limit", false)).toBe("한도 회복 대기");
    expect(inferNextAction("waiting_limit", false)).toBe("자동 재개 대기 또는 /restop");
    expect(inferNextAction("verification_failed", false)).toBe("수정 지시 또는 /next");
  });
});
