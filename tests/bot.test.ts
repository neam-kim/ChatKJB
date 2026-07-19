import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotRuntimeDependencies } from "../src/bot.js";
import {
  createBot,
  displayDriveLabel,
  formatSessionStatus,
  modelKeyboard,
  parseReserveCommand,
  parseReserveTime,
  resolveSessionUploadPath
} from "../src/bot.js";
import { resetAdvisoryRuntimeStateForTests } from "../src/bot/handlers/advisory.js";
import type { AppConfig } from "../src/config.js";
import { FALLBACK_MODEL_CATALOG } from "../src/model-catalog.js";
import { StateStore } from "../src/store.js";
import type { TopicDeletionSource } from "../src/telegram-topic-deletion.js";
import type { SessionRecord } from "../src/types.js";

const cleanup: Array<{ store: StateStore; directory: string; dispose: () => void; }> = [];
const originalFolderBrowserRoot = process.env.CHATKJB_FOLDER_BROWSER_ROOT;
const originalKjbWikiPostCompileScript = process.env.KJB_WIKI_POST_COMPILE_SCRIPT;
const originalKjbWikiTestMarker = process.env.KJB_WIKI_TEST_MARKER;
const originalWikiVault = process.env.WIKI_VAULT;

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
    grokUsage: null,
    handoffSummary: null,
    goalCondition: null,
    leanMode: true,
    usageSnapshot: null,
    createdAt: 0,
    updatedAt: 0
  };
}

function botSetup(extra?: {
  claudeCodeOauthTokens?: string[];
  codexAccountHomes?: string[];
  availableProviders?: Array<"claude" | "codex" | "agy" | "grok">;
  allowedUserIds?: number[];
  failSessionStartNotification?: boolean;
  /** sendMessage 본문이 이 조건을 만족하면 Telegram 길이 초과처럼 거부한다. */
  failSendMessageWhen?: (text: string) => boolean;
  telegramMtproto?: AppConfig["telegramMtproto"];
  runtime?: BotRuntimeDependencies;
}) {
  const directory = mkdtempSync(join(tmpdir(), "telegram-claude-bot-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  const project = { name: "test", cwd: directory, defaultMode: "default" as const };
  store.syncProjects([project]);
  store.createSession({ ...session("done"), cwd: directory });
  const codexAccountHomes = extra?.codexAccountHomes ?? [join(directory, "codex-home")];
  const claudeCodeOauthTokens = extra?.claudeCodeOauthTokens ?? ["test-oauth-token"];
  const availableProviders = extra?.availableProviders ?? ["claude", "codex", "agy", "grok"];
  const allowedUserIds = extra?.allowedUserIds ?? [7];
  const config = {
    telegramBotToken: "123456789:test-token",
    allowedUserId: allowedUserIds[0]!,
    allowedUserIds,
    chatId: -1001,
    telegramIpFamily: "auto",
    telegramMtproto: extra?.telegramMtproto ?? null,
    claudeCodeOauthToken: claudeCodeOauthTokens[0],
    claudeCodeOauthTokens,
    codexAccountHomes,
    availableProviders,
    defaultProvider: availableProviders[0]!,
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
    providerTurnTimeoutMs: undefined,
    codexTransientStreamRetries: 3,
    codexMcpHeartbeatMs: 10_000,
    longRunningMcpServers: new Set(["codex"]),
    turnIdleTimeoutMs: 120_000,
    claudeCodeExecutable: "claude",
    codexExecutable: "codex",
    agyExecutable: "agy",
    grokExecutable: "grok",
    grokModel: undefined,
    agyMcpServers: ["llm-wiki"],
    stt: {
      enabled: false,
      whisperCli: "whisper-cli",
      ffmpeg: "ffmpeg",
      modelPath: join(directory, "whisper-model.bin"),
      language: "ko",
      prompt: "",
      threads: 4,
      timeoutMs: 60_000
    }
  } satisfies AppConfig;
  const instance = createBot(config, store, {
    projectCatalogRoots: async () => [directory],
    ...extra?.runtime
  });
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
  const calls: Array<{ method: string; payload: Record<string, unknown>; }> = [];
  instance.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (
      extra?.failSessionStartNotification
      && method === "sendMessage"
      && String((payload as { text?: string; }).text ?? "").startsWith("세션을 시작했습니다.")
    ) {
      throw new Error("fixture session notification failure");
    }
    if (method === "sendMessage" && extra?.failSendMessageWhen) {
      const text = String((payload as { text?: string; }).text ?? "");
      if (extra.failSendMessageWhen(text)) {
        const err = new Error(
          "GrammyError: Call to 'sendMessage' failed! (400: Bad Request: message is too long)"
        ) as Error & { error_code: number; description: string; };
        err.error_code = 400;
        err.description = "Bad Request: message is too long";
        throw err;
      }
    }
    let result: unknown = true;
    if (method === "sendMessage") {
      result = {
        message_id: calls.length,
        date: 0,
        chat: { id: -1001, type: "supergroup", title: "Test" },
        text: String((payload as { text?: string; }).text ?? "")
      };
    } else if (method === "createForumTopic") {
      result = { message_thread_id: 7777, name: "topic", icon_color: 0 };
    }
    return { ok: true, result } as never;
  });
  cleanup.push({ store, directory, dispose: instance.dispose });
  return { ...instance, config, store, calls };
}

class FakeTopicDeletionSource implements TopicDeletionSource {
  private handler: ((topicIds: readonly number[]) => Promise<void>) | null = null;

  async start(handler: (topicIds: readonly number[]) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async findDeletedTopicIds(): Promise<number[]> {
    return [];
  }

  async emit(topicIds: readonly number[]): Promise<void> {
    await this.handler?.(topicIds);
  }

  async stop(): Promise<void> {
    this.handler = null;
  }
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

function providerCommand(updateId = 1) {
  return {
    ...modelCommand("/provider", updateId),
    message: {
      ...modelCommand("/provider", updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 9 }]
    }
  };
}

function newCommand(updateId = 1, text = "/new") {
  return {
    ...modelCommand(text, updateId),
    message: {
      ...modelCommand(text, updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 4 }]
    }
  };
}

function catalogSelectionForPath(prompt: string, path: string): string {
  const canonical = realpathSync(path);
  const row = prompt.split("\n").find((line) => line.includes(`\`${canonical}\``));
  const projectId = row?.match(/`(project-[a-f0-9]+)`/u)?.[1];
  if (!projectId) throw new Error(`catalog row not found for ${canonical}`);
  return JSON.stringify({ projectId, reason: "task match" });
}

function firstProviderCommand(updateId = 1) {
  return {
    ...modelCommand("/firstp", updateId),
    message: {
      ...modelCommand("/firstp", updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 7 }]
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

function compileCommand(text = "/compile", updateId = 1) {
  return {
    ...modelCommand(text, updateId),
    message: {
      ...modelCommand(text, updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 8 }]
    }
  };
}

function queryCommand(text: string, updateId = 1) {
  return {
    ...modelCommand(text, updateId),
    message: {
      ...modelCommand(text, updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 6 }]
    }
  };
}

function shotgunCommand(text = "/shotgun", updateId = 1) {
  return {
    ...modelCommand(text, updateId),
    message: {
      ...modelCommand(text, updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 8 }]
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

function textMessage(text: string, updateId = 1, topicId = 42, userId = 7) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      message_thread_id: topicId,
      chat: { id: -1001, type: "supergroup" as const, title: "Test" },
      from: { id: userId, is_bot: false, first_name: "User" },
      text
    }
  };
}

function workflowCommand(text: string, updateId = 1, topicId = 42, userId = 7) {
  const commandLength = text.split(/\s/, 1)[0]!.length;
  return {
    ...textMessage(text, updateId, topicId, userId),
    message: {
      ...textMessage(text, updateId, topicId, userId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: commandLength }]
    }
  };
}

function documentMessage(updateId = 1, topicId = 42) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      message_thread_id: topicId,
      chat: { id: -1001, type: "supergroup" as const, title: "Test" },
      from: { id: 7, is_bot: false, first_name: "User" },
      document: {
        file_id: "file-1",
        file_unique_id: "unique-1",
        file_name: "report.txt"
      },
      caption: "보고서 확인"
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

function goalCommand(text: string, updateId = 1, topicId = 42) {
  return {
    ...textMessage(text, updateId, topicId),
    message: {
      ...textMessage(text, updateId, topicId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 5 }]
    }
  };
}

function restopCommand(updateId = 1) {
  return {
    ...modelCommand("/restop", updateId),
    message: {
      ...modelCommand("/restop", updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 7 }]
    }
  };
}

function resumeCommand(updateId = 1) {
  return {
    ...modelCommand("/resume", updateId),
    message: {
      ...modelCommand("/resume", updateId).message,
      entities: [{ type: "bot_command" as const, offset: 0, length: 7 }]
    }
  };
}

function forkCommand(updateId = 1) {
  return {
    ...modelCommand("/fork", updateId),
    message: {
      ...modelCommand("/fork", updateId).message,
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

afterEach(async () => {
  vi.restoreAllMocks();
  resetAdvisoryRuntimeStateForTests();
  if (originalFolderBrowserRoot === undefined) {
    delete process.env.CHATKJB_FOLDER_BROWSER_ROOT;
  } else {
    process.env.CHATKJB_FOLDER_BROWSER_ROOT = originalFolderBrowserRoot;
  }
  if (originalKjbWikiPostCompileScript === undefined) {
    delete process.env.KJB_WIKI_POST_COMPILE_SCRIPT;
  } else {
    process.env.KJB_WIKI_POST_COMPILE_SCRIPT = originalKjbWikiPostCompileScript;
  }
  if (originalKjbWikiTestMarker === undefined) {
    delete process.env.KJB_WIKI_TEST_MARKER;
  } else {
    process.env.KJB_WIKI_TEST_MARKER = originalKjbWikiTestMarker;
  }
  if (originalWikiVault === undefined) {
    delete process.env.WIKI_VAULT;
  } else {
    process.env.WIKI_VAULT = originalWikiVault;
  }
  for (const item of cleanup.splice(0)) {
    await item.dispose();
    item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

describe("bot shutdown", () => {
  it("settles sessions before disposing the project catalog", async () => {
    const { dispose, sessions, projectCatalog } = botSetup();
    const order: string[] = [];
    const disposeSessions = sessions.dispose.bind(sessions);
    const disposeCatalog = projectCatalog.dispose.bind(projectCatalog);
    vi.spyOn(sessions, "dispose").mockImplementation(async () => {
      order.push("sessions");
      await disposeSessions();
    });
    vi.spyOn(projectCatalog, "dispose").mockImplementation(async () => {
      order.push("catalog");
      await disposeCatalog();
    });

    await dispose();
    expect(order).toEqual(["sessions", "catalog"]);
  });
});

describe("/catbot command", () => {
  it("refreshes the project catalog immediately and reports the project count", async () => {
    const { bot, calls, config } = botSetup();
    const discovered = join(config.projects[0]!.cwd, "discovered");
    mkdirSync(discovered);
    writeFileSync(join(discovered, "README.md"), "# Discovered\n\nManual catalog refresh test.");

    await bot.handleUpdate(workflowCommand("/catbot"));

    const reply = calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text;
    expect(reply).toContain("프로젝트 카탈로그를 갱신했습니다.");
    expect(reply).toContain("확인된 프로젝트: 2개");
    expect(readFileSync(join(config.projects[0]!.cwd, "project-catalog.md"), "utf8"))
      .toContain("Manual catalog refresh test.");
  });
});

describe("reserve command parsing", () => {
  it("parses reserve time expressions without a project prefix", () => {
    const now = new Date(2026, 5, 29, 22, 10, 0, 0);
    expect(parseReserveTime("2시간 뒤 테스트 실행", now)).toEqual({
      dueAt: new Date(2026, 5, 30, 0, 10, 0, 0).getTime(),
      prompt: "테스트 실행"
    });
    expect(parseReserveTime("2026-06-30 09:00 README 점검", now)).toEqual({
      dueAt: new Date(2026, 5, 30, 9, 0, 0, 0).getTime(),
      prompt: "README 점검"
    });
    expect(parseReserveTime("오늘 오후 3시 회의 정리", now)).toEqual({
      dueAt: new Date(2026, 5, 29, 15, 0, 0, 0).getTime(),
      prompt: "회의 정리"
    });
  });

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

  it("persists supported Grok reasoning through the unified command", async () => {
    const { bot, config, store } = botSetup();
    config.modelCatalog = { ...FALLBACK_MODEL_CATALOG, grokReasoningEfforts: ["high", "xhigh"] };
    store.updateSession("session", { provider: "grok" });

    await bot.handleUpdate(modelCommand("/power xhigh"));

    expect(store.getSession("session")?.grokReasoning).toBe("xhigh");
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

describe("/shotgun command", () => {
  it("starts a provider-neutral apology and re-review turn for an idle session", async () => {
    const { bot, sessions, calls } = botSetup();
    const resume = vi.spyOn(sessions, "resume").mockReturnValue(true);

    await bot.handleUpdate(shotgunCommand("/shotgun 테스트 누락"));

    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session", provider: "claude" }),
      expect.stringContaining("[SHOTGUN_REVIEW]")
    );
    const prompt = String(resume.mock.calls[0]?.[1] ?? "");
    expect(prompt).toContain("죄송합니다.");
    expect(prompt).toContain("테스트 누락");
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("Shotgun 재검토를 시작했습니다");
  });

  it("steers an active Codex turn so re-review takes priority", async () => {
    const { bot, sessions, store, calls } = botSetup();
    store.updateSession("session", { provider: "codex", codexThreadId: "thread-1" });
    vi.spyOn(sessions, "isActive").mockReturnValue(true);
    const steer = vi.spyOn(sessions, "steer").mockReturnValue("restarted");

    await bot.handleUpdate(shotgunCommand());

    expect(steer).toHaveBeenCalledWith("session", expect.stringContaining("[SHOTGUN_REVIEW]"));
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("현재 Codex 턴을 중단");
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
  it("hides account identifiers from cloud drive labels", () => {
    expect(displayDriveLabel("SynologyDrive-account")).toBe("SynologyDrive");
    expect(displayDriveLabel("GoogleDrive-user@example.com")).toBe("GoogleDrive");
    expect(displayDriveLabel("OneDrive Personal Account")).toBe("OneDrive");
    expect(displayDriveLabel("Team Share")).toBe("Team Share");
  });

  it("opens a generic topic and auto-selects a catalog project from the first task", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-auto-project-"));
    const projectDir = join(root, "Docs Project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, ".chatkjb-project.md"), "# Docs\n\nMaintains product documentation.");
    const runProjectSelector = vi.fn(async (prompt: string) =>
      catalogSelectionForPath(prompt, projectDir)
    );
    try {
      const { bot, store, sessions, calls } = botSetup({
        runtime: {
          projectCatalogRoots: async () => [root],
          runProjectSelector
        }
      });
      vi.spyOn(sessions as unknown as { execute: () => Promise<void>; }, "execute")
        .mockResolvedValue();

      await bot.handleUpdate(newCommand());
      await bot.handleUpdate(textMessage("제품 문서를 정리해줘", 2, 7777));

      const created = store.listSessions(10).find((item) => item.topicId === 7777);
      expect(created?.cwd).toBe(realpathSync(projectDir));
      expect(created?.projectName).toBe("Docs Project");
      expect(runProjectSelector).toHaveBeenCalledOnce();
      expect(runProjectSelector.mock.calls[0]?.[0]).toContain("제품 문서를 정리해줘");
      expect(calls.filter((call) => call.method === "createForumTopic")).toHaveLength(1);
      expect(calls.some((call) => call.method === "editForumTopic")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the catalog's canonical cwd when a stored project uses a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-auto-project-"));
    const projectDir = join(root, "Canonical Project");
    const linkedDir = join(root, "linked-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "README.md"), "# Canonical\n\nCanonical project.");
    symlinkSync(projectDir, linkedDir, "dir");
    const runProjectSelector = vi.fn(async (prompt: string) =>
      catalogSelectionForPath(prompt, projectDir)
    );
    try {
      const { bot, store, sessions } = botSetup({
        runtime: {
          projectCatalogRoots: async () => [root],
          runProjectSelector
        }
      });
      store.syncProjects([{ name: "Linked Project", cwd: linkedDir, defaultMode: "default" }]);
      vi.spyOn(sessions as unknown as { execute: () => Promise<void>; }, "execute")
        .mockResolvedValue();

      await bot.handleUpdate(newCommand());
      await bot.handleUpdate(textMessage("canonical 작업", 2, 7777));

      const created = store.listSessions(10).find((item) => item.topicId === 7777);
      expect(created?.projectName).toBe("Linked Project");
      expect(created?.cwd).toBe(realpathSync(projectDir));
      expect(store.listProjects().find((project) => project.name === "Linked Project")?.cwd)
        .toBe(realpathSync(projectDir));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the generic topic pending when the selector does not return a catalog id", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-auto-project-"));
    const projectDir = join(root, "Other Project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ description: "Other work" }));
    const runProjectSelector = vi.fn(async () => '{"path":"/tmp/forged"}');
    try {
      const { bot, store, calls } = botSetup({
        runtime: {
          projectCatalogRoots: async () => [root],
          runProjectSelector
        }
      });

      await bot.handleUpdate(newCommand());
      await bot.handleUpdate(textMessage("첫 시도", 2, 7777));
      await bot.handleUpdate(textMessage("두 번째 시도", 3, 7777));

      expect(store.listSessions(10).some((item) => item.topicId === 7777)).toBe(false);
      expect(runProjectSelector).toHaveBeenCalledTimes(2);
      expect(calls.filter((call) => call.method === "createForumTopic")).toHaveLength(1);
      expect(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text)
        .toContain("이 작업 토픽은 유지");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("claims a pending topic before awaiting selection so concurrent first inputs cannot duplicate sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-auto-project-"));
    const projectDir = join(root, "Concurrent Project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "README.md"), "# Concurrent\n\nConcurrent work.");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runProjectSelector = vi.fn(async (prompt: string) => {
      await gate;
      return catalogSelectionForPath(prompt, projectDir);
    });
    try {
      const { bot, store, sessions } = botSetup({
        runtime: {
          projectCatalogRoots: async () => [root],
          runProjectSelector
        }
      });
      vi.spyOn(sessions as unknown as { execute: () => Promise<void>; }, "execute")
        .mockResolvedValue();

      await bot.handleUpdate(newCommand());
      const first = bot.handleUpdate(textMessage("첫 입력", 2, 7777));
      await vi.waitFor(() => expect(runProjectSelector).toHaveBeenCalledOnce());
      await bot.handleUpdate(textMessage("동시 두 번째 입력", 3, 7777));
      release();
      await first;

      expect(runProjectSelector).toHaveBeenCalledOnce();
      expect(store.listSessions(20).filter((item) => item.topicId === 7777)).toHaveLength(1);
    } finally {
      release?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("auto-selects a project when an attachment is the first task input", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-auto-project-"));
    const projectDir = join(root, "Reports");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "README.md"), "# Reports\n\nProcesses reports.");
    const runProjectSelector = vi.fn(async (prompt: string) =>
      catalogSelectionForPath(prompt, projectDir)
    );
    try {
      const { bot, store, sessions } = botSetup({
        runtime: {
          downloadFile: async () => "/tmp/report.txt",
          projectCatalogRoots: async () => [root],
          runProjectSelector
        }
      });
      vi.spyOn(sessions as unknown as { execute: () => Promise<void>; }, "execute")
        .mockResolvedValue();

      await bot.handleUpdate(newCommand());
      await bot.handleUpdate(documentMessage(2, 7777));

      expect(store.listSessions(10).find((item) => item.topicId === 7777)?.cwd)
        .toBe(realpathSync(projectDir));
      expect(runProjectSelector.mock.calls[0]?.[0]).toContain("report.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows a dynamic drive picker when no folder-browser root override is set", async () => {
    delete process.env.CHATKJB_FOLDER_BROWSER_ROOT;
    const { bot, calls } = botSetup();

    await bot.handleUpdate(newCommand(1, "/new browse"));

    const browserMessage = calls.filter((call) => call.method === "sendMessage").at(-1)?.payload;
    expect(browserMessage?.text).toContain("드라이브를 선택하세요");
    const keyboard = browserMessage?.reply_markup as
      | { inline_keyboard?: Array<Array<{ text: string; callback_data: string; }>>; }
      | undefined;
    const buttons = keyboard?.inline_keyboard?.flat() ?? [];
    expect(buttons.some((button) => button.callback_data.startsWith("newfs:d:"))).toBe(true);
    expect(buttons.some((button) => button.text === "홈")).toBe(true);
  });

  it("browses folder-root override folders and starts a session without writing projects.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-folder-browser-"));
    const projectDir = join(root, "Alpha Project");
    mkdirSync(projectDir);
    process.env.CHATKJB_FOLDER_BROWSER_ROOT = root;
    const { bot, config, store, sessions, calls } = botSetup();
    vi.spyOn(sessions as unknown as { execute: () => Promise<void>; }, "execute")
      .mockResolvedValue();

    await bot.handleUpdate(newCommand(1, "/new browse"));

    const browserMessage = calls.filter((call) => call.method === "sendMessage").at(-1)?.payload;
    expect(browserMessage?.text).toContain("폴더를 선택하세요");
    expect(browserMessage?.text).not.toContain(root);
    expect(JSON.stringify(browserMessage?.reply_markup)).toContain("Alpha Project");
    expect(JSON.stringify(browserMessage?.reply_markup)).toContain("newfs:o:0");

    await bot.handleUpdate(callbackUpdate("newfs:o:0", 2));
    const childBrowserMessage = calls.filter((call) => call.method === "editMessageText").at(-1)?.payload;
    const childKeyboard = childBrowserMessage?.reply_markup as
      | { inline_keyboard?: Array<Array<{ text: string; callback_data: string; }>>; }
      | undefined;
    expect(childKeyboard?.inline_keyboard?.map((row) => row[0]?.text).filter(Boolean)).toEqual([
      "이 폴더 선택",
      "뒤로"
    ]);
    expect(childBrowserMessage?.text).toContain("Alpha Project");
    expect(childBrowserMessage?.text).not.toContain(root);

    await bot.handleUpdate(callbackUpdate("newfs:s", 3));
    const selectedMessage = calls.filter((call) => call.method === "editMessageText").at(-1)?.payload;
    expect(selectedMessage?.text).toBe("Alpha Project 작업 토픽을 열었습니다.");
    expect(selectedMessage?.text).not.toContain(projectDir);
    await bot.handleUpdate(textMessage("선택 폴더에서 작업", 4, 7777));

    const created = store
      .listSessions(10)
      .find((item) => item.topicId === 7777);
    expect(created?.projectName).toBe("Alpha Project");
    expect(created?.cwd).toBe(realpathSync(projectDir));
    expect(existsSync(config.projectsPath)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("reuses a configured project when its display name differs from the folder name", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-folder-browser-"));
    const projectDir = join(root, "LLM-Wiki");
    mkdirSync(projectDir);
    process.env.CHATKJB_FOLDER_BROWSER_ROOT = root;
    const { bot, config, store, sessions } = botSetup();
    const project = {
      name: "LLM Wiki",
      cwd: realpathSync(projectDir),
      defaultMode: "default" as const
    };
    config.projects.push(project);
    store.syncProjects([project]);
    vi.spyOn(sessions as unknown as { execute: () => Promise<void>; }, "execute")
      .mockResolvedValue();

    await bot.handleUpdate(newCommand(1, "/new browse"));
    await bot.handleUpdate(callbackUpdate("newfs:o:0", 2));
    await bot.handleUpdate(callbackUpdate("newfs:s", 3));
    await bot.handleUpdate(textMessage("위키 폴더 작업", 4, 7777));

    const created = store
      .listSessions(10)
      .find((item) => item.topicId === 7777);
    expect(created?.projectName).toBe("LLM Wiki");
    expect(created?.cwd).toBe(realpathSync(projectDir));
    expect(store.getProjectByCwd(realpathSync(projectDir))?.name).toBe("LLM Wiki");
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a session from the current new-session defaults", async () => {
    const { bot, store, sessions } = botSetup();
    // 세션 생성은 즉시 백그라운드 실행을 큐에 넣는다. 테스트에서는 실제 Claude 실행이
    // afterEach의 store.close() 뒤에 비동기로 거부되며 unhandled rejection을 내므로,
    // 실행만 무력화하고 생성·저장 결과만 검증한다.
    vi.spyOn(sessions as unknown as { execute: () => Promise<void>; }, "execute")
      .mockResolvedValue();

    await bot.handleUpdate(newCommand());
    await bot.handleUpdate(textMessage("작업을 실행해줘", 3, 7777));

    const created = store
      .listSessions(10)
      .find((item) => item.topicId === 7777);
    expect(created?.provider).toBe("claude");
    expect(created?.model).toBe("claude-opus-4-8");
    expect(created?.thinking).toBe("adaptive");
    expect(created?.claudeEffort).toBe("high");
  });

  it("reuses the pending topic when a document is the first session input", async () => {
    const downloadFile = vi.fn(async () => "/tmp/report.txt");
    const { bot, store, sessions, calls } = botSetup({
      runtime: { downloadFile }
    });
    const createSession = vi.spyOn(sessions, "createSession");
    vi.spyOn(sessions as unknown as { execute: () => Promise<void>; }, "execute")
      .mockResolvedValue();

    await bot.handleUpdate(newCommand(1, "/new test"));
    await bot.handleUpdate(documentMessage(3, 7777));

    expect(downloadFile).toHaveBeenCalledWith("file-1", "report.txt");
    expect(calls.filter((call) => call.method === "createForumTopic")).toHaveLength(1);
    expect(calls.some((call) => call.method === "editForumTopic")).toBe(true);
    const created = store.listSessions(10).find((item) => item.topicId === 7777);
    expect(createSession.mock.calls[0]?.[4]).toContain("저장 경로: /tmp/report.txt");
    expect(created?.title).toContain("보고서 확인");
  });

  it("applies Codex defaults when the default provider is Codex", async () => {
    const { bot, store, sessions } = botSetup();
    vi.spyOn(sessions as unknown as { executeCodex: () => Promise<void>; }, "executeCodex")
      .mockResolvedValue();
    store.updateSessionDefaults({ provider: "codex" });

    await bot.handleUpdate(newCommand(1, "/new test"));
    await bot.handleUpdate(textMessage("코덱스로 작업", 3, 7777));

    const created = store
      .listSessions(10)
      .find((item) => item.topicId === 7777);
    expect(created?.provider).toBe("codex");
    expect(created?.codexModel).toBe("gpt-5.5");
    expect(created?.codexReasoning).toBe("high");
    expect(created?.codexHome).toBeDefined();
  });

  it("uses /firstp to choose only from authenticated providers", async () => {
    const { bot, store, calls } = botSetup({
      claudeCodeOauthTokens: [],
      availableProviders: ["codex", "grok"]
    });

    expect(store.getSessionDefaults().provider).toBe("codex");
    await bot.handleUpdate(firstProviderCommand());
    const picker = calls.filter((call) => call.method === "sendMessage").at(-1)?.payload;
    const markup = JSON.stringify(picker?.reply_markup);
    expect(markup).toContain("dprov:codex");
    expect(markup).toContain("dprov:grok");
    expect(markup).not.toContain("dprov:claude");
    expect(markup).not.toContain("dprov:agy");

    await bot.handleUpdate(callbackUpdate("dprov:grok", 2));
    expect(store.getSessionDefaults().provider).toBe("grok");

    await bot.handleUpdate(callbackUpdate("dprov:claude", 3));
    expect(store.getSessionDefaults().provider).toBe("grok");
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
    vi.spyOn(sessions as unknown as { executeAgy: () => Promise<void>; }, "executeAgy")
      .mockResolvedValue();
    store.updateSessionDefaults({
      provider: "agy",
      agyModel: "gemini-3.5-flash",
      agyThinkingLevel: "high"
    });

    await bot.handleUpdate(newCommand(1, "/new test"));
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

    await bot.handleUpdate(newCommand(1, "/new test"));

    const reply = calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => call.payload)
      .find((payload) => payload.message_thread_id === 7777);
    expect(reply?.text).toContain("실행할 작업을 입력하세요");
    expect(reply?.text).not.toContain("아래 패널");
    expect(reply?.reply_markup).toEqual({ remove_keyboard: true });
  });
});

describe("/reserve command", () => {
  it("auto-selects from the task-only portion entered in a generic reservation topic", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 29, 22, 10, 0, 0));
    const root = mkdtempSync(join(tmpdir(), "telegram-auto-reserve-"));
    const projectDir = join(root, "Docs Reserve");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "README.md"), "# Docs\n\nDocumentation maintenance.");
    const runProjectSelector = vi.fn(async (prompt: string) =>
      catalogSelectionForPath(prompt, projectDir)
    );
    try {
      const { bot, store, sessions } = botSetup({
        runtime: {
          projectCatalogRoots: async () => [root],
          runProjectSelector
        }
      });
      vi.spyOn(sessions as unknown as { execute: () => Promise<void>; }, "execute")
        .mockResolvedValue();

      await bot.handleUpdate(reserveCommand("/reserve"));
      await bot.handleUpdate(textMessage("내일 오전 9시에 README 점검", 2, 7777));

      const task = store.listPendingReservedTasks()[0];
      expect(task).toMatchObject({
        projectName: "Docs Reserve",
        prompt: "README 점검",
        topicId: 7777
      });
      const selectorPrompt = runProjectSelector.mock.calls[0]?.[0] ?? "";
      expect(selectorPrompt).toContain("사용자 작업:\nREADME 점검");
      expect(selectorPrompt).not.toContain("내일 오전 9시");

      await vi.advanceTimersByTimeAsync(task!.dueAt - Date.now());
      const completed = store.getReservedTask(task!.id);
      expect(completed?.status).toBe("done");
      expect(store.getSession(completed!.sessionId!)?.cwd).toBe(realpathSync(projectDir));
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores the reservation topic when task persistence fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 29, 22, 10, 0, 0));
    const { bot, store, calls } = botSetup();
    vi.spyOn(store, "createReservedTask")
      .mockImplementationOnce(() => { throw new Error("database is readonly"); });
    try {
      await bot.handleUpdate(reserveCommand("/reserve test"));
      await bot.handleUpdate(textMessage("30분 뒤 테스트 실행", 2, 7777));

      expect(store.listPendingReservedTasks()).toHaveLength(0);
      expect(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text)
        .toContain("이 예약 토픽은 유지");

      await bot.handleUpdate(textMessage("30분 뒤 테스트 재실행", 3, 7777));
      expect(store.listPendingReservedTasks()).toHaveLength(1);
      expect(store.listPendingReservedTasks()[0]?.prompt).toBe("테스트 재실행");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("marks a partially persisted reservation as error before allowing a retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 29, 22, 10, 0, 0));
    const { bot, store, calls } = botSetup();
    try {
      await bot.handleUpdate(reserveCommand("/reserve test"));
      vi.spyOn(globalThis, "setTimeout")
        .mockImplementationOnce(() => { throw new Error("timer registration failed"); });
      await bot.handleUpdate(textMessage("30분 뒤 첫 실행", 2, 7777));

      const failed = store.listRecentReservedTasks().find((task) => task.prompt === "첫 실행");
      expect(failed?.status).toBe("error");
      expect(failed?.errorMessage).toContain("timer registration failed");
      expect(store.listPendingReservedTasks()).toHaveLength(0);
      expect(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text)
        .toContain("다시 시도하실 수 있습니다");

      await bot.handleUpdate(textMessage("30분 뒤 재시도 실행", 3, 7777));
      expect(store.listPendingReservedTasks()).toHaveLength(1);
      expect(store.listPendingReservedTasks()[0]?.prompt).toBe("재시도 실행");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("shows folder choices when reserve is called without arguments", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-folder-browser-"));
    mkdirSync(join(root, "Reserve Project"));
    process.env.CHATKJB_FOLDER_BROWSER_ROOT = root;
    const { bot, calls } = botSetup();

    try {
      await bot.handleUpdate(reserveCommand("/reserve browse"));

      const reply = calls.filter((call) => call.method === "sendMessage").at(-1)?.payload;
      expect(reply?.text).toContain("폴더를 선택하세요.");
      expect(reply?.text).not.toContain(root);
      expect(JSON.stringify(reply?.reply_markup)).toContain("resfs:s");
      expect(JSON.stringify(reply?.reply_markup)).toContain("resfs:o:0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("opens a reservation topic after a folder is picked", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-folder-browser-"));
    mkdirSync(join(root, "Reserve Project"));
    process.env.CHATKJB_FOLDER_BROWSER_ROOT = root;
    const { bot, calls } = botSetup();

    try {
      await bot.handleUpdate(reserveCommand("/reserve browse"));
      await bot.handleUpdate(callbackUpdate("resfs:o:0", 2));
      await bot.handleUpdate(callbackUpdate("resfs:s", 3));

      expect(calls.some((call) => call.method === "createForumTopic")).toBe(true);
      const selectedMessage = calls.filter((call) => call.method === "editMessageText").at(-1)?.payload;
      expect(selectedMessage?.text).toBe("Reserve Project 예약 토픽을 열었습니다.");
      expect(selectedMessage?.text).not.toContain(root);
      const topicMessage = calls
        .filter((call) => call.method === "sendMessage")
        .map((call) => call.payload)
        .find((payload) => payload.message_thread_id === 7777);
      expect(topicMessage?.text).toContain("Reserve Project 예약");
      expect(topicMessage?.text).toContain("이 토픽에 예약할 시간과 작업을 입력하세요");
      expect(topicMessage?.reply_markup).toEqual({ remove_keyboard: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses an existing stored project when reserve picks the same real folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-folder-browser-"));
    const projectDir = join(root, "Reserve Project");
    mkdirSync(projectDir);
    process.env.CHATKJB_FOLDER_BROWSER_ROOT = root;
    const { bot, store, calls } = botSetup();
    store.syncProjects([{ name: "Stored Reserve", cwd: `${projectDir}/.`, defaultMode: "auto" }]);

    try {
      await bot.handleUpdate(reserveCommand("/reserve browse"));
      await bot.handleUpdate(callbackUpdate("resfs:o:0", 2));
      await bot.handleUpdate(callbackUpdate("resfs:s", 3));

      const topicMessage = calls
        .filter((call) => call.method === "sendMessage")
        .map((call) => call.payload)
        .find((payload) => payload.message_thread_id === 7777);
      expect(topicMessage?.text).toContain("Stored Reserve 예약");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores a topic-backed reservation from a message in the reservation topic", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 29, 22, 10, 0, 0));
    const root = mkdtempSync(join(tmpdir(), "telegram-folder-browser-"));
    mkdirSync(join(root, "Reserve Project"));
    process.env.CHATKJB_FOLDER_BROWSER_ROOT = root;
    try {
      const { bot, store, calls } = botSetup();

      await bot.handleUpdate(reserveCommand("/reserve browse"));
      await bot.handleUpdate(callbackUpdate("resfs:o:0", 2));
      await bot.handleUpdate(callbackUpdate("resfs:s", 3));
      await bot.handleUpdate(textMessage("내일 오전 9시에 README 점검", 4, 7777));

      const task = store.listPendingReservedTasks()[0];
      expect(task).toMatchObject({
        projectName: "Reserve Project",
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses a reservation topic when the scheduled task starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 29, 22, 10, 0, 0));
    try {
      const { bot, store, sessions, calls } = botSetup();
      vi.spyOn(sessions as unknown as { execute: () => Promise<void>; }, "execute")
        .mockResolvedValue();

      await bot.handleUpdate(reserveCommand("/reserve test"));
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

  it("cancels a topic-backed reservation when its Telegram topic is deleted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 29, 22, 10, 0, 0));
    const topicDeletionSource = new FakeTopicDeletionSource();
    try {
      const { bot, store, startTopicDeletionMonitor } = botSetup({
        telegramMtproto: {
          apiId: 12345,
          apiHash: "0123456789abcdef0123456789abcdef",
          sessionPath: "/tmp/chatkjb-test-mtproto.session"
        },
        runtime: { topicDeletionSource }
      });
      await startTopicDeletionMonitor();

      await bot.handleUpdate(reserveCommand("/reserve test"));
      await bot.handleUpdate(textMessage("30분 뒤 테스트 실행", 3, 7777));
      const task = store.listPendingReservedTasks()[0]!;

      await topicDeletionSource.emit([7777]);

      expect(store.getReservedTask(task.id)?.status).toBe("canceled");
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      expect(store.listSessions(10).some((item) => item.topicId === 7777)).toBe(false);
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

describe("/compile command", () => {
  it("requires an agy preprocessing checkpoint in the batch prompt", async () => {
    const { bot, config, sessions, calls } = botSetup();
    mkdirSync(join(config.projects[0]!.cwd, ".claude", "commands"), { recursive: true });
    writeFileSync(join(config.projects[0]!.cwd, ".claude", "commands", "compile.md"), "# compile\n");
    // 개발자 기기에 실제 LLM-Wiki가 있는지에 따라 결과가 달라지지 않도록
    // vault를 이 테스트가 만든 임시 폴더로 고정한다.
    process.env.WIKI_VAULT = config.projects[0]!.cwd;
    // The command intentionally runs in the background. Keep this unit test
    // isolated from a real post-compile deploy and wait for that background
    // task before afterEach restores the process environment.
    process.env.KJB_WIKI_POST_COMPILE_SCRIPT = "";
    const runOneOffTask = vi
      .spyOn(sessions, "runOneOffTask")
      .mockResolvedValue("compile ok");

    await bot.handleUpdate(compileCommand("/compile 10-inbox/test.md"));

    expect(runOneOffTask).toHaveBeenCalledOnce();
    expect(runOneOffTask.mock.calls[0]![0]).toMatchObject({
      allowProviderFallback: false
    });
    expect(runOneOffTask.mock.calls[0]![0]).not.toHaveProperty("timeoutMs");
    const prompt = runOneOffTask.mock.calls[0]![0].prompt;
    expect(prompt).toContain("agy(Antigravity) 비신뢰 전처리는 필수 체크포인트입니다");
    expect(prompt).toContain("반드시 한 번 시도");
    expect(prompt).toContain("사용/폐기/생략 상태와 사유");
    expect(prompt).toContain("`10-inbox/test.md`");
    await vi.waitFor(() => {
      const texts = calls
        .filter((call) => call.method === "sendMessage")
        .map((call) => String(call.payload.text));
      expect(texts.some((text) => text.includes("LLM-Wiki compile 완료"))).toBe(true);
    });
  });

  it("deploys the configured KJB Wiki public graph before reporting completion", async () => {
    const { bot, config, sessions, calls } = botSetup();
    mkdirSync(join(config.projects[0]!.cwd, ".claude", "commands"), { recursive: true });
    writeFileSync(join(config.projects[0]!.cwd, ".claude", "commands", "compile.md"), "# compile\n");
    // 개발자 기기에 실제 LLM-Wiki가 있는지에 따라 결과가 달라지지 않도록
    // vault를 이 테스트가 만든 임시 폴더로 고정한다.
    process.env.WIKI_VAULT = config.projects[0]!.cwd;
    const scriptPath = join(config.projects[0]!.cwd, "kjb-post-compile.sh");
    const markerPath = join(config.projects[0]!.cwd, "kjb-post-compile.marker");
    writeFileSync(
      scriptPath,
      "#!/bin/sh\nprintf '%s' \"$1\" > \"$KJB_WIKI_TEST_MARKER\"\n",
      { mode: 0o755 }
    );
    process.env.KJB_WIKI_POST_COMPILE_SCRIPT = scriptPath;
    process.env.KJB_WIKI_TEST_MARKER = markerPath;
    vi.spyOn(sessions, "runOneOffTask").mockResolvedValue("compile ok");

    await bot.handleUpdate(compileCommand("/compile"));

    await vi.waitFor(() => expect(readFileSync(markerPath, "utf8")).toBe("--deploy"));
    await vi.waitFor(() => {
      const texts = calls
        .filter((call) => call.method === "sendMessage")
        .map((call) => String(call.payload.text));
      expect(texts.some((text) => text.includes("compile 및 KJB Wiki 공개 그래프 배포 완료")))
        .toBe(true);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("reports a post-compile deployment failure without misreporting the compile itself", async () => {
    const { bot, config, sessions, calls } = botSetup();
    mkdirSync(join(config.projects[0]!.cwd, ".claude", "commands"), { recursive: true });
    writeFileSync(join(config.projects[0]!.cwd, ".claude", "commands", "compile.md"), "# compile\n");
    // 개발자 기기에 실제 LLM-Wiki가 있는지에 따라 결과가 달라지지 않도록
    // vault를 이 테스트가 만든 임시 폴더로 고정한다.
    process.env.WIKI_VAULT = config.projects[0]!.cwd;
    const scriptPath = join(config.projects[0]!.cwd, "kjb-post-compile-fail.sh");
    writeFileSync(scriptPath, "#!/bin/sh\nexit 17\n", { mode: 0o755 });
    process.env.KJB_WIKI_POST_COMPILE_SCRIPT = scriptPath;
    vi.spyOn(sessions, "runOneOffTask").mockResolvedValue("compile ok");

    await bot.handleUpdate(compileCommand("/compile"));

    await vi.waitFor(() => {
      const texts = calls
        .filter((call) => call.method === "sendMessage")
        .map((call) => String(call.payload.text));
      expect(texts.some((text) => text.includes("compile은 완료했지만 KJB Wiki 공개 그래프 배포 오류")))
        .toBe(true);
      expect(texts.some((text) => text.includes("compile 및 KJB Wiki 공개 그래프 배포 완료")))
        .toBe(false);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("does not block later updates while compile is running", async () => {
    const { bot, config, sessions, calls } = botSetup();
    mkdirSync(join(config.projects[0]!.cwd, ".claude", "commands"), { recursive: true });
    writeFileSync(join(config.projects[0]!.cwd, ".claude", "commands", "compile.md"), "# compile\n");
    // 개발자 기기에 실제 LLM-Wiki가 있는지에 따라 결과가 달라지지 않도록
    // vault를 이 테스트가 만든 임시 폴더로 고정한다.
    process.env.WIKI_VAULT = config.projects[0]!.cwd;
    vi.spyOn(sessions, "runOneOffTask").mockReturnValue(new Promise(() => undefined));

    await bot.handleUpdate(compileCommand("/compile"));
    await bot.handleUpdate(newCommand(2, "/new browse"));

    const texts = calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => call.payload.text);
    expect(texts.some((text) => String(text).includes("LLM-Wiki compile을 시작합니다"))).toBe(true);
    expect(texts.some((text) => String(text).includes("드라이브를 선택하세요"))).toBe(true);
  });

  it("delivers a completion notice under Telegram's length limit for huge provider output", async () => {
    const { bot, config, sessions, calls } = botSetup();
    mkdirSync(join(config.projects[0]!.cwd, ".claude", "commands"), { recursive: true });
    writeFileSync(join(config.projects[0]!.cwd, ".claude", "commands", "compile.md"), "# compile\n");
    process.env.WIKI_VAULT = config.projects[0]!.cwd;
    process.env.KJB_WIKI_POST_COMPILE_SCRIPT = "";
    const huge = Array.from({ length: 200 }, (_, i) => `progress-${i} ${"x".repeat(500)}`).join("\n");
    vi.spyOn(sessions, "runOneOffTask").mockResolvedValue(huge);

    await bot.handleUpdate(compileCommand("/compile"));

    await vi.waitFor(() => {
      const texts = calls
        .filter((call) => call.method === "sendMessage")
        .map((call) => String(call.payload.text));
      expect(texts.some((text) => text.includes("LLM-Wiki compile 완료"))).toBe(true);
    });
    const completion = calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => String(call.payload.text))
      .find((text) => text.includes("LLM-Wiki compile 완료"));
    expect(completion).toBeDefined();
    expect(completion!.length).toBeLessThanOrEqual(4096);
  });

  it("falls back to a short completion notice when Telegram rejects a long body", async () => {
    const { bot, config, sessions, calls } = botSetup({
      failSendMessageWhen: (text) =>
        text.includes("compile 완료") && !text.includes("생략되었습니다")
    });
    mkdirSync(join(config.projects[0]!.cwd, ".claude", "commands"), { recursive: true });
    writeFileSync(join(config.projects[0]!.cwd, ".claude", "commands", "compile.md"), "# compile\n");
    process.env.WIKI_VAULT = config.projects[0]!.cwd;
    process.env.KJB_WIKI_POST_COMPILE_SCRIPT = "";
    vi.spyOn(sessions, "runOneOffTask").mockResolvedValue("compile ok\n".repeat(20));

    await bot.handleUpdate(compileCommand("/compile"));

    await vi.waitFor(() => {
      const texts = calls
        .filter((call) => call.method === "sendMessage")
        .map((call) => String(call.payload.text));
      expect(texts.some((text) => text.includes("생략되었습니다"))).toBe(true);
    });
    const fallback = calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => String(call.payload.text))
      .find((text) => text.includes("생략되었습니다"));
    expect(fallback!.length).toBeLessThanOrEqual(4096);
    // 거절된 본문 시도 + 짧은 폴백 성공이 calls에 모두 남는다.
    expect(
      calls.filter((call) => call.method === "sendMessage"
        && String(call.payload.text).includes("compile 완료")).length
    ).toBeGreaterThanOrEqual(2);
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

describe("/query command", () => {
  it("allows wiki query fileback while preserving original source files", async () => {
    const { bot, sessions } = botSetup();
    const resume = vi.spyOn(sessions, "resume").mockReturnValue(true);

    await bot.handleUpdate(queryCommand("/query ChatKJB 메모리 정책"));

    const prompt = String(resume.mock.calls[0]?.[1] ?? "");
    expect(prompt).toContain("50-queries/");
    expect(prompt).toContain("관련 위키 인덱스");
    expect(prompt).toContain("10-inbox/");
    expect(prompt).toContain("20-raw/");
    expect(prompt).toContain("삭제하거나 덮어쓰지 마라");
    expect(prompt).not.toContain("위키 파일을 수정하지 말고");
    expect(prompt).not.toContain("읽기 전용) 답변만 작성");
  });
});

describe("multi-user pending state isolation", () => {
  it("lets only the allowed user who opened a task topic consume its pending start", async () => {
    const { bot, sessions } = botSetup({ allowedUserIds: [7, 8] });
    const createSession = vi.spyOn(sessions, "createSession").mockReturnValue({
      ...session("queued"),
      id: "secondary-user-session",
      topicId: 7777,
      title: "test - secondary"
    });

    await bot.handleUpdate(workflowCommand("/new test", 1, 42, 8));
    await bot.handleUpdate(textMessage("다른 사용자의 입력", 2, 7777, 7));
    expect(createSession).not.toHaveBeenCalled();

    await bot.handleUpdate(textMessage("두 번째 허용 사용자의 작업", 3, 7777, 8));
    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession.mock.calls[0]?.[4]).toBe("두 번째 허용 사용자의 작업");
  });

  it("isolates pending reserve topics by the actual allowed user", async () => {
    const { bot, store } = botSetup({ allowedUserIds: [7, 8] });

    await bot.handleUpdate(workflowCommand("/reserve test", 1, 42, 8));
    await bot.handleUpdate(textMessage("30분 뒤 다른 사용자 입력", 2, 7777, 7));
    expect(store.listPendingReservedTasks()).toHaveLength(0);

    await bot.handleUpdate(textMessage("30분 뒤 README 점검", 3, 7777, 8));
    expect(store.listPendingReservedTasks()).toHaveLength(1);
    expect(store.listPendingReservedTasks()[0]?.prompt).toBe("README 점검");
  });

  it("ignores users outside the allowlist before handlers create state", async () => {
    const { bot, calls } = botSetup({ allowedUserIds: [7, 8] });

    await bot.handleUpdate(workflowCommand("/new test", 1, 42, 9));

    expect(calls).toEqual([]);
  });
});

describe("existing-session command lifecycle", () => {
  it.each(["/synth 설계 검토", "/query 장기 기억 정책"])(
    "rejects %s when its topic has no stored session",
    async (command) => {
      const { bot, calls } = botSetup();

      await bot.handleUpdate(workflowCommand(command, 1, 7777));

      expect(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text)
        .toBe("세션 토픽 안에서 사용하세요.");
    }
  );
});

describe("workflow commands", () => {
  it("starts a pending workflow exactly once through the complete handler chain even when its start notice fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { bot, store, sessions, calls } = botSetup({
      failSessionStartNotification: true,
      allowedUserIds: [7, 8]
    });
    const execute = vi.spyOn(
      sessions as unknown as { execute: (request: { prompt: string; session: SessionRecord; }) => Promise<void>; },
      "execute"
    ).mockResolvedValue();

    await bot.handleUpdate(workflowCommand("/new test", 1, 42, 8));
    await bot.handleUpdate(workflowCommand("/ralplan 다른 사용자의 교차 입력", 2, 7777, 7));
    expect(execute).not.toHaveBeenCalled();
    await bot.handleUpdate(workflowCommand("/ralplan 전체 handler 검증", 3, 7777, 8));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    const created = store.listSessions(10).filter((item) => item.topicId === 7777);
    expect(created).toHaveLength(1);
    expect(execute.mock.calls[0]?.[0].prompt)
      .toContain(`State root: .chatkjb/workflows/${created[0]!.id}/ralplan`);
    expect(calls.filter((call) => String(call.payload.text ?? "").includes("워크플로를 시작합니다")))
      .toHaveLength(1);
    expect(calls.some((call) => String(call.payload.text ?? "").includes("세션 시작 중 오류"))).toBe(false);
  });

  it.each([
    ["/deepinterview --standard 결제 흐름을 명확히 해줘", "deep-interview"],
    ["/ralplan 인증 리팩터링 계획", "ralplan"],
    ["/ultragoal plan/approved.md", "ultragoal"]
  ])("routes %s through the bundled shared skill", async (command, workflow) => {
    const { bot, sessions, calls } = botSetup();
    const resume = vi.spyOn(sessions, "resume").mockReturnValue(true);

    await bot.handleUpdate(workflowCommand(command, 1, 42));

    const prompt = String(resume.mock.calls[0]?.[1] ?? "");
    expect(prompt).toContain(`Workflow: ${workflow}`);
    expect(prompt).toContain(`/skills/${workflow}/SKILL.md`);
    expect(prompt).toContain(`State root: .chatkjb/workflows/session/${workflow}`);
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("워크플로를 시작합니다");
  });

  it("shows usage instead of starting an empty new workflow", async () => {
    const { bot, sessions, calls } = botSetup();
    const resume = vi.spyOn(sessions, "resume").mockReturnValue(true);

    await bot.handleUpdate(workflowCommand("/ralplan", 1, 42));

    expect(resume).not.toHaveBeenCalled();
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("사용법: /ralplan");
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
    const { bot, sessions, store, calls } = botSetup();
    store.updateSession("session", { goalCondition: "모든 테스트 통과" });
    vi.spyOn(sessions, "clearGoalForCommand").mockImplementation(async () => {
      store.updateSession("session", { goalCondition: null });
      return true;
    });

    await bot.handleUpdate(goalCommand("/goal clear"));

    expect(store.getSession("session")?.goalCondition).toBeNull();
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("네이티브 목표 해제를 요청했습니다");
  });

  it("wires a new goal condition into the session manager", async () => {
    const { bot, sessions, calls } = botSetup();
    const setGoal = vi.spyOn(sessions, "setGoal").mockResolvedValue("active");

    await bot.handleUpdate(goalCommand("/goal 모든 테스트가 통과한다"));

    expect(setGoal).toHaveBeenCalledWith("session", "모든 테스트가 통과한다");
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("목표를 저장했습니다");
  });

  it("starts a pending new-session topic when /goal is the first task message", async () => {
    const { bot, store, sessions, calls } = botSetup();
    vi.spyOn(sessions as unknown as { execute: () => Promise<void>; }, "execute")
      .mockResolvedValue();

    await bot.handleUpdate(newCommand());
    await bot.handleUpdate(goalCommand("/goal 지원 절차 자료를 만들어줘", 3, 7777));

    const created = store
      .listSessions(10)
      .find((item) => item.topicId === 7777);
    expect(created?.goalCondition).toBe("지원 절차 자료를 만들어줘");
    expect(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text)
      .toContain("네이티브 goal 전달을 예약했습니다");
  });

  it("preserves a first-message goal when the best-effort session start notice fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { bot, store, sessions, calls } = botSetup({ failSessionStartNotification: true });
    vi.spyOn(sessions as unknown as { execute: () => Promise<void>; }, "execute")
      .mockResolvedValue();

    await bot.handleUpdate(workflowCommand("/new test", 1));
    await bot.handleUpdate(goalCommand("/goal 알림 실패에도 목표 보존", 2, 7777));

    const created = store.listSessions(10).filter((item) => item.topicId === 7777);
    expect(created).toHaveLength(1);
    expect(created[0]?.goalCondition).toBe("알림 실패에도 목표 보존");
    expect(calls.filter((call) => String(call.payload.text ?? "").includes("네이티브 goal 전달을 예약했습니다")))
      .toHaveLength(1);
    expect(calls.some((call) => String(call.payload.text ?? "").includes("세션 시작 중 오류"))).toBe(false);
  });

  it("keeps a pending topic when the first /goal has no completion condition", async () => {
    const { bot, store, sessions, calls } = botSetup();
    vi.spyOn(sessions as unknown as { execute: () => Promise<void>; }, "execute")
      .mockResolvedValue();

    await bot.handleUpdate(workflowCommand("/new test", 1));
    await bot.handleUpdate(goalCommand("/goal", 2, 7777));

    expect(store.listSessions(10).some((item) => item.topicId === 7777)).toBe(false);
    expect(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text)
      .toContain("사용법: /goal");

    await bot.handleUpdate(textMessage("빈 goal 뒤 실제 첫 작업", 3, 7777));
    expect(store.listSessions(10).filter((item) => item.topicId === 7777)).toHaveLength(1);
  });

  it("reports when a goal is set through the native goal surface", async () => {
    const { bot, sessions, store, calls } = botSetup();
    store.updateSession("session", { provider: "codex", codexThreadId: "thread-1" });
    vi.spyOn(sessions, "setGoal").mockResolvedValue("native");

    await bot.handleUpdate(goalCommand("/goal 모든 테스트가 통과한다"));

    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("네이티브 goal로 설정");
  });

  it("passes Codex goals through the injected app-server client", async () => {
    const setGoal = vi.fn(async () => undefined);
    const clearGoal = vi.fn(async () => true);
    const { bot, store, config } = botSetup({
      runtime: { codexGoalClient: { setGoal, clearGoal } }
    });
    store.updateSession("session", {
      provider: "codex",
      codexThreadId: "thread-1",
      codexHome: config.codexAccountHomes[0]!
    });

    await bot.handleUpdate(goalCommand("/goal 모든 테스트가 통과한다"));

    expect(setGoal).toHaveBeenCalledWith(
      "thread-1",
      "모든 테스트가 통과한다",
      { codexHome: config.codexAccountHomes[0] }
    );
  });

  it("reports a native failure without enabling ChatKJB goal automation", async () => {
    const { bot, sessions, store, calls } = botSetup();
    store.updateSession("session", { provider: "codex", codexThreadId: "thread-1" });
    vi.spyOn(sessions, "setGoal").mockRejectedValue(new Error("native unavailable"));

    await bot.handleUpdate(goalCommand("/goal 모든 테스트가 통과한다"));

    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("목표 설정 중 오류");
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .not.toContain("자동 진행");
  });

  it("rejects goal on a provider without a native goal surface", async () => {
    const { bot, sessions, store, calls } = botSetup();
    store.updateSession("session", { provider: "grok" });
    const setGoal = vi.spyOn(sessions, "setGoal");

    await bot.handleUpdate(goalCommand("/goal 모든 테스트가 통과한다"));

    expect(setGoal).not.toHaveBeenCalled();
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("Grok는 네이티브 goal 기능을 제공하지 않습니다");
  });
});

describe("native slash command passthrough", () => {
  it("passes provider-native slash commands through an existing session", async () => {
    const { bot, sessions, calls } = botSetup();
    const runNative = vi.spyOn(sessions, "runNativeSlashCommand").mockReturnValue(true);

    await bot.handleUpdate(textMessage("/plan 구현 계획 세워줘", 1, 42));

    expect(runNative).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session", provider: "claude" }),
      "/plan 구현 계획 세워줘"
    );
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("네이티브 명령으로 전달");
  });

  it("passes unlisted slash commands to the provider instead of rejecting them", async () => {
    const { bot, sessions, calls } = botSetup();
    const runNative = vi.spyOn(sessions, "runNativeSlashCommand").mockReturnValue(true);

    await bot.handleUpdate(textMessage("/not_a_native_command", 1, 42));

    expect(runNative).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session", provider: "claude" }),
      "/not_a_native_command"
    );
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("네이티브 명령으로 전달");
  });
});

describe("/restop command", () => {
  it("cancels a waiting-limit auto resume without stopping the active run", async () => {
    const { bot, sessions, calls } = botSetup();
    const cancelLimitResume = vi.spyOn(sessions, "cancelLimitResume").mockReturnValue(true);

    await bot.handleUpdate(restopCommand());

    expect(cancelLimitResume).toHaveBeenCalledWith("session");
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("자동 재개 예약을 취소했습니다");
  });
});

describe("/resume command", () => {
  it("restarts the current topic from its provider context", async () => {
    const { bot, sessions, calls } = botSetup();
    const resume = vi.spyOn(sessions, "resume").mockReturnValue(true);

    await bot.handleUpdate(resumeCommand());

    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session" }),
      expect.stringContaining("[SERVICE_RECOVERY]")
    );
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("기존 제공자 문맥에서 재개했습니다");
  });
});

describe("plain follow-up messages", () => {
  it("starts a follow-up when the previous run is only finalizing after completion", async () => {
    const { bot, sessions, calls } = botSetup();
    vi.spyOn(sessions, "isActive").mockReturnValue(true);
    vi.spyOn(sessions, "isFinalizing").mockReturnValue(true);
    const resume = vi.spyOn(sessions, "resume").mockReturnValue(true);

    await bot.handleUpdate(textMessage("다음 작업 진행"));

    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session" }),
      "다음 작업 진행"
    );
    const replies = calls.filter((call) => call.method === "sendMessage").map((call) => call.payload.text);
    expect(replies).toContain("후속 작업을 시작했습니다.");
    expect(replies).not.toContain("현재 작업이 실행 중입니다.\n현재 작업을 수정하려면 `/steer 지시`, 끝난 뒤 실행하려면 `/next 지시`를 사용하세요.");
  });

  it("uses a pending fork start before resuming the existing topic session", async () => {
    const { bot, sessions, store, calls } = botSetup();
    const resume = vi.spyOn(sessions, "resume").mockReturnValue(true);
    vi.spyOn(sessions as unknown as { enqueue(request: unknown): void; }, "enqueue")
      .mockImplementation(() => undefined);

    await bot.handleUpdate(forkCommand(1));
    await bot.handleUpdate(textMessage("분기에서 새 작업", 2));

    expect(resume).not.toHaveBeenCalled();
    const forked = store.listSessions(10).find((item) => item.topicId === 7777);
    expect(forked?.title).toContain("분기에서 새 작업");
    const replies = calls.filter((call) => call.method === "sendMessage").map((call) => call.payload.text);
    expect(replies).toContain("새 분기에서 실행할 지시를 입력하세요.");
    expect(replies.some((text) => String(text).includes("세션을 시작했습니다."))).toBe(true);
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

  it("updates Codex, Antigravity, and Grok models through the same command", async () => {
    const { bot, store } = botSetup();

    store.updateSession("session", { provider: "codex" });
    await bot.handleUpdate(modelCommand("/model gpt-5.5", 11));
    expect(store.getSession("session")?.codexModel).toBe("gpt-5.5");

    store.updateSession("session", { provider: "agy" });
    await bot.handleUpdate(modelCommand("/model gemini-3.5-flash", 12));
    expect(store.getSession("session")?.agyModel).toBe("gemini-3.5-flash");

    store.updateSession("session", { provider: "grok" });
    await bot.handleUpdate(modelCommand("/model grok-composer-2.5-fast", 13));
    expect(store.getSession("session")?.grokModel).toBe("grok-composer-2.5-fast");
  });

  it("rejects model changes while the session is active", async () => {
    const { bot, sessions, store, calls } = botSetup();
    vi.spyOn(sessions, "isActive").mockReturnValue(true);

    await bot.handleUpdate(modelCommand("/model fable"));

    expect(store.getSession("session")?.model).toBeNull();
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toContain("실행 중에는 바꿀 수 없습니다.");
  });

  it("shows only the current provider model and its model keyboard without an argument", async () => {
    const { bot, calls } = botSetup();

    await bot.handleUpdate(modelCommand("/model"));

    const messages = calls.filter((call) => call.method === "sendMessage").map((call) => call.payload);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain("현재: Claude · Opus 4.8");
    expect(messages[0]?.reply_markup).toEqual(modelKeyboard());
    expect(JSON.stringify(messages[0]?.reply_markup)).not.toContain("mprov:");
  });
});

describe("/provider command", () => {
  it("shows only authenticated providers in a separate selection panel", async () => {
    const { bot, calls } = botSetup({ availableProviders: ["claude", "codex"] });

    await bot.handleUpdate(providerCommand());

    const messages = calls.filter((call) => call.method === "sendMessage").map((call) => call.payload);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain("현재 제공자: Claude");
    expect(messages[0]?.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "✅ Claude", callback_data: "mprov:claude" }],
        [{ text: "Codex", callback_data: "mprov:codex" }]
      ]
    });
  });
});

// /usage는 Claude 스냅샷만 mock하고 Codex 계정 상태는 실제로 조회한다. 기기 부하에
// 따라 기본 5초 제한을 넘겨 간헐적으로 실패하므로 이 묶음만 여유를 둔다.
describe("/usage command", { timeout: 20_000 }, () => {
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
    expect(reply).toContain("claude auth status");
    expect(reply).toContain("Codex 사용량");
  });
});
