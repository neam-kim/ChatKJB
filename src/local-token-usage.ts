import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "./types.js";
import { parseStoredAgyUsage, parseStoredGrokUsage } from "./usage.js";

/**
 * 이 맥미니에서 각 에이전트가 지금까지 쓴 누적 토큰을 로컬 기록만으로 집계한다(/ustoken).
 *
 * 원천이 제공자마다 다르다:
 *   - Claude : ~/.claude/projects/**\/*.jsonl 의 assistant 메시지별 usage. 같은 응답이 여러 줄에
 *              중복 기록될 수 있어 (message.id, requestId)로 중복을 제거한다.
 *   - Codex  : 각 CODEX_HOME 의 rollout-*.jsonl 에 세션 누적치(total_token_usage)가 갱신되며
 *              쌓이므로, 파일마다 **마지막** 값만 취해 더한다(전부 더하면 중복 합산).
 *   - agy    : CLI가 사용량을 디스크에 남기지 않아 봇 DB(sessions.agy_usage)의 측정값을 합산한다.
 *   - grok   : 위와 같은 이유로 봇 DB(sessions.grok_usage)에 턴마다 누적해 둔 값을 합산한다.
 *              grok CLI 0.2.99 미만은 사용량을 주지 않으므로 그 이전 실행분은 잡히지 않는다.
 */
export interface ProviderTokenUsage {
  provider: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 집계에 들어간 단위 수(세션/파일/메시지) — 표시에만 쓴다. */
  units: number;
  /** 집계가 불완전한 이유. 없으면 null. */
  caveat: string | null;
}

export interface LocalTokenUsageReport {
  capturedAt: number;
  providers: ProviderTokenUsage[];
  totalTokens: number;
}

const EMPTY = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, units: 0 };

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 디렉터리를 재귀 순회하며 조건에 맞는 파일 경로를 모은다. 없는 디렉터리는 조용히 건너뛴다. */
async function collectFiles(
  dir: string,
  matches: (name: string) => boolean,
  found: string[] = []
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(path, matches, found);
    else if (entry.isFile() && matches(entry.name)) found.push(path);
  }
  return found;
}

async function readClaudeUsage(home: string): Promise<ProviderTokenUsage> {
  const files = await collectFiles(join(home, ".claude", "projects"), (n) => n.endsWith(".jsonl"));
  const seen = new Set<string>();
  const acc = { ...EMPTY };
  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.includes("\"usage\"")) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const message = entry.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (!usage) continue;
      // 같은 assistant 응답이 요약·재개 과정에서 여러 트랜스크립트에 복제될 수 있다.
      const key = `${String(message?.id)}:${String(entry.requestId)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cached = count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens);
      acc.inputTokens += count(usage.input_tokens);
      acc.cachedTokens += cached;
      acc.outputTokens += count(usage.output_tokens);
    }
  }
  acc.units = seen.size;
  acc.totalTokens = acc.inputTokens + acc.cachedTokens + acc.outputTokens;
  return { provider: "Claude", ...acc, caveat: null };
}

/** rollout 한 줄에서 total_token_usage 객체를 찾는다(감싸는 이벤트 모양이 버전마다 다르다). */
function findTotalUsage(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const direct = record.total_token_usage;
  if (direct && typeof direct === "object") return direct as Record<string, unknown>;
  for (const child of Object.values(record)) {
    const nested = findTotalUsage(child);
    if (nested) return nested;
  }
  return null;
}

async function readCodexUsage(home: string): Promise<ProviderTokenUsage> {
  // 봇은 계정별로 CODEX_HOME을 분리해 쓴다(~/.codex, ~/.codex-acct-b, ...). 전부 훑는다.
  let homes: string[];
  try {
    homes = (await readdir(home, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\.codex(-.+)?$/.test(entry.name))
      .map((entry) => join(home, entry.name));
  } catch {
    homes = [];
  }

  const acc = { ...EMPTY };
  for (const codexHome of homes) {
    const files = await collectFiles(
      join(codexHome, "sessions"),
      (n) => n.startsWith("rollout-") && n.endsWith(".jsonl")
    );
    for (const file of files) {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        continue;
      }
      // total_token_usage는 세션 내 누적치라 마지막 줄의 값이 그 세션의 총합이다.
      let last: Record<string, unknown> | null = null;
      for (const line of raw.split("\n")) {
        if (!line.includes("total_token_usage")) continue;
        try {
          const found = findTotalUsage(JSON.parse(line));
          if (found) last = found;
        } catch {
          continue;
        }
      }
      if (!last) continue;
      // Codex의 input_tokens는 캐시 히트를 포함한다(Claude/Grok은 제외). 열을 나란히 놓고
      // 더할 수 있도록 "캐시 제외 입력"으로 맞춘다.
      const cached = count(last.cached_input_tokens);
      acc.units += 1;
      acc.inputTokens += Math.max(0, count(last.input_tokens) - cached);
      acc.cachedTokens += cached;
      acc.outputTokens += count(last.output_tokens);
      acc.totalTokens += count(last.total_tokens);
    }
  }
  return { provider: "Codex", ...acc, caveat: null };
}

function readAgyUsage(sessions: SessionRecord[]): ProviderTokenUsage {
  const acc = { ...EMPTY };
  for (const session of sessions) {
    const usage = parseStoredAgyUsage(session.agyUsage);
    if (!usage) continue;
    // Gemini 규약상 cachedContentTokenCount는 promptTokenCount에 포함된다 — Codex와 같은 보정.
    const cached = count(usage.cachedContentTokenCount);
    acc.units += 1;
    acc.inputTokens += Math.max(0, count(usage.promptTokenCount) - cached);
    acc.cachedTokens += cached;
    acc.outputTokens += count(usage.candidatesTokenCount) + count(usage.thoughtsTokenCount);
    acc.totalTokens += count(usage.totalTokenCount);
  }
  return {
    provider: "agy",
    ...acc,
    caveat: "봇을 통한 실행만 집계 (CLI가 사용량을 디스크에 남기지 않음)"
  };
}

function readGrokUsage(sessions: SessionRecord[]): ProviderTokenUsage {
  const acc = { ...EMPTY };
  for (const session of sessions) {
    const usage = parseStoredGrokUsage(session.grokUsage);
    if (!usage) continue;
    acc.units += 1;
    acc.inputTokens += count(usage.inputTokens);
    acc.cachedTokens += count(usage.cacheReadInputTokens);
    acc.outputTokens += count(usage.outputTokens);
    acc.totalTokens += count(usage.totalTokens);
  }
  return {
    provider: "Grok",
    ...acc,
    caveat: "봇을 통한 grok 0.2.99+ 실행만 집계 (그 이전 CLI는 사용량 미제공)"
  };
}

export async function collectLocalTokenUsage(
  sessions: SessionRecord[],
  home = homedir()
): Promise<LocalTokenUsageReport> {
  // 디스크 스캔 두 건은 서로 독립이라 함께 돌린다.
  const [claude, codex] = await Promise.all([readClaudeUsage(home), readCodexUsage(home)]);
  const providers = [claude, codex, readAgyUsage(sessions), readGrokUsage(sessions)];
  return {
    capturedAt: Date.now(),
    providers,
    totalTokens: providers.reduce((sum, provider) => sum + provider.totalTokens, 0)
  };
}
