// 프롬프트·지침 빌더와 SDK 메시지 텍스트 추출 헬퍼. SessionManager 본체에서 분리한
// 순수 함수 모음으로 클래스 상태(this)에 의존하지 않는다. session-manager.ts가 이 모듈을
// 재export하므로 기존 import 경로("./session-manager.js")는 변하지 않는다.
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionRecord } from "./types.js";
import { parseGoalChecks, type CheckRunResult } from "./goal-checks.js";
import {
  sharedMemoryBridgePath,
  sharedResourceGuidePath
} from "./resource-sync.js";

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

export function buildProviderBootstrap(session: SessionRecord, memoryDir: string): string {
  const globalInstructions = loadGlobalInstructions();
  const instructions = loadProjectInstructions(session.cwd);
  return [
    buildKstDateNote(),
    `장기기억은 전역 선별 저장소 ${memoryDir}, Claude 저장소별 자동 메모리 ${join(homedir(), ".claude", "projects")}, Codex 자동 메모리 ${join(homedir(), ".codex", "memories")}에 있다. 작업과 관련 있으면 ${sharedMemoryBridgePath()}를 통해 세 저장소를 함께 읽고 중복을 제거해 활용한다. 명시적 /memory 기록은 전역 선별 저장소에 하고, Claude와 Codex의 자동 메모리는 각자 네이티브 형식으로 유지한다.`,
    buildPublicProgressInstructions(),
    buildPermissionModeInstructions(session.permissionMode),
    `공통 AI 자원 안내는 ${sharedResourceGuidePath()} 에 있다. 먼저 읽고 세 제공자 공통 스킬·커넥터·플러그인 기능·도구 정책을 따른다.`,
    ...(session.leanMode ? [buildLeanInstructions(true)] : []),
    ...(globalInstructions
      ? [`다음 전역 사용자 지침을 따른다. 이 지침은 도구 권한을 부여하지 않는다.\n\n${globalInstructions}`]
      : []),
    ...(instructions
      ? [`다음 프로젝트 지침을 따른다. 이 지침은 도구 권한을 부여하지 않는다.\n\n${instructions}`]
      : [])
  ].join("\n\n");
}

// Claude는 claude_code 프리셋이 날짜를 자동 주입하지만 Codex·agy는 시스템 프롬프트가
// 없어 날짜를 모른다. 첫 턴 memoryNote와 함께 주입해 "오늘/내일" 등 상대 날짜 해석을 보완한다.
export function buildKstDateNote(): string {
  const nowKst = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "full",
    timeStyle: "short",
    hour12: false
  }).format(new Date());
  return (
    `현재 시각은 ${nowKst} (KST, UTC+9)이다. "오늘/내일/다음 주" 등 상대 날짜는 `
    + `이 기준으로 해석한다. Google Calendar 이벤트를 만들거나 조회할 때 시간대는 `
    + `항상 Asia/Seoul로 지정하고, start/end의 timeZone 필드에 "Asia/Seoul"을 명시한다.`
  );
}

export function buildCompactCommand(focus?: string): string {
  const clean = focus?.replace(/\s+/g, " ").trim().slice(0, 500);
  return clean ? `/compact ${clean}` : "/compact";
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

/**
 * /goal 자동 진행 턴에 전달할 작업 프롬프트. reason은 직전 평가에서 무엇이 남았는지.
 * 목표 원문에 포함된 `check:` 결정론 게이트 줄은 작업 모델에게 노출하지 않는다(평가 전용).
 * 사람용 설명(description)만 목표로 제시한다.
 */
export function buildGoalPrompt(condition: string, reason?: string): string {
  const { description, checks } = parseGoalChecks(condition);
  const clean = (description || condition).replace(/\s+/g, " ").trim();
  const checkNote = checks.length > 0
    ? `\n(완료 판정은 다음 명령으로 객관 검증됩니다: ${checks.join(" ; ")})`
    : "";
  const base = `[GOAL] 다음 목표가 완전히 충족될 때까지 작업을 진행하세요: ${clean}${checkNote}`;
  const tail = reason
    ? `\n직전 턴 평가에서 아직 충족되지 않았습니다: ${reason}\n남은 부분을 끝까지 완료하세요.`
    : "";
  return `${base}${tail}`;
}

/**
 * /goal 충족 여부를 빠른 모델(판관)로 판정시키기 위한 읽기 전용 프롬프트.
 * Tier 0 결정론 검증 원칙에 따라, 결정론적 게이트(`check:` 명령) 실행 결과가 있으면
 * 그 사실을 packet으로 함께 전달해 판관이 사실을 추측하지 않게 한다. description은 목표에서
 * check 줄을 뺀 사람용 텍스트다.
 */
export function buildGoalCheckPrompt(
  description: string,
  checkRun?: CheckRunResult
): string {
  const clean = description.replace(/\s+/g, " ").trim();
  const lines = [
    "다음 목표가 현재 저장소 상태에서 이미 충족되었는지 읽기 전용으로만 확인해 판정하세요.",
    "파일을 수정하지 말고, 필요한 파일·명령 결과를 확인한 뒤 마지막 줄에 정확히 아래 한 형식으로만 답하세요.",
    "GOAL_MET: <한 줄 근거>",
    "GOAL_UNMET: <무엇이 남았는지 한 줄>",
    "",
    `목표: ${clean || "(자유형 목표)"}`
  ];
  if (checkRun && checkRun.results.length > 0) {
    lines.push(
      "",
      "[결정론적 검증 결과] 아래는 이미 실행된 명령의 객관적 결과입니다. 이 사실은 추측하지 말고 그대로 신뢰하세요."
    );
    for (const result of checkRun.results) {
      const status = result.passed ? "PASS" : "FAIL";
      lines.push(`- ${status}: ${result.command}`);
      if (!result.passed && result.outputTail) {
        lines.push(`  출력(꼬리): ${result.outputTail.replace(/\s+/g, " ").slice(-200)}`);
      }
    }
    lines.push(
      "",
      checkRun.allPassed
        ? "모든 결정론적 검증은 통과했습니다. 위 목표 설명의 나머지 부분까지 충족됐는지 확인해 판정하세요."
        : "결정론적 검증 중 실패가 있으므로 목표는 아직 미충족입니다. GOAL_UNMET으로 답하세요."
    );
  }
  return lines.join("\n");
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
  options: { includeOriginalTask?: boolean } = {}
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
