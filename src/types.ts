import type { InlineKeyboard } from "grammy";
import type { PermissionMode, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

export type SessionStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_limit"
  | "done"
  | "verification_failed"
  | "aborted"
  | "error"
  | "interrupted";

export type ProviderKind = "claude" | "codex" | "agy";

export interface ProjectConfig {
  name: string;
  aliases?: string[];
  cwd: string;
  defaultMode: PermissionMode;
}

// /new로 만들 세션의 기본값. 상시 reply 키보드로 클릭 변경하며, 전역(단일 사용자) 1벌만 둔다.
export interface SessionDefaults {
  provider: ProviderKind;
  claudeModel: string;
  claudeTokenIndex: number;
  codexModel: string;
  agyModel: string;
  thinking: string;
  claudeEffort: string;
  codexReasoning: string;
  codexHome: string | null;
  agyThinkingLevel: string;
}

export interface UsageWindow {
  utilization: number | null;
  resetsAt: string | null;
}

export interface ExtraUsage {
  /** 오버에이지(추가 사용 과금)가 활성화되어 있는지. */
  isEnabled: boolean;
  utilization: number | null;
  usedCredits: number | null;
  monthlyLimit: number | null;
  currency: string | null;
}

export interface UsageSnapshot {
  capturedAt: number;
  subscriptionType: string | null;
  rateLimitsAvailable: boolean;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  sevenDaySonnet?: UsageWindow;
  /** seven_day_oauth_apps — Agent SDK/프로그래매틱 호출의 주간 한도. */
  agentSdkWeekly?: UsageWindow;
  /** extra_usage — 한도 초과 시 사용하는 오버에이지 크레딧(있을 때만). */
  extraUsage?: ExtraUsage;
}

export type ReservedTaskStatus = "pending" | "running" | "done" | "error" | "canceled";

export interface ReservedTaskStartOptions {
  provider?: ProviderKind;
  model?: string;
  thinking?: string;
  claudeEffort?: string;
  claudeTokenIndex?: number | null;
  codexModel?: string;
  codexReasoning?: string;
  codexHome?: string | null;
  agyThinkingLevel?: string;
  agyModel?: string;
  leanMode?: boolean;
}

export interface ReservedTaskRecord {
  id: string;
  chatId: number;
  projectName: string;
  prompt: string;
  dueAt: number;
  status: ReservedTaskStatus;
  errorMessage: string | null;
  topicId: number | null;
  sessionId: string | null;
  startOptions: ReservedTaskStartOptions;
  createdAt: number;
  updatedAt: number;
}

export interface CodexUsageSnapshot {
  capturedAt: number;
  model: string;
  reasoning: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexAccountUsageSnapshot {
  accountIndex: number;
  available: boolean;
  exhaustedUntil: number | null;
  latestUsage: CodexUsageSnapshot | null;
}

export interface SessionRecord {
  id: string;
  sdkSessionId: string | null;
  chatId: number;
  topicId: number;
  projectName: string;
  cwd: string;
  title: string;
  status: SessionStatus;
  permissionMode: PermissionMode;
  // 이 세션이 어느 제공사로 턴을 실행하는지. /model로 세션 도중에도 바꿀 수 있다.
  provider: ProviderKind;
  model: string | null;
  thinking: string | null;
  claudeEffort: string | null;
  // Claude 전용 설정. 원문 OAuth 토큰은 저장하지 않고 0-based 설정 번호만 저장한다.
  claudeTokenIndex?: number | null;
  // Codex 전용 설정. codexModel/codexReasoning은 provider="codex"일 때 사용한다.
  codexModel: string | null;
  codexReasoning: string | null;
  // 이 Codex 세션이 우선 사용할 CODEX_HOME. null/undefined이면 자동 선택.
  codexHome?: string | null;
  // Codex 스레드 재개 id(`~/.codex/sessions`). Claude의 sdkSessionId에 대응한다.
  codexThreadId: string | null;
  // agy 전용 설정. provider="agy"일 때 사용한다.
  agyModel: string | null;
  // GeminiModelOptions.thinking_level(minimal/low/medium/high). null이면 API 기본(레벨 미지정).
  agyThinkingLevel: string | null;
  // Antigravity SDK가 저장하는 대화 재개 id. codexThreadId에 대응한다.
  agyConversationId: string | null;
  // agy 대화 누적 토큰 사용량(JSON 문자열로 저장). 첫 턴 실행 전에는 null.
  agyUsage: string | null;
  // 제공사 전환 시 직전 provider가 만든 인계 요약. 다음 턴 프롬프트에 1회 주입 후 비운다.
  handoffSummary: string | null;
  // 활성 목표 조건. 설정되면 한 턴이 끝날 때마다 충족 여부를 평가하고, 미충족이면
  // 자동으로 다음 턴을 이어 간다(/goal). null이면 목표 자동 진행 없음.
  goalCondition: string | null;
  leanMode: boolean;
  usageSnapshot: UsageSnapshot | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApprovalRecord {
  nonce: string;
  toolUseId: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  status: "pending" | "allowed" | "denied" | "expired";
  expiresAt: number;
  messageId: number | null;
}

export interface MessageTransport {
  sendText(chatId: number, topicId: number, text: string, keyboard?: InlineKeyboard): Promise<number>;
  editText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void>;
  createTopic(chatId: number, title: string): Promise<number>;
  renameTopic(chatId: number, topicId: number, title: string): Promise<void>;
  deleteTopic(chatId: number, topicId: number): Promise<void>;
  sendDocument(chatId: number, topicId: number, filename: string, content: string, caption?: string): Promise<void>;
  sendChatAction(chatId: number, topicId: number, action: string): Promise<void>;
  sendFile(chatId: number, topicId: number, filePath: string, caption?: string): Promise<void>;
}
