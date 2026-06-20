import type { UsageSnapshot, UsageWindow } from "./types.js";

// 한 토큰을 "소진"으로 볼 사용률 임계값. SDK는 utilization을 0~100으로 클램프하므로
// 100이면 해당 한도 창에 도달한 상태다.
const DEFAULT_EXHAUSTION_UTILIZATION = 100;
// resetsAt를 알 수 없는 채로 소진/거부된 경우 다시 시도하기까지의 기본 백오프.
const DEFAULT_BACKOFF_MS = 60 * 60 * 1000;

export interface TokenPoolOptions {
  exhaustionUtilization?: number;
  defaultBackoffMs?: number;
}

interface TokenSlot {
  token: string;
  // epoch ms. 이 시각 전까지는 소진 상태로 간주하고 선택에서 제외한다.
  exhaustedUntil: number | null;
  lastUtilization: number | null;
}

function parseResetsAt(resetsAt: string | null | undefined): number | null {
  if (!resetsAt) return null;
  const parsed = Date.parse(resetsAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 여러 개의 Claude OAuth 토큰을 들고, 한도에 도달하지 않은 토큰을 우선 선택한다.
 * 한 토큰이 한도(utilization 100% 또는 rate-limit 오류)에 도달하면 해당 토큰을
 * 한도 초기화 시각(resetsAt)까지 봉인하고, 다음 세션은 살아있는 토큰을 쓰게 한다.
 *
 * 소진 상태는 메모리에만 보관한다. 데몬 재시작 시 초기화되지만, 첫 세션의 사용량
 * 이벤트로 곧바로 재감지되므로 실사용에 문제는 없다.
 */
export class TokenPool {
  private readonly slots: TokenSlot[];
  private readonly exhaustionUtilization: number;
  private readonly defaultBackoffMs: number;

  constructor(tokens: string[], options: TokenPoolOptions = {}) {
    const unique = [...new Set(tokens.map((token) => token.trim()).filter(Boolean))];
    if (unique.length === 0) {
      throw new Error("TokenPool requires at least one OAuth token");
    }
    this.slots = unique.map((token) => ({
      token,
      exhaustedUntil: null,
      lastUtilization: null
    }));
    this.exhaustionUtilization =
      options.exhaustionUtilization ?? DEFAULT_EXHAUSTION_UTILIZATION;
    this.defaultBackoffMs = options.defaultBackoffMs ?? DEFAULT_BACKOFF_MS;
  }

  get size(): number {
    return this.slots.length;
  }

  /** 0-based 인덱스. 없으면 -1. */
  indexOf(token: string): number {
    return this.slots.findIndex((slot) => slot.token === token);
  }

  /**
   * 살아있는 토큰이 하나도 없을 때, 가장 먼저 회복되는(=exhaustedUntil이 가장 이른) 시각을
   * epoch ms로 돌려준다. 사용 가능한 토큰이 하나라도 있으면(대기할 필요가 없으면) null.
   * 자동 재개를 그 시각에 맞춰 예약하는 데 쓴다.
   */
  recoversAt(now: number = Date.now()): number | null {
    const hasAvailable = this.slots.some(
      (slot) => slot.exhaustedUntil === null || slot.exhaustedUntil <= now
    );
    if (hasAvailable) return null;
    let soonest: number | null = null;
    for (const slot of this.slots) {
      if (slot.exhaustedUntil === null) continue;
      soonest = soonest === null ? slot.exhaustedUntil : Math.min(soonest, slot.exhaustedUntil);
    }
    return soonest;
  }

  isExhausted(token: string, now: number = Date.now()): boolean {
    const slot = this.slots.find((item) => item.token === token);
    return slot?.exhaustedUntil !== null
      && slot?.exhaustedUntil !== undefined
      && slot.exhaustedUntil > now;
  }

  /**
   * 사용할 토큰을 고른다. 등록 순서상 가장 앞에 있는 "살아있는" 토큰을 우선한다.
   * 전부 소진된 경우엔 가장 먼저 회복되는(=exhaustedUntil이 가장 이른) 토큰을 돌려준다.
   * 어떤 경우에도 토큰 하나는 반드시 반환한다.
   */
  select(now: number = Date.now()): string {
    const available = this.slots.find(
      (slot) => slot.exhaustedUntil === null || slot.exhaustedUntil <= now
    );
    if (available) return available.token;
    // 전부 소진: 회복이 가장 빠른(=exhaustedUntil이 가장 이른) 토큰을 시도한다.
    // 생성자에서 슬롯이 최소 1개임을 보장하므로 reduce는 항상 값을 반환한다.
    const soonest = this.slots.reduce((earliest, slot) =>
      (slot.exhaustedUntil ?? Infinity) < (earliest.exhaustedUntil ?? Infinity)
        ? slot
        : earliest
    );
    return soonest.token;
  }

  /**
   * 사용량 스냅샷을 보고 해당 토큰의 소진 상태를 갱신한다.
   * 한도 창 중 하나라도 임계 사용률에 도달하면, 그 창들이 모두 초기화될 때까지
   * (= 가장 늦은 resetsAt) 토큰을 봉인한다.
   */
  observe(
    token: string,
    snapshot: UsageSnapshot | null,
    now: number = Date.now()
  ): void {
    const slot = this.slots.find((item) => item.token === token);
    if (!slot || !snapshot) return;

    const windows: Array<UsageWindow | undefined> = [
      snapshot.fiveHour,
      snapshot.sevenDay,
      snapshot.sevenDayOpus,
      snapshot.sevenDaySonnet,
      snapshot.agentSdkWeekly
    ];

    let maxUtilization: number | null = null;
    let blockedUntil: number | null = null;

    for (const window of windows) {
      if (!window) continue;
      if (typeof window.utilization === "number") {
        maxUtilization = Math.max(maxUtilization ?? 0, window.utilization);
      }
      if (this.windowIsExhausted(window)) {
        const until = parseResetsAt(window.resetsAt) ?? now + this.defaultBackoffMs;
        blockedUntil = Math.max(blockedUntil ?? 0, until);
      }
    }

    slot.lastUtilization = maxUtilization;
    if (blockedUntil !== null && blockedUntil > now) {
      slot.exhaustedUntil = Math.max(slot.exhaustedUntil ?? 0, blockedUntil);
    }
  }

  private windowIsExhausted(window: UsageWindow): boolean {
    return typeof window.utilization === "number"
      && window.utilization >= this.exhaustionUtilization;
  }

  /** rate-limit 오류로 턴이 실패했을 때, resetsAt를 모르면 기본 백오프만큼 봉인한다. */
  noteRateLimited(token: string, now: number = Date.now(), until?: number): void {
    const slot = this.slots.find((item) => item.token === token);
    if (!slot) return;
    // 직전 rate_limit_event/usage 응답에서 정확한 reset 시각을 이미 받았다면,
    // resetsAt 없는 후속 오류의 추정 백오프(기본 1시간)로 덮어쓰지 않는다.
    if (until === undefined && slot.exhaustedUntil !== null && slot.exhaustedUntil > now) {
      return;
    }
    const target = until ?? now + this.defaultBackoffMs;
    slot.exhaustedUntil = Math.max(slot.exhaustedUntil ?? 0, target);
  }

  /** 진단/로그용 요약. */
  describe(now: number = Date.now()): string {
    return this.slots
      .map((slot, index) => {
        const state = this.isExhausted(slot.token, now)
          ? `소진 (${new Date(slot.exhaustedUntil as number).toISOString()} 회복)`
          : "사용 가능";
        const util = slot.lastUtilization === null
          ? ""
          : ` · 최근 사용률 ${Math.round(slot.lastUtilization)}%`;
        return `토큰 #${index + 1}: ${state}${util}`;
      })
      .join("\n");
  }
}
