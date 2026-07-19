import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { terminateChildTree } from "./child-process.js";
import type { CodexLiveUsageSnapshot, CodexLiveUsageWindow } from "./types.js";

const MAX_STDERR_BYTES = 16 * 1024;

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string; };
}

export interface CodexLiveUsageResult {
  snapshot: CodexLiveUsageSnapshot | null;
  error: string | null;
}

export interface CodexLiveUsageOptions {
  cwd: string;
  codexExecutable?: string | undefined;
  env: Record<string, string>;
  timeoutMs?: number;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function timestamp(value: unknown): string | null {
  const numeric = numberOrNull(value);
  if (numeric !== null) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(milliseconds).toISOString();
  }
  return stringOrNull(value);
}

function windowFrom(value: unknown): CodexLiveUsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    usedPercent: numberOrNull(record.usedPercent),
    windowDurationMins: numberOrNull(record.windowDurationMins),
    resetsAt: timestamp(record.resetsAt)
  };
}

function normalizeRateLimits(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const response = value as Record<string, unknown>;
  const limits = (
    response.rateLimitsByLimitId
    && typeof response.rateLimitsByLimitId === "object"
    && (response.rateLimitsByLimitId as Record<string, unknown>).codex
  ) || response.rateLimits;
  if (!limits || typeof limits !== "object") return null;
  const record = limits as Record<string, unknown>;
  const credits = record.credits && typeof record.credits === "object"
    ? record.credits as Record<string, unknown>
    : null;
  const resetCredits = response.rateLimitResetCredits && typeof response.rateLimitResetCredits === "object"
    ? response.rateLimitResetCredits as Record<string, unknown>
    : null;
  return {
    planType: stringOrNull(record.planType),
    primary: windowFrom(record.primary),
    secondary: windowFrom(record.secondary),
    resetCreditsAvailable: numberOrNull(resetCredits?.availableCount),
    creditsBalance: stringOrNull(credits?.balance),
    rateLimitReachedType: stringOrNull(record.rateLimitReachedType)
  };
}

function normalizeTokenUsage(value: unknown) {
  const empty = {
    lifetimeTokens: null,
    peakDailyTokens: null,
    currentStreakDays: null
  };
  if (!value || typeof value !== "object") return empty;
  const summary = (value as Record<string, unknown>).summary;
  if (!summary || typeof summary !== "object") return empty;
  const record = summary as Record<string, unknown>;
  return {
    lifetimeTokens: numberOrNull(record.lifetimeTokens),
    peakDailyTokens: numberOrNull(record.peakDailyTokens),
    currentStreakDays: numberOrNull(record.currentStreakDays)
  };
}

export async function fetchCodexLiveUsage(
  options: CodexLiveUsageOptions
): Promise<CodexLiveUsageResult> {
  const child = spawn(options.codexExecutable ?? "codex", ["app-server", "--stdio"], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true
  });

  let stderr = "";
  let spawnError: string | null = null;
  let rateLimits: unknown;
  let tokenUsage: unknown;
  let initialized = false;
  let settled = false;
  const exitCodePromise = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });

  const timer = setTimeout(() => {
    if (settled) return;
    terminateChildTree(child);
  }, options.timeoutMs ?? 15_000);

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
  });
  child.once("error", (error) => {
    spawnError = error.message;
  });

  function send(id: number, method: string, params?: unknown): void {
    const request = params === undefined ? { id, method } : { id, method, params };
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  send(1, "initialize", {
    clientInfo: { name: "chatkjb-usage", title: null, version: "0.1.0" },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      optOutNotificationMethods: []
    }
  });

  const lines = createInterface({ input: child.stdout });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (parsed.error) {
        throw new Error(parsed.error.message ?? "Codex app-server request failed");
      }
      if (parsed.id === 1 && !initialized) {
        initialized = true;
        send(2, "account/rateLimits/read");
        send(3, "account/usage/read");
      } else if (parsed.id === 2) {
        rateLimits = parsed.result;
      } else if (parsed.id === 3) {
        tokenUsage = parsed.result;
      }
      if (rateLimits !== undefined && tokenUsage !== undefined) break;
    }
  } catch (error) {
    settled = true;
    const killTimer = terminateChildTree(child);
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    await exitCodePromise;
    if (killTimer) clearTimeout(killTimer);
    return { snapshot: null, error: error instanceof Error ? error.message : String(error) };
  }

  settled = true;
  const killTimer = terminateChildTree(child);
  clearTimeout(timer);
  lines.close();
  child.stdin.end();
  await exitCodePromise;
  if (killTimer) clearTimeout(killTimer);

  if (spawnError) return { snapshot: null, error: spawnError };
  const normalizedLimits = normalizeRateLimits(rateLimits);
  if (!normalizedLimits) {
    return {
      snapshot: null,
      error: stderr.trim() || "Codex app-server가 사용량 한도 정보를 반환하지 않았습니다."
    };
  }
  return {
    snapshot: {
      capturedAt: Date.now(),
      ...normalizedLimits,
      ...normalizeTokenUsage(tokenUsage)
    },
    error: null
  };
}
