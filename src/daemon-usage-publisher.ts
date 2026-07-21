// 데몬 프로세스에서 Claude/Codex/Grok 사용량을 주기적으로 조회해 공유 캐시에 게시한다.
// Terminal 은 데몬이 없는 Mac 에서 이 파일을 읽어 **데몬 호스트의 한도**를 표시한다.
import { hostname } from "node:os";
import { createUsageProvider } from "./gui/usage-source.js";
import {
  discoverUsageCachePaths,
  writeDaemonUsageCache
} from "./usage-cache.js";

const DEFAULT_INTERVAL_MS = 60_000;

export interface DaemonUsagePublisherOptions {
  databasePath: string;
  codexExecutable: string;
  grokExecutable: string;
  codexAccountHomes: readonly string[];
  projectDir?: string | null;
  intervalMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export interface DaemonUsagePublisherHandle {
  stop: () => void;
  /** 즉시 한 번 게시(테스트·수동 갱신용). */
  publishNow: () => Promise<{ written: string[]; failed: string[] }>;
}

export function startDaemonUsagePublisher(
  options: DaemonUsagePublisherOptions
): DaemonUsagePublisherHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = options.log ?? ((message: string) => console.log(message));
  const provider = createUsageProvider({
    databasePath: options.databasePath,
    codexExecutable: options.codexExecutable,
    grokExecutable: options.grokExecutable,
    codexAccountHomes: [...options.codexAccountHomes]
  });

  let stopped = false;
  let inflight: Promise<unknown> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const publishNow = async (): Promise<{ written: string[]; failed: string[] }> => {
    if (stopped) return { written: [], failed: [] };
    if (inflight) {
      await inflight;
    }
    const run = (async () => {
      const [claude, codex, grok] = await Promise.all([
        provider.fetchClaudeUsage(),
        provider.fetchCodexUsage(),
        provider.fetchGrokUsage()
      ]);
      const paths = discoverUsageCachePaths({
        ...(options.projectDir !== undefined ? { projectDir: options.projectDir } : {}),
        ...(options.env !== undefined ? { env: options.env } : {})
      });
      if (paths.length === 0) {
        log("Usage cache publish skipped → no writable targets");
        return { written: [] as string[], failed: [] as string[] };
      }
      const result = writeDaemonUsageCache(
        {
          writtenAt: Date.now(),
          host: hostname(),
          claude,
          codex,
          grok
        },
        paths
      );
      if (result.written.length > 0) {
        log(
          `Usage cache published → ${result.written.length} path(s)`
          + (result.failed.length ? `, ${result.failed.length} failed` : "")
        );
      } else if (result.failed.length > 0) {
        log(`Usage cache publish failed → ${result.failed.length} path(s)`);
      }
      return result;
    })();
    inflight = run.finally(() => {
      if (inflight === run) inflight = null;
    });
    return await run;
  };

  void publishNow().catch((error: unknown) => {
    log(`Usage cache initial publish error → ${error instanceof Error ? error.message : String(error)}`);
  });

  timer = setInterval(() => {
    void publishNow().catch((error: unknown) => {
      log(`Usage cache publish error → ${error instanceof Error ? error.message : String(error)}`);
    });
  }, intervalMs);
  // unref 가능하면 데몬 종료를 막지 않는다.
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    publishNow
  };
}
