import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveGrokExecutable } from "./cli-resolver.js";
import { buildGrokSubscriptionEnvironment } from "./grok-environment.js";
import type { GrokBillingSnapshot, GrokProductUsage } from "./types.js";

// grok CLI 자체가 크레딧 잔량을 읽을 때 쓰는 경로와 동일하다(바이너리의 extensions/billing.rs).
// CLI에는 usage/quota 서브커맨드가 없어서 이 엔드포인트가 유일한 한도 조회 수단이다.
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const DEFAULT_TIMEOUT_MS = 15_000;
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;
const execFileAsync = promisify(execFile);

export interface GrokLiveUsageResult {
  snapshot: GrokBillingSnapshot | null;
  error: string | null;
}

interface GrokAccessToken {
  token: string;
  expiresAt: number | null;
}

export interface GrokLiveUsageOptions {
  timeoutMs?: number;
  clientVersion?: string;
  grokExecutable?: string;
  home?: string;
  fetchImpl?: typeof fetch;
  refreshAuth?: () => Promise<void>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** `{"val": 0}` 형태로 감싸 오는 금액 필드를 푼다. */
function amount(value: unknown): number | null {
  if (!value || typeof value !== "object") return numberOrNull(value);
  return numberOrNull((value as Record<string, unknown>).val);
}

/**
 * `~/.grok/auth.json`에서 OIDC access token을 읽는다. 파일은 issuer별 항목을 담은 맵이고
 * 각 항목의 `key`가 bearer 토큰이다. `expires_at`도 함께 읽어 만료 전에 CLI 갱신을 요청한다.
 */
async function readGrokAccessToken(home = homedir()): Promise<GrokAccessToken | null> {
  const raw = await readFile(join(home, ".grok", "auth.json"), "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const entry of Object.values(parsed)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const key = record.key;
    if (typeof key !== "string" || !key.trim()) continue;
    const expiresAtValue = record.expires_at;
    const expiresAt = typeof expiresAtValue === "string" ? Date.parse(expiresAtValue) : NaN;
    return { token: key, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
  }
  return null;
}

async function refreshGrokAuth(options: GrokLiveUsageOptions): Promise<void> {
  if (options.refreshAuth) {
    await options.refreshAuth();
    return;
  }
  await execFileAsync(
    options.grokExecutable ?? resolveGrokExecutable(),
    ["models"],
    {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      env: buildGrokSubscriptionEnvironment()
    }
  );
}

function tokenNeedsRefresh(token: GrokAccessToken): boolean {
  return token.expiresAt !== null && token.expiresAt <= Date.now() + ACCESS_TOKEN_EXPIRY_SKEW_MS;
}

export function snapshotFromGrokBilling(
  payload: unknown,
  capturedAt = Date.now()
): GrokBillingSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const config = (payload as Record<string, unknown>).config;
  if (!config || typeof config !== "object") return null;
  const record = config as Record<string, unknown>;
  const period = (record.currentPeriod ?? {}) as Record<string, unknown>;
  const products: GrokProductUsage[] = Array.isArray(record.productUsage)
    ? record.productUsage
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({
        product: stringOrNull(item.product) ?? "unknown",
        usagePercent: numberOrNull(item.usagePercent)
      }))
    : [];
  return {
    capturedAt,
    creditUsagePercent: numberOrNull(record.creditUsagePercent),
    periodType: stringOrNull(period.type),
    periodStart: stringOrNull(period.start) ?? stringOrNull(record.billingPeriodStart),
    periodEnd: stringOrNull(period.end) ?? stringOrNull(record.billingPeriodEnd),
    productUsage: products,
    onDemandCap: amount(record.onDemandCap),
    onDemandUsed: amount(record.onDemandUsed),
    prepaidBalance: amount(record.prepaidBalance)
  };
}

/** grok.com 과금 API에서 현재 크레딧 한도를 조회한다. 실패는 예외 대신 error 필드로 돌려준다. */
export async function fetchGrokLiveUsage(
  options: GrokLiveUsageOptions = {}
): Promise<GrokLiveUsageResult> {
  let token: GrokAccessToken | null;
  try {
    token = await readGrokAccessToken(options.home);
  } catch {
    return { snapshot: null, error: "grok 로그인 정보 없음 (`grok login` 필요)" };
  }
  if (!token) return { snapshot: null, error: "grok 로그인 정보 없음 (`grok login` 필요)" };

  let refreshed = false;
  const refresh = async (): Promise<string | null> => {
    try {
      await refreshGrokAuth(options);
      refreshed = true;
      token = await readGrokAccessToken(options.home);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  if (tokenNeedsRefresh(token)) {
    const refreshError = await refresh();
    if (refreshError || !token) {
      return {
        snapshot: null,
        error: `인증 갱신 실패${refreshError ? ` (${refreshError})` : ""} (grok login 필요)`
      };
    }
  }

  const request = async (accessToken: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      return await (options.fetchImpl ?? fetch)(BILLING_URL, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "x-grok-client-version": options.clientVersion ?? "0.2.101",
          "x-grok-client-mode": "cli",
          accept: "application/json"
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let response = await request(token.token);
    if ((response.status === 401 || response.status === 403) && !refreshed) {
      const refreshError = await refresh();
      if (refreshError || !token) {
        return {
          snapshot: null,
          error: `인증 갱신 실패${refreshError ? ` (${refreshError})` : ""} (grok login 필요)`
        };
      }
      response = await request(token.token);
    }
    if (!response.ok) {
      return {
        snapshot: null,
        error: response.status === 401 || response.status === 403
          ? "인증 만료 (`grok login` 필요)"
          : `HTTP ${response.status}`
      };
    }
    const snapshot = snapshotFromGrokBilling(await response.json());
    return snapshot
      ? { snapshot, error: null }
      : { snapshot: null, error: "과금 응답을 해석하지 못했습니다." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      snapshot: null,
      error: error instanceof DOMException && error.name === "AbortError" ? "조회 시간 초과" : message
    };
  }
}
