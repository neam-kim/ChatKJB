import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchGrokLiveUsage, snapshotFromGrokBilling } from "../src/grok-live-usage.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function writeGrokAuth(home: string, token: string, expiresAt: string): Promise<void> {
  await mkdir(join(home, ".grok"), { recursive: true });
  await writeFile(join(home, ".grok", "auth.json"), JSON.stringify({
    "https://auth.x.ai::test": { key: token, expires_at: expiresAt, refresh_token: "refresh" }
  }));
}

function billingResponse(status: number): Response {
  return new Response(status === 200 ? JSON.stringify({
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
      creditUsagePercent: 42,
      productUsage: []
    }
  }) : "", {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("snapshotFromGrokBilling", () => {
  it("normalizes the credits payload the grok billing API actually returns", () => {
    const snapshot = snapshotFromGrokBilling({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-11T04:24:10.645396+00:00",
          end: "2026-07-18T04:24:10.645396+00:00"
        },
        creditUsagePercent: 61.0,
        // 금액 필드는 {"val": n}으로 감싸 온다.
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        prepaidBalance: { val: 12.5 },
        productUsage: [
          { product: "GrokBuild", usagePercent: 59.0 },
          { product: "Api" }
        ],
        billingPeriodStart: "2026-07-11T04:24:10.645396+00:00"
      }
    }, 1_000);

    expect(snapshot).toEqual({
      capturedAt: 1_000,
      creditUsagePercent: 61,
      periodType: "USAGE_PERIOD_TYPE_WEEKLY",
      periodStart: "2026-07-11T04:24:10.645396+00:00",
      periodEnd: "2026-07-18T04:24:10.645396+00:00",
      productUsage: [
        { product: "GrokBuild", usagePercent: 59 },
        // 이번 주기에 쓰지 않은 제품은 usagePercent가 아예 없다.
        { product: "Api", usagePercent: null }
      ],
      onDemandCap: 0,
      onDemandUsed: 0,
      prepaidBalance: 12.5
    });
  });

  it("rejects payloads without a config block instead of inventing zeros", () => {
    expect(snapshotFromGrokBilling({})).toBeNull();
    expect(snapshotFromGrokBilling(null)).toBeNull();
    expect(snapshotFromGrokBilling("nope")).toBeNull();
  });
});

describe("fetchGrokLiveUsage", () => {
  it("asks the Grok CLI to refresh an expired access token before billing lookup", async () => {
    const home = await mkdtemp(join(tmpdir(), "chatkjb-grok-usage-"));
    tempDirectories.push(home);
    await writeGrokAuth(home, "expired", "2020-01-01T00:00:00Z");
    let refreshCount = 0;
    const requestedTokens: string[] = [];

    const result = await fetchGrokLiveUsage({
      home,
      refreshAuth: async () => {
        refreshCount += 1;
        await writeGrokAuth(home, "fresh", "2099-01-01T00:00:00Z");
      },
      fetchImpl: async (_input, init) => {
        requestedTokens.push(new Headers(init?.headers).get("authorization") ?? "");
        return billingResponse(200);
      }
    });

    expect(refreshCount).toBe(1);
    expect(requestedTokens).toEqual(["Bearer fresh"]);
    expect(result.snapshot?.creditUsagePercent).toBe(42);
    expect(result.error).toBeNull();
  });

  it("refreshes once and retries when billing rejects a token not marked expired", async () => {
    const home = await mkdtemp(join(tmpdir(), "chatkjb-grok-usage-"));
    tempDirectories.push(home);
    await writeGrokAuth(home, "revoked", "2099-01-01T00:00:00Z");
    let refreshCount = 0;
    const requestedTokens: string[] = [];

    const result = await fetchGrokLiveUsage({
      home,
      refreshAuth: async () => {
        refreshCount += 1;
        await writeGrokAuth(home, "fresh", "2099-01-01T00:00:00Z");
      },
      fetchImpl: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        requestedTokens.push(authorization);
        return billingResponse(authorization === "Bearer fresh" ? 200 : 401);
      }
    });

    expect(refreshCount).toBe(1);
    expect(requestedTokens).toEqual(["Bearer revoked", "Bearer fresh"]);
    expect(result.snapshot?.creditUsagePercent).toBe(42);
    expect(result.error).toBeNull();
  });
});
