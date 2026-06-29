import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/store.js";
import { DEFAULT_AGY_MODEL } from "../src/model-catalog.js";
import type { SessionRecord } from "../src/types.js";

const tempDirs: string[] = [];

function makeStore(): StateStore {
  const directory = mkdtempSync(join(tmpdir(), "telegram-claude-store-"));
  tempDirs.push(directory);
  const store = new StateStore(join(directory, "state.sqlite"));
  store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
  return store;
}

function makeSession(cwd: string): SessionRecord {
  const now = Date.now();
  return {
    id: "session-1",
    sdkSessionId: null,
    chatId: -1001,
    topicId: 42,
    projectName: "test",
    cwd,
    title: "test session",
    status: "running",
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
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("StateStore", () => {
  it("counts all stored sessions", () => {
    const store = makeStore();
    const session = makeSession(store.db.name.replace(/\/state\.sqlite$/, ""));
    store.createSession(session);

    expect(store.countSessions()).toBe(1);
    store.close();
  });

  it("persists topic mappings and session policy", () => {
    const store = makeStore();
    const session = makeSession(store.db.name.replace(/\/state\.sqlite$/, ""));
    store.createSession(session);
    store.updateSession(session.id, {
      sdkSessionId: "sdk-1",
      status: "done",
      usageSnapshot: {
        capturedAt: 1,
        subscriptionType: "pro",
        rateLimitsAvailable: true,
        fiveHour: { utilization: 42, resetsAt: "2026-06-12T06:00:00.000Z" }
      }
    });
    expect(store.getSessionByTopic(-1001, 42)).toMatchObject({
      sdkSessionId: "sdk-1",
      status: "done",
      leanMode: true,
      usageSnapshot: {
        subscriptionType: "pro",
        fiveHour: { utilization: 42 }
      }
    });
    store.close();
  });

  it("persists a session model and defaults new sessions to null", () => {
    const store = makeStore();
    const session = makeSession(store.db.name.replace(/\/state\.sqlite$/, ""));
    store.createSession(session);

    expect(store.getSession(session.id)?.model).toBeNull();
    store.updateSession(session.id, { model: "claude-sonnet-4-6" });
    expect(store.getSession(session.id)?.model).toBe("claude-sonnet-4-6");
    store.close();
  });

  it("migrates retired provider values back to Claude", () => {
    const store = makeStore();
    const path = store.db.name;
    const session = makeSession(path.replace(/\/state\.sqlite$/, ""));
    store.createSession(session);
    store.db.prepare("UPDATE sessions SET provider = 'retired-provider' WHERE id = ?").run(session.id);
    store.db.prepare(
      "INSERT OR REPLACE INTO app_settings(key, value) VALUES ('default.provider', 'retired-provider')"
    ).run();
    store.close();

    const reopened = new StateStore(path);
    expect(reopened.getSession(session.id)?.provider).toBe("claude");
    expect(reopened.getSessionDefaults().provider).toBe("claude");
    reopened.close();
  });

  it("resets incompatible agy CLI conversation handles once during the SDK cutover", () => {
    const store = makeStore();
    const path = store.db.name;
    const session = {
      ...makeSession(path.replace(/\/state\.sqlite$/, "")),
      provider: "agy" as const,
      agyModel: "Gemini 3.1 Pro (High)",
      agyConversationId: "legacy-cli-conversation"
    };
    store.createSession(session);
    store.db.prepare("DELETE FROM app_settings WHERE key = 'agy.backend'").run();
    store.close();

    const migrated = new StateStore(path);
    expect(migrated.getSession(session.id)).toMatchObject({
      agyModel: DEFAULT_AGY_MODEL,
      agyConversationId: null
    });
    migrated.updateSession(session.id, { agyConversationId: "sdk-conversation" });
    migrated.close();

    const reopened = new StateStore(path);
    expect(reopened.getSession(session.id)?.agyConversationId).toBe("sdk-conversation");
    reopened.close();
  });

  it("marks unfinished work interrupted on restart", () => {
    const store = makeStore();
    const session = makeSession(store.db.name.replace(/\/state\.sqlite$/, ""));
    store.createSession(session);

    expect(store.interruptIncompleteSessions()).toBe(1);
    expect(store.getSession(session.id)?.status).toBe("interrupted");
    store.close();
  });

  it("persists pending reserved tasks with start options", () => {
    const store = makeStore();
    const dueAt = Date.now() + 60_000;
    const task = store.createReservedTask({
      chatId: -1001,
      projectName: "test",
      prompt: "README 점검",
      dueAt,
      startOptions: {
        provider: "codex",
        codexModel: "gpt-5-codex",
        codexReasoning: "medium",
        codexHome: "/tmp/codex-home"
      }
    });

    expect(store.listPendingReservedTasks()).toMatchObject([{
      id: task.id,
      projectName: "test",
      prompt: "README 점검",
      dueAt,
      status: "pending",
      startOptions: {
        provider: "codex",
        codexModel: "gpt-5-codex",
        codexReasoning: "medium",
        codexHome: "/tmp/codex-home"
      }
    }]);

    store.updateReservedTask(task.id, {
      status: "done",
      topicId: 123,
      sessionId: "session-123"
    });
    expect(store.getReservedTask(task.id)).toMatchObject({
      status: "done",
      topicId: 123,
      sessionId: "session-123"
    });
    expect(store.listPendingReservedTasks()).toEqual([]);
    store.close();
  });

  it("deletes a session and cascades its pending approvals", () => {
    const store = makeStore();
    const session = makeSession(store.db.name.replace(/\/state\.sqlite$/, ""));
    store.createSession(session);
    store.createApproval({
      nonce: "approval-1",
      toolUseId: "tool-1",
      sessionId: session.id,
      toolName: "Edit",
      input: { file_path: "a.ts" },
      suggestions: [],
      status: "pending",
      expiresAt: Date.now() + 60_000,
      messageId: 1
    });

    expect(store.deleteSession(session.id)).toBe(true);
    expect(store.getSession(session.id)).toBeUndefined();
    expect(store.getApproval("approval-1")).toBeUndefined();
    expect(store.deleteSession(session.id)).toBe(false);
    store.close();
  });

  it("persists agyThinkingLevel and defaults new sessions to null", () => {
    const store = makeStore();
    const session = makeSession(store.db.name.replace(/\/state\.sqlite$/, ""));
    store.createSession(session);

    expect(store.getSession(session.id)?.agyThinkingLevel).toBeNull();
    store.updateSession(session.id, { agyThinkingLevel: "medium" });
    expect(store.getSession(session.id)?.agyThinkingLevel).toBe("medium");
    store.updateSession(session.id, { agyThinkingLevel: null });
    expect(store.getSession(session.id)?.agyThinkingLevel).toBeNull();
    store.close();
  });

  it("persists and normalizes the new-session agy thinking default", () => {
    const store = makeStore();

    expect(store.getSessionDefaults().agyThinkingLevel).toBe("minimal");
    expect(store.updateSessionDefaults({ agyThinkingLevel: "high" }).agyThinkingLevel)
      .toBe("high");
    store.db.prepare(
      "INSERT OR REPLACE INTO app_settings(key, value) VALUES ('default.agyThinkingLevel', 'invalid')"
    ).run();
    expect(store.getSessionDefaults().agyThinkingLevel).toBe("minimal");

    store.close();
  });

  it("migrates agy_thinking_level column to null on existing databases", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-claude-agy-think-"));
    tempDirs.push(directory);
    const path = join(directory, "state.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE projects (
        name TEXT PRIMARY KEY,
        cwd TEXT NOT NULL UNIQUE,
        default_mode TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        sdk_session_id TEXT UNIQUE,
        chat_id INTEGER NOT NULL,
        topic_id INTEGER NOT NULL,
        project_name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        agy_model TEXT,
        agy_conversation_id TEXT,
        always_allowed_tools TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO projects(name, cwd, default_mode, updated_at) VALUES ('test', '${directory}', 'default', 0);
      INSERT INTO sessions(
        id, chat_id, topic_id, project_name, cwd, title, status, permission_mode,
        provider, always_allowed_tools, created_at, updated_at
      ) VALUES (
        'sess-agy-migrate', -1001, 99, 'test', '${directory}', 'legacy', 'done', 'default',
        'agy', '[]', 0, 0
      );
    `);
    legacy.close();

    const store = new StateStore(path);
    const columns = store.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain("agy_thinking_level");
    // 기존 행은 null 기본값이어야 한다.
    expect(store.getSession("sess-agy-migrate")?.agyThinkingLevel).toBeNull();
    store.close();
  });

  it("persists agyUsage and defaults new sessions to null", () => {
    const store = makeStore();
    const session = makeSession(store.db.name.replace(/\/state\.sqlite$/, ""));
    store.createSession(session);

    expect(store.getSession(session.id)?.agyUsage).toBeNull();
    const usageJson = JSON.stringify({
      promptTokenCount: 100,
      cachedContentTokenCount: null,
      candidatesTokenCount: 50,
      thoughtsTokenCount: null,
      totalTokenCount: 150
    });
    store.updateSession(session.id, { agyUsage: usageJson });
    expect(store.getSession(session.id)?.agyUsage).toBe(usageJson);
    store.updateSession(session.id, { agyUsage: null });
    expect(store.getSession(session.id)?.agyUsage).toBeNull();
    store.close();
  });

  it("migrates agy_usage column to null on existing databases (Phase 3)", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-claude-agy-usage-"));
    tempDirs.push(directory);
    const path = join(directory, "state.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE projects (
        name TEXT PRIMARY KEY,
        cwd TEXT NOT NULL UNIQUE,
        default_mode TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        sdk_session_id TEXT UNIQUE,
        chat_id INTEGER NOT NULL,
        topic_id INTEGER NOT NULL,
        project_name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        agy_model TEXT,
        agy_conversation_id TEXT,
        agy_thinking_level TEXT,
        always_allowed_tools TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO projects(name, cwd, default_mode, updated_at) VALUES ('test', '${directory}', 'default', 0);
      INSERT INTO sessions(
        id, chat_id, topic_id, project_name, cwd, title, status, permission_mode,
        provider, always_allowed_tools, created_at, updated_at
      ) VALUES (
        'sess-phase3-migrate', -1001, 101, 'test', '${directory}', 'legacy', 'done', 'default',
        'agy', '[]', 0, 0
      );
    `);
    legacy.close();

    const store = new StateStore(path);
    const columns = store.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    // agy_usage 컬럼이 마이그레이션으로 추가되어 있어야 한다.
    expect(columns.map((c) => c.name)).toContain("agy_usage");
    // 기존 행은 null 기본값이어야 한다.
    expect(store.getSession("sess-phase3-migrate")?.agyUsage).toBeNull();
    store.close();
  });

  it("adds usage snapshots and models to databases created by the cost-tracking schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-claude-legacy-store-"));
    tempDirs.push(directory);
    const path = join(directory, "state.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE projects (
        name TEXT PRIMARY KEY,
        cwd TEXT NOT NULL UNIQUE,
        default_mode TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        sdk_session_id TEXT UNIQUE,
        chat_id INTEGER NOT NULL,
        topic_id INTEGER NOT NULL,
        project_name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        cost_usd REAL,
        always_allowed_tools TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    const store = new StateStore(path);
    const columns = store.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("usage_snapshot");
    expect(columns.map((column) => column.name)).toContain("model");
    expect(columns.map((column) => column.name)).toContain("lean_mode");
    store.close();
  });
});
