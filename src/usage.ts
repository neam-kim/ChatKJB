import type {
  SDKControlGetUsageResponse,
  SDKRateLimitInfo
} from "@anthropic-ai/claude-agent-sdk";
import type { UsageSnapshot, UsageWindow } from "./types.js";

export const AGENT_SDK_CREDIT_START_AT = Date.parse("2026-06-15T00:00:00+09:00");

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

function agentSdkCredit(value: unknown): UsageSnapshot["agentSdkCredit"] {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const window = usageWindow(record);
  const usedCredits = typeof record.used_credits === "number"
    ? record.used_credits
    : typeof record.usedCredits === "number"
      ? record.usedCredits
      : null;
  const monthlyLimit = typeof record.monthly_limit === "number"
    ? record.monthly_limit
    : typeof record.monthlyLimit === "number"
      ? record.monthlyLimit
      : null;
  const currency = typeof record.currency === "string" ? record.currency : null;
  if (!window && usedCredits === null && monthlyLimit === null) return undefined;
  return {
    utilization: window?.utilization ?? null,
    resetsAt: window?.resetsAt ?? null,
    usedCredits,
    monthlyLimit,
    currency
  };
}

function findAgentSdkCredit(response: SDKControlGetUsageResponse): UsageSnapshot["agentSdkCredit"] {
  const raw = response as unknown as Record<string, unknown>;
  const rateLimits = raw.rate_limits && typeof raw.rate_limits === "object"
    ? raw.rate_limits as Record<string, unknown>
    : {};
  const candidates = [
    raw.agent_sdk_credit,
    raw.agent_sdk_monthly_credit,
    raw.monthly_agent_sdk_credit,
    rateLimits.agent_sdk_credit,
    rateLimits.agent_sdk_monthly_credit,
    rateLimits.monthly_agent_sdk_credit
  ];
  for (const candidate of candidates) {
    const parsed = agentSdkCredit(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

export function snapshotFromUsageResponse(
  response: SDKControlGetUsageResponse,
  capturedAt = Date.now()
): UsageSnapshot {
  const fiveHour = usageWindow(response.rate_limits?.five_hour);
  const sevenDay = usageWindow(response.rate_limits?.seven_day);
  const agentSdkLegacy = usageWindow(response.rate_limits?.seven_day_oauth_apps);
  const monthlyCredit = findAgentSdkCredit(response);
  return {
    capturedAt,
    subscriptionType: response.subscription_type,
    rateLimitsAvailable: response.rate_limits_available,
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(agentSdkLegacy ? { agentSdkLegacy } : {}),
    ...(monthlyCredit ? { agentSdkCredit: monthlyCredit } : {})
  };
}

export function snapshotFromRateLimitInfo(
  info: SDKRateLimitInfo,
  capturedAt = Date.now()
): UsageSnapshot {
  const window: UsageWindow = {
    utilization: percentage(info.utilization),
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

function formatAgentSdkCredit(snapshot: UsageSnapshot): string {
  const credit = snapshot.agentSdkCredit;
  if (!credit) {
    return "월간 Agent SDK 크레딧: 공식 사용량 정보 미제공 · Claude 설정 > 사용량에서 확인";
  }
  const currency = credit.currency?.toUpperCase() === "USD" || !credit.currency ? "$" : `${credit.currency} `;
  const amount = credit.usedCredits !== null && credit.monthlyLimit !== null
    ? `${currency}${credit.usedCredits.toFixed(2)} / ${currency}${credit.monthlyLimit.toFixed(2)}`
    : null;
  const window = formatWindow("월간 Agent SDK 크레딧", credit);
  return amount ? `${window} · ${amount}` : window;
}

export function formatUsageSnapshot(snapshot: UsageSnapshot, now = Date.now()): string {
  const lines: string[] = [];
  if (now >= AGENT_SDK_CREDIT_START_AT) {
    lines.push(formatAgentSdkCredit(snapshot));
    const credit = snapshot.agentSdkCredit;
    const creditUtilization = credit?.utilization
      ?? (credit?.usedCredits !== null
        && credit?.usedCredits !== undefined
        && credit.monthlyLimit !== null
        && credit.monthlyLimit !== undefined
        && credit.monthlyLimit > 0
        ? credit.usedCredits / credit.monthlyLimit * 100
        : 0);
    if (creditUtilization >= 80) {
      lines.push("주의: 월간 크레딧이 80% 이상 사용되었습니다.");
    }
    if (snapshot.fiveHour) {
      lines.push(formatWindow("Claude 구독 5시간 한도 (참고)", snapshot.fiveHour));
    }
    if (snapshot.sevenDay) {
      lines.push(formatWindow("Claude 구독 7일 한도 (참고)", snapshot.sevenDay));
    }
  } else {
    if (snapshot.fiveHour) lines.push(formatWindow("5시간 한도", snapshot.fiveHour));
    if (snapshot.sevenDay) lines.push(formatWindow("7일 한도", snapshot.sevenDay));
    if (snapshot.agentSdkLegacy) {
      lines.push(formatWindow("Agent SDK 앱 한도", snapshot.agentSdkLegacy));
    }
    if ((snapshot.fiveHour?.utilization ?? 0) >= 80) {
      lines.push("주의: 긴 작업을 추가 실행하면 5시간 한도에 도달할 수 있습니다.");
    }
  }
  if (lines.length === 0) {
    lines.push(snapshot.rateLimitsAvailable
      ? "한도 사용량: 서버가 사용률을 반환하지 않았습니다."
      : "한도 사용량: 구독 OAuth 세션에서만 확인할 수 있습니다.");
  }
  return lines.join("\n");
}
