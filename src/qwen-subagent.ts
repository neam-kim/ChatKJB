import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ModelCatalog } from "./model-catalog.js";

export const QWEN_SUBAGENT_SERVER_NAME = "chatkjb_qwen_subagent";
export const QWEN_SUBAGENT_TOOL_NAME = `mcp__${QWEN_SUBAGENT_SERVER_NAME}__delegate`;

export interface ClaudeSubagentModelOption {
  id: string;
  label: string;
  kind: "claude" | "qwen";
}

export interface CodexSubagentModelOption {
  id: string;
  label: string;
  kind: "codex" | "qwen";
}

export interface GrokSubagentModelOption {
  id: string;
  label: string;
  kind: "grok" | "qwen";
}

/** Alibaba Token Plan에서 발견한 모델만 Claude의 Qwen 위임 대상으로 노출한다. */
export function isQwenSubagentModel(catalog: ModelCatalog, model: string | null | undefined): boolean {
  return Boolean(model) && catalog.codexModels.some((option) =>
    option.id === model && option.source === "token-plan"
  );
}

export function claudeSubagentModelOptions(catalog: ModelCatalog): ClaudeSubagentModelOption[] {
  return [
    ...catalog.claudeModels.map((option) => ({
      id: option.id,
      label: option.label,
      kind: "claude" as const
    })),
    ...catalog.codexModels
      .filter((option) => option.source === "token-plan")
      .map((option) => ({
        id: option.id,
        label: `Qwen · ${option.label}`,
        kind: "qwen" as const
      }))
  ];
}

/**
 * Codex의 API Qwen은 native child model로 넘기면 OpenAI provider로 해석된다.
 * 따라서 UI에서는 명시적으로 Qwen MCP 위임 대상임을 보여 주고 실행기는 별도 도구로 등록한다.
 */
export function codexSubagentModelOptions(catalog: ModelCatalog): CodexSubagentModelOption[] {
  return catalog.codexModels.map((option) => ({
    id: option.id,
    label: option.source === "token-plan" ? `Qwen · ${option.label}` : option.label,
    kind: option.source === "token-plan" ? "qwen" : "codex"
  }));
}

/** Grok native 모델과 전용 MCP Qwen을 함께 노출한다. */
export function grokSubagentModelOptions(catalog: ModelCatalog): GrokSubagentModelOption[] {
  return [
    ...catalog.grokModels.map((option) => ({
      id: option.id,
      label: option.label,
      kind: "grok" as const
    })),
    ...catalog.codexModels
      .filter((option) => option.source === "token-plan")
      .map((option) => ({
        id: option.id,
        label: `Qwen · ${option.label}`,
        kind: "qwen" as const
      }))
  ];
}

/** Claude Agent SDK의 네이티브 Task는 Claude 모델만 지원하므로 Qwen은 별도 MCP 도구로 실행한다. */
export function qwenSubagentMcpServer(model: string, cwd?: string): McpServerConfig {
  return qwenSubagentProcessConfig(model, cwd) as McpServerConfig;
}

/**
 * Codex config에는 SDK 객체가 아닌 TOML로 직렬화 가능한 값만 넘긴다.
 * cwd를 함께 넘기면 Qwen 서버가 그 디렉터리 안에서만 read-only 파일 도구를 쓸 수 있다.
 */
export function qwenSubagentProcessConfig(model: string, cwd?: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const script = new URL("./qwen-subagent-server.js", import.meta.url);
  return {
    command: process.execPath,
    args: [script.pathname],
    env: {
      DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY ?? "",
      DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL ?? "",
      CHATKJB_QWEN_SUBAGENT_MODEL: model,
      ...(cwd ? { CHATKJB_QWEN_SUBAGENT_CWD: cwd } : {})
    }
  };
}
