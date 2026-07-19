import { appLocale, appTimeZone } from "./localization.js";

export interface CodexAccountPoolOptions {
  defaultBackoffMs?: number;
}

export interface CodexAccountStatus {
  index: number;
  home: string;
  exhaustedUntil: number | null;
  available: boolean;
}

const DEFAULT_BACKOFF_MS = 60 * 60 * 1000;

export class CodexAccountPool {
  private slots: Array<{
    home: string;
    // blocks의 가장 늦은 회복 시각으로 파생되는 캐시다. 오류·재시작 복원처럼 근거가
    // 불완전한 봉인은 다음 실시간 한도 조회가 최신 상태로 대체할 수 있어야 한다.
    exhaustedUntil: number | null;
    blocks: Map<string, number>;
  }>;
  private lastSelected: string | null = null;
  private readonly defaultBackoffMs: number;

  constructor(homes: string[], options: CodexAccountPoolOptions = {}) {
    const deduped = Array.from(new Set(homes.map(home => home.trim()).filter(home => home.length > 0)));
    if (deduped.length === 0) {
      throw new Error("CodexAccountPool requires at least one CODEX_HOME");
    }
    this.slots = deduped.map(home => ({ home, exhaustedUntil: null, blocks: new Map() }));
    this.defaultBackoffMs = options.defaultBackoffMs ?? DEFAULT_BACKOFF_MS;
  }

  get size(): number {
    return this.slots.length;
  }

  indexOf(home: string): number {
    return this.slots.findIndex(slot => slot.home === home);
  }

  select(now: number = Date.now()): string {
    if (this.lastSelected !== null) {
      const lastSlot = this.slots.find((slot) => slot.home === this.lastSelected);
      if (lastSlot && (lastSlot.exhaustedUntil === null || lastSlot.exhaustedUntil <= now)) {
        return this.lastSelected;
      }
    }

    // 찾기: 사용 가능한 계정
    for (const slot of this.slots) {
      if (slot.exhaustedUntil === null || slot.exhaustedUntil <= now) {
        this.lastSelected = slot.home;
        return slot.home;
      }
    }

    // 없으면 가장 빨리 회복되는 계정 선택
    let soonest = Infinity;
    let chosenHome: string | null = null;
    for (const slot of this.slots) {
      if (slot.exhaustedUntil !== null && slot.exhaustedUntil < soonest) {
        soonest = slot.exhaustedUntil;
        chosenHome = slot.home;
      }
    }

    if (chosenHome !== null) {
      this.lastSelected = chosenHome;
      return chosenHome;
    }

    // 이론적으로 여기까지 오면 안 됨
    throw new Error("Unexpected state in CodexAccountPool.select");
  }

  selectNext(afterHome?: string | null, now: number = Date.now()): string {
    const startIndex = afterHome ? this.indexOf(afterHome) : this.indexOf(this.lastSelected ?? "");
    const offset = startIndex >= 0 ? startIndex + 1 : 0;

    for (let step = 0; step < this.slots.length; step += 1) {
      const slot = this.slots[(offset + step) % this.slots.length];
      if (!slot) continue;
      if (slot.exhaustedUntil === null || slot.exhaustedUntil <= now) {
        this.lastSelected = slot.home;
        return slot.home;
      }
    }

    let soonest = Infinity;
    let chosenHome: string | null = null;
    for (const slot of this.slots) {
      if (slot.exhaustedUntil !== null && slot.exhaustedUntil < soonest) {
        soonest = slot.exhaustedUntil;
        chosenHome = slot.home;
      }
    }

    if (chosenHome !== null) {
      this.lastSelected = chosenHome;
      return chosenHome;
    }

    throw new Error("Unexpected state in CodexAccountPool.selectNext");
  }

  markFailed(home: string, now: number = Date.now(), until?: number): void {
    const slot = this.slots.find((s) => s.home === home);
    if (!slot) return;

    if (until === undefined && slot.exhaustedUntil !== null && slot.exhaustedUntil > now) {
      return;
    }

    const backoff = until ?? now + this.defaultBackoffMs;
    slot.blocks.set("error", Math.max(slot.blocks.get("error") ?? -Infinity, backoff));
    this.recomputeExhaustion(slot, now);
  }

  /** 재시작 전 상태는 한도 창 근거가 유실된 잠정 봉인으로만 복원한다. */
  restoreExhaustion(home: string, exhaustedUntil: number, now: number = Date.now()): void {
    const slot = this.slots.find((s) => s.home === home);
    if (!slot || !Number.isFinite(exhaustedUntil)) return;
    slot.blocks.set("restored", Math.max(slot.blocks.get("restored") ?? -Infinity, exhaustedUntil));
    this.recomputeExhaustion(slot, now);
  }

  /**
   * app-server의 최신 한도 조회는 권위 있는 상태다. 과거 오류/재시작 봉인은 모두
   * 버리고, 실제로 소진된 현재 한도만 남긴다. 따라서 잘못 분류된 오류가 B·C 계정을
   * 재시작 뒤까지 막아 두는 일이 없다.
   */
  setExhaustion(home: string, exhaustedUntil: number | null): void {
    const slot = this.slots.find((s) => s.home === home);
    if (!slot) return;
    slot.blocks.clear();
    if (exhaustedUntil !== null && Number.isFinite(exhaustedUntil)) {
      slot.blocks.set("live", exhaustedUntil);
    }
    this.recomputeExhaustion(slot, Date.now());
  }

  private recomputeExhaustion(
    slot: { exhaustedUntil: number | null; blocks: Map<string, number>; },
    _now: number
  ): void {
    let exhaustedUntil: number | null = null;
    for (const until of slot.blocks.values()) {
      exhaustedUntil = exhaustedUntil === null ? until : Math.max(exhaustedUntil, until);
    }
    slot.exhaustedUntil = exhaustedUntil;
  }

  isExhausted(home: string, now: number = Date.now()): boolean {
    const slot = this.slots.find((s) => s.home === home);
    if (!slot) return false;
    return slot.exhaustedUntil !== null && slot.exhaustedUntil > now;
  }

  recoversAt(now: number = Date.now()): number | null {
    let earliestRecover = Infinity;
    let hasHealthy = false;

    for (const slot of this.slots) {
      if (slot.exhaustedUntil === null || slot.exhaustedUntil <= now) {
        hasHealthy = true;
        break;
      } else if (slot.exhaustedUntil < earliestRecover) {
        earliestRecover = slot.exhaustedUntil;
      }
    }

    if (hasHealthy) return null;
    return earliestRecover === Infinity ? null : earliestRecover;
  }

  statuses(now: number = Date.now()): CodexAccountStatus[] {
    return this.slots.map((slot, index) => ({
      index: index + 1,
      home: slot.home,
      exhaustedUntil: slot.exhaustedUntil,
      available: slot.exhaustedUntil === null || slot.exhaustedUntil <= now
    }));
  }

  describe(now: number = Date.now()): string {
    const lines: string[] = [];
    for (const [i, slot] of this.slots.entries()) {
      if (slot.exhaustedUntil === null) {
        lines.push(`Codex 계정 #${i + 1}: 사용 가능`);
      } else if (slot.exhaustedUntil > now) {
        const recoverTime = new Date(slot.exhaustedUntil).toLocaleString(appLocale(), { timeZone: appTimeZone() });
        lines.push(`Codex 계정 #${i + 1}: 소진 (${recoverTime} 회복)`);
      } else {
        lines.push(`Codex 계정 #${i + 1}: 사용 가능`);
      }
    }
    return lines.join("\n");
  }
}
