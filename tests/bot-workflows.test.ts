import { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { BotDeps } from "../src/bot/deps.js";
import { registerWorkflowHandlers } from "../src/bot/handlers/workflows.js";
import { pendingStartKey, type PendingStart } from "../src/bot/pending-keys.js";
import type { InitialSessionPrompt } from "../src/session-manager.js";
import type { ProjectConfig, SessionRecord } from "../src/types.js";

const CHAT_ID = -1001;
const USER_ID = 23;
const TOPIC_ID = 90;

function workflowUpdate(text: string, updateId = 1) {
  const command = text.split(/\s/u, 1)[0]!;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      message_thread_id: TOPIC_ID,
      chat: { id: CHAT_ID, type: "supergroup" as const, title: "Test" },
      from: { id: USER_ID, is_bot: false, first_name: "User" },
      text,
      entities: [{ type: "bot_command" as const, offset: 0, length: command.length }]
    }
  };
}

function createdSession(id = "created-session"): SessionRecord {
  return {
    id,
    sdkSessionId: null,
    chatId: CHAT_ID,
    topicId: TOPIC_ID,
    projectName: "test",
    cwd: "/tmp/test",
    title: "workflow",
    status: "queued",
    permissionMode: "default",
    provider: "claude",
    model: null,
    thinking: null,
    claudeEffort: null,
    claudeTokenIndex: null,
    codexModel: null,
    codexReasoning: null,
    codexHome: null,
    codexThreadId: null,
    agyModel: null,
    agyThinkingLevel: null,
    agyConversationId: null,
    agyUsage: null,
    grokModel: null,
    grokReasoning: null,
    grokUsage: null,
    handoffSummary: null,
    goalCondition: null,
    leanMode: true,
    usageSnapshot: null,
    createdAt: 0,
    updatedAt: 0
  };
}

function setup(options?: {
  pending?: PendingStart;
  selectProjectForTask?: (task: string) => Promise<ProjectConfig>;
  startSession?: (
    project: ProjectConfig,
    prompt: InitialSessionPrompt,
    pending: PendingStart,
    topicId?: number | null,
    titlePrompt?: string
  ) => Promise<SessionRecord>;
}) {
  const project: ProjectConfig = { name: "test", cwd: "/tmp/test", defaultMode: "default" };
  const pendingStarts = new Map<string, PendingStart>();
  const key = pendingStartKey(USER_ID, TOPIC_ID);
  pendingStarts.set(key, options?.pending ?? {
    kind: "project",
    project,
    pendingTopicId: TOPIC_ID,
    provider: "claude"
  });
  const getSessionByTopic = vi.fn(() => undefined as SessionRecord | undefined);
  const selectProjectForTask = vi.fn(options?.selectProjectForTask ?? (async () => project));
  const startSessionFromOptions = vi.fn(options?.startSession ?? (async (
    _project: ProjectConfig,
    prompt: InitialSessionPrompt
  ) => {
    const session = createdSession();
    if (typeof prompt === "function") prompt(session);
    return session;
  }));
  const replies: string[] = [];
  const bot = new Bot("123456789:test-token");
  bot.botInfo = {
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
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      replies.push(String((payload as { text?: string; }).text ?? ""));
      return {
        ok: true,
        result: {
          message_id: replies.length,
          date: 0,
          chat: { id: CHAT_ID, type: "supergroup", title: "Test" },
          text: replies.at(-1)
        }
      } as never;
    }
    return { ok: true, result: true } as never;
  });
  registerWorkflowHandlers(bot, {
    config: { chatId: CHAT_ID },
    store: { getSessionByTopic },
    sessions: { isActive: vi.fn(() => false), resume: vi.fn(() => true) },
    pendingStarts,
    selectProjectForTask,
    startSessionFromOptions
  } as unknown as BotDeps);
  return {
    bot,
    key,
    pendingStarts,
    project,
    replies,
    getSessionByTopic,
    selectProjectForTask,
    startSessionFromOptions
  };
}

describe("workflow commands as the first session message", () => {
  it.each([
    ["/deepinterview --quick 결제 흐름", "deep-interview"],
    ["/ralplan 인증 계획", "ralplan"],
    ["/ultragoal 승인된 계획", "ultragoal"]
  ])("starts %s with a prompt bound to the newly created session UUID", async (command, workflow) => {
    let capturedPrompt = "";
    const test = setup({
      startSession: async (_project, prompt) => {
        const session = createdSession("uuid-from-create");
        capturedPrompt = typeof prompt === "function" ? prompt(session) : prompt;
        return session;
      }
    });

    await test.bot.handleUpdate(workflowUpdate(command));

    expect(test.startSessionFromOptions).toHaveBeenCalledOnce();
    expect(test.startSessionFromOptions.mock.calls[0]?.[3]).toBe(TOPIC_ID);
    expect(test.startSessionFromOptions.mock.calls[0]?.[4]).toBe(command.replace(/^\/\w+\s*/u, ""));
    expect(capturedPrompt).toContain(`Workflow: ${workflow}`);
    expect(capturedPrompt).toContain(`State root: .chatkjb/workflows/uuid-from-create/${workflow}`);
    expect(test.pendingStarts.has(test.key)).toBe(false);
    expect(test.replies.at(-1)).toContain(`.chatkjb/workflows/uuid-from-create/${workflow}`);
  });

  it("shows usage for an empty task without consuming the pending start", async () => {
    const test = setup();

    await test.bot.handleUpdate(workflowUpdate("/ralplan"));

    expect(test.replies.at(-1)).toContain("사용법: /ralplan");
    expect(test.pendingStarts.has(test.key)).toBe(true);
    expect(test.selectProjectForTask).not.toHaveBeenCalled();
    expect(test.startSessionFromOptions).not.toHaveBeenCalled();
  });

  it("preserves Cline provider/model/reasoning when a shared workflow starts the session", async () => {
    const project: ProjectConfig = { name: "test", cwd: "/tmp/test", defaultMode: "default" };
    const test = setup({
      pending: {
        kind: "project",
        project,
        pendingTopicId: TOPIC_ID,
        provider: "cline",
        clineProviderId: "cline-pass",
        clineModel: "kimi-k3",
        clineReasoning: "high"
      }
    });

    await test.bot.handleUpdate(workflowUpdate("/ultragoal 승인 계획 실행"));

    expect(test.startSessionFromOptions).toHaveBeenCalledOnce();
    expect(test.startSessionFromOptions.mock.calls[0]?.[2]).toMatchObject({
      provider: "cline",
      clineProviderId: "cline-pass",
      clineModel: "kimi-k3",
      clineReasoning: "high"
    });
  });

  it("claims the pending start before project selection so concurrent commands start once", async () => {
    let releaseSelection!: (project: ProjectConfig) => void;
    const selection = new Promise<ProjectConfig>((resolve) => {
      releaseSelection = resolve;
    });
    const test = setup({
      pending: {
        kind: "auto-project",
        selectionDefaults: {
          provider: "claude",
          claudeModel: "test",
          thinking: "on",
          claudeEffort: "high",
          claudeTokenIndex: 0,
          codexModel: "test",
          codexReasoning: "medium",
          codexHome: null,
          agyModel: "test",
          agyThinkingLevel: "high",
          grokModel: "test",
          grokReasoning: "high"
        },
        pendingTopicId: TOPIC_ID
      },
      selectProjectForTask: async () => selection
    });

    const first = test.bot.handleUpdate(workflowUpdate("/ralplan 첫 요청", 1));
    await vi.waitFor(() => expect(test.selectProjectForTask).toHaveBeenCalledOnce());
    const second = test.bot.handleUpdate(workflowUpdate("/ralplan 중복 요청", 2));
    await second;
    releaseSelection(test.project);
    await first;

    expect(test.selectProjectForTask).toHaveBeenCalledOnce();
    expect(test.startSessionFromOptions).toHaveBeenCalledOnce();
    expect(test.replies.some((reply) => reply.includes("세션 토픽 안에서 사용하세요"))).toBe(true);
  });

  it("restores the pending start when automatic project selection fails", async () => {
    const test = setup({
      pending: {
        kind: "auto-project",
        selectionDefaults: {} as never,
        pendingTopicId: TOPIC_ID
      },
      selectProjectForTask: async () => {
        throw new Error("selector failed");
      }
    });

    await test.bot.handleUpdate(workflowUpdate("/ralplan 선택 실패"));

    expect(test.pendingStarts.has(test.key)).toBe(true);
    expect(test.startSessionFromOptions).not.toHaveBeenCalled();
    expect(test.replies.at(-1)).toContain("selector failed");
  });

  it("restores the pending start when prompt creation or session start fails atomically", async () => {
    const test = setup({
      startSession: async (_project, prompt) => {
        if (typeof prompt === "function") prompt(createdSession("failed-session"));
        throw new Error("start failed");
      }
    });

    await test.bot.handleUpdate(workflowUpdate("/ultragoal 시작 실패"));

    expect(test.pendingStarts.has(test.key)).toBe(true);
    expect(test.replies.at(-1)).toContain("start failed");
  });
});
