import { describe, expect, it } from "vitest";
import { reapOrphanedClineMcp, type ClineReaperDeps } from "../src/cline-orphan-reaper.js";

const HUB = 37773;
const HUB_COMMAND = "/opt/homebrew/lib/node_modules/cline/bin/.cline --cline-hub-daemon "
  + "--cwd /Users/tester --host 127.0.0.1 --port 25463 --pathname /hub";

interface Scenario {
  hubPids?: number[];
  command?: string | null;
  tree?: Record<number, number[]>;
  established?: number;
}

function deps(scenario: Scenario): { deps: ClineReaperDeps; signals: Array<[number, string]>; } {
  const signals: Array<[number, string]> = [];
  const tree = scenario.tree ?? {};
  return {
    signals,
    deps: {
      findPidsByCommand: () => scenario.hubPids ?? [HUB],
      commandLine: () => (scenario.command === undefined ? HUB_COMMAND : scenario.command),
      childPids: (pid) => tree[pid] ?? [],
      establishedConnections: () => scenario.established ?? 0,
      signal: (pid, sig) => { signals.push([pid, sig]); },
      sleep: async () => {}
    }
  };
}

describe("reapOrphanedClineMcp", () => {
  it("허브가 없으면 아무것도 하지 않는다", async () => {
    const { deps: d, signals } = deps({ hubPids: [] });
    const result = await reapOrphanedClineMcp(d);
    expect(result).toEqual({ hubPid: null, skippedBusy: false, reapedPids: [] });
    expect(signals).toEqual([]);
  });

  it("자식이 없으면 아무것도 하지 않는다", async () => {
    const { deps: d, signals } = deps({ tree: {} });
    const result = await reapOrphanedClineMcp(d);
    expect(result.reapedPids).toEqual([]);
    expect(signals).toEqual([]);
  });

  it("연결된 클라이언트가 있으면 살아 있는 세션을 건드리지 않는다", async () => {
    const { deps: d, signals } = deps({ tree: { [HUB]: [100, 101] }, established: 1 });
    const result = await reapOrphanedClineMcp(d);
    expect(result.skippedBusy).toBe(true);
    expect(result.reapedPids).toEqual([]);
    expect(signals).toEqual([]);
  });

  it("포트를 읽지 못하면 판정 불가이므로 중단한다", async () => {
    const { deps: d, signals } = deps({ tree: { [HUB]: [100] }, command: null });
    const result = await reapOrphanedClineMcp(d);
    expect(result.reapedPids).toEqual([]);
    expect(signals).toEqual([]);
  });

  it("클라이언트가 없으면 손자까지 포함한 함대를 TERM 후 KILL 한다", async () => {
    const { deps: d, signals } = deps({
      tree: { [HUB]: [100, 200], 100: [101], 200: [201], 201: [202] }
    });
    const result = await reapOrphanedClineMcp(d);
    expect(result.reapedPids.sort((a, b) => a - b)).toEqual([100, 101, 200, 201, 202]);
    expect(signals.filter(([, sig]) => sig === "SIGTERM").map(([pid]) => pid).sort((a, b) => a - b))
      .toEqual([100, 101, 200, 201, 202]);
    expect(signals.filter(([, sig]) => sig === "SIGKILL")).toHaveLength(5);
    // 허브 데몬 자체는 다음 접속에 재사용되므로 남긴다.
    expect(signals.some(([pid]) => pid === HUB)).toBe(false);
  });

  it("순환 참조가 있어도 무한 루프에 빠지지 않는다", async () => {
    const { deps: d } = deps({ tree: { [HUB]: [100], 100: [101], 101: [100] } });
    const result = await reapOrphanedClineMcp(d);
    expect(result.reapedPids.sort((a, b) => a - b)).toEqual([100, 101]);
  });
});
