import type { Codex } from "@openai/codex-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAccountPool } from "../src/codex-account-pool.js";
import { FALLBACK_MODEL_CATALOG } from "../src/model-catalog.js";
import { CodexExecutor, type CodexExecutorHost } from "../src/session/executors/codex.js";
import type { ActiveRun, ExecutorOptions } from "../src/session/executors/shared.js";
import { StateStore } from "../src/store.js";
import type { MessageTransport, SessionRecord } from "../src/types.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function session(cwd: string, codexHome: string): SessionRecord {
  return {
    id: "codex-executor",
    sdkSessionId: null,
    chatId: 1,
    topicId: 2,
    projectName: "test",
    cwd,
    title: "Codex executor",
    status: "queued",
    permissionMode: "default",
    provider: "codex",
    model: null,
    thinking: null,
    claudeEffort: null,
    claudeTokenIndex: null,
    codexModel: "gpt-5.5",
    codexReasoning: "high",
    codexHome,
    codexThreadId: null,
    agyModel: null,
    agyThinkingLevel: null,
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

describe("CodexExecutor retry lifecycle", () => {
  it("continues on the same thread after a structured user choice", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-codex-choice-"));
    directories.push(directory);
    const codexHome = join(directory, "codex-home");
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const record = session(directory, codexHome);
    store.createSession(record);
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
      codexMcpTimeoutMs: 60_000,
      codexMcpHeartbeatMs: 1_000,
      longRunningMcpServers: new Set(),
      turnIdleTimeoutMs: 60_000,
      claudeMemoryDir: directory,
      modelCatalog: FALLBACK_MODEL_CATALOG
    };
    const prompts: string[] = [];
    const accountPool = new CodexAccountPool([codexHome]);
    const host: CodexExecutorHost = {
      store,
      transport,
      options,
      active: new Map(),
      deleting: new Set(),
      accountPool,
      oauthTokens: [],
      goalClientAvailable: false,
      selectHome: () => codexHome,
      recordUsage() {},
      async setNativeGoal() {},
      clearGoal() {},
      markRateLimited() {},
      async reconcileAccounts() {},
      enqueue() {},
      scheduleLimitResume() {},
      applyHandoffSummary: (request) => request,
      safeRename: async () => undefined,
      requestUserInput: vi.fn(async () => ({ "설치 범위는?": "로컬" }))
    };
    const thread = {
      id: "choice-thread-id",
      async runStreamed(prompt: string) {
        prompts.push(prompt);
        const response = prompts.length === 1
          ? `[[REQUEST_USER_INPUT]]
{"questions":[{"question":"설치 범위는?","options":[{"label":"로컬"},{"label":"전역"}]}]}
[[/REQUEST_USER_INPUT]]`
          : "로컬 설치를 완료했습니다.";
        return {
          events: (async function* () {
            yield { type: "item.completed", item: { type: "agent_message", text: response } };
            yield {
              type: "turn.completed",
              usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }
            };
          })()
        };
      }
    };
    const fakeCodex = {
      startThread: () => thread,
      resumeThread: () => thread
    } as unknown as Codex;
    const executor = new CodexExecutor(host, {
      createClient: (() => fakeCodex) as never,
      copyRollout: (() => null) as never
    });

    await executor.execute({ session: record, prompt: "설치해 줘" });

    expect(host.requestUserInput).toHaveBeenCalledOnce();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('"설치 범위는?": "로컬"');
    expect(sent.join("\n")).not.toContain("REQUEST_USER_INPUT");
    expect(sent.join("\n")).toContain("로컬 설치를 완료했습니다.");
    expect(store.getSession(record.id)?.codexThreadId).toBe("choice-thread-id");
    expect(store.getSession(record.id)?.status).toBe("done");

    await executor.execute({
      session: store.getSession(record.id)!,
      prompt: "같은 스레드의 후속 작업"
    });
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("[MEMORY_ROUTING]");
    expect(prompts[1]).not.toContain("[MEMORY_ROUTING]");
    expect(prompts[2]).not.toContain("[MEMORY_ROUTING]");
    expect(prompts[2]).toContain("같은 스레드의 후속 작업");
    store.close();
  });

  it("distinguishes a user abort from a service-shutdown abort", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-codex-executor-"));
    directories.push(directory);
    const codexHome = join(directory, "codex-home");
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const record = session(directory, codexHome);
    store.createSession(record);
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
      codexMcpTimeoutMs: 60_000,
      codexMcpHeartbeatMs: 1_000,
      codexTransientStreamRetries: 1,
      longRunningMcpServers: new Set(),
      turnIdleTimeoutMs: 60_000,
      claudeMemoryDir: directory,
      modelCatalog: FALLBACK_MODEL_CATALOG
    };
    const active = new Map<string, ActiveRun>();
    const accountPool = new CodexAccountPool([codexHome]);
    const host: CodexExecutorHost = {
      store,
      transport,
      options,
      active,
      deleting: new Set(),
      accountPool,
      oauthTokens: [],
      goalClientAvailable: false,
      selectHome: () => codexHome,
      recordUsage() {},
      async setNativeGoal() {},
      clearGoal() {},
      markRateLimited() {},
      async reconcileAccounts() {},
      enqueue() {},
      scheduleLimitResume() {},
      applyHandoffSummary: (request) => request,
      safeRename: async () => undefined,
      requestUserInput: async () => ({})
    };
    let attempts = 0;
    const thread = {
      id: "thread-id",
      async runStreamed() {
        attempts += 1;
        throw new Error("websocket closed before response.completed");
      }
    };
    const fakeCodex = {
      startThread: () => thread,
      resumeThread: () => thread
    } as unknown as Codex;
    const executor = new CodexExecutor(host, {
      createClient: (() => fakeCodex) as never,
      copyRollout: (() => null) as never
    });

    const task = executor.execute({ session: record, prompt: "hello" });
    for (let index = 0; index < 20 && attempts === 0; index += 1) {
      await Promise.resolve();
    }
    expect(attempts).toBe(1);
    const stoppedRun = active.get(record.id)!;
    stoppedRun.stopRequested = true;
    stoppedRun.controller.abort();
    await task;

    expect(attempts).toBe(1);
    expect(active.size).toBe(0);
    expect(store.getSession(record.id)?.status).toBe("aborted");

    // 같은 SIGTERM abort라도 데몬 재시작 정리에서 온 신호라면 running을 남겨
    // 다음 프로세스의 interruptIncompleteSessions()가 자동 재개할 수 있어야 한다.
    store.updateSession(record.id, { status: "queued" });
    const restartTask = executor.execute({ session: store.getSession(record.id)!, prompt: "continue" });
    for (let index = 0; index < 20 && attempts < 2; index += 1) {
      await Promise.resolve();
    }
    expect(attempts).toBe(2);
    const restartRun = active.get(record.id)!;
    restartRun.serviceShutdownRequested = true;
    restartRun.controller.abort();
    await restartTask;

    expect(active.size).toBe(0);
    expect(store.getSession(record.id)?.status).toBe("running");
    expect(store.interruptIncompleteSessions().map((session) => session.id)).toEqual([record.id]);
    expect(store.getSession(record.id)?.status).toBe("interrupted");
    store.close();
  });

  it("keeps the session's preferred Codex home after live reconcile instead of soonest-exhausted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-codex-prefer-home-"));
    directories.push(directory);
    const homeA = join(directory, "codex-a");
    const homeB = join(directory, "codex-b");
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const record = session(directory, homeB);
    store.createSession(record);
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
      codexMcpTimeoutMs: 60_000,
      codexMcpHeartbeatMs: 1_000,
      longRunningMcpServers: new Set(),
      turnIdleTimeoutMs: 60_000,
      claudeMemoryDir: directory,
      modelCatalog: FALLBACK_MODEL_CATALOG
    };
    const now = Date.now();
    const accountPool = new CodexAccountPool([homeA, homeB]);
    // 과거 봉인: 전 계정 소진이면 예전 로직은 soonest=homeA를 고른다.
    accountPool.restoreExhaustion(homeA, now + 60_000);
    accountPool.restoreExhaustion(homeB, now + 120_000);
    const selectedHomes: string[] = [];
    const createdHomes: string[] = [];
    const host: CodexExecutorHost = {
      store,
      transport,
      options,
      active: new Map(),
      deleting: new Set(),
      accountPool,
      oauthTokens: [],
      goalClientAvailable: false,
      selectHome: (sessionRecord, selectOptions) => {
        if (selectOptions?.rotateFromSession) {
          return accountPool.selectNext(sessionRecord?.codexHome ?? null);
        }
        // production selectCodexHome: honor explicit session home
        if (
          sessionRecord?.codexHome
          && accountPool.indexOf(sessionRecord.codexHome) !== -1
        ) {
          return sessionRecord.codexHome;
        }
        return accountPool.select();
      },
      recordUsage() {},
      async setNativeGoal() {},
      clearGoal() {},
      markRateLimited() {},
      async reconcileAccounts() {
        // live usage: both healthy — clear stale seals
        accountPool.setExhaustion(homeA, null);
        accountPool.setExhaustion(homeB, null);
      },
      enqueue() {},
      scheduleLimitResume() {},
      applyHandoffSummary: (request) => request,
      safeRename: async () => undefined,
      requestUserInput: async () => ({})
    };
    const thread = {
      id: "prefer-home-thread",
      async runStreamed() {
        createdHomes.push("stream");
        return {
          events: (async function* () {
            yield { type: "item.completed", item: { type: "agent_message", text: "ok" } };
            yield {
              type: "turn.completed",
              usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }
            };
          })()
        };
      }
    };
    const fakeCodex = {
      startThread: () => thread,
      resumeThread: () => thread
    } as unknown as Codex;
    const executor = new CodexExecutor(host, {
      createClient: ((_options: ExecutorOptions, codexHome: string) => {
        selectedHomes.push(codexHome);
        return fakeCodex;
      }) as never,
      copyRollout: (() => null) as never
    });

    await executor.execute({ session: record, prompt: "use preferred account" });

    expect(selectedHomes).toEqual([homeB]);
    expect(store.getSession(record.id)?.codexHome).toBe(homeB);
    expect(store.getSession(record.id)?.status).toBe("done");
    store.close();
  });
});
