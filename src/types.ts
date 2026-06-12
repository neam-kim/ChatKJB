import type { InlineKeyboard } from "grammy";
import type { PermissionMode, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

export type SessionStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "done"
  | "aborted"
  | "error"
  | "interrupted";

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

export interface UsageSnapshot {
  capturedAt: number;
  subscriptionType: string | null;
  rateLimitsAvailable: boolean;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  sevenDaySonnet?: UsageWindow;
  agentSdkLegacy?: UsageWindow;
  agentSdkCredit?: UsageWindow & {
    usedCredits: number | null;
    monthlyLimit: number | null;
    currency: string | null;
  };
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
