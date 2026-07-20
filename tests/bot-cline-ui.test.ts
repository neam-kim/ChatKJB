import { Bot, Keyboard } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { BotDeps } from "../src/bot/deps.js";
import { registerConfigCommandHandlers } from "../src/bot/handlers/config-commands.js";
import { registerMessageHandlers } from "../src/bot/handlers/messages.js";
import { formatSessionStatus, providerDisplayLabel } from "../src/bot/formatting.js";
import { defaultsKeyboard, providerKeyboard } from "../src/bot/keyboards.js";
import { pendingFieldsFromDefaults } from "../src/bot/pending-keys.js";
import { cleanReservedTaskStartOptions } from "../src/bot/time-parse.js";
import type { ModelCatalog } from "../src/model-catalog.js";
import { FALLBACK_MODEL_CATALOG } from "../src/model-catalog.js";
import type { SessionDefaults, SessionRecord } from "../src/types.js";

const CHAT_ID = -1001;
const TOPIC_ID = 42;
const USER_ID = 7;

type InlineButton = { text: string; callback_data?: string; };
type ApiPayload = Record<string, unknown> & { reply_markup?: { inline_keyboard?: InlineButton[][]; }; };

function messageUpdate(text: string, updateId: number, userId = USER_ID) {
  const command = text.startsWith("/") ? text.split(/\s/u, 1)[0]! : null;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      message_thread_id: TOPIC_ID,
      chat: { id: CHAT_ID, type: "supergroup" as const, title: "Test" },
      from: { id: userId, is_bot: false, first_name: "User" },
      text,
      ...(command
        ? { entities: [{ type: "bot_command" as const, offset: 0, length: command.length }] }
        : {})
    }
  };
}

function callbackUpdate(data: string, updateId: number, userId = USER_ID) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: userId, is_bot: false, first_name: "User" },
      chat_instance: "test",
      data,
      message: {
        message_id: 100,
        date: 0,
        message_thread_id: TOPIC_ID,
        chat: { id: CHAT_ID, type: "supergroup" as const, title: "Test" },
        text: "Cline 선택"
      }
    }
  };
}

function clineCatalog(providerCount = 9, modelCount = 11): ModelCatalog {
  const providers = Array.from({ length: providerCount }, (_, index) => ({
    id: `provider-${index}-${"p".repeat(100)}`,
    label: `Provider ${index}`,
    models: modelCount,
    defaultModelId: `model-${index}-0-${"m".repeat(100)}`
  }));
  return {
    ...FALLBACK_MODEL_CATALOG,
    clineProviders: providers,
    clineModelsByProvider: Object.fromEntries(providers.map((provider, providerIndex) => [
      provider.id,
      Array.from({ length: modelCount }, (_, modelIndex) => ({
        id: `model-${providerIndex}-${modelIndex}-${"m".repeat(100)}`,
        label: `Model ${providerIndex}-${modelIndex}`,
        supportsReasoning: modelIndex % 2 === 0
      }))
    ]))
  };
}

function defaultsFor(catalog: ModelCatalog): SessionDefaults {
  const provider = catalog.clineProviders[0]!;
  return {
    provider: "cline",
    claudeModel: "claude",
    claudeTokenIndex: 0,
    codexModel: "codex",
    agyModel: "agy",
    grokModel: "grok",
    grokReasoning: "high",
    thinking: "adaptive",
    claudeEffort: "high",
    codexReasoning: "high",
    codexHome: null,
    agyThinkingLevel: "high",
    clineProviderId: provider.id,
    clineModel: provider.defaultModelId ?? catalog.clineModelsByProvider[provider.id]![0]!.id,
    clineReasoning: "high"
  };
}

function clineSession(defaults: SessionDefaults): SessionRecord {
  return {
    id: "cline-session",
    sdkSessionId: null,
    chatId: CHAT_ID,
    topicId: TOPIC_ID,
    projectName: "test",
    cwd: "/tmp/test",
    title: "Cline",
    status: "done",
    permissionMode: "default",
    provider: "cline",
    model: null,
    thinking: null,
    claudeEffort: null,
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
    clineProviderId: defaults.clineProviderId ?? null,
    clineModel: defaults.clineModel ?? null,
    clineReasoning: defaults.clineReasoning ?? null,
    clineSessionId: "cline-native",
    clineUsage: null,
    createdAt: 0,
    updatedAt: 0
  };
}

function setup(options: { withSession?: boolean; active?: boolean; unsetConnection?: boolean; } = {}) {
  const catalog = clineCatalog();
  let defaults = defaultsFor(catalog);
  let session = options.withSession ? clineSession(defaults) : undefined;
  if (session && options.unsetConnection) {
    // switchProvider(→cline)가 남기는 상태: provider만 cline이고 내부 연결값은 비어 있다.
    session = { ...session, clineProviderId: "", clineModel: "", clineReasoning: null, clineSessionId: null };
  }
  const sent: ApiPayload[] = [];
  const callbackAnswers: ApiPayload[] = [];
  const edited: ApiPayload[] = [];
  const pendingStarts = new Map();
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
      sent.push(payload as ApiPayload);
      return {
        ok: true,
        result: {
          message_id: sent.length,
          date: 0,
          chat: { id: CHAT_ID, type: "supergroup", title: "Test" },
          text: String((payload as { text?: string; }).text ?? "")
        }
      } as never;
    }
    if (method === "answerCallbackQuery") callbackAnswers.push(payload as ApiPayload);
    if (method === "editMessageReplyMarkup") edited.push(payload as ApiPayload);
    return { ok: true, result: true } as never;
  });

  const updateSessionDefaults = vi.fn((fields: Partial<SessionDefaults>) => {
    defaults = { ...defaults, ...fields };
    return defaults;
  });
  const updateSession = vi.fn((_id: string, fields: Partial<SessionRecord>) => {
    if (session) session = { ...session, ...fields };
  });
  const deps = {
    config: {
      chatId: CHAT_ID,
      availableProviders: ["cline"],
      defaultProvider: "cline",
      modelCatalog: catalog,
      claudeCodeOauthTokens: ["secret"],
      codexAccountHomes: [],
      claudeMemoryDir: "/tmp/memory",
      projects: []
    },
    store: {
      getSessionDefaults: () => defaults,
      updateSessionDefaults,
      getSessionByTopic: () => session,
      getSession: () => session,
      updateSession
    },
    sessions: {
      isActive: vi.fn(() => options.active ?? false),
      resume: vi.fn(() => true),
      switchProvider: vi.fn(async () => ({ ok: true })),
      updateClineConnection: vi.fn(async (_id: string, fields: Partial<SessionRecord>) => {
        if (session) session = { ...session, ...fields };
        return { ok: true };
      })
    },
    permissions: { handleCallback: vi.fn(), handleTextInput: vi.fn(async () => false) },
    pendingStarts,
    pendingReserves: new Map(),
    defaultPanelKeyboard: () => new Keyboard().text("panel"),
    transport: {},
    resolveSessionUploadPath: vi.fn(),
    scheduleReservedTask: vi.fn(),
    handleFile: vi.fn(),
    handleMediaMessage: vi.fn(),
    selectProjectForTask: vi.fn(),
    startSessionFromOptions: vi.fn()
  } as unknown as BotDeps;
  registerConfigCommandHandlers(bot, deps);
  registerMessageHandlers(bot, deps);
  return {
    bot,
    catalog,
    sent,
    callbackAnswers,
    edited,
    updateSessionDefaults,
    updateSession,
    defaults: () => defaults,
    session: () => session
  };
}

function callbacks(payload: ApiPayload | undefined): string[] {
  return payload?.reply_markup?.inline_keyboard
    ?.flat()
    .map((button) => button.callback_data)
    .filter((value): value is string => !!value) ?? [];
}

describe("Cline bot configuration UI", () => {
  it("carries Cline defaults into pending and reserved starts", () => {
    const catalog = clineCatalog(1, 1);
    const defaults = defaultsFor(catalog);
    const pending = pendingFieldsFromDefaults(defaults);

    expect(pending).toMatchObject({
      provider: "cline",
      clineProviderId: defaults.clineProviderId,
      clineModel: defaults.clineModel,
      clineReasoning: "high"
    });
    expect(cleanReservedTaskStartOptions(pending)).toMatchObject(pending);
  });

  it("keeps the persistent panel 3x2 and exposes Cline as the fifth outer provider", () => {
    const catalog = clineCatalog(1, 1);
    const panel = defaultsKeyboard(defaultsFor(catalog), catalog).build();
    expect(panel).toHaveLength(3);
    expect(panel.every((row) => row.length === 2)).toBe(true);
    const fifth = panel[2]?.[0];
    expect(typeof fifth === "string" ? fifth : fifth?.text).toContain("🔌 Cline 제공자");

    const providers = providerKeyboard("cline", ["claude", "codex", "agy", "grok", "cline"]).inline_keyboard;
    expect(providers.flat().some((button) => "callback_data" in button && button.callback_data === "mprov:cline"))
      .toBe(true);
  });

  it("formats Cline provider, model, and reasoning status", () => {
    const catalog = clineCatalog(1, 1);
    const defaults = defaultsFor(catalog);
    const status = formatSessionStatus(clineSession(defaults), false, catalog);
    expect(providerDisplayLabel("cline")).toBe("Cline");
    expect(status).toContain("제공자: Cline");
    expect(status).toContain("Cline 내부 제공자: Provider 0");
    expect(status).toContain("Cline 모델: Model 0-0");
    expect(status).toContain("Cline 추론 강도: high");
  });



  it("paginates provider/model snapshots without embedding long SDK ids", async () => {
    const test = setup();
    await test.bot.handleUpdate(messageUpdate("🔌 Cline 제공자: Provider 0", 1));

    const providerCallbacks = callbacks(test.sent.at(-1));
    expect(providerCallbacks.filter((value) => value.includes(":i"))).toHaveLength(8);
    expect(providerCallbacks).toContainEqual(expect.stringMatching(/^clp:[A-Za-z0-9_-]{16}:p1$/));
    expect(providerCallbacks.every((value) => Buffer.byteLength(value, "utf8") < 64)).toBe(true);
    expect(providerCallbacks.join("\n")).not.toContain("p".repeat(100));

    const selectProvider = providerCallbacks.find((value) => value.endsWith(":i0"))!;
    await test.bot.handleUpdate(callbackUpdate(selectProvider, 2));
    const modelCallbacks = callbacks(test.sent.at(-1));
    expect(modelCallbacks.filter((value) => value.includes(":i"))).toHaveLength(10);
    expect(modelCallbacks).toContainEqual(expect.stringMatching(/^clm:[A-Za-z0-9_-]{16}:p1$/));
    expect(modelCallbacks.every((value) => Buffer.byteLength(value, "utf8") < 64)).toBe(true);
    expect(modelCallbacks.join("\n")).not.toContain("m".repeat(100));

    await test.bot.handleUpdate(callbackUpdate(modelCallbacks.find((value) => value.endsWith(":i1"))!, 3));
    expect(test.defaults().clineModel).toBe(test.catalog.clineModelsByProvider[test.defaults().clineProviderId!]![1]!.id);
    expect(test.defaults().clineReasoning).toBe("off");
  });

  it("rejects a snapshot replay from another Telegram user", async () => {
    const test = setup();
    await test.bot.handleUpdate(messageUpdate("🔌 Cline 제공자: Provider 0", 1));
    const callback = callbacks(test.sent.at(-1)).find((value) => value.endsWith(":i0"))!;

    await test.bot.handleUpdate(callbackUpdate(callback, 2, USER_ID + 1));

    expect(test.updateSessionDefaults).not.toHaveBeenCalled();
    expect(test.callbackAnswers.at(-1)).toMatchObject({ show_alert: true });
  });

  it("updates an idle Cline session model and reasoning but rejects active changes", async () => {
    const test = setup({ withSession: true });
    await test.bot.handleUpdate(messageUpdate("/model", 1));
    const modelCallback = callbacks(test.sent.at(-1)).find((value) => value.endsWith(":i1"))!;
    await test.bot.handleUpdate(callbackUpdate(modelCallback, 2));
    expect(test.session()?.clineModel).toBe(test.catalog.clineModelsByProvider[test.session()!.clineProviderId!]![1]!.id);
    expect(test.session()?.clineReasoning).toBe("off");

    await test.bot.handleUpdate(messageUpdate("/power high", 3));
    expect(String(test.sent.at(-1)?.["text"])).toContain("지원하지 않는 Cline 추론 강도");

    const active = setup({ withSession: true, active: true });
    await active.bot.handleUpdate(messageUpdate("/power off", 4));
    expect(active.updateSession).not.toHaveBeenCalled();
    expect(String(active.sent.at(-1)?.["text"])).toContain("실행 중에는 바꿀 수 없습니다");
  });

  it("recovers a Cline session whose internal connection was never seeded", async () => {
    // 다른 제공자에서 /provider로 전환해 온 세션은 clineProviderId가 비어 있다. 이때도
    // /model 패널이 고른 모델을 받아들이고, 폴백 제공자 id를 함께 확정해야 한다.
    const test = setup({ withSession: true, unsetConnection: true });
    const fallback = test.catalog.clineProviders[0]!;

    await test.bot.handleUpdate(messageUpdate("/model", 1));
    const modelCallback = callbacks(test.sent.at(-1)).find((value) => value.endsWith(":i1"))!;
    await test.bot.handleUpdate(callbackUpdate(modelCallback, 2));

    expect(test.callbackAnswers.at(-1)).not.toMatchObject({ show_alert: true });
    expect(test.session()?.clineProviderId).toBe(fallback.id);
    expect(test.session()?.clineModel).toBe(test.catalog.clineModelsByProvider[fallback.id]![1]!.id);
  });
});
