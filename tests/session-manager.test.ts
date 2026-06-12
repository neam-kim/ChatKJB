import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionBroker } from "../src/permission-broker.js";
import {
  buildClaudeEnvironment,
  buildCompactCommand,
  buildUserMessage,
  loadProjectInstructions,
  MessageQueue,
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
  async sendDocument() {}
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
});

describe("compact command", () => {
  it("builds a manual compact command with an optional focus", () => {
    expect(buildCompactCommand()).toBe("/compact");
    expect(buildCompactCommand("  인증   변경 사항 중심  ")).toBe(
      "/compact 인증 변경 사항 중심"
    );
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

describe("session inspection", () => {
  it("maps active runs to stored sessions and reports the oldest Codex start", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-claude-inspect-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
    const now = Date.now();
    const session: SessionRecord = {
      id: "inspect-session",
      sdkSessionId: "sdk-session",
      chatId: -1001,
      topicId: 42,
      projectName: "test",
      cwd: directory,
      title: "inspect me",
      status: "running",
      permissionMode: "default",
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
      claudeMemoryDir: join(directory, ".claude", "memory")
    });
    const active = (manager as unknown as {
      active: Map<string, {
        controller: AbortController;
        input: MessageQueue;
        pendingTurns: number;
        startedAt: number;
        codexTimers: Map<string, NodeJS.Timeout>;
        codexStarts: Map<string, number>;
        mcpFailures: Map<string, number>;
      }>;
    }).active;
    active.set(session.id, {
      controller: new AbortController(),
      input: new MessageQueue(),
      pendingTurns: 2,
      startedAt: now - 5000,
      codexTimers: new Map(),
      codexStarts: new Map([["newer", now - 1000], ["older", now - 3000]]),
      mcpFailures: new Map()
    });
    active.set("missing-session", {
      controller: new AbortController(),
      input: new MessageQueue(),
      pendingTurns: 1,
      startedAt: now,
      codexTimers: new Map(),
      codexStarts: new Map(),
      mcpFailures: new Map()
    });

    try {
      const result = manager.inspect();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        sessionId: session.id,
        cwd: directory,
        title: "inspect me",
        pendingTurns: 2,
        codexInFlight: true
      });
      expect(result[0]?.codexElapsedMs).toBeGreaterThanOrEqual(3000);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
