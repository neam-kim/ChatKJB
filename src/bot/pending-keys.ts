import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectConfig, ProviderKind, SessionDefaults } from "../types.js";

export interface PendingStartOptions {
  resumeSessionId?: string;
  forkSession?: boolean;
  // 새 세션 시작 권한 모드 override. 없으면 프로젝트 defaultMode를 따른다.
  // 현재는 Cline 새 세션이 General 패널의 Plan/Act 토글값을 여기로 넘긴다.
  permissionMode?: PermissionMode | undefined;
  provider?: ProviderKind | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  claudeEffort?: string | undefined;
  claudeTokenIndex?: number | null | undefined;
  codexModel?: string | undefined;
  codexReasoning?: string | undefined;
  subagentModel?: string | null | undefined;
  codexHome?: string | null | undefined;
  agyThinkingLevel?: string | undefined;
  agyModel?: string | undefined;
  grokModel?: string | undefined;
  grokReasoning?: string | undefined;
  clineProviderId?: string | undefined;
  clineModel?: string | undefined;
  clineReasoning?: string | undefined;
  handoffSummary?: string | undefined;
  leanMode?: boolean | undefined;
}

export type PendingStart = PendingStartOptions & (
  | { kind: "project"; project: ProjectConfig; pendingTopicId?: number; }
  | { kind: "auto-project"; selectionDefaults: SessionDefaults; pendingTopicId: number; }
);

export function pendingStartKey(userId: number, topicId?: number): string {
  return `${userId}:${topicId ?? "general"}`;
}

export function parseTokenId(input: string): number | null {
  const value = Number.parseInt(input.trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function selectedCodexAccountIndex(
  codexHome: string | null | undefined,
  codexAccountHomes: readonly string[]
): number {
  if (codexAccountHomes.length === 0) return -1;
  if (!codexHome) return 0;
  const index = codexAccountHomes.findIndex((home) => home === codexHome);
  return index >= 0 ? index : 0;
}

export function selectedClaudeTokenIndex(
  claudeTokenIndex: number | null | undefined,
  claudeTokenCount: number
): number {
  if (claudeTokenCount <= 0) return -1;
  if (typeof claudeTokenIndex !== "number" || !Number.isInteger(claudeTokenIndex)) return 0;
  return claudeTokenIndex >= 0 && claudeTokenIndex < claudeTokenCount ? claudeTokenIndex : 0;
}

// 새 세션 기본값을 PendingStart 필드로 변환한다. provider에 따라 해당 제공자 설정만 채운다.
export function pendingFieldsFromDefaults(defaults: SessionDefaults): Partial<PendingStartOptions> {
  if (defaults.provider === "codex") {
    return {
      provider: "codex",
      codexModel: defaults.codexModel,
      codexReasoning: defaults.codexReasoning,
      codexHome: defaults.codexHome,
      subagentModel: defaults.subagentModel ?? null,
      leanMode: true
    };
  }
  if (defaults.provider === "agy") {
    return {
      provider: "agy",
      agyThinkingLevel: defaults.agyThinkingLevel,
      agyModel: defaults.agyModel,
      leanMode: true
    };
  }
  if (defaults.provider === "grok") {
    return {
      provider: "grok",
      grokModel: defaults.grokModel,
      grokReasoning: defaults.grokReasoning,
      leanMode: true
    };
  }
  if (defaults.provider === "cline") {
    return {
      provider: "cline",
      clineProviderId: defaults.clineProviderId ?? "",
      clineModel: defaults.clineModel ?? "",
      clineReasoning: defaults.clineReasoning ?? "off",
      // General 패널의 Plan/Act 토글값. 미설정이면 undefined로 두어 프로젝트 defaultMode를 따른다.
      ...(defaults.defaultPermissionMode ? { permissionMode: defaults.defaultPermissionMode } : {}),
      leanMode: true
    };
  }
  return {
    provider: "claude",
    model: defaults.claudeModel,
    thinking: defaults.thinking,
    claudeEffort: defaults.claudeEffort,
    claudeTokenIndex: defaults.claudeTokenIndex,
    subagentModel: defaults.subagentModel ?? null,
    leanMode: true
  };
}
