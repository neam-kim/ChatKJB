import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBot, formatSessionStatus, modelKeyboard } from "../src/bot.js";
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
    codexAccountHomes: [join(directory, "codex-home")],
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

function textMessage(text: string, updateId = 1) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      message_thread_id: 42,
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
    await bot.handleUpdate(textMessage("작업을 실행해줘", 3));

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
    await bot.handleUpdate(textMessage("코덱스로 작업", 3));

    const created = store
      .listSessions(10)
      .find((item) => item.topicId === 7777);
    expect(created?.provider).toBe("codex");
    expect(created?.codexModel).toBe("gpt-5.5");
    expect(created?.codexReasoning).toBe("high");
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
    await bot.handleUpdate(textMessage("agy로 작업", 3));

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

    const reply = calls.filter((call) => call.method === "sendMessage").at(-1)?.payload;
    expect(reply?.text).toContain("실행할 작업을 입력하세요");
    expect(reply?.reply_markup).toBeDefined();
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
  });
});
