import { describe, expect, it } from "vitest";
import {
  CLINE_SNAPSHOT_TTL_MS,
  ClineSnapshotStore,
  clineCatalogRevision
} from "../src/bot/cline-snapshots.js";

const scope = {
  userId: 7,
  topicId: 42,
  target: { kind: "session" as const, sessionId: "session-1" },
  revision: clineCatalogRevision([{ id: "provider-1", models: ["model-1"] }])
};

describe("Cline callback snapshots", () => {
  it("keeps callback payloads short and resolves immutable indexed items", () => {
    const store = new ClineSnapshotStore(() => 1_000, () => "abcdefghijklmnop");
    const source = [{ id: "x".repeat(300), label: "Long model" }];
    const snapshot = store.create("model", scope, source);
    source[0]!.id = "mutated";

    const callback = `clm:${snapshot.nonce}:i0`;
    expect(Buffer.byteLength(callback, "utf8")).toBeLessThan(64);
    expect(store.resolve("model", snapshot.nonce, "i0", scope)).toMatchObject({
      ok: true,
      item: { id: "x".repeat(300), label: "Long model" }
    });
  });

  it("rejects expired, cross-scope, and catalog-stale callbacks", () => {
    let now = 1_000;
    let nonce = 0;
    const store = new ClineSnapshotStore(() => now, () => `${String(++nonce).padStart(16, "a")}`);

    const crossScope = store.create("provider", scope, [{ id: "p1", label: "P1" }]);
    expect(store.resolve("provider", crossScope.nonce, "i0", { ...scope, userId: 8 }))
      .toEqual({ ok: false, reason: "scope" });

    const stale = store.create("provider", scope, [{ id: "p1", label: "P1" }]);
    expect(store.resolve("provider", stale.nonce, "i0", { ...scope, revision: "changed" }))
      .toEqual({ ok: false, reason: "stale" });

    const expired = store.create("provider", scope, [{ id: "p1", label: "P1" }]);
    now += CLINE_SNAPSHOT_TTL_MS;
    expect(store.resolve("provider", expired.nonce, "i0", scope))
      .toEqual({ ok: false, reason: "expired" });
  });

  it("replaces an older snapshot for the same kind and scope", () => {
    let nonce = 0;
    const store = new ClineSnapshotStore(() => 1_000, () => `${String(++nonce).padStart(16, "b")}`);
    const first = store.create("provider", scope, [{ id: "p1", label: "P1" }]);
    const second = store.create("provider", scope, [{ id: "p2", label: "P2" }]);

    expect(store.resolve("provider", first.nonce, "i0", scope)).toEqual({ ok: false, reason: "missing" });
    expect(store.resolve("provider", second.nonce, "p0", scope)).toMatchObject({ ok: true, page: 0 });
  });
});
