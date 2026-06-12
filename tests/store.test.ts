import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/store.js";
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
      usageSnapshot: {
        subscriptionType: "pro",
        fiveHour: { utilization: 42 }
      }
    });
    store.close();
  });

  it("marks unfinished work interrupted on restart", () => {
    const store = makeStore();
    const session = makeSession(store.db.name.replace(/\/state\.sqlite$/, ""));
    store.createSession(session);

    expect(store.interruptIncompleteSessions()).toBe(1);
    expect(store.getSession(session.id)?.status).toBe("interrupted");
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

  it("adds usage snapshots to databases created by the cost-tracking schema", () => {
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
    store.close();
  });
});
