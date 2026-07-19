export interface TransientMapOptions {
  ttlMs: number;
  maxEntries: number;
  cleanupIntervalMs?: number;
  now?: () => number;
}

/**
 * 사용자 입력을 기다리는 짧은 UI 상태를 보관한다.
 *
 * 일반 Map과 같은 표면을 유지하되 오래 방치된 항목과 과도한 항목 수를 자동으로
 * 정리한다. 항목마다 타이머를 만들지 않고 하나의 unref 정리 타이머만 사용한다.
 */
export class TransientMap<K, V> extends Map<K, V> {
  private readonly expiresAt = new Map<K, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(options: TransientMapOptions) {
    super();
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("TransientMap ttlMs must be greater than zero");
    }
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new Error("TransientMap maxEntries must be a positive integer");
    }
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? Date.now;
    const cleanupIntervalMs = options.cleanupIntervalMs
      ?? Math.min(this.ttlMs, 60_000);
    this.cleanupTimer = setInterval(() => this.prune(), cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  override set(key: K, value: V): this {
    this.prune();
    if (super.has(key)) super.delete(key);
    while (super.size >= this.maxEntries) {
      const oldest = super.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
    super.set(key, value);
    this.expiresAt.set(key, this.now() + this.ttlMs);
    return this;
  }

  override get(key: K): V | undefined {
    if (this.isExpired(key)) {
      this.delete(key);
      return undefined;
    }
    return super.get(key);
  }

  override has(key: K): boolean {
    if (this.isExpired(key)) {
      this.delete(key);
      return false;
    }
    return super.has(key);
  }

  override delete(key: K): boolean {
    this.expiresAt.delete(key);
    return super.delete(key);
  }

  override clear(): void {
    this.expiresAt.clear();
    super.clear();
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.clear();
  }

  private isExpired(key: K): boolean {
    const expiry = this.expiresAt.get(key);
    return expiry !== undefined && expiry <= this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, expiry] of this.expiresAt) {
      if (expiry <= now) this.delete(key);
    }
  }
}
