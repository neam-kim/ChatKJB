import { createHash } from "node:crypto";
import { appLocale, appTimeZone } from "./localization.js";
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
  // blocks의 최댓값으로 파생되는 캐시 값이다(직접 쓰지 말고 recomputeExhaustion을 거친다).
  exhaustedUntil: number | null;
  // 봉인 근거별(한도 창 key, 텍스트 오류="error", 재시작 복원="restored") 만료 시각.
  // 창이 다시 정상으로 보고되면 해당 근거만 지워 봉인을 자동으로 낮춘다(자가 치유).
  blocks: Map<string, number>;
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
    this.slots = unique.map((token) => ({
      token,
      fingerprint: createHash("sha256").update(token).digest("hex").slice(0, 16),
      exhaustedUntil: null,
      blocks: new Map<string, number>(),
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
    // 재시작 복원분은 어느 한도 창이 걸었는지 정보가 유실된 "잠정" 봉인이다. 다음 권위 있는
    // 사용량 읽기가 소진 창을 하나도 보고하지 않으면 observe에서 해제되어, stale 봉인이
    // 재시작으로 부활해 무기한 남는 문제를 막는다.
    slot.blocks.set("restored", Math.max(slot.blocks.get("restored") ?? 0, exhaustedUntil));
    this.recomputeExhaustion(slot, now, true);
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
    if (this.slots.length === 0) {
      throw new Error("Claude OAuth 인증이 없어 Claude 기능을 사용할 수 없습니다.");
    }
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
    // 빈 풀은 함수 시작에서 거절했으므로 reduce는 항상 값을 반환한다.
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
   * 소진된 한도 창은 그 창의 resetsAt까지 봉인하고, 정상으로 보고된 창은 지난 봉인을
   * 해제한다(창별 자가 치유). 소진 창이 하나도 없는 권위 있는 읽기는 창 정보가 유실된
   * 잠정/오류 봉인(restored·error)도 함께 해제해, stale 봉인이 무기한 남지 않게 한다.
   */
  observe(
    token: string,
    snapshot: UsageSnapshot | null,
    now: number = Date.now()
  ): void {
    const slot = this.slots.find((item) => item.token === token);
    if (!slot || !snapshot) return;

    const windows: Array<[string, UsageWindow | undefined]> = [
      ["fiveHour", snapshot.fiveHour],
      ["sevenDay", snapshot.sevenDay],
      ["sevenDayOpus", snapshot.sevenDayOpus],
      ["sevenDaySonnet", snapshot.sevenDaySonnet],
      ["agentSdkWeekly", snapshot.agentSdkWeekly]
    ];

    // 권위 있는 읽기 = 한도 정보가 있고(rateLimitsAvailable) 창을 하나 이상 실제로 보고한 경우.
    // get_usage 응답은 소진된 창을 실제로 노출하므로, 이런 읽기가 소진 창을 하나도 담지
    // 않으면 그 순간 토큰은 소진 상태가 아니라고 판단할 수 있다.
    const present = windows.filter(([, window]) => window !== undefined);
    const authoritative = snapshot.rateLimitsAvailable && present.length > 0;

    let maxUtilization: number | null = null;
    let anyExhausted = false;
    for (const [key, window] of windows) {
      if (!window) continue;
      if (typeof window.utilization === "number") {
        maxUtilization = Math.max(maxUtilization ?? 0, window.utilization);
      }
      if (this.windowIsExhausted(window)) {
        anyExhausted = true;
        const until = parseResetsAt(window.resetsAt) ?? now + this.defaultBackoffMs;
        slot.blocks.set(key, until);
      } else {
        // 창이 보고됐고 소진 상태가 아니면 그 창에 대한 지난 봉인을 해제한다.
        slot.blocks.delete(key);
      }
    }
    if (authoritative) {
      // 권위 있는 읽기는 모든 한도 창의 현재 상태를 담으므로, 창 정보가 유실된 잠정 봉인
      // (restored)은 소진 창이 남아 있든 아니든 버린다 — 진짜로 소진된 창은 위 루프에서
      // 자기 key로 다시 잡히고, stale 복원값이 실제 창 봉인을 덮어쓰는 일을 막는다.
      slot.blocks.delete("restored");
      // 텍스트 오류 봉인(error)은 소진 창이 하나도 없을 때만 해제한다(막 거부당한 직후의
      // 최종 일관성 지연을 감안해 보수적으로).
      if (!anyExhausted) slot.blocks.delete("error");
    }

    slot.lastUtilization = maxUtilization;
    this.recomputeExhaustion(slot, now);
  }

  /**
   * 남아 있는 봉인 근거(blocks)의 최댓값으로 exhaustedUntil을 다시 계산한다. 이미 지난
   * 근거는 제거한다. 값이 실제로 바뀌면 onExhaustionChange를 발화한다(silent=true면 억제 —
   * 발화가 곧 영속화를 부르는 복원 경로에서만 쓴다).
   */
  private recomputeExhaustion(slot: TokenSlot, now: number, silent = false): void {
    for (const [key, until] of slot.blocks) {
      if (until <= now) slot.blocks.delete(key);
    }
    let max: number | null = null;
    for (const until of slot.blocks.values()) {
      max = max === null ? until : Math.max(max, until);
    }
    const before = slot.exhaustedUntil;
    slot.exhaustedUntil = max;
    if (!silent && slot.exhaustedUntil !== before) this.onExhaustionChange?.();
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
    slot.blocks.set("error", Math.max(slot.blocks.get("error") ?? 0, target));
    this.recomputeExhaustion(slot, now);
  }

  /** 진단/로그용 요약. */
  describe(now: number = Date.now()): string {
    return this.slots
      .map((slot, index) => {
        const state = this.isExhausted(slot.token, now)
          ? `소진 (${new Date(slot.exhaustedUntil as number).toLocaleString(appLocale(), { timeZone: appTimeZone() })} 회복)`
          : "사용 가능";
        const util = slot.lastUtilization === null
          ? ""
          : ` · 최근 사용률 ${Math.round(slot.lastUtilization)}%`;
        return `토큰 #${index + 1}: ${state}${util}`;
      })
      .join("\n");
  }
}
