import { execFileSync } from "node:child_process";

/**
 * Cline 허브 데몬(`cline --cline-hub-daemon`)은 클라이언트가 접속할 때마다 공유 MCP 전체
 * (connectors.json 기준 20여 개)를 통째로 띄우지만, 클라이언트가 끊겨도 그 함대를 회수하지
 * 않는다. ChatKJB 봇은 SIGTERM 경로에서 ClineExecutor.dispose()를 부르지만 크래시나
 * SIGKILL로 죽으면 dispose가 실행되지 않고, launchd KeepAlive가 다시 띄우면 함대가 한 벌
 * 더 쌓인다. 재시작이 반복되면 고아 MCP가 수십 개·수 GB까지 누적된다(실측 96 프로세스/6.4GB).
 *
 * 그래서 봇 시작 시 "허브에 연결된 클라이언트가 하나도 없는데 MCP 자식은 살아 있는" 상태를
 * 확인해 그 함대만 정리한다. 접속 중인 클라이언트가 있으면 사용자가 직접 쓰는 cline CLI
 * 세션일 수 있으므로 절대 건드리지 않는다. 허브 데몬 자체는 가볍고 다음 접속에 재사용되므로
 * 남겨 둔다.
 */

const KILL_GRACE_MS = 3_000;

export interface ClineReaperDeps {
  /** 인자를 포함한 전체 커맨드라인으로 PID를 찾는다. */
  findPidsByCommand: (pattern: string) => number[];
  /** 해당 PID의 전체 커맨드라인. 찾지 못하면 null. */
  commandLine: (pid: number) => string | null;
  /** 해당 PID의 직계 자식. */
  childPids: (pid: number) => number[];
  /** 해당 TCP 포트의 ESTABLISHED 연결 수. */
  establishedConnections: (port: number) => number;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}

export interface ClineReapResult {
  hubPid: number | null;
  /** 연결된 클라이언트가 있어 정리를 건너뛴 경우 true. */
  skippedBusy: boolean;
  reapedPids: number[];
}

function parsePort(commandLine: string): number | null {
  const match = /--port\s+(\d+)/.exec(commandLine);
  if (!match?.[1]) return null;
  const port = Number.parseInt(match[1], 10);
  return Number.isInteger(port) && port > 0 ? port : null;
}

function collectTree(rootPids: number[], childPids: ClineReaperDeps["childPids"]): number[] {
  // 허브 → 런처(run-shared-mcp.mjs / npm exec) → 실제 서버 프로세스까지 2단계 아래가 존재한다.
  const seen = new Set<number>();
  const walk = (pid: number, depth: number) => {
    if (seen.has(pid) || depth > 4) return;
    seen.add(pid);
    for (const child of childPids(pid)) walk(child, depth + 1);
  };
  for (const pid of rootPids) walk(pid, 0);
  return [...seen];
}

/**
 * 이전 실행이 남긴 Cline 허브 MCP 함대를 정리한다. 정리할 것이 없거나 판단에 필요한 정보를
 * 얻지 못하면 아무것도 하지 않는다(오탐으로 남의 프로세스를 죽이지 않는 쪽을 택한다).
 */
export async function reapOrphanedClineMcp(
  deps: ClineReaperDeps = defaultDeps()
): Promise<ClineReapResult> {
  const idle: ClineReapResult = { hubPid: null, skippedBusy: false, reapedPids: [] };
  const hubPid = deps.findPidsByCommand("--cline-hub-daemon")[0];
  if (hubPid === undefined) return idle;
  idle.hubPid = hubPid;

  const children = deps.childPids(hubPid);
  if (children.length === 0) return idle;

  // 포트를 못 읽으면 접속 여부를 판정할 수 없다 — 살아 있는 세션을 죽일 위험이 있으므로 중단.
  const commandLine = deps.commandLine(hubPid);
  const port = commandLine ? parsePort(commandLine) : null;
  if (port === null) return idle;

  if (deps.establishedConnections(port) > 0) {
    return { ...idle, skippedBusy: true };
  }

  const tree = collectTree(children, deps.childPids);
  for (const pid of tree) deps.signal(pid, "SIGTERM");
  await deps.sleep(KILL_GRACE_MS);
  for (const pid of tree) deps.signal(pid, "SIGKILL");
  return { ...idle, reapedPids: tree };
}

function run(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // pgrep·lsof는 일치 항목이 없을 때도 0이 아닌 코드로 끝난다.
    return null;
  }
}

function parsePids(output: string | null): number[] {
  if (!output) return [];
  return output.split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export function defaultDeps(): ClineReaperDeps {
  return {
    findPidsByCommand: (pattern) => parsePids(run("/usr/bin/pgrep", ["-f", "--", pattern])),
    commandLine: (pid) => run("/bin/ps", ["-o", "command=", "-p", String(pid)])?.trim() || null,
    childPids: (pid) => parsePids(run("/usr/bin/pgrep", ["-P", String(pid)])),
    establishedConnections: (port) => {
      const output = run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED"]);
      if (!output) return 0;
      // 첫 줄은 헤더(COMMAND PID …)이므로 제외한다.
      return output.split("\n").filter((line) => line.trim() && !line.startsWith("COMMAND")).length;
    },
    signal: (pid, sig) => {
      try {
        process.kill(pid, sig);
      } catch {
        // 이미 종료된 프로세스(ESRCH)는 정상 경로다.
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  };
}
