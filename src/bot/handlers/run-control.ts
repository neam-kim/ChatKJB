import { Bot } from "grammy";
import { buildServiceRecoveryPrompt } from "../../session-prompts.js";
import { safeErrorMessage } from "../../telegram-transport.js";
import type { ProjectConfig, SessionRecord } from "../../types.js";
import type { BotDeps } from "../deps.js";
import {
  providerDisplayLabel
} from "../formatting.js";
import { pendingStartKey } from "../pending-keys.js";

function hasProviderContext(session: SessionRecord): boolean {
  if (session.provider === "claude") return !!session.sdkSessionId;
  if (session.provider === "codex") return !!session.codexThreadId;
  if (session.provider === "agy") return !!session.agyConversationId;
  if (session.provider === "grok") return !!session.grokSessionId;
  return !!session.clineSessionId;
}

export function registerRunControlHandlers(bot: Bot, deps: BotDeps): void {
  const {
    config,
    store,
    permissions,
    sessions,
    pendingStarts,
    startSessionFromOptions,
    selectProjectForTask
  } = deps;

  bot.command("stop", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const session = store.getSessionByTopic(config.chatId, topicId);
    if (!session || !sessions.stop(session.id)) {
      await ctx.reply("현재 실행 중인 작업이 없습니다.");
      return;
    }
    await ctx.reply("중단 요청을 보냈습니다.");
  });

  bot.command("restop", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const session = store.getSessionByTopic(config.chatId, topicId);
    if (!session || !sessions.cancelLimitResume(session.id)) {
      await ctx.reply("취소할 한도 회복 자동 재개 예약이 없습니다.");
      return;
    }
    await ctx.reply("한도 회복 후 자동 재개 예약을 취소했습니다. 이후 이어가려면 새 지시를 보내세요.");
  });

  bot.command("resume", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const session = store.getSessionByTopic(config.chatId, topicId);
    if (!session) {
      await ctx.reply("이 토픽에 연결된 세션이 없습니다.");
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.reply("현재 세션은 이미 실행 중입니다.");
      return;
    }
    if (!sessions.resume(session, buildServiceRecoveryPrompt())) {
      await ctx.reply("이어 갈 제공자 문맥이 없습니다. 새 지시를 보내 새 작업으로 시작하세요.");
      return;
    }
    await ctx.reply("직전 작업을 기존 제공자 문맥에서 재개했습니다.");
  });

  bot.command("reset", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const session = store.getSessionByTopic(config.chatId, topicId);
    if (!session) {
      await ctx.reply("이 토픽에 연결된 세션이 없습니다.");
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.reply("실행 중에는 문맥을 초기화할 수 없습니다. /stop 후 다시 시도하세요.");
      return;
    }
    const result = await sessions.resetContext(session.id);
    if (!result.ok) {
      await ctx.reply(result.reason ?? "문맥을 초기화하지 못했습니다.");
      return;
    }
    await ctx.reply("대화 문맥을 초기화했습니다. 다음 메시지부터 새 문맥으로 시작합니다.");
  });

  bot.command("steer", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    const prompt = ctx.match.trim();
    if (!session || !prompt) {
      await ctx.reply("실행 중인 세션 토픽에서 `/steer 수정할 지시` 형식으로 사용하세요.");
      return;
    }
    if (await permissions.handleTextInput(session.id, prompt)) {
      await ctx.reply("대기 중인 질문에 답변을 전달했습니다.");
      return;
    }
    const steerResult = sessions.steer(session.id, prompt);
    if (!steerResult) {
      await ctx.reply("현재 실행 중인 작업이 없습니다. 일반 메시지로 후속 작업을 시작하세요.");
      return;
    }
    await ctx.reply(
      steerResult === "restarted"
        ? "현재 Codex 턴을 중단하고 /steer 지시를 우선 반영해 다시 시작합니다."
        : session.provider === "claude"
          ? "현재 실행 중인 작업에 즉시 반영할 메시지를 보냈습니다."
          : "현재 턴이 끝나는 즉시 최우선으로 반영할 메시지를 보냈습니다."
    );
  });

  bot.command("next", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    const prompt = ctx.match.trim();
    if (!session || !prompt) {
      await ctx.reply("세션 토픽에서 `/next 이어서 할 작업` 형식으로 사용하세요.");
      return;
    }
    if (sessions.queueFollowUp(session.id, prompt)) {
      await ctx.reply("현재 작업이 끝난 뒤 실행하도록 후속 작업을 예약했습니다.");
      return;
    }
    if (sessions.resume(session, prompt)) {
      await ctx.reply("현재 작업이 끝난 상태라 후속 작업을 바로 시작했습니다.");
      return;
    }
    await ctx.reply("후속 작업을 예약할 수 없습니다. 이어 갈 대화 문맥이 아직 생성되지 않았습니다.");
  });

  bot.command("fork", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const hasContext = hasProviderContext(session);
    if (!hasContext || sessions.isActive(session.id)) {
      await ctx.reply("분기할 수 있는 완료 세션이 없습니다.");
      return;
    }
    const project = [...config.projects, ...store.listProjects()]
      .find((item) => item.name === session.projectName);
    if (!project) {
      await ctx.reply("프로젝트 설정을 찾을 수 없습니다.");
      return;
    }
    let handoffSummary: string | undefined;
    if (session.provider !== "claude") {
      await ctx.reply("현재 대화 문맥을 새 분기로 인계하기 위해 요약하는 중입니다…");
      const summary = await sessions.prepareFork(session);
      if (!summary) {
        await ctx.reply("분기용 문맥 요약을 만들 수 없습니다.");
        return;
      }
      handoffSummary = summary;
    }
    pendingStarts.set(pendingStartKey(ctx.from!.id, topicId), {
      kind: "project",
      project,
      ...(session.provider === "claude" && session.sdkSessionId
        ? { resumeSessionId: session.sdkSessionId, forkSession: true }
        : {}),
      provider: session.provider,
      model: session.model ?? undefined,
      thinking: session.thinking ?? undefined,
      claudeEffort: session.claudeEffort ?? undefined,
      claudeTokenIndex: session.claudeTokenIndex ?? undefined,
      codexModel: session.codexModel ?? undefined,
      codexReasoning: session.codexReasoning ?? undefined,
      codexHome: session.codexHome ?? undefined,
      agyModel: session.agyModel ?? undefined,
      agyThinkingLevel: session.agyThinkingLevel ?? undefined,
      grokModel: session.grokModel ?? undefined,
      grokReasoning: session.grokReasoning ?? undefined,
      clineProviderId: session.clineProviderId ?? undefined,
      clineModel: session.clineModel ?? undefined,
      clineReasoning: session.clineReasoning ?? undefined,
      ...(handoffSummary ? { handoffSummary } : {}),
      leanMode: session.leanMode
    });
    await ctx.reply("새 분기에서 실행할 지시를 입력하세요.");
  });

  bot.command("compact", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const hasContext = hasProviderContext(session);
    if (!hasContext) {
      await ctx.reply(`아직 압축할 ${providerDisplayLabel(session.provider)} 세션 문맥이 없습니다.`);
      return;
    }
    if (!sessions.compact(session, ctx.match)) {
      await ctx.reply("현재 작업이 실행 중입니다. 완료하거나 /stop으로 중단한 뒤 압축하세요.");
      return;
    }
    await ctx.reply(
      ctx.match.trim()
        ? `컨텍스트 압축을 시작했습니다.\n보존 초점: ${ctx.match.trim().slice(0, 500)}`
        : `컨텍스트 압축을 시작했습니다. ${providerDisplayLabel(session.provider)} 문맥을 압축한 뒤 새 대화로 이어갑니다.`
    );
  });

  bot.command("goal", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const arg = ctx.match.trim();
    let session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    let startedFromPendingGoal = false;
    if (!session) {
      const pendingKey = pendingStartKey(ctx.from!.id, topicId);
      const pending = pendingStarts.get(pendingKey);
      if (!pending) {
        await ctx.reply("세션 토픽 안에서 사용하세요.");
        return;
      }
      if (!arg) {
        await ctx.reply("사용법: /goal <완료 조건>\n빈 목표는 새 세션을 시작하지 않습니다.");
        return;
      }
      if (arg.toLowerCase() === "clear") {
        await ctx.reply("아직 세션이 없어 해제할 목표가 없습니다. 먼저 작업을 입력하세요.");
        return;
      }
      const pendingProvider = pending.provider ?? config.defaultProvider;
      if (pendingProvider !== "claude" && pendingProvider !== "codex") {
        await ctx.reply(
          `${providerDisplayLabel(pendingProvider)}는 네이티브 goal 기능을 제공하지 않습니다. `
          + "ChatKJB 자체 goal 자동 진행 기능은 제거되었습니다. 일반 작업 지시를 보내 주세요."
        );
        return;
      }
      pendingStarts.delete(pendingKey);
      let project: ProjectConfig;
      try {
        project = pending.kind === "project"
          ? pending.project
          : await selectProjectForTask(arg, pending.selectionDefaults);
      } catch (error) {
        pendingStarts.set(pendingKey, pending);
        await ctx.reply(
          `프로젝트 자동 선택 실패: ${safeErrorMessage(error)}\n`
          + "이 작업 토픽은 유지되므로 목표를 수정해 다시 시도하실 수 있습니다."
        );
        return;
      }
      try {
        session = await startSessionFromOptions(
          project,
          arg,
          pending,
          pending.pendingTopicId ?? topicId
        );
        startedFromPendingGoal = true;
      } catch (error) {
        if (!topicId || !store.getSessionByTopic(config.chatId, topicId)) {
          pendingStarts.set(pendingKey, pending);
        }
        await ctx.reply(`세션 시작 중 오류가 발생했습니다: ${safeErrorMessage(error)}`);
        return;
      }
    }
    if (session.provider !== "claude" && session.provider !== "codex") {
      sessions.clearGoal(session.id);
      await ctx.reply(
        `${providerDisplayLabel(session.provider)}는 네이티브 goal 기능을 제공하지 않습니다. `
        + "ChatKJB 자체 goal 자동 진행 기능은 제거되었습니다."
      );
      return;
    }
    if (!arg) {
      await ctx.reply(
        session.goalCondition
          ? `현재 네이티브 목표: ${session.goalCondition}\n해제하려면 /goal clear`
          : "설정된 목표가 없습니다.\n예: /goal 모든 테스트가 통과하고 lint가 깨끗하다\n"
          + "Claude는 네이티브 `/goal`, Codex는 app-server의 네이티브 goal API로 전달합니다.\n"
          + "Antigravity·Grok에는 동등한 네이티브 기능이 없어 지원하지 않습니다."
      );
      return;
    }
    if (arg.toLowerCase() === "clear") {
      let had = false;
      try {
        had = await sessions.clearGoalForCommand(session.id);
      } catch (error) {
        await ctx.reply(`목표 해제 중 오류가 발생했습니다: ${safeErrorMessage(error)}`);
        return;
      }
      await ctx.reply(had ? "네이티브 목표 해제를 요청했습니다." : "해제할 목표가 없습니다.");
      return;
    }
    let result: Awaited<ReturnType<typeof sessions.setGoal>>;
    try {
      result = await sessions.setGoal(session.id, arg);
    } catch (error) {
      await ctx.reply(`목표 설정 중 오류가 발생했습니다: ${safeErrorMessage(error)}`);
      return;
    }
    if (result === "native") {
      await ctx.reply(
        `목표를 네이티브 goal로 설정했습니다.\n조건: ${arg}\n`
        + "ChatKJB는 이 조건을 상태 표시에도 보존합니다. /goal clear 또는 /stop 으로 중단."
      );
    } else if (result === "active") {
      await ctx.reply(
        `목표를 저장했습니다. 현재 실행 중인 작업에서 네이티브 세션 핸들이 확인되는 즉시 제공자 goal로 전달합니다.\n조건: ${arg}`
      );
    } else if (result === "unsupported") {
      await ctx.reply(`${providerDisplayLabel(session.provider)}의 네이티브 goal 기능을 사용할 수 없습니다.`);
    } else {
      await ctx.reply(
        startedFromPendingGoal
          ? `세션을 시작했고 네이티브 goal 전달을 예약했습니다.\n조건: ${arg}`
          : session.provider === "codex"
            ? `목표를 저장했습니다. Codex 스레드가 생기면 네이티브 goal로 동기화합니다.\n조건: ${arg}`
            : `목표를 저장했습니다. Claude 세션 ID가 생기면 네이티브 /goal로 동기화합니다.\n조건: ${arg}`
      );
    }
  });

  // /route <작업 설명>: 강점 사전(매일 03:00 갱신)과 작업유형 규칙으로 적합한 제공자를
  // 추천한다. 1단계 라우터 — 추천만 하고 자동 배정은 하지 않는다(사용자가 최종 판단).

  bot.callbackQuery(/^stop:/, async (ctx) => {
    const sessionId = ctx.callbackQuery.data.slice("stop:".length);
    const stopped = sessions.stop(sessionId);
    await ctx.answerCallbackQuery({ text: stopped ? "중단 요청을 보냈습니다." : "실행 중이 아닙니다." });
  });
}
