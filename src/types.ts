import type { PermissionMode, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { InlineKeyboard } from "grammy";

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

export type ProviderKind = "claude" | "codex" | "agy" | "grok" | "cline" | "qwen";

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
  qwenModel?: string;
  qwenReasoning?: string;
  agyModel: string;
  grokModel: string;
  grokReasoning: string;
  clineProviderId?: string;
  clineModel?: string;
  clineReasoning?: string;
  thinking: string;
  claudeEffort: string;
  codexReasoning: string;
  codexHome: string | null;
  // Claude/Codex 하위 에이전트 모델. 비어 있으면 각 CLI의 기본 상속을 사용한다.
  subagentModel?: string | null;
  // 선택한 하위 모델이 지원할 때만 적용하는 추론 강도/작업량. null이면 모델 기본값.
  subagentReasoning?: string | null;
  subagentEffort?: string | null;
  agyThinkingLevel: string;
  // 새 세션의 시작 권한 모드. 기본은 auto이며, 사용자가 명시적으로 변경할 수 있다.
  defaultPermissionMode?: PermissionMode;
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
  // 새 세션 시작 권한 모드 override. 없으면 프로젝트 defaultMode를 따른다.
  permissionMode?: PermissionMode;
  provider?: ProviderKind;
  model?: string;
  thinking?: string;
  claudeEffort?: string;
  claudeTokenIndex?: number | null;
  codexModel?: string;
  codexReasoning?: string;
  qwenModel?: string;
  qwenReasoning?: string;
  codexHome?: string | null;
  agyThinkingLevel?: string;
  agyModel?: string;
  grokModel?: string;
  grokReasoning?: string;
  clineProviderId?: string;
  clineModel?: string;
  clineReasoning?: string;
  subagentModel?: string | null;
  subagentReasoning?: string | null;
  subagentEffort?: string | null;
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

export interface CodexLiveUsageWindow {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: string | null;
}

export interface CodexLiveUsageSnapshot {
  capturedAt: number;
  planType: string | null;
  primary: CodexLiveUsageWindow | null;
  secondary: CodexLiveUsageWindow | null;
  resetCreditsAvailable: number | null;
  creditsBalance: string | null;
  rateLimitReachedType: string | null;
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  currentStreakDays: number | null;
}

export interface CodexAccountUsageSnapshot {
  accountIndex: number;
  available: boolean;
  exhaustedUntil: number | null;
  latestUsage: CodexUsageSnapshot | null;
  liveUsage?: CodexLiveUsageSnapshot | null;
  liveUsageError?: string | null;
}

/** Grok 제품별 크레딧 사용률(GrokBuild/GrokImagine/Api/GrokChat 등). */
export interface GrokProductUsage {
  product: string;
  usagePercent: number | null;
}

/** grok.com 과금 API가 돌려주는 주기·크레딧 한도 스냅샷. */
export interface GrokBillingSnapshot {
  capturedAt: number;
  creditUsagePercent: number | null;
  periodType: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  productUsage: GrokProductUsage[];
  onDemandCap: number | null;
  onDemandUsed: number | null;
  prepaidBalance: number | null;
}

/** grok CLI 헤드리스 `end` 이벤트의 토큰 사용량(0.2.99+). */
export interface GrokTokenUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
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
  // 이 세션이 어느 제공사로 턴을 실행하는지. /provider로 세션 도중에도 바꿀 수 있다.
  provider: ProviderKind;
  model: string | null;
  thinking: string | null;
  claudeEffort: string | null;
  // Claude 전용 설정. 원문 OAuth 토큰은 저장하지 않고 0-based 설정 번호만 저장한다.
  claudeTokenIndex?: number | null;
  // Codex 전용 설정. codexModel/codexReasoning은 provider="codex"일 때 사용한다.
  codexModel: string | null;
  codexReasoning: string | null;
  qwenModel?: string | null;
  qwenReasoning?: string | null;
  qwenSessionId?: string | null;
  qwenUsage?: string | null;
  // 새 세션에서만 고정하는 Claude/Codex 하위 에이전트 모델. null이면 기본 상속.
  subagentModel?: string | null;
  // 하위 에이전트의 모델별 동적 조절값. null이면 해당 모델의 기본값을 쓴다.
  subagentReasoning?: string | null;
  subagentEffort?: string | null;
  // 이 Codex 세션이 우선 사용할 CODEX_HOME. null/undefined이면 자동 선택.
  codexHome?: string | null;
  // Codex 스레드 재개 id(`~/.codex/sessions`). Claude의 sdkSessionId에 대응한다.
  codexThreadId: string | null;
  // agy 전용 설정. provider="agy"일 때 사용한다.
  agyModel: string | null;
  // Antigravity CLI 모델명의 thinking 변형(minimal/low/medium/high). null이면 선택 모델 그대로.
  agyThinkingLevel: string | null;
  // Antigravity CLI가 저장하는 대화 재개 id. codexThreadId에 대응한다.
  agyConversationId: string | null;
  // agy 대화 누적 토큰 사용량(JSON 문자열로 저장). 첫 턴 실행 전에는 null.
  agyUsage: string | null;
  /** grok 누적 토큰 사용량(GrokTokenUsage JSON). grok은 디스크에 사용량을 남기지 않아 여기 모은다. */
  grokUsage: string | null;
  // Grok CLI 전용 설정. provider="grok"일 때 사용한다.
  grokModel?: string | null;
  // Grok CLI `--reasoning-effort` 값. null이면 CLI 기본값을 사용한다.
  grokReasoning?: string | null;
  // Grok CLI 세션 재개 UUID(`grok --session-id`로 만들고 `--resume`로 잇는다).
  // codexThreadId/agyConversationId에 대응한다. 첫 턴 성공 전에는 null이며, 첫
  // 턴에서 새 UUID로 세션을 만든 뒤 저장한다. 제공사 전환·문맥 초기화 시 null로 비워
  // 다음 grok 턴이 새 세션을 만들게 한다(봇 session.id와 분리해 UUID 충돌을 피한다).
  grokSessionId?: string | null;
  // ClineCore 내부 provider/model/reasoning 및 durable SDK session 상태.
  clineProviderId?: string | null;
  clineModel?: string | null;
  clineReasoning?: string | null;
  clineSessionId?: string | null;
  clineUsage?: string | null;
  // 제공사 전환 시 직전 provider가 만든 인계 요약. 다음 턴 프롬프트에 1회 주입 후 비운다.
  handoffSummary: string | null;
  // Claude/Codex 네이티브 /goal 상태를 UI에 표시하고 세션 핸들 생성 뒤 동기화하기 위한 미러.
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
