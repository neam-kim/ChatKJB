import { describe, expect, it } from "vitest";
import { FALLBACK_MODEL_CATALOG, refreshAlibabaTokenPlanModels } from "../src/model-catalog.js";
import { defaultsKeyboard } from "../src/bot/keyboards.js";
import type { SessionDefaults } from "../src/types.js";
import {
  claudeSubagentModelOptions,
  codexSubagentModelOptions,
  isQwenSubagentModel,
  QWEN_SUBAGENT_SERVER_NAME,
  QWEN_SUBAGENT_TOOL_NAME,
  qwenSubagentMcpServer
} from "../src/qwen-subagent.js";

const catalog = {
  ...FALLBACK_MODEL_CATALOG,
  codexModels: [
    ...FALLBACK_MODEL_CATALOG.codexModels,
    {
      id: "qwen3.8-max",
      label: "qwen3.8-max",
      reasoningOptions: [],
      defaultReasoning: "high" as const,
      source: "token-plan" as const
    }
  ]
};

describe("Qwen Claude subagent bridge", () => {
  it("exposes only Token Plan models as Qwen options", () => {
    expect(isQwenSubagentModel(catalog, "qwen3.8-max")).toBe(true);
    expect(isQwenSubagentModel(catalog, "gpt-5.5")).toBe(false);
    expect(claudeSubagentModelOptions(catalog)).toContainEqual({
      id: "qwen3.8-max",
      label: "Qwen · qwen3.8-max",
      kind: "qwen"
    });
  });

  it("marks a Token Plan Qwen selection in the Codex panel as an MCP delegate", () => {
    expect(codexSubagentModelOptions(catalog)).toContainEqual({
      id: "qwen3.8-max",
      label: "Qwen · qwen3.8-max",
      kind: "qwen"
    });
  });

  it("registers a dedicated MCP server and tool name for Qwen delegation", () => {
    const server = qwenSubagentMcpServer("qwen3.8-max") as { command: string; args: string[]; env: Record<string, string>; };
    expect(QWEN_SUBAGENT_SERVER_NAME).toBe("chatkjb_qwen_subagent");
    expect(QWEN_SUBAGENT_TOOL_NAME).toBe("mcp__chatkjb_qwen_subagent__delegate");
    expect(server.command).toBe(process.execPath);
    expect(server.args[0]).toContain("qwen-subagent-server.js");
    expect(server.env.CHATKJB_QWEN_SUBAGENT_MODEL).toBe("qwen3.8-max");
    // cwd를 넘기지 않으면 파일 도구 루트 env를 붙이지 않는다(파일 도구는 fail-closed로 비활성).
    expect(server.env.CHATKJB_QWEN_SUBAGENT_CWD).toBeUndefined();
  });

  it("passes the session working directory so Qwen can scope its read-only file tools", () => {
    const server = qwenSubagentMcpServer("qwen3.8-max", "/Volumes/NEAM_SSD/ChatKJB") as {
      env: Record<string, string>;
    };
    expect(server.env.CHATKJB_QWEN_SUBAGENT_CWD).toBe("/Volumes/NEAM_SSD/ChatKJB");
  });

  it("keeps the Qwen MCP delegate visible in the Claude panel even with multiple tokens", () => {
    const defaults: SessionDefaults = {
      provider: "claude",
      claudeModel: "claude-opus-4-8",
      claudeTokenIndex: 0,
      codexModel: "gpt-5.5",
      codexReasoning: "high",
      codexHome: null,
      subagentModel: "qwen3.8-max",
      agyModel: "gemini-3.1-pro-preview",
      agyThinkingLevel: "",
      grokModel: "grok-4.5",
      grokReasoning: "high",
      thinking: "adaptive",
      claudeEffort: "high"
    };
    const buttons = defaultsKeyboard(defaults, catalog, [], 2).build().flat();
    const labels = buttons.map((button) => typeof button === "string" ? button : button.text);
    expect(labels).toContain("🧑‍💻 서브에이전트: Qwen · qwen3.8-max");
  });

  it("keeps the Qwen MCP delegate visible in the Codex Terminal panel", () => {
    const defaults: SessionDefaults = {
      provider: "codex",
      claudeModel: "claude-opus-4-8",
      claudeTokenIndex: 0,
      codexModel: "gpt-5.5",
      codexReasoning: "high",
      codexHome: null,
      subagentModel: "qwen3.8-max",
      agyModel: "gemini-3.1-pro-preview",
      agyThinkingLevel: "",
      grokModel: "grok-4.5",
      grokReasoning: "high",
      thinking: "adaptive",
      claudeEffort: "high"
    };
    const buttons = defaultsKeyboard(defaults, catalog, [], 1).build().flat();
    const labels = buttons.map((button) => typeof button === "string" ? button : button.text);
    expect(labels).toContain("🧑‍💻 서브에이전트: Qwen · qwen3.8-max");
  });

  it("refreshes selectable Qwen models from the Token Plan /models endpoint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [{ id: "qwen3.8-max" }, { id: "qwen3.8-coder" }]
    }), { status: 200 });
    try {
      const refreshed = await refreshAlibabaTokenPlanModels(catalog, {
        apiKey: "test-key",
        baseUrl: "https://qwen.example/v1",
        defaultModel: "qwen3.8-max"
      });
      expect(claudeSubagentModelOptions(refreshed)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "qwen3.8-max", kind: "qwen" }),
        expect.objectContaining({ id: "qwen3.8-coder", kind: "qwen" })
      ]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
