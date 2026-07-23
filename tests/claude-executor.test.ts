import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_MODEL_CATALOG, type ModelCatalog } from "../src/model-catalog.js";
import { QWEN_SUBAGENT_SERVER_NAME, QWEN_SUBAGENT_TOOL_NAME } from "../src/qwen-subagent.js";
import { PermissionBroker } from "../src/permission-broker.js";
import {
  ClaudeExecutor,
  type ClaudeExecutorDependencies,
  type ClaudeExecutorHost
} from "../src/session/executors/claude.js";
import type { ActiveRun, ExecutorOptions } from "../src/session/executors/shared.js";
import { StateStore } from "../src/store.js";
import { TokenPool } from "../src/token-pool.js";
import type { MessageTransport, SessionRecord } from "../src/types.js";

const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function session(cwd: string): SessionRecord {
  return {
    id: "claude-executor",
    sdkSessionId: null,
    chatId: 1,
    topicId: 2,
    projectName: "test",
    cwd,
    title: "Claude executor",
    status: "queued",
    permissionMode: "default",
    provider: "claude",
    model: null,
    thinking: null,
    claudeEffort: null,
    claudeTokenIndex: null,
    codexModel: null,
    codexReasoning: null,
    codexHome: null,
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

function setup(
  selectToken?: ClaudeExecutorHost["selectToken"],
  createQuery?: ClaudeExecutorDependencies["createQuery"],
  modelCatalog: ModelCatalog = FALLBACK_MODEL_CATALOG,
  subagentModel?: string
): {
  active: Map<string, ActiveRun>;
  executor: ClaudeExecutor;
  enqueued: unknown[];
  renames: string[];
  store: StateStore;
} {
  const directory = mkdtempSync(join(tmpdir(), "chatkjb-claude-executor-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.sqlite"));
  store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
  const record = { ...session(directory), subagentModel: subagentModel ?? null };
  store.createSession(record);
  const renames: string[] = [];
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
  const permissions = new PermissionBroker(store, transport, 1_000);
  const options: ExecutorOptions = {
    debounceMs: 0,
    mcpToolTimeoutMs: 1_000,
    mcpMaxAttempts: 1,
    codexMcpTimeoutMs: 1_000,
    codexMcpHeartbeatMs: 1_000,
    longRunningMcpServers: new Set(),
    turnIdleTimeoutMs: 60_000,
    claudeMemoryDir: directory,
    modelCatalog
  };
  const active = new Map<string, ActiveRun>();
  const tokenPool = new TokenPool(["test-token"]);
  const enqueued: unknown[] = [];
  const host: ClaudeExecutorHost = {
    store,
    transport,
    permissions,
    options,
    active,
    deleting: new Set(),
    tokenPool,
    oauthTokens: ["test-token"],
    selectToken: selectToken ?? (() => "test-token"),
    markRateLimited() {},
    enqueue(request) { enqueued.push(request); },
    scheduleLimitResume() {},
    handleGoalCompletion() {},
    applyHandoffSummary: (request) => request,
    safeRename: async (_session, title) => { renames.push(title); },
    requestUserInput: async () => ({})
  };
  const failingQuery = {
    close() {},
    async *[Symbol.asyncIterator]() {
      throw new Error("Overloaded service");
    }
  } as unknown as Query;
  const executor = new ClaudeExecutor(host, {
    createQuery: createQuery ?? ((() => failingQuery) as never),
    renameSdkSession: (async () => undefined) as never
  });
  return { active, executor, enqueued, renames, store };
}

describe("ClaudeExecutor lifecycle", () => {
  it("registers Qwen as an MCP delegate rather than an unsupported native Task model", async () => {
    let captured: Parameters<ClaudeExecutorDependencies["createQuery"]>[0] | undefined;
    const emptyQuery = { close() {}, async *[Symbol.asyncIterator]() {} } as unknown as Query;
    const qwenCatalog: ModelCatalog = {
      ...FALLBACK_MODEL_CATALOG,
      codexModels: [...FALLBACK_MODEL_CATALOG.codexModels, {
        id: "qwen3.8-max",
        label: "qwen3.8-max",
        reasoningOptions: [],
        defaultReasoning: "high",
        source: "token-plan"
      }]
    };
    const createQuery = ((params) => {
      captured = params;
      return emptyQuery;
    }) as ClaudeExecutorDependencies["createQuery"];
    const { executor, store } = setup(undefined, createQuery, qwenCatalog, "qwen3.8-max");

    await executor.execute({ session: store.getSession("claude-executor")!, prompt: "delegate" });

    expect(captured?.options?.agents).toBeUndefined();
    expect(captured?.options?.allowedTools).toContain(QWEN_SUBAGENT_TOOL_NAME);
    expect(captured?.options?.allowedTools).not.toContain("Task");
    expect(captured?.options?.mcpServers?.[QWEN_SUBAGENT_SERVER_NAME]).toBeDefined();
  });

  it("pins native Task delegation to the selected Claude model and effort", async () => {
    let captured: Parameters<ClaudeExecutorDependencies["createQuery"]>[0] | undefined;
    const emptyQuery = { close() {}, async *[Symbol.asyncIterator]() {} } as unknown as Query;
    const createQuery = ((params) => {
      captured = params;
      return emptyQuery;
    }) as ClaudeExecutorDependencies["createQuery"];
    const { executor, store } = setup(undefined, createQuery, FALLBACK_MODEL_CATALOG, "claude-sonnet-4-5");
    store.updateSession("claude-executor", { subagentEffort: "high" });

    await executor.execute({ session: store.getSession("claude-executor")!, prompt: "delegate" });

    expect(captured?.options?.agents?.chatkjb_subagent).toMatchObject({
      model: "claude-sonnet-4-5",
      effort: "high"
    });
  });

  it("does not register an active run when token selection fails", async () => {
    const { active, executor, store } = setup(() => {
      throw new Error("no usable token");
    });
    const record = store.getSession("claude-executor")!;

    await expect(executor.execute({ session: record, prompt: "hello" }))
      .rejects.toThrow("no usable token");
    expect(active.size).toBe(0);
  });

  it("cancels scheduled overload retries on dispose", async () => {
    vi.useFakeTimers();
    const { active, executor, enqueued, store } = setup();
    const record = store.getSession("claude-executor")!;

    await executor.execute({ session: record, prompt: "hello" });
    expect(active.size).toBe(0);
    expect(store.getSession(record.id)?.status).toBe("queued");

    executor.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(enqueued).toHaveLength(0);
  });

  it("allows a pending overload retry to be canceled by session id", async () => {
    vi.useFakeTimers();
    const { executor, enqueued, store } = setup();
    const record = store.getSession("claude-executor")!;

    await executor.execute({ session: record, prompt: "hello" });
    expect(executor.cancelRetry(record.id)).toBe(true);
    expect(executor.cancelRetry(record.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(enqueued).toHaveLength(0);
  });

  it("defers Claude completion while background agents are still running", async () => {
    let captured: Parameters<ClaudeExecutorDependencies["createQuery"]>[0] | undefined;
    const emptyQuery = {
      close() {},
      async *[Symbol.asyncIterator]() {}
    } as unknown as Query;
    const createQuery = ((params) => {
      captured = params;
      return emptyQuery;
    }) as ClaudeExecutorDependencies["createQuery"];
    const { executor, store } = setup(undefined, createQuery);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await executor.execute({ session: store.getSession("claude-executor")!, prompt: "audit" });

    const stopHook = captured?.options?.hooks?.Stop?.[0]?.hooks[0];
    expect(stopHook).toBeTypeOf("function");
    const output = await stopHook!(
      {
        hook_event_name: "Stop",
        stop_hook_active: false,
        session_id: "sdk-session",
        transcript_path: "/tmp/session.jsonl",
        cwd: store.getSession("claude-executor")!.cwd,
        background_tasks: [{
          id: "agent-1",
          type: "subagent",
          status: "running",
          description: "Security audit"
        }]
      } as never,
      undefined,
      { signal: new AbortController().signal }
    );

    expect(output).toMatchObject({
      decision: "block",
      continue: true,
      hookSpecificOutput: { hookEventName: "Stop" }
    });
    expect(JSON.stringify(output)).toContain("agent-1");
  });

  it("still blocks stop when stop_hook_active and background agents remain", async () => {
    let captured: Parameters<ClaudeExecutorDependencies["createQuery"]>[0] | undefined;
    const emptyQuery = {
      close() {},
      async *[Symbol.asyncIterator]() {}
    } as unknown as Query;
    const createQuery = ((params) => {
      captured = params;
      return emptyQuery;
    }) as ClaudeExecutorDependencies["createQuery"];
    const { executor, store } = setup(undefined, createQuery);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await executor.execute({ session: store.getSession("claude-executor")!, prompt: "audit" });

    const stopHook = captured?.options?.hooks?.Stop?.[0]?.hooks[0];
    const output = await stopHook!(
      {
        hook_event_name: "Stop",
        stop_hook_active: true,
        session_id: "sdk-session",
        transcript_path: "/tmp/session.jsonl",
        cwd: store.getSession("claude-executor")!.cwd,
        background_tasks: [{
          id: "agent-2",
          type: "subagent",
          status: "running",
          description: "Still working"
        }]
      } as never,
      undefined,
      { signal: new AbortController().signal }
    );

    expect(output).toMatchObject({ decision: "block" });
    expect(JSON.stringify(output)).toContain("agent-2");
  });

  it("allows stop when background tasks are already finished", async () => {
    let captured: Parameters<ClaudeExecutorDependencies["createQuery"]>[0] | undefined;
    const emptyQuery = {
      close() {},
      async *[Symbol.asyncIterator]() {}
    } as unknown as Query;
    const createQuery = ((params) => {
      captured = params;
      return emptyQuery;
    }) as ClaudeExecutorDependencies["createQuery"];
    const { executor, store } = setup(undefined, createQuery);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await executor.execute({ session: store.getSession("claude-executor")!, prompt: "audit" });

    const stopHook = captured?.options?.hooks?.Stop?.[0]?.hooks[0];
    const output = await stopHook!(
      {
        hook_event_name: "Stop",
        stop_hook_active: false,
        session_id: "sdk-session",
        transcript_path: "/tmp/session.jsonl",
        cwd: store.getSession("claude-executor")!.cwd,
        background_tasks: [{
          id: "agent-3",
          type: "subagent",
          status: "completed",
          description: "Done"
        }]
      } as never,
      undefined,
      { signal: new AbortController().signal }
    );

    expect(output).toEqual({});
  });

  it("does not mark the session done while open subagent tasks remain after a result", async () => {
    const messages: unknown[] = [
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-open-1",
        description: "Explore module",
        uuid: "u1",
        session_id: "sdk-1"
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 10,
        duration_api_ms: 10,
        is_error: false,
        num_turns: 1,
        result: "partial",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "u2",
        session_id: "sdk-1"
      }
    ];
    const query = {
      close() {},
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message as never;
      },
      async getServerInfo() { return null; }
    } as unknown as Query;
    const { executor, renames, store } = setup(
      undefined,
      (() => query) as ClaudeExecutorDependencies["createQuery"]
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await executor.execute({ session: store.getSession("claude-executor")!, prompt: "spawn subagent" });

    // open task 때문에 중간 result를 최종 완료로 취급하지 않아 [DONE] 이 되면 안 된다.
    expect(renames).not.toContain("[DONE] Claude executor");
    expect(store.getSession("claude-executor")?.status).not.toBe("done");
  });

  it("marks done after open subagent tasks complete and a final result arrives", async () => {
    const messages: unknown[] = [
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-open-2",
        description: "Review",
        uuid: "u1",
        session_id: "sdk-2"
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 10,
        duration_api_ms: 10,
        is_error: false,
        num_turns: 1,
        result: "waiting",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "u2",
        session_id: "sdk-2"
      },
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task-open-2",
        status: "completed",
        output_file: "/tmp/out",
        summary: "review done",
        uuid: "u3",
        session_id: "sdk-2"
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 20,
        duration_api_ms: 20,
        is_error: false,
        num_turns: 2,
        result: "all integrated",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 2,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "u4",
        session_id: "sdk-2"
      }
    ];
    const query = {
      close() {},
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message as never;
      },
      async getServerInfo() { return null; }
    } as unknown as Query;
    const { executor, renames, store } = setup(
      undefined,
      (() => query) as ClaudeExecutorDependencies["createQuery"]
    );

    await executor.execute({ session: store.getSession("claude-executor")!, prompt: "spawn then integrate" });

    expect(store.getSession("claude-executor")?.status).toBe("done");
    expect(renames).toContain("[DONE] Claude executor");
  });

  it("marks done when subagent tasks finish but the SDK ends without a final result", async () => {
    // 회귀 방지: 하위 작업 완료 후 SDK가 통합 result를 자동 재개하지 않고 스트림을
    // 닫으면, 예전에는 result 보류로 세션이 영구 running에 갇혀 [DONE]이 발송되지
    // 않았다. 이제는 조기 종료(에러)가 아니라 정상 완료로 종결해야 한다.
    const messages: unknown[] = [
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-open-3",
        description: "Long review",
        uuid: "u1",
        session_id: "sdk-3"
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 10,
        duration_api_ms: 10,
        is_error: false,
        num_turns: 1,
        result: "waiting on subagent",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "u2",
        session_id: "sdk-3"
      },
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task-open-3",
        status: "completed",
        output_file: "/tmp/out",
        summary: "subagent finished",
        uuid: "u3",
        session_id: "sdk-3"
      }
      // 통합 result 없이 스트림 종료(SDK가 후속 turn을 재개하지 않는 경우).
    ];
    const query = {
      close() {},
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message as never;
      },
      async getServerInfo() { return null; }
    } as unknown as Query;
    const { executor, renames, store } = setup(
      undefined,
      (() => query) as ClaudeExecutorDependencies["createQuery"]
    );

    await executor.execute({ session: store.getSession("claude-executor")!, prompt: "spawn subagent" });

    expect(store.getSession("claude-executor")?.status).toBe("done");
    expect(renames).toContain("[DONE] Claude executor");
  });

  it("forks a resumed Claude session once when the SDK stream is completely empty", async () => {
    const emptyQuery = {
      close() {},
      async *[Symbol.asyncIterator]() {}
    } as unknown as Query;
    const { executor, enqueued, renames, store } = setup(
      undefined,
      (() => emptyQuery) as ClaudeExecutorDependencies["createQuery"]
    );
    store.updateSession("claude-executor", { sdkSessionId: "stalled-session" });
    const record = store.getSession("claude-executor")!;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await executor.execute({
      session: record,
      prompt: "finish the pending work",
      resumeSessionId: "stalled-session"
    });

    expect(store.getSession(record.id)?.status).toBe("queued");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      resumeSessionId: "stalled-session",
      forkSession: true,
      claudeEmptyStreamRecoveryCount: 1
    });
    expect((enqueued[0] as { prompt: string }).prompt).toContain("finish the pending work");
    expect(renames).toContain("[RECOVER] Claude executor");
    expect(renames).not.toContain("[DONE] Claude executor");
  });

  it("reports an error instead of looping when the empty-stream recovery also fails", async () => {
    const emptyQuery = {
      close() {},
      async *[Symbol.asyncIterator]() {}
    } as unknown as Query;
    const { executor, enqueued, renames, store } = setup(
      undefined,
      (() => emptyQuery) as ClaudeExecutorDependencies["createQuery"]
    );
    store.updateSession("claude-executor", { sdkSessionId: "stalled-session" });
    const record = store.getSession("claude-executor")!;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await executor.execute({
      session: record,
      prompt: "finish the pending work",
      resumeSessionId: "stalled-session",
      forkSession: true,
      claudeEmptyStreamRecoveryCount: 1
    });

    expect(store.getSession(record.id)?.status).toBe("error");
    expect(enqueued).toHaveLength(0);
    expect(renames).toContain("[ERROR] Claude executor");
    expect(renames).not.toContain("[DONE] Claude executor");
  });
});
