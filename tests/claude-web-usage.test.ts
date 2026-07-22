import { describe, expect, it } from "vitest";
import { parseClaudeUsagePageText } from "../src/claude-web-usage.js";

describe("parseClaudeUsagePageText", () => {
  it("한국어 사용량 화면에서 세션·주간 한도를 분리한다", () => {
    const usage = parseClaudeUsagePageText([
      "플랜 사용량 한도",
      "현재 세션",
      "3시간 19분 후 재설정",
      "98% 사용됨",
      "주간 한도",
      "모든 모델",
      "(수) 오전 10:59에 재설정",
      "8% 사용됨",
      "사용 크레딧",
      "90% 사용"
    ].join("\n"), 1234);
    expect(usage).toEqual({
      fiveHour: { utilization: 98, resetsAt: null },
      sevenDay: { utilization: 8, resetsAt: null },
      stale: false,
      capturedAt: 1234
    });
  });

  it("영어 화면과 소수 퍼센트도 처리한다", () => {
    const usage = parseClaudeUsagePageText([
      "Current session",
      "Resets in 2 hours",
      "12.5% used",
      "Weekly limit",
      "All models",
      "Resets Wednesday",
      "8% used",
      "Usage credits",
      "90% used"
    ].join("\n"), 9);
    expect(usage?.fiveHour?.utilization).toBe(12.5);
    expect(usage?.sevenDay?.utilization).toBe(8);
  });

  it("보안 확인·로그인 화면은 사용량으로 오인하지 않는다", () => {
    expect(parseClaudeUsagePageText("claude.ai\n보안 확인 수행 중\nCloudflare", 9)).toBeNull();
  });
});
