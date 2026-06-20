import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { query, type ModelInfo } from "@anthropic-ai/claude-agent-sdk";

const execFileAsync = promisify(execFile);
// Claude 모델 조회는 Claude Code 자식 프로세스를 띄우므로 콜드스타트 여유를 둔다.
const CLAUDE_DISCOVERY_TIMEOUT_MS = 20_000;
const CODEX_DISCOVERY_TIMEOUT_MS = 15_000;
const AGY_DISCOVERY_TIMEOUT_MS = 15_000;

export type ClaudeThinkingLevel =
  | "adaptive"
  | "off"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

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

// agy는 추론(effort)이 모델 이름에 포함되므로 Codex 같은 별도 reasoning 축이 없다.
export interface AgyModelOption {
  id: string;
  label: string;
  source: "cli" | "fallback";
}

export interface ModelCatalog {
  claudeModels: ClaudeModelOption[];
  codexModels: CodexModelOption[];
  agyModels: AgyModelOption[];
}

export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_AGY_MODEL = "Gemini 3.1 Pro (High)";
export const DEFAULT_THINKING_LEVEL: ClaudeThinkingLevel = "adaptive";
// Claude 작업량(effort). API 기본값과 동일하게 high. null이면 SDK에 effort를 넘기지 않아 API 기본(high)이 적용된다.
export const DEFAULT_CLAUDE_EFFORT: ClaudeThinkingLevel = "high";
export const DEFAULT_CODEX_REASONING: CodexReasoningEffort = "high";

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

// `agy models` 출력(표시명)을 그대로 쓴다. agy --model 은 이 표시명 문자열을 받는다.
export const FALLBACK_AGY_MODELS: AgyModelOption[] = [
  "Gemini 3.5 Flash (Medium)",
  "Gemini 3.5 Flash (High)",
  "Gemini 3.5 Flash (Low)",
  "Gemini 3.1 Pro (Low)",
  "Gemini 3.1 Pro (High)",
  "Claude Sonnet 4.6 (Thinking)",
  "Claude Opus 4.6 (Thinking)",
  "GPT-OSS 120B (Medium)"
].map((name) => ({ id: name, label: name, source: "fallback" as const }));

export const FALLBACK_MODEL_CATALOG: ModelCatalog = {
  claudeModels: FALLBACK_CLAUDE_MODELS,
  codexModels: FALLBACK_CODEX_MODELS,
  agyModels: FALLBACK_AGY_MODELS
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

export function resolveCodexModel(catalog: ModelCatalog, input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (!value) return undefined;
  return catalog.codexModels.find((option) => option.id.toLowerCase() === value)?.id;
}

export function agyModelLabel(catalog: ModelCatalog, id: string | null | undefined): string {
  if (!id) return agyModelLabel(catalog, DEFAULT_AGY_MODEL);
  return catalog.agyModels.find((option) => option.id === id)?.label ?? id;
}

export function resolveAgyModel(catalog: ModelCatalog, input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (!value) return undefined;
  return catalog.agyModels.find((option) => option.id.toLowerCase() === value)?.id;
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
  oauthToken: string;
  claudeCodeExecutable?: string | undefined;
  agyExecutable?: string | undefined;
  mcpToolTimeoutMs?: number | undefined;
}

export async function loadModelCatalog(probe: CatalogProbe): Promise<ModelCatalog> {
  const [claudeModels, codexModels, agyModels] = await Promise.all([
    discoverClaudeModels(probe).catch(() => FALLBACK_CLAUDE_MODELS),
    discoverCodexModels().catch(() => FALLBACK_CODEX_MODELS),
    discoverAgyModels(probe).catch(() => FALLBACK_AGY_MODELS)
  ]);
  return {
    claudeModels: claudeModels.length ? claudeModels : FALLBACK_CLAUDE_MODELS,
    codexModels: codexModels.length ? codexModels : FALLBACK_CODEX_MODELS,
    agyModels: agyModels.length ? agyModels : FALLBACK_AGY_MODELS
  };
}

// agy를 비대화로 실행해 stdout을 모은다. stdin을 ignore(=/dev/null)로 줘야 한다.
// 그러지 않으면 agy가 stdin EOF를 기다리며 멈춘다(TTY 없는 파이프 환경).
function runAgyCommand(binary: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`agy ${args.join(" ")} 실패 (코드 ${code}): ${stderr.slice(0, 200)}`));
    });
  });
}

// agy 모델은 `agy models` 서브커맨드가 표시명을 한 줄씩 출력한다. 이 표시명을 그대로
// --model 값으로 쓴다(추론 수준이 이름에 포함됨).
async function discoverAgyModels(probe: CatalogProbe): Promise<AgyModelOption[]> {
  const stdout = await runAgyCommand(probe.agyExecutable ?? "agy", ["models"], AGY_DISCOVERY_TIMEOUT_MS);
  const seen = new Set<string>();
  const models: AgyModelOption[] = [];
  for (const line of stdout.split("\n")) {
    const name = line.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    models.push({ id: name, label: name, source: "cli" });
  }
  return models;
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
    return mapped;
  } finally {
    abortController.abort();
    sdkQuery.close();
  }
}

// 카탈로그 항목 하나를 표시용 옵션으로 변환한다. fallback 목록에 동일 모델이 있으면(별칭
// 매칭) 기존 id/별칭/라벨을 재사용해 저장된 세션의 모델값 해석을 유지하고, thinking 옵션은
// 항상 현재 capability에서 새로 만든다. 모르는 모델은 카탈로그 value/displayName으로 만든다.
function claudeOptionFromModelInfo(info: ModelInfo): ClaudeModelOption {
  const liveThinking = claudeThinkingOptionsFromInfo(info);
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
  const displayName = info.displayName || info.value;
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

async function discoverCodexModels(): Promise<CodexModelOption[]> {
  const binary = resolveCodexBinaryPath();
  const { stdout } = await execFileAsync(binary, ["debug", "models"], {
    timeout: CODEX_DISCOVERY_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024
  });
  const payload = JSON.parse(stdout) as { models?: UnknownCodexModel[] };
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
  supported_reasoning_levels?: Array<{ effort?: string }>;
}

function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh";
}
