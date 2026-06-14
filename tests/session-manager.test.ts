import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionBroker } from "../src/permission-broker.js";
import {
  buildClaudeEnvironment,
  buildCodexEnvironment,
  buildCompactCommand,
  buildMemoryPrompt,
  buildUserMessage,
  CLAUDE_MODEL,
  CLAUDE_THINKING,
  CODEX_MODEL,
  CODEX_REASONING_EFFORT,
  loadProjectInstructions,
  MessageQueue,
  requireCodexSubscriptionAuth,
  resolveModel,
  resultSummary,
  SessionManager,
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
    expect(resolveModel("sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveModel("fable")).toBe("claude-fable-5");
    expect(resolveModel("opus")).toBe("claude-opus-4-8");
    expect(resolveModel(" CLAUDE-SONNET-4-6 ")).toBe("claude-sonnet-4-6");
    expect(resolveModel("없는모델")).toBeUndefined();
  });
});

describe("Codex model policy", () => {
  it("forces GPT-5.5 with high reasoning", () => {
    expect(CODEX_MODEL).toBe("gpt-5.5");
    expect(CODEX_REASONING_EFFORT).toBe("high");
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
