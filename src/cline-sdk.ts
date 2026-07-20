import {
  ProviderSettingsManager,
  getLocalProviderModels,
  listLocalProviders,
  type CoreModelConfig
} from "@cline/sdk";

export type ClineReasoningEffort = "off" | "low" | "medium" | "high" | "xhigh";
export type ClineSdkReasoningEffort = Exclude<ClineReasoningEffort, "off">;

export interface ClineModelOption {
  id: string;
  label: string;
  supportsReasoning: boolean;
}

export interface ClineProviderOption {
  id: string;
  label: string;
  models: number;
  defaultModelId?: string | undefined;
}

export interface ClineCatalog {
  providers: ClineProviderOption[];
  modelsByProvider: Record<string, ClineModelOption[]>;
}

type ClineCatalogSource =
  | Pick<ClineCatalog, "modelsByProvider">
  | { clineModelsByProvider: Record<string, ClineModelOption[]>; };

/** 제공자 목록까지 필요한 호출부용. ClineCatalog와 ModelCatalog 두 표기를 모두 받는다. */
type ClineProviderSource =
  | Pick<ClineCatalog, "providers">
  | { clineProviders: readonly ClineProviderOption[]; };

function providerList(source: ClineProviderSource): readonly ClineProviderOption[] {
  return "providers" in source ? source.providers : source.clineProviders;
}

export interface ClineCatalogDiscoveryOptions {
  /** 테스트 또는 별도 Cline profile을 위한 SDK data directory override. */
  dataDir?: string | undefined;
}

export type ClineReasoningConfig =
  | { thinking: false; }
  | { thinking: true; reasoningEffort: ClineSdkReasoningEffort; };

/**
 * 실행기 내부 전용. `providerConfig`에 인증정보가 포함될 수 있으므로 직렬화, 로깅,
 * 저장, Telegram/Terminal 전달을 금지한다.
 */
export type ClineResolvedConnection = Required<
  Pick<CoreModelConfig, "providerId" | "modelId" | "providerConfig">
> & ClineReasoningConfig;

export const DEFAULT_CLINE_REASONING: ClineReasoningEffort = "high";
export const EMPTY_CLINE_CATALOG: ClineCatalog = Object.freeze({
  providers: Object.freeze([]) as unknown as ClineProviderOption[],
  modelsByProvider: Object.freeze({}) as Record<string, ClineModelOption[]>
});

const CLINE_REASONING_EFFORTS: readonly ClineSdkReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh"
];

function cleanLabel(value: string, fallback: string): string {
  const label = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (label || fallback).slice(0, 160);
}

/**
 * Cline의 secret-bearing provider 설정은 이 함수 안에서만 사용한다. 반환값은 UI와
 * 세션 기본값에 필요한 provider/model 식별자와 capability만 포함한다. SDK 오류도
 * 외부로 전달하지 않아 설정값이 포함된 오류 문자열이 로그나 Telegram으로 새지 않는다.
 */
export async function discoverClineCatalog(
  options: ClineCatalogDiscoveryOptions = {}
): Promise<ClineCatalog> {
  const manager = new ProviderSettingsManager(
    options.dataDir ? { dataDir: options.dataDir } : undefined
  );
  let listed: Awaited<ReturnType<typeof listLocalProviders>>;
  try {
    listed = await listLocalProviders(manager, { isClinePassEnabled: true });
  } catch {
    return emptyClineCatalog();
  }

  const providers: ClineProviderOption[] = [];
  const modelsByProvider: Record<string, ClineModelOption[]> = Object.create(null) as Record<
    string,
    ClineModelOption[]
  >;

  for (const listedProvider of listed.providers) {
    if (!listedProvider.enabled) continue;
    try {
      const config = manager.getProviderConfig(listedProvider.id);
      if (!config) continue;
      const response = await getLocalProviderModels(listedProvider.id, config);
      const models = sanitizeModels(response.models);
      if (models.length === 0) continue;
      modelsByProvider[listedProvider.id] = models;
      providers.push({
        id: listedProvider.id,
        label: cleanLabel(listedProvider.name, listedProvider.id),
        models: models.length,
        ...(listedProvider.defaultModelId
          && models.some((model) => model.id === listedProvider.defaultModelId)
          ? { defaultModelId: listedProvider.defaultModelId }
          : {})
      });
    } catch {
      // 한 provider의 손상된 인증 또는 catalog가 다른 provider의 탐색을 막지 않게 한다.
    }
  }

  return { providers, modelsByProvider };
}

export async function hasReadyClineProvider(
  options: ClineCatalogDiscoveryOptions = {}
): Promise<boolean> {
  return (await discoverClineCatalog(options)).providers.length > 0;
}

/**
 * 선택된 provider/model을 SDK 실행 설정으로 해석한다. 반환값은 실행 직전에만 소비하고
 * 수명이 끝나면 버려야 한다. 실패 오류는 원래 SDK 오류나 설정값을 포함하지 않는다.
 */
export async function resolveClineConnection(
  providerId: string,
  modelId: string,
  reasoning: string | null | undefined,
  options: ClineCatalogDiscoveryOptions = {}
): Promise<ClineResolvedConnection> {
  try {
    const normalizedProviderId = providerId.trim();
    const normalizedModelId = modelId.trim();
    if (!normalizedProviderId || !normalizedModelId) throw new Error("invalid selection");
    const manager = new ProviderSettingsManager(
      options.dataDir ? { dataDir: options.dataDir } : undefined
    );
    const providerConfig = manager.getProviderConfig(normalizedProviderId, {
      includeKnownModels: true
    });
    if (!providerConfig) throw new Error("provider unavailable");
    const response = await getLocalProviderModels(normalizedProviderId, providerConfig);
    const model = sanitizeModels(response.models)
      .find((candidate) => candidate.id === normalizedModelId);
    if (!model) throw new Error("model unavailable");
    const reasoningConfig = normalizeClineReasoningForModel(reasoning, model);
    return {
      providerId: normalizedProviderId,
      modelId: normalizedModelId,
      providerConfig: {
        ...providerConfig,
        providerId: normalizedProviderId,
        modelId: normalizedModelId
      },
      ...(reasoningConfig === "off"
        ? { thinking: false }
        : { thinking: true, reasoningEffort: reasoningConfig })
    };
  } catch {
    throw new Error("선택한 Cline provider/model 연결을 사용할 수 없습니다.");
  }
}

export function clineModelsForProvider(
  catalog: ClineCatalogSource,
  providerId: string | null | undefined
): ClineModelOption[] {
  if (!providerId) return [];
  return modelMap(catalog)[providerId] ?? [];
}

export interface ClineConnectionSeed {
  clineProviderId: string;
  clineModel: string;
  clineReasoning: ClineReasoningEffort;
}

/**
 * 유효한 내부 연결이 이미 있으면 보존하고, 없을 때만 카탈로그 기본값으로 채운다.
 * 카탈로그가 비어 있으면 빈 객체를 돌려 호출자가 기존 값을 건드리지 않게 한다.
 */
export function seedClineConnection(
  catalog: ClineCatalogSource & ClineProviderSource,
  current: {
    clineProviderId?: string | null;
    clineModel?: string | null;
    clineReasoning?: string | null;
  }
): Partial<ClineConnectionSeed> {
  const providers = providerList(catalog);
  const kept = providers.find((item) => item.id === current.clineProviderId?.trim());
  const provider = kept ?? providers[0];
  if (!provider) return {};
  const models = clineModelsForProvider(catalog, provider.id);
  const model = (kept && models.find((item) => item.id === current.clineModel?.trim()))
    ?? models.find((item) => item.id === provider.defaultModelId)
    ?? models[0];
  if (!model) return {};
  return {
    clineProviderId: provider.id,
    clineModel: model.id,
    clineReasoning: normalizeClineReasoning(current.clineReasoning, model)
  };
}

export function clineReasoningOptionsForModel(
  model: Pick<ClineModelOption, "supportsReasoning"> | null | undefined
): ClineReasoningEffort[];
export function clineReasoningOptionsForModel(
  catalog: ClineCatalogSource,
  providerId: string | null | undefined,
  modelId: string | null | undefined
): ClineReasoningEffort[];
export function clineReasoningOptionsForModel(
  catalogOrModel: ClineCatalogSource | Pick<ClineModelOption, "supportsReasoning"> | null | undefined,
  providerId?: string | null,
  modelId?: string | null
): ClineReasoningEffort[] {
  const model = arguments.length === 1
    ? catalogOrModel as Pick<ClineModelOption, "supportsReasoning"> | null | undefined
    : findClineModel(catalogOrModel as ClineCatalogSource, providerId, modelId);
  return model?.supportsReasoning
    ? ["off", ...CLINE_REASONING_EFFORTS]
    : ["off"];
}

/** 지원 모델은 high를 기본값으로, 미지원 모델은 항상 off로 정규화한다. */
export function normalizeClineReasoning(
  value: string | null | undefined,
  model: Pick<ClineModelOption, "supportsReasoning"> | null | undefined
): ClineReasoningEffort;
export function normalizeClineReasoning(
  catalog: ClineCatalogSource,
  providerId: string | null | undefined,
  modelId: string | null | undefined,
  value: string | null | undefined
): ClineReasoningEffort;
export function normalizeClineReasoning(
  catalogOrValue: ClineCatalogSource | string | null | undefined,
  providerOrModel: string | Pick<ClineModelOption, "supportsReasoning"> | null | undefined,
  modelId?: string | null,
  value?: string | null
): ClineReasoningEffort {
  if (arguments.length === 2) {
    return normalizeClineReasoningForModel(
      catalogOrValue as string | null | undefined,
      providerOrModel as Pick<ClineModelOption, "supportsReasoning"> | null | undefined
    );
  }
  const model = findClineModel(
    catalogOrValue as ClineCatalogSource,
    providerOrModel as string | null | undefined,
    modelId
  );
  return normalizeClineReasoningForModel(value, model);
}

function normalizeClineReasoningForModel(
  value: string | null | undefined,
  model: Pick<ClineModelOption, "supportsReasoning"> | null | undefined
): ClineReasoningEffort {
  if (!model?.supportsReasoning) return "off";
  if (value === "off" || CLINE_REASONING_EFFORTS.includes(value as ClineSdkReasoningEffort)) {
    return value as ClineReasoningEffort;
  }
  return DEFAULT_CLINE_REASONING;
}

export function clineReasoningConfig(
  catalog: ClineCatalogSource,
  providerId: string | null | undefined,
  modelId: string | null | undefined,
  value: string | null | undefined
): ClineReasoningConfig {
  const normalized = normalizeClineReasoning(catalog, providerId, modelId, value);
  return normalized === "off"
    ? { thinking: false }
    : { thinking: true, reasoningEffort: normalized };
}

function modelMap(catalog: ClineCatalogSource): Record<string, ClineModelOption[]> {
  return "modelsByProvider" in catalog
    ? catalog.modelsByProvider
    : catalog.clineModelsByProvider;
}

function findClineModel(
  catalog: ClineCatalogSource,
  providerId: string | null | undefined,
  modelId: string | null | undefined
): ClineModelOption | undefined {
  if (!modelId) return undefined;
  return clineModelsForProvider(catalog, providerId).find((model) => model.id === modelId);
}

function sanitizeModels(
  rawModels: Awaited<ReturnType<typeof getLocalProviderModels>>["models"]
): ClineModelOption[] {
  const seen = new Set<string>();
  const models: ClineModelOption[] = [];
  for (const rawModel of rawModels) {
    const id = rawModel.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: cleanLabel(rawModel.name, id),
      supportsReasoning: rawModel.supportsReasoning === true
    });
  }
  return models;
}

function emptyClineCatalog(): ClineCatalog {
  return { providers: [], modelsByProvider: Object.create(null) as Record<string, ClineModelOption[]> };
}
