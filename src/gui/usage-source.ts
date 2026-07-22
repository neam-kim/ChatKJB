// 작성창 사용량 스트립의 소스. GUI 프로세스는 SessionManager에 접근할 수 없으므로
// Claude는 공유 SQLite를 읽기 전용으로 직접 읽고, Codex/Grok은 각 라이브 조회를
// 인프로세스로 호출한다. 모든 실패는 예외 대신 값 부재(null 칸)로 돌려준다(표시 전용,
// setExhaustion/persist 같은 부작용은 만들지 않는다).
//
// DB 접근에는 better-sqlite3가 아니라 Node 26 내장 node:sqlite를 쓴다. macOS 앱
// 번들(esbuild)은 네이티브 모듈을 탑재할 수 없어, better-sqlite3를 정적 import하면
// 패키징된 GUI에서 Claude 칸이 영구 실패한다. 내장 모듈은 번들이 자동으로 external
// 처리하므로 휘발성 앱에서도 그대로 동작한다.
import { DatabaseSync } from "node:sqlite";
import { basename } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchCodexLiveUsage } from "../codex-live-usage.js";
import { fetchGrokLiveUsage } from "../grok-live-usage.js";
import { buildCodexEnvironment } from "../session-environment.js";
import {
  fetchDaemonUsageCache,
  isDaemonUsageCacheStale,
  readDaemonUsageCache,
  type DaemonUsageCacheFile
} from "../usage-cache.js";
import type {
  GuiClaudeUsageDto,
  GuiCodexAccountUsageDto,
  GuiCodexUsageDto,
  GuiGrokUsageDto,
  GuiUsageProvider,
  GuiUsageWindowDto
} from "./protocol.js";
import type { UsageSnapshot, UsageWindow } from "../types.js";

// 라이브 조회 시간 상한. fetchCodexLiveUsage/fetchGrokLiveUsage에 그대로 전달해
// 8초 안에 자식 프로세스 정리까지 끝낸다(별도 상한을 두면 고아 spawn이 남는다).
const LIVE_FETCH_TIMEOUT_MS = 8_000;
// 45초 폴칭 주기와 분리된 캐시 TTL. codex는 spawn 비용이 커 90초, grok은 HTTP라 20초.
const CODEX_CACHE_TTL_MS = 90_000;
const GROK_CACHE_TTL_MS = 20_000;
// 가장 짧은 표시 창(5시간)을 넘긴 스냅샷은 현재 창을 설명하지 못하므로 stale로 본다.
const CLAUDE_SNAPSHOT_STALE_MS = 6 * 3_600_000;

export type UsageSourceMode = "local" | "daemon-cache";

export interface UsageSourceOptions {
  databasePath: string;
  codexExecutable: string;
  grokExecutable: string;
  // Codex 구독 계정 홈(CODEX_ACCOUNT_HOMES) 목록. 각 홈마다 라이브 조회를 한 번씩 돌려
  // 계정별 사용량 줄을 만든다. 비어 있거나 미지정이면 codexHome(또는 기본 홈) 1개만 쓴다.
  codexAccountHomes?: readonly string[];
  // 단일 홈 하위호환 경로. codexAccountHomes가 비었을 때만 참조한다.
  codexHome?: string;
  cwd?: string;
  fetchCodex?: typeof fetchCodexLiveUsage;
  fetchGrok?: typeof fetchGrokLiveUsage;
  now?: () => number;
  /**
   * local: 이 Mac 이 데몬 호스트 — DB·CLI 직접 조회.
   * daemon-cache: 다른 Mac 의 Terminal — 데몬이 게시한 공유 캐시만 읽어 데몬 머신 한도를 표시.
   */
  sourceMode?: UsageSourceMode;
  /** 데몬 사용량 파일 캐시 후보 경로(NAS Program 등). sourceMode=daemon-cache 일 때 사용. */
  usageCachePaths?: readonly string[];
  /**
   * 데몬 사용량 HTTP URL 후보(Tailscale MagicDNS 등). NAS 미마운트 맥북용.
   * 파일 캐시가 없거나 실패하면 순서대로 조회한다.
   */
  usageCacheUrls?: readonly string[];
  usageHttpToken?: string;
}

export interface UsageCacheOptions {
  now?: () => number;
  codexTtlMs?: number;
  grokTtlMs?: number;
}

const EMPTY_CLAUDE_USAGE: GuiClaudeUsageDto = {
  fiveHour: null,
  sevenDay: null,
  stale: false,
  capturedAt: null
};
const EMPTY_GROK_USAGE: GuiGrokUsageDto = {
  weekly: null,
  monthly: null,
  weeklyReceived: false,
  monthlyReceived: false,
  loginRequired: false
};

/** 소스가 하나도 주입되지 않았을 때 모든 칸을 "—"로 응답하는 제공자. */
export function createEmptyUsageProvider(): GuiUsageProvider {
  return {
    fetchClaudeUsage: async () => ({ ...EMPTY_CLAUDE_USAGE }),
    fetchCodexUsage: async () => ({ accounts: [] }),
    fetchGrokUsage: async () => ({ ...EMPTY_GROK_USAGE })
  };
}

function claudeWindow(window: UsageWindow | undefined): GuiUsageWindowDto | null {
  if (!window || typeof window !== "object") return null;
  return {
    utilization: typeof window.utilization === "number" && Number.isFinite(window.utilization)
      ? window.utilization
      : null,
    resetsAt: typeof window.resetsAt === "string" ? window.resetsAt : null
  };
}

/**
 * 창이 **실측 utilization** 을 담고 있는지. resetsAt 만 있고 utilization 이 null 인 창은
 * 표시할 수치가 없으므로 "값 있는 창"으로 치지 않는다(5h/1w 가 "—" 로 비는 회귀 방지).
 */
function windowHasUtilization(window: UsageWindow | undefined): window is UsageWindow {
  return Boolean(window)
    && typeof window!.utilization === "number"
    && Number.isFinite(window!.utilization);
}

/**
 * 공유 SQLite에서 Claude 사용량 스냅샷을 읽는다.
 * 읽기 전용 핸들을 매 폴칭마다 열고 닫으므로 WAL 체크포인트와 무관하게 항상 신선값을 본다.
 *
 * SDK usage API 는 조회 시점에 서버가 준 창만 담아, fiveHour 만 있고 sevenDay 가 없거나
 * (또는 그 반대) utilization 이 null(resetsAt 만) 인 **부분 스냅샷**이 흔하다. 최신 스냅샷 하나만
 * 골라 쓰면 다른 스냅샷에 남은 최신 실측값이 유실돼 5h/1w 가 "—" 로 빈다. 그래서 최신순으로
 * 훑으며 **창별로 첫 실측 utilization 을 병합**하고, capturedAt 은 채택한 창 중 가장 최신값을 쓴다.
 * 실측 창이 하나도 없으면(모두 rateLimitsAvailable=false 등) 최신 스냅샷을 그대로 폴백한다.
 * DB 부재·스키마 미생성·JSON 파손은 모두 "스냅샷 없음"과 같게 취급한다.
 */
function readLatestClaudeUsageSnapshot(databasePath: string): UsageSnapshot | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const rows = db.prepare(
      "SELECT usage_snapshot FROM sessions WHERE usage_snapshot IS NOT NULL ORDER BY updated_at DESC LIMIT 24"
    ).all() as Array<{ usage_snapshot?: unknown }>;
    let fallback: UsageSnapshot | null = null;
    const merged: {
      fiveHour?: UsageWindow;
      sevenDay?: UsageWindow;
      subscriptionType?: UsageSnapshot["subscriptionType"];
      capturedAt?: number;
    } = {};
    for (const row of rows) {
      const raw = row?.usage_snapshot;
      if (typeof raw !== "string" || !raw) continue;
      let parsed: UsageSnapshot;
      try {
        parsed = JSON.parse(raw) as UsageSnapshot;
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || typeof parsed.capturedAt !== "number") continue;
      if (!fallback) fallback = parsed;
      // 창별로 아직 못 채운 칸을, 실측 utilization 을 가진 최신 스냅샷에서 하나씩 채운다.
      let contributed = false;
      if (merged.fiveHour === undefined && windowHasUtilization(parsed.fiveHour)) {
        merged.fiveHour = parsed.fiveHour;
        contributed = true;
      }
      if (merged.sevenDay === undefined && windowHasUtilization(parsed.sevenDay)) {
        merged.sevenDay = parsed.sevenDay;
        contributed = true;
      }
      if (contributed) {
        // rows 는 최신순이라 처음 기여한 스냅샷의 capturedAt 이 가장 최신이다.
        if (merged.capturedAt === undefined) merged.capturedAt = parsed.capturedAt;
        if (merged.subscriptionType === undefined && parsed.subscriptionType != null) {
          merged.subscriptionType = parsed.subscriptionType;
        }
      }
      if (merged.fiveHour !== undefined && merged.sevenDay !== undefined) break;
    }
    if (merged.capturedAt !== undefined) {
      return {
        capturedAt: merged.capturedAt,
        subscriptionType: merged.subscriptionType ?? fallback?.subscriptionType ?? null,
        rateLimitsAvailable: true,
        ...(merged.fiveHour ? { fiveHour: merged.fiveHour } : {}),
        ...(merged.sevenDay ? { sevenDay: merged.sevenDay } : {})
      };
    }
    return fallback;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // 닫기 실패는 표시에 영향이 없다.
    }
  }
}

function isGrokLoginError(error: string | null): boolean {
  return typeof error === "string" && /로그인|login/i.test(error);
}

/**
 * Grok 과금 API의 periodType을 주간/월간 칸으로 정규화한다.
 * 실측 값은 `USAGE_PERIOD_TYPE_WEEKLY` / `USAGE_PERIOD_TYPE_MONTHLY` 이고,
 * 테스트·구버전 호환을 위해 짧은 `WEEKLY` / `MONTHLY` 도 받아들인다.
 */
export function grokPeriodKind(
  periodType: string | null | undefined
): "weekly" | "monthly" | null {
  if (!periodType) return null;
  const normalized = periodType.trim().toUpperCase();
  if (
    normalized === "WEEKLY"
    || normalized === "USAGE_PERIOD_TYPE_WEEKLY"
    || normalized.endsWith("_WEEKLY")
  ) {
    return "weekly";
  }
  if (
    normalized === "MONTHLY"
    || normalized === "USAGE_PERIOD_TYPE_MONTHLY"
    || normalized.endsWith("_MONTHLY")
  ) {
    return "monthly";
  }
  return null;
}

/**
 * Codex 라이브 스냅샷의 primary/secondary를 windowDurationMins로 5시간/주간에 매핑한다.
 * 위치(primary인지 secondary인지)를 가정하지 않고, 스냅샷 부재나 매칭 실패 창은 null로 둔다.
 */
function codexWindows(
  snapshot: Awaited<ReturnType<typeof fetchCodexLiveUsage>>["snapshot"]
): { fiveHour: GuiUsageWindowDto | null; sevenDay: GuiUsageWindowDto | null } {
  let fiveHour: GuiUsageWindowDto | null = null;
  let sevenDay: GuiUsageWindowDto | null = null;
  if (!snapshot) return { fiveHour, sevenDay };
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (!window) continue;
    const dto: GuiUsageWindowDto = { utilization: window.usedPercent, resetsAt: window.resetsAt };
    const mins = window.windowDurationMins;
    // 정확 매칭 우선. 값이 비정형이어도 대략 5시간/주간으로 나눠 칸을 비우지 않는다.
    if (mins === 300 || (mins !== null && mins > 0 && mins <= 360 && fiveHour === null)) {
      fiveHour = dto;
    } else if (mins === 10_080 || (mins !== null && mins >= 1_440 && sevenDay === null)) {
      sevenDay = dto;
    } else if (mins === null && fiveHour === null) {
      fiveHour = dto;
    } else if (mins === null && sevenDay === null) {
      sevenDay = dto;
    }
  }
  return { fiveHour, sevenDay };
}

/**
 * 계정 홈 경로에 표시용 레이블을 붙인다. 기본은 홈 디렉터리 basename(예: `.codex-acct-b`).
 * basename이 겹치면 순번(#1, #2…)을 덧붙여 사용자가 계정을 구분할 수 있게 한다.
 */
export function labelCodexHomes(homes: readonly string[]): Array<{ home: string; label: string }> {
  const counts = new Map<string, number>();
  for (const home of homes) {
    const key = basename(home) || home;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const used = new Map<string, number>();
  return homes.map((home) => {
    const key = basename(home) || home;
    if ((counts.get(key) ?? 0) <= 1) return { home, label: key };
    const index = (used.get(key) ?? 0) + 1;
    used.set(key, index);
    return { home, label: `${key} #${index}` };
  });
}
/**
 * 원시 사용량 소스. 서버는 이 제공자를 createCachedUsageProvider로 감싸 주입받는다.
 *
 * - local: 데몬 호스트에서 DB·CLI 직접 조회(기존 동작).
 * - daemon-cache: 다른 Mac 에서 데몬이 게시한 공유 캐시만 읽어 **데몬 머신 한도**를 표시.
 *   로컬 CLI/DB 를 쓰지 않아 맥북 자체 사용량으로 오염되지 않는다.
 */
export function createUsageProvider(options: UsageSourceOptions): GuiUsageProvider {
  const fetchCodex = options.fetchCodex ?? fetchCodexLiveUsage;
  const fetchGrok = options.fetchGrok ?? fetchGrokLiveUsage;
  const now = options.now ?? Date.now;
  const cwd = options.cwd ?? process.cwd();
  const sourceMode: UsageSourceMode = options.sourceMode ?? "local";
  const cachePaths = options.usageCachePaths ?? [];
  const cacheUrls = options.usageCacheUrls ?? [];
  const codexHome = options.codexHome
    ?? (process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
  // 조회할 Codex 계정 홈 목록. 다계정이 지정되면 그대로, 아니면 단일 홈 하나로 폴백한다.
  const codexHomes = options.codexAccountHomes && options.codexAccountHomes.length > 0
    ? [...options.codexAccountHomes]
    : [codexHome];
  const codexAccounts = labelCodexHomes(codexHomes);

  // 파일(있으면) 우선, 없으면 Tailscale HTTP. 폴링마다 HTTP 를 치지 않도록 짧게 메모리 보관.
  let resolvedCache: DaemonUsageCacheFile | null = null;
  let resolvedAt = Number.NEGATIVE_INFINITY;
  const RESOLVE_TTL_MS = 20_000;

  const resolveCache = async (): Promise<DaemonUsageCacheFile | null> => {
    if (now() - resolvedAt < RESOLVE_TTL_MS && resolvedCache) return resolvedCache;
    const fromFile = cachePaths.length > 0 ? readDaemonUsageCache(cachePaths) : null;
    if (fromFile) {
      resolvedCache = fromFile;
      resolvedAt = now();
      return fromFile;
    }
    const fromHttp = cacheUrls.length > 0
      ? await fetchDaemonUsageCache(cacheUrls, {
        ...(options.usageHttpToken ? { token: options.usageHttpToken } : {})
      })
      : null;
    resolvedCache = fromHttp;
    resolvedAt = now();
    return fromHttp;
  };

  if (sourceMode === "daemon-cache") {
    return {
      async fetchClaudeUsage(): Promise<GuiClaudeUsageDto> {
        const cache = await resolveCache();
        if (!cache) return { ...EMPTY_CLAUDE_USAGE };
        const stale = cache.claude.stale || isDaemonUsageCacheStale(cache, now());
        return { ...cache.claude, stale };
      },
      async fetchCodexUsage(): Promise<GuiCodexUsageDto> {
        const cache = await resolveCache();
        return cache?.codex ?? { accounts: [] };
      },
      async fetchGrokUsage(): Promise<GuiGrokUsageDto> {
        const cache = await resolveCache();
        return cache?.grok ?? { ...EMPTY_GROK_USAGE };
      }
    };
  }

  return {
    async fetchClaudeUsage(): Promise<GuiClaudeUsageDto> {
      const snapshot = readLatestClaudeUsageSnapshot(options.databasePath);
      if (!snapshot) return { ...EMPTY_CLAUDE_USAGE };
      return {
        fiveHour: claudeWindow(snapshot.fiveHour),
        sevenDay: claudeWindow(snapshot.sevenDay),
        stale: now() - snapshot.capturedAt > CLAUDE_SNAPSHOT_STALE_MS,
        capturedAt: snapshot.capturedAt
      };
    },

    async fetchCodexUsage(): Promise<GuiCodexUsageDto> {
      // 계정별로 라이브 조회를 순차 실행한다 — 각 조회는 codex app-server 자식을 띄우므로
      // 병렬 spawn으로 자원을 몰지 않고 등록 순서대로 처리한다. 한 계정의 실패는 그 계정
      // 줄만 빈 창으로 두고 나머지 계정에는 영향을 주지 않는다.
      const accounts: GuiCodexAccountUsageDto[] = [];
      for (const account of codexAccounts) {
        const result = await fetchCodex({
          cwd,
          codexExecutable: options.codexExecutable,
          env: buildCodexEnvironment(account.home),
          timeoutMs: LIVE_FETCH_TIMEOUT_MS
        });
        accounts.push({ label: account.label, ...codexWindows(result.snapshot) });
      }
      return { accounts };
    },

    async fetchGrokUsage(): Promise<GuiGrokUsageDto> {
      const result = await fetchGrok({
        grokExecutable: options.grokExecutable,
        timeoutMs: LIVE_FETCH_TIMEOUT_MS
      });
      const snapshot = result.snapshot;
      if (!snapshot) {
        return { ...EMPTY_GROK_USAGE, loginRequired: isGrokLoginError(result.error) };
      }
      const window: GuiUsageWindowDto = {
        utilization: snapshot.creditUsagePercent,
        resetsAt: snapshot.periodEnd
      };
      const kind = grokPeriodKind(snapshot.periodType);
      if (kind === "weekly") {
        return { ...EMPTY_GROK_USAGE, weekly: window, weeklyReceived: true };
      }
      if (kind === "monthly") {
        return { ...EMPTY_GROK_USAGE, monthly: window, monthlyReceived: true };
      }
      // periodType이 비어도 크레딧 %가 있으면 주간 칸에 표시(빈 스트립보다 정보가 낫다).
      if (snapshot.creditUsagePercent !== null && Number.isFinite(snapshot.creditUsagePercent)) {
        return { ...EMPTY_GROK_USAGE, weekly: window, weeklyReceived: true };
      }
      return { ...EMPTY_GROK_USAGE };
    }
  };
}

/**
 * 폴칭용 캐시 래퍼. Codex/Grok은 라이브 조회 비용이 크므로 TTL과 inflight 단일화로
 * 다중 탭·연속 폴칭에서도 spawn/HTTP가 1회만 발생하게 한다. Grok은 API가 한 번에
 * 하나의 periodType만 주므로 칸별 마지막값을 계속 보관한다. Claude(DB 읽기)는
 * 저렴해 캐시하지 않는다. 조회 실패도 TTL 동안 캐시해 실패 반복 시 fetch 폭주를 막는다.
 */
export function createCachedUsageProvider(
  provider: GuiUsageProvider,
  options: UsageCacheOptions = {}
): GuiUsageProvider {
  const now = options.now ?? Date.now;
  const codexTtlMs = options.codexTtlMs ?? CODEX_CACHE_TTL_MS;
  const grokTtlMs = options.grokTtlMs ?? GROK_CACHE_TTL_MS;

  let codexValue: GuiCodexUsageDto = { accounts: [] };
  let codexFetchedAt = Number.NEGATIVE_INFINITY;
  let codexInflight: Promise<GuiCodexUsageDto> | null = null;

  let grokWeekly: { window: GuiUsageWindowDto | null; received: boolean } = { window: null, received: false };
  let grokMonthly: { window: GuiUsageWindowDto | null; received: boolean } = { window: null, received: false };
  let grokLoginRequired = false;
  let grokFetchedAt = Number.NEGATIVE_INFINITY;
  let grokInflight: Promise<GuiGrokUsageDto> | null = null;

  const grokSnapshot = (): GuiGrokUsageDto => ({
    weekly: grokWeekly.window,
    monthly: grokMonthly.window,
    weeklyReceived: grokWeekly.received,
    monthlyReceived: grokMonthly.received,
    loginRequired: grokLoginRequired
  });

  return {
    async fetchClaudeUsage(): Promise<GuiClaudeUsageDto> {
      try {
        return await provider.fetchClaudeUsage();
      } catch {
        return { ...EMPTY_CLAUDE_USAGE };
      }
    },

    async fetchCodexUsage(): Promise<GuiCodexUsageDto> {
      if (now() - codexFetchedAt < codexTtlMs) return codexValue;
      if (codexInflight) return codexInflight;
      codexInflight = (async () => {
        try {
          codexValue = await provider.fetchCodexUsage();
        } catch {
          codexValue = { accounts: [] };
        } finally {
          codexFetchedAt = now();
          codexInflight = null;
        }
        return codexValue;
      })();
      return codexInflight;
    },

    async fetchGrokUsage(): Promise<GuiGrokUsageDto> {
      if (now() - grokFetchedAt < grokTtlMs) return grokSnapshot();
      if (grokInflight) return grokInflight;
      grokInflight = (async () => {
        try {
          const result = await provider.fetchGrokUsage();
          if (result.weeklyReceived) grokWeekly = { window: result.weekly, received: true };
          if (result.monthlyReceived) grokMonthly = { window: result.monthly, received: true };
          grokLoginRequired = result.loginRequired;
        } catch {
          // 조회 실패 시 칸별 마지막 상태를 그대로 유지한다.
        } finally {
          grokFetchedAt = now();
          grokInflight = null;
        }
        return grokSnapshot();
      })();
      return grokInflight;
    }
  };
}
