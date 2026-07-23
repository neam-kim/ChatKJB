import type { ClineResolvedConnection } from "./cline-sdk.js";
import type { AlibabaTokenPlanConfig } from "./model-catalog.js";

/**
 * Qwen은 사용자에게 독립 provider로 노출하지만, 도구·MCP·세션 수명주기는 검증된
 * Cline Core SDK를 내부 adapter로만 재사용한다. 이 경계 밖으로 secret-bearing config를
 * 전달하거나 저장하지 않는다.
 */
export function resolveQwenConnection(
  plan: AlibabaTokenPlanConfig | undefined,
  modelId: string | null | undefined
): ClineResolvedConnection {
  try {
    const model = modelId?.trim() || plan?.defaultModel?.trim();
    if (!plan?.apiKey || !model) throw new Error("missing configuration");
    const url = new URL(plan.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid endpoint");
    const providerConfig = {
      providerId: "openai-compatible",
      apiKey: plan.apiKey,
      baseUrl: url.toString().replace(/\/$/, ""),
      modelId: model,
      knownModels: {
        [model]: {
          id: model,
          name: model,
          contextWindow: 128_000,
          maxTokens: 8_192,
          capabilities: ["streaming", "tools"]
        }
      },
      capabilities: ["streaming", "tools"]
    };
    return { providerId: "openai-compatible", modelId: model, providerConfig, thinking: false };
  } catch {
    throw new Error("Qwen Token API 연결 설정을 사용할 수 없습니다.");
  }
}
