import type {
  SDKControlGetUsageResponse,
  SDKRateLimitInfo
} from "@anthropic-ai/claude-agent-sdk";
import type { ExtraUsage, UsageSnapshot, UsageWindow } from "./types.js";
import type { AgyUsage } from "./agy-interactive.js";

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
    ? ` · ${new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
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
    return count !== null ? count.toLocaleString("ko-KR") : "-";
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
