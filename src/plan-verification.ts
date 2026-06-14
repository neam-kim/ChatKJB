import type { PlanCriterionStatus, PlanEvidenceRecord } from "./types.js";

const CRITERIA_START = "[ACCEPTANCE_CRITERIA]";
const CRITERIA_END = "[/ACCEPTANCE_CRITERIA]";

export interface ReviewedCriterion {
  ordinal: number;
  status: Exclude<PlanCriterionStatus, "pending">;
  evidence: string;
}

export interface StructuredPlanReview {
  verdict: "APPROVE" | "REJECT";
  summary: string;
  blockers: string[];
  criteria: ReviewedCriterion[];
  approved: boolean;
}

function cleanCriterion(line: string): string {
  return line
    .replace(/^\s*(?:[-*]\s+)?\[[ xX]\]\s+/, "")
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseAcceptanceCriteria(plan: string): string[] {
  const upper = plan.toUpperCase();
  const start = upper.indexOf(CRITERIA_START);
  const end = upper.indexOf(CRITERIA_END, start + CRITERIA_START.length);
  if (start < 0 || end < 0 || end <= start) return [];

  const body = plan.slice(start + CRITERIA_START.length, end);
  const seen = new Set<string>();
  const criteria: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const clean = cleanCriterion(line);
    if (!clean || clean === line.trim() || seen.has(clean)) continue;
    seen.add(clean);
    criteria.push(clean.slice(0, 1000));
    if (criteria.length >= 50) break;
  }
  return criteria;
}

export function buildPlanPrompt(instruction: string, previous?: string, revision?: string): string {
  const revisionBlock = previous
    ? `\n\n[이전 계획]\n${previous}\n\n[사용자 수정 요청]\n${revision ?? ""}`
    : "";
  return [
    instruction,
    "",
    "위 요청을 구현하기 위한 구체적이고 순서가 명확하며 자기완결적인 실행 계획을 작성하세요.",
    "관련 파일과 검증 방법을 포함하되 파일을 수정하거나 명령으로 변경하지 마세요.",
    previous
      ? "이전 계획과 사용자 수정 요청을 반영해 계획을 다시 작성하세요."
      : "요청이 모호하거나 핵심 정보가 빠졌다면 계획 확정 전에 AskUserQuestion으로 확인하세요.",
    "핵심 사항을 임의로 추측하지 마세요. 이후 Codex 실행은 비대화형입니다.",
    "",
    "계획 마지막에는 반드시 아래 형식으로 독립 검증 가능한 완료 기준을 1개 이상 작성하세요.",
    CRITERIA_START,
    "1. 실행 명령이나 관찰 가능한 결과로 참/거짓을 판정할 수 있는 기준",
    `2. 필요한 테스트와 회귀 방지 기준`,
    CRITERIA_END,
    "마커 이름을 바꾸거나 코드 블록으로 감싸지 마세요.",
    revisionBlock
  ].join("\n");
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate) throw new Error("검토 JSON을 찾을 수 없습니다.");
  return JSON.parse(candidate) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

export function parsePlanReview(text: string, criterionCount: number): StructuredPlanReview {
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "검토 JSON 파싱 실패";
    return {
      verdict: "REJECT",
      summary: reason,
      blockers: [reason],
      criteria: Array.from({ length: criterionCount }, (_, index) => ({
        ordinal: index + 1,
        status: "fail",
        evidence: "구조화된 검토 판정이 없습니다."
      })),
      approved: false
    };
  }

  if (!isRecord(parsed)) {
    return parsePlanReview("", criterionCount);
  }
  const rawCriteria = Array.isArray(parsed["criteria"]) ? parsed["criteria"] : [];
  const byOrdinal = new Map<number, ReviewedCriterion>();
  for (const item of rawCriteria) {
    if (!isRecord(item)) continue;
    const ordinal = item["ordinal"];
    const status = item["status"];
    const evidence = item["evidence"];
    if (
      typeof ordinal !== "number"
      || !Number.isInteger(ordinal)
      || ordinal < 1
      || ordinal > criterionCount
      || !["pass", "fail", "blocked"].includes(String(status))
      || typeof evidence !== "string"
      || evidence.trim() === ""
    ) {
      continue;
    }
    byOrdinal.set(ordinal, {
      ordinal,
      status: status as ReviewedCriterion["status"],
      evidence: evidence.trim().slice(0, 4000)
    });
  }

  const criteria = Array.from({ length: criterionCount }, (_, index) =>
    byOrdinal.get(index + 1) ?? {
      ordinal: index + 1,
      status: "fail" as const,
      evidence: "검토 응답에 이 기준의 판정이 없습니다."
    }
  );
  const verdict = parsed["verdict"] === "APPROVE" ? "APPROVE" : "REJECT";
  const blockers = strings(parsed["blockers"]).map((item) => item.trim().slice(0, 2000));
  const summary = typeof parsed["summary"] === "string" && parsed["summary"].trim()
    ? parsed["summary"].trim().slice(0, 4000)
    : verdict === "APPROVE"
      ? "모든 완료 기준을 통과했습니다."
      : "완료 기준 검토를 통과하지 못했습니다.";
  const approved = verdict === "APPROVE"
    && blockers.length === 0
    && criterionCount > 0
    && criteria.every((criterion) => criterion.status === "pass");
  return { verdict, summary, blockers, criteria, approved };
}

export function buildReviewPrompt(
  plan: string,
  codexResult: string,
  criteria: string[],
  evidence: PlanEvidenceRecord[],
  gitStatus: string,
  gitDiff: string
): string {
  const criteriaText = criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n");
  const evidenceText = evidence
    .slice(-80)
    .map((item) => `- [${item.kind}] ${item.summary}`)
    .join("\n");
  return [
    "Codex 구현 결과를 독립적으로 검토하세요. 구현자의 완료 주장을 신뢰하지 말고 실제 diff와 실행 증거를 기준으로 판정하세요.",
    "각 완료 기준은 관찰 가능한 증거가 있을 때만 pass로 판정합니다. 누락, 부분 구현, 테스트 미실행은 fail 또는 blocked입니다.",
    "",
    "[PLAN]",
    plan.slice(0, 12_000),
    "",
    "[완료 기준]",
    criteriaText,
    "",
    "[CODEX RESULT]",
    codexResult.slice(0, 12_000) || "(최종 응답 없음)",
    "",
    "[실행 증거 원장]",
    evidenceText || "(증거 없음)",
    "",
    "[GIT STATUS]",
    gitStatus || "(변경 없음)",
    "",
    "[GIT DIFF]",
    gitDiff.slice(0, 100_000) || "(diff 없음)",
    "",
    "아래 JSON 객체만 출력하세요. 코드 펜스와 추가 설명은 금지합니다.",
    "{",
    '  "verdict": "APPROVE 또는 REJECT",',
    '  "summary": "전체 판정 요약",',
    '  "blockers": ["승인을 막는 문제. 없으면 빈 배열"],',
    '  "criteria": [',
    '    {"ordinal": 1, "status": "pass 또는 fail 또는 blocked", "evidence": "실제 증거"}',
    "  ]",
    "}",
    `criteria에는 1부터 ${criteria.length}까지 모든 ordinal을 정확히 한 번씩 포함하세요.`,
    "verdict는 모든 기준이 pass이고 blockers가 없을 때만 APPROVE입니다."
  ].join("\n");
}

export function formatStructuredReview(review: StructuredPlanReview): string {
  const criteria = review.criteria
    .map((item) => `${item.status === "pass" ? "PASS" : item.status.toUpperCase()} ${item.ordinal}. ${item.evidence}`)
    .join("\n");
  const blockers = review.blockers.length > 0
    ? `\n차단 문제\n${review.blockers.map((item) => `- ${item}`).join("\n")}`
    : "";
  return [
    `판정: ${review.verdict}`,
    review.summary,
    "",
    "완료 기준",
    criteria,
    blockers
  ].join("\n");
}
