import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_REASONING,
  FALLBACK_MODEL_CATALOG,
  codexReasoningLabel,
  codexReasoningOptionsForModel
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
