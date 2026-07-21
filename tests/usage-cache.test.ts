import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverUsageCachePaths,
  readDaemonUsageCache,
  writeDaemonUsageCache,
  USAGE_CACHE_VERSION
} from "../src/usage-cache.js";
import { createUsageProvider } from "../src/gui/usage-source.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function samplePayload(writtenAt = 1_784_600_000_000) {
  return {
    writtenAt,
    host: "neamui-Macmini.local",
    claude: {
      fiveHour: { utilization: 42, resetsAt: "2026-07-21T12:00:00.000Z" },
      sevenDay: { utilization: 55, resetsAt: "2026-07-22T00:00:00.000Z" },
      stale: false,
      capturedAt: writtenAt
    },
    codex: {
      accounts: [
        {
          label: ".codex",
          fiveHour: { utilization: 10, resetsAt: null },
          sevenDay: { utilization: 80, resetsAt: "2026-07-25T00:00:00.000Z" }
        }
      ]
    },
    grok: {
      weekly: { utilization: 71, resetsAt: "2026-07-25T04:24:10.000Z" },
      monthly: null,
      weeklyReceived: true,
      monthlyReceived: false,
      loginRequired: false
    }
  };
}

describe("daemon usage cache", () => {
  it("writes and reads the newest valid cache among candidates", () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-usage-cache-"));
    directories.push(directory);
    const older = join(directory, "older.json");
    const newer = join(directory, "newer.json");
    writeDaemonUsageCache(samplePayload(100), [older]);
    writeDaemonUsageCache(samplePayload(200), [newer]);
    const cache = readDaemonUsageCache([older, newer]);
    expect(cache?.writtenAt).toBe(200);
    expect(cache?.version).toBe(USAGE_CACHE_VERSION);
    expect(cache?.claude.fiveHour?.utilization).toBe(42);
    expect(cache?.codex.accounts[0]?.sevenDay?.utilization).toBe(80);
    expect(cache?.grok.weekly?.utilization).toBe(71);
    expect(cache?.host).toBe("neamui-Macmini.local");
  });

  it("ignores v1 or corrupted files", () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-usage-cache-bad-"));
    directories.push(directory);
    const path = join(directory, "bad.json");
    writeFileSync(path, JSON.stringify({ version: 1, writtenAt: 9, claude: { capturedAt: 1 } }));
    expect(readDaemonUsageCache([path])).toBeNull();
    writeFileSync(path, "{not-json");
    expect(readDaemonUsageCache([path])).toBeNull();
  });

  it("includes project data path and configured path", () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-usage-cache-paths-"));
    directories.push(directory);
    const configured = join(directory, "custom-usage.json");
    const paths = discoverUsageCachePaths({
      projectDir: directory,
      env: { CHATKJB_USAGE_CACHE_PATH: configured },
      home: directory
    });
    expect(paths[0]).toBe(configured);
    expect(paths).toContain(join(directory, "data", "usage-cache.json"));
  });

  it("daemon-cache source mode returns only published daemon values", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-usage-cache-mode-"));
    directories.push(directory);
    const cachePath = join(directory, "chatkjb-usage.json");
    writeDaemonUsageCache(samplePayload(), [cachePath]);

    const provider = createUsageProvider({
      databasePath: join(directory, "missing-state.sqlite"),
      codexExecutable: "codex-should-not-run",
      grokExecutable: "grok-should-not-run",
      sourceMode: "daemon-cache",
      usageCachePaths: [cachePath],
      fetchCodex: async () => {
        throw new Error("local codex must not be called in daemon-cache mode");
      },
      fetchGrok: async () => {
        throw new Error("local grok must not be called in daemon-cache mode");
      }
    });

    await expect(provider.fetchClaudeUsage()).resolves.toMatchObject({
      fiveHour: { utilization: 42 },
      sevenDay: { utilization: 55 }
    });
    await expect(provider.fetchCodexUsage()).resolves.toEqual({
      accounts: [
        {
          label: ".codex",
          fiveHour: { utilization: 10, resetsAt: null },
          sevenDay: { utilization: 80, resetsAt: "2026-07-25T00:00:00.000Z" }
        }
      ]
    });
    await expect(provider.fetchGrokUsage()).resolves.toMatchObject({
      weekly: { utilization: 71 },
      weeklyReceived: true
    });
  });

  it("daemon-cache mode with missing file returns empty strip", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-usage-cache-empty-"));
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const provider = createUsageProvider({
      databasePath: join(directory, "missing.sqlite"),
      codexExecutable: "codex",
      grokExecutable: "grok",
      sourceMode: "daemon-cache",
      usageCachePaths: [join(directory, "nope.json")]
    });
    await expect(provider.fetchClaudeUsage()).resolves.toMatchObject({ capturedAt: null });
    await expect(provider.fetchCodexUsage()).resolves.toEqual({ accounts: [] });
    await expect(provider.fetchGrokUsage()).resolves.toMatchObject({ weeklyReceived: false });
  });
});

describe("writeDaemonUsageCache permissions payload", () => {
  it("persists pretty JSON with version 2", () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-usage-cache-write-"));
    directories.push(directory);
    const path = join(directory, "out.json");
    const result = writeDaemonUsageCache(samplePayload(123), [path]);
    expect(result.written).toEqual([path]);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version: number; writtenAt: number };
    expect(parsed.version).toBe(2);
    expect(parsed.writtenAt).toBe(123);
  });
});
