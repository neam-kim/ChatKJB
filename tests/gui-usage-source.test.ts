import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCachedUsageProvider,
  createUsageProvider
} from "../src/gui/usage-source.js";
import type { GuiUsageProvider } from "../src/gui/protocol.js";
import type { CodexLiveUsageOptions, CodexLiveUsageResult } from "../src/codex-live-usage.js";
import type { GrokLiveUsageResult } from "../src/grok-live-usage.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureDatabase(rows: Array<{ id: string; updatedAt: number; snapshot: unknown }>): string {
  const directory = mkdtempSync(join(tmpdir(), "chatkjb-usage-source-"));
  directories.push(directory);
  const databasePath = join(directory, "state.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, usage_snapshot TEXT)");
  const insert = db.prepare("INSERT INTO sessions (id, updated_at, usage_snapshot) VALUES (?, ?, ?)");
  for (const row of rows) {
    insert.run(row.id, row.updatedAt, row.snapshot === null ? null : JSON.stringify(row.snapshot));
  }
  db.close();
  return databasePath;
}

function sourceOptions(overrides: Record<string, unknown> = {}) {
  return {
    databasePath: join(tmpdir(), "chatkjb-usage-source-missing", "state.sqlite"),
    codexExecutable: "codex",
    codexHome: "/tmp/codex-homes/.codex",
    grokExecutable: "grok",
    ...overrides
  } as Parameters<typeof createUsageProvider>[0];
}

function codexResult(snapshot: Partial<CodexLiveUsageResult["snapshot"]> | null): CodexLiveUsageResult {
  return {
    snapshot: snapshot === null ? null : {
      capturedAt: 1_784_600_000_000,
      planType: "pro",
      primary: null,
      secondary: null,
      resetCreditsAvailable: null,
      creditsBalance: null,
      rateLimitReachedType: null,
      lifetimeTokens: null,
      peakDailyTokens: null,
      currentStreakDays: null,
      ...snapshot
    } as CodexLiveUsageResult["snapshot"],
    error: snapshot === null ? "codex 조회 실패" : null
  };
}

function grokResult(
  snapshot: Partial<NonNullable<GrokLiveUsageResult["snapshot"]>> | null,
  error: string | null = null
): GrokLiveUsageResult {
  return {
    snapshot: snapshot === null ? null : {
      capturedAt: 1_784_600_000_000,
      creditUsagePercent: null,
      periodType: null,
      periodStart: null,
      periodEnd: null,
      productUsage: [],
      onDemandCap: null,
      onDemandUsed: null,
      prepaidBalance: null,
      ...snapshot
    },
    error: snapshot === null ? (error ?? "grok 조회 실패") : null
  };
}

describe("createUsageProvider — Claude 스냅샷", () => {
  it("가장 최근 갱신된 세션의 usage_snapshot을 읽어 창을 매핑한다", async () => {
    const databasePath = fixtureDatabase([
      {
        id: "older",
        updatedAt: 1_000,
        snapshot: { capturedAt: 900, fiveHour: { utilization: 11, resetsAt: "a" }, sevenDay: { utilization: 22, resetsAt: "b" } }
      },
      { id: "no-snapshot", updatedAt: 3_000, snapshot: null },
      {
        id: "newer",
        updatedAt: 2_000,
        snapshot: { capturedAt: 1_500, fiveHour: { utilization: 42, resetsAt: "c" }, sevenDay: { utilization: 7, resetsAt: "d" } }
      }
    ]);
    const provider = createUsageProvider(sourceOptions({ databasePath, now: () => 2_000 }));
    const usage = await provider.fetchClaudeUsage();
    expect(usage).toEqual({
      fiveHour: { utilization: 42, resetsAt: "c" },
      sevenDay: { utilization: 7, resetsAt: "d" },
      stale: false,
      capturedAt: 1_500
    });
  });

  it("스냅샷 부재·DB 부재·JSON 파손은 값 부재로 돌려준다", async () => {
    const empty = fixtureDatabase([{ id: "x", updatedAt: 1, snapshot: null }]);
    const provider = createUsageProvider(sourceOptions({ databasePath: empty }));
    expect(await provider.fetchClaudeUsage()).toEqual({
      fiveHour: null,
      sevenDay: null,
      stale: false,
      capturedAt: null
    });

    const missing = createUsageProvider(sourceOptions());
    expect((await missing.fetchClaudeUsage()).capturedAt).toBeNull();

    const broken = fixtureDatabase([]);
    const db = new DatabaseSync(broken);
    db.prepare("INSERT INTO sessions (id, updated_at, usage_snapshot) VALUES (?, ?, ?)").run("bad", 5, "{not json");
    db.close();
    const brokenProvider = createUsageProvider(sourceOptions({ databasePath: broken }));
    expect((await brokenProvider.fetchClaudeUsage()).capturedAt).toBeNull();
  });

  it("창이 없는 최신 스냅샷보다 한도 창이 있는 최근 스냅샷을 고른다", async () => {
    const databasePath = fixtureDatabase([
      {
        id: "empty-newer",
        updatedAt: 9_000,
        snapshot: { capturedAt: 9_000, rateLimitsAvailable: false }
      },
      {
        id: "rich-older",
        updatedAt: 8_000,
        snapshot: {
          capturedAt: 8_000,
          rateLimitsAvailable: true,
          fiveHour: { utilization: 77, resetsAt: "h" },
          sevenDay: { utilization: 55, resetsAt: "w" }
        }
      }
    ]);
    const usage = await createUsageProvider(sourceOptions({ databasePath, now: () => 8_000 })).fetchClaudeUsage();
    expect(usage).toEqual({
      fiveHour: { utilization: 77, resetsAt: "h" },
      sevenDay: { utilization: 55, resetsAt: "w" },
      stale: false,
      capturedAt: 8_000
    });
  });

  it("부분 스냅샷을 창별로 병합해 5h·1w 최신 실측값을 함께 채운다", async () => {
    // 실측 회귀: 최신 스냅샷은 fiveHour.utilization=null(resetsAt만)·sevenDay 부재라
    // 하나만 고르면 5h·1w가 모두 "—"로 빈다. 창별 최신 실측값을 병합해야 한다.
    const databasePath = fixtureDatabase([
      {
        id: "latest-null-five",
        updatedAt: 3_000,
        snapshot: { capturedAt: 3_000, rateLimitsAvailable: true, fiveHour: { utilization: null, resetsAt: "z" } }
      },
      {
        id: "mid-five",
        updatedAt: 2_000,
        snapshot: { capturedAt: 2_000, rateLimitsAvailable: true, fiveHour: { utilization: 61, resetsAt: "f" } }
      },
      {
        id: "old-seven",
        updatedAt: 1_000,
        snapshot: { capturedAt: 1_000, rateLimitsAvailable: true, sevenDay: { utilization: 88, resetsAt: "w" } }
      }
    ]);
    const usage = await createUsageProvider(sourceOptions({ databasePath, now: () => 3_000 })).fetchClaudeUsage();
    expect(usage.fiveHour).toEqual({ utilization: 61, resetsAt: "f" });
    expect(usage.sevenDay).toEqual({ utilization: 88, resetsAt: "w" });
    expect(usage.capturedAt).toBe(2_000);
  });

  it("초기화 시각이 지난 창은 이전 주기 값으로 병합하지 않는다", async () => {
    const databasePath = fixtureDatabase([
      {
        id: "latest-five",
        updatedAt: 10_000,
        snapshot: {
          capturedAt: 10_000,
          rateLimitsAvailable: true,
          fiveHour: { utilization: 7, resetsAt: "1970-01-01T00:00:20.000Z" }
        }
      },
      {
        id: "expired-week",
        updatedAt: 9_000,
        snapshot: {
          capturedAt: 9_000,
          rateLimitsAvailable: true,
          sevenDay: { utilization: 100, resetsAt: "1970-01-01T00:00:09.000Z" }
        }
      }
    ]);
    const usage = await createUsageProvider(sourceOptions({ databasePath, now: () => 10_000 })).fetchClaudeUsage();
    expect(usage.fiveHour).toEqual({ utilization: 7, resetsAt: "1970-01-01T00:00:20.000Z" });
    expect(usage.sevenDay).toBeNull();
    expect(usage.capturedAt).toBe(10_000);
  });

  it("만료된 창만 있는 fallback도 이전 사용률을 노출하지 않는다", async () => {
    const databasePath = fixtureDatabase([
      {
        id: "expired-only",
        updatedAt: 9_000,
        snapshot: {
          capturedAt: 9_000,
          rateLimitsAvailable: true,
          sevenDay: { utilization: 100, resetsAt: "1970-01-01T00:00:09.000Z" }
        }
      }
    ]);
    const usage = await createUsageProvider(sourceOptions({ databasePath, now: () => 10_000 })).fetchClaudeUsage();
    expect(usage.fiveHour).toBeNull();
    expect(usage.sevenDay).toBeNull();
    expect(usage.capturedAt).toBe(9_000);
  });

  it("실측 utilization이 하나도 없으면 최신 스냅샷을 그대로 폴백한다", async () => {
    const databasePath = fixtureDatabase([
      {
        id: "only-resets",
        updatedAt: 5_000,
        snapshot: { capturedAt: 5_000, rateLimitsAvailable: true, fiveHour: { utilization: null, resetsAt: "z" } }
      }
    ]);
    const usage = await createUsageProvider(sourceOptions({ databasePath, now: () => 5_000 })).fetchClaudeUsage();
    expect(usage.fiveHour).toEqual({ utilization: null, resetsAt: "z" });
    expect(usage.sevenDay).toBeNull();
    expect(usage.capturedAt).toBe(5_000);
  });

  it("capturedAt이 stale 임계(6시간)를 넘기면 stale로 표시한다", async () => {
    const now = 10 * 3_600_000;
    const databasePath = fixtureDatabase([
      { id: "old", updatedAt: 1, snapshot: { capturedAt: now - 7 * 3_600_000, fiveHour: { utilization: 3, resetsAt: null } } }
    ]);
    const provider = createUsageProvider(sourceOptions({ databasePath, now: () => now }));
    const usage = await provider.fetchClaudeUsage();
    expect(usage.stale).toBe(true);
    expect(usage.fiveHour).toEqual({ utilization: 3, resetsAt: null });

    const freshDatabase = fixtureDatabase([
      { id: "fresh", updatedAt: 1, snapshot: { capturedAt: now - 3_600_000, fiveHour: { utilization: 3, resetsAt: null } } }
    ]);
    const freshProvider = createUsageProvider(sourceOptions({ databasePath: freshDatabase, now: () => now }));
    expect((await freshProvider.fetchClaudeUsage()).stale).toBe(false);
  });
});
describe("createUsageProvider — Codex 창 매핑", () => {
  it("windowDurationMins 300/10080을 primary/secondary 위치와 무관하게 매핑한다", async () => {
    const calls: CodexLiveUsageOptions[] = [];
    const provider = createUsageProvider(sourceOptions({
      fetchCodex: async (options: CodexLiveUsageOptions) => {
        calls.push(options);
        return codexResult({
          primary: { usedPercent: 11, windowDurationMins: 10_080, resetsAt: "w" },
          secondary: { usedPercent: 42, windowDurationMins: 300, resetsAt: "h" }
        });
      }
    }));
    const usage = await provider.fetchCodexUsage();
    expect(usage).toEqual({
      accounts: [
        { label: ".codex", fiveHour: { utilization: 42, resetsAt: "h" }, sevenDay: { utilization: 11, resetsAt: "w" } }
      ]
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.timeoutMs).toBe(8_000);
    expect(calls[0]!.env["CODEX_HOME"]).toBeTruthy();
    expect(calls[0]!.env["OPENAI_API_KEY"]).toBeUndefined();
  });

  it("null 창을 방어하고 매칭되는 창만 채운다", async () => {
    const provider = createUsageProvider(sourceOptions({
      fetchCodex: async () => codexResult({
        primary: null,
        secondary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null }
      })
    }));
    expect(await provider.fetchCodexUsage()).toEqual({
      accounts: [{ label: ".codex", fiveHour: { utilization: 5, resetsAt: null }, sevenDay: null }]
    });
  });

  it("조회 실패는 계정 줄의 두 칸 모두 null로 돌려준다", async () => {
    const provider = createUsageProvider(sourceOptions({
      fetchCodex: async () => codexResult(null)
    }));
    expect(await provider.fetchCodexUsage()).toEqual({
      accounts: [{ label: ".codex", fiveHour: null, sevenDay: null }]
    });
  });

  it("codexAccountHomes의 각 계정을 순서대로 별도 줄로 조회한다", async () => {
    const seenHomes: string[] = [];
    const byHome: Record<string, number> = {
      "/tmp/codex-homes/.codex": 10,
      "/tmp/codex-homes/.codex-acct-b": 40,
      "/tmp/codex-homes/.codex-acct-c": 70
    };
    const provider = createUsageProvider(sourceOptions({
      codexAccountHomes: Object.keys(byHome),
      fetchCodex: async (options: CodexLiveUsageOptions) => {
        const home = options.env["CODEX_HOME"]!;
        seenHomes.push(home);
        return codexResult({
          primary: { usedPercent: byHome[home]!, windowDurationMins: 300, resetsAt: "h" },
          secondary: { usedPercent: byHome[home]! + 1, windowDurationMins: 10_080, resetsAt: "w" }
        });
      }
    }));
    const usage = await provider.fetchCodexUsage();
    expect(seenHomes).toEqual(Object.keys(byHome));
    expect(usage.accounts.map((a) => a.label)).toEqual([".codex", ".codex-acct-b", ".codex-acct-c"]);
    expect(usage.accounts[0]!.fiveHour).toEqual({ utilization: 10, resetsAt: "h" });
    expect(usage.accounts[2]!.sevenDay).toEqual({ utilization: 71, resetsAt: "w" });
  });

  it("한 계정의 조회 실패가 다른 계정 줄을 가리지 않는다", async () => {
    const provider = createUsageProvider(sourceOptions({
      codexAccountHomes: ["/tmp/codex-homes/.codex", "/tmp/codex-homes/.codex-acct-b"],
      fetchCodex: async (options: CodexLiveUsageOptions) =>
        options.env["CODEX_HOME"]!.endsWith(".codex-acct-b")
          ? codexResult(null)
          : codexResult({ primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: null } })
    }));
    const usage = await provider.fetchCodexUsage();
    expect(usage.accounts).toEqual([
      { label: ".codex", fiveHour: { utilization: 33, resetsAt: null }, sevenDay: null },
      { label: ".codex-acct-b", fiveHour: null, sevenDay: null }
    ]);
  });

  it("basename이 겹치는 홈은 순번 레이블로 구분한다", async () => {
    const provider = createUsageProvider(sourceOptions({
      codexAccountHomes: ["/a/.codex", "/b/.codex"],
      fetchCodex: async () => codexResult({ primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null } })
    }));
    const usage = await provider.fetchCodexUsage();
    expect(usage.accounts.map((a) => a.label)).toEqual([".codex #1", ".codex #2"]);
  });
});

describe("createUsageProvider — Grok periodType", () => {
  it("WEEKLY·USAGE_PERIOD_TYPE_WEEKLY는 주간, MONTHLY 계열은 월간 칸에 매핑한다", async () => {
    const weekly = createUsageProvider(sourceOptions({
      fetchGrok: async () => grokResult({ creditUsagePercent: 63, periodType: "WEEKLY", periodEnd: "e" })
    }));
    expect(await weekly.fetchGrokUsage()).toEqual({
      weekly: { utilization: 63, resetsAt: "e" },
      monthly: null,
      weeklyReceived: true,
      monthlyReceived: false,
      loginRequired: false
    });

    // grok.com 실측 periodType (usage.ts formatGrokUsage와 동일)
    const weeklyApi = createUsageProvider(sourceOptions({
      fetchGrok: async () => grokResult({
        creditUsagePercent: 69,
        periodType: "USAGE_PERIOD_TYPE_WEEKLY",
        periodEnd: "2026-07-25T04:24:10.645396+00:00"
      })
    }));
    expect(await weeklyApi.fetchGrokUsage()).toEqual({
      weekly: { utilization: 69, resetsAt: "2026-07-25T04:24:10.645396+00:00" },
      monthly: null,
      weeklyReceived: true,
      monthlyReceived: false,
      loginRequired: false
    });

    const monthly = createUsageProvider(sourceOptions({
      fetchGrok: async () => grokResult({ creditUsagePercent: 21, periodType: "MONTHLY", periodEnd: "m" })
    }));
    expect(await monthly.fetchGrokUsage()).toEqual({
      weekly: null,
      monthly: { utilization: 21, resetsAt: "m" },
      weeklyReceived: false,
      monthlyReceived: true,
      loginRequired: false
    });

    const monthlyApi = createUsageProvider(sourceOptions({
      fetchGrok: async () => grokResult({ creditUsagePercent: 40, periodType: "USAGE_PERIOD_TYPE_MONTHLY", periodEnd: "m2" })
    }));
    expect((await monthlyApi.fetchGrokUsage()).monthly).toEqual({ utilization: 40, resetsAt: "m2" });
  });

  it("알 수 없는 periodType이어도 creditUsagePercent가 있으면 주간 칸에 표시한다", async () => {
    const provider = createUsageProvider(sourceOptions({
      fetchGrok: async () => grokResult({ creditUsagePercent: 50, periodType: "DAILY" })
    }));
    const usage = await provider.fetchGrokUsage();
    expect(usage.weeklyReceived).toBe(true);
    expect(usage.weekly).toEqual({ utilization: 50, resetsAt: null });
    expect(usage.monthlyReceived).toBe(false);
  });

  it("로그인 부재는 loginRequired로 구분한다", async () => {
    const provider = createUsageProvider(sourceOptions({
      fetchGrok: async () => grokResult(null, "grok 로그인 정보 없음 (`grok login` 필요)")
    }));
    const usage = await provider.fetchGrokUsage();
    expect(usage.loginRequired).toBe(true);
    expect(usage.weeklyReceived).toBe(false);

    const httpFailure = createUsageProvider(sourceOptions({
      fetchGrok: async () => grokResult(null, "HTTP 500")
    }));
    expect((await httpFailure.fetchGrokUsage()).loginRequired).toBe(false);
  });
});

describe("createCachedUsageProvider", () => {
  function countingProvider(overrides: Partial<GuiUsageProvider> = {}) {
    const calls = { claude: 0, codex: 0, grok: 0 };
    const provider: GuiUsageProvider = {
      fetchClaudeUsage: async () => {
        calls.claude += 1;
        return { fiveHour: null, sevenDay: null, stale: false, capturedAt: 1 };
      },
      fetchCodexUsage: async () => {
        calls.codex += 1;
        return { accounts: [{ label: ".codex", fiveHour: { utilization: 10, resetsAt: null }, sevenDay: null }] };
      },
      fetchGrokUsage: async () => {
        calls.grok += 1;
        return { weekly: null, monthly: null, weeklyReceived: false, monthlyReceived: false, loginRequired: false };
      },
      ...overrides
    };
    return { provider, calls };
  }

  it("TTL 안에서는 codex/grok을 한 번만 조회하고 Claude는 매번 읽는다", async () => {
    let current = 0;
    const { provider, calls } = countingProvider();
    const cached = createCachedUsageProvider(provider, { now: () => current });

    await cached.fetchCodexUsage();
    await cached.fetchCodexUsage();
    await cached.fetchGrokUsage();
    await cached.fetchGrokUsage();
    await cached.fetchClaudeUsage();
    await cached.fetchClaudeUsage();
    expect(calls).toEqual({ claude: 2, codex: 1, grok: 1 });

    current = 19_999;
    await cached.fetchGrokUsage();
    expect(calls.grok).toBe(1);
    current = 20_001;
    await cached.fetchGrokUsage();
    expect(calls.grok).toBe(2);

    current = 89_999;
    await cached.fetchCodexUsage();
    expect(calls.codex).toBe(1);
    current = 90_001;
    await cached.fetchCodexUsage();
    expect(calls.codex).toBe(2);
  });

  it("동시 호출은 inflight 조회를 공유한다", async () => {
    let release: (() => void) | null = null;
    let codexCount = 0;
    const { provider } = countingProvider({
      fetchCodexUsage: () => {
        codexCount += 1;
        return new Promise((resolve) => {
          release = () => resolve({ accounts: [{ label: ".codex", fiveHour: { utilization: 1, resetsAt: null }, sevenDay: null }] });
        });
      }
    });
    const cached = createCachedUsageProvider(provider);
    const first = cached.fetchCodexUsage();
    const second = cached.fetchCodexUsage();
    expect(codexCount).toBe(1);
    release!();
    await Promise.all([first, second]);
    expect(codexCount).toBe(1);
  });

  it("grok은 받은 주기 칸만 갱신하고 반대 칸은 마지막값을 유지한다", async () => {
    let current = 0;
    const results = [
      { weekly: { utilization: 30, resetsAt: "w1" }, monthly: null, weeklyReceived: true, monthlyReceived: false, loginRequired: false },
      { weekly: null, monthly: { utilization: 55, resetsAt: "m1" }, weeklyReceived: false, monthlyReceived: true, loginRequired: false }
    ];
    let index = 0;
    const { provider } = countingProvider({
      fetchGrokUsage: async () => results[Math.min(index++, results.length - 1)]!
    });
    const cached = createCachedUsageProvider(provider, { now: () => current });

    expect(await cached.fetchGrokUsage()).toEqual({
      weekly: { utilization: 30, resetsAt: "w1" },
      monthly: null,
      weeklyReceived: true,
      monthlyReceived: false,
      loginRequired: false
    });
    current = 21_000;
    expect(await cached.fetchGrokUsage()).toEqual({
      weekly: { utilization: 30, resetsAt: "w1" },
      monthly: { utilization: 55, resetsAt: "m1" },
      weeklyReceived: true,
      monthlyReceived: true,
      loginRequired: false
    });
  });

  it("조회 실패도 TTL 동안 캐시해 fetch 폭주를 막는다", async () => {
    let current = 0;
    let codexCount = 0;
    const { provider } = countingProvider({
      fetchCodexUsage: async () => {
        codexCount += 1;
        throw new Error("spawn 실패");
      }
    });
    const cached = createCachedUsageProvider(provider, { now: () => current });
    expect(await cached.fetchCodexUsage()).toEqual({ accounts: [] });
    await cached.fetchCodexUsage();
    expect(codexCount).toBe(1);
    current = 91_000;
    await cached.fetchCodexUsage();
    expect(codexCount).toBe(2);
  });
});
