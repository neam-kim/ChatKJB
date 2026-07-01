import { describe, expect, it } from "vitest";

import {
  buildPeerCritiquePrompt,
  buildJudgePrompt,
  buildJudgeUserPrompt,
  buildRevisionPrompt,
  buildSynthesisPrompt,
  parseJudgeResponse,
  type JudgeCandidate,
} from "../src/judge.js";

const candidates: JudgeCandidate[] = [
  { provider: "claude", text: "4" },
  { provider: "codex", text: "5" },
  { provider: "agy", text: "사과" },
];

describe("심사 응답 파싱", () => {
  it("정상 JSON에서 winner·reason을 뽑는다", () => {
    expect(parseJudgeResponse('{"winner":1,"reason":"정답"}', 3)).toEqual({
      winner: 1,
      reason: "정답",
    });
  });

  it("승점 배열을 함께 파싱한다", () => {
    expect(parseJudgeResponse('{"scores":[6,3,0],"winner":1,"reason":"리그 1위"}', 3)).toEqual({
      scores: [6, 3, 0],
      winner: 1,
      reason: "리그 1위",
    });
  });

  it("winner가 없으면 승점 1위로 winner를 계산한다", () => {
    expect(parseJudgeResponse('{"scores":[1,4,2],"reason":"승점 우세"}', 3)).toEqual({
      scores: [1, 4, 2],
      winner: 2,
      reason: "승점 우세",
    });
  });

  it("코드펜스·앞뒤 잡텍스트가 섞여도 첫 JSON을 해석한다", () => {
    const r = parseJudgeResponse('생각: ...\n```json\n{"winner": 2, "reason": "더 완전"}\n```', 3);
    expect(r).toEqual({ winner: 2, reason: "더 완전" });
  });

  it("winner를 후보 범위로 클램프한다", () => {
    expect(parseJudgeResponse('{"winner":9,"reason":"x"}', 3)?.winner).toBe(3);
    expect(parseJudgeResponse('{"winner":0,"reason":"x"}', 3)?.winner).toBe(1);
  });

  it("JSON이 없거나 깨지면 null", () => {
    expect(parseJudgeResponse("그냥 텍스트", 3)).toBeNull();
    expect(parseJudgeResponse('{"winner":', 3)).toBeNull();
    expect(parseJudgeResponse("", 3)).toBeNull();
  });

  it("reason이 없으면 기본 문구를 채운다", () => {
    expect(parseJudgeResponse('{"winner":1}', 3)?.reason).toBe("근거 미상");
  });
});

describe("심사 프롬프트", () => {
  it("후보를 번호 매겨 본문에 넣는다", () => {
    const prompt = buildJudgeUserPrompt("2+2?", candidates);
    expect(prompt).toContain("[후보 1] (claude)");
    expect(prompt).toContain("[후보 3] (agy)");
  });

  it("클라우드 심사 프롬프트는 채점 규약을 본문에 포함한다(self-contained)", () => {
    const prompt = buildJudgePrompt("2+2?", candidates);
    expect(prompt).toContain("중립 심사자");
    expect(prompt).toContain("[후보 2] (codex)");
    expect(prompt).toContain("승점제 리그 방식");
    expect(prompt).toContain("후보 1 vs 후보 2");
    expect(prompt).toContain("JSON 한 줄로만 답한다");
  });

  it("상호 비판 프롬프트는 후보별 비판 메모만 요구한다", () => {
    const prompt = buildPeerCritiquePrompt("2+2?", candidates, "claude");
    expect(prompt).toContain("claude 관점");
    expect(prompt).toContain("[후보 3] (agy)");
    expect(prompt).toContain("비판 메모만");
    expect(prompt).toContain("최종 답변을 다시 쓰지 말고");
  });

  it("보완 프롬프트는 원 모델이 비판과 장점을 반영해 다시 쓰게 한다", () => {
    const prompt = buildRevisionPrompt("2+2?", candidates[1]!, candidates, [
      { provider: "claude", text: "codex 답은 산술이 틀림" },
      { provider: "agy", text: "claude 답이 정답" },
    ]);
    expect(prompt).toContain("codex의 원답");
    expect(prompt).toContain("← 너의 원답");
    expect(prompt).toContain("상호 비판 메모");
    expect(prompt).toContain("보완된 최종 후보 답변만");
  });

  it("종합 프롬프트는 최우수 후보를 표시하고 통합을 지시한다", () => {
    const prompt = buildSynthesisPrompt("2+2?", candidates, { winner: 2, reason: "더 정확", scores: [1, 4, 0] });
    expect(prompt).toContain("후보 2이(가) 최우수");
    expect(prompt).toContain("후보 2 4점");
    expect(prompt).toContain("← 최우수");
    expect(prompt).toContain("통합");
    expect(prompt).toContain("파일을 수정하지 말고");
  });

  it("종합 프롬프트는 winner를 후보 범위로 클램프한다", () => {
    const prompt = buildSynthesisPrompt("q", candidates, { winner: 99, reason: "x" });
    expect(prompt).toContain("후보 3이(가) 최우수");
  });
});
