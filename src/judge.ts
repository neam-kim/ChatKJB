import type { ProviderKind } from "./types.js";

// 병렬 종합의 심사자. 여러 provider가 같은 작업을 푼 후보 답들을 받아 가장 정확·완전한
// 것을 고른다. 심사자는 작업을 수행하지 않는다(중립 채점만).
//
// 1차 = 로컬 qwen3.6(96k). 토큰 한도 무관·자기답 편향 없는 독립 심판.
// 폴백 = Haiku. 로컬이 죽거나 응답이 깨지면 자동 강등(로컬을 단일 장애점으로 두지 않음).
//
// 이 모듈은 SDK에 의존하지 않는다. 로컬 심사는 fetch로 자체 완결하고, Haiku 폴백은
// 프롬프트 빌더와 파서만 export해 session-manager의 기존 Claude 실행 경로가 호출한다.

export interface JudgeCandidate {
  provider: ProviderKind;
  text: string;
}

export interface JudgeVerdict {
  // 1-based 후보 번호.
  winner: number;
  reason: string;
  // 어느 심사자가 판정했는지(투명성).
  judge: "local" | "haiku" | "fallback";
}

export interface LocalJudgeConfig {
  url: string;
  model: string;
  disabled: boolean;
  timeoutMs: number;
}

export function localJudgeConfig(env: NodeJS.ProcessEnv = process.env): LocalJudgeConfig {
  return {
    url: env.JUDGE_OLLAMA_URL || "http://localhost:11434/api/chat",
    model: env.JUDGE_MODEL || "qwen3.6:27b-96k",
    disabled: env.JUDGE_DISABLE_LOCAL === "1",
    timeoutMs: Number(env.JUDGE_TIMEOUT_MS) || 60_000
  };
}

const JUDGE_SYSTEM =
  "너는 여러 후보 답변을 채점하는 중립 심사자다. 작업을 직접 수행하지 말고, 주어진 "
  + "후보들만 비교해 가장 정확하고 완전한 것을 고른다. 반드시 JSON 한 줄로만 답한다: "
  + '{"winner": <1부터 시작하는 후보 번호>, "reason": <한 문장 근거>}';

// 후보들을 번호 매겨 심사 프롬프트 본문으로 만든다. 로컬·Haiku 공용.
export function buildJudgeUserPrompt(question: string, candidates: readonly JudgeCandidate[]): string {
  const lines = [`작업/질문:\n${question.trim()}`, "", "후보 답변들:"];
  candidates.forEach((c, i) => {
    lines.push(`\n[후보 ${i + 1}] (${c.provider})\n${c.text.trim()}`);
  });
  lines.push("", "가장 정확하고 완전한 후보의 번호와 한 문장 근거를 JSON으로만 답하라.");
  return lines.join("\n");
}

// 모델 응답 문자열에서 {winner, reason}을 견고하게 파싱한다. 코드펜스·앞뒤 잡텍스트가
// 섞여도 첫 JSON 객체를 찾아 해석하고, winner를 후보 범위로 클램프한다.
export function parseJudgeResponse(
  content: string,
  candidateCount: number
): { winner: number; reason: string } | null {
  if (!content || candidateCount <= 0) return null;
  const match = content.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const rawWinner = Number(obj.winner);
  if (!Number.isFinite(rawWinner)) return null;
  const winner = Math.min(Math.max(Math.round(rawWinner), 1), candidateCount);
  const reason = typeof obj.reason === "string" && obj.reason.trim()
    ? obj.reason.trim()
    : "근거 미상";
  return { winner, reason };
}

// 로컬 qwen3.6에 심사를 의뢰한다. 성공 시 {winner,reason}, 실패(서버다운·타임아웃·
// JSON깨짐·disabled)면 null을 돌려 호출자가 Haiku로 폴백하게 한다.
export async function judgeLocal(
  question: string,
  candidates: readonly JudgeCandidate[],
  config: LocalJudgeConfig = localJudgeConfig(),
  fetchImpl: typeof fetch = fetch
): Promise<{ winner: number; reason: string } | null> {
  if (config.disabled || candidates.length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        stream: false,
        think: false,
        options: { temperature: 0, num_ctx: 16_384 },
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: buildJudgeUserPrompt(question, candidates) }
        ]
      })
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { message?: { content?: string } };
    const content = data.message?.content ?? "";
    return parseJudgeResponse(content, candidates.length);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Haiku 폴백용 프롬프트. 로컬과 같은 채점 규약을 쓰되, Claude 실행 경로가 system 프롬프트를
// 따로 주입하지 않으므로 규약을 본문에 포함한다(self-contained).
export function buildHaikuJudgePrompt(question: string, candidates: readonly JudgeCandidate[]): string {
  return [
    JUDGE_SYSTEM,
    "",
    buildJudgeUserPrompt(question, candidates)
  ].join("\n");
}

// 승자 기반 통합 프롬프트. 심사에서 1위로 뽑힌 후보를 기준으로, 다른 후보의 더 나은 부분을
// 흡수해 최종본을 만들게 한다. 종합자(승자 provider)가 읽기 전용으로 1회 실행한다.
export function buildSynthesisPrompt(
  question: string,
  candidates: readonly JudgeCandidate[],
  verdict: { winner: number; reason: string }
): string {
  const winnerIdx = Math.min(Math.max(verdict.winner, 1), candidates.length);
  const lines = [
    "아래는 같은 작업에 대한 여러 AI의 후보 답변과, 심사자가 고른 최우수 후보다.",
    `작업/질문:\n${question.trim()}`,
    "",
    `심사 결과: 후보 ${winnerIdx}이(가) 최우수 (근거: ${verdict.reason}).`,
    ""
  ];
  candidates.forEach((c, i) => {
    const tag = i + 1 === winnerIdx ? " ← 최우수" : "";
    lines.push(`[후보 ${i + 1}] (${c.provider})${tag}\n${c.text.trim()}\n`);
  });
  lines.push(
    "",
    `최우수 후보(후보 ${winnerIdx})를 기준으로 삼되, 다른 후보의 더 정확하거나 완전한 부분이 `
    + "있으면 그것을 흡수해 하나의 최종 답변으로 통합하라. 후보 비교 과정은 설명하지 말고 "
    + "최종 답변 본문만 출력하라. 파일을 수정하지 말고 답변만 작성하라."
  );
  return lines.join("\n");
}
