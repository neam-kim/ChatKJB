import type {
  SDKControlGetUsageResponse,
  SDKRateLimitInfo
} from "@anthropic-ai/claude-agent-sdk";
import type { GrokLiveUsageResult } from "./grok-live-usage.js";
import type { LocalTokenUsageReport } from "./local-token-usage.js";
import { appLocale, appTimeZone } from "./localization.js";
import type {
  CodexAccountUsageSnapshot,
  CodexLiveUsageSnapshot,
  CodexLiveUsageWindow,
  CodexUsageSnapshot,
  ExtraUsage,
  GrokTokenUsage,
  SessionRecord,
  UsageSnapshot,
  UsageWindow
} from "./types.js";

/** 이전 Antigravity API가 SQLite에 남긴 사용량을 읽기 위한 호환 형식이다. */
export interface AgyUsage {
  promptTokenCount: number | null;
  cachedContentTokenCount: number | null;
  candidatesTokenCount: number | null;
  thoughtsTokenCount: number | null;
  totalTokenCount: number | null;
}

function percentage(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = value >= 0 && value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, normalized));
}

function timestamp(value: unknown): string | null {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  return null;
}

function usageWindow(value: unknown): UsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const utilization = percentage(record.utilization);
  const resetsAt = timestamp(record.resets_at ?? record.resetsAt);
  if (utilization === null && resetsAt === null) return undefined;
  return { utilization, resetsAt };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extraUsage(value: unknown): ExtraUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const isEnabled = record.is_enabled === true;
  const utilization = percentage(record.utilization);
  const usedCredits = numberOrNull(record.used_credits);
  const monthlyLimit = numberOrNull(record.monthly_limit);
  const currency = typeof record.currency === "string" ? record.currency : null;
  if (!isEnabled && utilization === null && usedCredits === null && monthlyLimit === null) {
    return undefined;
  }
  return { isEnabled, utilization, usedCredits, monthlyLimit, currency };
}

export function snapshotFromUsageResponse(
  response: SDKControlGetUsageResponse,
  capturedAt = Date.now()
): UsageSnapshot {
  const limits = response.rate_limits ?? undefined;
  const fiveHour = usageWindow(limits?.five_hour);
  const sevenDay = usageWindow(limits?.seven_day);
  const sevenDayOpus = usageWindow(limits?.seven_day_opus);
  const sevenDaySonnet = usageWindow(limits?.seven_day_sonnet);
  const agentSdkWeekly = usageWindow(limits?.seven_day_oauth_apps);
  const extra = extraUsage(limits?.extra_usage);
  return {
    capturedAt,
    subscriptionType: response.subscription_type,
    rateLimitsAvailable: response.rate_limits_available,
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(sevenDayOpus ? { sevenDayOpus } : {}),
    ...(sevenDaySonnet ? { sevenDaySonnet } : {}),
    ...(agentSdkWeekly ? { agentSdkWeekly } : {}),
    ...(extra ? { extraUsage: extra } : {})
  };
}

export function snapshotFromRateLimitInfo(
  info: SDKRateLimitInfo,
  capturedAt = Date.now()
): UsageSnapshot {
  const window: UsageWindow = {
    // 실제 거부 이벤트는 status와 resetsAt만 주고 utilization을 생략할 수 있다.
    // 토큰 선택 관점에서 rejected는 소진 상태이므로 100%로 정규화한다.
    utilization: info.status === "rejected" ? 100 : percentage(info.utilization),
    resetsAt: timestamp(info.resetsAt)
  };
  const snapshot: UsageSnapshot = {
    capturedAt,
    subscriptionType: null,
    rateLimitsAvailable: true
  };
  if (info.rateLimitType === "five_hour") snapshot.fiveHour = window;
  if (info.rateLimitType === "seven_day") snapshot.sevenDay = window;
  if (info.rateLimitType === "seven_day_opus") snapshot.sevenDayOpus = window;
  if (info.rateLimitType === "seven_day_sonnet") snapshot.sevenDaySonnet = window;
  if (info.rateLimitType === "overage") {
    snapshot.extraUsage = {
      isEnabled: true,
      utilization: percentage(info.utilization),
      usedCredits: null,
      monthlyLimit: null,
      currency: null
    };
  }
  return snapshot;
}

export function mergeUsageSnapshots(
  previous: UsageSnapshot | null,
  next: UsageSnapshot
): UsageSnapshot {
  return {
    ...(previous ?? {}),
    ...next,
    capturedAt: next.capturedAt,
    subscriptionType: next.subscriptionType ?? previous?.subscriptionType ?? null,
    rateLimitsAvailable: next.rateLimitsAvailable
  };
}

function formatWindow(label: string, window: UsageWindow): string {
  const utilization = window.utilization === null
    ? "사용률 확인 불가"
    : `${Math.round(window.utilization)}% 사용`;
  const reset = window.resetsAt
    ? ` · ${new Intl.DateTimeFormat(appLocale(), {
      timeZone: appTimeZone(),
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(window.resetsAt))} 초기화`
    : "";
  return `${label}: ${utilization}${reset}`;
}

function formatExtraUsage(extra: ExtraUsage): string | null {
  if (!extra.isEnabled) return null;
  const currency = extra.currency?.toUpperCase() === "USD" || !extra.currency
    ? "$"
    : `${extra.currency} `;
  const amount = extra.usedCredits !== null && extra.monthlyLimit !== null
    ? ` · ${currency}${extra.usedCredits.toFixed(2)} / ${currency}${extra.monthlyLimit.toFixed(2)}`
    : "";
  const utilization = extra.utilization === null
    ? "사용 중"
    : `${Math.round(extra.utilization)}% 사용`;
  return `추가 사용(overage): ${utilization}${amount}`;
}

/** agy 네이티브 토큰 사용량을 텔레그램 출력용 문자열로 포맷한다.
 *  totalUsage: 대화 누적. turnUsage: 마지막 턴(선택). */
export function formatAgyUsage(totalUsage: AgyUsage, turnUsage?: AgyUsage): string {
  const lines: string[] = [];

  function tok(count: number | null): string {
    return count !== null ? count.toLocaleString(appLocale()) : "-";
  }

  lines.push("agy 누적 토큰 사용량");
  lines.push(`  전체: ${tok(totalUsage.totalTokenCount)}`);
  lines.push(`  입력(prompt): ${tok(totalUsage.promptTokenCount)}`);
  if (totalUsage.cachedContentTokenCount !== null) {
    lines.push(`  캐시: ${tok(totalUsage.cachedContentTokenCount)}`);
  }
  lines.push(`  출력(candidates): ${tok(totalUsage.candidatesTokenCount)}`);
  if (totalUsage.thoughtsTokenCount !== null) {
    lines.push(`  추론(thoughts): ${tok(totalUsage.thoughtsTokenCount)}`);
  }

  if (turnUsage) {
    lines.push("");
    lines.push("마지막 턴");
    lines.push(`  전체: ${tok(turnUsage.totalTokenCount)}`);
    lines.push(`  입력(prompt): ${tok(turnUsage.promptTokenCount)}`);
    if (turnUsage.cachedContentTokenCount !== null) {
      lines.push(`  캐시: ${tok(turnUsage.cachedContentTokenCount)}`);
    }
    lines.push(`  출력(candidates): ${tok(turnUsage.candidatesTokenCount)}`);
    if (turnUsage.thoughtsTokenCount !== null) {
      lines.push(`  추론(thoughts): ${tok(turnUsage.thoughtsTokenCount)}`);
    }
  }

  return lines.join("\n");
}

/** JSON 문자열로 저장된 agyUsage를 AgyUsage로 파싱한다. 실패 시 null. */
export function parseStoredAgyUsage(value: string | null): AgyUsage | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as AgyUsage;
  } catch {
    return null;
  }
}

/** 여러 세션의 agy 누적 사용량을 필드별로 합산한다. 모든 값이 null인 필드는 null로 둔다. */
function sumAgyUsage(list: AgyUsage[]): AgyUsage {
  const add = (key: keyof AgyUsage): number | null => {
    const values = list
      .map((usage) => usage[key])
      .filter((value): value is number => value !== null);
    return values.length > 0 ? values.reduce((acc, value) => acc + value, 0) : null;
  };
  return {
    promptTokenCount: add("promptTokenCount"),
    cachedContentTokenCount: add("cachedContentTokenCount"),
    candidatesTokenCount: add("candidatesTokenCount"),
    thoughtsTokenCount: add("thoughtsTokenCount"),
    totalTokenCount: add("totalTokenCount")
  };
}

/**
 * 전역 /usage용 agy 요약. agy 토큰 사용량은 CLI 백엔드가 제공하지 않아 대화(세션) 단위로
 * 저장된 이전 API 측정값만 있으므로, 저장값이 있는 agy 세션들을 합산해 보여 준다.
 */
export function formatAgyAccountUsage(sessions: SessionRecord[]): string {
  const measured = sessions
    .filter((session) => session.provider === "agy")
    .map((session) => parseStoredAgyUsage(session.agyUsage))
    .filter((usage): usage is AgyUsage => usage !== null);
  if (measured.length === 0) {
    return "Antigravity(agy) 사용량: 측정된 세션이 없습니다.\n"
      + "(agy 토픽에서 턴을 실행하면 누적 토큰이 기록됩니다.)";
  }
  const total = sumAgyUsage(measured);
  return `Antigravity(agy) 사용량 · ${measured.length}개 세션 합계\n`
    + formatAgyUsage(total)
    + "\n원천: Antigravity CLI 이전 API 측정값 (CLI 백엔드는 토큰 사용량 미제공)";
}

/**
 * 전역 /usage용 Grok 요약. grok CLI에는 usage/quota 서브커맨드가 없지만, CLI 자신이 크레딧
 * 잔량을 읽을 때 쓰는 grok.com 과금 API를 같은 자격증명으로 조회해 한도를 보여 준다.
 */
export function formatGrokUsage(result: GrokLiveUsageResult): string {
  const { snapshot, error } = result;
  if (!snapshot) {
    return `Grok 구독 사용량: 조회 실패${error ? ` (${error})` : ""}`;
  }
  const lines = ["Grok 구독 사용량"];
  lines.push(snapshot.creditUsagePercent === null
    ? "  구독 크레딧: 사용률 데이터 없음"
    : `  구독 크레딧: ${Math.round(snapshot.creditUsagePercent)}% 사용`);

  const period = snapshot.periodType === "USAGE_PERIOD_TYPE_WEEKLY"
    ? "주간"
    : snapshot.periodType === "USAGE_PERIOD_TYPE_MONTHLY"
      ? "월간"
      : "현재";
  if (snapshot.periodEnd) {
    lines.push(`  ${period} 주기: ${new Intl.DateTimeFormat(appLocale(), {
      timeZone: appTimeZone(),
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(snapshot.periodEnd))} 초기화`);
  }

  // 사용률이 붙지 않은 제품은 이번 주기에 쓰지 않았다는 뜻이라 노이즈만 되므로 뺀다.
  const used = snapshot.productUsage.filter((item) =>
    item.usagePercent !== null && item.product.toLowerCase() !== "api"
  );
  if (used.length > 0) {
    lines.push(`  구독 제품별: ${used
      .map((item) => `${item.product} ${Math.round(item.usagePercent!)}%`)
      .join(" · ")}`);
  }
  if ((snapshot.creditUsagePercent ?? 0) >= 80) {
    lines.push("  주의: Grok 구독 크레딧이 80% 이상 사용되었습니다.");
  }
  lines.push("원천: grok.com 구독 과금 API 실시간 조회 (API 키 사용량 제외)");
  return lines.join("\n");
}

/** JSON 문자열로 저장된 grokUsage를 GrokTokenUsage로 파싱한다. 실패 시 null. */
export function parseStoredGrokUsage(value: string | null): GrokTokenUsage | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as GrokTokenUsage;
  } catch {
    return null;
  }
}

/** 세션에 저장된 grok 누적 사용량에 이번 턴 사용량을 더한다. */
export function addGrokUsage(
  previous: GrokTokenUsage | null,
  next: GrokTokenUsage
): GrokTokenUsage {
  if (!previous) return next;
  return {
    inputTokens: previous.inputTokens + next.inputTokens,
    cacheReadInputTokens: previous.cacheReadInputTokens + next.cacheReadInputTokens,
    outputTokens: previous.outputTokens + next.outputTokens,
    reasoningTokens: previous.reasoningTokens + next.reasoningTokens,
    totalTokens: previous.totalTokens + next.totalTokens
  };
}

function formatTokenCount(value: number): string {
  return value.toLocaleString(appLocale());
}

function formatCodexUsageSnapshot(snapshot: CodexUsageSnapshot): string {
  return [
    `  전체: ${formatTokenCount(snapshot.totalTokens)}`,
    `  입력: ${formatTokenCount(snapshot.inputTokens)}`,
    `  캐시 입력: ${formatTokenCount(snapshot.cachedInputTokens)}`,
    `  출력: ${formatTokenCount(snapshot.outputTokens)}`,
    `  추론 출력: ${formatTokenCount(snapshot.reasoningOutputTokens)}`,
    `  모델: ${snapshot.model} · reasoning ${snapshot.reasoning}`,
    `  측정: ${new Date(snapshot.capturedAt).toLocaleString(appLocale(), { timeZone: appTimeZone() })}`
  ].join("\n");
}

function formatCodexWindow(label: string, window: CodexLiveUsageWindow | null): string | null {
  if (!window) return null;
  const used = window.usedPercent === null ? "사용률 확인 불가" : `${Math.round(window.usedPercent)}% 사용`;
  const duration = window.windowDurationMins === 300
    ? "5시간"
    : window.windowDurationMins === 10080
      ? "주간"
      : window.windowDurationMins !== null
        ? `${window.windowDurationMins}분`
        : label;
  const reset = window.resetsAt
    ? ` · ${new Date(window.resetsAt).toLocaleString(appLocale(), { timeZone: appTimeZone() })} 초기화`
    : "";
  return `  ${duration} 한도: ${used}${reset}`;
}

function formatCodexLiveUsage(snapshot: CodexLiveUsageSnapshot): string {
  const lines: string[] = [];
  if (snapshot.planType) lines.push(`  플랜: ${snapshot.planType}`);
  const primary = formatCodexWindow("기본", snapshot.primary);
  if (primary) lines.push(primary);
  const secondary = formatCodexWindow("보조", snapshot.secondary);
  if (secondary) lines.push(secondary);
  if (snapshot.resetCreditsAvailable !== null) {
    lines.push(`  사용 가능 reset: ${snapshot.resetCreditsAvailable}`);
  }
  if (snapshot.creditsBalance !== null) {
    lines.push(`  크레딧 잔액: ${snapshot.creditsBalance}`);
  }
  if (snapshot.rateLimitReachedType) {
    lines.push(`  제한 상태: ${snapshot.rateLimitReachedType}`);
  }
  if (snapshot.lifetimeTokens !== null) {
    lines.push(`  누적 토큰: ${formatTokenCount(snapshot.lifetimeTokens)}`);
  }
  if (snapshot.peakDailyTokens !== null) {
    lines.push(`  일일 최고 토큰: ${formatTokenCount(snapshot.peakDailyTokens)}`);
  }
  if (snapshot.currentStreakDays !== null) {
    lines.push(`  연속 사용일: ${snapshot.currentStreakDays}`);
  }
  lines.push(`  측정: ${new Date(snapshot.capturedAt).toLocaleString(appLocale(), { timeZone: appTimeZone() })}`);
  return lines.join("\n");
}

export function formatCodexAccountUsage(snapshots: CodexAccountUsageSnapshot[]): string {
  if (snapshots.length === 0) {
    return "Codex 계정: 설정 없음";
  }
  const lines = ["Codex 사용량"];
  for (const snapshot of snapshots) {
    const status = snapshot.available
      ? "사용 가능"
      : `소진 · ${snapshot.exhaustedUntil
        ? new Date(snapshot.exhaustedUntil).toLocaleString(appLocale(), { timeZone: appTimeZone() })
        : "회복 시각 알 수 없음"} 회복`;
    lines.push(`Codex 계정 #${snapshot.accountIndex}: ${status}`);
    if (snapshot.liveUsage) {
      lines.push(formatCodexLiveUsage(snapshot.liveUsage));
    } else if (snapshot.liveUsageError) {
      lines.push(`  실시간 조회 실패: ${snapshot.liveUsageError}`);
    }
    lines.push(snapshot.latestUsage
      ? formatCodexUsageSnapshot(snapshot.latestUsage)
      : "  최근 완료 턴 토큰 사용량: 아직 없음");
  }
  lines.push("원천: Codex app-server 실시간 조회 및 SDK 완료 이벤트");
  return lines.join("\n");
}

/**
 * /ustoken 출력. 이 맥미니의 모든 에이전트가 지금까지 쓴 누적 토큰을 제공자별로 보여 준다.
 * 한도(/usage)와 달리 주기 개념이 없는 전체 누계이며, 집계가 불완전한 제공자는 사유를 함께 적는다.
 */
export function formatLocalTokenUsage(report: LocalTokenUsageReport): string {
  const lines = ["이 맥미니의 누적 토큰 사용량 (전 에이전트)"];
  for (const provider of report.providers) {
    if (provider.totalTokens === 0) {
      lines.push("");
      lines.push(`${provider.provider}: 기록 없음${provider.caveat ? `\n  · ${provider.caveat}` : ""}`);
      continue;
    }
    lines.push("");
    lines.push(`${provider.provider}: ${formatTokenCount(provider.totalTokens)}`);
    lines.push(
      `  입력 ${formatTokenCount(provider.inputTokens)}`
      + ` · 캐시 ${formatTokenCount(provider.cachedTokens)}`
      + ` · 출력 ${formatTokenCount(provider.outputTokens)}`
    );
    if (provider.caveat) lines.push(`  · ${provider.caveat}`);
  }
  lines.push("");
  lines.push(`합계: ${formatTokenCount(report.totalTokens)} 토큰`);
  lines.push(
    `측정: ${new Date(report.capturedAt).toLocaleString(appLocale(), { timeZone: appTimeZone() })}`
  );
  lines.push("원천: 로컬 트랜스크립트·rollout 기록 및 봇 DB (과금 청구액과 다를 수 있습니다)");
  return lines.join("\n");
}

// 한도 윈도우를 항상 같은 순서로, 서버가 실제로 반환한 것만 표시한다.
// SDK 사용량 API가 노출하지 않는 과금 항목은 추정해서 만들지 않는다.
export function formatUsageSnapshot(snapshot: UsageSnapshot): string {
  const lines: string[] = [];
  if (snapshot.fiveHour) lines.push(formatWindow("5시간 한도", snapshot.fiveHour));
  if (snapshot.sevenDay) lines.push(formatWindow("주간 한도", snapshot.sevenDay));
  if (snapshot.sevenDayOpus) lines.push(formatWindow("주간 한도 (Opus)", snapshot.sevenDayOpus));
  if (snapshot.sevenDaySonnet) lines.push(formatWindow("주간 한도 (Sonnet)", snapshot.sevenDaySonnet));
  if (snapshot.agentSdkWeekly) {
    lines.push(formatWindow("Agent SDK 주간 한도", snapshot.agentSdkWeekly));
  }
  if (snapshot.extraUsage) {
    const extra = formatExtraUsage(snapshot.extraUsage);
    if (extra) lines.push(extra);
  }

  if ((snapshot.fiveHour?.utilization ?? 0) >= 80) {
    lines.push("주의: 5시간 한도가 80% 이상 사용되었습니다.");
  }
  if ((snapshot.sevenDay?.utilization ?? 0) >= 80) {
    lines.push("주의: 주간 한도가 80% 이상 사용되었습니다.");
  }

  if (lines.length === 0) {
    lines.push(snapshot.rateLimitsAvailable
      ? "한도 사용량: 서버가 사용률을 반환하지 않았습니다."
      : "한도 사용량: 구독 OAuth 세션에서만 확인할 수 있습니다.");
  }
  return lines.join("\n");
}
