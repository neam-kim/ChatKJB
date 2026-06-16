import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBot, formatSessionStatus, modelKeyboard } from "../src/bot.js";
import type { AppConfig } from "../src/config.js";
import { StateStore } from "../src/store.js";
import type { SessionRecord } from "../src/types.js";

const cleanup: Array<{ store: StateStore; directory: string }> = [];

function session(status: SessionRecord["status"]): SessionRecord {
  return {
    id: "session",
    sdkSessionId: "sdk-session",
    chatId: -1001,
    topicId: 42,
    projectName: "test",
    cwd: "/tmp",
    title: "test session",
    status,
    permissionMode: "default",
    model: null,
    thinking: null,
    leanMode: true,
    usageSnapshot: null,
    createdAt: 0,
    updatedAt: 0
  };
}

function botSetup() {
  const directory = mkdtempSync(join(tmpdir(), "telegram-claude-bot-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  const project = { name: "test", cwd: directory, defaultMode: "default" as const };
  store.syncProjects([project]);
  store.createSession(session("done"));
  const config = {
    telegramBotToken: "123456789:test-token",
    allowedUserId: 7,
    chatId: -1001,
    claudeCodeOauthToken: "test-oauth-token",
    claudeCodeOauthTokens: ["test-oauth-token"],
    databasePath: join(directory, "state.sqlite"),
    projectsPath: join(directory, "projects.json"),
    projects: [project],
    claudeMemoryDir: join(directory, "memory"),
    fileInboxDir: join(directory, "inbox"),
    approvalTimeoutMs: 60_000,
    statusDebounceMs: 1000,
    mcpToolTimeoutMs: 60_000,
    mcpMaxAttempts: 3,
    codexMcpTimeoutMs: 60_000,
    codexMcpHeartbeatMs: 10_000,
    longRunningMcpServers: new Set(["codex"]),
    turnIdleTimeoutMs: 120_000,
    claudeCodeExecutable: undefined
  } satisfies AppConfig;
  const instance = createBot(config, store);
  instance.bot.botInfo = {
    id: 123456789,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    can_manage_bots: false,
    has_topics_enabled: true,
    allows_users_to_create_topics: false
  };
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  instance.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return {
      ok: true,
      result: method === "sendMessage"
        ? {
            message_id: calls.length,
            date: 0,
            chat: { id: -1001, type: "supergroup", title: "Test" },
            text: String((payload as { text?: string }).text ?? "")
          }
        : true
    } as never;
  });
  cleanup.push({ store, directory });
  return { ...instance, store, calls };
}

function modelCommand(text: string, updateId = 1) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      message_thread_id: 42,
      chat: { id: -1001, type: "supergroup" as const, title: "Test" },
      from: { id: 7, is_bot: false, first_name: "User" },
      text,
      entities: [{ type: "bot_command" as const, offset: 0, length: 6 }]
    }
  };
}

function leanCommand(text: string, updateId = 1) {
  return {
    ...modelCommand(text, updateId),
    message: {
      ...modelCommand(text, updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 5 }]
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const item of cleanup.splice(0)) {
    item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

describe("session status formatting", () => {
  it("distinguishes a live active run from a stored status", () => {
    expect(formatSessionStatus(session("running"), true)).toContain("작업: 실행 중");
    expect(formatSessionStatus(session("running"), false)).toContain("작업: 실행 중인 작업 없음");
    expect(formatSessionStatus(session("running"), true))
      .toContain("Codex: gpt-5.5 · reasoning high");
    expect(formatSessionStatus(session("running"), true)).toContain("lean: on");
  });

  it("shows queued and approval states", () => {
    expect(formatSessionStatus(session("queued"), false)).toContain("작업: 대기 중");
    expect(formatSessionStatus(session("waiting_approval"), false)).toContain("작업: 승인 대기 중");
    expect(formatSessionStatus(session("verification_failed"), false))
      .toContain("작업: 완료 검증 실패");
  });
});

describe("/lean command", () => {
  it("persists the session policy", async () => {
    const { bot, store } = botSetup();

    await bot.handleUpdate(leanCommand("/lean off"));

    expect(store.getSession("session")?.leanMode).toBe(false);
  });

  it("rejects changes while the session is active", async () => {
    const { bot, sessions, store, calls } = botSetup();
    vi.spyOn(sessions, "isActive").mockReturnValue(true);

    await bot.handleUpdate(leanCommand("/lean off"));

    expect(store.getSession("session")?.leanMode).toBe(true);
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("실행 중에는 바꿀 수 없습니다.");
  });
});

describe("model selection keyboard", () => {
  it("offers all supported models with canonical callback IDs", () => {
    expect(modelKeyboard().inline_keyboard).toEqual([
      [{ text: "Opus 4.8", callback_data: "model:claude-opus-4-8" }],
      [{ text: "Sonnet 4.6", callback_data: "model:claude-sonnet-4-6" }],
      [{ text: "Fable 5", callback_data: "model:claude-fable-5" }]
    ]);
  });
});

describe("/model command", () => {
  it("updates the stored model from an alias", async () => {
    const { bot, store } = botSetup();

    await bot.handleUpdate(modelCommand("/model sonnet"));

    expect(store.getSession("session")?.model).toBe("claude-sonnet-4-6");
  });

  it("rejects model changes while the session is active", async () => {
    const { bot, sessions, store, calls } = botSetup();
    vi.spyOn(sessions, "isActive").mockReturnValue(true);

    await bot.handleUpdate(modelCommand("/model fable"));

    expect(store.getSession("session")?.model).toBeNull();
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("실행 중에는 바꿀 수 없습니다.");
  });

  it("shows the current model and inline keyboard without an argument", async () => {
    const { bot, calls } = botSetup();

    await bot.handleUpdate(modelCommand("/model"));

    const reply = calls.find((call) => call.method === "sendMessage")?.payload;
    expect(reply?.text).toContain("현재 모델: Opus 4.8");
    expect(reply?.reply_markup).toEqual(modelKeyboard());
  });
});
