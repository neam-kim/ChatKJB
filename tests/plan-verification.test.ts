import { describe, expect, it } from "vitest";
import {
  buildPlanPrompt,
  buildReviewPrompt,
  parseAcceptanceCriteria,
  parsePlanReview
} from "../src/plan-verification.js";

describe("plan acceptance criteria", () => {
  it("extracts numbered and checkbox criteria from the required marker block", () => {
    const plan = `
# 계획

[ACCEPTANCE_CRITERIA]
1. npm test가 종료 코드 0으로 완료된다.
- [ ] /status가 완료 기준 통계를 표시한다.
[/ACCEPTANCE_CRITERIA]
`;
    expect(parseAcceptanceCriteria(plan)).toEqual([
      "npm test가 종료 코드 0으로 완료된다.",
      "/status가 완료 기준 통계를 표시한다."
    ]);
  });

  it("requires the explicit marker block", () => {
    expect(parseAcceptanceCriteria("- 테스트가 통과한다.")).toEqual([]);
    expect(buildPlanPrompt("기능 구현")).toContain("[ACCEPTANCE_CRITERIA]");
    expect(buildPlanPrompt("기능 구현")).toContain("[/ACCEPTANCE_CRITERIA]");
  });
});

describe("structured plan review", () => {
  it("approves only when every criterion passes and blockers are empty", () => {
    const review = parsePlanReview(JSON.stringify({
      verdict: "APPROVE",
      summary: "검증 완료",
      blockers: [],
      criteria: [
        { ordinal: 1, status: "pass", evidence: "npm test 종료 코드 0" },
        { ordinal: 2, status: "pass", evidence: "/status 출력 확인" }
      ]
    }), 2);

    expect(review.approved).toBe(true);
    expect(review.criteria.map((criterion) => criterion.status)).toEqual(["pass", "pass"]);
  });

  it("rejects malformed output and missing criterion verdicts", () => {
    expect(parsePlanReview("검토 결과 문제 없음", 1)).toMatchObject({
      verdict: "REJECT",
      approved: false
    });

    const review = parsePlanReview(JSON.stringify({
      verdict: "APPROVE",
      summary: "일부만 검토",
      blockers: [],
      criteria: [
        { ordinal: 1, status: "pass", evidence: "첫 기준만 확인" }
      ]
    }), 2);
    expect(review.approved).toBe(false);
    expect(review.criteria[1]).toMatchObject({ ordinal: 2, status: "fail" });
  });

  it("includes criteria and evidence in the reviewer prompt", () => {
    const prompt = buildReviewPrompt(
      "plan",
      "codex result",
      ["테스트 통과"],
      [{
        id: "e1",
        planRunId: "run",
        criterionId: null,
        kind: "command",
        source: "codex",
        summary: "completed: npm test",
        details: {},
        createdAt: 1
      }],
      "M src/file.ts",
      "diff"
    );
    expect(prompt).toContain("1. 테스트 통과");
    expect(prompt).toContain("[command] completed: npm test");
    expect(prompt).toContain('"verdict": "APPROVE 또는 REJECT"');
  });
});
