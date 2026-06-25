import { createHash } from "node:crypto";
import type { UsageSnapshot, UsageWindow } from "./types.js";

// 한 토큰을 "소진"으로 볼 사용률 임계값. SDK는 utilization을 0~100으로 클램프하므로
// 100이면 해당 한도 창에 도달한 상태다.
const DEFAULT_EXHAUSTION_UTILIZATION = 100;
// resetsAt를 알 수 없는 채로 소진/거부된 경우 다시 시도하기까지의 기본 백오프.
const DEFAULT_BACKOFF_MS = 60 * 60 * 1000;

export interface TokenPoolOptions {
  exhaustionUtilization?: number;
  defaultBackoffMs?: number;
  // 슬롯의 소진 시각(exhaustedUntil)이 실제로 바뀔 때마다 호출된다. 이를 통해 한도 상태를
  // 외부(SQLite)에 영속화한다. observe/noteRateLimited가 상태를 바꾼 경우에만 발화한다.
  onExhaustionChange?: () => void;
}

interface TokenSlot {
  token: string;
  // 토큰 식별용 비가역 지문(sha256 앞 16자). OAuth 토큰 원문은 비밀이라 영속 저장하지 않고,
  // 재시작 후 소진 상태 복원은 이 지문으로 매칭한다.
  fingerprint: string;
  // epoch ms. 이 시각 전까지는 소진 상태로 간주하고 선택에서 제외한다.
  exhaustedUntil: number | null;
  lastUtilization: number | null;
}

/** 영속/복원에 쓰는 토큰별 비밀-없는 상태 요약. */
export interface TokenSlotStatus {
  index: number;
  fingerprint: string;
  exhaustedUntil: number | null;
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
  private readonly onExhaustionChange: (() => void) | undefined;
  // 직전 select()가 고른 토큰. scope별로 살아있는 한 계속 같은 토큰을 쓰는(sticky) 선택의 기준이 된다.
  private readonly lastSelectedByScope = new Map<string, string>();

  constructor(tokens: string[], options: TokenPoolOptions = {}) {
    const unique = [...new Set(tokens.map((token) => token.trim()).filter(Boolean))];
    if (unique.length === 0) {
      throw new Error("TokenPool requires at least one OAuth token");
    }
    this.slots = unique.map((token) => ({
      token,
      fingerprint: createHash("sha256").update(token).digest("hex").slice(0, 16),
      exhaustedUntil: null,
      lastUtilization: null
    }));
    this.exhaustionUtilization =
      options.exhaustionUtilization ?? DEFAULT_EXHAUSTION_UTILIZATION;
    this.defaultBackoffMs = options.defaultBackoffMs ?? DEFAULT_BACKOFF_MS;
    this.onExhaustionChange = options.onExhaustionChange;
  }

  /** 영속용 토큰별 상태(비밀 없음). 등록 순서대로 지문과 소진 시각만 노출한다. */
  statuses(): TokenSlotStatus[] {
    return this.slots.map((slot, index) => ({
      index: index + 1,
      fingerprint: slot.fingerprint,
      exhaustedUntil: slot.exhaustedUntil
    }));
  }

  /**
   * 영속 상태 복원용: 지문으로 슬롯을 찾아 소진 시각을 되살린다. 모르는 지문(토큰 구성이
   * 바뀐 경우)이나 이미 회복된 시각은 무시한다. 복원은 onExhaustionChange를 발화하지 않는다.
   */
  restoreExhaustion(fingerprint: string, exhaustedUntil: number, now: number = Date.now()): void {
    if (!Number.isFinite(exhaustedUntil) || exhaustedUntil <= now) return;
    const slot = this.slots.find((item) => item.fingerprint === fingerprint);
    if (!slot) return;
    slot.exhaustedUntil = Math.max(slot.exhaustedUntil ?? 0, exhaustedUntil);
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
   * 사용할 토큰을 고른다. "마지막에 사용한 토큰 우선(sticky)" 전략:
   * 직전에 고른 토큰이 아직 살아있으면 그 토큰을 계속 쓴다. 그래야 한도 도달로 다음
   * 토큰으로 넘어간 뒤, 앞선 토큰이 회복되더라도 1순위로 되돌아가지 않고 현재 토큰을 유지한다.
   * 직전 토큰이 없거나 소진됐으면 등록 순서상 가장 앞의 살아있는 토큰을 고른다.
   * 전부 소진된 경우엔 가장 먼저 회복되는(=exhaustedUntil이 가장 이른) 토큰을 돌려준다.
   * 어떤 경우에도 토큰 하나는 반드시 반환하며, 반환한 토큰을 lastSelected로 기록한다.
   */
  select(now: number = Date.now(), scope = "default"): string {
    const lastSelected = this.lastSelectedByScope.get(scope) ?? null;
    // 직전에 고른 토큰이 아직 살아있으면 그대로 유지한다.
    if (lastSelected !== null) {
      const slot = this.slots.find((item) => item.token === lastSelected);
      if (slot && (slot.exhaustedUntil === null || slot.exhaustedUntil <= now)) {
        return lastSelected;
      }
    }
    // 등록 순서상 가장 앞의 살아있는 토큰.
    const available = this.slots.find(
      (slot) => slot.exhaustedUntil === null || slot.exhaustedUntil <= now
    );
    if (available) {
      this.lastSelectedByScope.set(scope, available.token);
      return available.token;
    }
    // 전부 소진: 회복이 가장 빠른(=exhaustedUntil이 가장 이른) 토큰을 시도한다.
    // 생성자에서 슬롯이 최소 1개임을 보장하므로 reduce는 항상 값을 반환한다.
    const soonest = this.slots.reduce((earliest, slot) =>
      (slot.exhaustedUntil ?? Infinity) < (earliest.exhaustedUntil ?? Infinity)
        ? slot
        : earliest
    );
    this.lastSelectedByScope.set(scope, soonest.token);
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
      const before = slot.exhaustedUntil;
      slot.exhaustedUntil = Math.max(slot.exhaustedUntil ?? 0, blockedUntil);
      if (slot.exhaustedUntil !== before) this.onExhaustionChange?.();
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
    const before = slot.exhaustedUntil;
    slot.exhaustedUntil = Math.max(slot.exhaustedUntil ?? 0, target);
    if (slot.exhaustedUntil !== before) this.onExhaustionChange?.();
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
