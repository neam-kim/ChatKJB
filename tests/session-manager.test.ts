import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionBroker } from "../src/permission-broker.js";
import { FALLBACK_MODEL_CATALOG, resolveModel } from "../src/model-catalog.js";
import {
  agyFailureFromLog,
  agyRequestsProceed,
  buildClaudeEnvironment,
  buildCodexSteeredPrompt,
  buildCodexEnvironment,
  buildCompactCommand,
  buildGoalCheckPrompt,
  buildGoalPrompt,
  buildLeanInstructions,
  buildLimitResumePrompt,
  buildMemoryPrompt,
  buildPermissionModeInstructions,
  buildPublicProgressInstructions,
  buildRolloverSummaryPrompt,
  buildUserMessage,
  CLAUDE_MODEL,
  MAX_GOAL_ROUNDS,
  CLAUDE_THINKING,
  CODEX_MODEL,
  CODEX_REASONING_EFFORT,
  isNoRolloutError,
  isOverloadedError,
  isRateLimitError,
  loadProjectInstructions,
  MessageQueue,
  mimeFromPath,
  extractAgyAttachments,
  ProgressiveParagraphCollector,
  requireCodexSubscriptionAuth,
  resultFailureText,
  resultSummary,
  SessionManager,
  snapshotFromRateLimitError,
  StreamingTextCollector
} from "../src/session-manager.js";
import { StateStore } from "../src/store.js";
import type { MessageTransport, SessionRecord } from "../src/types.js";
import { agyApiModel, normalizeAgyResponse } from "../src/agy-interactive.js";

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
    expect(buildCodexEnvironment(undefined, {
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

  it("overrides CODEX_HOME with the selected account home", () => {
    expect(buildCodexEnvironment("/tmp/codex-acct-b", {
      PATH: "/usr/bin",
      CODEX_HOME: "/tmp/codex"
    })).toEqual({
      PATH: "/usr/bin",
      CODEX_HOME: "/tmp/codex-acct-b"
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
  it("maps agy display model names to Gemini API model ids", () => {
    expect(agyApiModel("Gemini 3.1 Pro (High)")).toBe("gemini-3.1-pro-preview");
    expect(agyApiModel("Gemini 3.5 Flash (Medium)")).toBe("gemini-3.5-flash");
    expect(agyApiModel("gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

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
        active: Map<string, { codexRestartPrompt?: string }>;
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

  it("injects deterministic check results as objective facts when all pass", () => {
    const prompt = buildGoalCheckPrompt("모든 테스트 통과", {
      allPassed: true,
      results: [{ command: "npm test", passed: true, outputTail: "" }]
    });
    expect(prompt).toContain("결정론적 검증 결과");
    expect(prompt).toContain("PASS: npm test");
    expect(prompt).toContain("모든 결정론적 검증은 통과");
    expect(prompt).toContain("모든 테스트 통과");
  });

  it("tells the judge it's unmet when a check fails", () => {
    const prompt = buildGoalCheckPrompt("빌드 성공", {
      allPassed: false,
      results: [{ command: "tsc --noEmit", passed: false, outputTail: "error TS1234: boom" }]
    });
    expect(prompt).toContain("FAIL: tsc --noEmit");
    expect(prompt).toContain("GOAL_UNMET");
    expect(prompt).toContain("미충족");
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
      agyThinkingLevel: null,
      agyConversationId: null,
      agyUsage: null,
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
      agyThinkingLevel: null,
      agyConversationId: null,
      agyUsage: null,
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

describe("session context reset", () => {
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

describe("agy conversation file cleanup on delete", () => {
  // 유효한 32자 16진수 conversation_id를 가진 agy 세션을 삭제하면
  // save_dir의 .db/.db-shm/.db-wal 파일이 제거되어야 한다.
  it("removes .db and sidecar files when conversation_id is valid", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-agy-delete-"));
    const saveDir = join(directory, "agy-conversations");
    mkdirSync(saveDir, { recursive: true });
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const now = Date.now();
    const convId = "0589e314d927af6f4f204b5926cec2a7"; // 32자 16진수
    const session: SessionRecord = {
      id: "agy-session",
      sdkSessionId: null,
      chatId: -1001,
      topicId: 50,
      projectName: "test",
      cwd: directory,
      title: "agy delete test",
      status: "done",
      permissionMode: "default",
      model: null,
      thinking: null,
      claudeEffort: null,
      provider: "agy",
      codexModel: null,
      codexReasoning: null,
      codexThreadId: null,
      agyModel: "gemini-2.5-pro",
      agyThinkingLevel: null,
      agyConversationId: convId,
      agyUsage: null,
      handoffSummary: null,
      goalCondition: null,
      leanMode: false,
      usageSnapshot: null,
      createdAt: now,
      updatedAt: now
    };
    // 가짜 .db/.db-shm/.db-wal 파일 생성
    for (const suffix of [".db", ".db-shm", ".db-wal"]) {
      writeFileSync(join(saveDir, convId + suffix), "fake");
    }
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
      modelCatalog: FALLBACK_MODEL_CATALOG,
      deleteClaudeSession: async () => {},
      agyConvSaveDir: saveDir
    });

    try {
      await manager.deleteSession(session);
      // 세션 레코드가 삭제되어야 한다.
      expect(store.getSession(session.id)).toBeUndefined();
      // .db/.db-shm/.db-wal 파일이 모두 제거되어야 한다.
      for (const suffix of [".db", ".db-shm", ".db-wal"]) {
        expect(existsSync(join(saveDir, convId + suffix))).toBe(false);
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // WAL/SHM 사이드카가 없어도 force: true 덕분에 예외 없이 완료되어야 한다.
  it("succeeds even when sidecar files are absent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-agy-delete-nosidecar-"));
    const saveDir = join(directory, "agy-conversations");
    mkdirSync(saveDir, { recursive: true });
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const now = Date.now();
    const convId = "aabbccdd11223344aabbccdd11223344"; // 32자 16진수
    const session: SessionRecord = {
      id: "agy-session-nosidecar",
      sdkSessionId: null,
      chatId: -1001,
      topicId: 51,
      projectName: "test",
      cwd: directory,
      title: "agy delete no sidecar",
      status: "done",
      permissionMode: "default",
      model: null,
      thinking: null,
      claudeEffort: null,
      provider: "agy",
      codexModel: null,
      codexReasoning: null,
      codexThreadId: null,
      agyModel: "gemini-2.5-pro",
      agyThinkingLevel: null,
      agyConversationId: convId,
      agyUsage: null,
      handoffSummary: null,
      goalCondition: null,
      leanMode: false,
      usageSnapshot: null,
      createdAt: now,
      updatedAt: now
    };
    // .db 파일만 생성 (사이드카 없음)
    writeFileSync(join(saveDir, convId + ".db"), "fake");
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
      modelCatalog: FALLBACK_MODEL_CATALOG,
      deleteClaudeSession: async () => {},
      agyConvSaveDir: saveDir
    });

    try {
      // 사이드카가 없어도 예외 없이 완료되어야 한다.
      await expect(manager.deleteSession(session)).resolves.not.toThrow();
      expect(existsSync(join(saveDir, convId + ".db"))).toBe(false);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // conversation_id가 유효하지 않은 형식이면 파일 제거 없이 건너뛰어야 한다.
  it("skips file removal when conversation_id has invalid format", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-agy-delete-invalid-"));
    const saveDir = join(directory, "agy-conversations");
    mkdirSync(saveDir, { recursive: true });
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const now = Date.now();
    const badConvId = "../etc/passwd"; // 경로 조작 시도
    const session: SessionRecord = {
      id: "agy-session-badid",
      sdkSessionId: null,
      chatId: -1001,
      topicId: 52,
      projectName: "test",
      cwd: directory,
      title: "agy delete bad id",
      status: "done",
      permissionMode: "default",
      model: null,
      thinking: null,
      claudeEffort: null,
      provider: "agy",
      codexModel: null,
      codexReasoning: null,
      codexThreadId: null,
      agyModel: "gemini-2.5-pro",
      agyThinkingLevel: null,
      agyConversationId: badConvId,
      agyUsage: null,
      handoffSummary: null,
      goalCondition: null,
      leanMode: false,
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
      modelCatalog: FALLBACK_MODEL_CATALOG,
      deleteClaudeSession: async () => {},
      agyConvSaveDir: saveDir
    });

    try {
      // 잘못된 형식이어도 예외 없이 완료되어야 한다.
      await expect(manager.deleteSession(session)).resolves.not.toThrow();
      // 세션 레코드만 삭제되고, saveDir에 별도 파일이 생성되지 않아야 한다.
      expect(store.getSession(session.id)).toBeUndefined();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Phase 6: mimeFromPath / extractAgyAttachments 단위 테스트
// ──────────────────────────────────────────────────────────────────────────────

describe("mimeFromPath — 확장자 → MIME 테이블", () => {
  it.each([
    // 이미지
    ["/inbox/photo.jpg",  "image/jpeg"],
    ["/inbox/photo.jpeg", "image/jpeg"],
    ["/inbox/img.png",    "image/png"],
    ["/inbox/img.webp",   "image/webp"],
    ["/inbox/img.bmp",    "image/bmp"],
    // 문서
    ["/inbox/doc.pdf",   "application/pdf"],
    ["/inbox/notes.txt", "text/plain"],
    ["/inbox/data.csv",  "text/csv"],
    ["/inbox/info.json", "application/json"],
    ["/inbox/page.html", "text/html"],
    ["/inbox/page.htm",  "text/html"],
    ["/inbox/feed.xml",  "text/xml"],
    ["/inbox/style.css", "text/css"],
    ["/inbox/app.js",    "text/javascript"],
    ["/inbox/doc.rtf",   "text/rtf"],
    // 오디오
    ["/inbox/track.mp3",  "audio/mpeg"],
    ["/inbox/voice.m4a",  "audio/m4a"],
    ["/inbox/sound.wav",  "audio/wav"],
    ["/inbox/music.aac",  "audio/aac"],
    ["/inbox/song.flac",  "audio/flac"],
    ["/inbox/pod.ogg",    "audio/ogg"],
    ["/inbox/voice.opus", "audio/opus"],
    // 동영상
    ["/inbox/clip.mp4",  "video/mp4"],
    ["/inbox/clip.mov",  "video/quicktime"],
    ["/inbox/clip.webm", "video/webm"],
    ["/inbox/clip.avi",  "video/avi"],
    ["/inbox/clip.mpeg", "video/mpeg"],
    ["/inbox/clip.mpg",  "video/mpeg"],
    ["/inbox/clip.3gp",  "video/3gpp"],
    ["/inbox/clip.wmv",  "video/wmv"],
    ["/inbox/clip.flv",  "video/x-flv"],
  ] as [string, string][])("mimeFromPath(%s) === %s", (path, expected) => {
    expect(mimeFromPath(path)).toBe(expected);
  });

  it("지원되지 않는 확장자는 undefined를 반환한다", () => {
    expect(mimeFromPath("/inbox/archive.zip")).toBeUndefined();
    expect(mimeFromPath("/inbox/data.bin")).toBeUndefined();
    expect(mimeFromPath("/inbox/image.gif")).toBeUndefined();
  });

  it("확장자가 없는 경로는 undefined를 반환한다", () => {
    expect(mimeFromPath("/inbox/noextension")).toBeUndefined();
  });

  it("대소문자를 구분하지 않는다 (확장자를 소문자로 정규화)", () => {
    expect(mimeFromPath("/inbox/PHOTO.JPG")).toBe("image/jpeg");
    expect(mimeFromPath("/inbox/DOC.PDF")).toBe("application/pdf");
  });
});

describe("extractAgyAttachments — fileMessage에서 첨부 파싱", () => {
  it("표준 fileMessage에서 저장 경로를 추출하고 지원 MIME으로 변환한다", () => {
    const prompt = [
      "[첨부 파일]",
      "종류: 사진",
      "파일명: test.jpg",
      "저장 경로: /Users/user/inbox/2026-01-01_test.jpg",
    ].join("\n");

    const result = extractAgyAttachments(prompt);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ path: "/Users/user/inbox/2026-01-01_test.jpg", mimeType: "image/jpeg" });
  });

  it("지원되지 않는 형식(zip 등)은 제외하고 빈 배열을 반환한다", () => {
    const prompt = [
      "[첨부 파일]",
      "종류: 문서",
      "파일명: archive.zip",
      "저장 경로: /inbox/archive.zip",
    ].join("\n");

    const result = extractAgyAttachments(prompt);
    expect(result).toHaveLength(0);
  });

  it("저장 경로 줄이 없으면 빈 배열을 반환한다", () => {
    const prompt = "일반 텍스트 메시지입니다.";
    expect(extractAgyAttachments(prompt)).toHaveLength(0);
  });

  it("여러 저장 경로 줄이 있으면 모두 파싱한다 (다중 첨부)", () => {
    const prompt = [
      "[첨부 파일]",
      "저장 경로: /inbox/img.png",
      "저장 경로: /inbox/doc.pdf",
    ].join("\n");

    const result = extractAgyAttachments(prompt);
    expect(result).toHaveLength(2);
    expect(result[0]?.mimeType).toBe("image/png");
    expect(result[1]?.mimeType).toBe("application/pdf");
  });

  it("캡션이 있는 fileMessage에서도 정상 파싱된다", () => {
    const prompt = [
      "[첨부 파일]",
      "종류: 문서",
      "파일명: report.pdf",
      "저장 경로: /inbox/report.pdf",
      "캡션: 분기 보고서",
    ].join("\n");

    const result = extractAgyAttachments(prompt);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ path: "/inbox/report.pdf", mimeType: "application/pdf" });
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
