import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyExecutor, type AgySessionClient } from "../src/session/executors/agy.js";
import type { ActiveRun, BaseExecutorHost, ExecutorOptions } from "../src/session/executors/shared.js";
import { buildOrchestratedTurnPrompt } from "../src/session-prompts.js";
import { StateStore } from "../src/store.js";
import type { MessageTransport, SessionRecord } from "../src/types.js";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function record(cwd: string): SessionRecord {
  return {
    id: "agy-executor",
    sdkSessionId: null,
    chatId: 1,
    topicId: 2,
    projectName: "test",
    cwd,
    title: "Agy executor",
    status: "queued",
    permissionMode: "default",
    provider: "agy",
    model: null,
    thinking: null,
    claudeEffort: null,
    claudeTokenIndex: null,
    codexModel: null,
    codexReasoning: null,
    codexThreadId: null,
    agyModel: "Gemini 3.5 Flash (Medium)",
    agyThinkingLevel: "medium",
    agyConversationId: null,
    agyUsage: null,
    grokModel: null,
    grokReasoning: null,
    grokSessionId: null,
    grokUsage: null,
    handoffSummary: null,
    goalCondition: null,
    leanMode: true,
    usageSnapshot: null,
    createdAt: 0,
    updatedAt: 0
  };
}

describe("AgyExecutor lifecycle", () => {
  it("continues on the same conversation after a structured user choice", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-agy-choice-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    store.createSession(record(directory));
    const sent: string[] = [];
    const transport: MessageTransport = {
      async sendText(_chatId, _topicId, text) { sent.push(text); return sent.length; },
      async editText(_chatId, _messageId, text) { sent.push(text); },
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile() {}
    };
    const options: ExecutorOptions = {
      debounceMs: 0,
      mcpToolTimeoutMs: 1_000,
      mcpMaxAttempts: 1,
      codexMcpTimeoutMs: 1_000,
      codexMcpHeartbeatMs: 1_000,
      longRunningMcpServers: new Set(),
      turnIdleTimeoutMs: 1_000,
      claudeMemoryDir: directory,
      modelCatalog: {
        clineProviders: [],
        clineModelsByProvider: {},
        claudeModels: [], codexModels: [], grokModels: [],
        agyModels: [{ id: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash (Medium)", source: "cli" }]
      }
    };
    const prompts: string[] = [];
    const host: BaseExecutorHost = {
      store,
      transport,
      options,
      active: new Map(),
      deleting: new Set(),
      applyHandoffSummary: (request) => request,
      safeRename: async () => undefined,
      requestUserInput: vi.fn(async () => ({ "설치 범위는?": "로컬" }))
    };
    const client: AgySessionClient = {
      alive: true,
      async runTurn(prompt) {
        prompts.push(prompt);
        return {
          response: prompts.length === 1
            ? `[[REQUEST_USER_INPUT]]
{"questions":[{"question":"설치 범위는?","options":[{"label":"로컬"},{"label":"전역"}]}]}
[[/REQUEST_USER_INPUT]]`
            : "로컬 설치를 완료했습니다.",
          conversationId: "choice-conversation"
        };
      },
      async getStatus() { return { isIdle: true, turnCount: null, conversationId: null }; },
      interrupt() {},
      close() {}
    };
    const executor = new AgyExecutor(host, {
      createSession: () => client,
      syncResources: (() => ({ connectorCount: 0 })) as never
    });

    await executor.execute({ session: store.getSession("agy-executor")!, prompt: "설치해 줘" });

    expect(host.requestUserInput).toHaveBeenCalledOnce();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('"설치 범위는?": "로컬"');
    expect(sent.join("\n")).not.toContain("REQUEST_USER_INPUT");
    expect(sent.join("\n")).toContain("로컬 설치를 완료했습니다.");
    expect(store.getSession("agy-executor")?.agyConversationId).toBe("choice-conversation");
    store.close();
  });

  it("injects bootstrap once, persists the conversation, and resets owned cache state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-agy-executor-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    store.createSession(record(directory));
    const transport: MessageTransport = {
      async sendText() { return 1; },
      async editText() {},
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile() {}
    };
    const options: ExecutorOptions = {
      debounceMs: 0,
      mcpToolTimeoutMs: 1_000,
      mcpMaxAttempts: 1,
      codexMcpTimeoutMs: 1_000,
      codexMcpHeartbeatMs: 1_000,
      longRunningMcpServers: new Set(),
      turnIdleTimeoutMs: 1_000,
      claudeMemoryDir: directory,
      modelCatalog: {
        clineProviders: [],
        clineModelsByProvider: {},
        claudeModels: [],
        codexModels: [],
        agyModels: [
          { id: "Gemini 3.5 Flash (Low)", label: "Gemini 3.5 Flash (Low)", source: "cli" },
          { id: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash (Medium)", source: "cli" },
          { id: "Gemini 3.5 Flash (High)", label: "Gemini 3.5 Flash (High)", source: "cli" }
        ],
        grokModels: []
      }
    };
    const active = new Map<string, ActiveRun>();
    const host: BaseExecutorHost = {
      store,
      transport,
      options,
      active,
      deleting: new Set(),
      applyHandoffSummary: (request) => request,
      safeRename: async () => undefined,
      requestUserInput: async () => ({})
    };
    const prompts: string[] = [];
    const createSession = vi.fn((): AgySessionClient => ({
      alive: true,
      async runTurn(prompt) {
        prompts.push(prompt);
        return {
          response: `response-${prompts.length}`,
          conversationId: "11111111-2222-3333-4444-555555555555"
        };
      },
      async getStatus() {
        return { isIdle: true, turnCount: null, conversationId: null };
      },
      interrupt() {},
      close() {}
    }));
    const executor = new AgyExecutor(host, {
      createSession,
      syncResources: (() => ({ connectorCount: 0 })) as never
    });

    await executor.execute({ session: store.getSession("agy-executor")!, prompt: "first" });
    await executor.execute({ session: store.getSession("agy-executor")!, prompt: "second" });

    expect(prompts[0]).not.toBe(buildOrchestratedTurnPrompt("first"));
    expect(prompts[1]).toBe(buildOrchestratedTurnPrompt("second"));
    expect(store.getSession("agy-executor")?.agyConversationId)
      .toBe("11111111-2222-3333-4444-555555555555");
    expect(active.size).toBe(0);

    executor.dispose();
    const restartedExecutor = new AgyExecutor(host, {
      createSession,
      syncResources: (() => ({ connectorCount: 0 })) as never
    });
    await restartedExecutor.execute({
      session: store.getSession("agy-executor")!,
      prompt: "third"
    });
    expect(prompts[2]).toBe(buildOrchestratedTurnPrompt("third"));

    store.updateSession("agy-executor", { agyConversationId: null });
    restartedExecutor.resetContext("agy-executor");
    await restartedExecutor.execute({
      session: store.getSession("agy-executor")!,
      prompt: "fourth"
    });
    expect(prompts[3]).not.toBe(buildOrchestratedTurnPrompt("fourth"));
    expect(store.getSession("agy-executor")?.status).toBe("done");
    store.close();
  });
});
