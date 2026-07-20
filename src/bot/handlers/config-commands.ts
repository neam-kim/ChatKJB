import { Bot, InlineKeyboard } from "grammy";
import {
  clineModelsForProvider,
  clineReasoningOptionsForModel,
  normalizeClineReasoning,
  seedClineConnection
} from "../../cline-sdk.js";
import {
  agyModelLabel,
  agyThinkingLabel,
  agyThinkingOptionsForModel,
  claudeEffortLabel,
  claudeEffortOptionsForModel,
  codexModelLabel,
  codexReasoningLabel,
  codexReasoningOptionsForModel,
  DEFAULT_AGY_MODEL,
  DEFAULT_AGY_THINKING_LEVEL,
  DEFAULT_CLAUDE_EFFORT,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING,
  DEFAULT_GROK_MODEL,
  DEFAULT_GROK_REASONING,
  DEFAULT_THINKING_LEVEL,
  grokModelLabel,
  grokReasoningLabel,
  grokReasoningOptions,
  modelLabel,
  normalizeThinkingForModel,
  resolveAgyModel,
  resolveAgyThinkingLevel,
  resolveCodexModel,
  resolveGrokModel,
  resolveModel,
  thinkingLabel,
  thinkingToggleOptionsForModel
} from "../../model-catalog.js";
import { buildMemoryPrompt } from "../../session-manager.js";
import type { ProviderKind } from "../../types.js";
import type { BotDeps } from "../deps.js";
import {
  providerDisplayLabel
} from "../formatting.js";
import {
  agyModelKeyboard,
  codexModelKeyboard,
  clineModelOption,
  clineModelSnapshotKeyboard,
  clineProviderOption,
  clineProviderSnapshotKeyboard,
  clineReasoningLabel,
  defaultsProviderKeyboard,
  defaultsSummary,
  grokModelKeyboard,
  modelKeyboard,
  parseMode,
  powerKeyboardForSession,
  providerKeyboard,
  thinkingKeyboard
} from "../keyboards.js";
import { clineCatalogRevision, clineSnapshotStoreFor } from "../cline-snapshots.js";
import { parseTokenId, pendingStartKey } from "../pending-keys.js";

export function registerConfigCommandHandlers(bot: Bot, deps: BotDeps): void {
  const {
    config,
    store,
    sessions,
    pendingStarts,
    defaultPanelKeyboard
  } = deps;
  const clineSnapshots = clineSnapshotStoreFor(bot);
  const clineRevision = () => clineCatalogRevision({
    providers: config.modelCatalog.clineProviders,
    modelsByProvider: config.modelCatalog.clineModelsByProvider
  });

  bot.command("firstp", async (ctx) => {
    const current = store.getSessionDefaults();
    await ctx.reply(
      `새 세션 기본 제공자를 선택하세요. 인증된 제공자만 표시합니다.\n현재: ${providerDisplayLabel(current.provider)}`,
      { reply_markup: defaultsProviderKeyboard(current.provider, config.availableProviders) }
    );
  });

  bot.command("tokenid", async (ctx) => {
    const pendingKey = pendingStartKey(ctx.from!.id, ctx.message?.message_thread_id);
    const pending = pendingStarts.get(pendingKey);
    if (!pending) {
      await ctx.reply("/new로 프로젝트를 먼저 선택한 뒤 첫 작업 메시지 전에 사용하세요.\n예: /tokenid 2");
      return;
    }
    if ((pending.provider ?? config.defaultProvider) !== "codex") {
      await ctx.reply("현재 대기 중인 새 세션 제공자가 Codex가 아닙니다. /tokenid는 Codex 세션에만 적용됩니다.");
      return;
    }
    const tokenId = parseTokenId(ctx.match);
    if (!tokenId || tokenId > config.codexAccountHomes.length) {
      await ctx.reply(`사용할 Codex 계정 번호를 1부터 ${config.codexAccountHomes.length} 사이로 입력하세요.\n예: /tokenid 1`);
      return;
    }
    pending.codexHome = config.codexAccountHomes[tokenId - 1] ?? null;
    pendingStarts.set(pendingKey, pending);
    await ctx.reply(`새 Codex 세션에서 계정 #${tokenId}을(를) 우선 사용합니다. 이제 첫 작업 메시지를 입력하세요.`);
  });

  bot.command("memory", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("기록할 세션 토픽 안에서 사용하세요.");
      return;
    }
    const hasContext = session.provider === "codex"
      ? !!session.codexThreadId
      : session.provider === "agy"
        ? !!session.agyConversationId
        : session.provider === "grok"
          ? !!session.grokSessionId
          : session.provider === "cline"
            ? !!session.clineSessionId
          : !!session.sdkSessionId;
    if (!hasContext) {
      await ctx.reply(
        `아직 검토할 ${providerDisplayLabel(session.provider)} 세션 문맥이 없습니다.`
      );
      return;
    }
    if (!sessions.resume(session, buildMemoryPrompt(ctx.match, config.claudeMemoryDir))) {
      await ctx.reply("현재 작업이 실행 중입니다. 완료하거나 /stop으로 중단한 뒤 메모리를 기록하세요.");
      return;
    }
    await ctx.reply(
      ctx.match.trim()
        ? `전역 메모리 업데이트를 시작했습니다.\n저장 초점: ${ctx.match.trim().slice(0, 1000)}`
        : "현재 세션에서 장기적으로 유효한 내용을 선별해 전역 메모리에 기록합니다."
    );
  });

  bot.command("mode", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const mode = parseMode(ctx.match);
    if (!mode) {
      await ctx.reply(
        `현재 모드: ${session.permissionMode}\n사용 가능: default, acceptEdits, plan, dontAsk, auto\n`
        + "Claude와 Cline은 텔레그램 승인 브로커를 사용하고, Codex·Antigravity·Grok은 같은 모드를 샌드박스와 실행 지침으로 적용합니다."
      );
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.reply("실행 중에는 바꿀 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요.");
      return;
    }
    store.updateSession(session.id, { permissionMode: mode });
    if (session.provider === "agy") {
      // agy는 런타임 setMode API가 없으므로, 다음 턴에 같은 conversation_id로
      // 브리지를 재구성하여 새 CapabilitiesConfig+policies를 적용한다.
      // 대화 문맥(conversation_id)은 그대로 유지된다.
      const hasConv = !!session.agyConversationId;
      await ctx.reply(
        `권한 모드를 ${mode}(으)로 변경했습니다.\n`
        + `Antigravity는 다음 메시지부터 같은 대화${hasConv ? `(${session.agyConversationId!.slice(0, 8)}…)` : ""}를 `
        + `유지한 채 새 모드로 재구성됩니다.`
      );
      return;
    }
    await ctx.reply(`다음 실행부터 권한 모드를 ${mode}(으)로 사용합니다.`);
  });

  // /provider: 제공자 전환은 버튼(mprov:)으로만 하며, 전환 시 직전 provider가 만든
  // 요약을 새 provider에 인계한다(SessionManager.switchProvider).

  bot.command("provider", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    await ctx.reply(
      `현재 제공자: ${providerDisplayLabel(session.provider)}\n`
      + "제공자를 바꾸려면 아래에서 선택하세요(직전 대화 요약이 새 제공자로 인계됩니다).",
      { reply_markup: providerKeyboard(session.provider, config.availableProviders) }
    );
  });

  // /model: 현재 제공자의 모델만 확인·변경한다.

  bot.command("model", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const input = ctx.match.trim();
    if (!input) {
      if (session.provider === "cline") {
        const provider = clineProviderOption(config.modelCatalog, session.clineProviderId);
        const models = clineModelsForProvider(config.modelCatalog, provider?.id);
        if (!provider || models.length === 0) {
          await ctx.reply("선택 가능한 Cline 내부 제공자 또는 모델이 없습니다. Cline 설정을 확인한 뒤 다시 시도하세요.");
          return;
        }
        const scope = {
          userId: ctx.from!.id,
          topicId: topicId ?? null,
          target: { kind: "session" as const, sessionId: session.id },
          revision: clineRevision()
        };
        const providerSnapshot = clineSnapshots.create("provider", scope, config.modelCatalog.clineProviders);
        const modelSnapshot = clineSnapshots.create(
          "model",
          scope,
          models.map((model) => ({ ...model, providerId: provider.id }))
        );
        const model = clineModelOption(config.modelCatalog, provider.id, session.clineModel);
        await ctx.reply(
          `현재: Cline · ${provider.label} · ${model?.label ?? "감지된 모델 없음"}\n`
          + "내부 제공자를 바꾸려면 아래에서 선택하세요.",
          { reply_markup: clineProviderSnapshotKeyboard(providerSnapshot) }
        );
        await ctx.reply("현재 내부 제공자의 모델을 선택하세요.", {
          reply_markup: clineModelSnapshotKeyboard(modelSnapshot)
        });
        return;
      }
      const current = session.provider === "codex"
        ? `현재: Codex · ${codexModelLabel(config.modelCatalog, session.codexModel ?? DEFAULT_CODEX_MODEL)}`
        : session.provider === "agy"
          ? `현재: Antigravity · ${agyModelLabel(config.modelCatalog, session.agyModel ?? DEFAULT_AGY_MODEL)}`
          : session.provider === "grok"
            ? `현재: Grok · ${grokModelLabel(config.modelCatalog, session.grokModel ?? DEFAULT_GROK_MODEL)}`
            : `현재: Claude · ${modelLabel(config.modelCatalog, session.model ?? DEFAULT_CLAUDE_MODEL)}`;
      const modelBoard = session.provider === "codex"
        ? codexModelKeyboard(config.modelCatalog)
        : session.provider === "agy"
          ? agyModelKeyboard(config.modelCatalog)
          : session.provider === "grok"
            ? grokModelKeyboard(config.modelCatalog)
            : modelKeyboard(config.modelCatalog);
      await ctx.reply(
        `${current}\n모델을 바꾸려면 아래에서 선택하세요.`,
        { reply_markup: modelBoard }
      );
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.reply("실행 중에는 바꿀 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요.");
      return;
    }
    // 텍스트 인자: 현재 제공자 기준으로 모델 id/별칭을 해석한다.
    if (session.provider === "codex") {
      const codexModel = resolveCodexModel(config.modelCatalog, input);
      if (!codexModel) {
        await ctx.reply("지원하지 않는 Codex 모델입니다. /model 버튼의 모델을 사용하세요.");
        return;
      }
      store.updateSession(session.id, { codexModel });
      await ctx.reply(`다음 실행부터 Codex ${codexModelLabel(config.modelCatalog, codexModel)} 모델을 사용합니다.`);
      return;
    }
    if (session.provider === "agy") {
      const agyModel = resolveAgyModel(config.modelCatalog, input);
      if (!agyModel) {
        await ctx.reply("지원하지 않는 Antigravity 모델입니다. /model 버튼의 모델을 사용하세요.");
        return;
      }
      store.updateSession(session.id, { agyModel, agyThinkingLevel: null });
      // agy는 런타임 setModel API가 없으므로, 다음 턴에 같은 conversation_id로
      // 브리지를 재구성하여 새 ModelTarget을 적용한다. 대화 문맥은 유지된다.
      const hasConv = !!session.agyConversationId;
      await ctx.reply(
        `Antigravity 모델을 ${agyModelLabel(config.modelCatalog, agyModel)}(으)로 변경했습니다.\n`
        + `다음 메시지부터 같은 대화${hasConv ? `(${session.agyConversationId!.slice(0, 8)}…)` : ""}를 `
        + `유지한 채 새 모델로 재구성됩니다.`
      );
      return;
    }
    if (session.provider === "grok") {
      const grokModel = resolveGrokModel(config.modelCatalog, input);
      if (!grokModel) {
        await ctx.reply("지원하지 않는 Grok 모델입니다. /model 버튼의 모델을 사용하세요.");
        return;
      }
      store.updateSession(session.id, { grokModel });
      await ctx.reply(`다음 실행부터 Grok ${grokModelLabel(config.modelCatalog, grokModel)} 모델을 사용합니다.`);
      return;
    }
    if (session.provider === "cline") {
      const provider = clineProviderOption(config.modelCatalog, session.clineProviderId);
      const models = clineModelsForProvider(config.modelCatalog, provider?.id);
      const option = models.find((item) => item.id === input);
      if (!provider || !option) {
        await ctx.reply("지원하지 않는 Cline 모델입니다. /model 버튼의 모델을 사용하세요.");
        return;
      }
      const clineReasoning = normalizeClineReasoning(session.clineReasoning, option);
      const changed = await sessions.updateClineConnection(session.id, {
        clineProviderId: provider.id,
        clineModel: option.id,
        clineReasoning
      });
      if (!changed.ok) {
        await ctx.reply(changed.reason ?? "Cline 연결 설정을 바꾸지 못했습니다.");
        return;
      }
      await ctx.reply(`다음 실행부터 Cline ${option.label} 모델을 사용합니다.\nreasoning: ${clineReasoningLabel(clineReasoning)}`);
      return;
    }
    const model = resolveModel(config.modelCatalog, input);
    if (!model) {
      await ctx.reply("지원하지 않는 모델입니다. /model 버튼에 표시되는 모델 ID나 별칭을 사용하세요.");
      return;
    }
    const thinking = normalizeThinkingForModel(config.modelCatalog, model, session.thinking);
    store.updateSession(session.id, { model, thinking });
    await ctx.reply(
      `다음 실행부터 ${modelLabel(config.modelCatalog, model)} 모델을 사용합니다.\n`
      + `thinking: ${thinkingLabel(thinking)}`
    );
  });

  bot.command("thinking", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    if (session.provider !== "claude") {
      await ctx.reply("/thinking은 Claude 전용입니다. Codex·Antigravity·Grok·Cline은 /power를 사용하세요.");
      return;
    }
    const input = ctx.match.trim().toLowerCase();
    if (!input) {
      await ctx.reply(
        `현재 thinking: ${thinkingLabel(session.thinking ?? DEFAULT_THINKING_LEVEL)}`,
        { reply_markup: thinkingKeyboard(config.modelCatalog, session.model ?? DEFAULT_CLAUDE_MODEL) }
      );
      return;
    }
    const option = thinkingToggleOptionsForModel(
      config.modelCatalog,
      session.model ?? DEFAULT_CLAUDE_MODEL
    ).find((item) => item.id === input);
    if (!option) {
      await ctx.reply("지원하지 않는 thinking 수준입니다.\n사용 가능: adaptive, off (작업량은 /power)");
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.reply("실행 중에는 바꿀 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요.");
      return;
    }
    store.updateSession(session.id, { thinking: option.id });
    await ctx.reply(`다음 실행부터 thinking을 ${option.label}(으)로 사용합니다.`);
  });

  async function handlePowerCommand(
    ctx: {
      reply: (
        text: string,
        options?: { reply_markup?: InlineKeyboard; }
      ) => Promise<unknown>;
      message?: { message_thread_id?: number; } | undefined;
      match: string;
    },
    legacyAlias = false
  ): Promise<void> {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const input = ctx.match.trim().toLowerCase();
    const aliasSuffix = legacyAlias ? "\n이 명령은 /power로 통합되었습니다." : "";

    if (!input) {
      const currentText = session.provider === "claude"
        ? `현재 Claude 작업량: ${claudeEffortLabel(session.claudeEffort ?? DEFAULT_CLAUDE_EFFORT)}`
        : session.provider === "codex"
          ? `현재 Codex 추론 강도: ${codexReasoningLabel(session.codexReasoning ?? DEFAULT_CODEX_REASONING)}`
          : session.provider === "grok"
            ? `현재 Grok 추론 강도: ${grokReasoningLabel(session.grokReasoning ?? DEFAULT_GROK_REASONING)}`
            : session.provider === "cline"
              ? `현재 Cline 추론 강도: ${clineReasoningLabel(session.clineReasoning)}`
            : `현재 Antigravity 추론 강도: ${agyThinkingLabel(session.agyThinkingLevel ?? DEFAULT_AGY_THINKING_LEVEL)}`;
      await ctx.reply(
        `${currentText}${aliasSuffix}`,
        { reply_markup: powerKeyboardForSession(session, config.modelCatalog) }
      );
      return;
    }

    if (session.provider === "claude") {
      const option = claudeEffortOptionsForModel(
        config.modelCatalog,
        session.model ?? DEFAULT_CLAUDE_MODEL
      ).find((item) => item.id === input);
      if (!option) {
        await ctx.reply(`지원하지 않는 작업량입니다.\n사용 가능: low, medium, high, xhigh, max${aliasSuffix}`);
        return;
      }
      if (sessions.isActive(session.id)) {
        await ctx.reply("실행 중에는 바꿀 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요.");
        return;
      }
      store.updateSession(session.id, { claudeEffort: option.id });
      await ctx.reply(`다음 실행부터 Claude 작업량을 ${option.label}(으)로 사용합니다.${aliasSuffix}`);
      return;
    }

    if (session.provider === "codex") {
      const option = codexReasoningOptionsForModel(
        config.modelCatalog,
        session.codexModel ?? DEFAULT_CODEX_MODEL
      ).find((item) => item.id === input);
      if (!option) {
        await ctx.reply(`지원하지 않는 추론 강도입니다.\n사용 가능: minimal, low, medium, high, xhigh${aliasSuffix}`);
        return;
      }
      if (sessions.isActive(session.id)) {
        await ctx.reply("실행 중에는 바꿀 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요.");
        return;
      }
      store.updateSession(session.id, { codexReasoning: option.id });
      await ctx.reply(`다음 실행부터 Codex 추론 강도를 ${option.label}(으)로 사용합니다.${aliasSuffix}`);
      return;
    }

    if (session.provider === "grok") {
      const option = grokReasoningOptions(config.modelCatalog).find((item) => item.id === input);
      if (!option) {
        await ctx.reply(`지원하지 않는 Grok 추론 강도입니다.\n사용 가능: ${grokReasoningOptions(config.modelCatalog).map((item) => item.id).join(", ") || "감지 실패"}${aliasSuffix}`);
        return;
      }
      if (sessions.isActive(session.id)) {
        await ctx.reply("실행 중에는 바꿀 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요.");
        return;
      }
      store.updateSession(session.id, { grokReasoning: option.id });
      await ctx.reply(`다음 실행부터 Grok 추론 강도를 ${option.label}(으)로 사용합니다.${aliasSuffix}`);
      return;
    }

    if (session.provider === "cline") {
      const model = clineModelOption(config.modelCatalog, session.clineProviderId, session.clineModel);
      const option = clineReasoningOptionsForModel(model).find((value) => value === input);
      if (!option) {
        await ctx.reply(
          `지원하지 않는 Cline 추론 강도입니다.\n사용 가능: ${clineReasoningOptionsForModel(model).join(", ")}${aliasSuffix}`
        );
        return;
      }
      if (sessions.isActive(session.id)) {
        await ctx.reply("실행 중에는 바꿀 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요.");
        return;
      }
      const changed = await sessions.updateClineConnection(session.id, { clineReasoning: option });
      if (!changed.ok) {
        await ctx.reply(changed.reason ?? "Cline 연결 설정을 바꾸지 못했습니다.");
        return;
      }
      await ctx.reply(`다음 실행부터 Cline 추론 강도를 ${clineReasoningLabel(option)}(으)로 사용합니다.${aliasSuffix}`);
      return;
    }

    if (input === "reset" || input === "default") {
      if (sessions.isActive(session.id)) {
        await ctx.reply("실행 중에는 바꿀 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요.");
        return;
      }
      store.updateSession(session.id, { agyThinkingLevel: null });
      await ctx.reply(`Antigravity 추론 강도를 모델 기본값으로 초기화했습니다. 다음 실행부터 적용됩니다.${aliasSuffix}`);
      return;
    }
    const supported = agyThinkingOptionsForModel(config.modelCatalog, session.agyModel);
    const resolved = resolveAgyThinkingLevel(input);
    const option = supported.find((item) => item.id === resolved);
    if (!option) {
      const available = supported.map((item) => item.id).join(", ") || "모델 기본값만";
      await ctx.reply(`선택한 모델이 지원하지 않는 추론 강도입니다.\n사용 가능: ${available} (또는 reset)${aliasSuffix}`);
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.reply("실행 중에는 바꿀 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요.");
      return;
    }
    store.updateSession(session.id, { agyThinkingLevel: option.id });
    await ctx.reply(`다음 실행부터 Antigravity 추론 강도를 ${option.label}(으)로 사용합니다.${aliasSuffix}`);
  }

  bot.command("power", async (ctx) => {
    await handlePowerCommand(ctx);
  });

  bot.command("effort", async (ctx) => {
    await handlePowerCommand(ctx, true);
  });

  bot.command("lean", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const input = ctx.match.trim().toLowerCase();
    if (!input) {
      await ctx.reply(
        `현재 lean 모드: ${session.leanMode ? "on" : "off"}\n사용 가능: on, off`
      );
      return;
    }
    if (input !== "on" && input !== "off") {
      await ctx.reply("지원하지 않는 lean 모드입니다.\n사용 가능: on, off");
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.reply("실행 중에는 바꿀 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요.");
      return;
    }
    store.updateSession(session.id, { leanMode: input === "on" });
    await ctx.reply(
      input === "on"
        ? "다음 실행부터 최소 구현 원칙을 적용합니다."
        : "다음 실행부터 최소 구현 원칙을 적용하지 않습니다."
    );
  });

  bot.callbackQuery(/^model:/, async (ctx) => {
    const modelId = ctx.callbackQuery.data.slice("model:".length);
    const option = config.modelCatalog.claudeModels.find((item) => item.id === modelId);
    if (!option) {
      await ctx.answerCallbackQuery({ text: "지원하지 않는 모델입니다.", show_alert: true });
      return;
    }
    const topicId = ctx.callbackQuery.message?.message_thread_id;
    const session = topicId
      ? store.getSessionByTopic(config.chatId, topicId)
      : undefined;
    if (!session) {
      await ctx.answerCallbackQuery({ text: "세션을 찾을 수 없습니다.", show_alert: true });
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.answerCallbackQuery({
        text: "실행 중에는 모델을 바꿀 수 없습니다.",
        show_alert: true
      });
      return;
    }
    const thinking = normalizeThinkingForModel(config.modelCatalog, option.id, session.thinking);
    store.updateSession(session.id, { model: option.id, thinking });
    await ctx.answerCallbackQuery({ text: `${option.label} 선택` });
    await ctx.reply(
      `다음 실행부터 ${option.label} 모델을 사용합니다.\n`
      + `thinking: ${thinkingLabel(thinking)}`
    );
  });

  bot.callbackQuery(/^think:/, async (ctx) => {
    const thinkingId = ctx.callbackQuery.data.slice("think:".length);
    const topicId = ctx.callbackQuery.message?.message_thread_id;
    const session = topicId
      ? store.getSessionByTopic(config.chatId, topicId)
      : undefined;
    if (!session) {
      await ctx.answerCallbackQuery({ text: "세션을 찾을 수 없습니다.", show_alert: true });
      return;
    }
    const option = thinkingToggleOptionsForModel(
      config.modelCatalog,
      session.model ?? DEFAULT_CLAUDE_MODEL
    ).find((item) => item.id === thinkingId);
    if (!option) {
      await ctx.answerCallbackQuery({ text: "지원하지 않는 thinking 수준입니다.", show_alert: true });
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.answerCallbackQuery({
        text: "실행 중에는 thinking을 바꿀 수 없습니다.",
        show_alert: true
      });
      return;
    }
    store.updateSession(session.id, { thinking: option.id });
    await ctx.answerCallbackQuery({ text: `${option.label} 선택` });
    await ctx.reply(`다음 실행부터 thinking을 ${option.label}(으)로 사용합니다.`);
  });

  async function applyPowerSelection(
    ctx: {
      answerCallbackQuery: (args?: { text?: string; show_alert?: boolean; }) => Promise<unknown>;
      reply: (text: string) => Promise<unknown>;
      callbackQuery: { data: string; message?: { message_thread_id?: number; }; };
    },
    provider: ProviderKind,
    optionId: string
  ): Promise<void> {
    const topicId = ctx.callbackQuery.message?.message_thread_id;
    const session = topicId
      ? store.getSessionByTopic(config.chatId, topicId)
      : undefined;
    if (!session) {
      await ctx.answerCallbackQuery({ text: "세션을 찾을 수 없습니다.", show_alert: true });
      return;
    }
    if (provider === "claude") {
      const option = claudeEffortOptionsForModel(
        config.modelCatalog,
        session.model ?? DEFAULT_CLAUDE_MODEL
      ).find((item) => item.id === optionId);
      if (!option) {
        await ctx.answerCallbackQuery({ text: "지원하지 않는 작업량입니다.", show_alert: true });
        return;
      }
      if (sessions.isActive(session.id)) {
        await ctx.answerCallbackQuery({
          text: "실행 중에는 작업량을 바꿀 수 없습니다.",
          show_alert: true
        });
        return;
      }
      store.updateSession(session.id, { claudeEffort: option.id });
      await ctx.answerCallbackQuery({ text: `${option.label} 선택` });
      await ctx.reply(`다음 실행부터 Claude 작업량을 ${option.label}(으)로 사용합니다.`);
      return;
    }

    if (provider === "codex") {
      const option = codexReasoningOptionsForModel(
        config.modelCatalog,
        session.codexModel ?? DEFAULT_CODEX_MODEL
      ).find((item) => item.id === optionId);
      if (!option) {
        await ctx.answerCallbackQuery({ text: "지원하지 않는 추론 강도입니다.", show_alert: true });
        return;
      }
      if (sessions.isActive(session.id)) {
        await ctx.answerCallbackQuery({
          text: "실행 중에는 바꿀 수 없습니다.",
          show_alert: true
        });
        return;
      }
      store.updateSession(session.id, { codexReasoning: option.id });
      await ctx.answerCallbackQuery({ text: `${option.label} 선택` });
      await ctx.reply(`다음 실행부터 Codex 추론 강도를 ${option.label}(으)로 사용합니다.`);
      return;
    }

    if (provider === "grok") {
      const option = grokReasoningOptions(config.modelCatalog).find((item) => item.id === optionId);
      if (!option) {
        await ctx.answerCallbackQuery({ text: "지원하지 않는 Grok 추론 강도입니다.", show_alert: true });
        return;
      }
      if (sessions.isActive(session.id)) {
        await ctx.answerCallbackQuery({ text: "실행 중에는 바꿀 수 없습니다.", show_alert: true });
        return;
      }
      store.updateSession(session.id, { grokReasoning: option.id });
      await ctx.answerCallbackQuery({ text: `${option.label} 선택` });
      await ctx.reply(`다음 실행부터 Grok 추론 강도를 ${option.label}(으)로 사용합니다.`);
      return;
    }

    if (provider === "cline") {
      if (session.provider !== "cline") {
        await ctx.answerCallbackQuery({ text: "Cline 세션이 아닙니다.", show_alert: true });
        return;
      }
      const model = clineModelOption(config.modelCatalog, session.clineProviderId, session.clineModel);
      const option = clineReasoningOptionsForModel(model).find((value) => value === optionId);
      if (!option) {
        await ctx.answerCallbackQuery({ text: "지원하지 않는 Cline 추론 강도입니다.", show_alert: true });
        return;
      }
      if (sessions.isActive(session.id)) {
        await ctx.answerCallbackQuery({ text: "실행 중에는 바꿀 수 없습니다.", show_alert: true });
        return;
      }
      const changed = await sessions.updateClineConnection(session.id, { clineReasoning: option });
      if (!changed.ok) {
        await ctx.answerCallbackQuery({ text: changed.reason ?? "Cline 연결 변경 실패", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: `${clineReasoningLabel(option)} 선택` });
      await ctx.reply(`다음 실행부터 Cline 추론 강도를 ${clineReasoningLabel(option)}(으)로 사용합니다.`);
      return;
    }

    const resolved = optionId === "reset" || optionId === "default"
      ? null
      : resolveAgyThinkingLevel(optionId);
    const option = resolved
      ? agyThinkingOptionsForModel(config.modelCatalog, session.agyModel)
        .find((item) => item.id === resolved)
      : null;
    if (resolved === undefined || (resolved !== null && !option)) {
      await ctx.answerCallbackQuery({ text: "지원하지 않는 추론 강도입니다.", show_alert: true });
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.answerCallbackQuery({ text: "실행 중에는 바꿀 수 없습니다.", show_alert: true });
      return;
    }
    store.updateSession(session.id, { agyThinkingLevel: resolved });
    await ctx.answerCallbackQuery({
      text: option ? `${option.label} 선택` : "모델 기본 선택"
    });
    await ctx.reply(
      option
        ? `다음 실행부터 Antigravity 추론 강도를 ${option.label}(으)로 사용합니다.`
        : "Antigravity 추론 강도를 모델 기본값으로 초기화했습니다. 다음 실행부터 적용됩니다."
    );
  }

  bot.callbackQuery(/^power:/, async (ctx) => {
    const payload = ctx.callbackQuery.data.slice("power:".length);
    const topicId = ctx.callbackQuery.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.answerCallbackQuery({ text: "세션을 찾을 수 없습니다.", show_alert: true });
      return;
    }
    const [first, second, ...rest] = payload.split(":");
    if ((first === "claude" || first === "codex" || first === "agy" || first === "grok" || first === "cline") && second && rest.length === 0) {
      await applyPowerSelection(ctx, first, second);
      return;
    }
    if (!first) {
      await ctx.answerCallbackQuery({ text: "알 수 없는 작업량입니다.", show_alert: true });
      return;
    }
    await applyPowerSelection(ctx, session.provider, payload);
  });

  bot.callbackQuery(/^effort:/, async (ctx) => {
    const reasoningId = ctx.callbackQuery.data.slice("effort:".length);
    const topicId = ctx.callbackQuery.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.answerCallbackQuery({ text: "세션을 찾을 수 없습니다.", show_alert: true });
      return;
    }
    await applyPowerSelection(ctx, session.provider, reasoningId);
  });

  bot.callbackQuery(/^agythink:/, async (ctx) => {
    const levelId = ctx.callbackQuery.data.slice("agythink:".length);
    const topicId = ctx.callbackQuery.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.answerCallbackQuery({ text: "세션을 찾을 수 없습니다.", show_alert: true });
      return;
    }
    await applyPowerSelection(ctx, session.provider, levelId);
  });

  // /provider 제공자 전환. 직전 provider의 요약을 새 provider로 인계한다(요약 생성에 시간이
  // 걸릴 수 있어 먼저 안내한다).

  bot.callbackQuery(/^mprov:/, async (ctx) => {
    const target = ctx.callbackQuery.data.slice("mprov:".length) as ProviderKind;
    if (target !== "claude" && target !== "codex" && target !== "agy" && target !== "grok" && target !== "cline") {
      await ctx.answerCallbackQuery({ text: "알 수 없는 제공자입니다.", show_alert: true });
      return;
    }
    if (!config.availableProviders.includes(target)) {
      await ctx.answerCallbackQuery({ text: "인증되지 않은 제공자입니다.", show_alert: true });
      return;
    }
    const topicId = ctx.callbackQuery.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.answerCallbackQuery({ text: "세션을 찾을 수 없습니다.", show_alert: true });
      return;
    }
    if (session.provider === target) {
      await ctx.answerCallbackQuery({ text: "이미 사용 중입니다." });
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.answerCallbackQuery({ text: "실행 중에는 전환할 수 없습니다.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: `${providerDisplayLabel(target)}로 전환` });
    await ctx.reply("직전 대화 요약을 만들어 새 제공자로 인계하는 중입니다…");
    const result = await sessions.switchProvider(session.id, target);
    if (!result.ok) {
      await ctx.reply(result.reason ?? "제공자를 전환하지 못했습니다.");
      return;
    }
    const updated = store.getSession(session.id);
    const label = target === "codex"
      ? `Codex · ${codexModelLabel(config.modelCatalog, updated?.codexModel ?? DEFAULT_CODEX_MODEL)}`
      : target === "agy"
        ? `Antigravity · ${agyModelLabel(config.modelCatalog, updated?.agyModel ?? DEFAULT_AGY_MODEL)}`
        : target === "grok"
          ? `Grok · ${grokModelLabel(config.modelCatalog, updated?.grokModel ?? DEFAULT_GROK_MODEL)}`
          : target === "cline"
            ? `Cline · ${clineProviderOption(config.modelCatalog, updated?.clineProviderId)?.label ?? "감지 없음"} · ${clineModelOption(config.modelCatalog, updated?.clineProviderId, updated?.clineModel)?.label ?? "감지된 모델 없음"}`
          : `Claude · ${modelLabel(config.modelCatalog, updated?.model ?? DEFAULT_CLAUDE_MODEL)}`;
    await ctx.reply(
      `제공자를 ${label}로 전환했습니다. 다음 메시지부터 새 제공자가 직전 작업 요약을 이어받아 진행합니다.`
    );
  });

  // 기본값 패널 제공자 선택. mprov:(세션 전환·요약 인계)와 달리 새 세션 기본값만 바꾼다.

  bot.callbackQuery(/^dprov:/, async (ctx) => {
    const target = ctx.callbackQuery.data.slice("dprov:".length) as ProviderKind;
    if (target !== "claude" && target !== "codex" && target !== "agy" && target !== "grok" && target !== "cline") {
      await ctx.answerCallbackQuery();
      return;
    }
    if (!config.availableProviders.includes(target)) {
      await ctx.answerCallbackQuery({ text: "인증되지 않은 제공자입니다.", show_alert: true });
      return;
    }
    // Cline으로 되돌아올 때 직전에 고른 내부 제공자·모델을 버리지 않는다(유효하면 보존).
    const defaults = store.updateSessionDefaults({
      provider: target,
      ...(target === "cline"
        ? seedClineConnection(config.modelCatalog, store.getSessionDefaults())
        : {})
    });
    await ctx.answerCallbackQuery({ text: `${providerDisplayLabel(target)} 선택` });
    await ctx.reply(
      `새 세션 기본 제공자: ${providerDisplayLabel(target)}\n${defaultsSummary(defaults, config.modelCatalog)}`,
      { reply_markup: defaultPanelKeyboard(defaults) }
    );
  });

  // /model에서 Codex 세션의 모델 선택. cmodel:<id>

  bot.callbackQuery(/^cmodel:/, async (ctx) => {
    const modelId = ctx.callbackQuery.data.slice("cmodel:".length);
    const option = config.modelCatalog.codexModels.find((item) => item.id === modelId);
    if (!option) {
      await ctx.answerCallbackQuery({ text: "지원하지 않는 Codex 모델입니다.", show_alert: true });
      return;
    }
    const topicId = ctx.callbackQuery.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.answerCallbackQuery({ text: "세션을 찾을 수 없습니다.", show_alert: true });
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.answerCallbackQuery({ text: "실행 중에는 바꿀 수 없습니다.", show_alert: true });
      return;
    }
    store.updateSession(session.id, { codexModel: option.id });
    await ctx.answerCallbackQuery({ text: `${option.label} 선택` });
    await ctx.reply(`다음 실행부터 Codex ${option.label} 모델을 사용합니다.`);
  });

  // /model에서 agy 세션의 모델 선택. amodel:<id>

  bot.callbackQuery(/^amodel:/, async (ctx) => {
    const modelId = ctx.callbackQuery.data.slice("amodel:".length);
    const option = config.modelCatalog.agyModels.find((item) => item.id === modelId);
    if (!option) {
      await ctx.answerCallbackQuery({ text: "지원하지 않는 Antigravity 모델입니다.", show_alert: true });
      return;
    }
    const topicId = ctx.callbackQuery.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.answerCallbackQuery({ text: "세션을 찾을 수 없습니다.", show_alert: true });
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.answerCallbackQuery({ text: "실행 중에는 바꿀 수 없습니다.", show_alert: true });
      return;
    }
    store.updateSession(session.id, { agyModel: option.id, agyThinkingLevel: null });
    await ctx.answerCallbackQuery({ text: `${option.label} 선택` });
    // agy는 런타임 setModel API가 없으므로, 다음 턴에 같은 conversation_id로
    // 브리지를 재구성하여 새 ModelTarget을 적용한다. 대화 문맥은 유지된다.
    const hasConv = !!session.agyConversationId;
    await ctx.reply(
      `Antigravity 모델을 ${option.label}(으)로 변경했습니다.\n`
      + `다음 메시지부터 같은 대화${hasConv ? `(${session.agyConversationId!.slice(0, 8)}…)` : ""}를 `
      + `유지한 채 새 모델로 재구성됩니다.`
    );
  });

  // /model에서 Grok 세션의 모델 선택. gmodel:<id>

  bot.callbackQuery(/^gmodel:/, async (ctx) => {
    const modelId = ctx.callbackQuery.data.slice("gmodel:".length);
    const option = config.modelCatalog.grokModels.find((item) => item.id === modelId);
    if (!option) {
      await ctx.answerCallbackQuery({ text: "지원하지 않는 Grok 모델입니다.", show_alert: true });
      return;
    }
    const topicId = ctx.callbackQuery.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.answerCallbackQuery({ text: "세션을 찾을 수 없습니다.", show_alert: true });
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.answerCallbackQuery({ text: "실행 중에는 바꿀 수 없습니다.", show_alert: true });
      return;
    }
    store.updateSession(session.id, { grokModel: option.id });
    await ctx.answerCallbackQuery({ text: `${option.label} 선택` });
    await ctx.reply(`다음 실행부터 Grok ${option.label} 모델을 사용합니다.`);
  });

  function clineSnapshotError(reason: string): string {
    return reason === "scope"
      ? "이 Cline 선택지는 다른 사용자 또는 토픽에서 열렸습니다."
      : "Cline 선택 목록이 만료되었거나 변경되었습니다. 목록을 다시 여세요.";
  }

  bot.callbackQuery(/^clp:/, async (ctx) => {
    const [prefix, nonce, action, ...rest] = ctx.callbackQuery.data.split(":");
    if (prefix !== "clp" || !nonce || !action || rest.length > 0) {
      await ctx.answerCallbackQuery({ text: "잘못된 Cline 제공자 선택입니다.", show_alert: true });
      return;
    }
    const resolution = clineSnapshots.resolve("provider", nonce, action, {
      userId: ctx.from.id,
      topicId: ctx.callbackQuery.message?.message_thread_id ?? null,
      revision: clineRevision()
    });
    if (!resolution.ok) {
      await ctx.answerCallbackQuery({ text: clineSnapshotError(resolution.reason), show_alert: true });
      return;
    }
    if (resolution.page !== undefined) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({
        reply_markup: clineProviderSnapshotKeyboard(resolution.snapshot, resolution.page)
      });
      return;
    }
    const selected = resolution.item
      ? config.modelCatalog.clineProviders.find((provider) => provider.id === resolution.item!.id)
      : undefined;
    const models = clineModelsForProvider(config.modelCatalog, selected?.id);
    const model = models.find((item) => item.id === selected?.defaultModelId) ?? models[0];
    if (!selected || !model) {
      await ctx.answerCallbackQuery({ text: "Cline 제공자 또는 모델이 더 이상 제공되지 않습니다.", show_alert: true });
      return;
    }
    const target = resolution.snapshot.scope.target;
    if (target.kind === "session") {
      const session = store.getSession(target.sessionId);
      if (!session || session.provider !== "cline") {
        await ctx.answerCallbackQuery({ text: "Cline 세션을 찾을 수 없습니다.", show_alert: true });
        return;
      }
      if (sessions.isActive(session.id)) {
        await ctx.answerCallbackQuery({ text: "실행 중에는 바꿀 수 없습니다. /stop 후 다시 시도하세요.", show_alert: true });
        return;
      }
      const changed = await sessions.updateClineConnection(session.id, {
        clineProviderId: selected.id,
        clineModel: model.id,
        clineReasoning: normalizeClineReasoning(session.clineReasoning, model)
      });
      if (!changed.ok) {
        await ctx.answerCallbackQuery({ text: changed.reason ?? "Cline 연결 변경 실패", show_alert: true });
        return;
      }
    } else {
      const current = store.getSessionDefaults();
      const clineReasoning = normalizeClineReasoning(current.clineReasoning, model);
      store.updateSessionDefaults({
        clineProviderId: selected.id,
        clineModel: model.id,
        clineReasoning
      });
      const pendingKey = pendingStartKey(ctx.from.id, ctx.callbackQuery.message?.message_thread_id);
      const pending = pendingStarts.get(pendingKey);
      if (pending && (pending.provider ?? config.defaultProvider) === "cline") {
        pendingStarts.set(pendingKey, {
          ...pending,
          clineProviderId: selected.id,
          clineModel: model.id,
          clineReasoning
        });
      }
    }
    const modelSnapshot = clineSnapshots.create(
      "model",
      resolution.snapshot.scope,
      models.map((item) => ({ ...item, providerId: selected.id }))
    );
    await ctx.answerCallbackQuery({ text: `${selected.label} 선택` });
    await ctx.reply(`Cline 내부 제공자: ${selected.label}\n모델을 선택하세요.`, {
      reply_markup: clineModelSnapshotKeyboard(modelSnapshot)
    });
  });

  bot.callbackQuery(/^clm:/, async (ctx) => {
    const [prefix, nonce, action, ...rest] = ctx.callbackQuery.data.split(":");
    if (prefix !== "clm" || !nonce || !action || rest.length > 0) {
      await ctx.answerCallbackQuery({ text: "잘못된 Cline 모델 선택입니다.", show_alert: true });
      return;
    }
    const resolution = clineSnapshots.resolve("model", nonce, action, {
      userId: ctx.from.id,
      topicId: ctx.callbackQuery.message?.message_thread_id ?? null,
      revision: clineRevision()
    });
    if (!resolution.ok) {
      await ctx.answerCallbackQuery({ text: clineSnapshotError(resolution.reason), show_alert: true });
      return;
    }
    if (resolution.page !== undefined) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({
        reply_markup: clineModelSnapshotKeyboard(resolution.snapshot, resolution.page)
      });
      return;
    }
    const target = resolution.snapshot.scope.target;
    const storedProviderId = target.kind === "session"
      ? store.getSession(target.sessionId)?.clineProviderId
      : store.getSessionDefaults().clineProviderId;
    // 목록은 clineProviderOption의 폴백(첫 제공자)으로 만들어졌으므로 가드도 같은 해석을
    // 써야 한다. 원본 값을 그대로 비교하면 내부 제공자가 비어 있는 세션(/provider 전환 직후)이
    // 영구히 모델을 고를 수 없게 된다.
    const currentProviderId = clineProviderOption(config.modelCatalog, storedProviderId)?.id;
    if (!resolution.item?.providerId || currentProviderId !== resolution.item.providerId) {
      await ctx.answerCallbackQuery({ text: "Cline 내부 제공자가 변경되었습니다. 모델 목록을 다시 여세요.", show_alert: true });
      return;
    }
    const option = clineModelsForProvider(config.modelCatalog, currentProviderId)
      .find((model) => model.id === resolution.item!.id);
    if (!option) {
      await ctx.answerCallbackQuery({ text: "Cline 모델이 더 이상 제공되지 않습니다.", show_alert: true });
      return;
    }
    if (target.kind === "session") {
      const session = store.getSession(target.sessionId);
      if (!session || session.provider !== "cline") {
        await ctx.answerCallbackQuery({ text: "Cline 세션을 찾을 수 없습니다.", show_alert: true });
        return;
      }
      if (sessions.isActive(session.id)) {
        await ctx.answerCallbackQuery({ text: "실행 중에는 바꿀 수 없습니다. /stop 후 다시 시도하세요.", show_alert: true });
        return;
      }
      const changed = await sessions.updateClineConnection(session.id, {
        clineProviderId: currentProviderId,
        clineModel: option.id,
        clineReasoning: normalizeClineReasoning(session.clineReasoning, option)
      });
      if (!changed.ok) {
        await ctx.answerCallbackQuery({ text: changed.reason ?? "Cline 연결 변경 실패", show_alert: true });
        return;
      }
    } else {
      const current = store.getSessionDefaults();
      const clineReasoning = normalizeClineReasoning(current.clineReasoning, option);
      store.updateSessionDefaults({ clineProviderId: currentProviderId, clineModel: option.id, clineReasoning });
      const pendingKey = pendingStartKey(ctx.from.id, ctx.callbackQuery.message?.message_thread_id);
      const pending = pendingStarts.get(pendingKey);
      if (pending && (pending.provider ?? config.defaultProvider) === "cline") {
        pendingStarts.set(pendingKey, {
          ...pending,
          clineProviderId: currentProviderId,
          clineModel: option.id,
          clineReasoning
        });
      }
    }
    await ctx.answerCallbackQuery({ text: `${option.label} 선택` });
    await ctx.reply(`다음 Cline 실행부터 ${option.label} 모델을 사용합니다.`);
  });

  bot.callbackQuery(/^agygo:/, async (ctx) => {
    const sessionId = ctx.callbackQuery.data.slice("agygo:".length);
    const session = store.getSession(sessionId);
    if (!session || session.provider !== "agy") {
      await ctx.answerCallbackQuery({ text: "Antigravity 세션을 찾을 수 없습니다.", show_alert: true });
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.answerCallbackQuery({ text: "이미 작업이 실행 중입니다.", show_alert: true });
      return;
    }
    if (!sessions.resume(session, "승인합니다. 제시한 계획대로 계속 진행하십시오.")) {
      await ctx.answerCallbackQuery({ text: "후속 작업을 시작할 수 없습니다.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "진행을 시작했습니다." });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    await ctx.reply("승인되어 후속 작업을 시작했습니다.");
  });

  // 새 세션 기본값 패널: 토큰 선택. sett:claude|codex:<0-based-index>

  bot.callbackQuery(/^sett:/, async (ctx) => {
    const rest = ctx.callbackQuery.data.slice("sett:".length);
    const sep = rest.indexOf(":");
    const provider = rest.slice(0, sep);
    const index = Number.parseInt(rest.slice(sep + 1), 10);
    const pendingKey = pendingStartKey(ctx.from.id, ctx.callbackQuery.message?.message_thread_id);
    const pending = pendingStarts.get(pendingKey);

    if (provider === "claude") {
      if (!Number.isInteger(index) || index < 0 || index >= config.claudeCodeOauthTokens.length) {
        await ctx.answerCallbackQuery({ text: "지원하지 않는 Claude 토큰입니다.", show_alert: true });
        return;
      }
      const defaults = store.updateSessionDefaults({ claudeTokenIndex: index });
      if (pending && (pending.provider ?? config.defaultProvider) === "claude") {
        pendingStarts.set(pendingKey, { ...pending, claudeTokenIndex: index });
      }
      await ctx.answerCallbackQuery({ text: `Claude 토큰 #${index + 1} 선택` });
      await ctx.reply(`새 Claude 세션 기본 토큰: #${index + 1}`, {
        reply_markup: defaultPanelKeyboard(defaults)
      });
      return;
    }

    if (provider === "codex") {
      if (!Number.isInteger(index) || index < 0 || index >= config.codexAccountHomes.length) {
        await ctx.answerCallbackQuery({ text: "지원하지 않는 Codex 토큰입니다.", show_alert: true });
        return;
      }
      const codexHome = config.codexAccountHomes[index] ?? null;
      const defaults = store.updateSessionDefaults({ codexHome });
      if (pending && (pending.provider ?? config.defaultProvider) === "codex") {
        pendingStarts.set(pendingKey, { ...pending, codexHome });
      }
      await ctx.answerCallbackQuery({ text: `Codex 토큰 #${index + 1} 선택` });
      await ctx.reply(`새 Codex 세션 기본 토큰: #${index + 1}`, {
        reply_markup: defaultPanelKeyboard(defaults)
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: "지원하지 않는 토큰 선택입니다.", show_alert: true });
  });

  bot.callbackQuery(/^noop:/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "변경할 설정이 없습니다." });
  });

  // 새 세션 기본값 패널: 모델 선택. setm:<provider>:<id>

  bot.callbackQuery(/^setm:/, async (ctx) => {
    const rest = ctx.callbackQuery.data.slice("setm:".length);
    const sep = rest.indexOf(":");
    const provider = rest.slice(0, sep) as ProviderKind;
    const modelId = rest.slice(sep + 1);
    if (provider === "cline") {
      await ctx.answerCallbackQuery({
        text: "Cline 모델 목록이 변경될 수 있습니다. 모델 버튼을 다시 여세요.",
        show_alert: true
      });
      return;
    }
    if (provider === "codex") {
      const option = config.modelCatalog.codexModels.find((item) => item.id === modelId);
      if (!option) {
        await ctx.answerCallbackQuery({ text: "지원하지 않는 모델입니다.", show_alert: true });
        return;
      }
      const defaults = store.updateSessionDefaults({ codexModel: option.id });
      await ctx.answerCallbackQuery({ text: `${option.label} 기본값` });
      await ctx.reply(`새 세션 기본 Codex 모델: ${option.label}`, {
        reply_markup: defaultPanelKeyboard(defaults)
      });
      return;
    }
    if (provider === "agy") {
      const option = config.modelCatalog.agyModels.find((item) => item.id === modelId);
      if (!option) {
        await ctx.answerCallbackQuery({ text: "지원하지 않는 모델입니다.", show_alert: true });
        return;
      }
      const defaults = store.updateSessionDefaults({ agyModel: option.id, agyThinkingLevel: "" });
      await ctx.answerCallbackQuery({ text: `${option.label} 기본값` });
      await ctx.reply(`새 세션 기본 Antigravity 모델: ${option.label}`, {
        reply_markup: defaultPanelKeyboard(defaults)
      });
      return;
    }
    if (provider === "grok") {
      const option = config.modelCatalog.grokModels.find((item) => item.id === modelId);
      if (!option) {
        await ctx.answerCallbackQuery({ text: "지원하지 않는 모델입니다.", show_alert: true });
        return;
      }
      const defaults = store.updateSessionDefaults({ grokModel: option.id });
      await ctx.answerCallbackQuery({ text: `${option.label} 기본값` });
      await ctx.reply(`새 세션 기본 Grok 모델: ${option.label}`, {
        reply_markup: defaultPanelKeyboard(defaults)
      });
      return;
    }
    const option = config.modelCatalog.claudeModels.find((item) => item.id === modelId);
    if (!option) {
      await ctx.answerCallbackQuery({ text: "지원하지 않는 모델입니다.", show_alert: true });
      return;
    }
    const defaults = store.updateSessionDefaults({ claudeModel: option.id });
    await ctx.answerCallbackQuery({ text: `${option.label} 기본값` });
    await ctx.reply(`새 세션 기본 Claude 모델: ${option.label}`, {
      reply_markup: defaultPanelKeyboard(defaults)
    });
  });

  // 새 세션 기본값 패널: 추론 강도/thinking 선택. setr:<provider>:<id>

  bot.callbackQuery(/^setr:/, async (ctx) => {
    const rest = ctx.callbackQuery.data.slice("setr:".length);
    const sep = rest.indexOf(":");
    const provider = rest.slice(0, sep) as ProviderKind;
    const valueId = rest.slice(sep + 1);
    if (provider === "codex") {
      const current = store.getSessionDefaults();
      const option = codexReasoningOptionsForModel(config.modelCatalog, current.codexModel)
        .find((item) => item.id === valueId);
      if (!option) {
        await ctx.answerCallbackQuery({ text: "지원하지 않는 추론 강도입니다.", show_alert: true });
        return;
      }
      const defaults = store.updateSessionDefaults({ codexReasoning: option.id });
      await ctx.answerCallbackQuery({ text: `${option.label} 기본값` });
      await ctx.reply(`새 세션 기본 Codex 추론 강도: ${option.label}`, {
        reply_markup: defaultPanelKeyboard(defaults)
      });
      return;
    }
    if (provider === "agy") {
      const current = store.getSessionDefaults();
      const option = agyThinkingOptionsForModel(config.modelCatalog, current.agyModel)
        .find((item) => item.id === valueId);
      if (!option) {
        await ctx.answerCallbackQuery({ text: "지원하지 않는 추론 강도입니다.", show_alert: true });
        return;
      }
      const defaults = store.updateSessionDefaults({ agyThinkingLevel: option.id });
      await ctx.answerCallbackQuery({ text: `${option.label} 기본값` });
      await ctx.reply(`새 세션 기본 Antigravity 추론 강도: ${option.label}`, {
        reply_markup: defaultPanelKeyboard(defaults)
      });
      return;
    }
    if (provider === "grok") {
      const option = grokReasoningOptions(config.modelCatalog).find((item) => item.id === valueId);
      if (!option) {
        await ctx.answerCallbackQuery({ text: "지원하지 않는 Grok 추론 강도입니다.", show_alert: true });
        return;
      }
      const defaults = store.updateSessionDefaults({ grokReasoning: option.id });
      await ctx.answerCallbackQuery({ text: `${option.label} 기본값` });
      await ctx.reply(`새 세션 기본 Grok 추론 강도: ${option.label}`, {
        reply_markup: defaultPanelKeyboard(defaults)
      });
      return;
    }
    if (provider === "cline") {
      const current = store.getSessionDefaults();
      const model = clineModelOption(config.modelCatalog, current.clineProviderId, current.clineModel);
      const option = clineReasoningOptionsForModel(model).find((value) => value === valueId);
      if (!option) {
        await ctx.answerCallbackQuery({ text: "지원하지 않는 Cline 추론 강도입니다.", show_alert: true });
        return;
      }
      const defaults = store.updateSessionDefaults({ clineReasoning: option });
      await ctx.answerCallbackQuery({ text: `${clineReasoningLabel(option)} 기본값` });
      await ctx.reply(`새 세션 기본 Cline 추론 강도: ${clineReasoningLabel(option)}`, {
        reply_markup: defaultPanelKeyboard(defaults)
      });
      return;
    }
    // Claude: thinking on(adaptive)/off.
    if (valueId !== "adaptive" && valueId !== "off") {
      await ctx.answerCallbackQuery({ text: "지원하지 않는 thinking입니다.", show_alert: true });
      return;
    }
    const defaults = store.updateSessionDefaults({ thinking: valueId });
    await ctx.answerCallbackQuery({ text: `thinking ${valueId === "off" ? "off" : "on"} 기본값` });
    await ctx.reply(`새 세션 기본 thinking: ${valueId === "off" ? "off" : "on"}`, {
      reply_markup: defaultPanelKeyboard(defaults)
    });
  });

  // 새 세션 기본값 패널: Claude 작업량(effort) 선택. sete:<provider>:<id>
  // thinking(setr:)과 별개 축이며 Claude 전용이다.

  bot.callbackQuery(/^sete:/, async (ctx) => {
    const rest = ctx.callbackQuery.data.slice("sete:".length);
    const sep = rest.indexOf(":");
    const provider = rest.slice(0, sep) as ProviderKind;
    const valueId = rest.slice(sep + 1);
    if (provider !== "claude") {
      await ctx.answerCallbackQuery({ text: "작업량은 Claude 기본값 전용입니다.", show_alert: true });
      return;
    }
    const current = store.getSessionDefaults();
    const option = claudeEffortOptionsForModel(config.modelCatalog, current.claudeModel)
      .find((item) => item.id === valueId);
    if (!option) {
      await ctx.answerCallbackQuery({ text: "지원하지 않는 작업량입니다.", show_alert: true });
      return;
    }
    const defaults = store.updateSessionDefaults({ claudeEffort: option.id });
    await ctx.answerCallbackQuery({ text: `${option.label} 기본값` });
    await ctx.reply(`새 세션 기본 Claude 작업량: ${option.label}`, {
      reply_markup: defaultPanelKeyboard(defaults)
    });
  });
}
