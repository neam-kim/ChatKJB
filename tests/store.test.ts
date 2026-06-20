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

  it("marks unfinished work interrupted on restart", () => {
    const store = makeStore();
    const session = makeSession(store.db.name.replace(/\/state\.sqlite$/, ""));
    store.createSession(session);
    store.createPlanRun({
      id: "plan-run",
      sessionId: session.id,
      instruction: "구현",
      planText: "계획",
      status: "executing",
      reviewerVerdict: null,
      reviewText: null,
      codexResult: null,
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
      completedAt: null
    });

    expect(store.interruptIncompleteSessions()).toBe(1);
    expect(store.getSession(session.id)?.status).toBe("interrupted");
    expect(store.getPlanRun("plan-run")?.status).toBe("interrupted");
    store.close();
  });

  it("persists plan criteria and evidence with reviewer results", () => {
    const store = makeStore();
    const session = makeSession(store.db.name.replace(/\/state\.sqlite$/, ""));
    store.createSession(session);
    store.createPlanRun({
      id: "plan-run",
      sessionId: session.id,
      instruction: "구현",
      planText: "계획",
      status: "planning",
      reviewerVerdict: null,
      reviewText: null,
      codexResult: null,
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
      completedAt: null
    });

    const [criterion] = store.replacePlanCriteria("plan-run", ["npm test가 통과한다."]);
    expect(criterion).toBeDefined();
    store.updatePlanCriterion(criterion!.id, "pass", "종료 코드 0");
    store.addPlanEvidence({
      id: "evidence-1",
      planRunId: "plan-run",
      criterionId: criterion!.id,
      kind: "command",
      source: "codex",
      summary: "completed: npm test",
      details: { exitCode: 0 },
      createdAt: 2
    });
    store.updatePlanRun("plan-run", {
      status: "passed",
      reviewerVerdict: "APPROVE",
      reviewText: "{}",
      completedAt: 3
    });

    expect(store.getLatestPlanRunForSession(session.id)).toMatchObject({
      status: "passed",
      reviewerVerdict: "APPROVE"
    });
    expect(store.listPlanCriteria("plan-run")).toMatchObject([{
      status: "pass",
      evidenceSummary: "종료 코드 0"
    }]);
    expect(store.listPlanEvidence("plan-run")).toMatchObject([{
      criterionId: criterion!.id,
      details: { exitCode: 0 }
    }]);
    store.close();
  });

  it("redacts secrets before persisting plan text and evidence", () => {
    const store = makeStore();
    const session = makeSession(store.db.name.replace(/\/state\.sqlite$/, ""));
    const apiKey = `sk-${"a".repeat(24)}`;
    const oauthToken = `sk-ant-oat01-${"private_token"}`;
    const telegramToken = `123456789:${"A".repeat(32)}`;
    store.createSession(session);
    store.createPlanRun({
      id: "secret-plan",
      sessionId: session.id,
      instruction: `use OPENAI_API_KEY=${apiKey}`,
      planText: `token ${oauthToken}`,
      status: "planning",
      reviewerVerdict: null,
      reviewText: null,
      codexResult: null,
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
      completedAt: null
    });
    const [criterion] = store.replacePlanCriteria(
      "secret-plan",
      [`API_KEY=${apiKey}를 출력하지 않는다.`]
    );
    store.updatePlanCriterion(criterion!.id, "pass", `Bearer ${"sensitive-token"}`);
    store.addPlanEvidence({
      id: "secret-evidence",
      planRunId: "secret-plan",
      criterionId: null,
      kind: "command",
      source: "codex",
      summary: "Bearer sensitive-token",
      details: { output: `TELEGRAM_BOT_TOKEN=${telegramToken}` },
      createdAt: 2
    });

    expect(store.getPlanRun("secret-plan")).toMatchObject({
      instruction: "use OPENAI_API_KEY=[REDACTED]",
      planText: "token [REDACTED]"
    });
    expect(store.listPlanCriteria("secret-plan")).toMatchObject([{
      description: "API_KEY=[REDACTED] 출력하지 않는다.",
      evidenceSummary: "[REDACTED]"
    }]);
    expect(store.listPlanEvidence("secret-plan")).toMatchObject([{
      summary: "[REDACTED]",
      details: { output: "TELEGRAM_BOT_TOKEN=[REDACTED]" }
    }]);
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
    store.createPlanRun({
      id: "plan-run",
      sessionId: session.id,
      instruction: "구현",
      planText: "계획",
      status: "planning",
      reviewerVerdict: null,
      reviewText: null,
      codexResult: null,
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
      completedAt: null
    });

    expect(store.deleteSession(session.id)).toBe(true);
    expect(store.getSession(session.id)).toBeUndefined();
    expect(store.getApproval("approval-1")).toBeUndefined();
    expect(store.getPlanRun("plan-run")).toBeUndefined();
    expect(store.deleteSession(session.id)).toBe(false);
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
