import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadItem } from "@openai/codex-sdk";
import { resultText } from "../session-prompts.js";
import { isOverloadedError, isRateLimitError } from "../session-usage.js";
import type { CodexUsageSnapshot, ProviderKind } from "../types.js";
import {
  emptyRemainingPlan,
  remainingPlanFromCounts,
  truncateSummary,
  type ProgressEvent,
  type RemainingPlan
} from "./progress-model.js";

export function agyRequestsProceed(text: string): boolean {
  return /\bProceed\b[\s\S]{0,100}(?:버튼|승인)/iu.test(text)
    || /(?:진행|승인)[\s\S]{0,50}버튼/u.test(text);
}

export function agyFailureFromLog(log: string): string | null {
  const retry = log.match(/Please retry in ([0-9.]+s)/i)?.[1];
  if (retry) {
    return `Gemini API 무료 분당 한도에 도달했습니다. 약 ${retry} 후 다시 시도하십시오.`;
  }
  const lines = log.split(/\r?\n/).filter((line) =>
    /RESOURCE_EXHAUSTED|Individual quota reached|model unreachable/i.test(line)
  );
  if (lines.length === 0) return null;
  const reset = lines.join("\n").match(/Resets in ([0-9hms]+)/i)?.[1];
  return reset
    ? `선택한 Antigravity 모델의 개인 할당량이 소진되었습니다. 초기화까지 ${reset} 남았습니다. 다른 모델로 바꾸거나 초기화 후 다시 시도하십시오.`
    : "선택한 Antigravity 모델의 개인 할당량이 소진되었습니다. 다른 모델로 바꾸거나 할당량 초기화 후 다시 시도하십시오.";
}

export function isCodexUsageSnapshot(value: unknown): value is CodexUsageSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.capturedAt === "number"
    && typeof record.model === "string"
    && typeof record.reasoning === "string"
    && typeof record.inputTokens === "number"
    && typeof record.cachedInputTokens === "number"
    && typeof record.outputTokens === "number"
    && typeof record.reasoningOutputTokens === "number"
    && typeof record.totalTokens === "number";
}

export function codexProgress(item: ThreadItem): string | null {
  return normalizeCodexItem(item)?.summary ?? null;
}

/** Normalize a Codex thread item into a cockpit ProgressEvent (+ optional plan). */
export function normalizeCodexItem(item: ThreadItem): (ProgressEvent & {
  remainingPlan?: RemainingPlan;
}) | null {
  if (item.type === "command_execution") {
    return {
      kind: "command",
      summary: `Codex 명령 완료: ${item.command.split("\n")[0]?.slice(0, 180) ?? ""}`
    };
  }
  if (item.type === "file_change") {
    const paths = item.changes.map((change) => change.path).slice(0, 4).join(", ");
    return { kind: "file", summary: `Codex 파일 변경: ${paths}` };
  }
  if (item.type === "todo_list") {
    const completed = item.items.filter((todo) => todo.completed).length;
    const items = item.items
      .filter((todo) => !todo.completed)
      .map((todo) => todo.text)
      .slice(0, 8);
    return {
      kind: "plan",
      summary: `Codex 계획 진행: ${completed}/${item.items.length}`,
      remainingPlan: remainingPlanFromCounts(completed, item.items.length, items)
    };
  }
  if (item.type === "web_search") {
    return { kind: "search", summary: `Codex 검색 완료: ${item.query.slice(0, 180)}` };
  }
  if (item.type === "mcp_tool_call") {
    return { kind: "tool", summary: `Codex MCP 완료: ${item.server}/${item.tool}` };
  }
  if (item.type === "error") {
    return { kind: "error", summary: `Codex 오류: ${item.message.slice(0, 180)}` };
  }
  return null;
}

/** Claude tool_use block → ProgressEvent. */
export function normalizeClaudeTool(
  toolName: string,
  input: Record<string, unknown> = {}
): ProgressEvent {
  const target = input.file_path ?? input.path ?? input.command ?? input.query ?? input.pattern ?? "";
  const detail = target ? String(target).slice(0, 180) : undefined;
  return {
    kind: "tool",
    summary: detail ? `${toolName}: ${detail}` : toolName
  };
}

/** Claude task/subagent lifecycle note. */
export function normalizeClaudeSubagent(label: string, phase: "start" | "end"): ProgressEvent {
  return {
    kind: "subagent",
    summary: phase === "start"
      ? `Claude 하위 작업 시작: ${truncateSummary(label, 120)}`
      : `Claude 하위 작업: ${truncateSummary(label, 120)}`
  };
}

/**
 * Provider-level degrade plan when the executor cannot expose a structured plan.
 * Same 4-pane structure is kept; plan pane is explicitly marked as limited.
 */
export function degradedPlanForProvider(provider: ProviderKind): RemainingPlan {
  const base = emptyRemainingPlan(true);
  if (provider === "grok") {
    return { ...base, label: "남은 계획 정보 없음(Grok 스트리밍 제한 · ETA 미제공)" };
  }
  if (provider === "agy") {
    return { ...base, label: "남은 계획 정보 없음(Antigravity 제한 · ETA 미제공)" };
  }
  if (provider === "cline") {
    return { ...base, label: "남은 계획 정보 없음(Cline 제한 · ETA 미제공)" };
  }
  if (provider === "codex") {
    return { ...base, label: "남은 계획 정보 없음(Codex todo 대기 · ETA 미제공)" };
  }
  return { ...base, label: "남은 계획 정보 없음(Claude plan 대기 · ETA 미제공)" };
}

/** Live-steer capability note for cockpit (provider equality via explicit degrade). */
export function steerCapabilityNote(provider: ProviderKind): string {
  if (provider === "claude") {
    return "조향: 라이브 주입(중단 없이 다음 턴 반영)";
  }
  if (provider === "codex") {
    return "조향: 현재 턴 재시작 후 우선 반영";
  }
  if (provider === "agy") {
    return "조향: 큐 주입(라이브 스트림 재작성 제한)";
  }
  if (provider === "grok") {
    return "조향: 큐 주입(글자 조각 스트림 · 라이브 불가 표기)";
  }
  return "조향: 큐 주입(Cline · 라이브 스트림 제한)";
}

export function resultFailureText(
  message: SDKMessage,
  rateLimitRejected = false
): string | null {
  if (message.type !== "result") return null;
  const text = resultText(message);
  const apiErrorStatus =
    message.subtype === "success" ? message.api_error_status : null;
  if (apiErrorStatus === 429) {
    return text || "Claude API Error: 429 rate limit";
  }
  if (apiErrorStatus != null && apiErrorStatus >= 500) {
    return text && !text.includes("[ede_diagnostic]")
      ? text
      : `Claude API Error: ${apiErrorStatus} ${apiErrorStatus === 529 ? "Overloaded" : "server error"
      }`;
  }
  if (rateLimitRejected || isRateLimitError(text) || isOverloadedError(text)) {
    return text || (rateLimitRejected ? "Claude rate limit rejected" : null);
  }
  return message.subtype === "success" ? null : text || "Claude 실행이 실패했습니다.";
}
