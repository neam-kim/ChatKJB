import { describe, expect, it } from "vitest";
import {
  buildDashboardCards,
  formatCockpitRunningStatus,
  formatDashboardCard,
  formatLegacyRunningStatus,
  formatRunningStatus,
  inferNextAction,
  inferWaitingReason,
  isCockpitV2Enabled
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

describe("cockpit running status", () => {
  it("enables COCKPIT_V2 by default and honors off switch", () => {
    expect(isCockpitV2Enabled({})).toBe(true);
    expect(isCockpitV2Enabled({ CHATKJB_COCKPIT_V2: "0" })).toBe(false);
    expect(isCockpitV2Enabled({ CHATKJB_COCKPIT_V2: "false" })).toBe(false);
  });

  it("renders four panes with explicit degrade plan", () => {
    const text = formatCockpitRunningStatus({
      session: session(),
      status: "running",
      startedAt: Date.now() - 5_000,
      currentActivity: "도구 사용: Read · src/a.ts",
      waitReason: { kind: "none", label: "대기 아님 · 실행 중" },
      ledgerEntries: [
        { at: Date.now(), kind: "tool", summary: "Read: src/a.ts" },
        { at: Date.now(), kind: "decision", summary: "조향: 테스트 추가" }
      ],
      remainingPlan: {
        items: ["테스트 작성"],
        completed: 1,
        total: 3,
        percent: 33,
        degraded: false,
        label: "1/3 완료 (33%) · ETA 미제공"
      },
      cockpitV2: true
    });
    expect(text).toContain("① 현재 단계·행동");
    expect(text).toContain("② 대기 사유");
    expect(text).toContain("③ 지금까지 한 일");
    expect(text).toContain("④ 남은 계획·진행률");
    expect(text).toContain("도구 사용: Read");
    expect(text).toContain("조향: 테스트 추가");
    expect(text).toContain("ETA 미제공");
  });

  it("keeps legacy layout when cockpitV2 is forced off", () => {
    const legacy = formatLegacyRunningStatus({
      session: session(),
      status: "running",
      startedAt: Date.now() - 1_000,
      recentActivity: "응답 대기 중"
    });
    const forced = formatRunningStatus({
      session: session(),
      status: "running",
      startedAt: Date.now() - 1_000,
      recentActivity: "응답 대기 중",
      cockpitV2: false
    });
    expect(legacy).toContain("대기 사유:");
    expect(legacy).not.toContain("① 현재 단계·행동");
    expect(forced).toBe(legacy);
  });
});
