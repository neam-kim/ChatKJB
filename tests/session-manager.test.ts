import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeAgyResponse } from "../src/agy-interactive.js";
import { FALLBACK_MODEL_CATALOG, resolveModel } from "../src/model-catalog.js";
import { PermissionBroker } from "../src/permission-broker.js";
import {
  agyFailureFromLog,
  agyRequestsProceed,
  buildClaudeEnvironment,
  buildCodexEnvironment,
  buildCodexSteeredPrompt,
  buildCompactCommand,
  buildGoalCommand,
  buildLeanInstructions,
  buildLimitResumePrompt,
  buildMemoryPrompt,
  buildOrchestratedTurnPrompt,
  buildOrchestrationBoundaryInstructions,
  buildPermissionModeInstructions,
  buildPublicProgressInstructions,
  buildRolloverSummaryPrompt,
  buildUserMessage,
  CLAUDE_MODEL,
  CLAUDE_THINKING,
  CODEX_MODEL,
  CODEX_REASONING_EFFORT,
  codexExhaustedUntilFromLiveUsage,
  GrokProgressCollector,
  isNoRolloutError,
  isOverloadedError,
  isRateLimitError,
  isTransientStreamError,
  loadProjectInstructions,
  MessageQueue,
  parseGrokTranscript,
  ProgressiveParagraphCollector,
  requireCodexSubscriptionAuth,
  resolveClaudeEffort,
  resolveThinkingConfig,
  resultFailureText,
  resultSummary,
  SessionManager,
  snapshotFromRateLimitError,
  StreamingTextCollector
} from "../src/session-manager.js";
import {
  buildProviderBootstrap,
  loadSupplementalProjectInstructions
} from "../src/session-prompts.js";
import { StateStore } from "../src/store.js";
import type { MessageTransport, ProviderKind, SessionRecord } from "../src/types.js";

const fakeTransport: MessageTransport = {
  async sendText() { return 1; },
  async editText() {},
  async createTopic() { return 1; },
  async renameTopic() {},
  async deleteTopic() {},
  async sendDocument() {},
  async sendChatAction() {},
  async sendFile() {}
};

function baseSession(id: string, cwd: string): SessionRecord {
  const now = Date.now();
  return {
    id,
    sdkSessionId: null,
    chatId: -1001,
    topicId: 42,
    projectName: "test",
    cwd,
    title: id,
    status: "done",
    permissionMode: "default",
    provider: "claude",
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
    createdAt: now,
    updatedAt: now
  };
}

function sessionManagerOptions(directory: string, codexAccountHomes?: string[]) {
  return {
    debounceMs: 1,
    claudeCodeOauthToken: "test-token",
    ...(codexAccountHomes ? { codexAccountHomes } : {}),
    mcpToolTimeoutMs: 1000,
    mcpMaxAttempts: 1,
    codexMcpTimeoutMs: 1000,
    codexMcpHeartbeatMs: 1000,
    longRunningMcpServers: new Set(["codex"]),
    turnIdleTimeoutMs: 600_000,
    claudeMemoryDir: join(directory, ".claude", "memory"),
    modelCatalog: FALLBACK_MODEL_CATALOG
  };
}

describe("read-only one-off task", () => {
  it("uses plan permission with the requested provider and captured defaults", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-read-only-task-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    const permissions = new PermissionBroker(store, fakeTransport, 1_000);
    const manager = new SessionManager(
      store,
      fakeTransport,
      permissions,
      sessionManagerOptions(directory)
    );
    const runSilentReadOnly = vi.spyOn(
      manager as unknown as {
        runSilentReadOnly: (
          session: SessionRecord,
          provider: ProviderKind,
          prompt: string,
          options: { timeoutMs?: number; }
        ) => Promise<string>;
      },
      "runSilentReadOnly"
    ).mockResolvedValue('{"projectId":"project-1"}');
    try {
      const defaults = store.getSessionDefaults();
      const result = await manager.runReadOnlyTask({
        provider: "claude",
        defaults,
        cwd: directory,
        prompt: "select project",
        timeoutMs: 5_000
      });

      expect(result).toContain("project-1");
      expect(runSilentReadOnly).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: directory,
          permissionMode: "plan",
          provider: "claude",
          model: defaults.claudeModel
        }),
        "claude",
        "select project",
        { timeoutMs: 5_000, toolFree: true }
      );
    } finally {
      await manager.dispose();
      permissions.dispose();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses Antigravity itself for selection when Antigravity is the task provider", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-read-only-task-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    const permissions = new PermissionBroker(store, fakeTransport, 1_000);
    const manager = new SessionManager(
      store,
      fakeTransport,
      permissions,
      { ...sessionManagerOptions(directory), availableProviders: ["agy", "claude"] }
    );
    const runSilentReadOnly = vi.spyOn(
      manager as unknown as {
        runSilentReadOnly: (
          session: SessionRecord,
          provider: ProviderKind,
          prompt: string,
          options: { timeoutMs?: number; toolFree?: boolean; }
        ) => Promise<string>;
      },
      "runSilentReadOnly"
    ).mockResolvedValue('{"projectId":"project-1"}');
    try {
      await manager.runReadOnlyTask({
        provider: "agy",
        defaults: store.getSessionDefaults(),
        cwd: directory,
        prompt: "select project",
        timeoutMs: 5_000
      });
      expect(runSilentReadOnly).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "agy", permissionMode: "plan" }),
        "agy",
        "select project",
        { timeoutMs: 5_000, toolFree: true }
      );
    } finally {
      await manager.dispose();
      permissions.dispose();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not accept a new classifier task after disposal begins", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-read-only-task-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    const permissions = new PermissionBroker(store, fakeTransport, 1_000);
    const manager = new SessionManager(
      store,
      fakeTransport,
      permissions,
      sessionManagerOptions(directory)
    );
    try {
      await manager.dispose();
      await expect(manager.runReadOnlyTask({
        provider: "claude",
        defaults: store.getSessionDefaults(),
        cwd: directory,
        prompt: "select project",
        timeoutMs: 5_000
      })).rejects.toThrow("종료되어 프로젝트를 선택할 수 없습니다");
      expect(() => manager.createSession(
        { name: "test", cwd: directory, defaultMode: "default" },
        -1001,
        42,
        "late session",
        "must not start"
      )).toThrow("종료되어 새 세션을 만들 수 없습니다");
      expect(store.listSessions(10)).toHaveLength(0);
    } finally {
      await manager.dispose();
      permissions.dispose();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("initial session prompt factory", () => {
  it("resolves the UUID-aware prompt before persistence and enqueue", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-session-prompt-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    const permissions = new PermissionBroker(store, fakeTransport, 1_000);
    const manager = new SessionManager(
      store,
      fakeTransport,
      permissions,
      sessionManagerOptions(directory)
    );
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const enqueue = vi.spyOn(
      manager as unknown as {
        enqueue: (request: { session: SessionRecord; prompt: string; }) => void;
      },
      "enqueue"
    ).mockImplementation(() => undefined);
    try {
      const created = manager.createSession(
        { name: "test", cwd: directory, defaultMode: "default" },
        -1001,
        42,
        "workflow",
        (session) => {
          expect(store.getSession(session.id)).toBeUndefined();
          expect(enqueue).not.toHaveBeenCalled();
          return `State root: .chatkjb/workflows/${session.id}/ralplan`;
        }
      );

      expect(store.getSession(created.id)).toMatchObject({ id: created.id });
      expect(enqueue).toHaveBeenCalledOnce();
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        session: expect.objectContaining({ id: created.id }),
        prompt: `State root: .chatkjb/workflows/${created.id}/ralplan`
      }));
    } finally {
      await manager.dispose();
      permissions.dispose();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves no database record or enqueue work when the factory throws", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-session-prompt-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    const permissions = new PermissionBroker(store, fakeTransport, 1_000);
    const manager = new SessionManager(
      store,
      fakeTransport,
      permissions,
      sessionManagerOptions(directory)
    );
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const enqueue = vi.spyOn(
      manager as unknown as { enqueue: (request: unknown) => void; },
      "enqueue"
    ).mockImplementation(() => undefined);
    try {
      expect(() => manager.createSession(
        { name: "test", cwd: directory, defaultMode: "default" },
        -1001,
        42,
        "workflow",
        () => {
          throw new Error("prompt factory failed");
        }
      )).toThrow("prompt factory failed");

      expect(store.listSessions(10)).toHaveLength(0);
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await manager.dispose();
      permissions.dispose();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Claude child environment", () => {
  it("resolves Claude thinking and effort settings to SDK options", () => {
    expect(resolveThinkingConfig("off")).toEqual({ type: "disabled" });
    expect(resolveThinkingConfig("high")).toEqual({ type: "adaptive" });
    expect(resolveThinkingConfig(undefined)).toEqual({ type: "adaptive" });

    expect(resolveClaudeEffort("low")).toBe("low");
    expect(resolveClaudeEffort("max")).toBe("max");
    expect(resolveClaudeEffort("off")).toBeUndefined();
    expect(resolveClaudeEffort(null)).toBeUndefined();
  });

  it("forces setup-token OAuth and removes API credentials", () => {
    const environment = buildClaudeEnvironment("sk-ant-oat01-oauth", {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "api-key",
      ANTHROPIC_AUTH_TOKEN: "auth-token",
      CLAUDE_CODE_OAUTH_TOKEN: "old-token"
    });

    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-oauth",
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined
    });
  });
});

describe("usage lookup fallback", () => {
  it("turns a Claude session-limit reset error into a 100% five-hour snapshot", () => {
    const snapshot = snapshotFromRateLimitError(
      new Error("You've hit your session limit · resets 2pm (Asia/Seoul)"),
      Date.parse("2026-06-16T02:20:00.000Z")
    );

    expect(snapshot?.fiveHour).toEqual({
      utilization: 100,
      resetsAt: "2026-06-16T05:00:00.000Z"
    });
  });

  it("honors an explicit reset timezone instead of assuming Korea time", () => {
    const snapshot = snapshotFromRateLimitError(
      new Error("You've hit your session limit · resets 2pm (America/Los_Angeles)"),
      Date.parse("2026-06-16T02:20:00.000Z")
    );

    expect(snapshot?.fiveHour).toEqual({
      utilization: 100,
      resetsAt: "2026-06-16T21:00:00.000Z"
    });
  });
});

describe("Codex subscription authentication", () => {
  it("removes API billing credentials from the Codex child environment", () => {
    const nodeBin = dirname(process.execPath);
    expect(buildCodexEnvironment(undefined, {
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      OPENAI_API_KEY: "openai-key",
      CODEX_API_KEY: "codex-key",
      OPENAI_BASE_URL: "https://example.test",
      CODEX_HOME: "/tmp/codex"
    })).toEqual({
      PATH: `${nodeBin}:/usr/bin`,
      HOME: "/tmp/home",
      CODEX_HOME: "/tmp/codex"
    });
  });

  it("overrides CODEX_HOME with the selected account home", () => {
    const nodeBin = dirname(process.execPath);
    expect(buildCodexEnvironment("/tmp/codex-acct-b", {
      PATH: "/usr/bin",
      CODEX_HOME: "/tmp/codex"
    })).toEqual({
      PATH: `${nodeBin}:/usr/bin`,
      CODEX_HOME: "/tmp/codex-acct-b"
    });
  });

  it("adds the current Node bin to Codex PATH for env-node CLI wrappers", () => {
    const nodeBin = dirname(process.execPath);
    expect(buildCodexEnvironment(undefined, {
      CODEX_HOME: "/tmp/codex"
    })).toMatchObject({
      PATH: `${nodeBin}:/usr/bin:/bin`,
      CODEX_HOME: "/tmp/codex"
    });
  });

  it("accepts ChatGPT login and rejects API-key auth mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-codex-auth-"));
    try {
      writeFileSync(join(directory, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
      expect(() => requireCodexSubscriptionAuth(directory)).not.toThrow();

      writeFileSync(join(directory, "auth.json"), JSON.stringify({ auth_mode: "apikey" }));
      expect(() => requireCodexSubscriptionAuth(directory))
        .toThrow("API 키 인증은 허용하지 않습니다");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Claude model policy", () => {
  it("forces Opus 4.8 with adaptive thinking", () => {
    expect(CLAUDE_MODEL).toBe("claude-opus-4-8");
    expect(CLAUDE_THINKING).toEqual({ type: "adaptive" });
  });

  it("resolves supported model aliases and rejects unknown models", () => {
    expect(resolveModel(FALLBACK_MODEL_CATALOG, "sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveModel(FALLBACK_MODEL_CATALOG, "fable")).toBe("claude-fable-5");
    expect(resolveModel(FALLBACK_MODEL_CATALOG, "opus")).toBe("claude-opus-4-8");
    expect(resolveModel(FALLBACK_MODEL_CATALOG, " CLAUDE-SONNET-4-6 ")).toBe("claude-sonnet-4-6");
    expect(resolveModel(FALLBACK_MODEL_CATALOG, "없는모델")).toBeUndefined();
  });
});

describe("Codex model policy", () => {
  it("forces GPT-5.5 with high reasoning", () => {
    expect(CODEX_MODEL).toBe("gpt-5.5");
    expect(CODEX_REASONING_EFFORT).toBe("high");
  });
});

describe("failure classification", () => {
  it("treats session/usage limits as rate-limit errors (token failover)", () => {
    expect(isRateLimitError(new Error("You've hit your session limit · resets 2pm"))).toBe(true);
    expect(isRateLimitError(new Error("Codex 스트림 오류: You've hit your usage limit. Try again at 4:17 AM."))).toBe(true);
    expect(isRateLimitError(new Error("HTTP 429 rate_limit_error"))).toBe(true);
    expect(isRateLimitError(new Error("quota exceeded"))).toBe(true);
  });

  it("treats Overloaded and 5xx as transient errors (backoff retry, not failover)", () => {
    expect(isOverloadedError(new Error("Claude Code returned an error result: API Error: Overloaded"))).toBe(true);
    expect(isOverloadedError(new Error("API Error: 529 overloaded_error"))).toBe(true);
    expect(isOverloadedError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isOverloadedError(new Error("502 Bad Gateway"))).toBe(true);
  });

  it("keeps the two classes disjoint for the dispatch branches", () => {
    const overloaded = new Error("API Error: Overloaded");
    expect(isOverloadedError(overloaded)).toBe(true);
    expect(isRateLimitError(overloaded)).toBe(false);
    const limit = new Error("You've hit your session limit · resets 2pm");
    expect(isRateLimitError(limit)).toBe(true);
    expect(isOverloadedError(limit)).toBe(false);
  });

  it("treats server-closed Codex streams as retryable without classifying limits", () => {
    const streamClosed = new Error(
      "Codex 스트림 오류: Reconnecting... 2/5 (stream disconnected before completion: websocket closed by server before response.completed)"
    );
    expect(isTransientStreamError(streamClosed)).toBe(true);
    expect(isRateLimitError(streamClosed)).toBe(false);
    expect(isTransientStreamError(new Error("You've hit your usage limit"))).toBe(false);
  });

  it("treats a success result containing a session-limit message as failure", () => {
    const result = {
      type: "result",
      subtype: "success",
      result: "You've hit your session limit · resets 4:40pm (Asia/Seoul)",
      session_id: "session"
    } as Parameters<typeof resultFailureText>[0];

    expect(resultFailureText(result)).toContain("session limit");
  });

  it("treats a rejected rate-limit event as failure even with an empty success result", () => {
    const result = {
      type: "result",
      subtype: "success",
      result: "",
      session_id: "session"
    } as Parameters<typeof resultFailureText>[0];

    expect(resultFailureText(result, true)).toBe("Claude rate limit rejected");
  });

  it("turns a 529 success-shaped diagnostic result into an overloaded failure", () => {
    const result = {
      type: "result",
      subtype: "success",
      api_error_status: 529,
      result:
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
      session_id: "session"
    } as Parameters<typeof resultFailureText>[0];

    const failure = resultFailureText(result);
    expect(failure).toBe("Claude API Error: 529 Overloaded");
    expect(isOverloadedError(failure)).toBe(true);
  });

  it("turns a 429 success-shaped diagnostic result into a rate-limit failure", () => {
    const result = {
      type: "result",
      subtype: "success",
      api_error_status: 429,
      result: "",
      session_id: "session"
    } as Parameters<typeof resultFailureText>[0];

    const failure = resultFailureText(result);
    expect(failure).toBe("Claude API Error: 429 rate limit");
    expect(isRateLimitError(failure)).toBe(true);
  });
});

describe("agy bridge behavior", () => {
  it("removes an exact duplicated Antigravity final response", () => {
    expect(normalizeAgyResponse("GREEN-964GREEN-964")).toBe("GREEN-964");
    expect(normalizeAgyResponse("서로 다른 응답")).toBe("서로 다른 응답");
  });

  it("recognizes a model-authored Proceed request that needs a Telegram button", () => {
    expect(agyRequestsProceed("**Proceed(진행)** 버튼을 눌러 승인해 주시면 반영하겠습니다.")).toBe(true);
    expect(agyRequestsProceed("작업을 모두 완료했습니다.")).toBe(false);
  });

  it("turns a hidden agy quota failure into an actionable error", () => {
    const message = agyFailureFromLog(
      "model unreachable: RESOURCE_EXHAUSTED: Individual quota reached. Resets in 155h9m55s."
    );
    expect(message).toContain("개인 할당량");
    expect(message).toContain("155h9m55s");
  });

  it("does not relay agy partial output and sends only the final response on completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-agy-final-only-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    const sent: string[] = [];
    const transport: MessageTransport = {
      async sendText(_chatId, _topicId, text) {
        sent.push(text);
        return sent.length;
      },
      async editText() {},
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile() {}
    };

    try {
      store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
      const session = {
        ...baseSession("agy-final-only", directory),
        provider: "agy" as const,
        status: "running" as const
      };
      store.createSession(session);
      const manager = new SessionManager(
        store,
        transport,
        new PermissionBroker(store, transport, 1000),
        sessionManagerOptions(directory)
      );
      const renderer = {
        partial: (text: string) => sent.push(`partial:${text}`),
        text: async (text: string) => { sent.push(`text:${text}`); },
        finish: async (_status: "done" | "aborted" | "error", summary: string) => {
          sent.push("[DONE] 작업 종료 · 0:01");
          if (summary.trim()) sent.push(summary);
        }
      };
      const ctx = {
        session,
        request: { operation: "goal_native" },
        renderer,
        controller: new AbortController(),
        turnTimeout: undefined,
        timedOut: false,
        agyConversationId: null,
        lastResponse: ""
      };
      const client = {
        async runTurn(_prompt: string, _signal: AbortSignal) {
          return { response: "최종 결론", conversationId: "conv-1" };
        }
      };

      const response = await (manager as any).agyExecutor.runTurn(ctx, client, "요청");
      ctx.lastResponse = response;
      await (manager as any).agyExecutor.finalizeRun(ctx);

      expect(response).toBe("최종 결론");
      expect(sent).toContain("최종 결론");
      expect(sent.some((text) => text.includes("중간 내용"))).toBe(false);
      expect(sent.some((text) => text.startsWith("partial:"))).toBe(false);
      expect(sent.some((text) => text.startsWith("text:"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("public progress streaming", () => {
  it("requests public progress without exposing hidden reasoning", () => {
    const instructions = buildPublicProgressInstructions();
    expect(instructions).toContain("내부 사고 과정");
    expect(instructions).toContain("공개 가능한");
    expect(instructions).toContain("독립된 문단");
  });

  it("emits only completed agy paragraphs and flushes the final remainder", () => {
    const collector = new ProgressiveParagraphCollector();

    expect(collector.accept("첫 단계 확인 중")).toEqual([]);
    expect(collector.accept("첫 단계 확인 중입니다.\n\n둘째 단계")).toEqual([
      "첫 단계 확인 중입니다."
    ]);
    expect(collector.accept("첫 단계 확인 중입니다.\n\n둘째 단계 완료.\n\n최종")).toEqual([
      "둘째 단계 완료."
    ]);
    expect(collector.finish("첫 단계 확인 중입니다.\n\n둘째 단계 완료.\n\n최종 답변")).toEqual([
      "최종 답변"
    ]);
  });

  it("keeps Grok progress separate from the final completed response", () => {
    expect(parseGrokTranscript(
      "[PROGRESS] 첫 단계가 끝났습니다.\n\n[PROGRESS] 검증했습니다.\n\n[FINAL] 구현과 검증을 마쳤습니다."
    )).toEqual({
      progress: ["첫 단계가 끝났습니다.", "검증했습니다."],
      final: "구현과 검증을 마쳤습니다."
    });
    expect(parseGrokTranscript("표지 없는 호환 응답")).toEqual({
      progress: [],
      final: "표지 없는 호환 응답"
    });
    expect(parseGrokTranscript(
      "시작합니다. [PROGRESS] 구조를 확인했습니다. [PROGRESS] 검증을 마쳤습니다. [FINAL] 결과를 정리했습니다."
    )).toEqual({
      progress: ["시작합니다.", "구조를 확인했습니다.", "검증을 마쳤습니다."],
      final: "결과를 정리했습니다."
    });
  });

  it("coalesces Grok token fragments into one Telegram-ready progress message", () => {
    const collector = new GrokProgressCollector();

    expect(collector.accept("[PROG")).toEqual([]);
    expect(collector.accept("RESS] 첫 단계")).toEqual([]);
    expect(collector.accept("입니다. [/PROGRESS][PROGRESS] 둘째 단계")).toEqual(["첫 단계입니다."]);
    expect(collector.accept("입니다. [/PROGRESS][FINAL] 완료")).toEqual(["둘째 단계입니다."]);
    expect(collector.accept("했습니다. [/FINAL]")).toEqual(["완료했습니다."]);
    expect(collector.finish()).toEqual([]);
  });
});

describe("streaming input", () => {
  it("marks active runs as service shutdown before aborting them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-service-shutdown-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const session = {
      ...baseSession("service-shutdown", directory),
      provider: "codex" as const,
      codexThreadId: "thread-1",
      status: "running" as const
    };
    store.createSession(session);
    const manager = new SessionManager(
      store,
      fakeTransport,
      new PermissionBroker(store, fakeTransport, 1000),
      sessionManagerOptions(directory)
    );
    const run = {
      controller: new AbortController(),
      input: new MessageQueue(),
      pendingTurns: 1,
      startedAt: Date.now(),
      serviceShutdownRequested: false,
      codexTimers: new Map<string, NodeJS.Timeout>(),
      codexStarts: new Map<string, number>(),
      mcpFailures: new Map<string, number>()
    };

    try {
      (manager as unknown as { active: Map<string, typeof run>; }).active.set(session.id, run);

      await manager.dispose();

      expect(run.serviceShutdownRequested).toBe(true);
      expect(run.controller.signal.aborted).toBe(true);
      expect(store.getSession(session.id)?.status).toBe("running");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("queues steering and follow-up messages with distinct priorities", async () => {
    const queue = new MessageQueue();
    queue.push(buildUserMessage("현재 지시", "now"));
    queue.push(buildUserMessage("후속 작업", "next"));
    queue.close();

    const messages = [];
    for await (const message of queue) messages.push(message);

    expect(messages.map((message) => [message.message.content, message.priority])).toEqual([
      ["현재 지시", "now"],
      ["후속 작업", "next"]
    ]);
  });

  it("discards queued messages when a run is cancelled", async () => {
    const queue = new MessageQueue();
    queue.push(buildUserMessage("폐기할 예약 메시지", "next"));
    queue.cancel();

    const messages = [];
    for await (const message of queue) messages.push(message);

    expect(messages).toEqual([]);
  });

  it("builds a Codex restart prompt that preserves the interrupted instruction and prioritizes steering", () => {
    const prompt = buildCodexSteeredPrompt("원래 작업", "표로 바꿔");

    expect(prompt).toContain("원래 작업");
    expect(prompt).toContain("표로 바꿔");
    expect(prompt).toContain("우선 반영");
    expect(prompt).toContain("현재 저장소 상태");
  });

  it("builds an automatic limit-resume prompt without replaying the original task by default", () => {
    const prompt = buildLimitResumePrompt("초기 전체 지시");

    expect(prompt).toContain("[AUTO_LIMIT_RESUME]");
    expect(prompt).toContain("새 사용자 요청이 아니라");
    expect(prompt).toContain("새로 내려진 명령처럼 다시 실행하지 마십시오");
    expect(prompt).not.toContain("초기 전체 지시");
    expect(prompt).not.toContain("[INTERRUPTED_TASK_FOR_CONTEXT_ONLY]");
  });

  it("can include the interrupted task only as bounded context when provider history is unavailable", () => {
    const prompt = buildLimitResumePrompt("초기 전체 지시", { includeOriginalTask: true });

    expect(prompt).toContain("[AUTO_LIMIT_RESUME]");
    expect(prompt).toContain("[INTERRUPTED_TASK_FOR_CONTEXT_ONLY]");
    expect(prompt).toContain("초기 전체 지시");
    expect(prompt).toContain("[/INTERRUPTED_TASK_FOR_CONTEXT_ONLY]");
  });

  it("restores persisted Codex account limit state for /usage", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-codex-state-"));
    const home = join(directory, "codex-a");
    const store = new StateStore(join(directory, "state.sqlite"));
    const exhaustedUntil = Date.parse("2026-06-27T06:57:00.000Z");
    const latestUsage = {
      capturedAt: Date.parse("2026-06-24T15:00:00.000Z"),
      model: "gpt-5.5",
      reasoning: "high",
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 3,
      reasoningOutputTokens: 1,
      totalTokens: 13
    };

    try {
      store.setAppSetting("codex.accountState.v1", JSON.stringify({
        version: 1,
        accounts: [{ home, exhaustedUntil, latestUsage }]
      }));
      const manager = new SessionManager(
        store,
        fakeTransport,
        new PermissionBroker(store, fakeTransport, 1000),
        sessionManagerOptions(directory, [home])
      );

      expect(manager.getCodexUsageSnapshots(Date.parse("2026-06-26T00:00:00.000Z"))).toEqual([
        {
          accountIndex: 1,
          available: false,
          exhaustedUntil,
          latestUsage
        }
      ]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restarts an active Codex turn when steered instead of queueing for after the turn", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-codex-steer-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const session: SessionRecord = {
      id: "codex-steer",
      sdkSessionId: null,
      chatId: -1001,
      topicId: 10,
      projectName: "test",
      cwd: directory,
      title: "codex steer",
      status: "running",
      permissionMode: "default",
      provider: "codex",
      model: null,
      thinking: null,
      claudeEffort: null,
      codexModel: null,
      codexReasoning: null,
      codexThreadId: "thread-1",
      agyModel: null,
      agyThinkingLevel: null,
      agyConversationId: null,
      agyUsage: null,
      grokUsage: null,
      handoffSummary: null,
      goalCondition: null,
      leanMode: true,
      usageSnapshot: null,
      createdAt: 1,
      updatedAt: 1
    };
    const controller = new AbortController();
    const manager = new SessionManager(
      store,
      fakeTransport,
      new PermissionBroker(store, fakeTransport, 1000),
      sessionManagerOptions(directory)
    );

    try {
      store.createSession(session);
      (manager as unknown as {
        active: Map<string, {
          controller: AbortController;
          input: MessageQueue;
          pendingTurns: number;
          startedAt: number;
          codexCurrentPrompt: string;
          codexRestartPrompt?: string;
          codexTimers: Map<string, NodeJS.Timeout>;
          codexStarts: Map<string, number>;
          mcpFailures: Map<string, number>;
        }>;
      }).active.set(session.id, {
        controller,
        input: new MessageQueue(),
        pendingTurns: 1,
        startedAt: Date.now(),
        codexCurrentPrompt: "원래 작업",
        codexTimers: new Map(),
        codexStarts: new Map(),
        mcpFailures: new Map()
      });

      expect(manager.steer(session.id, "표로 바꿔")).toBe("restarted");
      const run = (manager as unknown as {
        active: Map<string, { codexRestartPrompt?: string; }>;
      }).active.get(session.id);
      expect(controller.signal.aborted).toBe(true);
      expect(run?.codexRestartPrompt).toContain("표로 바꿔");
      expect(run?.codexRestartPrompt).toContain("원래 작업");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("streaming output", () => {
  it("emits one completed visible text block and ignores thinking deltas", () => {
    const collector = new StreamingTextCollector();
    const base = {
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
      session_id: "session"
    };

    expect(collector.accept({
      type: "stream_event",
      ...base,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "", citations: null }
      }
    })).toBeNull();
    expect(collector.accept({
      type: "stream_event",
      ...base,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "파일 구조를 확인했습니다. " }
      }
    })).toBeNull();
    expect(collector.accept({
      type: "stream_event",
      ...base,
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "thinking_delta", thinking: "hidden", estimated_tokens: null }
      }
    })).toBeNull();
    expect(collector.accept({
      type: "stream_event",
      ...base,
      event: { type: "content_block_stop", index: 0 }
    })).toBe("파일 구조를 확인했습니다.");
  });

  it("ignores forwarded subagent text", () => {
    const collector = new StreamingTextCollector();
    expect(collector.accept({
      type: "stream_event",
      parent_tool_use_id: "tool-use",
      uuid: "00000000-0000-0000-0000-000000000002",
      session_id: "session",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "subagent detail" }
      }
    })).toBeNull();
  });

  it("does not resend a successful result after assistant text was delivered", () => {
    const result = {
      type: "result",
      subtype: "success",
      result: "이미 스트리밍된 최종 답변",
      session_id: "session"
    } as Parameters<typeof resultSummary>[0];

    expect(resultSummary(result, true)).toBe("");
    expect(resultSummary(result, false)).toBe("이미 스트리밍된 최종 답변");
  });
});

describe("compact command", () => {
  it("builds a manual compact command with an optional focus", () => {
    expect(buildCompactCommand()).toBe("/compact");
    expect(buildCompactCommand("  인증   변경 사항 중심  ")).toBe(
      "/compact 인증 변경 사항 중심"
    );
  });

  it("builds provider-neutral rollover summaries", () => {
    expect(buildRolloverSummaryPrompt()).toContain("인계 요약");
    expect(buildRolloverSummaryPrompt("검증 결과 중심")).toContain("검증 결과 중심");
  });

  it("builds a Claude native goal command", () => {
    expect(buildGoalCommand("  테스트   통과\ncheck: npm test  ")).toBe(
      "/goal 테스트 통과\ncheck: npm test"
    );
  });
});

describe("provider permission parity", () => {
  it("turns the shared modes into explicit provider instructions", () => {
    expect(buildPermissionModeInstructions("plan")).toContain("변경하지 말고");
    expect(buildPermissionModeInstructions("acceptEdits")).toContain("프로젝트 내부 파일 편집");
    expect(buildPermissionModeInstructions("auto")).toContain("자율 실행");
  });
});

describe("memory command", () => {
  it("builds a conservative explicit memory update request", () => {
    expect(buildMemoryPrompt()).toContain("[EXPLICIT_MEMORY_UPDATE]");
    expect(buildMemoryPrompt()).toContain("현재 세션 전체");
    expect(buildMemoryPrompt("  사용자   승인 규칙 중심  ")).toContain(
      "사용자가 지정한 저장 초점: 사용자 승인 규칙 중심"
    );
    expect(buildMemoryPrompt("token")).toContain("비밀정보, 자격증명은 저장하지 않는다");
  });

  it("injects mandatory query-first long-memory recall into provider bootstrap", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-bootstrap-memory-"));
    try {
      const prompt = buildProviderBootstrap(
        {
          ...baseSession("bootstrap-memory", directory),
          permissionMode: "auto"
        },
        join(directory, ".claude", "memory")
      );

      expect(prompt).toContain("[MEMORY_ROUTING]");
      expect(prompt).toContain("LLM-Wiki /query flow");
      expect(prompt).toContain("/query는 현재 대화나 연결된 MCP 목록만으로 답하지 않는다");
      expect(prompt).toContain("위키에 없음 — /compile 또는 /ingest 필요");
      expect(prompt).toContain("[CHATKJB_ORCHESTRATION_BOUNDARY]");
      expect(prompt).toContain("상위 조정자는 ChatKJB");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("wraps provider turns with an explicit ChatKJB boundary", () => {
    const prompt = buildOrchestratedTurnPrompt("현재 요청");

    expect(prompt).toContain("현재 시각은");
    expect(prompt).toContain("Asia/Seoul");
    expect(prompt).toContain("[CHATKJB_ORCHESTRATED_TURN]");
    expect(prompt).toContain("[USER_REQUEST]\n현재 요청\n[/USER_REQUEST]");
    expect(prompt).toContain("새 독립 작업 지시가 아니다");
    expect(buildOrchestratedTurnPrompt(prompt)).toBe(prompt);
    const boundary = buildOrchestrationBoundaryInstructions();
    expect(boundary).toContain("독립 native-app 세션으로 전환하지 않는다");
    expect(boundary).toContain("[SUBAGENT_DELEGATION_REQUIRED]");
    expect(boundary).toContain("조사 또는 구현이 포함된 요청은 provider-native subagent에 반드시 위임한다");
    expect(boundary).toContain("주 에이전트 단독으로 조사·구현을 시작하거나 완료하지 않는다");
    expect(boundary).toContain("사전 조사, 변경안 검토, 테스트 설계 또는 결과 검증");
    expect(boundary).toContain("사용자가 위임을 명시적으로 금지한 경우");
    expect(boundary).toContain("통로가 없으면 주 에이전트 단독 수행으로 바꾸지 말고");
    expect(boundary).toContain("판단·위험 확인·작업 분해·조율·결과 통합·통합 검증·최종 보고");
    expect(boundary).toContain("동시에 최대 4명(주 에이전트 제외)");
    expect(boundary).toContain("깊이 1");
    expect(boundary).toContain("재귀 위임 금지");
    expect(boundary).toContain("MCP 기동을 생략한 경량 role");
    expect(boundary).toContain("POLICIES.md#execution-and-subagents");
    expect(boundary.length).toBeLessThan(1_400);
  });
});

describe("lean implementation policy", () => {
  it("prefers existing capabilities without weakening safety or verification", () => {
    const instructions = buildLeanInstructions(true);
    expect(instructions).toContain("표준 라이브러리");
    expect(instructions).toContain("새 의존성을 추가하지 않는다");
    expect(instructions).toContain("보안");
    expect(instructions).toContain("실행 가능한 검증");
    expect(buildLeanInstructions(false)).toBe("");
  });
});

describe("project instructions", () => {
  it("loads instruction files without enabling filesystem settings", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-claude-instructions-"));
    try {
      writeFileSync(join(directory, "CLAUDE.md"), "Claude rules");
      writeFileSync(join(directory, "AGENTS.md"), "Agent rules");

      expect(loadProjectInstructions(directory)).toContain("[CLAUDE.md]\nClaude rules");
      expect(loadProjectInstructions(directory)).toContain("[AGENTS.md]\nAgent rules");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not duplicate project CLAUDE.md in Grok rules", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-grok-instructions-"));
    try {
      writeFileSync(join(directory, "CLAUDE.md"), "Claude compatibility rules");
      writeFileSync(join(directory, "AGENTS.md"), "Native agent rules");

      expect(loadSupplementalProjectInstructions(directory, "grok")).toBe("");
      expect(loadSupplementalProjectInstructions(directory, "codex"))
        .toContain("Claude compatibility rules");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("skips Claude append content identical to the user-scope CLAUDE.md", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-claude-dedupe-"));
    const home = mkdtempSync(join(tmpdir(), "telegram-claude-dedupe-home-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "CLAUDE.md"), "Global shared rules");
      // resource-sync가 네이티브 harness용으로 만드는 프로젝트 AGENTS.md 심링크와 같은 내용.
      writeFileSync(join(directory, "AGENTS.md"), "Global shared rules");
      writeFileSync(join(directory, "CLAUDE.md"), "Project-only rules");

      const result = loadSupplementalProjectInstructions(directory, "claude", { home });
      expect(result).toContain("[CLAUDE.md]\nProject-only rules");
      expect(result).not.toContain("Global shared rules");
      // 다른 제공자는 전역 파일과의 중복 검사 없이 기존 동작을 유지한다.
      expect(loadSupplementalProjectInstructions(directory, "codex", { home }))
        .toContain("Project-only rules");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("goal state", () => {
  it("stores a goal without launching a run when there is no resumable session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-goal-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const now = Date.now();
    const session: SessionRecord = {
      id: "goal-session",
      sdkSessionId: null,
      chatId: -1001,
      topicId: 42,
      projectName: "test",
      cwd: directory,
      title: "goal session",
      status: "done",
      permissionMode: "default",
      model: null,
      thinking: null,
      claudeEffort: null,
      provider: "claude",
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
      createdAt: now,
      updatedAt: now
    };
    store.createSession(session);
    const permissions = new PermissionBroker(store, fakeTransport, 1000);
    const manager = new SessionManager(store, fakeTransport, permissions, {
      debounceMs: 1,
      claudeCodeOauthToken: "test-token",
      mcpToolTimeoutMs: 1000,
      mcpMaxAttempts: 1,
      codexMcpTimeoutMs: 1000,
      codexMcpHeartbeatMs: 1000,
      longRunningMcpServers: new Set(["codex"]),
      turnIdleTimeoutMs: 600_000,
      claudeMemoryDir: join(directory, ".claude", "memory"),
      modelCatalog: FALLBACK_MODEL_CATALOG
    });

    try {
      // sdkSessionId가 없으므로 resume할 수 없어 실행을 시작하지 않고 저장만 한다.
      await expect(manager.setGoal(session.id, "  모든 테스트   통과  ")).resolves.toBe("stored");
      expect(store.getSession(session.id)?.goalCondition).toBe("모든 테스트 통과");
      expect(store.getSession(session.id)?.status).toBe("done");

      expect(manager.clearGoal(session.id)).toBe(true);
      expect(store.getSession(session.id)?.goalCondition).toBeNull();
      expect(manager.clearGoal(session.id)).toBe(false);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cancels a scheduled limit resume and marks the waiting session aborted", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-limit-restop-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const session = {
      ...baseSession("limit-session", directory),
      status: "waiting_limit" as const
    };
    store.createSession(session);
    const permissions = new PermissionBroker(store, fakeTransport, 1000);
    const manager = new SessionManager(store, fakeTransport, permissions, sessionManagerOptions(directory));
    const timer = setTimeout(() => {}, 60_000);

    try {
      (manager as unknown as { limitWaiters: Map<string, ReturnType<typeof setTimeout>>; })
        .limitWaiters.set(session.id, timer);

      expect(manager.cancelLimitResume(session.id)).toBe(true);
      expect(store.getSession(session.id)?.status).toBe("aborted");
      expect(manager.cancelLimitResume(session.id)).toBe(false);
    } finally {
      clearTimeout(timer);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("schedules provider-limit auto resume and keeps /restop able to cancel it", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-limit-resume-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const session = baseSession("limit-pause-session", directory);
    store.createSession(session);
    const sent: string[] = [];
    const transport: MessageTransport = {
      ...fakeTransport,
      async sendText(_chatId, _topicId, text) {
        sent.push(text);
        return 1;
      }
    };
    const permissions = new PermissionBroker(store, transport, 1000);
    const manager = new SessionManager(store, transport, permissions, sessionManagerOptions(directory));

    try {
      (manager as unknown as {
        scheduleLimitResume(
          session: SessionRecord,
          request: { session: SessionRecord; prompt: string; },
          sdkSessionId: string | null,
          resumeAt: number
        ): void;
        limitWaiters: Map<string, ReturnType<typeof setTimeout>>;
      }).scheduleLimitResume(
        session,
        { session, prompt: "continue" },
        null,
        Date.parse("2026-07-03T12:00:00.000Z")
      );

      expect(store.getSession(session.id)?.status).toBe("waiting_limit");
      expect((manager as unknown as { limitWaiters: Map<string, ReturnType<typeof setTimeout>>; }).limitWaiters.size)
        .toBe(1);
      expect(sent.at(-1)).toContain("자동 재개를 예약했습니다");
      expect(manager.cancelLimitResume(session.id)).toBe(true);
      expect(store.getSession(session.id)?.status).toBe("aborted");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rotates a Codex limit-resume task before it starts again", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-codex-limit-rotate-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const firstHome = join(directory, "codex-a");
    const nextHome = join(directory, "codex-b");
    const session = {
      ...baseSession("codex-limit-rotate", directory),
      provider: "codex" as const,
      codexHome: firstHome
    };
    store.createSession(session);
    const permissions = new PermissionBroker(store, fakeTransport, 1000);
    const manager = new SessionManager(
      store,
      fakeTransport,
      permissions,
      sessionManagerOptions(directory, [firstHome, nextHome])
    );

    try {
      const executor = (manager as unknown as {
        codexExecutor: {
          prepareRun(request: { session: SessionRecord; prompt: string; codexRotateOnStart?: boolean; }): {
            codexHome: string;
            request: { codexRotateOnStart?: boolean; };
          } | null;
          cleanupRun(ctx: unknown): void;
        };
      }).codexExecutor;
      const context = executor.prepareRun({ session, prompt: "continue", codexRotateOnStart: true });

      expect(context?.codexHome).toBe(nextHome);
      expect(context?.request.codexRotateOnStart).toBe(false);
      if (context) executor.cleanupRun(context);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows a follow-up to queue while a completed run is still finalizing", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-finalizing-resume-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const session = {
      ...baseSession("finalizing-session", directory),
      sdkSessionId: "sdk-session",
      status: "done" as const
    };
    store.createSession(session);
    const permissions = new PermissionBroker(store, fakeTransport, 1000);
    const manager = new SessionManager(store, fakeTransport, permissions, sessionManagerOptions(directory));
    const activeRun = {
      controller: new AbortController(),
      input: new MessageQueue(),
      pendingTurns: 0,
      startedAt: Date.now(),
      codexTimers: new Map(),
      codexStarts: new Map(),
      mcpFailures: new Map()
    };
    const neverDispatches = new Promise<void>(() => undefined);

    try {
      (manager as unknown as { active: Map<string, unknown>; }).active.set(session.id, activeRun);
      (manager as unknown as { projectTails: Map<string, Promise<void>>; }).projectTails.set(directory, neverDispatches);

      expect(manager.isActive(session.id)).toBe(true);
      expect(manager.isFinalizing(session.id)).toBe(true);
      expect(manager.resume(session, "다음 작업")).toBe(true);
      expect(store.getSession(session.id)?.status).toBe("queued");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps same-project queuedCounts consistent across serialized sessions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-queue-counts-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const sessions = [
      { ...baseSession("queue-session-1", directory), topicId: 42 },
      { ...baseSession("queue-session-2", directory), topicId: 43 },
      { ...baseSession("queue-session-3", directory), topicId: 44 }
    ];
    for (const session of sessions) store.createSession(session);
    const sent: string[] = [];
    const transport: MessageTransport = {
      ...fakeTransport,
      async sendText(_chatId, _topicId, text) {
        sent.push(text);
        return 1;
      }
    };
    const permissions = new PermissionBroker(store, transport, 1000);
    const manager = new SessionManager(store, transport, permissions, sessionManagerOptions(directory));
    const managerInternals = manager as unknown as {
      enqueue(request: { session: SessionRecord; prompt: string; }): void;
      dispatch(request: { session: SessionRecord; prompt: string; }): Promise<void>;
      queuedCounts: Map<string, number>;
      projectTails: Map<string, Promise<void>>;
      sessionTasks: Map<string, Promise<void>>;
    };
    const gates = [0, 1, 2].map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    });
    const order: string[] = [];
    let dispatchIndex = 0;
    managerInternals.dispatch = async (request) => {
      order.push(request.session.id);
      await gates[dispatchIndex++]!.promise;
    };
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

    try {
      for (const session of sessions) {
        managerInternals.enqueue({ session, prompt: `run ${session.id}` });
      }
      await tick();

      expect(order).toEqual(["queue-session-1"]);
      expect(sent.filter((text) => text.startsWith("[QUEUED]"))).toEqual([
        "[QUEUED] 같은 프로젝트에서 실행 중인 작업 1개가 끝나기를 기다립니다.\n앞선 작업이 종료되면 자동으로 시작합니다.",
        "[QUEUED] 같은 프로젝트에서 실행 중인 작업 2개가 끝나기를 기다립니다.\n앞선 작업이 종료되면 자동으로 시작합니다."
      ]);

      gates[0]!.resolve();
      await tick();
      expect(order).toEqual(["queue-session-1", "queue-session-2"]);
      gates[1]!.resolve();
      await tick();
      expect(order).toEqual(["queue-session-1", "queue-session-2", "queue-session-3"]);
      gates[2]!.resolve();
      await Promise.all(Array.from(managerInternals.sessionTasks.values()));
      await tick();

      expect(managerInternals.queuedCounts.has(directory)).toBe(false);
      expect(managerInternals.projectTails.has(directory)).toBe(false);
      expect(managerInternals.sessionTasks.size).toBe(0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses only provider-native goal and rejects providers without one", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-goal-providers-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const now = Date.now();
    const base: SessionRecord = {
      id: "",
      sdkSessionId: null,
      chatId: -1001,
      topicId: 0,
      projectName: "test",
      cwd: directory,
      title: "goal provider",
      status: "done",
      permissionMode: "default",
      model: null,
      thinking: null,
      claudeEffort: null,
      provider: "claude",
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
      createdAt: now,
      updatedAt: now
    };
    const codexSession: SessionRecord = {
      ...base, id: "codex-goal", topicId: 11, provider: "codex", codexThreadId: "thread-1"
    };
    const claudeSession: SessionRecord = {
      ...base, id: "claude-goal", topicId: 14, provider: "claude", sdkSessionId: "claude-session-1"
    };
    const agySession: SessionRecord = {
      ...base, id: "agy-goal", topicId: 12, provider: "agy", agyConversationId: "conv-1"
    };
    const grokSession: SessionRecord = {
      ...base, id: "grok-goal", topicId: 15, provider: "grok", grokSessionId: "grok-session-1"
    };
    const noResumeCodex: SessionRecord = {
      ...base, id: "codex-no-handle", topicId: 13, provider: "codex"
    };
    store.createSession(codexSession);
    store.createSession(claudeSession);
    store.createSession(agySession);
    store.createSession(grokSession);
    store.createSession(noResumeCodex);
    const permissions = new PermissionBroker(store, fakeTransport, 1000);
    const codexGoalCalls: Array<{ threadId: string; objective: string; codexHome?: string | null; }> = [];
    const manager = new SessionManager(store, fakeTransport, permissions, {
      debounceMs: 1,
      claudeCodeOauthToken: "test-token",
      mcpToolTimeoutMs: 1000,
      mcpMaxAttempts: 1,
      codexMcpTimeoutMs: 1000,
      codexMcpHeartbeatMs: 1000,
      longRunningMcpServers: new Set(["codex"]),
      turnIdleTimeoutMs: 600_000,
      claudeMemoryDir: join(directory, ".claude", "memory"),
      modelCatalog: FALLBACK_MODEL_CATALOG,
      codexAccountHomes: [join(directory, "codex-home")],
      codexGoalClient: {
        async setGoal(threadId, objective, options) {
          codexGoalCalls.push({ threadId, objective, codexHome: options?.codexHome ?? null });
        },
        async clearGoal() {
          return true;
        }
      },
      // 백그라운드 실제 실행을 막기 위해 곧장 삭제로 드레인하므로 Claude 트랜스크립트 삭제는 무시한다.
      deleteClaudeSession: async () => {}
    });

    try {
      await expect(manager.setGoal("codex-goal", "테스트 통과")).resolves.toBe("native");
      expect(codexGoalCalls).toEqual([{
        threadId: "thread-1",
        objective: "테스트 통과",
        codexHome: join(directory, "codex-home")
      }]);
      expect(store.getSession("codex-goal")?.status).toBe("done");
      await expect(manager.setGoal("claude-goal", "테스트 통과")).resolves.toBe("native");
      expect(store.getSession("claude-goal")?.goalCondition).toBe("테스트 통과");
      await expect(manager.setGoal("agy-goal", "테스트 통과")).resolves.toBe("unsupported");
      await expect(manager.setGoal("grok-goal", "테스트 통과")).resolves.toBe("unsupported");
      expect(store.getSession("agy-goal")?.goalCondition).toBeNull();
      expect(store.getSession("grok-goal")?.goalCondition).toBeNull();
      // 재개 핸들이 없으면(한 번도 실행 안 한 세션) 저장만 한다.
      await expect(manager.setGoal("codex-no-handle", "테스트 통과")).resolves.toBe("stored");
      expect(store.getSession("codex-no-handle")?.status).toBe("done");

      // Claude 네이티브 명령 큐가 외부 SDK를 호출하기 전에 안전하게 드레인한다.
      const drains = [
        manager.deleteSession(codexSession),
        manager.deleteSession(claudeSession)
      ];
      await new Promise((resolve) => setTimeout(resolve, 100));
      await Promise.all(drains);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not fall back when Codex native goal fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-goal-codex-native-failure-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const session = baseSession("codex-goal-native-failure", directory);
    store.createSession({
      ...session,
      provider: "codex",
      codexThreadId: "thread-1",
      status: "done"
    });
    const permissions = new PermissionBroker(store, fakeTransport, 1000);
    const manager = new SessionManager(store, fakeTransport, permissions, {
      debounceMs: 1,
      claudeCodeOauthToken: "test-token",
      mcpToolTimeoutMs: 1000,
      mcpMaxAttempts: 1,
      codexMcpTimeoutMs: 1000,
      codexMcpHeartbeatMs: 1000,
      longRunningMcpServers: new Set(["codex"]),
      turnIdleTimeoutMs: 600_000,
      claudeMemoryDir: join(directory, ".claude", "memory"),
      modelCatalog: FALLBACK_MODEL_CATALOG,
      codexAccountHomes: [join(directory, "codex-home")],
      codexGoalClient: {
        async setGoal() {
          throw new Error("unsupported method");
        },
        async clearGoal() {
          throw new Error("unsupported method");
        }
      },
      deleteClaudeSession: async () => {}
    });

    try {
      await expect(manager.setGoal("codex-goal-native-failure", "테스트 통과"))
        .rejects.toThrow("unsupported method");
      expect(store.getSession("codex-goal-native-failure")?.goalCondition).toBeNull();
      expect(store.getSession("codex-goal-native-failure")?.status).toBe("done");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("synthesis provider coverage", () => {
  it("uses every authenticated provider and delegates judging to the newest Fable model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-synth-providers-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    const permissions = new PermissionBroker(store, fakeTransport, 1000);
    const fable = FALLBACK_MODEL_CATALOG.claudeModels.find((model) => model.id === "claude-fable-5")!;
    const modelCatalog = {
      ...FALLBACK_MODEL_CATALOG,
      claudeModels: [
        { ...fable, id: "claude-fable-5-2", label: "Fable 5.2", source: "api" as const },
        { ...fable, id: "claude-fable-6", label: "Fable 6", source: "api" as const }
      ]
    };
    const manager = new SessionManager(store, fakeTransport, permissions, {
      ...sessionManagerOptions(directory),
      availableProviders: ["claude", "codex", "agy", "grok"],
      modelCatalog
    });
    const calls: Array<{
      provider: ProviderKind;
      claudeModelOverride?: string;
    }> = [];
    const internals = manager as unknown as {
      runSilentReadOnly: (
        session: SessionRecord,
        provider: ProviderKind,
        prompt: string,
        options?: { claudeModelOverride?: string; }
      ) => Promise<string>;
    };
    internals.runSilentReadOnly = async (_session, provider, _prompt, options = {}) => {
      calls.push({ provider, ...options });
      if (options.claudeModelOverride) {
        return '{"scores":[3,2,1,0],"winner":1,"reason":"best"}';
      }
      return `${provider} candidate`;
    };

    try {
      const result = await manager.runSynthesis(baseSession("synth", directory), "설계를 검토해줘");

      expect(result.ok).toBe(true);
      expect(result.candidates).toEqual(["claude", "codex", "agy", "grok"]);
      expect(result.verdict).toMatchObject({
        judge: "claude",
        judgeModel: "claude-fable-6"
      });
      expect(calls.some((call) => call.provider === "grok")).toBe(true);
      expect(calls.some((call) => call.claudeModelOverride === "claude-fable-6")).toBe(true);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("session context reset", () => {
  it("clears only the active provider's conversation and usage state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-reset-provider-boundary-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const agySession: SessionRecord = {
      ...baseSession("reset-agy", directory),
      provider: "agy",
      agyConversationId: "agy-conversation",
      agyUsage: '{"input":10}',
      grokSessionId: "grok-session",
      grokUsage: '{"input":20}',
      handoffSummary: "old context"
    };
    const grokSession: SessionRecord = {
      ...baseSession("reset-grok", directory),
      topicId: 43,
      provider: "grok",
      agyConversationId: "agy-conversation",
      agyUsage: '{"input":30}',
      grokSessionId: "grok-session",
      grokUsage: '{"input":40}',
      handoffSummary: "old context"
    };
    store.createSession(agySession);
    store.createSession(grokSession);
    const manager = new SessionManager(
      store,
      fakeTransport,
      new PermissionBroker(store, fakeTransport, 1000),
      sessionManagerOptions(directory)
    );

    try {
      await expect(manager.resetContext(agySession.id)).resolves.toEqual({ ok: true });
      expect(store.getSession(agySession.id)).toMatchObject({
        agyConversationId: null,
        agyUsage: null,
        grokSessionId: "grok-session",
        grokUsage: '{"input":20}',
        handoffSummary: null
      });

      await expect(manager.resetContext(grokSession.id)).resolves.toEqual({ ok: true });
      expect(store.getSession(grokSession.id)).toMatchObject({
        agyConversationId: "agy-conversation",
        agyUsage: '{"input":30}',
        grokSessionId: null,
        grokUsage: null,
        handoffSummary: null
      });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("clears Claude resume state only after transcript deletion succeeds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-reset-claude-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const session: SessionRecord = {
      id: "reset-claude",
      sdkSessionId: "sdk-reset",
      chatId: -1001,
      topicId: 70,
      projectName: "test",
      cwd: directory,
      title: "reset claude",
      status: "done",
      permissionMode: "default",
      provider: "claude",
      model: "claude-sonnet-4-6",
      thinking: "adaptive",
      claudeEffort: "high",
      codexModel: null,
      codexReasoning: null,
      codexThreadId: null,
      agyModel: null,
      agyThinkingLevel: null,
      agyConversationId: null,
      agyUsage: null,
      grokUsage: null,
      handoffSummary: "old context",
      goalCondition: null,
      leanMode: true,
      usageSnapshot: {
        capturedAt: 1,
        subscriptionType: "pro",
        rateLimitsAvailable: true
      },
      createdAt: 1,
      updatedAt: 1
    };
    store.createSession(session);
    const deleted: string[] = [];
    const manager = new SessionManager(
      store,
      fakeTransport,
      new PermissionBroker(store, fakeTransport, 1000),
      {
        debounceMs: 1,
        claudeCodeOauthToken: "test-token",
        mcpToolTimeoutMs: 1000,
        mcpMaxAttempts: 1,
        codexMcpTimeoutMs: 1000,
        codexMcpHeartbeatMs: 1000,
        longRunningMcpServers: new Set(["codex"]),
        turnIdleTimeoutMs: 600_000,
        claudeMemoryDir: join(directory, ".claude", "memory"),
        modelCatalog: FALLBACK_MODEL_CATALOG,
        deleteClaudeSession: async (id) => { deleted.push(id); }
      }
    );

    try {
      await expect(manager.resetContext(session.id)).resolves.toEqual({ ok: true });
      expect(deleted).toEqual(["sdk-reset"]);
      expect(store.getSession(session.id)).toMatchObject({
        sdkSessionId: null,
        handoffSummary: null,
        usageSnapshot: null,
        topicId: 70,
        model: "claude-sonnet-4-6"
      });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves Claude resume state when transcript deletion fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-reset-failure-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const now = Date.now();
    const session: SessionRecord = {
      id: "reset-failure",
      sdkSessionId: "sdk-still-valid",
      chatId: -1001,
      topicId: 71,
      projectName: "test",
      cwd: directory,
      title: "reset failure",
      status: "done",
      permissionMode: "default",
      provider: "claude",
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
      handoffSummary: "keep me",
      goalCondition: null,
      leanMode: true,
      usageSnapshot: null,
      createdAt: now,
      updatedAt: now
    };
    store.createSession(session);
    const manager = new SessionManager(
      store,
      fakeTransport,
      new PermissionBroker(store, fakeTransport, 1000),
      {
        debounceMs: 1,
        claudeCodeOauthToken: "test-token",
        mcpToolTimeoutMs: 1000,
        mcpMaxAttempts: 1,
        codexMcpTimeoutMs: 1000,
        codexMcpHeartbeatMs: 1000,
        longRunningMcpServers: new Set(["codex"]),
        turnIdleTimeoutMs: 600_000,
        claudeMemoryDir: join(directory, ".claude", "memory"),
        modelCatalog: FALLBACK_MODEL_CATALOG,
        deleteClaudeSession: async () => { throw new Error("delete failed"); }
      }
    );

    try {
      const result = await manager.resetContext(session.id);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("delete failed");
      expect(store.getSession(session.id)).toMatchObject({
        sdkSessionId: "sdk-still-valid",
        handoffSummary: "keep me"
      });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("session deletion", () => {
  it("removes the orchestrator record and the local Claude transcript", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-claude-delete-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const now = Date.now();
    const session: SessionRecord = {
      id: "orchestrator-session",
      sdkSessionId: "sdk-session",
      chatId: -1001,
      topicId: 42,
      projectName: "test",
      cwd: directory,
      title: "delete me",
      status: "done",
      permissionMode: "default",
      model: null,
      thinking: null,
      claudeEffort: null,
      provider: "claude",
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
      createdAt: now,
      updatedAt: now
    };
    store.createSession(session);
    const deleted: Array<{ id: string; dir?: string; }> = [];
    const permissions = new PermissionBroker(store, fakeTransport, 1000);
    const manager = new SessionManager(store, fakeTransport, permissions, {
      debounceMs: 1,
      claudeCodeOauthToken: "test-token",
      mcpToolTimeoutMs: 1000,
      mcpMaxAttempts: 1,
      codexMcpTimeoutMs: 1000,
      codexMcpHeartbeatMs: 1000,
      longRunningMcpServers: new Set(["codex", "obsidian"]),
      turnIdleTimeoutMs: 600_000,
      claudeMemoryDir: join(directory, ".claude", "memory"),
      modelCatalog: FALLBACK_MODEL_CATALOG,
      deleteClaudeSession: async (id, options) => {
        deleted.push({ id, ...(options?.dir ? { dir: options.dir } : {}) });
      }
    });

    try {
      await manager.deleteSession(session);
      await manager.deleteSession(session);
      expect(store.getSession(session.id)).toBeUndefined();
      expect(deleted).toEqual([{ id: "sdk-session", dir: directory }]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("reset timestamp parsing", () => {
  it("parses Codex 'try again at' with an absolute date and year", () => {
    const snapshot = snapshotFromRateLimitError(
      new Error(
        "You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jun 27th, 2026 3:57 PM."
      ),
      Date.parse("2026-06-24T05:00:00.000Z")
    );
    expect(snapshot?.fiveHour).toEqual({
      utilization: 100,
      resetsAt: "2026-06-27T06:57:00.000Z"
    });
  });

  it("parses Codex 'try again at' with a time only", () => {
    const snapshot = snapshotFromRateLimitError(
      new Error("You've hit your usage limit. Try again at 5:28 PM."),
      Date.parse("2026-06-24T02:00:00.000Z")
    );
    expect(snapshot?.fiveHour).toEqual({
      utilization: 100,
      resetsAt: "2026-06-24T08:28:00.000Z"
    });
  });

  it("parses a Claude weekly limit with a month/day and no year", () => {
    const snapshot = snapshotFromRateLimitError(
      new Error("You've hit your weekly limit · resets Jun 25 at 9am (Asia/Seoul)"),
      Date.parse("2026-06-24T02:20:00.000Z")
    );
    expect(snapshot?.fiveHour).toEqual({
      utilization: 100,
      resetsAt: "2026-06-25T00:00:00.000Z"
    });
  });

  it("still parses the bare 'resets 2pm (TZ)' form", () => {
    const snapshot = snapshotFromRateLimitError(
      new Error("You've hit your session limit · resets 2pm (Asia/Seoul)"),
      Date.parse("2026-06-16T02:20:00.000Z")
    );
    expect(snapshot?.fiveHour).toEqual({
      utilization: 100,
      resetsAt: "2026-06-16T05:00:00.000Z"
    });
  });
});

describe("Codex live usage recovery time", () => {
  const now = Date.parse("2026-07-05T11:31:00.000Z");

  it("uses the five-hour reset while weekly usage is not exhausted", () => {
    expect(codexExhaustedUntilFromLiveUsage({
      capturedAt: now,
      planType: "plus",
      primary: {
        usedPercent: 100,
        windowDurationMins: 300,
        resetsAt: "2026-07-05T14:45:02.000Z"
      },
      secondary: {
        usedPercent: 61,
        windowDurationMins: 10080,
        resetsAt: "2026-07-10T11:58:14.000Z"
      },
      resetCreditsAvailable: 1,
      creditsBalance: "0",
      rateLimitReachedType: "rate_limit_reached",
      lifetimeTokens: null,
      peakDailyTokens: null,
      currentStreakDays: null
    }, now)).toBe(Date.parse("2026-07-05T14:45:02.000Z"));
  });

  it("uses the weekly reset when weekly usage is exhausted", () => {
    expect(codexExhaustedUntilFromLiveUsage({
      capturedAt: now,
      planType: "plus",
      primary: {
        usedPercent: 100,
        windowDurationMins: 300,
        resetsAt: "2026-07-05T14:45:02.000Z"
      },
      secondary: {
        usedPercent: 100,
        windowDurationMins: 10080,
        resetsAt: "2026-07-10T15:45:00.000Z"
      },
      resetCreditsAvailable: 0,
      creditsBalance: "0",
      rateLimitReachedType: "rate_limit_reached",
      lifetimeTokens: null,
      peakDailyTokens: null,
      currentStreakDays: null
    }, now)).toBe(Date.parse("2026-07-10T15:45:00.000Z"));
  });

  it("clears exhaustion when neither window is exhausted", () => {
    expect(codexExhaustedUntilFromLiveUsage({
      capturedAt: now,
      planType: "plus",
      primary: {
        usedPercent: 1,
        windowDurationMins: 300,
        resetsAt: "2026-07-05T16:31:29.000Z"
      },
      secondary: {
        usedPercent: 0,
        windowDurationMins: 10080,
        resetsAt: "2026-07-12T11:31:29.000Z"
      },
      resetCreditsAvailable: 3,
      creditsBalance: "0",
      rateLimitReachedType: null,
      lifetimeTokens: null,
      peakDailyTokens: null,
      currentStreakDays: null
    }, now)).toBeNull();
  });
});

describe("no-rollout classification", () => {
  it("detects a missing Codex rollout as a resumable error", () => {
    expect(
      isNoRolloutError(
        new Error(
          "Codex Exec exited with code 1: Reading prompt from stdin...\nError: thread/resume: thread/resume failed: no rollout found for thread id 019ef7fa-e0a6-7a51-9189-8b656aa0aa5f (code -32600)"
        )
      )
    ).toBe(true);
    expect(isNoRolloutError(new Error("You've hit your usage limit"))).toBe(false);
    expect(isNoRolloutError(new Error("turn aborted"))).toBe(false);
  });
});
