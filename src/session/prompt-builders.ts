import type { EffortLevel, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import {
  buildLimitResumePrompt,
  buildOrchestratedTurnPrompt,
  buildProviderBootstrap
} from "../session-prompts.js";
import type { ProviderKind, SessionRecord } from "../types.js";

export function resolveThinkingConfig(level: string | null | undefined): ThinkingConfig {
  switch (level) {
    case "off":
      return { type: "disabled" };
    case "adaptive":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    default:
      return { type: "adaptive" };
  }
}

export function resolveClaudeEffort(level: string | null | undefined): EffortLevel | undefined {
  switch (level) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return level;
    default:
      return undefined;
  }
}

export interface RunRequest {
  session: SessionRecord;
  prompt: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  operation?: "prompt" | "compact" | "goal_native" | "native_command";
  // 자동 한도 재시도/재개에서는 원 사용자 프롬프트를 새 명령처럼 다시 넣지 않고,
  // 재개 경계 프롬프트로 치환한다. originalPrompt는 컨텍스트가 유실된 경우에만 함께 보낸다.
  limitResume?: {
    originalPrompt: string;
    includeOriginalTask: boolean;
  };
  // 한도 오류로 다른 계정 토큰에 자동 전환해 재실행한 횟수. 무한 전환을 막는 가드.
  autoSwitchCount?: number;
  // 한도 회복 자동 재개 때 저장된 Codex 홈에 고정하지 않고 다음 사용 가능 홈부터 순환 탐색한다.
  codexRotateOnStart?: boolean;
  // 일시적 과부하(Overloaded/5xx)로 백오프 후 자동 재시도한 횟수. 무한 재시도를 막는 가드.
  retryCount?: number;
  // Claude 재개 프로세스가 SDK result 없이 즉시 종료될 때 문맥을 fork해 복구한 횟수.
  // 원본 세션이 손상되어도 무한 반복하지 않도록 Claude 실행기가 1회로 제한한다.
  claudeEmptyStreamRecoveryCount?: number;
  // Codex rollout 유실(no rollout found)로 스레드를 버리고 새 스레드로 재실행한 횟수. 무한 루프 가드.
  rolloutResetCount?: number;
}

export function limitResumeRequest(
  request: RunRequest,
  includeOriginalTask: boolean
): RunRequest {
  return {
    ...request,
    limitResume: {
      originalPrompt: request.limitResume?.originalPrompt ?? request.prompt,
      includeOriginalTask: request.limitResume?.includeOriginalTask || includeOriginalTask
    }
  };
}

export function providerLabel(provider: ProviderKind): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "grok") return "Grok";
  return "Antigravity";
}

export function promptForRequest(request: RunRequest): string {
  if (!request.limitResume) return request.prompt;
  return buildLimitResumePrompt(request.limitResume.originalPrompt, {
    includeOriginalTask: request.limitResume.includeOriginalTask
  });
}

export function promptForClaudeRequest(request: RunRequest): string {
  const prompt = promptForRequest(request);
  if (request.operation === "compact" || request.operation === "goal_native" || request.operation === "native_command") {
    return prompt;
  }
  // claude_code preset이 현재 날짜를 이미 제공하므로 user turn에는 중복하지 않는다.
  return buildOrchestratedTurnPrompt(prompt, { includeDate: false });
}

export function promptForCodexRequest(request: RunRequest): string {
  const prompt = promptForRequest(request);
  return request.operation === "native_command" ? prompt : buildOrchestratedTurnPrompt(prompt);
}

export function buildClaudeSystemPromptAppend(
  session: SessionRecord,
  opts: { mcpMaxAttempts: number; claudeMemoryDir: string; }
): string {
  return buildProviderBootstrap(session, opts.claudeMemoryDir, {
    // claude_code preset이 날짜와 user-scope CLAUDE.md를 이미 제공한다.
    includeDate: false,
    prefixSections: [
      `MCP 도구가 timeout, connection closed 또는 transport 오류로 실패하면 `
      + `호스트의 MCP_RETRY 지시에 따라 같은 입력을 순차적으로 최대 `
      + `${opts.mcpMaxAttempts}회까지만 재시도한다. 병렬 재시도하지 않는다.`
    ]
  });
}
