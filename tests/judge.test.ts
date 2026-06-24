import { describe, expect, it, vi } from "vitest";

import {
  buildHaikuJudgePrompt,
  buildJudgeUserPrompt,
  buildSynthesisPrompt,
  judgeLocal,
  localJudgeConfig,
  parseJudgeResponse,
  type JudgeCandidate,
  type LocalJudgeConfig,
} from "../src/judge.js";

const candidates: JudgeCandidate[] = [
  { provider: "claude", text: "4" },
  { provider: "codex", text: "5" },
  { provider: "agy", text: "사과" },
];

function jsonResponse(content: string): Response {
  return {
    ok: true,
    json: async () => ({ message: { content } }),
  } as unknown as Response;
}

const cfg: LocalJudgeConfig = {
  url: "http://localhost:11434/api/chat",
  model: "qwen3.6:27b-96k",
  disabled: false,
  timeoutMs: 1000,
};

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

  it("Haiku 폴백 프롬프트는 채점 규약을 본문에 포함한다(self-contained)", () => {
    const prompt = buildHaikuJudgePrompt("2+2?", candidates);
    expect(prompt).toContain("중립 심사자");
    expect(prompt).toContain("[후보 2] (codex)");
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

describe("로컬 심사", () => {
  it("정상 응답이면 verdict를 돌려준다", async () => {
    const fetchMock = vi.fn(async () => jsonResponse('{"winner":1,"reason":"4가 맞다"}'));
    const r = await judgeLocal("2+2?", candidates, cfg, fetchMock as unknown as typeof fetch);
    expect(r).toEqual({ winner: 1, reason: "4가 맞다" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("disabled면 호출 없이 null", async () => {
    const fetchMock = vi.fn();
    const r = await judgeLocal("q", candidates, { ...cfg, disabled: true }, fetchMock as unknown as typeof fetch);
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HTTP 오류면 null(폴백 유도)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false }) as Response);
    const r = await judgeLocal("q", candidates, cfg, fetchMock as unknown as typeof fetch);
    expect(r).toBeNull();
  });

  it("fetch 예외(서버다운)면 null", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await judgeLocal("q", candidates, cfg, fetchMock as unknown as typeof fetch);
    expect(r).toBeNull();
  });

  it("응답이 JSON이 아니면 null", async () => {
    const fetchMock = vi.fn(async () => jsonResponse("무슨 답인지 모르겠음"));
    const r = await judgeLocal("q", candidates, cfg, fetchMock as unknown as typeof fetch);
    expect(r).toBeNull();
  });
});

describe("설정", () => {
  it("환경변수로 url·model·disabled를 오버라이드한다", () => {
    const c = localJudgeConfig({
      JUDGE_OLLAMA_URL: "http://x:1/api",
      JUDGE_MODEL: "m",
      JUDGE_DISABLE_LOCAL: "1",
    } as NodeJS.ProcessEnv);
    expect(c).toMatchObject({ url: "http://x:1/api", model: "m", disabled: true });
  });
});
