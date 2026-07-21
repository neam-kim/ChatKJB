// 데몬 호스트(ChatKJB.app 이 도는 Mac)의 사용량 스냅샷을 공유 파일로 게시·구독한다.
//
// Terminal GUI 사용량 스트립은 원래 그 머신 로컬 DB/CLI 를 읽는다. 봇 데몬이 없는 다른
// Mac(맥북 등)에서는 로컬 값이 비거나 **그 Mac 의 사용량**이 되어 버린다. 어르신이 원하는
// 것은 항상 **데몬이 도는 컴퓨터의 한도**이므로, 데몬이 주기적으로 전체 스트립을 NAS 등
// 공유 경로에 쓰고 Terminal 은 데몬 호스트가 아니면 그 캐시만 읽는다.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  GuiClaudeUsageDto,
  GuiCodexUsageDto,
  GuiGrokUsageDto,
  GuiUsageWindowDto
} from "./gui/protocol.js";

export const USAGE_CACHE_VERSION = 2 as const;
export const USAGE_CACHE_FILENAME = "chatkjb-usage.json";
/** 캐시가 이보다 오래되면 stale 로 취급(표시는 하되 주석). 데몬 60초 주기 + 여유. */
export const USAGE_CACHE_STALE_MS = 10 * 60_000;

export interface DaemonUsageCacheFile {
  version: typeof USAGE_CACHE_VERSION;
  writtenAt: number;
  /** 게시한 호스트 이름(진단용). */
  host: string | null;
  claude: GuiClaudeUsageDto;
  codex: GuiCodexUsageDto;
  grok: GuiGrokUsageDto;
}

function expandHomePath(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function pushUnique(paths: string[], seen: Set<string>, candidate: string): void {
  const trimmed = candidate.trim();
  if (!trimmed || seen.has(trimmed)) return;
  seen.add(trimmed);
  paths.push(trimmed);
}

/**
 * 사용량 캐시 후보 경로.
 * 우선순위: CHATKJB_USAGE_CACHE_PATH → 봇 프로젝트 data/usage-cache.json →
 * /Volumes/homes/<user>/Program/chatkjb-usage.json (Terminal DMG 와 같은 NAS Program).
 */
export function discoverUsageCachePaths(options: {
  projectDir?: string | null;
  env?: NodeJS.ProcessEnv;
  home?: string;
} = {}): string[] {
  const env = options.env ?? process.env;
  const home = options.home ?? process.env.HOME ?? "";
  const paths: string[] = [];
  const seen = new Set<string>();

  const configured = env.CHATKJB_USAGE_CACHE_PATH?.trim();
  if (configured) {
    pushUnique(paths, seen, expandHomePath(configured, home));
  }

  const projectDir = options.projectDir?.trim();
  if (projectDir) {
    pushUnique(paths, seen, join(projectDir, "data", "usage-cache.json"));
  }

  for (const volumeRoot of ["/Volumes/homes", "/Volumes/home"] as const) {
    if (!existsSync(volumeRoot)) continue;
    try {
      for (const entry of readdirSync(volumeRoot)) {
        // NAS 휴지통·숨김 항목은 공유 대상이 아니다.
        if (!entry || entry.startsWith(".") || entry.startsWith("#")) continue;
        const programDir = join(volumeRoot, entry, "Program");
        if (!existsSync(programDir)) continue;
        pushUnique(paths, seen, join(programDir, USAGE_CACHE_FILENAME));
      }
    } catch {
      // 볼륨 읽기 실패는 후보에서 제외.
    }
  }

  return paths;
}

function isUsageWindow(value: unknown): value is GuiUsageWindowDto {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const utilizationOk = record.utilization === null
    || (typeof record.utilization === "number" && Number.isFinite(record.utilization));
  const resetsOk = record.resetsAt === null || typeof record.resetsAt === "string";
  return utilizationOk && resetsOk;
}

function parseClaude(value: unknown): GuiClaudeUsageDto | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const fiveHour = record.fiveHour === null
    ? null
    : isUsageWindow(record.fiveHour)
      ? record.fiveHour
      : null;
  const sevenDay = record.sevenDay === null
    ? null
    : isUsageWindow(record.sevenDay)
      ? record.sevenDay
      : null;
  if (record.fiveHour != null && fiveHour === null) return null;
  if (record.sevenDay != null && sevenDay === null) return null;
  return {
    fiveHour,
    sevenDay,
    stale: record.stale === true,
    capturedAt: typeof record.capturedAt === "number" && Number.isFinite(record.capturedAt)
      ? record.capturedAt
      : null
  };
}

function parseCodex(value: unknown): GuiCodexUsageDto | null {
  if (!value || typeof value !== "object") return null;
  const accountsRaw = (value as Record<string, unknown>).accounts;
  if (!Array.isArray(accountsRaw)) return null;
  const accounts = accountsRaw
    .filter((account) => account && typeof account === "object")
    .map((account) => {
      const row = account as Record<string, unknown>;
      return {
        label: typeof row.label === "string" && row.label.trim() ? row.label.trim() : "Codex",
        fiveHour: row.fiveHour === null
          ? null
          : isUsageWindow(row.fiveHour)
            ? row.fiveHour
            : null,
        sevenDay: row.sevenDay === null
          ? null
          : isUsageWindow(row.sevenDay)
            ? row.sevenDay
            : null
      };
    });
  return { accounts };
}

function parseGrok(value: unknown): GuiGrokUsageDto | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    weekly: record.weekly === null
      ? null
      : isUsageWindow(record.weekly)
        ? record.weekly
        : null,
    monthly: record.monthly === null
      ? null
      : isUsageWindow(record.monthly)
        ? record.monthly
        : null,
    weeklyReceived: record.weeklyReceived === true,
    monthlyReceived: record.monthlyReceived === true,
    loginRequired: record.loginRequired === true
  };
}

/** 후보 경로 중 가장 최근 유효 캐시를 반환한다. */
export function readDaemonUsageCache(paths: readonly string[]): DaemonUsageCacheFile | null {
  let best: DaemonUsageCacheFile | null = null;
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      // v2 전체 스트립. v1(Claude 스냅샷만)은 더 이상 쓰지 않는다.
      if (record.version !== USAGE_CACHE_VERSION) continue;
      if (typeof record.writtenAt !== "number" || !Number.isFinite(record.writtenAt)) continue;
      const claude = parseClaude(record.claude);
      const codex = parseCodex(record.codex);
      const grok = parseGrok(record.grok);
      if (!claude || !codex || !grok) continue;
      const candidate: DaemonUsageCacheFile = {
        version: USAGE_CACHE_VERSION,
        writtenAt: record.writtenAt,
        host: typeof record.host === "string" ? record.host : null,
        claude,
        codex,
        grok
      };
      if (!best || candidate.writtenAt > best.writtenAt) best = candidate;
    } catch {
      // 개별 파일 실패는 다음 후보.
    }
  }
  return best;
}

export function writeDaemonUsageCache(
  payload: Omit<DaemonUsageCacheFile, "version">,
  paths: readonly string[]
): { written: string[]; failed: string[] } {
  const document = {
    version: USAGE_CACHE_VERSION,
    ...payload
  };
  const body = JSON.stringify(document, null, 2) + "\n";
  const written: string[] = [];
  const failed: string[] = [];
  for (const path of paths) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
      written.push(path);
    } catch {
      failed.push(path);
    }
  }
  return { written, failed };
}

export function isDaemonUsageCacheStale(
  cache: DaemonUsageCacheFile,
  now = Date.now(),
  staleMs = USAGE_CACHE_STALE_MS
): boolean {
  return now - cache.writtenAt > staleMs;
}
