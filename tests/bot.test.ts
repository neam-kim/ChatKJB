import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBot,
  formatSessionStatus,
  modelKeyboard,
  parseReserveCommand,
  resolveSessionUploadPath
} from "../src/bot.js";
import type { AppConfig } from "../src/config.js";
import { FALLBACK_MODEL_CATALOG } from "../src/model-catalog.js";
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
    createdAt: 0,
    updatedAt: 0
  };
}

function botSetup(extra?: { claudeCodeOauthTokens?: string[]; codexAccountHomes?: string[] }) {
  const directory = mkdtempSync(join(tmpdir(), "telegram-claude-bot-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  const project = { name: "test", cwd: directory, defaultMode: "default" as const };
  store.syncProjects([project]);
  store.createSession({ ...session("done"), cwd: directory });
  const codexAccountHomes = extra?.codexAccountHomes ?? [join(directory, "codex-home")];
  const claudeCodeOauthTokens = extra?.claudeCodeOauthTokens ?? ["test-oauth-token"];
  const config = {
    telegramBotToken: "123456789:test-token",
    allowedUserId: 7,
    allowedUserIds: [7],
    chatId: -1001,
    claudeCodeOauthToken: claudeCodeOauthTokens[0] ?? "test-oauth-token",
    claudeCodeOauthTokens,
    codexAccountHomes,
    modelCatalog: FALLBACK_MODEL_CATALOG,
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
    claudeCodeExecutable: undefined,
    agyExecutable: "agy",
    geminiApiKey: "test-gemini-api-key-value-1234567890",
    agySdkPython: "/usr/bin/python3"
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
    let result: unknown = true;
    if (method === "sendMessage") {
      result = {
        message_id: calls.length,
        date: 0,
        chat: { id: -1001, type: "supergroup", title: "Test" },
        text: String((payload as { text?: string }).text ?? "")
      };
    } else if (method === "createForumTopic") {
      result = { message_thread_id: 7777, name: "topic", icon_color: 0 };
    }
    return { ok: true, result } as never;
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

function newCommand(updateId = 1) {
  return {
    ...modelCommand("/new", updateId),
    message: {
      ...modelCommand("/new", updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 4 }]
    }
  };
}

function reserveCommand(text: string, updateId = 1) {
  return {
    ...modelCommand(text, updateId),
    message: {
      ...modelCommand(text, updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 8 }]
    }
  };
}

function cancelCommand(updateId = 1) {
  return {
    ...modelCommand("/cancel", updateId),
    message: {
      ...modelCommand("/cancel", updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 7 }]
    }
  };
}

function callbackUpdate(data: string, updateId = 1) {
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: 7, is_bot: false, first_name: "User" },
      chat_instance: "instance",
      data,
      message: {
        message_id: updateId,
        date: 0,
        message_thread_id: 42,
        chat: { id: -1001, type: "supergroup" as const, title: "Test" },
        from: { id: 123456789, is_bot: true, first_name: "Test" }
      }
    }
  };
}

function textMessage(text: string, updateId = 1, topicId = 42) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      message_thread_id: topicId,
      chat: { id: -1001, type: "supergroup" as const, title: "Test" },
      from: { id: 7, is_bot: false, first_name: "User" },
      text
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

function goalCommand(text: string, updateId = 1) {
  return {
    ...modelCommand(text, updateId),
    message: {
      ...modelCommand(text, updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 5 }]
    }
  };
}

function usageCommand(updateId = 1) {
  return {
    ...modelCommand("/usage", updateId),
    message: {
      ...modelCommand("/usage", updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 6 }]
    }
  };
}

function effortCommand(text: string, updateId = 1) {
  return {
    ...modelCommand(text, updateId),
    message: {
      ...modelCommand(text, updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 7 }]
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

describe("reserve command parsing", () => {
  it("parses a project, KST time expression, and prompt", () => {
    const now = new Date(2026, 5, 29, 22, 10, 0, 0);
    expect(parseReserveCommand("ChatKJB 내일 오전 9시 README 점검", now)).toMatchObject({
      projectIdentifier: "ChatKJB",
      dueAt: new Date(2026, 5, 30, 9, 0, 0, 0).getTime(),
      prompt: "README 점검"
    });
    expect(parseReserveCommand("ChatKJB 내일 오전 9시에 README 점검", now)).toMatchObject({
      projectIdentifier: "ChatKJB",
      dueAt: new Date(2026, 5, 30, 9, 0, 0, 0).getTime(),
      prompt: "README 점검"
    });
    expect(parseReserveCommand("ChatKJB 30분 뒤 테스트 실행", now)).toMatchObject({
      projectIdentifier: "ChatKJB",
      dueAt: new Date(2026, 5, 29, 22, 40, 0, 0).getTime(),
      prompt: "테스트 실행"
    });
    expect(parseReserveCommand("ChatKJB 2026-06-30 09:00 README 점검", now)).toMatchObject({
      projectIdentifier: "ChatKJB",
      dueAt: new Date(2026, 5, 30, 9, 0, 0, 0).getTime(),
      prompt: "README 점검"
    });
  });
});

describe("session status formatting", () => {
  it("distinguishes a live active run from a stored status", () => {
    expect(formatSessionStatus(session("running"), true)).toContain("작업: 실행 중");
    expect(formatSessionStatus(session("running"), false)).toContain("작업: 실행 중인 작업 없음");
    expect(formatSessionStatus(session("running"), true)).toContain("제공자: Claude");
    expect(formatSessionStatus(session("running"), true)).toContain("lean: on");
  });

  it("reflects the per-session Codex reasoning effort for a Codex session", () => {
    const tuned = { ...session("running"), provider: "codex" as const, codexReasoning: "low" };
    expect(formatSessionStatus(tuned, true)).toContain("제공자: Codex");
    expect(formatSessionStatus(tuned, true)).toContain("reasoning 낮음 (Low)");
  });

  it("shows the selected Codex account number when codexHome is known", () => {
    const codexHomes = ["/tmp/codex-a", "/tmp/codex-b"];
    const tuned = {
      ...session("running"),
      provider: "codex" as const,
      codexHome: codexHomes[1]!
    };

    expect(formatSessionStatus(tuned, true, FALLBACK_MODEL_CATALOG, codexHomes))
      .toContain("Codex 계정: #2");
  });

  it("shows the default Claude 작업량 and reflects an override", () => {
    expect(formatSessionStatus(session("running"), true))
      .toContain("Claude 작업량: 높음 (High)");
    const tuned = { ...session("running"), claudeEffort: "max" };
    expect(formatSessionStatus(tuned, true)).toContain("Claude 작업량: 최대 (Max)");
  });

  it("shows queued and approval states", () => {
    expect(formatSessionStatus(session("queued"), false)).toContain("작업: 대기 중");
    expect(formatSessionStatus(session("waiting_approval"), false)).toContain("작업: 승인 대기 중");
    expect(formatSessionStatus(session("verification_failed"), false))
      .toContain("작업: 완료 검증 실패");
  });
});

describe("/power command", () => {
  it("persists the Claude 작업량 for the next run", async () => {
    const { bot, store } = botSetup();

    await bot.handleUpdate(modelCommand("/power max"));

    expect(store.getSession("session")?.claudeEffort).toBe("max");
  });

  it("rejects an unsupported 작업량", async () => {
    const { bot, store, calls } = botSetup();

    await bot.handleUpdate(modelCommand("/power adaptive"));

    expect(store.getSession("session")?.claudeEffort).toBeNull();
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("지원하지 않는 작업량입니다");
  });

  it("rejects changes while the session is active", async () => {
    const { bot, sessions, store, calls } = botSetup();
    vi.spyOn(sessions, "isActive").mockReturnValue(true);

    await bot.handleUpdate(modelCommand("/power low"));

    expect(store.getSession("session")?.claudeEffort).toBeNull();
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("실행 중에는 바꿀 수 없습니다.");
  });

  it("persists Codex reasoning through the unified command", async () => {
    const { bot, store } = botSetup();
    store.updateSession("session", { provider: "codex", codexModel: "gpt-5.5" });

    await bot.handleUpdate(modelCommand("/power low"));

    expect(store.getSession("session")?.codexReasoning).toBe("low");
  });

  it("persists agy thinking level through the unified command", async () => {
    const { bot, store } = botSetup();
    store.updateSession("session", { provider: "agy" });

    await bot.handleUpdate(modelCommand("/power medium"));

    expect(store.getSession("session")?.agyThinkingLevel).toBe("medium");
  });

  it("keeps /effort as a compatibility alias and announces /power", async () => {
    const { bot, store, calls } = botSetup();
    store.updateSession("session", { provider: "codex", codexModel: "gpt-5.5" });

    await bot.handleUpdate(effortCommand("/effort xhigh"));

    expect(store.getSession("session")?.codexReasoning).toBe("xhigh");
    expect(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text)
      .toContain("/power로 통합");
  });
});

describe("/reset command", () => {
  it("delegates context reset for the current topic", async () => {
    const { bot, sessions, calls } = botSetup();
    const reset = vi.spyOn(sessions, "resetContext").mockResolvedValue({ ok: true });

    await bot.handleUpdate(modelCommand("/reset"));

    expect(reset).toHaveBeenCalledWith("session");
    expect(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text)
      .toContain("다음 메시지부터 새 문맥");
  });

  it("preserves the failure reason returned by the session manager", async () => {
    const { bot, sessions, calls } = botSetup();
    vi.spyOn(sessions, "resetContext").mockResolvedValue({
      ok: false,
      reason: "대화 파일을 정리하지 못했습니다."
    });

    await bot.handleUpdate(modelCommand("/reset"));

    expect(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text)
      .toContain("대화 파일을 정리하지 못했습니다.");
  });
});

describe("/steer command", () => {
  it("answers a pending Claude question before queueing a steering turn", async () => {
    const { bot, sessions, permissions, calls } = botSetup();
    const answer = vi.spyOn(permissions, "handleTextInput").mockResolvedValue(true);
    const steer = vi.spyOn(sessions, "steer");

    await bot.handleUpdate(modelCommand("/steer 2번으로 진행", 100));

    expect(answer).toHaveBeenCalledWith("session", "2번으로 진행");
    expect(steer).not.toHaveBeenCalled();
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("대기 중인 질문에 답변");
  });
});

function thinkingCommand(text: string, updateId = 1) {
  return {
    ...modelCommand(text, updateId),
    message: {
      ...modelCommand(text, updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 9 }]
    }
  };
}

describe("/thinking command", () => {
  it("accepts a thinking toggle but rejects effort levels", async () => {
    const { bot, store, calls } = botSetup();

    await bot.handleUpdate(thinkingCommand("/thinking off"));
    expect(store.getSession("session")?.thinking).toBe("off");

    await bot.handleUpdate(thinkingCommand("/thinking high"));
    expect(store.getSession("session")?.thinking).toBe("off");
    expect(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text)
      .toContain("지원하지 않는 thinking 수준입니다");
  });
});

describe("/new defaults fast path", () => {
  it("creates a session from the current new-session defaults", async () => {
    const { bot, store, sessions } = botSetup();
    // 세션 생성은 즉시 백그라운드 실행을 큐에 넣는다. 테스트에서는 실제 Claude 실행이
    // afterEach의 store.close() 뒤에 비동기로 거부되며 unhandled rejection을 내므로,
    // 실행만 무력화하고 생성·저장 결과만 검증한다.
    vi.spyOn(sessions as unknown as { execute: () => Promise<void> }, "execute")
      .mockResolvedValue();

    await bot.handleUpdate(newCommand());
    await bot.handleUpdate(callbackUpdate("newp:0", 2));
    await bot.handleUpdate(textMessage("작업을 실행해줘", 3, 7777));

    const created = store
      .listSessions(10)
      .find((item) => item.topicId === 7777);
    expect(created?.provider).toBe("claude");
    expect(created?.model).toBe("claude-opus-4-8");
    expect(created?.thinking).toBe("adaptive");
    expect(created?.claudeEffort).toBe("high");
  });

  it("applies Codex defaults when the default provider is Codex", async () => {
    const { bot, store, sessions } = botSetup();
    vi.spyOn(sessions as unknown as { executeCodex: () => Promise<void> }, "executeCodex")
      .mockResolvedValue();
    store.updateSessionDefaults({ provider: "codex" });

    await bot.handleUpdate(newCommand());
    await bot.handleUpdate(callbackUpdate("newp:0", 2));
    await bot.handleUpdate(textMessage("코덱스로 작업", 3, 7777));

    const created = store
      .listSessions(10)
      .find((item) => item.topicId === 7777);
    expect(created?.provider).toBe("codex");
    expect(created?.codexModel).toBe("gpt-5.5");
    expect(created?.codexReasoning).toBe("high");
    expect(created?.codexHome).toBeDefined();
  });

  it("shows Codex token choices from the sixth defaults panel slot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-codex-homes-"));
    rmSync(directory, { recursive: true, force: true });
    const codexHomes = [join(directory, "codex-a"), join(directory, "codex-b")];
    const { bot, store, calls } = botSetup({ codexAccountHomes: codexHomes });
    store.updateSessionDefaults({ provider: "codex", codexHome: codexHomes[0]! });

    await bot.handleUpdate(textMessage("🔑 토큰: #1"));

    expect(store.getSessionDefaults().codexHome).toBe(codexHomes[0]);
    const reply = calls.filter((call) => call.method === "sendMessage").at(-1)?.payload;
    expect(reply?.text).toContain("새 세션 기본 Codex 토큰을 선택하세요");
    expect(JSON.stringify(reply?.reply_markup)).toContain("sett:codex:1");
  });

  it("selects a Codex token from the token choices", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-codex-homes-"));
    rmSync(directory, { recursive: true, force: true });
    const codexHomes = [join(directory, "codex-a"), join(directory, "codex-b")];
    const { bot, store, calls } = botSetup({ codexAccountHomes: codexHomes });
    store.updateSessionDefaults({ provider: "codex", codexHome: codexHomes[0]! });

    await bot.handleUpdate(callbackUpdate("sett:codex:1"));

    expect(store.getSessionDefaults().codexHome).toBe(codexHomes[1]);
    const reply = calls.filter((call) => call.method === "sendMessage").at(-1)?.payload;
    expect(reply?.text).toContain("새 Codex 세션 기본 토큰: #2");
    expect(JSON.stringify(reply?.reply_markup)).toContain("🔑 토큰: #2");
  });

  it("shows Claude token choices from the sixth defaults panel slot", async () => {
    const { bot, store, calls } = botSetup({
      claudeCodeOauthTokens: ["test-oauth-token-a", "test-oauth-token-b"]
    });
    store.updateSessionDefaults({ provider: "claude", claudeTokenIndex: 0 });

    await bot.handleUpdate(textMessage("🔑 토큰: #1"));

    expect(store.getSessionDefaults().claudeTokenIndex).toBe(0);
    const reply = calls.filter((call) => call.method === "sendMessage").at(-1)?.payload;
    expect(reply?.text).toContain("새 세션 기본 Claude 토큰을 선택하세요");
    expect(JSON.stringify(reply?.reply_markup)).toContain("sett:claude:1");
  });

  it("selects a Claude token from the token choices", async () => {
    const { bot, store, calls } = botSetup({
      claudeCodeOauthTokens: ["test-oauth-token-a", "test-oauth-token-b"]
    });
    store.updateSessionDefaults({ provider: "claude", claudeTokenIndex: 0 });

    await bot.handleUpdate(callbackUpdate("sett:claude:1"));

    expect(store.getSessionDefaults().claudeTokenIndex).toBe(1);
    const reply = calls.filter((call) => call.method === "sendMessage").at(-1)?.payload;
    expect(reply?.text).toContain("새 Claude 세션 기본 토큰: #2");
    expect(JSON.stringify(reply?.reply_markup)).toContain("🔑 토큰: #2");
  });

  it("applies agy model and thinking defaults to a new session", async () => {
    const { bot, store, sessions } = botSetup();
    vi.spyOn(sessions as unknown as { executeAgy: () => Promise<void> }, "executeAgy")
      .mockResolvedValue();
    store.updateSessionDefaults({
      provider: "agy",
      agyModel: "gemini-3.5-flash",
      agyThinkingLevel: "high"
    });

    await bot.handleUpdate(newCommand());
    await bot.handleUpdate(callbackUpdate("newp:0", 2));
    await bot.handleUpdate(textMessage("agy로 작업", 3, 7777));

    const created = store
      .listSessions(10)
      .find((item) => item.topicId === 7777);
    expect(created?.provider).toBe("agy");
    expect(created?.agyModel).toBe("gemini-3.5-flash");
    expect(created?.agyThinkingLevel).toBe("high");
  });

  it("asks for the task prompt right after the project is picked", async () => {
    const { bot, calls } = botSetup();

    await bot.handleUpdate(newCommand());
    await bot.handleUpdate(callbackUpdate("newp:0", 2));

    const reply = calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => call.payload)
      .find((payload) => payload.message_thread_id === 7777);
    expect(reply?.text).toContain("실행할 작업을 입력하세요");
    expect(reply?.reply_markup).toBeDefined();
  });
});

describe("/reserve command", () => {
  it("shows project choices when reserve is called without arguments", async () => {
    const { bot, calls } = botSetup();

    await bot.handleUpdate(reserveCommand("/reserve"));

    const reply = calls.filter((call) => call.method === "sendMessage").at(-1)?.payload;
    expect(reply?.text).toBe("예약할 프로젝트를 선택하세요.");
    expect(JSON.stringify(reply?.reply_markup)).toContain("resp:0");
  });

  it("opens a reservation topic after a project is picked", async () => {
    const { bot, calls } = botSetup();

    await bot.handleUpdate(reserveCommand("/reserve"));
    await bot.handleUpdate(callbackUpdate("resp:0", 2));

    expect(calls.some((call) => call.method === "createForumTopic")).toBe(true);
    const topicMessage = calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => call.payload)
      .find((payload) => payload.message_thread_id === 7777);
    expect(topicMessage?.text).toContain("test 예약");
    expect(topicMessage?.text).toContain("이 토픽에 예약할 시간과 작업을 입력하세요");
  });

  it("stores a topic-backed reservation from a message in the reservation topic", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 29, 22, 10, 0, 0));
    try {
      const { bot, store, calls } = botSetup();

      await bot.handleUpdate(reserveCommand("/reserve"));
      await bot.handleUpdate(callbackUpdate("resp:0", 2));
      await bot.handleUpdate(textMessage("내일 오전 9시에 README 점검", 3, 7777));

      const task = store.listPendingReservedTasks()[0];
      expect(task).toMatchObject({
        projectName: "test",
        prompt: "README 점검",
        dueAt: new Date(2026, 5, 30, 9, 0, 0, 0).getTime(),
        topicId: 7777,
        status: "pending"
      });
      expect(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text)
        .toContain("예약했습니다.");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("reuses a reservation topic when the scheduled task starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 29, 22, 10, 0, 0));
    try {
      const { bot, store, sessions, calls } = botSetup();
      vi.spyOn(sessions as unknown as { execute: () => Promise<void> }, "execute")
        .mockResolvedValue();

      await bot.handleUpdate(reserveCommand("/reserve"));
      await bot.handleUpdate(callbackUpdate("resp:0", 2));
      await bot.handleUpdate(textMessage("30분 뒤 테스트 실행", 3, 7777));
      const taskId = store.listPendingReservedTasks()[0]!.id;

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

      const task = store.getReservedTask(taskId);
      expect(task?.status).toBe("done");
      expect(task?.topicId).toBe(7777);
      const created = store.listSessions(10).find((item) => item.id === task?.sessionId);
      expect(created?.topicId).toBe(7777);
      expect(calls.some((call) => call.method === "editForumTopic")).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("stores a pending reserved task using the current defaults", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 29, 22, 10, 0, 0));
    try {
      const { bot, store, calls } = botSetup();
      store.updateSessionDefaults({ provider: "codex" });

      await bot.handleUpdate(reserveCommand("/reserve test 내일 오전 9시 README 점검"));

      const task = store.listPendingReservedTasks()[0];
      expect(task).toMatchObject({
        projectName: "test",
        prompt: "README 점검",
        dueAt: new Date(2026, 5, 30, 9, 0, 0, 0).getTime(),
        status: "pending",
        startOptions: {
          provider: "codex",
          codexModel: "gpt-5.5",
          codexReasoning: "high"
        }
      });
      expect(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text)
        .toContain("예약했습니다.");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("/cancel command", () => {
  it("shows pending reserved tasks as buttons and cancels the selected task", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 29, 22, 10, 0, 0));
    try {
      const { bot, store, calls } = botSetup();
      const task = store.createReservedTask({
        chatId: -1001,
        projectName: "test",
        prompt: "README 점검",
        dueAt: new Date(2026, 5, 30, 9, 0, 0, 0).getTime()
      });

      await bot.handleUpdate(cancelCommand());

      const cancelList = calls.filter((call) => call.method === "sendMessage").at(-1);
      expect(cancelList?.payload.text).toBe("취소할 예약 작업을 선택하세요.");
      expect(JSON.stringify(cancelList?.payload.reply_markup)).toContain(`rescancel:${task.id}`);

      await bot.handleUpdate(callbackUpdate(`rescancel:${task.id}`, 2));

      expect(store.getReservedTask(task.id)?.status).toBe("canceled");
      expect(store.listPendingReservedTasks()).toEqual([]);
      expect(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text)
        .toContain("예약을 취소했습니다.");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("/upload path policy", () => {
  it("resolves relative files from the session project", async () => {
    const { store } = botSetup();
    const session = store.getSession("session")!;
    writeFileSync(join(session.cwd, "report.txt"), "ok");

    await expect(resolveSessionUploadPath(session.cwd, "report.txt"))
      .resolves.toBe(realpathSync(join(session.cwd, "report.txt")));
  });

  it("rejects absolute paths and traversal outside the session project", async () => {
    const { store } = botSetup();
    const session = store.getSession("session")!;
    const outside = mkdtempSync(join(tmpdir(), "telegram-claude-outside-"));
    writeFileSync(join(outside, "secret.txt"), "secret");
    const escapingPath = relative(session.cwd, join(outside, "secret.txt"));

    try {
      await expect(resolveSessionUploadPath(session.cwd, join(outside, "secret.txt")))
        .rejects.toThrow("절대경로");
      await expect(resolveSessionUploadPath(session.cwd, escapingPath))
        .rejects.toThrow("프로젝트 밖");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("agy proceed callback", () => {
  it("resumes the agy session with an explicit approval prompt", async () => {
    const { bot, store, sessions, calls } = botSetup();
    store.updateSession("session", {
      provider: "agy",
      agyConversationId: "agy-conversation"
    });
    const resume = vi.spyOn(sessions, "resume").mockReturnValue(true);

    await bot.handleUpdate(callbackUpdate("agygo:session"));

    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session", provider: "agy" }),
      "승인합니다. 제시한 계획대로 계속 진행하십시오."
    );
    expect(calls.some((call) => call.method === "editMessageReplyMarkup")).toBe(true);
  });
});

describe("/goal command", () => {
  it("reports no active goal without an argument", async () => {
    const { bot, calls } = botSetup();

    await bot.handleUpdate(goalCommand("/goal"));

    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("설정된 목표가 없습니다");
  });

  it("clears an existing goal", async () => {
    const { bot, store, calls } = botSetup();
    store.updateSession("session", { goalCondition: "모든 테스트 통과" });

    await bot.handleUpdate(goalCommand("/goal clear"));

    expect(store.getSession("session")?.goalCondition).toBeNull();
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("목표를 해제했습니다");
  });

  it("wires a new goal condition into the session manager", async () => {
    const { bot, sessions, calls } = botSetup();
    const setGoal = vi.spyOn(sessions, "setGoal").mockReturnValue("active");

    await bot.handleUpdate(goalCommand("/goal 모든 테스트가 통과한다"));

    expect(setGoal).toHaveBeenCalledWith("session", "모든 테스트가 통과한다");
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("끝나면 달성 여부를 평가");
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

  it("shows the current provider/model and a model keyboard without an argument", async () => {
    const { bot, calls } = botSetup();

    await bot.handleUpdate(modelCommand("/model"));

    const messages = calls.filter((call) => call.method === "sendMessage").map((call) => call.payload);
    expect(messages[0]?.text).toContain("현재: Claude · Opus 4.8");
    expect(messages.some((payload) => {
      try {
        return JSON.stringify(payload.reply_markup) === JSON.stringify(modelKeyboard());
      } catch {
        return false;
      }
    })).toBe(true);
  });
});

describe("/usage command", () => {
  it("fetches a live Claude usage snapshot before using cached data", async () => {
    const { bot, sessions, calls } = botSetup();
    vi.spyOn(sessions, "fetchCurrentUsageSnapshots").mockResolvedValue([
      {
        tokenIndex: 1,
        snapshot: {
          capturedAt: Date.parse("2026-06-16T02:20:00.000Z"),
          subscriptionType: "pro",
          rateLimitsAvailable: true,
          fiveHour: { utilization: 42, resetsAt: null }
        },
        error: null
      },
      {
        tokenIndex: 2,
        snapshot: {
          capturedAt: Date.parse("2026-06-16T02:21:00.000Z"),
          subscriptionType: "pro",
          rateLimitsAvailable: true,
          fiveHour: { utilization: 10, resetsAt: null }
        },
        error: null
      }
    ]);

    await bot.handleUpdate(usageCommand());

    const reply = calls.find((call) => call.method === "sendMessage")?.payload.text;
    expect(reply).toContain("토큰 #1");
    expect(reply).toContain("5시간 한도: 42% 사용");
    expect(reply).toContain("토큰 #2");
    expect(reply).toContain("5시간 한도: 10% 사용");
    expect(reply).toContain("원천: Claude 서버 실시간 조회");
    expect(reply).toContain("Codex 사용량");
    expect(reply).toContain("Codex 계정 #1: 사용 가능");
  });

  it("explains when the live OAuth session lacks rate-limit data", async () => {
    const { bot, sessions, calls } = botSetup();
    vi.spyOn(sessions, "fetchCurrentUsageSnapshots").mockResolvedValue([
      {
        tokenIndex: 1,
        snapshot: {
          capturedAt: Date.parse("2026-06-16T02:20:00.000Z"),
          subscriptionType: null,
          rateLimitsAvailable: false
        },
        error: null
      }
    ]);

    await bot.handleUpdate(usageCommand());

    const reply = calls.find((call) => call.method === "sendMessage")?.payload.text;
    expect(reply).toContain("Claude 서버가 현재 OAuth 토큰에 대해 한도 창");
    expect(reply).toContain("claude setup-token");
    expect(reply).toContain("Codex 사용량");
  });
});
