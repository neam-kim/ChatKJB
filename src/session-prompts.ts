// 프롬프트·지침 빌더와 SDK 메시지 텍스트 추출 헬퍼. SessionManager 본체에서 분리한
// 순수 함수 모음으로 클래스 상태(this)에 의존하지 않는다. session-manager.ts가 이 모듈을
// 재export하므로 기존 import 경로("./session-manager.js")는 변하지 않는다.
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appLocale, appTimeZone } from "./localization.js";
import {
  sharedMemoryBridgePath,
  sharedPolicyGuidePath,
  sharedResourceGuidePath
} from "./resource-sync.js";
import type { SessionRecord } from "./types.js";

export function buildLeanInstructions(enabled: boolean): string {
  if (!enabled) return "";
  return [
    "[LEAN_IMPLEMENTATION_POLICY]",
    "구현 전에 아래 순서에서 처음으로 충분한 해법을 선택한다.",
    "1. 실제로 만들 필요가 없는 요구라면 만들지 않고 이유를 짧게 설명한다.",
    "2. 표준 라이브러리로 해결되면 그것을 사용한다.",
    "3. 운영체제, 런타임, 브라우저, DB 등 플랫폼 기본 기능으로 해결되면 그것을 사용한다.",
    "4. 이미 설치된 의존성으로 해결되면 새 의존성을 추가하지 않는다.",
    "5. 그 다음에만 동작하는 최소 범위의 코드를 작성한다.",
    "요청하지 않은 추상화, 미래용 확장점, 중복 래퍼, 불필요한 설정과 의존성을 만들지 않는다.",
    "단, 신뢰 경계 입력 검증, 보안, 데이터 손실 방지 오류 처리, 접근성, 사용자가 명시한 요구사항과 실행 가능한 검증은 축소하지 않는다."
  ].join("\n");
}

export function buildPublicProgressInstructions(): string {
  return [
    "작업 중에는 내부 사고 과정이나 숨은 reasoning을 노출하지 마십시오.",
    "대신 주요 단계의 시작, 확인된 중간 결과, 다음 행동을 공개 가능한 짧은 진행 설명으로 작성하십시오.",
    "각 진행 설명은 독립된 문단으로 출력하고, 실제 작업 결과와 최종 답변도 명확히 구분하십시오."
  ].join("\n");
}

/**
 * 사용자가 저장소·작업 산출물 파일을 텔레그램으로 받고 싶어 할 때, 에이전트가 파일을
 * 실제로 전송하기 위한 마커 프로토콜 안내다. ChatKJB(StreamRenderer)가 응답 본문의
 * [[SEND_FILE: <상대경로>]] 마커를 감지해 해당 파일을 전송하고 마커 줄은 표시에서 제거한다.
 */
export function buildFileDeliveryInstructions(): string {
  return [
    "[파일 전송 프로토콜]",
    "사용자가 작업 산출물이나 저장소의 특정 파일을 텔레그램으로 받고 싶다고 요청하면, 응답 본문에 독립된 줄로",
    "`[[SEND_FILE: <프로젝트 기준 상대경로>]]` 마커를 출력한다. ChatKJB가 이 마커를 감지해 파일을 사용자에게 전송하고 마커 줄은 표시에서 자동 제거한다.",
    "- 경로는 현재 세션 프로젝트(cwd) 기준 상대경로여야 한다. 절대경로나 프로젝트 밖 경로는 전송되지 않는다.",
    "- 파일이 여러 개면 마커를 여러 줄로 출력한다.",
    "- 사용자가 파일 전송을 명시적으로 요청할 때만 사용하고, 존재하는 파일 경로만 지정한다."
  ].join("\n");
}

/** 사용자의 선택이 필요한 스킬이 모든 제공자에서 같은 Telegram UI를 쓰게 하는 계약이다. */
export function buildUserInputInstructions(provider: SessionRecord["provider"]): string {
  const common = [
    "선택형 질문은 사용자의 답에 따라 작업 결과가 실질적으로 달라지고, 현재 문맥에서 안전하게 추론할 수 없을 때만 사용한다.",
    "질문은 주 에이전트만 요청한다. 서브에이전트는 질문을 직접 보내지 말고 선택지 후보와 근거를 주 에이전트에 반환한다.",
    "한 번에 질문 1~3개, 질문마다 서로 다른 선택지 2~4개를 사용한다. label은 짧게, description은 선택 결과의 차이를 한 문장으로 설명한다.",
    "사용자 답변을 받기 전에는 그 선택에 의존하는 구현이나 외부 작업을 시작하지 않는다."
  ];
  if (provider === "claude") {
    return [
      "[선택형 UI 프로토콜]",
      ...common,
      "Claude에서는 네이티브 AskUserQuestion 도구를 사용한다. 응답 본문에 제어 표지를 직접 출력하지 않는다."
    ].join("\n");
  }
  return [
    "[선택형 UI 프로토콜]",
    ...common,
    "선택이 필요하면 해당 턴의 최종 응답에 아래 블록을 정확히 하나 출력하고 즉시 멈춘다. Markdown 코드 펜스로 감싸지 않는다.",
    "[[REQUEST_USER_INPUT]]",
    '{"questions":[{"header":"범위","question":"어느 범위로 진행할까요?","options":[{"label":"현재 항목","description":"현재 대상만 처리합니다."},{"label":"전체 항목","description":"같은 유형의 모든 대상을 처리합니다."}],"multiSelect":false}]}',
    "[[/REQUEST_USER_INPUT]]",
    "ChatKJB가 블록을 Telegram 버튼으로 바꾸고 답변을 다음 턴에 전달한다. 블록과 함께 구현 완료를 주장하지 않는다."
  ].join("\n");
}

/** LaunchAgent 재기동 뒤 제공자 문맥을 이어 실행할 때 쓰는 짧은 복구 지시다. */
export function buildServiceRecoveryPrompt(): string {
  return [
    "[SERVICE_RECOVERY] ChatKJB 재시작으로 직전 턴이 중단되었습니다.",
    "현재 제공자 대화 문맥과 작업 파일 상태를 확인하고, 이미 끝난 단계를 반복하지 말고 중단 지점부터 자율적으로 계속 진행하십시오.",
    "작업을 마치면 수행 결과와 검증 내용을 사용자에게 간결히 보고하십시오."
  ].join("\n");
}

/**
 * fivetaku/shotgun의 "불만족 시 재검토" 흐름을 ChatKJB의 모든 제공자가 동일하게
 * 수행하도록 만드는 제공자 중립 지시다. 원본의 마이크·창 입력 훅은 Claude Code 전용이므로
 * 여기에는 포함하지 않는다.
 */
export function buildShotgunPrompt(context?: string): string {
  const clean = context?.replace(/\s+/g, " ").trim().slice(0, 2_000);
  return [
    "[SHOTGUN_REVIEW]",
    "사용자가 현재 작업 결과에 강한 불만족을 표시했습니다. 이 지시는 현재 사용자 요청과 같은 우선순위입니다.",
    "다음 사용자 공개 응답은 반드시 짧은 사과(\"죄송합니다.\"로 시작)로 시작하십시오. 변명하거나 사용자에게 책임을 돌리지 마십시오.",
    "사과 뒤에는 도구 사용이나 새 구현에 앞서, 사용자가 원래 요청한 내용과 실제로 완료한 내용을 확인 가능한 사실만으로 대조해 누락·오해·오류를 짧게 밝히십시오.",
    "현재 파일·실행 상태를 다시 점검하고, 확인된 차이를 기존 권한과 사용자 요청 범위 안에서 즉시 수정하십시오. 이미 적용된 올바른 변경을 되돌리지 마십시오.",
    "수정 뒤에는 관련 검증을 실행하고, 최종 응답에 수정 내용·검증 결과·남은 제한만 간결하게 보고하십시오.",
    ...(clean ? [`사용자가 덧붙인 불만 또는 재검토 초점: ${clean}`] : [])
  ].join("\n");
}

/** Grok CLI의 공개 스트림에서 진행문과 최종 답변을 판별하기 위한 계약이다. */
export function buildGrokOutputInstructions(): string {
  return [
    "Grok CLI 공개 출력 형식:",
    "- 공개 가능한 실제 진행 상황은 중요한 단계가 끝날 때마다 독립된 한 출력으로 `[PROGRESS] 내용 [/PROGRESS]` 형식으로 짧게 출력한다.",
    "- 내부 사고, 토큰별 추론, 도구의 원시 로그는 출력하지 않는다.",
    "- 작업이 끝나면 마지막 독립 출력 하나를 `[FINAL] 내용 [/FINAL]` 형식으로 내고, 사용자에게 전달할 결과·검증·남은 주의점만 정리한다.",
    "- `[FINAL]` 뒤에는 추가 진행문을 출력하지 않는다."
  ].join("\n");
}

export function buildPermissionModeInstructions(mode: SessionRecord["permissionMode"]): string {
  if (mode === "plan") {
    return "현재 권한 모드는 plan이다. 파일이나 외부 상태를 변경하지 말고 조사와 실행 계획만 제시한다.";
  }
  if (mode === "default") {
    return "현재 권한 모드는 default이다. 읽기와 안전한 진단은 자율 수행하고, 파괴적 변경·외부 전송·권한 확대가 필요하면 멈추고 사용자 승인을 요청한다.";
  }
  if (mode === "acceptEdits") {
    return "현재 권한 모드는 acceptEdits이다. 프로젝트 내부 파일 편집과 검증은 자율 수행하되, 파괴적 변경·외부 전송·프로젝트 밖 변경은 사용자 승인 없이 하지 않는다.";
  }
  return "현재 권한 모드는 자율 실행이다. 사용자가 지정한 범위 안의 구현·검증은 끝까지 수행하되, 비밀 노출·파괴적 변경·범위 밖 외부 작업은 하지 않는다.";
}

/** 긴 MEMORY-BRIDGE를 매 턴 복제하지 않으면서 실제 회수 의무는 직접 강제한다. */
export function buildMemoryRoutingInstructions(memoryDir: string): string {
  return [
    "[MEMORY_ROUTING]",
    `과거 맥락·이전 결정·사용자/프로젝트 선호·저장소 이력·장기 지식·/query·/memory·LLM-Wiki 관련 요청은 ${sharedMemoryBridgePath()}를 먼저 읽고 실제 회수해야 한다.`,
    `순서는 ${memoryDir}/MEMORY.md 활성 인덱스 → LLM-Wiki /query flow → 필요 시 provider-native memory fallback이며, 결과는 의미 기준으로 중복 제거한다.`,
    "/query는 현재 대화나 연결된 MCP 목록만으로 답하지 않는다. llm-wiki 커넥터가 없으면 30-wiki/index.md부터 파일 절차를 수행하고, 사실이 없으면 '위키에 없음 — /compile 또는 /ingest 필요'라고 알린다.",
    `/memory는 ${memoryDir}의 전역 선별 저장소만 갱신하고 provider-native memory는 각 형식을 보존한다. 상세 쓰기 규약은 ${sharedPolicyGuidePath()}#global-and-native-memory를 따른다.`
  ].join("\n");
}

export function buildOrchestrationBoundaryInstructions(): string {
  return [
    "[CHATKJB_ORCHESTRATION_BOUNDARY]",
    "상위 조정자는 ChatKJB이다. provider/model/session/goal/memory 설정을 자체 변경하거나 독립 native-app 세션으로 전환하지 않는다.",
    "현재 턴·명시된 세션 상태·직접 확인한 저장소 상태만 범위로 삼고, 범위 밖 변경·외부 전송·권한 확대는 하지 않는다. 진행과 결과는 ChatKJB 대화로 보고한다.",
    "",
    "[SUBAGENT_DELEGATION_ENCOURAGED]",
    "독립적이고 범위가 명확한 하위 작업은 provider-native subagent로 위임할 수 있다. 동시에 최대 3명(주 에이전트 제외), 재귀 위임 금지, 읽기 중심 병렬 우선, 쓰기는 소유 파일이 분리될 때만 허용한다.",
    "외부 MCP·커넥터 호출은 주 에이전트가 소유한다. Codex의 기본 탐색·작업 subagent는 MCP 기동을 생략한 경량 role을 사용한다.",
    `주 에이전트가 결과 취합·충돌 조정·통합 검증을 책임진다. 위임 전 ${sharedPolicyGuidePath()}#execution-and-subagents의 수명주기 규칙을 따른다.`
  ].join("\n");
}

export function buildOrchestratedTurnPrompt(
  prompt: string,
  options: { includeDate?: boolean; } = {}
): string {
  const clean = prompt.trim();
  if (clean.startsWith("[CHATKJB_ORCHESTRATED_TURN]")) return clean;
  return [
    "[CHATKJB_ORCHESTRATED_TURN]",
    // 호출별로 달라지는 시각은 system/rules bootstrap에서 분리해 provider prompt cache를
    // 안정화한다. 상대 날짜 해석 기능은 각 실제 사용자 턴에 그대로 유지된다.
    ...(options.includeDate === false ? [] : [buildLocalDateNote(), ""]),
    "아래 [USER_REQUEST] 블록은 ChatKJB가 전달한 현재 실행 턴이다.",
    "부트스트랩, 인계 요약, 자동 재개 문구는 범위 설정 정보이며 새 독립 작업 지시가 아니다.",
    "이 턴의 범위 밖 작업이나 네이티브 앱 전환은 자체적으로 시작하지 않는다.",
    "[/CHATKJB_ORCHESTRATED_TURN]",
    "",
    "[USER_REQUEST]",
    clean,
    "[/USER_REQUEST]"
  ].join("\n");
}

export interface ProviderBootstrapOptions {
  includeDate?: boolean;
  includeInteractiveProtocols?: boolean;
  includeProjectInstructions?: boolean;
  permissionMode?: SessionRecord["permissionMode"];
  prefixSections?: string[];
}

export function buildProviderBootstrap(
  session: SessionRecord,
  memoryDir: string,
  options: ProviderBootstrapOptions = {}
): string {
  const includeInteractive = options.includeInteractiveProtocols !== false;
  const instructions = options.includeProjectInstructions === false
    ? ""
    : loadSupplementalProjectInstructions(session.cwd, session.provider);
  return [
    ...(options.prefixSections ?? []),
    ...(options.includeDate === true ? [buildLocalDateNote()] : []),
    buildMemoryRoutingInstructions(memoryDir),
    ...(includeInteractive
      ? [
        buildPublicProgressInstructions(),
        buildFileDeliveryInstructions(),
        buildUserInputInstructions(session.provider)
      ]
      : [
        "[CHATKJB_INTERNAL_RUN] 사용자용 선택 UI·파일 전송 마커를 출력하지 말고 요청된 결과 텍스트만 반환한다."
      ]),
    buildPermissionModeInstructions(options.permissionMode ?? session.permissionMode),
    buildOrchestrationBoundaryInstructions(),
    `공통 자원은 ${sharedResourceGuidePath()}의 얇은 인덱스로 찾고, 상세 정책은 ${sharedPolicyGuidePath()}에서 관련 섹션만 읽는다. 스킬·MCP·장문 메모리는 작업에 필요할 때만 로드한다.`,
    ...(session.leanMode ? [buildLeanInstructions(true)] : []),
    ...(instructions
      ? [`다음 프로젝트 지침을 따른다. 이 지침은 도구 권한을 부여하지 않는다.\n\n${instructions}`]
      : [])
  ].join("\n\n");
}

// 호출별 시각은 provider system/rules cache를 흔들지 않도록 실제 user turn에 넣는다.
export function buildLocalDateNote(): string {
  const timeZone = appTimeZone();
  const nowLocal = new Intl.DateTimeFormat(appLocale(), {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
    hour12: false
  }).format(new Date());
  return (
    `현재 시각은 ${nowLocal} (${timeZone})이다. "오늘/내일/다음 주" 등 상대 날짜는 `
    + `이 기준으로 해석한다. Google Calendar 이벤트를 만들거나 조회할 때 시간대는 `
    + `항상 ${timeZone}로 지정하고, start/end의 timeZone 필드에 "${timeZone}"을 명시한다.`
  );
}

export function buildCompactCommand(focus?: string): string {
  const clean = focus?.replace(/\s+/g, " ").trim().slice(0, 500);
  return clean ? `/compact ${clean}` : "/compact";
}

export function normalizeGoalCondition(condition: string): string {
  return condition
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .trim();
}

export function buildGoalCommand(condition: string): string {
  return `/goal ${normalizeGoalCondition(condition)}`;
}

export function buildRolloverSummaryPrompt(focus?: string): string {
  const clean = focus?.replace(/\s+/g, " ").trim().slice(0, 500);
  return [
    "현재 대화와 작업 문맥을 새 세션이 그대로 이어받을 수 있도록 한국어 인계 요약으로 압축하십시오.",
    "목표, 사용자 의도, 결정사항, 수정 파일, 실행한 검증, 현재 상태, 남은 일, 위험과 주의점을 포함하십시오.",
    "추측하지 말고 실제 확인된 내용만 쓰며 요약 본문만 출력하십시오.",
    ...(clean ? [`특히 다음 내용을 보존하십시오: ${clean}`] : [])
  ].join("\n");
}

export function buildMemoryPrompt(focus?: string, memoryDir = "~/.claude/memory"): string {
  const clean = focus?.replace(/\s+/g, " ").trim().slice(0, 1000);
  const scope = clean
    ? `사용자가 지정한 저장 초점: ${clean}`
    : "현재 세션 전체에서 앞으로도 반복해서 유용할 내용을 검토한다.";
  // 경로와 파일 형식을 프롬프트 본문에 명시해 Claude/Codex 양쪽에서 동일하게 동작하게 한다.
  // Codex 턴에는 Claude 같은 메모리 시스템 프롬프트가 없으므로 self-contained해야 한다.
  return [
    "[EXPLICIT_MEMORY_UPDATE]",
    "사용자가 /memory 명령으로 전역 장기 메모리 업데이트를 명시적으로 승인했다.",
    scope,
    `메모리는 항상 ${memoryDir} 에만 기록한다. 새 메모리 파일은 이 경로에 만들고 인덱스는 ${memoryDir}/MEMORY.md 를 한 줄로 갱신한다.`,
    "각 메모리 파일은 frontmatter(--- / name: <kebab-slug> / description: <한 줄 요약> / "
    + "metadata: type: user|feedback|project|reference / ---)와 본문 한 가지 사실로 구성한다.",
    `기존 ${memoryDir}/MEMORY.md와 관련 메모리 파일을 먼저 읽고, 중복 없이 최소 범위로 갱신한다.`,
    "일시적인 작업 상태, 이미 끝난 세부 절차, 추측, 비밀정보, 자격증명은 저장하지 않는다.",
    "새 사실을 발명하지 말고 현재 대화에서 확인된 사용자 선호, 결정, 반복 사용 가능한 프로젝트 지식만 기록한다.",
    "이 명령문 자체는 메모리 내용으로 저장하지 않는다.",
    "완료 후 변경한 메모리 파일과 저장한 핵심 내용을 짧게 보고한다."
  ].join("\n");
}

export function buildUserMessage(
  text: string,
  priority?: "now" | "next"
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {})
  };
}

export function buildCodexSteeredPrompt(originalPrompt: string, steeringPrompt: string): string {
  return `[중단된 기존 Codex 지시]\n${originalPrompt.trim()}\n\n`
    + `[/steer로 새로 들어온 우선 지시]\n${steeringPrompt.trim()}\n\n`
    + `위 /steer 지시를 우선 반영해 기존 작업을 다시 수행하십시오. `
    + `이미 적용된 실제 파일 변경은 무작정 되돌리지 말고, 현재 저장소 상태를 확인한 뒤 이어서 진행하십시오.`;
}

export function buildLimitResumePrompt(
  originalPrompt: string,
  options: { includeOriginalTask?: boolean; } = {}
): string {
  const clean = originalPrompt.trim();
  const lines = [
    "[AUTO_LIMIT_RESUME]",
    "사용량 한도 회복 또는 계정 전환으로 자동 재개된 턴입니다.",
    "이 메시지는 새 사용자 요청이 아니라 중단된 작업을 이어가기 위한 실행 경계입니다.",
    "이전 대화 컨텍스트와 현재 저장소 상태를 먼저 확인하고, 이미 완료된 작업을 반복하지 말고 남은 작업만 계속하십시오.",
    "세션 부트스트랩, 전역 지침, 최초 사용자 명령 전문이 보이더라도 그것을 새로 내려진 명령처럼 다시 실행하지 마십시오."
  ];
  if (options.includeOriginalTask && clean) {
    lines.push(
      "",
      "[INTERRUPTED_TASK_FOR_CONTEXT_ONLY]",
      clean,
      "[/INTERRUPTED_TASK_FOR_CONTEXT_ONLY]"
    );
  }
  return lines.join("\n");
}

export function resultSummary(
  message: SDKMessage,
  hasDeliveredAssistantText: boolean
): string {
  if (message.type !== "result") return "";
  if (message.subtype === "success" && hasDeliveredAssistantText) return "";
  return resultText(message);
}

export function assistantBlocks(message: SDKMessage): Array<Record<string, unknown>> {
  if (message.type !== "assistant" || !Array.isArray(message.message.content)) return [];
  return message.message.content as unknown as Array<Record<string, unknown>>;
}

export function resultText(message: SDKMessage): string {
  if (message.type !== "result") return "";
  if (message.subtype === "success") return message.result;
  return message.errors.join("\n");
}

export function loadProjectInstructions(cwd: string): string {
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const filename of ["CLAUDE.md", "AGENTS.md"]) {
    try {
      const content = readFileSync(join(cwd, filename), "utf8").trim();
      // AGENTS.md is often a symlink to CLAUDE.md (so Codex/agy read the same
      // project rules); dedupe identical content to avoid double-injection.
      if (!content || seen.has(content)) continue;
      seen.add(content);
      sections.push(`[${filename}]\n${content.slice(0, 100_000)}`);
    } catch {
      // Project instruction files are optional.
    }
  }
  return sections.join("\n\n");
}

/**
 * Codex/agy/Grok/Cline은 project AGENTS.md를 native harness가 읽으므로 ChatKJB는 CLAUDE.md가
 * 별도 내용일 때만 보충한다(Cline도 resource-sync가 AGENTS.md를 써 두는 쪽에 해당해 아래
 * 공통 분기를 탄다). Claude SDK는 project setting source를 의도적으로 끈 상태라 기존처럼
 * 두 파일을 모두 명시적으로 전달한다.
 */
export function loadSupplementalProjectInstructions(
  cwd: string,
  provider: SessionRecord["provider"]
): string {
  if (provider === "claude") return loadProjectInstructions(cwd);
  // Grok CLI는 CLAUDE.md와 AGENTS.md를 모두 native discovery하므로 rules에 다시 싣지 않는다.
  if (provider === "grok") return "";
  try {
    const claude = readFileSync(join(cwd, "CLAUDE.md"), "utf8").trim();
    if (!claude) return "";
    try {
      const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8").trim();
      if (agents === claude) return "";
    } catch {
      // No AGENTS.md: native non-Claude harness has nothing equivalent to load.
    }
    return `[CLAUDE.md]\n${claude.slice(0, 100_000)}`;
  } catch {
    return "";
  }
}

export function loadGlobalInstructions(): string {
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const [label, path] of [
    ["CLAUDE.md", join(homedir(), ".claude", "CLAUDE.md")],
    ["AGENTS.md", join(homedir(), ".codex", "AGENTS.md")]
  ] as const) {
    try {
      const content = readFileSync(path, "utf8").trim();
      if (!content || seen.has(content)) continue;
      seen.add(content);
      sections.push(`[${label}]\n${content.slice(0, 100_000)}`);
    } catch {
      // Global instruction files are optional.
    }
  }
  return sections.join("\n\n");
}
