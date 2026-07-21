// 데몬 프로세스에서 Claude/Codex/Grok 사용량을 주기적으로 조회해
// (1) 공유 파일 캐시 (2) Tailscale/LAN HTTP 로 게시한다.
// Terminal 은 데몬이 없는 Mac 에서 파일 또는 HTTP 로 **데몬 호스트 한도**를 표시한다.
import { hostname } from "node:os";
import { createUsageProvider } from "./gui/usage-source.js";
import {
  startDaemonUsageHttpServer,
  resolveUsageHttpPort,
  type DaemonUsageHttpServerHandle
} from "./daemon-usage-http.js";
import {
  discoverUsageCachePaths,
  USAGE_CACHE_VERSION,
  writeDaemonUsageCache,
  type DaemonUsageCacheFile
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
  /** false 이면 HTTP 서버를 열지 않는다(테스트용). 기본 true. */
  enableHttp?: boolean;
}

export interface DaemonUsagePublisherHandle {
  stop: () => void;
  /** 즉시 한 번 게시(테스트·수동 갱신용). */
  publishNow: () => Promise<{ written: string[]; failed: string[] }>;
  getLatest: () => DaemonUsageCacheFile | null;
}

export function startDaemonUsagePublisher(
  options: DaemonUsagePublisherOptions
): DaemonUsagePublisherHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.log(message));
  const provider = createUsageProvider({
    databasePath: options.databasePath,
    codexExecutable: options.codexExecutable,
    grokExecutable: options.grokExecutable,
    codexAccountHomes: [...options.codexAccountHomes],
    // publisher 자신은 항상 로컬 조회(캐시 재귀 방지).
    sourceMode: "local"
  });

  let stopped = false;
  let latest: DaemonUsageCacheFile | null = null;
  let inflight: Promise<unknown> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let httpServer: DaemonUsageHttpServerHandle | null = null;

  if (options.enableHttp !== false) {
    const httpToken = env.CHATKJB_USAGE_HTTP_TOKEN?.trim();
    void startDaemonUsageHttpServer({
      getPayload: () => latest,
      port: resolveUsageHttpPort(env),
      ...(httpToken ? { token: httpToken } : {}),
      log
    }).then((handle) => {
      if (stopped) {
        void handle.stop().catch(() => undefined);
        return;
      }
      httpServer = handle;
    }).catch((error: unknown) => {
      log(
        `Usage HTTP failed to start → ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

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
      latest = {
        version: USAGE_CACHE_VERSION,
        writtenAt: Date.now(),
        host: hostname(),
        claude,
        codex,
        grok
      };
      const paths = discoverUsageCachePaths({
        ...(options.projectDir !== undefined ? { projectDir: options.projectDir } : {}),
        env
      });
      if (paths.length === 0) {
        log("Usage cache file publish skipped → no writable targets (HTTP still serves memory)");
        return { written: [] as string[], failed: [] as string[] };
      }
      const result = writeDaemonUsageCache(
        {
          writtenAt: latest.writtenAt,
          host: latest.host,
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
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (httpServer) {
        void httpServer.stop().catch(() => undefined);
        httpServer = null;
      }
    },
    publishNow,
    getLatest: () => latest
  };
}
