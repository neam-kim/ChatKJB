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

/** JSON/객체 페이로드를 검증해 캐시 구조로 만든다. 실패 시 null. */
export function parseDaemonUsageCachePayload(raw: unknown): DaemonUsageCacheFile | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  // v2 전체 스트립. v1(Claude 스냅샷만)은 더 이상 쓰지 않는다.
  if (record.version !== USAGE_CACHE_VERSION) return null;
  if (typeof record.writtenAt !== "number" || !Number.isFinite(record.writtenAt)) return null;
  const claude = parseClaude(record.claude);
  const codex = parseCodex(record.codex);
  const grok = parseGrok(record.grok);
  if (!claude || !codex || !grok) return null;
  return {
    version: USAGE_CACHE_VERSION,
    writtenAt: record.writtenAt,
    host: typeof record.host === "string" ? record.host : null,
    claude,
    codex,
    grok
  };
}

/** 후보 경로 중 가장 최근 유효 캐시를 반환한다. */
export function readDaemonUsageCache(paths: readonly string[]): DaemonUsageCacheFile | null {
  let best: DaemonUsageCacheFile | null = null;
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue;
      const candidate = parseDaemonUsageCachePayload(JSON.parse(readFileSync(path, "utf8")) as unknown);
      if (!candidate) continue;
      if (!best || candidate.writtenAt > best.writtenAt) best = candidate;
    } catch {
      // 개별 파일 실패는 다음 후보.
    }
  }
  return best;
}

/** 데몬 사용량 HTTP 기본 포트. Terminal 은 Tailscale MagicDNS 로 이 포트를 조회한다. */
export const DEFAULT_USAGE_HTTP_PORT = 17_846;
export const USAGE_HTTP_PATH = "/v1/usage";

/**
 * 맥북처럼 NAS 를 마운트하지 않는 Terminal 이 데몬 호스트 사용량을 가져올 HTTP URL 후보.
 * 우선순위: CHATKJB_USAGE_URL → CHATKJB_USAGE_HOSTS(CSV) → 기본 Tailscale/로컬 호스트명.
 */
export function discoverUsageCacheUrls(options: {
  env?: NodeJS.ProcessEnv;
} = {}): string[] {
  const env = options.env ?? process.env;
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (url: string) => {
    const trimmed = url.trim().replace(/\/+$/, "");
    if (!trimmed || seen.has(trimmed)) return;
    // path 가 없으면 표준 경로를 붙인다.
    const withPath = /\/v1\/usage$/i.test(trimmed)
      ? trimmed
      : `${trimmed}${USAGE_HTTP_PATH}`;
    if (seen.has(withPath)) return;
    seen.add(withPath);
    urls.push(withPath);
  };

  const explicit = env.CHATKJB_USAGE_URL?.trim();
  if (explicit) {
    add(explicit);
    return urls;
  }

  const portRaw = env.CHATKJB_USAGE_HTTP_PORT?.trim();
  const port = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : DEFAULT_USAGE_HTTP_PORT;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return urls;
  }

  // 명시 URL 목록(전체 URL 또는 host[:port]). 비어 있으면 기본 후보.
  const hostsRaw = env.CHATKJB_USAGE_HOSTS?.trim();
  if (hostsRaw) {
    for (const part of hostsRaw.split(",").map((entry) => entry.trim()).filter(Boolean)) {
      if (/^https?:\/\//i.test(part)) add(part);
      else if (part.includes(":")) add(`http://${part}`);
      else add(`http://${part}:${port}`);
    }
    return urls;
  }

  // 기본 후보:
  // 1) Tailscale Serve HTTP(:80) — macOS 방화벽이 :17846 직접 수신을 막는 경우가 많아
  //    `tailscale serve --bg --http=80 17846` 경유가 맥북에서 가장 안정적이다.
  // 2) 데몬 포트 직접(방화벽 허용 시)
  // 3) 로컬 mDNS(같은 LAN)
  add("http://neam-macmini/v1/usage");
  add(`http://neam-macmini:${port}/v1/usage`);
  add(`http://neamui-Macmini.local:${port}/v1/usage`);
  add(`http://neamui-Macmini:${port}/v1/usage`);
  return urls;
}

/**
 * HTTP 로 데몬 사용량 캐시를 가져온다. 후보 URL 을 순서대로 시도하고 첫 성공을 쓴다.
 * 네트워크 오류·타임아웃·비-JSON 은 다음 후보로 넘어간다(예외를 밖으로 던지지 않음).
 */
export async function fetchDaemonUsageCache(
  urls: readonly string[],
  options: {
    token?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<DaemonUsageCacheFile | null> {
  if (urls.length === 0) return null;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;

  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (options.token?.trim()) {
        headers.Authorization = `Bearer ${options.token.trim()}`;
      }
      const response = await fetchImpl(url, {
        method: "GET",
        headers,
        signal: controller.signal
      });
      if (!response.ok) continue;
      const raw = await response.json() as unknown;
      const parsed = parseDaemonUsageCachePayload(raw);
      if (parsed) return parsed;
    } catch {
      // 다음 URL.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
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
