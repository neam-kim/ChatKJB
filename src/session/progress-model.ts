/**
 * Provider-agnostic progress model for the live task cockpit.
 * Normalizes current activity, wait reason, ledger, and remaining plan
 * so Telegram and Terminal can share one surface-agnostic status text.
 */

export type WaitReasonKind =
  | "none"
  | "approval"
  | "limit"
  | "subagent"
  | "tool"
  | "queue"
  | "unknown";

export type LedgerEntryKind =
  | "tool"
  | "file"
  | "command"
  | "decision"
  | "plan"
  | "note"
  | "subagent"
  | "search"
  | "error";

export interface ProgressEvent {
  kind: LedgerEntryKind | "activity" | "wait" | "plan";
  summary: string;
  detail?: string;
  at?: number;
}

export interface LedgerEntry {
  at: number;
  kind: LedgerEntryKind;
  summary: string;
  detail?: string;
}

export interface WaitReason {
  kind: WaitReasonKind;
  /** User-visible one-line label. Never empty when kind !== "none". */
  label: string;
  /** True when the provider could not supply a precise reason. */
  degraded?: boolean;
}

export interface RemainingPlan {
  /** Checklist-style remaining or planned steps. */
  items: string[];
  completed: number;
  total: number;
  /** 0–100 when total > 0; null when progress is unknown. */
  percent: number | null;
  /** True when the provider does not expose a plan. */
  degraded: boolean;
  /** Short caption, e.g. "3/7 완료" or degrade message. */
  label: string;
}

export interface CockpitSnapshot {
  currentActivity: string;
  waitReason: WaitReason;
  ledger: LedgerEntry[];
  remainingPlan: RemainingPlan;
}

/** Soft cap before compaction; keeps memory bounded. */
export const LEDGER_SOFT_LIMIT = 48;
/** Max lines shown in the status message after compaction. */
export const LEDGER_DISPLAY_LIMIT = 12;
/** Max characters per ledger summary line. */
export const LEDGER_SUMMARY_MAX = 180;

const DEGRADE_NO_ACTIVITY = "현재 단계 정보 없음(제공자 제한)";
const DEGRADE_NO_WAIT = "대기 아님 · 실행 중";
const DEGRADE_NO_PLAN = "남은 계획 정보 없음(제공자 제한 · ETA 미제공)";
const DEGRADE_UNKNOWN_WAIT = "대기 사유 확인 중";

export function degradeActivityLabel(): string {
  return DEGRADE_NO_ACTIVITY;
}

export function degradePlanLabel(): string {
  return DEGRADE_NO_PLAN;
}

export function emptyRemainingPlan(degraded = true): RemainingPlan {
  return {
    items: [],
    completed: 0,
    total: 0,
    percent: null,
    degraded,
    label: degraded ? DEGRADE_NO_PLAN : "계획 없음"
  };
}

export function remainingPlanFromCounts(
  completed: number,
  total: number,
  items: string[] = []
): RemainingPlan {
  const safeTotal = Math.max(0, total);
  const safeCompleted = Math.min(Math.max(0, completed), safeTotal || completed);
  if (safeTotal <= 0 && items.length === 0) return emptyRemainingPlan(true);
  const percent = safeTotal > 0
    ? Math.min(100, Math.round((safeCompleted / safeTotal) * 100))
    : null;
  return {
    items: items.map((item) => truncateSummary(item)).slice(0, 8),
    completed: safeCompleted,
    total: safeTotal || items.length,
    percent,
    degraded: false,
    label: percent !== null
      ? `${safeCompleted}/${safeTotal || items.length} 완료 (${percent}%) · ETA 미제공`
      : `${items.length}개 단계 · ETA 미제공`
  };
}

export function waitReasonFromSessionStatus(
  status: string | null | undefined,
  overrides?: { openSubagents?: number; toolWaiting?: boolean; }
): WaitReason {
  if (overrides?.openSubagents && overrides.openSubagents > 0) {
    return {
      kind: "subagent",
      label: `서브에이전트 대기 (${overrides.openSubagents}개)`
    };
  }
  if (overrides?.toolWaiting) {
    return { kind: "tool", label: "도구 응답 대기" };
  }
  switch (status) {
    case "waiting_approval":
      return { kind: "approval", label: "사용자 승인 필요" };
    case "waiting_limit":
      return { kind: "limit", label: "한도 회복 대기" };
    case "queued":
      return { kind: "queue", label: "같은 프로젝트의 앞선 작업 대기" };
    case "running":
    case null:
    case undefined:
      return { kind: "none", label: DEGRADE_NO_WAIT };
    default:
      return { kind: "unknown", label: DEGRADE_UNKNOWN_WAIT, degraded: true };
  }
}

export function truncateSummary(text: string, max = LEDGER_SUMMARY_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Bounded append-only ledger with automatic compaction.
 * When soft limit is exceeded, older entries collapse into a single summary line.
 */
export class TaskLedger {
  private entries: LedgerEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }

  append(
    kind: LedgerEntryKind,
    summary: string,
    detail?: string,
    at: number = Date.now()
  ): LedgerEntry {
    const entry: LedgerEntry = {
      at,
      kind,
      summary: truncateSummary(summary),
      ...(detail ? { detail: truncateSummary(detail, 240) } : {})
    };
    this.entries.push(entry);
    this.compactIfNeeded();
    return entry;
  }

  applyEvent(event: ProgressEvent): LedgerEntry | null {
    if (event.kind === "activity" || event.kind === "wait" || event.kind === "plan") {
      return null;
    }
    return this.append(event.kind, event.summary, event.detail, event.at);
  }

  /** Newest-last display list, capped for message length. */
  displayEntries(limit = LEDGER_DISPLAY_LIMIT): LedgerEntry[] {
    if (this.entries.length <= limit) return this.entries.slice();
    return this.entries.slice(-limit);
  }

  formatLines(limit = LEDGER_DISPLAY_LIMIT): string[] {
    return this.displayEntries(limit).map((entry) => {
      const prefix = ledgerKindPrefix(entry.kind);
      return `${prefix}${entry.summary}`;
    });
  }

  toJSON(): LedgerEntry[] {
    return this.entries.slice();
  }

  private compactIfNeeded(): void {
    if (this.entries.length <= LEDGER_SOFT_LIMIT) return;
    const drop = this.entries.length - Math.floor(LEDGER_SOFT_LIMIT / 2);
    if (drop <= 0) return;
    const removed = this.entries.splice(0, drop);
    const summary = `이전 ${removed.length}건 축약 (${removed[0]?.summary ?? "…"} … ${removed[removed.length - 1]?.summary ?? "…"})`;
    this.entries.unshift({
      at: removed[0]?.at ?? Date.now(),
      kind: "note",
      summary: truncateSummary(summary)
    });
  }
}

export function ledgerKindPrefix(kind: LedgerEntryKind): string {
  switch (kind) {
    case "tool":
      return "도구 ";
    case "file":
      return "파일 ";
    case "command":
      return "명령 ";
    case "decision":
      return "결정 ";
    case "plan":
      return "계획 ";
    case "subagent":
      return "하위 ";
    case "search":
      return "검색 ";
    case "error":
      return "오류 ";
    default:
      return "";
  }
}

export function activityFromTool(toolName: string, target?: string): string {
  const base = toolName.trim() || "도구";
  if (!target?.trim()) return `도구 사용: ${truncateSummary(base, 80)}`;
  return `도구 사용: ${truncateSummary(`${base} · ${target}`, 120)}`;
}

export function snapshotCockpit(input: {
  currentActivity?: string | null;
  waitReason?: WaitReason | null;
  ledger?: TaskLedger | LedgerEntry[] | null;
  remainingPlan?: RemainingPlan | null;
}): CockpitSnapshot {
  const ledgerEntries = input.ledger instanceof TaskLedger
    ? input.ledger.displayEntries()
    : (input.ledger ?? []);
  const activity = input.currentActivity?.trim() || DEGRADE_NO_ACTIVITY;
  const wait = input.waitReason ?? {
    kind: "unknown" as const,
    label: DEGRADE_UNKNOWN_WAIT,
    degraded: true
  };
  const plan = input.remainingPlan ?? emptyRemainingPlan(true);
  return {
    currentActivity: activity === "" ? DEGRADE_NO_ACTIVITY : activity,
    waitReason: wait.kind === "none" && !wait.label
      ? { kind: "none", label: DEGRADE_NO_WAIT }
      : wait,
    ledger: ledgerEntries,
    remainingPlan: plan
  };
}
