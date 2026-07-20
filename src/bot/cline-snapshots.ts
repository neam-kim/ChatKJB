import { randomBytes } from "node:crypto";

export const CLINE_PROVIDER_PAGE_SIZE = 8;
export const CLINE_MODEL_PAGE_SIZE = 10;
export const CLINE_SNAPSHOT_TTL_MS = 15 * 60 * 1000;

export type ClineSnapshotKind = "provider" | "model";

export interface ClineSnapshotItem {
  id: string;
  label: string;
  supportsReasoning?: boolean;
  providerId?: string;
}

export type ClineSnapshotTarget =
  | { kind: "defaults"; }
  | { kind: "session"; sessionId: string; };

export interface ClineSnapshotScope {
  userId: number;
  topicId: number | null;
  target: ClineSnapshotTarget;
  revision: string;
}

export type ClineSnapshotRequestScope = Omit<ClineSnapshotScope, "target"> & {
  target?: ClineSnapshotTarget;
};

export interface ClineSnapshot {
  nonce: string;
  kind: ClineSnapshotKind;
  scope: ClineSnapshotScope;
  items: readonly Readonly<ClineSnapshotItem>[];
  createdAt: number;
  expiresAt: number;
}

export type ClineSnapshotResolution =
  | { ok: true; snapshot: ClineSnapshot; item?: Readonly<ClineSnapshotItem>; page?: number; }
  | { ok: false; reason: "missing" | "expired" | "scope" | "stale" | "action"; };

function targetKey(target: ClineSnapshotTarget): string {
  return target.kind === "defaults" ? "defaults" : `session:${target.sessionId}`;
}

function sameScope(left: ClineSnapshotScope, right: ClineSnapshotScope): boolean {
  return left.userId === right.userId
    && left.topicId === right.topicId
    && targetKey(left.target) === targetKey(right.target);
}

function matchesRequest(snapshot: ClineSnapshotScope, request: ClineSnapshotRequestScope): boolean {
  return snapshot.userId === request.userId
    && snapshot.topicId === request.topicId
    && (!request.target || targetKey(snapshot.target) === targetKey(request.target));
}

export function clineCatalogRevision(value: unknown): string {
  // Provider/model ids and public capability flags are already sanitized at the SDK adapter
  // boundary. A deterministic JSON representation is sufficient to reject reordered/stale UI.
  return JSON.stringify(value);
}

export class ClineSnapshotStore {
  private readonly snapshots = new Map<string, ClineSnapshot>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly nonce: () => string = () => randomBytes(12).toString("base64url")
  ) {}

  create(
    kind: ClineSnapshotKind,
    scope: ClineSnapshotScope,
    items: readonly ClineSnapshotItem[]
  ): ClineSnapshot {
    this.prune();
    for (const [nonce, snapshot] of this.snapshots) {
      if (snapshot.kind === kind && sameScope(snapshot.scope, scope)) this.snapshots.delete(nonce);
    }
    const createdAt = this.now();
    const snapshot: ClineSnapshot = Object.freeze({
      nonce: this.uniqueNonce(),
      kind,
      scope: Object.freeze({ ...scope, target: Object.freeze({ ...scope.target }) }),
      items: Object.freeze(items.map((item) => Object.freeze({ ...item }))),
      createdAt,
      expiresAt: createdAt + CLINE_SNAPSHOT_TTL_MS
    });
    this.snapshots.set(snapshot.nonce, snapshot);
    return snapshot;
  }

  resolve(
    kind: ClineSnapshotKind,
    nonce: string,
    action: string,
    scope: ClineSnapshotRequestScope
  ): ClineSnapshotResolution {
    const snapshot = this.snapshots.get(nonce);
    if (!snapshot || snapshot.kind !== kind) return { ok: false, reason: "missing" };
    if (snapshot.expiresAt <= this.now()) {
      this.snapshots.delete(nonce);
      return { ok: false, reason: "expired" };
    }
    if (!matchesRequest(snapshot.scope, scope)) return { ok: false, reason: "scope" };
    if (snapshot.scope.revision !== scope.revision) return { ok: false, reason: "stale" };
    const match = /^([ip])(\d+)$/.exec(action);
    if (!match) return { ok: false, reason: "action" };
    const value = Number.parseInt(match[2]!, 10);
    if (!Number.isSafeInteger(value) || value < 0) return { ok: false, reason: "action" };
    if (match[1] === "p") return { ok: true, snapshot, page: value };
    const item = snapshot.items[value];
    return item ? { ok: true, snapshot, item } : { ok: false, reason: "action" };
  }

  private uniqueNonce(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const nonce = this.nonce();
      if (/^[A-Za-z0-9_-]{16}$/.test(nonce) && !this.snapshots.has(nonce)) return nonce;
    }
    throw new Error("Cline callback snapshot nonce를 만들 수 없습니다.");
  }

  private prune(): void {
    const now = this.now();
    for (const [nonce, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= now) this.snapshots.delete(nonce);
    }
  }
}

const stores = new WeakMap<object, ClineSnapshotStore>();

export function clineSnapshotStoreFor(owner: object): ClineSnapshotStore {
  const current = stores.get(owner);
  if (current) return current;
  const created = new ClineSnapshotStore();
  stores.set(owner, created);
  return created;
}
