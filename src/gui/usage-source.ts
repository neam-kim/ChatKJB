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
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchCodexLiveUsage } from "../codex-live-usage.js";
import { fetchGrokLiveUsage } from "../grok-live-usage.js";
import { buildCodexEnvironment } from "../session-environment.js";
import type {
  GuiClaudeUsageDto,
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

export interface UsageSourceOptions {
  databasePath: string;
  codexExecutable: string;
  grokExecutable: string;
  // 단일 기본 CODEX_HOME만 지원한다(CODEX_ACCOUNT_HOMES 다중 계정은 미대응).
  codexHome?: string;
  cwd?: string;
  fetchCodex?: typeof fetchCodexLiveUsage;
  fetchGrok?: typeof fetchGrokLiveUsage;
  now?: () => number;
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
const EMPTY_CODEX_USAGE: GuiCodexUsageDto = { fiveHour: null, sevenDay: null };
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
    fetchCodexUsage: async () => ({ ...EMPTY_CODEX_USAGE }),
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
 * 공유 SQLite에서 가장 최근에 갱신된 세션의 usage_snapshot 1건을 읽는다.
 * 읽기 전용 핸들을 매 폴칭마다 열고 닫으므로 WAL 체크포인트와 무관하게 항상 신선값을 본다.
 * DB 부재·스키마 미생성·JSON 파손은 모두 "스냅샷 없음"과 같게 취급한다.
 */
function readLatestClaudeUsageSnapshot(databasePath: string): UsageSnapshot | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const row = db.prepare(
      "SELECT usage_snapshot FROM sessions WHERE usage_snapshot IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
    ).get() as { usage_snapshot?: unknown } | undefined;
    const raw = row?.usage_snapshot;
    if (typeof raw !== "string" || !raw) return null;
    const parsed = JSON.parse(raw) as UsageSnapshot;
    if (!parsed || typeof parsed !== "object" || typeof parsed.capturedAt !== "number") return null;
    return parsed;
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
 * 원시 사용량 소스. 캐시 없이 매번 실제 조회를 수행한다 — 서버는 이 제공자를
 * createCachedUsageProvider로 감싸 주입받는다.
 */
export function createUsageProvider(options: UsageSourceOptions): GuiUsageProvider {
  const fetchCodex = options.fetchCodex ?? fetchCodexLiveUsage;
  const fetchGrok = options.fetchGrok ?? fetchGrokLiveUsage;
  const now = options.now ?? Date.now;
  const cwd = options.cwd ?? process.cwd();
  const codexHome = options.codexHome
    ?? (process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));

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
      const result = await fetchCodex({
        cwd,
        codexExecutable: options.codexExecutable,
        env: buildCodexEnvironment(codexHome),
        timeoutMs: LIVE_FETCH_TIMEOUT_MS
      });
      const snapshot = result.snapshot;
      if (!snapshot) return { ...EMPTY_CODEX_USAGE };
      // primary/secondary 위치를 가정하지 않고 windowDurationMins로 5시간/주간을 고른다.
      let fiveHour: GuiUsageWindowDto | null = null;
      let sevenDay: GuiUsageWindowDto | null = null;
      for (const window of [snapshot.primary, snapshot.secondary]) {
        if (!window) continue;
        const dto: GuiUsageWindowDto = { utilization: window.usedPercent, resetsAt: window.resetsAt };
        if (window.windowDurationMins === 300) fiveHour = dto;
        else if (window.windowDurationMins === 10_080) sevenDay = dto;
      }
      return { fiveHour, sevenDay };
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
      const periodType = snapshot.periodType?.trim().toUpperCase();
      if (periodType === "WEEKLY") {
        return { ...EMPTY_GROK_USAGE, weekly: window, weeklyReceived: true };
      }
      if (periodType === "MONTHLY") {
        return { ...EMPTY_GROK_USAGE, monthly: window, monthlyReceived: true };
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

  let codexValue: GuiCodexUsageDto = { ...EMPTY_CODEX_USAGE };
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
          codexValue = { ...EMPTY_CODEX_USAGE };
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
