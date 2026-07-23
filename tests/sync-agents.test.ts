import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  formatAgentSyncReport,
  parseTelegramResponse,
  restartReasonForUpdates,
  resolveBin,
  resolveNodeBinDir
} from "../scripts/sync-agents.mjs";

const syncAgentSource = readFileSync(
  new URL("../scripts/sync-agents.mjs", import.meta.url),
  "utf8"
);

describe("resolveNodeBinDir", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("CHATKJB_NODE_BIN을 process.execPath 형제보다 우선한다", () => {
    const realBin = mkdtempSync(join(tmpdir(), "sync-real-node-"));
    const bundleBin = mkdtempSync(join(tmpdir(), "sync-bundle-"));
    temporaryDirectories.push(realBin, bundleBin);
    writeFileSync(join(realBin, "npm"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(realBin, "node"), "#!/bin/sh\n", { mode: 0o755 });
    // 번들 쪽에는 ChatKJB만 있고 npm이 없다.
    writeFileSync(join(bundleBin, "ChatKJB"), "#!/bin/sh\n", { mode: 0o755 });

    const resolved = resolveNodeBinDir(
      { CHATKJB_NODE_BIN: realBin },
      join(bundleBin, "ChatKJB")
    );
    expect(resolved).toBe(realBin);
  });

  it("CHATKJB_NODE_BIN이 없으면 execPath 디렉터리를 쓴다", () => {
    const bundleBin = mkdtempSync(join(tmpdir(), "sync-bundle-only-"));
    temporaryDirectories.push(bundleBin);
    writeFileSync(join(bundleBin, "node"), "#!/bin/sh\n", { mode: 0o755 });
    const resolved = resolveNodeBinDir({}, join(bundleBin, "node"));
    expect(resolved).toBe(bundleBin);
  });
});

describe("resolveBin", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("후보 경로에서 존재하는 첫 바이너리를 고른다", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-bin-"));
    temporaryDirectories.push(dir);
    const codex = join(dir, "codex");
    writeFileSync(codex, "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveBin("codex", [join(dir, "missing"), codex], "")).toBe(codex);
  });
});

describe("Codex lockstep source boundary", () => {
  it("updates only the shared runtime and never writes a prefix lockfile into the project", () => {
    expect(syncAgentSource).not.toContain("copyFileSync(sharedLock, projLock)");
    expect(syncAgentSource).not.toContain("writeFileSync(projPkg, bumped)");
    expect(syncAgentSource).toContain('["install", "--prefix", shareBase,');
  });
});

describe("formatAgentSyncReport", () => {
  it("업데이트·실패·최신·락스텝·재시작을 요약한다", () => {
    const text = formatAgentSyncReport(
      {
        updates: [
          { name: "codex", status: "updated", before: "0.144.6", after: "0.145.0" },
          { name: "claude", status: "latest", before: "2.1.215", after: "2.1.215" },
          { name: "grok", status: "failed", before: "0.2.103", after: "0.2.103", error: "timeout" },
          { name: "agy", status: "skipped", error: "바이너리 미발견" }
        ],
        current: {
          codexCli: "0.145.0",
          codexSdk: "0.145.0",
          claude: "2.1.215",
          grok: "0.2.103",
          agy: null
        },
        lockstep: { from: "0.144.6", to: "0.145.0", ok: true },
        restartReason: "codex 락스텝 0.145.0"
      },
      new Date("2026-07-20T03:15:00.000Z")
    );

    expect(text).toContain("🔄 agent-sync");
    expect(text).toContain("· codex: 0.144.6 → 0.145.0");
    expect(text).toContain("· claude: 최신(2.1.215)");
    expect(text).toContain("· grok: 실패 — timeout");
    expect(text).toContain("· agy: 건너뜀 (바이너리 미발견)");
    expect(text).toContain("· 락스텝: codex-sdk 0.144.6 → 0.145.0 성공");
    expect(text).toContain("· 데몬 재시작: codex 락스텝 0.145.0");
  });

  it("변동 없음 outcome을 포함한다", () => {
    const text = formatAgentSyncReport({
      updates: [{ name: "codex", status: "latest", before: "0.144.6", after: "0.144.6" }],
      current: {
        codexCli: "0.144.6",
        codexSdk: "0.144.6",
        claude: "2.1.215",
        grok: "0.2.103",
        agy: "1.1.4"
      },
      outcome: "변동 없음 — 무동작"
    });
    expect(text).toContain("· 변동 없음 — 무동작");
  });

});

describe("restartReasonForUpdates", () => {
  it("실제 버전이 갱신된 모든 provider를 데몬 재시작 사유에 넣는다", () => {
    expect(
      restartReasonForUpdates([
        { name: "codex", status: "updated", before: "0.145.0", after: "0.146.0" },
        { name: "claude", status: "latest", before: "2.1.215", after: "2.1.215" },
        { name: "grok", status: "updated", before: "0.2.103", after: "0.2.106" },
        { name: "agy", status: "failed", error: "timeout" }
      ])
    ).toBe("provider 업데이트(codex, grok)");
  });

  it("버전 갱신이 없으면 데몬을 재시작하지 않는다", () => {
    expect(
      restartReasonForUpdates([
        { name: "codex", status: "latest", before: "0.146.0", after: "0.146.0" },
        { name: "grok", status: "failed", error: "timeout" }
      ])
    ).toBeNull();
  });
});

describe("parseTelegramResponse", () => {
  it("ok 여부를 판별한다", () => {
    expect(parseTelegramResponse('{"ok":true,"result":true}').ok).toBe(true);
    expect(parseTelegramResponse('{"ok":false,"description":"Bad Request"}').ok).toBe(false);
    expect(parseTelegramResponse("not-json").ok).toBe(false);
  });
});
