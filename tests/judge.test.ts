import { describe, expect, it } from "vitest";

import {
  buildJudgePrompt,
  buildJudgeUserPrompt,
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
    expect(prompt).toContain("JSON 한 줄로만 답한다");
  });

  it("종합 프롬프트는 최우수 후보를 표시하고 통합을 지시한다", () => {
    const prompt = buildSynthesisPrompt("2+2?", candidates, { winner: 2, reason: "더 정확" });
    expect(prompt).toContain("후보 2이(가) 최우수");
    expect(prompt).toContain("← 최우수");
    expect(prompt).toContain("통합");
    expect(prompt).toContain("파일을 수정하지 말고");
  });

  it("종합 프롬프트는 winner를 후보 범위로 클램프한다", () => {
    const prompt = buildSynthesisPrompt("q", candidates, { winner: 99, reason: "x" });
    expect(prompt).toContain("후보 3이(가) 최우수");
  });
});
