import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MODEL_DISCOVERY_TIMEOUT_MS = 3_000;

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

export interface ModelCatalog {
  claudeModels: ClaudeModelOption[];
  codexModels: CodexModelOption[];
}

export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_THINKING_LEVEL: ClaudeThinkingLevel = "adaptive";
export const DEFAULT_CODEX_REASONING: CodexReasoningEffort = "high";

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

export const FALLBACK_MODEL_CATALOG: ModelCatalog = {
  claudeModels: FALLBACK_CLAUDE_MODELS,
  codexModels: FALLBACK_CODEX_MODELS
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

export function thinkingOptionsForModel(
  catalog: ModelCatalog,
  modelId: string | null | undefined
): ThinkingOption[] {
  const model = catalog.claudeModels.find((option) => option.id === modelId)
    ?? catalog.claudeModels.find((option) => option.id === DEFAULT_CLAUDE_MODEL)
    ?? catalog.claudeModels[0];
  return model?.thinkingOptions.length ? model.thinkingOptions : thinkingOptions(["adaptive", "off"]);
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

export async function loadModelCatalog(oauthToken: string): Promise<ModelCatalog> {
  const [claudeModels, codexModels] = await Promise.all([
    discoverClaudeModels(oauthToken).catch(() => FALLBACK_CLAUDE_MODELS),
    discoverCodexModels().catch(() => FALLBACK_CODEX_MODELS)
  ]);
  return {
    claudeModels: claudeModels.length ? claudeModels : FALLBACK_CLAUDE_MODELS,
    codexModels: codexModels.length ? codexModels : FALLBACK_CODEX_MODELS
  };
}

async function discoverClaudeModels(oauthToken: string): Promise<ClaudeModelOption[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "anthropic-version": "2023-06-01",
        authorization: `Bearer ${oauthToken}`
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Claude model discovery failed: ${response.status}`);
    const payload = await response.json() as { data?: UnknownClaudeModel[] };
    return (payload.data ?? [])
      .filter((model) => typeof model.id === "string" && typeof model.display_name === "string")
      .map((model) => ({
        id: model.id,
        label: model.display_name,
        aliases: aliasesForClaudeModel(model.id, model.display_name),
        thinkingOptions: claudeThinkingOptions(model.capabilities),
        source: "api" as const
      }));
  } finally {
    clearTimeout(timeout);
  }
}

interface UnknownClaudeModel {
  id: string;
  display_name: string;
  capabilities?: {
    thinking?: {
      supported?: boolean;
      types?: {
        adaptive?: { supported?: boolean };
        enabled?: { supported?: boolean };
      };
    };
    effort?: {
      supported?: boolean;
      low?: { supported?: boolean };
      medium?: { supported?: boolean };
      high?: { supported?: boolean };
      xhigh?: { supported?: boolean };
      max?: { supported?: boolean };
    };
  } | null;
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

function claudeThinkingOptions(capabilities: UnknownClaudeModel["capabilities"]): ThinkingOption[] {
  if (!capabilities?.thinking?.supported) return thinkingOptions(["off"]);
  const levels: ClaudeThinkingLevel[] = [];
  if (capabilities.thinking.types?.adaptive?.supported) levels.push("adaptive");
  if (capabilities.effort?.supported) {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      if (capabilities.effort[level]?.supported) levels.push(level);
    }
  }
  if (capabilities.thinking.types?.enabled?.supported && levels.length === 0) {
    levels.push("high");
  }
  levels.push("off");
  return thinkingOptions(levels.length ? levels : ["adaptive", "off"]);
}

async function discoverCodexModels(): Promise<CodexModelOption[]> {
  const { stdout } = await execFileAsync("codex", ["debug", "models"], {
    timeout: MODEL_DISCOVERY_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024
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
