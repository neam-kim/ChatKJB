import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkState = vi.hoisted(() => ({
  listError: null as Error | null,
  modelErrors: new Set<string>()
}));

vi.mock("@cline/sdk", () => ({
  ProviderSettingsManager: class {
    getProviderConfig(providerId: string): object | undefined {
      if (providerId === "missing-config") return undefined;
      return { apiKey: "CHATKJB_SECRET_SENTINEL", provider: providerId };
    }
  },
  listLocalProviders: vi.fn(async () => {
    if (sdkState.listError) throw sdkState.listError;
    return {
      settingsPath: "/secret/providers.json",
      providers: [
        {
          id: "cline",
          name: "Cline\nProvider",
          enabled: true,
          defaultModelId: "reasoning-model",
          apiKey: "CHATKJB_SECRET_SENTINEL"
        },
        { id: "disabled", name: "Disabled", enabled: false },
        { id: "missing-config", name: "Missing", enabled: true },
        { id: "broken", name: "Broken", enabled: true }
      ]
    };
  }),
  getLocalProviderModels: vi.fn(async (providerId: string) => {
    if (sdkState.modelErrors.has(providerId)) {
      throw new Error("CHATKJB_SECRET_SENTINEL");
    }
    if (providerId === "broken") throw new Error("CHATKJB_SECRET_SENTINEL");
    return {
      providerId,
      models: [
        { id: "reasoning-model", name: "Reasoning\tModel", supportsReasoning: true },
        { id: "plain-model", name: "Plain Model", supportsReasoning: false },
        { id: "reasoning-model", name: "Duplicate", supportsReasoning: false },
        { id: "   ", name: "Empty", supportsReasoning: true }
      ]
    };
  })
}));

import {
  clineModelsForProvider,
  clineReasoningConfig,
  clineReasoningOptionsForModel,
  discoverClineCatalog,
  hasReadyClineProvider,
  normalizeClineReasoning,
  resolveClineConnection,
  seedClineConnection
} from "../src/cline-sdk.js";

describe("Cline SDK catalog adapter", () => {
  beforeEach(() => {
    sdkState.listError = null;
    sdkState.modelErrors.clear();
  });

  it("returns only sanitized configured providers and provider-scoped models", async () => {
    const catalog = await discoverClineCatalog();

    expect(catalog.providers).toEqual([{
      id: "cline",
      label: "Cline Provider",
      models: 2,
      defaultModelId: "reasoning-model"
    }]);
    expect(clineModelsForProvider(catalog, "cline")).toEqual([
      { id: "reasoning-model", label: "Reasoning Model", supportsReasoning: true },
      { id: "plain-model", label: "Plain Model", supportsReasoning: false }
    ]);
    expect(clineModelsForProvider(catalog, "disabled")).toEqual([]);
    expect(JSON.stringify(catalog)).not.toContain("CHATKJB_SECRET_SENTINEL");
    expect(JSON.stringify(catalog)).not.toContain("providers.json");
  });

  it("fails closed without exporting SDK error contents", async () => {
    sdkState.listError = new Error("CHATKJB_SECRET_SENTINEL");

    const catalog = await discoverClineCatalog();
    expect(catalog.providers).toEqual([]);
    expect(catalog.modelsByProvider).toEqual({});
    expect(JSON.stringify(catalog)).not.toContain("CHATKJB_SECRET_SENTINEL");
    expect(await hasReadyClineProvider()).toBe(false);
  });

  it("reports readiness only when an executable provider has models", async () => {
    expect(await hasReadyClineProvider()).toBe(true);
    sdkState.modelErrors.add("cline");
    expect(await hasReadyClineProvider()).toBe(false);
  });

  it("feeds the sanitized provider-scoped catalog into ModelCatalog", async () => {
    const { loadModelCatalog } = await import("../src/model-catalog.js");
    const catalog = await loadModelCatalog({ cwd: process.cwd(), availableProviders: ["cline"] });

    expect(catalog.clineProviders.map((provider) => provider.id)).toEqual(["cline"]);
    expect(catalog.clineModelsByProvider.cline).toHaveLength(2);
    expect(JSON.stringify(catalog.clineProviders)).not.toContain("CHATKJB_SECRET_SENTINEL");
  });

  it("resolves secret-bearing runtime connection only through the adapter", async () => {
    const connection = await resolveClineConnection(
      "cline",
      "reasoning-model",
      "medium"
    );

    expect(connection.providerId).toBe("cline");
    expect(connection.modelId).toBe("reasoning-model");
    expect(connection.thinking).toBe(true);
    expect(connection).toMatchObject({ reasoningEffort: "medium" });
    expect(connection.providerConfig).toMatchObject({
      providerId: "cline",
      modelId: "reasoning-model",
      apiKey: "CHATKJB_SECRET_SENTINEL"
    });
  });

  it("redacts SDK details from runtime connection errors", async () => {
    sdkState.modelErrors.add("cline");

    await expect(resolveClineConnection("cline", "reasoning-model", "high"))
      .rejects.toThrow("선택한 Cline provider/model 연결을 사용할 수 없습니다.");
    await expect(resolveClineConnection("cline", "reasoning-model", "high"))
      .rejects.not.toThrow("CHATKJB_SECRET_SENTINEL");
  });
});

describe("Cline reasoning normalization", () => {
  const catalog = {
    modelsByProvider: {
      cline: [
        { id: "reasoning", label: "Reasoning", supportsReasoning: true },
        { id: "plain", label: "Plain", supportsReasoning: false }
      ]
    }
  };

  it("defaults supported models to high and exposes every SDK effort", () => {
    expect(normalizeClineReasoning(catalog, "cline", "reasoning", undefined)).toBe("high");
    expect(clineReasoningOptionsForModel(catalog, "cline", "reasoning"))
      .toEqual(["off", "low", "medium", "high", "xhigh"]);
    expect(clineReasoningConfig(catalog, "cline", "reasoning", "xhigh"))
      .toEqual({ thinking: true, reasoningEffort: "xhigh" });
  });

  it("forces unsupported and unknown models to off", () => {
    expect(normalizeClineReasoning(catalog, "cline", "plain", "high")).toBe("off");
    expect(normalizeClineReasoning(catalog, "cline", "missing", "high")).toBe("off");
    expect(clineReasoningOptionsForModel(catalog, "cline", "plain")).toEqual(["off"]);
    expect(clineReasoningConfig(catalog, "cline", "plain", "high"))
      .toEqual({ thinking: false });
  });

  it("preserves explicit off and normalizes invalid values to high", () => {
    expect(normalizeClineReasoning(catalog, "cline", "reasoning", "off")).toBe("off");
    expect(normalizeClineReasoning(catalog, "cline", "reasoning", "invalid")).toBe("high");
  });
});

describe("Cline connection seeding", () => {
  const catalog = {
    providers: [
      { id: "first", label: "First", models: 2, defaultModelId: "first-plain" },
      { id: "second", label: "Second", models: 1, defaultModelId: "second-reasoning" }
    ],
    modelsByProvider: {
      first: [
        { id: "first-plain", label: "First plain", supportsReasoning: false },
        { id: "first-reasoning", label: "First reasoning", supportsReasoning: true }
      ],
      second: [{ id: "second-reasoning", label: "Second reasoning", supportsReasoning: true }]
    }
  };

  it("fills an empty connection with the first provider's default model", () => {
    expect(seedClineConnection(catalog, {})).toEqual({
      clineProviderId: "first",
      clineModel: "first-plain",
      clineReasoning: "off"
    });
  });

  it("preserves a valid existing provider, model, and reasoning", () => {
    expect(seedClineConnection(catalog, {
      clineProviderId: "second",
      clineModel: "second-reasoning",
      clineReasoning: "low"
    })).toEqual({
      clineProviderId: "second",
      clineModel: "second-reasoning",
      clineReasoning: "low"
    });
  });

  it("repairs a stale provider id instead of keeping its model", () => {
    expect(seedClineConnection(catalog, {
      clineProviderId: "removed",
      clineModel: "second-reasoning"
    })).toEqual({
      clineProviderId: "first",
      clineModel: "first-plain",
      clineReasoning: "off"
    });
  });

  it("leaves the caller's values untouched when the catalog is empty", () => {
    expect(seedClineConnection({ providers: [], modelsByProvider: {} }, { clineProviderId: "x" }))
      .toEqual({});
  });
});
