import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolApprovalRequest } from "@cline/sdk";
import { PermissionBroker } from "../src/permission-broker.js";
import { StateStore } from "../src/store.js";
import {
  ClineExecutor,
  type ClineCoreLike,
  type ClineExecutorDependencies
} from "../src/session/executors/cline.js";
import type { BaseExecutorHost, ExecutorOptions } from "../src/session/executors/shared.js";
import type { MessageTransport, SessionRecord } from "../src/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(existingClineId: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), "chatkjb-cline-executor-"));
  roots.push(root);
  const store = new StateStore(join(root, "state.sqlite"));
  store.syncProjects([{ name: "test", cwd: root, defaultMode: "auto" }]);
  const session: SessionRecord = {
    id: "chat-session",
    sdkSessionId: null,
    chatId: 1,
    topicId: 2,
    projectName: "test",
    cwd: root,
    title: "Cline test",
    status: "queued",
    permissionMode: "auto",
    provider: "cline",
    model: null,
    thinking: null,
    claudeEffort: null,
    codexModel: null,
    codexReasoning: null,
    codexThreadId: null,
    agyModel: null,
    agyThinkingLevel: null,
    agyConversationId: null,
    agyUsage: null,
    grokUsage: null,
    handoffSummary: null,
    goalCondition: null,
    leanMode: true,
    usageSnapshot: null,
    clineProviderId: "cline-pass",
    clineModel: "cline-pass/kimi-k3",
    clineReasoning: "high",
    clineSessionId: existingClineId,
    clineUsage: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  store.createSession(session);
  const transport: MessageTransport = {
    sendText: vi.fn(async () => 1),
    editText: vi.fn(async () => undefined),
    createTopic: vi.fn(async () => 2),
    renameTopic: vi.fn(async () => undefined),
    deleteTopic: vi.fn(async () => undefined),
    sendDocument: vi.fn(async () => undefined),
    sendChatAction: vi.fn(async () => undefined),
    sendFile: vi.fn(async () => undefined)
  };
  const active = new Map();
  const options: ExecutorOptions = {
    debounceMs: 1,
    availableProviders: ["cline"],
    mcpToolTimeoutMs: 1000,
    mcpMaxAttempts: 1,
    codexMcpTimeoutMs: 1000,
    codexMcpHeartbeatMs: 1000,
    longRunningMcpServers: new Set(),
    turnIdleTimeoutMs: 1000,
    claudeMemoryDir: join(root, "memory"),
    modelCatalog: {
      claudeModels: [],
      codexModels: [],
      agyModels: [],
      grokModels: [],
      clineProviders: [{ id: "cline-pass", label: "Cline Pass", models: 1, defaultModelId: "cline-pass/kimi-k3" }],
      clineModelsByProvider: {
        "cline-pass": [{ id: "cline-pass/kimi-k3", label: "Kimi K3", supportsReasoning: true }]
      }
    }
  };
  const base: BaseExecutorHost = {
    store,
    transport,
    options,
    active,
    deleting: new Set(),
    applyHandoffSummary: (request) => request,
    safeRename: async () => undefined,
    requestUserInput: async () => ({})
  };
  const permissions = new PermissionBroker(store, transport, 1000);
  return { root, store, session, transport, active, host: { ...base, permissions } };
}

function fakeCore(resultText: string) {
  const start = vi.fn(async (_input: unknown) => ({ result: { text: resultText } }));
  const send = vi.fn(async (_input: unknown) => ({ text: resultText }));
  const subscribe = vi.fn((_listener: unknown, _options: unknown) => vi.fn());
  const abort = vi.fn(async () => undefined);
  const deleteSession = vi.fn(async () => true);
  const get = vi.fn(async () => ({ sessionId: "native-session" }));
  const readMessages = vi.fn(async () => []);
  const getAccumulatedUsage = vi.fn(async () => ({ aggregateUsage: { inputTokens: 1, outputTokens: 2 } }));
  const updateSessionConnection = vi.fn(async () => undefined);
  const dispose = vi.fn(async () => undefined);
  const core = {
    start,
    send,
    abort,
    dispose,
    delete: deleteSession,
    get,
    readMessages,
    getAccumulatedUsage,
    updateSessionConnection,
    subscribe
  } as unknown as ClineCoreLike;
  return {
    core,
    start,
    send,
    subscribe,
    abort,
    delete: deleteSession,
    get,
    readMessages,
    getAccumulatedUsage,
    updateSessionConnection,
    dispose
  };
}

function dependencies(core: ClineCoreLike): ClineExecutorDependencies {
  return {
    createCore: async (_approval: (request: ToolApprovalRequest) => Promise<{ approved: boolean }>) => core,
    resolveConnection: async (providerId, modelId) => ({
      providerId,
      modelId,
      providerConfig: { providerId, modelId },
      thinking: true,
      reasoningEffort: "high"
    }),
    createSessionId: () => "native-session"
  };
}

describe("ClineExecutor", () => {
  it("starts a direct SDK session with a closed tool set and persists id/usage", async () => {
    const f = fixture();
    const fake = fakeCore("SDK_OK");
    const executor = new ClineExecutor(f.host, dependencies(fake.core));
    await executor.execute({ session: f.session, prompt: "reply SDK_OK" });

    expect(fake.start).toHaveBeenCalledTimes(1);
    const input = fake.start.mock.calls[0]?.[0] as any;
    expect(input.config.enableTools).toBe(false);
    expect(input.config.enableSpawnAgent).toBe(false);
    expect(input.localRuntime.extraTools.map((tool: { name: string }) => tool.name)).not.toContain("unknown_tool");
    expect(fake.subscribe).toHaveBeenCalledWith(expect.any(Function), { sessionId: "native-session" });
    expect(f.store.getSession(f.session.id)).toMatchObject({
      status: "done",
      clineSessionId: "native-session"
    });
    expect(f.store.getSession(f.session.id)?.clineUsage).toContain("inputTokens");
    await executor.dispose();
    f.store.close();
  });

  it("rehydrates existing messages once before sending the new prompt", async () => {
    const f = fixture("native-session");
    const fake = fakeCore("ORBIT_731");
    fake.start.mockResolvedValueOnce({ result: undefined } as never);
    const executor = new ClineExecutor(f.host, dependencies(fake.core));
    await executor.execute({ session: f.session, prompt: "remember?" });

    expect(fake.start).toHaveBeenCalledTimes(1);
    expect((fake.start.mock.calls[0]?.[0] as any).initialMessages).toEqual([]);
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.send).toHaveBeenCalledWith({ sessionId: "native-session", prompt: expect.stringContaining("remember?") });
    await executor.dispose();
    f.store.close();
  });

  it("continues same-process sessions with send only and never starts twice", async () => {
    const f = fixture("native-session");
    const fake = fakeCore("TURN_2");
    const executor = new ClineExecutor(f.host, dependencies(fake.core));
    // First turn hydrates, second turn should only send.
    await executor.execute({ session: f.session, prompt: "first" });
    await executor.execute({ session: f.store.getSession(f.session.id)!, prompt: "second" });

    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(fake.send).toHaveBeenCalledTimes(2);
    expect(fake.send.mock.calls[1]?.[0]).toMatchObject({ sessionId: "native-session" });
    await executor.dispose();
    f.store.close();
  });

  it("keeps concurrent Cline sessions isolated by native session id", async () => {
    const f1 = fixture(null);
    const f2 = fixture(null);
    f2.session.id = "chat-session-2";
    f2.session.topicId = 3;
    f2.store.createSession(f2.session);

    const sharedHost = {
      ...f1.host,
      store: {
        getSession: (id: string) => (id === f1.session.id
          ? f1.store.getSession(id)
          : f2.store.getSession(id)),
        updateSession: (id: string, fields: Record<string, unknown>) => {
          if (id === f1.session.id) f1.store.updateSession(id, fields as never);
          else f2.store.updateSession(id, fields as never);
        }
      },
      active: new Map()
    } as unknown as typeof f1.host;

    let nextId = 0;
    const ids = ["cline-a", "cline-b"];
    const start = vi.fn(async (input: { config?: { sessionId?: string }; }) => {
      const sessionId = input.config?.sessionId ?? "unknown";
      return { result: { text: sessionId === "cline-a" ? "A_ONLY" : "B_ONLY" } };
    });
    const core = {
      start,
      send: vi.fn(async () => ({ text: "unused" })),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      delete: vi.fn(async () => true),
      get: vi.fn(async (sessionId: string) => ({ sessionId })),
      readMessages: vi.fn(async () => []),
      getAccumulatedUsage: vi.fn(async (sessionId: string) => ({
        aggregateUsage: {
          inputTokens: sessionId === "cline-a" ? 11 : 22,
          outputTokens: sessionId === "cline-a" ? 1 : 2
        }
      })),
      updateSessionConnection: vi.fn(async () => undefined),
      subscribe: vi.fn((listener: (event: unknown) => void, options: { sessionId: string }) => {
        queueMicrotask(() => {
          listener({
            type: "assistant_message",
            sessionId: options.sessionId,
            message: {
              role: "assistant",
              content: [{ type: "text", text: options.sessionId === "cline-a" ? "A_ONLY" : "B_ONLY" }]
            }
          });
        });
        return vi.fn();
      })
    } as unknown as ClineCoreLike;

    const isolated = new ClineExecutor(sharedHost, {
      createCore: async () => core,
      resolveConnection: async (providerId, modelId) => ({
        providerId,
        modelId,
        providerConfig: { providerId, modelId },
        thinking: false
      }),
      createSessionId: () => ids[nextId++] ?? "cline-x"
    });

    await Promise.all([
      isolated.execute({ session: f1.session, prompt: "a" }),
      isolated.execute({ session: f2.session, prompt: "b" })
    ]);

    const s1 = f1.store.getSession(f1.session.id);
    const s2 = f2.store.getSession(f2.session.id);
    expect(s1?.clineSessionId).toBe("cline-a");
    expect(s2?.clineSessionId).toBe("cline-b");
    expect(s1?.clineUsage).toContain("11");
    expect(s2?.clineUsage).toContain("22");
    expect(s1?.clineUsage).not.toContain("22");
    expect(s2?.clineUsage).not.toContain("11");
    await isolated.dispose();
    f1.store.close();
    f2.store.close();
  });

  it("aborts with core.abort and preserves the native session id", async () => {
    const f = fixture();
    const fake = fakeCore("ignored");
    let releaseStart!: () => void;
    fake.start.mockImplementationOnce(() => new Promise((resolve) => {
      releaseStart = () => resolve({ result: { text: "should-not-finish" } });
    }));
    const executor = new ClineExecutor(f.host, dependencies(fake.core));
    const running = executor.execute({ session: f.session, prompt: "long" });
    await vi.waitFor(() => expect(fake.start).toHaveBeenCalled());
    const run = f.host.active.get(f.session.id)!;
    run.stopRequested = true;
    run.controller.abort();
    releaseStart();
    await running;

    expect(fake.abort).toHaveBeenCalledWith("native-session");
    expect(f.store.getSession(f.session.id)).toMatchObject({
      status: "aborted",
      clineSessionId: "native-session"
    });
    await executor.dispose();
    f.store.close();
  });

  it("reset deletes the native session and a later run starts a fresh id", async () => {
    const f = fixture("native-session");
    const fake = fakeCore("fresh");
    const executor = new ClineExecutor(f.host, dependencies(fake.core));
    await executor.reset(f.session);
    expect(fake.abort).toHaveBeenCalledWith("native-session");
    expect(fake.delete).toHaveBeenCalledWith("native-session");

    f.store.updateSession(f.session.id, { clineSessionId: null });
    await executor.execute({ session: f.store.getSession(f.session.id)!, prompt: "new" });
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect((fake.start.mock.calls[0]?.[0] as any).config.sessionId).toBe("native-session");
    await executor.dispose();
    f.store.close();
  });

  it("denies broker errors and unknown sessions without approving tools", async () => {
    const f = fixture();
    const fake = fakeCore("ok");
    let approval!: (request: ToolApprovalRequest) => Promise<{ approved: boolean; reason?: string }>;
    const executor = new ClineExecutor(f.host, {
      createCore: async (requestApproval) => {
        approval = requestApproval;
        return fake.core;
      },
      resolveConnection: async (providerId, modelId) => ({
        providerId,
        modelId,
        providerConfig: { providerId, modelId },
        thinking: false
      }),
      createSessionId: () => "mapped-session"
    });

    // Force lazy core creation so the approval callback is captured.
    await executor.execute({ session: f.session, prompt: "bootstrap" });
    await expect(approval({
      sessionId: "missing",
      toolCallId: "t1",
      toolName: "editor",
      input: { path: "a.ts" }
    } as ToolApprovalRequest)).resolves.toMatchObject({ approved: false });

    f.host.permissions.request = vi.fn(async () => {
      throw new Error("broker boom");
    }) as never;
    (executor as unknown as { chatSessionByClineId: Map<string, string> })
      .chatSessionByClineId.set("mapped-session", f.session.id);
    f.host.active.set(f.session.id, {
      controller: new AbortController(),
      input: { push() {}, cancel() {} } as never,
      pendingTurns: 1,
      startedAt: Date.now(),
      codexTimers: new Map(),
      codexStarts: new Map(),
      mcpFailures: new Map()
    });
    await expect(approval({
      sessionId: "mapped-session",
      toolCallId: "t2",
      toolName: "run_commands",
      input: { command: "pwd" }
    } as ToolApprovalRequest)).resolves.toMatchObject({ approved: false });

    await executor.dispose();
    f.store.close();
  });

  it("builds closed tools without MCP and refuses catalog drift", async () => {
    const f = fixture();
    const fake = fakeCore("ok");
    const executor = new ClineExecutor(f.host, dependencies(fake.core));
    await executor.execute({ session: f.session, prompt: "tools" });
    const input = fake.start.mock.calls[0]?.[0] as any;
    expect(input.config.disableMcpSettingsTools).toBe(true);
    expect(input.config.enableSpawnAgent).toBe(false);
    expect(input.config.enableAgentTeams).toBe(false);
    const names = input.localRuntime.extraTools.map((tool: { name: string }) => tool.name);
    expect(names).not.toContain("mcp");
    expect(names.every((name: string) => [
      "read_files",
      "search_codebase",
      "fetch_web_content",
      "editor",
      "apply_patch",
      "run_commands",
      "skills",
      "ask_question"
    ].includes(name))).toBe(true);
    await executor.dispose();
    f.store.close();
  });
});
