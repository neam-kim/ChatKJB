import type { InlineKeyboard } from "grammy";
import type { PermissionMode, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

export type SessionStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "done"
  | "verification_failed"
  | "aborted"
  | "error"
  | "interrupted";

export type PlanRunStatus =
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "reviewing"
  | "passed"
  | "failed"
  | "rejected"
  | "aborted"
  | "interrupted";

export type PlanCriterionStatus = "pending" | "pass" | "fail" | "blocked";

export type PlanEvidenceKind =
  | "command"
  | "file_change"
  | "todo"
  | "mcp"
  | "web_search"
  | "agent_result"
  | "git_status"
  | "git_diff"
  | "review"
  | "error";

export interface PlanRunRecord {
  id: string;
  sessionId: string;
  instruction: string;
  planText: string;
  status: PlanRunStatus;
  reviewerVerdict: "APPROVE" | "REJECT" | null;
  reviewText: string | null;
  codexResult: string | null;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface PlanCriterionRecord {
  id: string;
  planRunId: string;
  ordinal: number;
  description: string;
  status: PlanCriterionStatus;
  evidenceSummary: string | null;
  updatedAt: number;
}

export interface PlanEvidenceRecord {
  id: string;
  planRunId: string;
  criterionId: string | null;
  kind: PlanEvidenceKind;
  source: "codex" | "claude" | "orchestrator";
  summary: string;
  details: Record<string, unknown>;
  createdAt: number;
}

export interface ProjectConfig {
  name: string;
  aliases?: string[];
  cwd: string;
  defaultMode: PermissionMode;
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
  model: string | null;
  thinking: string | null;
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
