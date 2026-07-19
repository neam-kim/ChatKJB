import { appLocale, appTimeZone } from "../localization.js";
import {
  agyModelLabel,
  agyThinkingLabel,
  claudeEffortLabel,
  codexModelLabel,
  codexReasoningLabel,
  DEFAULT_AGY_MODEL,
  DEFAULT_AGY_THINKING_LEVEL,
  DEFAULT_CLAUDE_EFFORT,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING,
  DEFAULT_GROK_MODEL,
  DEFAULT_THINKING_LEVEL,
  FALLBACK_MODEL_CATALOG,
  grokModelLabel,
  grokReasoningLabel,
  type ModelCatalog,
  modelLabel,
  thinkingLabel
} from "../model-catalog.js";
import type { ProviderKind, ReservedTaskRecord, SessionRecord } from "../types.js";
import { selectedClaudeTokenIndex } from "./pending-keys.js";

export function topicTitle(project: string, prompt: string): string {
  const summary = prompt.replace(/\s+/g, " ").trim().slice(0, 70);
  return `${project} - ${summary || "새 작업"}`;
}

export function topicLink(chatId: number, topicId: number): string {
  return `https://t.me/c/${String(chatId).replace(/^-100/, "")}/${topicId}`;
}

export function displayDriveLabel(rawLabel: string): string {
  const label = rawLabel.trim().replace(/\s+/g, " ");
  const cloudStorageMatch = /^(SynologyDrive|GoogleDrive|OneDrive|Dropbox|Box)(?:[-_ ].*)?$/i.exec(label);
  if (!cloudStorageMatch) return label || "드라이브";
  const canonical = cloudStorageMatch[1]!;
  if (/^googledrive$/i.test(canonical)) return "GoogleDrive";
  if (/^onedrive$/i.test(canonical)) return "OneDrive";
  if (/^synologydrive$/i.test(canonical)) return "SynologyDrive";
  if (/^dropbox$/i.test(canonical)) return "Dropbox";
  if (/^box$/i.test(canonical)) return "Box";
  return canonical;
}

export function statusLabel(session: SessionRecord): string {
  return session.status;
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(appLocale(), {
    timeZone: appTimeZone(),
    hour12: false
  });
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}시간 ${minutes}분 ${remainder}초`
    : minutes > 0
      ? `${minutes}분 ${remainder}초`
      : `${remainder}초`;
}

export function formatReservedTaskLine(task: ReservedTaskRecord): string {
  const prompt = task.prompt.replace(/\s+/g, " ").trim().slice(0, 80);
  return `${task.projectName} · ${formatTimestamp(task.dueAt)}\n${prompt}`;
}

export function codexAccountLabel(
  codexHome: string | null | undefined,
  codexAccountHomes: readonly string[]
): string | null {
  if (!codexHome) return null;
  const accountIndex = codexAccountHomes.findIndex((home) => home === codexHome);
  return accountIndex >= 0
    ? `Codex 계정: #${accountIndex + 1}`
    : "Codex 계정: 지정됨";
}

export function formatSessionStatus(
  session: SessionRecord,
  active: boolean,
  catalog: ModelCatalog = FALLBACK_MODEL_CATALOG,
  codexAccountHomes: readonly string[] = [],
  claudeTokenCount = 1
): string {
  const state = session.status === "waiting_approval"
    ? "승인 대기 중"
    : session.status === "waiting_limit"
      ? "한도 회복 대기 중 (회복 시 자동 재개)"
      : session.status === "verification_failed"
        ? "완료 검증 실패"
        : active
          ? "실행 중"
          : session.status === "queued"
            ? "대기 중"
            : "실행 중인 작업 없음";
  const codexAccount = codexAccountLabel(session.codexHome, codexAccountHomes);
  const claudeTokenIndex = selectedClaudeTokenIndex(session.claudeTokenIndex, claudeTokenCount);
  const providerLines = session.provider === "codex"
    ? [
      "제공자: Codex",
      `Codex 모델: ${codexModelLabel(catalog, session.codexModel ?? DEFAULT_CODEX_MODEL)} · reasoning ${codexReasoningLabel(session.codexReasoning ?? DEFAULT_CODEX_REASONING)}`,
      ...(codexAccount ? [codexAccount] : [])
    ]
    : session.provider === "agy"
      ? [
        "제공자: Antigravity",
        `Antigravity 모델: ${agyModelLabel(catalog, session.agyModel ?? DEFAULT_AGY_MODEL)}`,
        `Antigravity 추론 강도: ${agyThinkingLabel(session.agyThinkingLevel ?? DEFAULT_AGY_THINKING_LEVEL)}`,
        "MCP: ~/.gemini/config/mcp_config.json"
      ]
      : session.provider === "grok"
        ? [
          "제공자: Grok",
          `Grok 모델: ${grokModelLabel(catalog, session.grokModel ?? DEFAULT_GROK_MODEL)}`,
          `Grok 추론 강도: ${grokReasoningLabel(session.grokReasoning)}`
        ]
        : [
          "제공자: Claude",
          `모델: ${modelLabel(catalog, session.model ?? DEFAULT_CLAUDE_MODEL)}`,
          `thinking: ${thinkingLabel(session.thinking ?? DEFAULT_THINKING_LEVEL)}`,
          `Claude 작업량: ${claudeEffortLabel(session.claudeEffort ?? DEFAULT_CLAUDE_EFFORT)}`,
          ...(claudeTokenCount > 1 && claudeTokenIndex >= 0 ? [`Claude 토큰: #${claudeTokenIndex + 1}`] : [])
        ];
  return [
    "오케스트레이터: 정상 응답",
    `작업: ${state}`,
    `저장 상태: ${session.status}`,
    `프로젝트: ${session.projectName}`,
    ...providerLines,
    `권한 모드: ${session.permissionMode}`,
    `lean: ${session.leanMode ? "on" : "off"}`,
    ...(session.goalCondition && (session.provider === "claude" || session.provider === "codex")
      ? [`목표(제공자 native): ${session.goalCondition}`]
      : []),
    `마지막 상태 변경: ${formatTimestamp(session.updatedAt)}`
  ].join("\n");
}

// 새 세션 기본값을 보여주는 상시 reply 키보드(ChatKJB식). 좌상 라벨, 우상 모델,
// 좌하 제공자, 우하 thinking(Claude) 또는 추론 강도(Codex).
export function providerDisplayLabel(provider: ProviderKind): string {
  if (provider === "codex") return "Codex";
  if (provider === "agy") return "Antigravity";
  if (provider === "grok") return "Grok";
  return "Claude";
}
