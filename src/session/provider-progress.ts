import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadItem } from "@openai/codex-sdk";
import { resultText } from "../session-prompts.js";
import { isOverloadedError, isRateLimitError } from "../session-usage.js";
import type { CodexUsageSnapshot } from "../types.js";

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
  if (item.type === "command_execution") {
    return `Codex 명령 완료: ${item.command.split("\n")[0]?.slice(0, 180) ?? ""}`;
  }
  if (item.type === "file_change") {
    const paths = item.changes.map((change) => change.path).slice(0, 4).join(", ");
    return `Codex 파일 변경: ${paths}`;
  }
  if (item.type === "todo_list") {
    const completed = item.items.filter((todo) => todo.completed).length;
    return `Codex 계획 진행: ${completed}/${item.items.length}`;
  }
  if (item.type === "web_search") return `Codex 검색 완료: ${item.query.slice(0, 180)}`;
  if (item.type === "mcp_tool_call") return `Codex MCP 완료: ${item.server}/${item.tool}`;
  if (item.type === "error") return `Codex 오류: ${item.message.slice(0, 180)}`;
  return null;
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
