import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_REASONING,
  FALLBACK_MODEL_CATALOG,
  agyThinkingOptionsForModel,
  codexReasoningLabel,
  codexReasoningOptionsForModel,
  grokReasoningOptions,
  normalizeGrokCliReasoningEfforts,
  normalizeGrokReasoningEffort,
  latestClaudeFableModel,
  loadModelCatalog,
  normalizeAgyModelForCatalog,
  resolveAgyCliModel,
  normalizeClaudeCliModels,
  normalizeGrokCliModels,
  resolveModel
} from "../src/model-catalog.js";

describe("codex reasoning catalog", () => {
  it("defaults to high effort", () => {
    expect(DEFAULT_CODEX_REASONING).toBe("high");
  });

  it("exposes the model's reasoning options", () => {
    const options = codexReasoningOptionsForModel(FALLBACK_MODEL_CATALOG, "gpt-5.5");
    expect(options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh"
    ]);
    for (const option of options) {
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  it("falls back to the default model's options for unknown models", () => {
    const options = codexReasoningOptionsForModel(FALLBACK_MODEL_CATALOG, "nonexistent");
    expect(options.length).toBeGreaterThan(0);
  });

  it("labels known efforts and falls back to High", () => {
    expect(codexReasoningLabel("low")).not.toBe(codexReasoningLabel("high"));
    expect(codexReasoningLabel(null)).toBe(codexReasoningLabel("high"));
    expect(codexReasoningLabel("bogus")).toBe(codexReasoningLabel("high"));
  });
});

describe("Claude CLI catalog normalization", () => {
  it("adds Sonnet 5 and maps the sonnet alias to the latest Sonnet", () => {
    const catalog = {
      ...FALLBACK_MODEL_CATALOG,
      claudeModels: normalizeClaudeCliModels(FALLBACK_MODEL_CATALOG.claudeModels)
    };

    expect(catalog.claudeModels[0]?.id).toBe("claude-sonnet-5");
    expect(resolveModel(catalog, "sonnet")).toBe("claude-sonnet-5");
    expect(resolveModel(catalog, "sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("selects the newest Fable model from the dynamic Claude catalog", () => {
    const fable5 = FALLBACK_MODEL_CATALOG.claudeModels.find((model) => model.id === "claude-fable-5")!;
    const catalog = {
      ...FALLBACK_MODEL_CATALOG,
      claudeModels: [
        { ...fable5, id: "claude-fable-5-1", label: "Fable 5.1", source: "api" as const },
        { ...fable5, id: "claude-fable-6", label: "Fable 6", source: "api" as const },
        { ...fable5, id: "claude-fable-5-2", label: "Fable 5.2", source: "api" as const }
      ]
    };

    expect(latestClaudeFableModel(catalog)?.id).toBe("claude-fable-6");
  });

  it("returns undefined when the dynamic Claude catalog has no Fable model", () => {
    const catalog = {
      ...FALLBACK_MODEL_CATALOG,
      claudeModels: FALLBACK_MODEL_CATALOG.claudeModels.filter((model) =>
        !model.id.includes("fable"))
    };

    expect(latestClaudeFableModel(catalog)).toBeUndefined();
  });

  it("does not mistake a static fallback Fable for a dynamically detected model", () => {
    expect(latestClaudeFableModel(FALLBACK_MODEL_CATALOG)).toBeUndefined();
  });
});

describe("Grok CLI catalog normalization", () => {
  it("기본 모델과 일반 모델을 모두 동적으로 노출한다", () => {
    const models = normalizeGrokCliModels(
      "Default model: grok-4.5\n\nAvailable models:\n  * grok-4.5 (default)\n  - grok-composer-2.5-fast\n"
    );

    expect(models).toEqual([
      { id: "grok-4.5", label: "grok-4.5", source: "cli" },
      { id: "grok-composer-2.5-fast", label: "grok-composer-2.5-fast", source: "cli" }
    ]);
  });

  it("CLI 오류에서 추론 강도를 동적으로 읽어 노출한다", () => {
    const efforts = normalizeGrokCliReasoningEfforts(
      "--effort: unknown effort level 'xhigh'; use one of: high, medium, low"
    );
    expect(grokReasoningOptions({ grokReasoningEfforts: efforts }).map((option) => option.id))
      .toEqual(["high", "medium", "low"]);
  });

  it("저장된 값도 동적으로 감지한 허용 목록 안에서만 전달한다", () => {
    expect(normalizeGrokReasoningEffort("xhigh", ["low", "xhigh"])).toBe("xhigh");
    expect(normalizeGrokReasoningEffort("xhigh", ["low", "medium", "high"])).toBe("high");
    expect(normalizeGrokReasoningEffort("xhigh", ["medium", "low"])).toBe("medium");
    expect(normalizeGrokReasoningEffort("high", [])).toBeUndefined();
  });
});

describe("Antigravity CLI model compatibility", () => {
  const catalog = {
    ...FALLBACK_MODEL_CATALOG,
    agyModels: [
      { id: "Gemini 3.5 Flash (Low)", label: "Gemini 3.5 Flash (Low)", source: "cli" as const },
      { id: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash (Medium)", source: "cli" as const },
      { id: "Gemini 3.1 Pro (Low)", label: "Gemini 3.1 Pro (Low)", source: "cli" as const },
      { id: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)", source: "cli" as const }
    ]
  };

  it("maps legacy Flash slugs to the current medium model label", () => {
    expect(normalizeAgyModelForCatalog(catalog, "gemini-3.5-flash"))
      .toBe("Gemini 3.5 Flash (Medium)");
  });

  it("maps legacy Pro preview slugs to the current high model label", () => {
    expect(normalizeAgyModelForCatalog(catalog, "gemini-3.1-pro-preview"))
      .toBe("Gemini 3.1 Pro (High)");
  });

  it("preserves exact current CLI model labels", () => {
    expect(normalizeAgyModelForCatalog(catalog, "Gemini 3.5 Flash (Low)"))
      .toBe("Gemini 3.5 Flash (Low)");
  });

  it("maps the stored thinking level to a matching CLI model variant", () => {
    expect(resolveAgyCliModel(catalog, "Gemini 3.1 Pro (High)", "low"))
      .toBe("Gemini 3.1 Pro (Low)");
    expect(resolveAgyCliModel(catalog, "gemini-3.5-flash", "low"))
      .toBe("Gemini 3.5 Flash (Low)");
    expect(resolveAgyCliModel(catalog, "gemini-3.5-flash", "minimal"))
      .toBe("Gemini 3.5 Flash (Medium)");
    expect(resolveAgyCliModel(catalog, "Gemini 3.1 Pro (Low)", "medium"))
      .toBe("Gemini 3.1 Pro (Low)");
    expect(agyThinkingOptionsForModel(catalog, "Gemini 3.1 Pro (High)")
      .map((option) => option.id)).toEqual(["low", "high"]);
  });

  it("closes stdin while discovering dynamic CLI models", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-agy-models-"));
    const executable = join(directory, "agy");
    writeFileSync(executable, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.once('end', () => console.log('Gemini 3.5 Flash (Medium)'));"
    ].join("\n"));
    chmodSync(executable, 0o755);
    try {
      const loaded = await loadModelCatalog({
        cwd: directory,
        availableProviders: ["agy"],
        agyExecutable: executable
      });
      expect(loaded.agyModels).toEqual([{
        id: "Gemini 3.5 Flash (Medium)",
        label: "Gemini 3.5 Flash (Medium)",
        source: "cli"
      }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
