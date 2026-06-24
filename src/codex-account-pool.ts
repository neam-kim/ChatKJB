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
  private slots: { home: string; exhaustedUntil: number | null }[];
  private lastSelected: string | null = null;
  private readonly defaultBackoffMs: number;

  constructor(homes: string[], options: CodexAccountPoolOptions = {}) {
    const deduped = Array.from(new Set(homes.map(home => home.trim()).filter(home => home.length > 0)));
    if (deduped.length === 0) {
      throw new Error("CodexAccountPool requires at least one CODEX_HOME");
    }
    this.slots = deduped.map(home => ({ home, exhaustedUntil: null }));
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

  markFailed(home: string, now: number = Date.now(), until?: number): void {
    const slot = this.slots.find((s) => s.home === home);
    if (!slot) return;

    if (until === undefined && slot.exhaustedUntil !== null && slot.exhaustedUntil > now) {
      return;
    }

    const backoff = until ?? now + this.defaultBackoffMs;
    slot.exhaustedUntil = Math.max(slot.exhaustedUntil ?? -Infinity, backoff);
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
        const recoverTime = new Date(slot.exhaustedUntil).toISOString();
        lines.push(`Codex 계정 #${i + 1}: 소진 (${recoverTime} 회복)`);
      } else {
        lines.push(`Codex 계정 #${i + 1}: 사용 가능`);
      }
    }
    return lines.join("\n");
  }
}
