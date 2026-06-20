import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionBroker } from "../src/permission-broker.js";
import { FALLBACK_MODEL_CATALOG, resolveModel } from "../src/model-catalog.js";
import {
  buildClaudeEnvironment,
  buildCodexEnvironment,
  buildCompactCommand,
  buildGoalCheckPrompt,
  buildGoalPrompt,
  buildLeanInstructions,
  buildMemoryPrompt,
  buildUserMessage,
  CLAUDE_MODEL,
  MAX_GOAL_ROUNDS,
  CLAUDE_THINKING,
  CODEX_MODEL,
  CODEX_REASONING_EFFORT,
  isOverloadedError,
  isRateLimitError,
  loadProjectInstructions,
  MessageQueue,
  requireCodexSubscriptionAuth,
  resultFailureText,
  resultSummary,
  SessionManager,
  snapshotFromRateLimitError,
  StreamingTextCollector
} from "../src/session-manager.js";
import { StateStore } from "../src/store.js";
import type { MessageTransport, SessionRecord } from "../src/types.js";

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

describe("Claude child environment", () => {
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
    expect(buildCodexEnvironment({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      OPENAI_API_KEY: "openai-key",
      CODEX_API_KEY: "codex-key",
      OPENAI_BASE_URL: "https://example.test",
      CODEX_HOME: "/tmp/codex"
    })).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      CODEX_HOME: "/tmp/codex"
    });
  });

  it("accepts ChatGPT login and rejects API-key auth mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-codex-auth-"));
    try {
      writeFileSync(join(directory, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
      expect(() => requireCodexSubscriptionAuth({ CODEX_HOME: directory })).not.toThrow();

      writeFileSync(join(directory, "auth.json"), JSON.stringify({ auth_mode: "apikey" }));
      expect(() => requireCodexSubscriptionAuth({ CODEX_HOME: directory }))
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
});

describe("streaming input", () => {
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
});

describe("goal prompts", () => {
  it("builds a goal turn prompt and folds in the prior unmet reason", () => {
    expect(buildGoalPrompt("모든 테스트가 통과한다")).toContain(
      "[GOAL] 다음 목표가 완전히 충족될 때까지"
    );
    expect(buildGoalPrompt("모든 테스트가 통과한다")).toContain("모든 테스트가 통과한다");
    const withReason = buildGoalPrompt("모든 테스트가 통과한다", "auth 테스트 2건 실패");
    expect(withReason).toContain("아직 충족되지 않았습니다: auth 테스트 2건 실패");
  });

  it("builds a read-only check prompt that forces the GOAL_MET/GOAL_UNMET format", () => {
    const prompt = buildGoalCheckPrompt("lint가 깨끗하다");
    expect(prompt).toContain("읽기 전용");
    expect(prompt).toContain("GOAL_MET:");
    expect(prompt).toContain("GOAL_UNMET:");
    expect(prompt).toContain("lint가 깨끗하다");
  });

  it("caps automatic goal rounds to prevent runaway loops", () => {
    expect(MAX_GOAL_ROUNDS).toBe(25);
  });
});

describe("goal state", () => {
  it("stores a goal without launching a run when there is no resumable session", () => {
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
      agyConversationId: null,
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
      expect(manager.setGoal(session.id, "  모든 테스트   통과  ")).toBe("stored");
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

  it("launches a goal run for codex and agy sessions via their resume handles", async () => {
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
      agyConversationId: null,
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
    const agySession: SessionRecord = {
      ...base, id: "agy-goal", topicId: 12, provider: "agy", agyConversationId: "conv-1"
    };
    const noResumeCodex: SessionRecord = {
      ...base, id: "codex-no-handle", topicId: 13, provider: "codex"
    };
    store.createSession(codexSession);
    store.createSession(agySession);
    store.createSession(noResumeCodex);
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
      // 백그라운드 실제 실행을 막기 위해 곧장 삭제로 드레인하므로 Claude 트랜스크립트 삭제는 무시한다.
      deleteClaudeSession: async () => {}
    });

    try {
      // 재개 핸들(codexThreadId/agyConversationId)이 있으면 즉시 목표 턴을 큐에 넣는다.
      expect(manager.setGoal("codex-goal", "테스트 통과")).toBe("queued");
      expect(store.getSession("codex-goal")?.status).toBe("queued");
      expect(manager.setGoal("agy-goal", "테스트 통과")).toBe("queued");
      expect(store.getSession("agy-goal")?.status).toBe("queued");
      // 재개 핸들이 없으면(한 번도 실행 안 한 세션) 저장만 한다.
      expect(manager.setGoal("codex-no-handle", "테스트 통과")).toBe("stored");
      expect(store.getSession("codex-no-handle")?.status).toBe("done");

      // 큐에 들어간 실제 실행이 외부 CLI를 호출하기 전에 안전하게 드레인한다.
      // deleteSession은 동기 구간에서 먼저 deleting에 등록하므로, await 전에 둘 다 호출하면
      // 디스패치가 풀릴 때 두 세션 모두 deleting 가드에 걸려 즉시 반환한다. store가 열린 채
      // 큐가 비워지도록 잠시 대기한 뒤(닫힌 store 접근 방지) 삭제 완료를 기다린다.
      const drains = [manager.deleteSession(codexSession), manager.deleteSession(agySession)];
      await new Promise((resolve) => setTimeout(resolve, 100));
      await Promise.all(drains);
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
      agyConversationId: null,
      handoffSummary: null,
      goalCondition: null,
      leanMode: true,
      usageSnapshot: null,
      createdAt: now,
      updatedAt: now
    };
    store.createSession(session);
    const deleted: Array<{ id: string; dir?: string }> = [];
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
      expect(store.getSession(session.id)).toBeUndefined();
      expect(deleted).toEqual([{ id: "sdk-session", dir: directory }]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
