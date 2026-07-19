import type { ProviderKind } from "./types.js";

// 병렬 종합의 심사 프롬프트와 응답 파서. 여러 provider가 같은 작업을 푼 후보 답들을 받아
// 가장 정확·완전한 것을 고르게 한다. 실제 심사는 동적으로 감지한 최신 Claude Fable 판관이 수행하며
// (실패 시 첫 후보 폴백), session-manager가 담당하므로 이 모듈은 SDK에 의존하지 않는다.

export interface JudgeCandidate {
  provider: ProviderKind;
  text: string;
}

export interface JudgeVerdict {
  // 1-based 후보 번호.
  winner: number;
  reason: string;
  // 후보 순서와 같은 승점 배열. 리그식 심사에서만 채운다.
  scores?: number[];
  // 어느 심사자가 판정했는지(투명성). "claude" = 최신 Fable, "fallback" = 첫 후보 채택.
  judge: "claude" | "fallback";
  judgeModel?: string;
}

export interface SynthCritique {
  provider: ProviderKind;
  text: string;
}

const JUDGE_SYSTEM =
  "너는 여러 후보 답변을 채점하는 중립 심사자다. 작업을 직접 수행하지 말고, 주어진 "
  + "후보들만 승점제 리그 방식으로 비교한다. 모든 후보 쌍을 맞대결로 평가해 승=3점, "
  + "무=1점, 패=0점을 부여하고 총 승점이 가장 높은 후보를 고른다. 반드시 JSON 한 줄로만 답한다: "
  + '{"scores": [<후보 순서의 승점>], "winner": <1부터 시작하는 후보 번호>, "reason": <한 문장 근거>}';

// 후보들을 번호 매겨 심사 프롬프트 본문으로 만든다. 로컬·Haiku 공용.
export function buildJudgeUserPrompt(question: string, candidates: readonly JudgeCandidate[]): string {
  const lines = [`작업/질문:\n${question.trim()}`, "", "후보 답변들:"];
  candidates.forEach((c, i) => {
    lines.push(`\n[후보 ${i + 1}] (${c.provider})\n${c.text.trim()}`);
  });
  lines.push("", "리그 대진:");
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      lines.push(`- 후보 ${i + 1} vs 후보 ${j + 1}`);
    }
  }
  lines.push(
    "",
    "각 대진에서 더 정확하고 완전한 답은 승리(3점), 비슷하면 무승부(각 1점), 부족한 답은 패배(0점)로 처리하라. "
    + "총 승점이 가장 높은 후보의 번호, 후보 순서의 승점 배열, 한 문장 근거를 JSON으로만 답하라. "
    + "승점 동률이면 더 직접적이고 검증 가능한 답을 우선한다."
  );
  return lines.join("\n");
}

// 모델 응답 문자열에서 {scores, winner, reason}을 견고하게 파싱한다. 코드펜스·앞뒤 잡텍스트가
// 섞여도 첫 JSON 객체를 찾아 해석하고, winner를 후보 범위로 클램프한다.
export function parseJudgeResponse(
  content: string,
  candidateCount: number
): { winner: number; reason: string; scores?: number[] } | null {
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
  const scores = Array.isArray(obj.scores) && obj.scores.length === candidateCount
    ? obj.scores.map((score) => Math.max(0, Math.round(Number(score))))
    : undefined;
  const validScores = scores?.every((score) => Number.isFinite(score)) ? scores : undefined;
  const rawWinner = Number(obj.winner);
  if (!Number.isFinite(rawWinner) && !validScores) return null;
  const scoreWinner = validScores
    ? validScores.reduce((best, score, index) => score > validScores[best]! ? index : best, 0) + 1
    : null;
  const selectedWinner = Number.isFinite(rawWinner) ? rawWinner : scoreWinner;
  if (selectedWinner === null) return null;
  const winner = Math.min(Math.max(Math.round(selectedWinner), 1), candidateCount);
  const reason = typeof obj.reason === "string" && obj.reason.trim()
    ? obj.reason.trim()
    : "근거 미상";
  return { winner, reason, ...(validScores ? { scores: validScores } : {}) };
}

// 클라우드 심사용 프롬프트. Claude·Codex 실행 경로가 system 프롬프트를 따로 주입하지
// 않으므로 채점 규약을 본문에 포함한다(self-contained).
export function buildJudgePrompt(question: string, candidates: readonly JudgeCandidate[]): string {
  return [
    JUDGE_SYSTEM,
    "",
    buildJudgeUserPrompt(question, candidates)
  ].join("\n");
}

export function buildPeerCritiquePrompt(
  question: string,
  candidates: readonly JudgeCandidate[],
  reviewer: ProviderKind
): string {
  const lines = [
    "아래는 같은 작업에 대한 여러 AI의 원답이다.",
    `작업/질문:\n${question.trim()}`,
    "",
    "원답 후보들:"
  ];
  candidates.forEach((c, i) => {
    lines.push(`\n[후보 ${i + 1}] (${c.provider})\n${c.text.trim()}`);
  });
  lines.push(
    "",
    `${reviewer} 관점에서 각 후보의 중요한 비판점, 누락, 오류, 더 나은 부분을 짧게 정리하라. `
    + "최종 답변을 다시 쓰지 말고, 후보별 개선에 필요한 비판 메모만 작성하라. "
    + "파일을 수정하지 말고 답변만 작성하라."
  );
  return lines.join("\n");
}

export function buildRevisionPrompt(
  question: string,
  originalCandidate: JudgeCandidate,
  candidates: readonly JudgeCandidate[],
  critiques: readonly SynthCritique[]
): string {
  const lines = [
    "아래는 같은 작업에 대한 원답들과 상호 비판 메모다.",
    `작업/질문:\n${question.trim()}`,
    "",
    `너는 ${originalCandidate.provider}의 원답을 낸 모델이다. 원래 답을 방어적으로 고집하지 말고, `
    + "비판 중 타당한 부분과 다른 후보의 장점을 반영해 자신의 답변을 보완하라.",
    "",
    "원답 후보들:"
  ];
  candidates.forEach((c, i) => {
    const tag = c.provider === originalCandidate.provider ? " ← 너의 원답" : "";
    lines.push(`\n[후보 ${i + 1}] (${c.provider})${tag}\n${c.text.trim()}`);
  });
  lines.push("", "상호 비판 메모:");
  critiques.forEach((critique) => {
    lines.push(`\n[비판자: ${critique.provider}]\n${critique.text.trim()}`);
  });
  lines.push(
    "",
    "이제 보완된 최종 후보 답변만 출력하라. 비판 과정, 후보 비교, 변경 내역은 설명하지 말라. "
    + "파일을 수정하지 말고 답변만 작성하라."
  );
  return lines.join("\n");
}

// 승자 기반 통합 프롬프트. 심사에서 1위로 뽑힌 후보를 기준으로, 다른 후보의 더 나은 부분을
// 흡수해 최종본을 만들게 한다. 종합자(승자 provider)가 읽기 전용으로 1회 실행한다.
export function buildSynthesisPrompt(
  question: string,
  candidates: readonly JudgeCandidate[],
  verdict: { winner: number; reason: string; scores?: readonly number[] }
): string {
  const winnerIdx = Math.min(Math.max(verdict.winner, 1), candidates.length);
  const scoreText = verdict.scores && verdict.scores.length === candidates.length
    ? ` / 승점: ${verdict.scores.map((score, index) => `후보 ${index + 1} ${score}점`).join(", ")}`
    : "";
  const lines = [
    "아래는 같은 작업에 대한 여러 AI의 후보 답변과, 승점제 리그 심사자가 고른 최우수 후보다.",
    `작업/질문:\n${question.trim()}`,
    "",
    `심사 결과: 후보 ${winnerIdx}이(가) 최우수${scoreText} (근거: ${verdict.reason}).`,
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
