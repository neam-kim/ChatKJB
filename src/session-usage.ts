// 사용량 스냅샷·한도(rate limit) 파싱 헬퍼. SessionManager 본체에서 분리한 순수/준순수
// 함수 모음으로, 클래스 상태(this)에 의존하지 않는다. session-manager.ts가 이 모듈을
// 그대로 재export하므로 기존 import 경로("./session-manager.js")는 변하지 않는다.
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { UsageSnapshot } from "./types.js";
import { snapshotFromUsageResponse } from "./usage.js";

export async function readUsageSnapshot(
  sdkQuery: ReturnType<typeof query>,
  timeoutMs = 5000
): Promise<UsageSnapshot | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      sdkQuery
        .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
        .then((usage) => snapshotFromUsageResponse(usage)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      })
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface UsageLookupResult {
  snapshot: UsageSnapshot | null;
  error: string | null;
}

export interface TokenUsageLookupResult extends UsageLookupResult {
  tokenIndex: number;
}

export function hasUsageWindows(snapshot: UsageSnapshot): boolean {
  return Boolean(
    snapshot.fiveHour
    || snapshot.sevenDay
    || snapshot.sevenDayOpus
    || snapshot.sevenDaySonnet
    || snapshot.agentSdkWeekly
    || snapshot.extraUsage
  );
}

function datePartsInTimeZone(timestamp: number, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0
  };
}

function zonedDateTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = datePartsInTimeZone(candidate, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const correction = targetAsUtc - actualAsUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  return candidate;
}

function normalizeResetTimeZone(value: string | undefined): string {
  const clean = value?.trim();
  if (!clean) return "Asia/Seoul";
  const aliases: Record<string, string> = {
    KST: "Asia/Seoul",
    UTC: "UTC",
    GMT: "UTC"
  };
  const timeZone = aliases[clean.toUpperCase()] ?? clean;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "Asia/Seoul";
  }
}

function nextResetInTimeZone(
  hour: number,
  minute: number,
  timeZone: string,
  now = Date.now()
): string {
  const current = datePartsInTimeZone(now, timeZone);
  let reset = zonedDateTimeToEpoch(
    current.year,
    current.month,
    current.day,
    hour,
    minute,
    timeZone
  );
  if (reset <= now) {
    const nextDate = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
    reset = zonedDateTimeToEpoch(
      nextDate.getUTCFullYear(),
      nextDate.getUTCMonth() + 1,
      nextDate.getUTCDate(),
      hour,
      minute,
      timeZone
    );
  }
  return new Date(reset).toISOString();
}

const RESET_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

// 한도 메시지에서 회복 시각(ISO)을 파싱한다. 지원하는 표현:
//  - Claude 5시간 한도: "resets 2pm (Asia/Seoul)", "resets 4:40pm"
//  - Claude 주간 한도:  "resets Jun 25 at 9am (Asia/Seoul)" (연도 생략 → 가까운 미래로 보정)
//  - Codex 사용 한도:   "...try again at Jun 27th, 2026 3:57 PM.", "...try again at 5:28 PM."
// 시간만 주어지면 다음 도래 시각, 날짜가 함께 오면 그 절대 시각을 쓴다. 시간대 미표기 시
// 로컬(Asia/Seoul)로 가정한다(Codex/Claude 모두 사용자 로컬 표기를 따른다).
export function parseResetTimestamp(message: string, capturedAt = Date.now()): string | null {
  const anchor = message.match(/(?:resets?|try again at)\s+(.+?)(?:[.\n]|$)/i);
  const tail = anchor?.[1];
  if (!tail) return null;
  const detail = tail.match(
    /(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?\s*(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i
  );
  if (!detail) return null;
  const [, monthName, dayStr, yearStr, hourStr, minuteStr, meridiem] = detail;
  let hour = Number(hourStr);
  const minute = minuteStr ? Number(minuteStr) : 0;
  const ampm = meridiem?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23) return null;
  const timeZone = normalizeResetTimeZone(detail[7]);

  const month = monthName ? RESET_MONTHS[monthName.toLowerCase().slice(0, 3)] : undefined;
  if (monthName && month !== undefined) {
    const day = Number(dayStr);
    const year = yearStr ? Number(yearStr) : datePartsInTimeZone(capturedAt, timeZone).year;
    let reset = zonedDateTimeToEpoch(year, month, day, hour, minute, timeZone);
    // 연도가 생략된 형식(예: Claude 주간 한도 "resets Jun 25 at 9am")에서 이미 지난
    // 날짜면 다음 해로 넘긴다. 연도가 명시된 Codex 메시지는 그대로 쓴다.
    if (!yearStr && reset <= capturedAt) {
      reset = zonedDateTimeToEpoch(year + 1, month, day, hour, minute, timeZone);
    }
    return new Date(reset).toISOString();
  }
  return nextResetInTimeZone(hour, minute, timeZone, capturedAt);
}

export function snapshotFromRateLimitError(error: unknown, capturedAt = Date.now()): UsageSnapshot | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!isRateLimitError(message)) return null;
  return {
    capturedAt,
    subscriptionType: null,
    rateLimitsAvailable: true,
    fiveHour: {
      utilization: 100,
      resetsAt: parseResetTimestamp(message, capturedAt)
    }
  };
}

// 한도/요금 한계로 턴이 실패했는지 휴리스틱으로 판별한다. utilization 100% 이벤트가
// 오기 전에 곧장 에러로 끝나는 경우를 잡아 다음 세션을 다른 토큰으로 유도하기 위함이다.
export function isRateLimitError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("rate limit")
    || message.includes("rate_limit")
    || message.includes("429")
    || message.includes("usage limit")
    || message.includes("quota")
    || (message.includes("limit") && message.includes("reset"))
  );
}

// Codex 스레드 재개(thread/resume) 시 해당 rollout 파일이 사라져 재개가 불가능한지 판별한다.
// 계정 홈을 바꿨거나 rollout이 정리/만료된 경우 "no rollout found ... (code -32600)"로 실패하며,
// 이때는 기존 codexThreadId를 버리고 새 스레드로 다시 시작하면 복구된다(맥락은 부트스트랩으로 보강).
export function isNoRolloutError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("no rollout found") || message.includes("thread/resume failed");
}

// 일시적 서버 과부하/장애로 턴이 실패했는지 판별한다. 토큰 한도가 아니라 Anthropic
// 백엔드 전역 과부하(529 Overloaded)나 일시 장애(5xx)이므로, 토큰을 봉인/전환하지 않고
// 짧은 백오프 후 같은 토큰으로 같은 작업을 재시도하면 대부분 회복된다.
export function isOverloadedError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("overloaded")
    || message.includes("529")
    || message.includes("503")
    || message.includes("502")
    || message.includes("service unavailable")
    || message.includes("internal server error")
  );
}
