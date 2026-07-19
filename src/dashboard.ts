import { execFileSync } from "node:child_process";
import { appLocale, appTimeZone } from "./localization.js";
import type {
  ProviderKind,
  ReservedTaskRecord,
  SessionRecord,
  SessionStatus,
  UsageSnapshot
} from "./types.js";
import { formatUsageSnapshot } from "./usage.js";

export type DashboardTaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_limit"
  | "blocked"
  | "needs_user"
  | "done"
  | "error"
  | "aborted";

export interface DashboardInspection {
  sessionId: string;
  startedAt: number;
  pendingTurns: number;
  codexInFlight: boolean;
  codexElapsedMs: number | null;
}

export interface DashboardTaskCard {
  id: string;
  source: "session" | "reserved_task";
  title: string;
  projectName: string;
  cwd: string | null;
  topicId: number | null;
  provider: ProviderKind | null;
  model: string | null;
  status: DashboardTaskStatus;
  startedAt: number | null;
  updatedAt: number;
  pendingTurns: number;
  branch: string | null;
  usageText: string | null;
  waitingReason: string | null;
  nextAction: string;
  topicUrl: string | null;
  activeDetail: string | null;
}

export interface DashboardBuildOptions {
  sessions: SessionRecord[];
  inspections: DashboardInspection[];
  reservedTasks?: ReservedTaskRecord[];
  now?: number;
  includeRecentDone?: boolean;
}

export interface RunningStatusInput {
  session: SessionRecord;
  status: "queued" | "running";
  startedAt: number;
  now?: number;
  pendingTurns?: number;
  branch?: string | null;
  usageSnapshot?: UsageSnapshot | null;
  recentActivity?: string;
  partialPreview?: string;
}

const ACTIVE_STATUSES = new Set<SessionStatus>([
  "queued",
  "running",
  "waiting_approval",
  "waiting_limit",
  "verification_failed"
]);

const TERMINAL_RECENT_LIMIT = 5;

export function buildDashboardCards(options: DashboardBuildOptions): DashboardTaskCard[] {
  const inspectionsBySession = new Map(
    options.inspections.map((inspection) => [inspection.sessionId, inspection])
  );
  const cards: DashboardTaskCard[] = [];
  let recentDone = 0;

  for (const session of options.sessions) {
    const inspection = inspectionsBySession.get(session.id);
    const shouldShow = inspection
      || ACTIVE_STATUSES.has(session.status)
      || (options.includeRecentDone === true && recentDone < TERMINAL_RECENT_LIMIT);
    if (!shouldShow) continue;
    if (!inspection && !ACTIVE_STATUSES.has(session.status)) recentDone += 1;
    cards.push(sessionToDashboardCard(session, inspection));
  }

  for (const task of options.reservedTasks ?? []) {
    if (task.status !== "pending" && task.status !== "running") continue;
    cards.push(reservedTaskToDashboardCard(task));
  }

  return cards.sort(compareDashboardCards);
}

export function sessionToDashboardCard(
  session: SessionRecord,
  inspection: DashboardInspection | undefined
): DashboardTaskCard {
  const status = normalizeSessionStatus(session.status, !!inspection);
  const activeDetail = inspection?.codexInFlight && inspection.codexElapsedMs !== null
    ? `Codex 실행 ${formatShortDuration(inspection.codexElapsedMs)}`
    : null;
  return {
    id: session.id,
    source: "session",
    title: session.title,
    projectName: session.projectName,
    cwd: session.cwd,
    topicId: session.topicId,
    provider: session.provider,
    model: modelForSession(session),
    status,
    startedAt: inspection?.startedAt ?? null,
    updatedAt: session.updatedAt,
    pendingTurns: inspection?.pendingTurns ?? 0,
    branch: readGitBranch(session.cwd),
    usageText: session.usageSnapshot ? compactUsageText(session.usageSnapshot) : null,
    waitingReason: inferWaitingReason(session.status, !!inspection, activeDetail),
    nextAction: inferNextAction(session.status, !!inspection),
    topicUrl: topicUrl(session.chatId, session.topicId),
    activeDetail
  };
}

export function reservedTaskToDashboardCard(task: ReservedTaskRecord): DashboardTaskCard {
  return {
    id: task.id,
    source: "reserved_task",
    title: task.prompt.replace(/\s+/g, " ").trim().slice(0, 90) || "예약 작업",
    projectName: task.projectName,
    cwd: null,
    topicId: task.topicId,
    provider: task.startOptions.provider ?? null,
    model: task.startOptions.model ?? task.startOptions.codexModel ?? task.startOptions.agyModel ?? null,
    status: task.status === "running" ? "running" : "queued",
    startedAt: null,
    updatedAt: task.updatedAt,
    pendingTurns: 0,
    branch: null,
    usageText: null,
    waitingReason: task.status === "running"
      ? "예약 작업을 세션으로 시작하는 중"
      : `예약 시각: ${formatLocalTimestamp(task.dueAt)}`,
    nextAction: task.status === "running" ? "세션 생성 완료 대기" : "취소하려면 /cancel",
    topicUrl: task.topicId ? topicUrl(task.chatId, task.topicId) : null,
    activeDetail: null
  };
}

export function formatDashboardCard(card: DashboardTaskCard, now: number = Date.now()): string {
  const lines = [
    `[${statusLabel(card.status)}] ${providerLabel(card.provider)} · ${card.projectName}`,
    `작업: ${card.title}`
  ];
  if (card.branch) lines.push(`브랜치: ${card.branch}`);
  if (card.model) lines.push(`모델: ${card.model}`);
  const elapsed = card.startedAt ? `경과: ${formatShortDuration(now - card.startedAt)}` : null;
  const queue = card.pendingTurns > 0 ? `대기 턴: ${card.pendingTurns}` : null;
  const stateDetails = [elapsed, queue, card.activeDetail].filter(Boolean).join(" · ");
  if (stateDetails) lines.push(stateDetails);
  if (card.usageText) lines.push(`사용량: ${card.usageText}`);
  if (card.waitingReason) lines.push(`대기 사유: ${card.waitingReason}`);
  lines.push(`다음 액션: ${card.nextAction}`);
  if (card.topicUrl) lines.push(`토픽: ${card.topicUrl}`);
  return lines.join("\n");
}

export function formatDashboard(cards: DashboardTaskCard[], now: number = Date.now()): string {
  if (cards.length === 0) {
    return "ChatKJB 작업판\n현재 표시할 작업이 없습니다.";
  }
  return ["ChatKJB 작업판", ...cards.map((card) => formatDashboardCard(card, now))].join("\n\n");
}

export function formatRunningStatus(input: RunningStatusInput): string {
  const now = input.now ?? Date.now();
  const usageText = input.usageSnapshot ? compactUsageText(input.usageSnapshot) : null;
  const card: DashboardTaskCard = {
    id: input.session.id,
    source: "session",
    title: input.session.title,
    projectName: input.session.projectName,
    cwd: input.session.cwd,
    topicId: input.session.topicId,
    provider: input.session.provider,
    model: modelForSession(input.session),
    status: input.status,
    startedAt: input.startedAt,
    updatedAt: input.session.updatedAt,
    pendingTurns: input.pendingTurns ?? 0,
    branch: input.branch ?? null,
    usageText,
    waitingReason: input.status === "queued" ? "같은 프로젝트의 앞선 작업 대기" : "응답 생성 중",
    nextAction: input.status === "queued" ? "대기 취소는 /stop" : "완료 대기 또는 /steer",
    topicUrl: null,
    activeDetail: input.recentActivity || null
  };
  const preview = input.partialPreview
    ? `\n\n${truncate(input.partialPreview, 1200, "tail")}`
    : "";
  return `${formatDashboardCard(card, now)}${preview}`;
}

export function inferWaitingReason(
  status: SessionStatus,
  active: boolean,
  activeDetail: string | null = null
): string | null {
  if (activeDetail) return activeDetail;
  if (active) return "응답 생성 중";
  if (status === "queued") return "같은 프로젝트의 앞선 작업 대기";
  if (status === "waiting_approval") return "사용자 승인 필요";
  if (status === "waiting_limit") return "한도 회복 대기";
  if (status === "verification_failed") return "완료 검증 실패";
  if (status === "error") return "오류로 중단됨";
  if (status === "aborted" || status === "interrupted") return "중단됨";
  return null;
}

export function inferNextAction(status: SessionStatus, active: boolean): string {
  if (active) return "완료 대기 또는 /steer";
  if (status === "queued") return "대기 취소는 /stop";
  if (status === "waiting_approval") return "토픽에서 승인 또는 거절";
  if (status === "waiting_limit") return "자동 재개 대기 또는 /restop";
  if (status === "verification_failed") return "수정 지시 또는 /next";
  if (status === "done") return "결과 검토, 필요 시 /next";
  if (status === "error") return "로그 확인 후 재시도";
  if (status === "aborted" || status === "interrupted") return "필요 시 새 작업 시작";
  return "상태 확인";
}

export function readGitBranch(cwd: string): string | null {
  try {
    const branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

function normalizeSessionStatus(status: SessionStatus, active: boolean): DashboardTaskStatus {
  if (active && status === "running") return "running";
  if (status === "verification_failed") return "blocked";
  if (status === "interrupted") return "aborted";
  if (status === "waiting_approval") return "waiting_approval";
  if (status === "waiting_limit") return "waiting_limit";
  if (status === "queued") return "queued";
  if (status === "done") return "done";
  if (status === "error") return "error";
  if (status === "aborted") return "aborted";
  return active ? "running" : "done";
}

function modelForSession(session: SessionRecord): string | null {
  if (session.provider === "codex") return session.codexModel;
  if (session.provider === "agy") return session.agyModel;
  if (session.provider === "grok") return session.grokModel ?? null;
  return session.model;
}

function providerLabel(provider: ProviderKind | null): string {
  if (provider === "codex") return "Codex";
  if (provider === "agy") return "Antigravity";
  if (provider === "grok") return "Grok";
  if (provider === "claude") return "Claude";
  return "Agent";
}

function statusLabel(status: DashboardTaskStatus): string {
  if (status === "waiting_approval") return "WAIT_APPROVAL";
  if (status === "waiting_limit") return "WAIT_LIMIT";
  if (status === "needs_user") return "NEEDS_USER";
  return status.toUpperCase();
}

function compactUsageText(snapshot: UsageSnapshot): string {
  return truncate(formatUsageSnapshot(snapshot).replace(/\n+/g, " · "), 220, "head");
}

function topicUrl(chatId: number, topicId: number): string {
  return `https://t.me/c/${String(chatId).replace(/^-100/, "")}/${topicId}`;
}

function compareDashboardCards(a: DashboardTaskCard, b: DashboardTaskCard): number {
  return statusRank(a.status) - statusRank(b.status) || b.updatedAt - a.updatedAt;
}

function statusRank(status: DashboardTaskStatus): number {
  if (status === "waiting_approval") return 0;
  if (status === "waiting_limit") return 1;
  if (status === "running") return 2;
  if (status === "queued") return 3;
  if (status === "blocked" || status === "needs_user") return 4;
  if (status === "error") return 5;
  if (status === "aborted") return 6;
  return 7;
}

function formatShortDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  if (minutes > 0) return `${minutes}분 ${remainder}초`;
  return `${remainder}초`;
}

function formatLocalTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(appLocale(), {
    timeZone: appTimeZone(),
    hour12: false
  });
}

function truncate(value: string, limit: number, side: "head" | "tail"): string {
  if (value.length <= limit) return value;
  if (limit <= 1) return value.slice(0, limit);
  return side === "tail" ? `…${value.slice(-(limit - 1))}` : `${value.slice(0, limit - 1)}…`;
}
