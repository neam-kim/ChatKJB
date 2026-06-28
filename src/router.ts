import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderKind } from "./types.js";
import { filesystemPath } from "./filesystem-path.js";

// LLM-Wiki 저장소 루트. 환경변수 WIKI_VAULT로 위치를 바꾼 경우도 따른다.
export function wikiVaultPath(env: NodeJS.ProcessEnv = process.env): string {
  return filesystemPath(
    env.WIKI_VAULT ||
    "smb://JB_Kim._smb._tcp.local/homes/mac_neam96/AI/LLM-Wiki"
  );
}

// 집계기(scripts/aggregate-agent-strengths.mjs)가 강점 사전을 쓰는 곳과 같은 경로.
export function agentStrengthsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.STRENGTHS_OUT) return env.STRENGTHS_OUT;
  return join(wikiVaultPath(env), "_meta", "agent-strengths.md");
}

// 멀티모델 1단계 라우터: 작업 프롬프트를 작업유형으로 분류하고, 강점 사전
// (LLM-Wiki/_meta/agent-strengths.md)에서 도출된 라우팅 힌트를 결합해 적합한
// 제공자를 추천한다. 규칙(작업유형) 우선, 힌트는 동률·모호할 때의 보정값이다.
//
// 학습기가 아니라 결정적 규칙 + 이력 힌트의 조합이다. 힌트 파일이 없거나 비어 있어도
// 규칙만으로 안전하게 동작한다(콜드 스타트 내성).

export type TaskType =
  | "coding"
  | "multimodal"
  | "research"
  | "writing"
  | "automation"
  | "integration"
  | "other";

export interface RouteDecision {
  provider: ProviderKind;
  taskType: TaskType;
  reason: string;
  // 강점 사전 힌트가 규칙과 달라 보정에 쓰였는지(투명성용).
  usedHint: boolean;
}

// 작업유형 분류 규칙. scripts/aggregate-agent-strengths.mjs의 TASK_TYPE_RULES와
// 의미적으로 같게 유지한다(집계와 라우팅이 같은 작업유형 어휘를 써야 힌트가 맞물린다).
// 순서가 우선순위다.
const TASK_TYPE_RULES: ReadonlyArray<{ type: TaskType; keywords: readonly string[] }> = [
  { type: "coding", keywords: ["구현", "리팩터", "리팩토링", "버그", "수정", "코드", "함수", "빌드", "테스트", "타입", "배포", "deploy", "refactor", "implement", "fix"] },
  { type: "multimodal", keywords: ["이미지", "사진", "아이콘", "pdf", "오디오", "비디오", "동영상", "음성", "ocr", "스크린샷", "그림"] },
  { type: "research", keywords: ["조사", "검토", "분석", "비교", "타당성", "리서치", "research", "알아봐", "찾아"] },
  { type: "writing", keywords: ["요약", "번역", "작성", "문서", "정리", "위키", "노트", "readme", "summary", "translate", "write"] },
  { type: "automation", keywords: ["자동", "스케줄", "cron", "launchd", "데몬", "파이프라인", "봇", "오케스트레이터", "automation", "schedule"] },
  { type: "integration", keywords: ["mcp", "커넥터", "연동", "통합", "api", "플러그인", "서버 등록", "integration", "connector"] },
];

// 강점 사전이 아직 신호를 주지 못할 때(콜드 스타트)의 결정적 기본 매핑.
// .result.md 이력에서 거듭 확인된 역할 분담을 반영한다:
//   - 도구를 여러 번 호출하는 작업(코딩·통합·자동화·조사)은 한도가 넉넉한 Claude/Codex.
//   - 루프 없는 무거운 단발 멀티모달은 agy(Gemini 네이티브 멀티모달).
const DEFAULT_TYPE_PROVIDER: Readonly<Record<TaskType, ProviderKind>> = {
  coding: "codex",
  integration: "claude",
  automation: "claude",
  research: "claude",
  writing: "claude",
  multimodal: "agy",
  other: "claude",
};

export function classifyTaskType(prompt: string): TaskType {
  const lower = String(prompt || "").toLowerCase();
  for (const rule of TASK_TYPE_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw.toLowerCase()))) return rule.type;
  }
  return "other";
}

// agent-strengths.md의 "라우팅 힌트" 섹션을 파싱해 작업유형→provider 맵을 만든다.
// 형식 예: "- 작업유형 `coding` → 관측상 codex가 가장 많이 담당 (3건)."
// 파일이 없거나 형식이 어긋나면 빈 맵을 돌려준다(규칙만으로 동작).
export function parseStrengthHints(markdown: string): Partial<Record<TaskType, ProviderKind>> {
  const hints: Partial<Record<TaskType, ProviderKind>> = {};
  const lineRe = /작업유형\s+`([a-z]+)`\s*→\s*관측상\s+(claude|codex|agy)/u;
  for (const line of String(markdown || "").split("\n")) {
    const m = line.match(lineRe);
    if (!m) continue;
    const type = m[1] as TaskType;
    const provider = m[2] as ProviderKind;
    if (type in DEFAULT_TYPE_PROVIDER) hints[type] = provider;
  }
  return hints;
}

export function loadStrengthHints(path: string): Partial<Record<TaskType, ProviderKind>> {
  try {
    return parseStrengthHints(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// 작업 프롬프트를 받아 제공자를 결정한다.
//   1) 작업유형을 분류한다.
//   2) 강점 사전 힌트에 그 작업유형이 있고, 그 provider가 사용 가능하면 그것을 쓴다(이력 우선).
//   3) 없으면 결정적 기본 매핑을 쓴다.
//   4) 선택한 provider가 available에 없으면 available 중 안전 순서로 폴백한다.
export function routeProvider(
  prompt: string,
  hints: Partial<Record<TaskType, ProviderKind>> = {},
  available: readonly ProviderKind[] = ["claude", "codex", "agy"]
): RouteDecision {
  const taskType = classifyTaskType(prompt);
  const hinted = hints[taskType];
  const ruleProvider = DEFAULT_TYPE_PROVIDER[taskType];

  let provider: ProviderKind;
  let usedHint = false;
  let reason: string;

  if (hinted && available.includes(hinted)) {
    provider = hinted;
    usedHint = hinted !== ruleProvider;
    reason = usedHint
      ? `작업유형 '${taskType}' — 이력상 ${hinted}가 가장 많이 담당해 추천.`
      : `작업유형 '${taskType}' — 규칙과 이력이 모두 ${hinted}를 가리킴.`;
  } else if (available.includes(ruleProvider)) {
    provider = ruleProvider;
    reason = `작업유형 '${taskType}' — 기본 규칙상 ${ruleProvider} 추천.`;
  } else {
    // 폴백: 사용 가능한 제공자 중 안전 우선순위(claude→codex→agy).
    const fallback = (["claude", "codex", "agy"] as const).find((p) => available.includes(p));
    provider = fallback ?? "claude";
    reason = `작업유형 '${taskType}' — 권장 제공자를 쓸 수 없어 ${provider}로 폴백.`;
  }

  return { provider, taskType, reason, usedHint };
}
