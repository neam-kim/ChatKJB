import { query, type ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { terminateChildTree } from "./child-process.js";
import { buildGrokSubscriptionEnvironment } from "./grok-environment.js";
import type { ProviderKind } from "./types.js";

const execFileAsync = promisify(execFile);
// Claude 모델 조회는 Claude Code 자식 프로세스를 띄우므로 콜드스타트 여유를 둔다.
const CLAUDE_DISCOVERY_TIMEOUT_MS = 20_000;
const CODEX_DISCOVERY_TIMEOUT_MS = 15_000;
const AGY_DISCOVERY_TIMEOUT_MS = 15_000;
const GROK_DISCOVERY_TIMEOUT_MS = 15_000;

export type ClaudeThinkingLevel =
  | "adaptive"
  | "off"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

// Grok CLI가 보고하는 `--reasoning-effort` 값이다. CLI 버전에 따라 달라질 수 있다.
export type GrokReasoningEffort = string;

export interface ThinkingOption {
  id: ClaudeThinkingLevel;
  label: string;
}

export interface CodexReasoningOption {
  id: CodexReasoningEffort;
  label: string;
}

export interface ClaudeModelOption {
  id: string;
  label: string;
  aliases: string[];
  thinkingOptions: ThinkingOption[];
  source: "api" | "fallback";
}

export interface CodexModelOption {
  id: string;
  label: string;
  reasoningOptions: CodexReasoningOption[];
  defaultReasoning: CodexReasoningEffort;
  source: "cli" | "fallback";
}

// agy 추론 강도는 CLI 모델명의 (Low/Medium/High) 변형으로 제어한다.
// null이면 선택한 모델 변형을 그대로 쓴다. Codex와 동일하게 /effort 명령으로 노출한다.
export type AgyThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface AgyThinkingOption {
  id: AgyThinkingLevel;
  label: string;
}

export interface AgyModelOption {
  id: string;
  label: string;
  source: "cli" | "fallback";
}

export interface GrokModelOption {
  id: string;
  label: string;
  source: "cli" | "fallback";
}

export interface ModelCatalog {
  claudeModels: ClaudeModelOption[];
  codexModels: CodexModelOption[];
  agyModels: AgyModelOption[];
  grokModels: GrokModelOption[];
  /** 기동 시 Grok CLI가 실제로 보고한 `--reasoning-effort` 허용 목록. */
  grokReasoningEfforts?: GrokReasoningEffort[];
}

export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_AGY_MODEL = "gemini-3.1-pro-preview";
export const DEFAULT_GROK_MODEL = "grok-4.5";
export const DEFAULT_THINKING_LEVEL: ClaudeThinkingLevel = "adaptive";
// Claude 작업량(effort). API 기본값과 동일하게 high. null이면 SDK에 effort를 넘기지 않아 API 기본(high)이 적용된다.
export const DEFAULT_CLAUDE_EFFORT: ClaudeThinkingLevel = "high";
export const DEFAULT_CODEX_REASONING: CodexReasoningEffort = "high";
export const DEFAULT_GROK_REASONING: GrokReasoningEffort = "high";
// agy thinking 기본값. null이면 선택한 CLI 모델 변형을 그대로 사용한다.
export const DEFAULT_AGY_THINKING_LEVEL: AgyThinkingLevel | null = null;

// /thinking은 확장적 사고 on/off만, /power는 작업량(effort) 수준만 다룬다. 두 축은 Claude API에서
// 서로 독립이다(thinking: adaptive|disabled vs output_config.effort: low~max).
const THINKING_TOGGLE_IDS: ClaudeThinkingLevel[] = ["adaptive", "off"];
const CLAUDE_EFFORT_IDS: ClaudeThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];

const CLAUDE_THINKING_LABELS: Record<ClaudeThinkingLevel, string> = {
  adaptive: "자동 (Adaptive)",
  off: "끄기 (Off)",
  low: "낮음 (Low)",
  medium: "보통 (Medium)",
  high: "높음 (High)",
  xhigh: "매우 높음 (xHigh)",
  max: "최대 (Max)"
};

const CODEX_REASONING_LABELS: Record<CodexReasoningEffort, string> = {
  minimal: "최소 (Minimal)",
  low: "낮음 (Low)",
  medium: "보통 (Medium)",
  high: "높음 (High)",
  xhigh: "매우 높음 (xHigh)"
};

// agy thinking 4단계 레이블. null은 선택한 CLI 모델 변형을 그대로 쓰는 "모델 기본"이다.
const AGY_THINKING_LABELS: Record<AgyThinkingLevel, string> = {
  minimal: "최소 (Minimal)",
  low: "낮음 (Low)",
  medium: "보통 (Medium)",
  high: "높음 (High)"
};

export const FALLBACK_CLAUDE_MODELS: ClaudeModelOption[] = [
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    aliases: ["opus", "opus-4-8"],
    thinkingOptions: thinkingOptions(["adaptive", "low", "medium", "high", "xhigh", "max", "off"]),
    source: "fallback"
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    aliases: ["sonnet", "sonnet-4-6"],
    thinkingOptions: thinkingOptions(["adaptive", "low", "medium", "high", "xhigh", "max", "off"]),
    source: "fallback"
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
    aliases: ["fable", "fable-5"],
    thinkingOptions: thinkingOptions(["adaptive", "low", "medium", "high", "xhigh", "max", "off"]),
    source: "fallback"
  }
];

export const FALLBACK_CODEX_MODELS: CodexModelOption[] = [
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    reasoningOptions: codexReasoningOptions(["low", "medium", "high", "xhigh"]),
    defaultReasoning: "high",
    source: "fallback"
  }
];

export const FALLBACK_AGY_MODELS: AgyModelOption[] = [
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", source: "fallback" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", source: "fallback" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", source: "fallback" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", source: "fallback" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", source: "fallback" }
];

export const FALLBACK_GROK_MODELS: GrokModelOption[] = [
  { id: "grok-4.5", label: "Grok 4.5", source: "fallback" },
  { id: "grok-composer-2.5-fast", label: "Grok Composer 2.5 Fast", source: "fallback" }
];

export const FALLBACK_MODEL_CATALOG: ModelCatalog = {
  claudeModels: FALLBACK_CLAUDE_MODELS,
  codexModels: FALLBACK_CODEX_MODELS,
  agyModels: FALLBACK_AGY_MODELS,
  grokModels: FALLBACK_GROK_MODELS,
  grokReasoningEfforts: []
};

function thinkingOptions(levels: ClaudeThinkingLevel[]): ThinkingOption[] {
  return [...new Set(levels)].map((id) => ({ id, label: CLAUDE_THINKING_LABELS[id] }));
}

function codexReasoningOptions(levels: CodexReasoningEffort[]): CodexReasoningOption[] {
  return [...new Set(levels)].map((id) => ({ id, label: CODEX_REASONING_LABELS[id] }));
}

export function thinkingLabel(level: string | null | undefined): string {
  return CLAUDE_THINKING_LABELS[level as ClaudeThinkingLevel] ?? "자동 (Adaptive)";
}

export function codexReasoningLabel(id: string | null | undefined): string {
  return CODEX_REASONING_LABELS[id as CodexReasoningEffort] ?? "높음 (High)";
}

export function grokReasoningOptions(
  catalog: Pick<ModelCatalog, "grokReasoningEfforts">
): Array<{ id: GrokReasoningEffort; label: string; }> {
  return (catalog.grokReasoningEfforts ?? []).map((id) => ({ id, label: grokReasoningLabel(id) }));
}

/** 저장된 값은 CLI가 이번 기동에서 실제 보고한 허용 목록 안에서만 전달한다. */
export function normalizeGrokReasoningEffort(
  value: string | null | undefined,
  supported: readonly GrokReasoningEffort[] | undefined
): GrokReasoningEffort | undefined {
  if (!supported?.length) return undefined;
  if (value && supported.includes(value)) return value;
  return supported.includes(DEFAULT_GROK_REASONING)
    ? DEFAULT_GROK_REASONING
    : supported[0];
}

export function grokReasoningLabel(id: string | null | undefined): string {
  return id ? id : "모델 기본";
}

/** agy thinking 표시 라벨. null/없음이면 "모델 기본"을 반환한다. */
export function agyThinkingLabel(level: string | null | undefined): string {
  if (!level) return "모델 기본";
  return AGY_THINKING_LABELS[level as AgyThinkingLevel] ?? "모델 기본";
}

function agyModelFamilyKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/preview/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** 현재 CLI 카탈로그가 같은 모델 계열에 실제로 제공하는 강도만 노출한다. */
export function agyThinkingOptionsForModel(
  catalog: ModelCatalog,
  id: string | null | undefined
): AgyThinkingOption[] {
  const normalized = normalizeAgyModelForCatalog(catalog, id);
  const key = agyModelFamilyKey(normalized);
  const available = new Set<AgyThinkingLevel>();
  for (const option of catalog.agyModels) {
    if (agyModelFamilyKey(option.id) !== key) continue;
    const level = option.id.toLowerCase().match(/\((low|medium|high)\)/)?.[1];
    if (level) available.add(level as AgyThinkingLevel);
  }
  const levels = available.size > 0
    ? (["low", "medium", "high"] as AgyThinkingLevel[]).filter((level) => available.has(level))
    // 모델 탐색 자체가 실패한 fallback 카탈로그에서는 기존 3단계 입력 표면을 유지한다.
    : (["low", "medium", "high"] as AgyThinkingLevel[]);
  return levels
    .map((level) => ({ id: level, label: AGY_THINKING_LABELS[level] }));
}

/** 문자열 입력을 정규화된 AgyThinkingLevel로 변환. 인식할 수 없으면 undefined를 반환한다. */
export function resolveAgyThinkingLevel(input: string): AgyThinkingLevel | undefined {
  const value = input.trim().toLowerCase() as AgyThinkingLevel;
  return AGY_THINKING_LABELS[value] ? value : undefined;
}

export function modelLabel(catalog: ModelCatalog, id: string): string {
  return catalog.claudeModels.find((option) => option.id === id)?.label ?? id;
}

export function codexModelLabel(catalog: ModelCatalog, id: string | null | undefined): string {
  if (!id) return codexModelLabel(catalog, DEFAULT_CODEX_MODEL);
  return catalog.codexModels.find((option) => option.id === id)?.label ?? id;
}

export function resolveModel(catalog: ModelCatalog, input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (!value) return undefined;
  const direct = catalog.claudeModels.find((option) =>
    option.id.toLowerCase() === value || option.aliases.includes(value)
  );
  return direct?.id;
}

/** Claude SDK가 보고한 Fable 계열 가운데 버전 번호가 가장 큰 모델을 고른다. */
export function latestClaudeFableModel(catalog: ModelCatalog): ClaudeModelOption | undefined {
  const candidates = catalog.claudeModels.filter((option) =>
    option.source === "api" && [option.id, option.label, ...option.aliases]
      .some((value) => value.toLowerCase().includes("fable"))
  );
  return candidates.sort((left, right) => {
    const leftParts = [...`${left.id} ${left.label}`.matchAll(/\d+/g)]
      .map((match) => Number(match[0]));
    const rightParts = [...`${right.id} ${right.label}`.matchAll(/\d+/g)]
      .map((match) => Number(match[0]));
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return right.id.localeCompare(left.id);
  })[0];
}

export function resolveCodexModel(catalog: ModelCatalog, input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (!value) return undefined;
  return catalog.codexModels.find((option) => option.id.toLowerCase() === value)?.id;
}

export function agyModelLabel(catalog: ModelCatalog, id: string | null | undefined): string {
  const normalized = normalizeAgyModelForCatalog(catalog, id);
  return catalog.agyModels.find((option) => option.id === normalized)?.label ?? normalized;
}

/**
 * agy CLI 0.5+는 `Gemini 3.5 Flash (Medium)` 같은 표시명을 --model 값으로 받는다.
 * 이전 ChatKJB가 저장한 slug(`gemini-3.5-flash`)도 현재 동적 카탈로그에 대응시켜
 * 기존 기본값·세션이 CLI 업그레이드 뒤 곧바로 실패하지 않게 한다.
 */
export function normalizeAgyModelForCatalog(
  catalog: ModelCatalog,
  id: string | null | undefined
): string {
  const requested = id?.trim() || DEFAULT_AGY_MODEL;
  const exact = catalog.agyModels.find(
    (option) => option.id.toLowerCase() === requested.toLowerCase()
  );
  if (exact) return exact.id;

  const key = agyModelFamilyKey(requested);
  const matches = catalog.agyModels.filter((option) => agyModelFamilyKey(option.id) === key);
  if (matches.length === 0) return requested;

  const preferredLevels = key.includes("flash")
    ? ["(medium)", "(high)", "(low)"]
    : ["(high)", "(medium)", "(low)"];
  for (const level of preferredLevels) {
    const preferred = matches.find((option) => option.id.toLowerCase().includes(level));
    if (preferred) return preferred.id;
  }
  return matches[0]?.id ?? requested;
}

/**
 * Antigravity CLI는 별도 thinking 플래그 대신 모델명의 `(Low|Medium|High)` 변형을
 * 제공한다. 저장된 추론 강도와 같은 계열 변형이 있으면 그 모델을 선택한다.
 */
export function resolveAgyCliModel(
  catalog: ModelCatalog,
  id: string | null | undefined,
  thinkingLevel: string | null | undefined
): string {
  const normalized = normalizeAgyModelForCatalog(catalog, id);
  const level = thinkingLevel?.trim().toLowerCase();
  if (!level) return normalized;
  const key = agyModelFamilyKey(normalized);
  const variants = catalog.agyModels.flatMap((option) => {
    if (agyModelFamilyKey(option.id) !== key) return [];
    const variant = option.id.toLowerCase().match(/\((low|medium|high)\)/)?.[1];
    return variant ? [{ id: option.id, level: variant }] : [];
  });
  const exact = variants.find((variant) => variant.level === level);
  return exact?.id ?? normalized;
}

export function resolveAgyModel(catalog: ModelCatalog, input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (!value) return undefined;
  return catalog.agyModels.find((option) => option.id.toLowerCase() === value)?.id;
}

export function grokModelLabel(catalog: ModelCatalog, id: string | null | undefined): string {
  if (!id) return grokModelLabel(catalog, DEFAULT_GROK_MODEL);
  return catalog.grokModels.find((option) => option.id === id)?.label ?? id;
}

export function resolveGrokModel(catalog: ModelCatalog, input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (!value) return undefined;
  return catalog.grokModels.find((option) => option.id.toLowerCase() === value)?.id;
}

export function thinkingOptionsForModel(
  catalog: ModelCatalog,
  modelId: string | null | undefined
): ThinkingOption[] {
  const model = catalog.claudeModels.find((option) => option.id === modelId)
    ?? catalog.claudeModels.find((option) => option.id === DEFAULT_CLAUDE_MODEL)
    ?? catalog.claudeModels[0];
  return model?.thinkingOptions.length ? model.thinkingOptions : thinkingOptions(["adaptive", "off"]);
}

// /thinking 명령용: 확장적 사고 on/off만. 모델이 노출하는 thinking 옵션 중 adaptive·off만 추린다.
export function thinkingToggleOptionsForModel(
  catalog: ModelCatalog,
  modelId: string | null | undefined
): ThinkingOption[] {
  const filtered = thinkingOptionsForModel(catalog, modelId).filter((option) =>
    THINKING_TOGGLE_IDS.includes(option.id)
  );
  return filtered.length ? filtered : thinkingOptions(THINKING_TOGGLE_IDS);
}

// /power 명령용: Claude 작업량(effort) 수준만. thinking 옵션 중 adaptive·off를 제외한 나머지.
export function claudeEffortOptionsForModel(
  catalog: ModelCatalog,
  modelId: string | null | undefined
): ThinkingOption[] {
  const filtered = thinkingOptionsForModel(catalog, modelId).filter((option) =>
    CLAUDE_EFFORT_IDS.includes(option.id)
  );
  return filtered.length ? filtered : thinkingOptions(CLAUDE_EFFORT_IDS);
}

export function claudeEffortLabel(level: string | null | undefined): string {
  return CLAUDE_THINKING_LABELS[level as ClaudeThinkingLevel]
    ?? CLAUDE_THINKING_LABELS[DEFAULT_CLAUDE_EFFORT];
}

export function codexReasoningOptionsForModel(
  catalog: ModelCatalog,
  modelId: string | null | undefined
): CodexReasoningOption[] {
  const model = catalog.codexModels.find((option) => option.id === modelId)
    ?? catalog.codexModels.find((option) => option.id === DEFAULT_CODEX_MODEL)
    ?? catalog.codexModels[0];
  return model?.reasoningOptions.length
    ? model.reasoningOptions
    : codexReasoningOptions(["low", "medium", "high"]);
}

export function normalizeThinkingForModel(
  catalog: ModelCatalog,
  modelId: string | null | undefined,
  level: string | null | undefined
): ClaudeThinkingLevel {
  const requested = (level ?? DEFAULT_THINKING_LEVEL) as ClaudeThinkingLevel;
  const options = thinkingOptionsForModel(catalog, modelId);
  if (options.some((option) => option.id === requested)) return requested;
  return options.find((option) => option.id === DEFAULT_THINKING_LEVEL)?.id
    ?? options[0]?.id
    ?? DEFAULT_THINKING_LEVEL;
}

// 제공사 카탈로그 조회에 필요한 입력. Claude는 SDK가 Claude Code 자식 프로세스를 띄우므로
// 실제 프로젝트 경로(cwd)와 OAuth 토큰이 필요하다.
export interface CatalogProbe {
  cwd: string;
  oauthToken?: string | undefined;
  availableProviders?: readonly ProviderKind[] | undefined;
  claudeCodeExecutable?: string | undefined;
  codexExecutable?: string | undefined;
  agyExecutable?: string | undefined;
  grokExecutable?: string | undefined;
  mcpToolTimeoutMs?: number | undefined;
}

export async function loadModelCatalog(probe: CatalogProbe): Promise<ModelCatalog> {
  const available = probe.availableProviders ?? ["claude", "codex", "agy", "grok"];
  const [claudeModels, codexModels, agyModels, grokModels, grokReasoningEfforts] = await Promise.all([
    probe.oauthToken && available.includes("claude")
      ? discoverClaudeModels(probe).catch(() => FALLBACK_CLAUDE_MODELS)
      : Promise.resolve(FALLBACK_CLAUDE_MODELS),
    available.includes("codex")
      ? discoverCodexModels(probe).catch(() => FALLBACK_CODEX_MODELS)
      : Promise.resolve(FALLBACK_CODEX_MODELS),
    available.includes("agy")
      ? discoverAgyModels(probe).catch(() => FALLBACK_AGY_MODELS)
      : Promise.resolve(FALLBACK_AGY_MODELS),
    available.includes("grok")
      ? discoverGrokModels(probe).catch(() => FALLBACK_GROK_MODELS)
      : Promise.resolve(FALLBACK_GROK_MODELS),
    available.includes("grok")
      ? discoverGrokReasoningEfforts(probe).catch(() => [])
      : Promise.resolve([])
  ]);
  return {
    claudeModels: claudeModels.length ? claudeModels : FALLBACK_CLAUDE_MODELS,
    codexModels: codexModels.length ? codexModels : FALLBACK_CODEX_MODELS,
    agyModels: agyModels.length ? agyModels : FALLBACK_AGY_MODELS,
    grokModels: grokModels.length ? grokModels : FALLBACK_GROK_MODELS,
    grokReasoningEfforts
  };
}

async function discoverGrokModels(probe: CatalogProbe): Promise<GrokModelOption[]> {
  const executable = probe.grokExecutable ?? "grok";
  const { stdout } = await execFileAsync(
    executable,
    ["models"],
    {
      timeout: GROK_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      env: buildGrokSubscriptionEnvironment()
    }
  );
  return normalizeGrokCliModels(stdout);
}

// `grok --help`는 effort 값 자체를 열거하지 않는다. 존재하지 않는 값을 넣으면 파서가
// 네트워크·에이전트 실행 전에 실제 허용 목록을 오류로 반환하므로 이를 기동 시 읽는다.
async function discoverGrokReasoningEfforts(probe: CatalogProbe): Promise<GrokReasoningEffort[]> {
  const executable = probe.grokExecutable ?? "grok";
  try {
    await execFileAsync(
      executable,
      ["--reasoning-effort", "__chatkjb_capability_probe__", "-p", "ChatKJB capability probe"],
      {
        timeout: GROK_DISCOVERY_TIMEOUT_MS,
        maxBuffer: 8 * 1024,
        env: buildGrokSubscriptionEnvironment()
      }
    );
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; };
    const efforts = normalizeGrokCliReasoningEfforts(
      [candidate.stdout, candidate.stderr, candidate.message].filter(Boolean).join("\n")
    );
    if (efforts.length) return efforts;
    throw error;
  }
  throw new Error("Grok CLI가 capability probe의 미지원 값을 거부하지 않았습니다.");
}

/** Grok CLI의 `use one of: high, medium, low` 오류에서 실제 허용값을 읽는다. */
export function normalizeGrokCliReasoningEfforts(output: string): GrokReasoningEffort[] {
  const raw = output.match(/use one of:\s*([^\r\n]+)/i)?.[1];
  if (!raw) return [];
  const efforts = new Set<GrokReasoningEffort>();
  for (const value of raw.replace(/[.。]+$/, "").split(",")) {
    const effort = value.trim();
    if (/^[a-z0-9][a-z0-9_-]*$/i.test(effort)) efforts.add(effort);
  }
  return [...efforts];
}

/** `grok models`의 기본(`*`)·일반(`-`) 목록을 모두 동적으로 반영한다. */
export function normalizeGrokCliModels(stdout: string): GrokModelOption[] {
  const ids = new Set<string>();
  const models: GrokModelOption[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^[*-]\s+(\S+)(?:\s+\(default\))?\s*$/);
    const id = match?.[1];
    if (!id || ids.has(id)) continue;
    ids.add(id);
    models.push({ id, label: id, source: "cli" });
  }
  return models;
}

async function discoverAgyModels(probe: CatalogProbe): Promise<AgyModelOption[]> {
  const executable = probe.agyExecutable ?? join(homedir(), ".local", "bin", "agy");
  const stdout = await readAgyModels(executable);
  const models: AgyModelOption[] = [];
  for (const line of stdout.split("\n")) {
    const label = line.trim();
    if (!label) continue;
    models.push({ id: label, label, source: "cli" });
  }
  return models;
}

// agy CLI는 stdin 파이프가 열린 채면 `models`에서도 입력을 기다릴 수 있다. 실제 대화
// 세션과 마찬가지로 stdin을 /dev/null로 닫아 동적 모델 탐색이 timeout 폴백으로 빠지지 않게 한다.
function readAgyModels(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["models"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => {
      terminateChildTree(child);
      finish(new Error(`Antigravity 모델 조회 시간 초과 (${AGY_DISCOVERY_TIMEOUT_MS}ms)`));
    }, AGY_DISCOVERY_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > 64 * 1024) {
        terminateChildTree(child);
        finish(new Error("Antigravity 모델 조회 출력이 64 KiB를 초과했습니다."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(
        `Antigravity 모델 조회 실패 (코드 ${code ?? "unknown"})`
        + (stderr.trim() ? `: ${stderr.trim()}` : "")
      ));
    });
  });
}

// Claude 모델은 공개 REST API가 setup-token OAuth를 받지 않으므로(401), Agent SDK의
// supportedModels()로 읽는다. 이 호출은 구독 OAuth로 동작하며 모델별 thinking/effort
// 지원 여부까지 돌려준다.
async function discoverClaudeModels(probe: CatalogProbe): Promise<ClaudeModelOption[]> {
  const abortController = new AbortController();
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: probe.oauthToken,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ...(probe.mcpToolTimeoutMs
      ? {
        MCP_TIMEOUT: String(probe.mcpToolTimeoutMs),
        MCP_TOOL_TIMEOUT: String(probe.mcpToolTimeoutMs)
      }
      : {})
  };
  const sdkQuery = query({
    prompt: "모델 카탈로그 조회용 요청입니다.",
    options: {
      cwd: probe.cwd,
      abortController,
      maxTurns: 1,
      permissionMode: "default",
      allowedTools: [],
      settingSources: [],
      env,
      ...(probe.claudeCodeExecutable
        ? { pathToClaudeCodeExecutable: probe.claudeCodeExecutable }
        : {})
    }
  });
  try {
    const models = await Promise.race([
      sdkQuery.supportedModels(),
      new Promise<ModelInfo[]>((_, reject) =>
        setTimeout(
          () => reject(new Error("supportedModels timeout")),
          CLAUDE_DISCOVERY_TIMEOUT_MS
        ).unref()
      )
    ]);
    const mapped: ClaudeModelOption[] = [];
    const seen = new Set<string>();
    for (const info of models) {
      // "default"는 추천 별칭이라 명시적 모델 선택 UI에서는 제외한다.
      if (!info?.value || info.value === "default") continue;
      const option = claudeOptionFromModelInfo(info);
      if (seen.has(option.id)) continue;
      seen.add(option.id);
      mapped.push(option);
    }
    return normalizeClaudeCliModels(mapped);
  } finally {
    abortController.abort();
    sdkQuery.close();
  }
}

export function normalizeClaudeCliModels(models: ClaudeModelOption[]): ClaudeModelOption[] {
  const seen = new Set(models.map((model) => model.id));
  const sonnetThinking = models.find((model) => model.id.includes("sonnet"))?.thinkingOptions
    ?? thinkingOptions(["adaptive", "low", "medium", "high", "xhigh", "max", "off"]);
  const normalized = models.map((model) => {
    if (model.id !== "claude-sonnet-4-6") return model;
    return {
      ...model,
      aliases: model.aliases.filter((alias) => alias !== "sonnet")
    };
  });
  if (!seen.has("claude-sonnet-5")) {
    normalized.unshift({
      id: "claude-sonnet-5",
      label: "Sonnet 5",
      aliases: ["sonnet", "sonnet-5"],
      thinkingOptions: sonnetThinking,
      source: "api"
    });
  }
  return normalized;
}

// 카탈로그 항목 하나를 표시용 옵션으로 변환한다. fallback 목록에 동일 모델이 있으면(별칭
// 매칭) 기존 id/별칭/라벨을 재사용해 저장된 세션의 모델값 해석을 유지하고, thinking 옵션은
// 항상 현재 capability에서 새로 만든다. 모르는 모델은 카탈로그 value/displayName으로 만든다.
function claudeOptionFromModelInfo(info: ModelInfo): ClaudeModelOption {
  const liveThinking = claudeThinkingOptionsFromInfo(info);
  const displayName = info.displayName || info.value;
  // `fable` 같은 SDK 이동 별칭은 그 자체가 최신 Fable을 가리킨다. 고정 fallback ID로
  // 치환하면 새 버전이 나와도 판관이 과거 모델에 묶이므로 라이브 별칭과 표시명을 보존한다.
  if (info.value.toLowerCase() === "fable") {
    return {
      id: info.value,
      label: displayName,
      aliases: aliasesForClaudeModel(info.value, displayName),
      thinkingOptions: liveThinking,
      source: "api"
    };
  }
  const known = FALLBACK_CLAUDE_MODELS.find(
    (option) => option.id === info.value || option.aliases.includes(info.value)
  );
  if (known) {
    return {
      id: known.id,
      label: known.label,
      aliases: known.aliases,
      thinkingOptions: liveThinking,
      source: "api"
    };
  }
  return {
    id: info.value,
    label: displayName,
    aliases: aliasesForClaudeModel(info.value, displayName),
    thinkingOptions: liveThinking,
    source: "api"
  };
}

function claudeThinkingOptionsFromInfo(info: ModelInfo): ThinkingOption[] {
  const levels: ClaudeThinkingLevel[] = [];
  if (info.supportsAdaptiveThinking) levels.push("adaptive");
  if (info.supportsEffort && info.supportedEffortLevels) {
    for (const level of info.supportedEffortLevels) {
      if (
        level === "low"
        || level === "medium"
        || level === "high"
        || level === "xhigh"
        || level === "max"
      ) {
        levels.push(level);
      }
    }
  }
  levels.push("off");
  return thinkingOptions(levels);
}

function aliasesForClaudeModel(id: string, displayName: string): string[] {
  const values = new Set<string>();
  for (const value of [id, displayName]) {
    const lower = value.toLowerCase();
    if (lower.includes("opus")) values.add("opus");
    if (lower.includes("sonnet")) values.add("sonnet");
    if (lower.includes("fable")) values.add("fable");
    const compact = lower
      .replace(/^claude-/, "")
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (compact) values.add(compact);
  }
  return [...values];
}

// Codex SDK가 번들한 네이티브 바이너리 경로를 찾는다. PATH의 `codex`에 의존하지 않는다.
// 플랫폼 패키지의 vendor 디렉터리에서 bin/codex(신규) 또는 codex/codex(레거시)를 탐색한다.
function resolveCodexBinaryPath(): string {
  const requireFromHere = createRequire(import.meta.url);
  const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
  const packageJsonPath = requireFromHere.resolve(`${platformPackage}/package.json`);
  const vendorRoot = join(dirname(packageJsonPath), "vendor");
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
  for (const triple of readdirSync(vendorRoot)) {
    for (const candidate of [
      join(vendorRoot, triple, "bin", binaryName),
      join(vendorRoot, triple, "codex", binaryName)
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Codex 바이너리를 ${vendorRoot}에서 찾지 못했습니다.`);
}

async function discoverCodexModels(probe: CatalogProbe): Promise<CodexModelOption[]> {
  const candidates = [
    probe.codexExecutable,
    resolveCodexBinaryPath()
  ].filter((candidate): candidate is string => Boolean(candidate));
  const tried = new Set<string>();
  let lastError: unknown;
  for (const binary of candidates) {
    if (tried.has(binary)) continue;
    tried.add(binary);
    try {
      return await discoverCodexModelsFromBinary(binary);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Codex 모델 카탈로그 조회 실패");
}

async function discoverCodexModelsFromBinary(binary: string): Promise<CodexModelOption[]> {
  const { stdout } = await execFileAsync(binary, ["debug", "models"], {
    timeout: CODEX_DISCOVERY_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024
  });
  const payload = JSON.parse(stdout) as { models?: UnknownCodexModel[]; };
  return (payload.models ?? [])
    .filter((model) => model.visibility !== "hidden" && typeof model.slug === "string")
    .map((model) => {
      const levels = (model.supported_reasoning_levels ?? [])
        .map((level) => level.effort)
        .filter(isCodexReasoningEffort);
      const defaultReasoning = isCodexReasoningEffort(model.default_reasoning_level)
        ? model.default_reasoning_level
        : DEFAULT_CODEX_REASONING;
      const reasoningOptions = codexReasoningOptions(
        levels.length ? levels : ["low", "medium", "high"]
      );
      return {
        id: model.slug,
        label: model.display_name ?? model.slug,
        reasoningOptions,
        defaultReasoning: reasoningOptions.some((option) => option.id === defaultReasoning)
          ? defaultReasoning
          : reasoningOptions[0]?.id ?? DEFAULT_CODEX_REASONING,
        source: "cli" as const
      };
    });
}

interface UnknownCodexModel {
  slug: string;
  display_name?: string;
  visibility?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort?: string; }>;
}

function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh";
}
