import { Bot } from "grammy";
import { clineModelsForProvider } from "../../cline-sdk.js";
import type { ProjectConfig } from "../../types.js";
import { safeErrorMessage } from "../../telegram-transport.js";
import type { BotDeps } from "../deps.js";
import {
  formatTimestamp,
  providerDisplayLabel
} from "../formatting.js";
import {
  defaultsEffortKeyboard,
  defaultsModelKeyboard,
  defaultsProviderKeyboard,
  defaultsReasoningKeyboard,
  defaultsSummary,
  defaultsTokenKeyboard
} from "../keyboards.js";
import {
  clineModelSnapshotKeyboard,
  clineProviderOption,
  clineProviderSnapshotKeyboard
} from "../keyboards.js";
import {
  clineCatalogRevision,
  clineSnapshotStoreFor
} from "../cline-snapshots.js";
import { pendingStartKey, selectedClaudeTokenIndex, selectedCodexAccountIndex } from "../pending-keys.js";
import { parseReserveTime } from "../time-parse.js";

export function registerMessageHandlers(bot: Bot, deps: BotDeps): void {
  const {
    config,
    store,
    transport,
    permissions,
    sessions,
    pendingStarts,
    pendingReserves,
    defaultPanelKeyboard,
    startSessionFromOptions,
    selectProjectForTask,
    scheduleReservedTask,
    handleFile,
    handleMediaMessage,
    resolveSessionUploadPath
  } = deps;
  const clineSnapshots = clineSnapshotStoreFor(bot);

  const clineRevision = () => clineCatalogRevision({
    providers: config.modelCatalog.clineProviders,
    modelsByProvider: config.modelCatalog.clineModelsByProvider
  });

  bot.callbackQuery(/^(ap|q):/, async (ctx) => {
    const answer = await permissions.handleCallback(ctx.callbackQuery.data);
    await ctx.answerCallbackQuery({ text: answer });
  });

  bot.command("upload", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!topicId || !session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const inputPath = ctx.match.trim();
    if (!inputPath) {
      await ctx.reply("보낼 파일 경로를 입력하세요.\n예: /upload output/result.pdf");
      return;
    }
    try {
      const filePath = await resolveSessionUploadPath(session.cwd, inputPath);
      await transport.sendFile(config.chatId, topicId, filePath);
    } catch (error) {
      await ctx.reply(`파일 전송 실패: ${safeErrorMessage(error)}`);
    }
  });

  // 상시 기본값 패널(reply 키보드) 버튼 처리. message:text보다 먼저 등록해 일반 메시지로
  // 새지 않게 한다. 버튼 라벨은 동적이라 접두 이모지로 매칭한다.

  bot.hears(/^⚙️ 새 세션 기본값/, async (ctx) => {
    const defaults = store.getSessionDefaults();
    await ctx.reply(`현재 새 세션 기본값: ${defaultsSummary(defaults, config.modelCatalog)}`, {
      reply_markup: defaultPanelKeyboard(defaults)
    });
  });

  bot.hears(/^🤖 제공자/, async (ctx) => {
    const current = store.getSessionDefaults();
    await ctx.reply(
      `새 세션 기본 제공자를 선택하세요. (현재: ${providerDisplayLabel(current.provider)})`,
      { reply_markup: defaultsProviderKeyboard(current.provider, config.availableProviders) }
    );
  });

  bot.hears(/^🧠 모델/, async (ctx) => {
    const defaults = store.getSessionDefaults();
    if (defaults.provider === "cline") {
      const provider = clineProviderOption(config.modelCatalog, defaults.clineProviderId);
      const models = clineModelsForProvider(config.modelCatalog, provider?.id);
      if (!provider || models.length === 0) {
        await ctx.reply("선택 가능한 Cline 내부 제공자 또는 모델이 없습니다. Cline 설정을 확인한 뒤 다시 시도하세요.");
        return;
      }
      const snapshot = clineSnapshots.create("model", {
        userId: ctx.from!.id,
        topicId: ctx.message!.message_thread_id ?? null,
        target: { kind: "defaults" },
        revision: clineRevision()
      }, models.map((model) => ({ ...model, providerId: provider.id })));
      await ctx.reply(`Cline ${provider.label} 모델을 선택하세요.`, {
        reply_markup: clineModelSnapshotKeyboard(snapshot)
      });
      return;
    }
    await ctx.reply(
      `${providerDisplayLabel(defaults.provider)} 모델을 선택하세요.`,
      { reply_markup: defaultsModelKeyboard(defaults, config.modelCatalog) }
    );
  });

  bot.hears(/^💭 /, async (ctx) => {
    // 순환 토글 대신, 강도/thinking 선택지를 개별 버튼으로 노출한다.
    const defaults = store.getSessionDefaults();
    const prompt = defaults.provider === "codex"
      ? "새 세션 기본 Codex 추론 강도를 선택하세요."
      : defaults.provider === "agy"
        ? "새 세션 기본 Antigravity 추론 강도를 선택하세요."
        : defaults.provider === "grok"
          ? "새 세션 기본 Grok 추론 강도를 선택하세요."
          : defaults.provider === "cline"
            ? "새 세션 기본 Cline 추론 강도를 선택하세요."
          : "새 세션 기본 Claude thinking을 선택하세요.";
    await ctx.reply(prompt, {
      reply_markup: defaultsReasoningKeyboard(defaults, config.modelCatalog)
    });
  });

  bot.hears(/^🛠️ 작업량/, async (ctx) => {
    // Claude의 작업량(effort)은 thinking(💭)과 별개 축이다. 개별 버튼으로 노출한다.
    const defaults = store.getSessionDefaults();
    if (defaults.provider !== "claude") {
      await ctx.reply(
        "작업량(effort)은 Claude 기본값 전용입니다. Codex·Antigravity는 추론 강도(💭)가 작업량을 겸합니다.",
        { reply_markup: defaultPanelKeyboard(defaults) }
      );
      return;
    }
    await ctx.reply("새 세션 기본 Claude 작업량을 선택하세요. (thinking과 별개 축)", {
      reply_markup: defaultsEffortKeyboard(defaults, config.modelCatalog)
    });
  });

  bot.hears(/^🔑 토큰/, async (ctx) => {
    const defaults = store.getSessionDefaults();
    if (defaults.provider === "claude") {
      if (config.claudeCodeOauthTokens.length <= 1) {
        await ctx.reply("선택 가능한 Claude 토큰이 1개뿐입니다.", {
          reply_markup: defaultPanelKeyboard(defaults)
        });
        return;
      }
      const currentIndex = selectedClaudeTokenIndex(defaults.claudeTokenIndex, config.claudeCodeOauthTokens.length);
      await ctx.reply("새 세션 기본 Claude 토큰을 선택하세요.", {
        reply_markup: defaultsTokenKeyboard("claude", currentIndex, config.claudeCodeOauthTokens.length)
      });
      return;
    }
    if (defaults.provider !== "codex") {
      await ctx.reply("토큰 선택은 Claude/Codex 기본값 전용입니다.", {
        reply_markup: defaultPanelKeyboard(defaults)
      });
      return;
    }
    if (config.codexAccountHomes.length <= 1) {
      await ctx.reply("선택 가능한 Codex 토큰이 1개뿐입니다.", {
        reply_markup: defaultPanelKeyboard(defaults)
      });
      return;
    }
    const currentIndex = selectedCodexAccountIndex(defaults.codexHome, config.codexAccountHomes);
    await ctx.reply("새 세션 기본 Codex 토큰을 선택하세요.", {
      reply_markup: defaultsTokenKeyboard("codex", currentIndex, config.codexAccountHomes.length)
    });
  });

  bot.hears(/^🔌 Cline 제공자/, async (ctx) => {
    const defaults = store.getSessionDefaults();
    if (defaults.provider !== "cline") {
      await ctx.reply("Cline을 새 세션 기본 제공자로 먼저 선택하세요.", {
        reply_markup: defaultPanelKeyboard(defaults)
      });
      return;
    }
    const providers = config.modelCatalog.clineProviders;
    if (providers.length === 0) {
      await ctx.reply("선택 가능한 Cline 내부 제공자가 없습니다. Cline 설정을 확인한 뒤 다시 시도하세요.");
      return;
    }
    const snapshot = clineSnapshots.create("provider", {
      userId: ctx.from!.id,
      topicId: ctx.message!.message_thread_id ?? null,
      target: { kind: "defaults" },
      revision: clineRevision()
    }, providers);
    await ctx.reply("새 세션에서 사용할 Cline 내부 제공자를 선택하세요.", {
      reply_markup: clineProviderSnapshotKeyboard(snapshot)
    });
  });

  bot.hears(/^➖/, async (ctx) => {
    // Cline 외 제공자의 예약 슬롯.
    await ctx.reply("아직 배선되지 않은 예약 슬롯입니다(추후 추가 예정).");
  });

  bot.on("message:text", async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    const pendingKey = pendingStartKey(ctx.from.id, topicId);
    if (ctx.message.text.startsWith("/")) {
      const existing = topicId
        ? store.getSessionByTopic(config.chatId, topicId)
        : undefined;
      if (!existing) {
        await ctx.reply("이 명령은 ChatKJB 명령이 아니며, 전달할 세션도 없습니다. /new로 새 작업을 시작하세요.");
        return;
      }
      if (!sessions.runNativeSlashCommand(existing, ctx.message.text)) {
        await ctx.reply("네이티브 명령을 전달하지 못했습니다. 실행 중인 작업이 있거나 이어 갈 세션 문맥이 없습니다.");
        return;
      }
      await ctx.reply(`${providerDisplayLabel(existing.provider)} 네이티브 명령으로 전달했습니다: ${ctx.message.text.trim()}`);
      return;
    }
    const pendingReserve = pendingReserves.get(pendingKey);
    if (pendingReserve) {
      const parsed = parseReserveTime(ctx.message.text, new Date());
      if (!parsed) {
        await ctx.reply(
          "예약 시간을 해석하지 못했습니다.\n"
          + "예: 내일 오전 9시 README 점검해줘\n"
          + "예: 30분 뒤 테스트 실행\n"
          + "예: 2026-06-30 09:00 README 점검해줘"
        );
        return;
      }
      if (parsed.dueAt <= Date.now() + 5_000) {
        await ctx.reply("예약 시각은 현재보다 5초 이상 뒤여야 합니다.");
        return;
      }
      // 선택기는 최대 60초 걸릴 수 있으므로 await 전에 pending을 선점한다. 실패하면
      // 복원하여 재시도할 수 있게 하고, 동시 입력은 중복 예약을 만들지 못하게 한다.
      pendingReserves.delete(pendingKey);
      let project: ProjectConfig;
      try {
        project = pendingReserve.kind === "project"
          ? pendingReserve.project
          : await selectProjectForTask(parsed.prompt, pendingReserve.selectionDefaults);
      } catch (error) {
        pendingReserves.set(pendingKey, pendingReserve);
        await ctx.reply(
          `프로젝트 자동 선택 실패: ${safeErrorMessage(error)}\n`
          + "이 예약 토픽은 유지되므로 입력을 수정해 다시 시도하실 수 있습니다."
        );
        return;
      }
      let task;
      try {
        task = store.createReservedTask({
          chatId: config.chatId,
          projectName: project.name,
          prompt: parsed.prompt,
          dueAt: parsed.dueAt,
          topicId: pendingReserve.topicId,
          startOptions: pendingReserve.startOptions
        });
      } catch (error) {
        pendingReserves.set(pendingKey, pendingReserve);
        await ctx.reply(
          `예약 저장 실패: ${safeErrorMessage(error)}\n`
          + "이 예약 토픽은 유지되므로 다시 시도하실 수 있습니다."
        );
        return;
      }
      try {
        scheduleReservedTask(task);
      } catch (error) {
        const message = safeErrorMessage(error);
        // DB insert 뒤 메모리 타이머 등록만 실패하면 재시도와 기존 레코드가 둘 다
        // pending인 부분 커밋이 된다. 최초 레코드를 terminal error로 바꾼 뒤에만
        // 입력 상태를 복원하여 중복 실행을 막는다.
        store.updateReservedTask(task.id, { status: "error", errorMessage: message });
        pendingReserves.set(pendingKey, pendingReserve);
        await ctx.reply(
          `예약 스케줄 등록 실패: ${message}\n`
          + "실패한 예약은 오류 상태로 기록했으며, 이 토픽에서 다시 시도하실 수 있습니다."
        );
        return;
      }
      await ctx.reply(
        `예약했습니다.\n`
        + `${project.name} · ${formatTimestamp(task.dueAt)}\n`
        + `${pendingReserve.defaultsSummaryText}\n`
        + task.prompt
      );
      return;
    }
    const existing = topicId
      ? store.getSessionByTopic(config.chatId, topicId)
      : undefined;

    if (existing && await permissions.handleTextInput(existing.id, ctx.message.text)) {
      await ctx.reply("직접 답변을 전달했습니다.");
      return;
    }

    const pending = pendingStarts.get(pendingKey);
    if (pending) {
      // text/file/goal 처리기가 공유하는 map에서 await 전에 선점해야 같은 토픽에
      // 세션이 두 개 생기는 경쟁을 막을 수 있다.
      pendingStarts.delete(pendingKey);
      let project: ProjectConfig;
      try {
        project = pending.kind === "project"
          ? pending.project
          : await selectProjectForTask(ctx.message.text, pending.selectionDefaults);
        await startSessionFromOptions(
          project,
          ctx.message.text,
          pending,
          pending.pendingTopicId
        );
      } catch (error) {
        if (!topicId || !store.getSessionByTopic(config.chatId, topicId)) {
          pendingStarts.set(pendingKey, pending);
        }
        await ctx.reply(
          `프로젝트 자동 선택 실패: ${safeErrorMessage(error)}\n`
          + "이 작업 토픽은 유지되므로 지시를 수정해 다시 시도하실 수 있습니다."
        );
        return;
      }
      return;
    }

    if (!existing) {
      await ctx.reply("/new로 새 작업을 시작하거나 세션 토픽에 메시지를 입력하세요.");
      return;
    }
    if (sessions.isActive(existing.id) && !sessions.isFinalizing(existing.id)) {
      await ctx.reply(
        "현재 작업이 실행 중입니다.\n"
        + "현재 작업을 수정하려면 `/steer 지시`, 끝난 뒤 실행하려면 `/next 지시`를 사용하세요."
      );
      return;
    }
    if (!sessions.resume(existing, ctx.message.text)) {
      await ctx.reply("이 세션은 이미 실행 중이거나 아직 이어 갈 대화 문맥이 없습니다.");
      return;
    }
    await ctx.reply("후속 작업을 시작했습니다.");
  });

  // 사진·문서·오디오·동영상은 앨범(미디어 그룹)으로 묶여 올 수 있으므로 media_group_id로
  // 코얼레싱해 한 번에 처리한다. 그룹이 아니면 media_group_id가 undefined라 즉시 단건 처리된다.
  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1)!;
    await handleMediaMessage(
      ctx,
      { fileId: photo.file_id, filename: `photo_${photo.file_unique_id}.jpg`, fileType: "사진" },
      ctx.message.media_group_id,
      ctx.message.caption
    );
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    await handleMediaMessage(
      ctx,
      { fileId: doc.file_id, filename: doc.file_name ?? `document_${doc.file_unique_id}`, fileType: "문서" },
      ctx.message.media_group_id,
      ctx.message.caption
    );
  });

  bot.on("message:audio", async (ctx) => {
    const audio = ctx.message.audio;
    await handleMediaMessage(
      ctx,
      { fileId: audio.file_id, filename: audio.file_name ?? `audio_${audio.file_unique_id}.mp3`, fileType: "오디오", transcribe: true },
      ctx.message.media_group_id,
      ctx.message.caption
    );
  });

  bot.on("message:voice", async (ctx) => {
    const voice = ctx.message.voice;
    await handleFile(ctx, voice.file_id, `voice_${voice.file_unique_id}.ogg`, "음성 메시지", ctx.message.caption, { transcribe: true });
  });

  bot.on("message:video", async (ctx) => {
    const video = ctx.message.video;
    await handleMediaMessage(
      ctx,
      { fileId: video.file_id, filename: video.file_name ?? `video_${video.file_unique_id}.mp4`, fileType: "동영상" },
      ctx.message.media_group_id,
      ctx.message.caption
    );
  });

  bot.on("message:video_note", async (ctx) => {
    const note = ctx.message.video_note;
    await handleFile(ctx, note.file_id, `video_note_${note.file_unique_id}.mp4`, "원형 동영상", undefined);
  });

  bot.on("message:animation", async (ctx) => {
    const anim = ctx.message.animation;
    await handleFile(ctx, anim.file_id, anim.file_name ?? `animation_${anim.file_unique_id}.mp4`, "애니메이션/GIF", ctx.message.caption);
  });

  bot.on("message:sticker", async (ctx) => {
    const sticker = ctx.message.sticker;
    const ext = sticker.is_animated ? ".tgs" : sticker.is_video ? ".webm" : ".webp";
    await handleFile(ctx, sticker.file_id, `sticker_${sticker.file_unique_id}${ext}`, "스티커", undefined);
  });
}
