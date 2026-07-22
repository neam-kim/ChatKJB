// 데몬 프로세스에서 Claude/Codex/Grok 사용량을 주기적으로 조회해
// (1) 공유 파일 캐시 (2) Tailscale/LAN HTTP 로 게시한다.
// Terminal 은 데몬이 없는 Mac 에서 파일 또는 HTTP 로 **데몬 호스트 한도**를 표시한다.
import { hostname } from "node:os";
import { createUsageProvider } from "./gui/usage-source.js";
import { fetchClaudeWebUsage } from "./claude-web-usage.js";
import {
  ensureTailscaleUsageServe,
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

// Claude 웹 사용량은 정시 반복을 피하며 약 15분마다 갱신한다.
// Codex/Grok도 동일 게시 주기를 따르되, 수동 publishNow는 진단·테스트에만 쓴다.
const DEFAULT_INTERVAL_MS = 15 * 60_000;
const USAGE_PUBLISH_JITTER_SECONDS = 300;

/** 다음 자동 조회 시각을 기준 15분에서 ±5분 무작위로 분산한다. */
export function nextUsagePublishDelayMs(
  baseIntervalMs = DEFAULT_INTERVAL_MS,
  random: () => number = Math.random
): number {
  // Math.random()은 [0, 1)이나, 테스트용 주입값도 안전하게 같은 범위로 정규화한다.
  const sample = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
  const offsetSeconds = Math.floor(sample * (USAGE_PUBLISH_JITTER_SECONDS * 2 + 1))
    - USAGE_PUBLISH_JITTER_SECONDS;
  return Math.max(1_000, baseIntervalMs + offsetSeconds * 1_000);
}

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
    sourceMode: "local",
    // 개인 구독에는 공식 실시간 API가 없어 전용 로그인 프로필을 통해 읽는다.
    // 실패 시 usage-source가 SQLite 스냅샷으로 폴백한다.
    fetchClaudeWeb: fetchClaudeWebUsage
  });

  let stopped = false;
  let latest: DaemonUsageCacheFile | null = null;
  let inflight: Promise<unknown> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let httpServer: DaemonUsageHttpServerHandle | null = null;

  if (options.enableHttp !== false) {
    const httpToken = env.CHATKJB_USAGE_HTTP_TOKEN?.trim();
    const httpPort = resolveUsageHttpPort(env);
    void startDaemonUsageHttpServer({
      getPayload: () => latest,
      port: httpPort,
      ...(httpToken ? { token: httpToken } : {}),
      log
    }).then(async (handle) => {
      if (stopped) {
        void handle.stop().catch(() => undefined);
        return;
      }
      httpServer = handle;
      // 맥북은 NAS 없이 Tailscale 만 쓰므로 Serve HTTP(:80) 프록시를 유지한다.
      await ensureTailscaleUsageServe(httpPort, log);
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

  // 매번 새 난수를 써야 하므로 setInterval 대신 다음 완료 후 setTimeout을 다시 건다.
  // 이 방식은 느린 웹 조회가 다음 조회와 겹치는 것도 막는다.
  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void publishNow().catch((error: unknown) => {
        log(`Usage cache publish error → ${error instanceof Error ? error.message : String(error)}`);
      }).finally(scheduleNext);
    }, nextUsagePublishDelayMs(intervalMs));
    timer.unref?.();
  };

  void publishNow().catch((error: unknown) => {
    log(`Usage cache initial publish error → ${error instanceof Error ? error.message : String(error)}`);
  }).finally(scheduleNext);

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
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
