import { Bot, InlineKeyboard } from "grammy";
import { resolveProject } from "../../config.js";
import { buildDashboardCards, formatDashboard } from "../../dashboard.js";
import { runDoctor } from "../../doctor.js";
import { fetchGrokLiveUsage } from "../../grok-live-usage.js";
import { collectLocalTokenUsage } from "../../local-token-usage.js";
import { appLocale, appTimeZone } from "../../localization.js";
import { safeErrorMessage } from "../../telegram-transport.js";
import { formatAgyAccountUsage, formatAgyUsage, formatCodexAccountUsage, formatGrokUsage, formatLocalTokenUsage, formatUsageSnapshot, parseStoredAgyUsage } from "../../usage.js";
import type { BotDeps } from "../deps.js";
import {
  formatDuration,
  formatReservedTaskLine,
  formatSessionStatus,
  formatTimestamp,
  statusLabel,
  topicLink
} from "../formatting.js";
import {
  defaultsSummary,
  usageRateLimitWarning
} from "../keyboards.js";
import { pendingStartKey } from "../pending-keys.js";
import { cleanReservedTaskStartOptions, parseReserveCommand } from "../time-parse.js";

export function registerLifecycleHandlers(bot: Bot, deps: BotDeps): void {
  const {
    config,
    store,
    transport,
    sessions,
    pendingStarts,
    defaultPanelKeyboard,
    pendingFieldsForDefaults,
    openPendingStartTopic,
    openPendingAutoStartTopic,
    showFolderBrowserRoot,
    openPendingReserveTopic,
    openPendingAutoReserveTopic,
    scheduleReservedTask,
    cancelReservedTimer,
    reservedTaskCancelKeyboard
  } = deps;
  bot.command("start", async (ctx) => {
    const defaults = store.getSessionDefaults();
    await ctx.reply(
      "Claude/Codex/Antigravity/Grok 세션 오케스트레이터\n\n/new 새 작업\n/firstp 인증된 기본 제공자 선택\n/reserve 예약 작업\n/cancel 예약 취소\n/status 현재 작동 상태\n/doctor 환경 진단\n/sessions 최근 세션\n/usage 한도 사용량\n/compile LLM-Wiki 자동 컴파일\n/dpbot 완료된 세션 transcript 수동 덤프\n토픽 안에서 /deepinterview, /ralplan, /ultragoal, /shotgun, /steer, /next, /goal, /restop, /stop, /reset, /fork, /compact, /memory, /mode, /provider, /model, /thinking, /power, /lean, /diff, /upload, /delete 사용\n\n아래 기본값 패널 버튼으로 새 세션 기본값(제공자·모델·thinking/추론·작업량·토큰)을 클릭만으로 바꿀 수 있습니다.",
      { reply_markup: defaultPanelKeyboard(defaults) }
    );
  });

  bot.command("new", async (ctx) => {
    const defaults = store.getSessionDefaults();
    const identifier = ctx.match.trim();
    if (identifier) {
      if (identifier.toLowerCase() === "browse") {
        const key = pendingStartKey(ctx.from!.id, ctx.message?.message_thread_id);
        try {
          await showFolderBrowserRoot(key, "newfs", (text, keyboard) =>
            ctx.reply(text, { reply_markup: keyboard })
          );
        } catch (error) {
          await ctx.reply(`폴더를 읽지 못했습니다.\n${safeErrorMessage(error)}`);
        }
        return;
      }
      const project = resolveProject([...config.projects, ...store.listProjects()], identifier);
      if (!project) {
        await ctx.reply("프로젝트 이름 또는 별칭을 찾을 수 없습니다. 직접 고르려면 /new browse를 사용하세요.");
        return;
      }
      await openPendingStartTopic(ctx.from!.id, project, defaults, pendingFieldsForDefaults(defaults));
      await ctx.reply(`${project.name} 작업 토픽을 열었습니다.`);
      return;
    }
    try {
      await openPendingAutoStartTopic(ctx.from!.id, defaults, pendingFieldsForDefaults(defaults));
      await ctx.reply("프로젝트 자동 선택 작업 토픽을 열었습니다.");
    } catch (error) {
      await ctx.reply(`작업 토픽을 열지 못했습니다.\n${safeErrorMessage(error)}`);
    }
  });

  bot.command("reserve", async (ctx) => {
    const input = ctx.match.trim();
    if (!input) {
      try {
        await openPendingAutoReserveTopic(ctx.from!.id, store.getSessionDefaults());
        await ctx.reply("프로젝트 자동 선택 예약 토픽을 열었습니다.");
      } catch (error) {
        await ctx.reply(`예약 토픽을 열지 못했습니다.\n${safeErrorMessage(error)}`);
      }
      return;
    }
    if (input.toLowerCase() === "browse") {
      const key = pendingStartKey(ctx.from!.id, ctx.message?.message_thread_id);
      try {
        await showFolderBrowserRoot(key, "resfs", (text, keyboard) =>
          ctx.reply(text, { reply_markup: keyboard })
        );
      } catch (error) {
        await ctx.reply(`폴더를 읽지 못했습니다.\n${safeErrorMessage(error)}`);
      }
      return;
    }
    const parsed = parseReserveCommand(input, new Date());
    if (!parsed) {
      const project = resolveProject([...config.projects, ...store.listProjects()], input);
      if (project) {
        await openPendingReserveTopic(ctx.from!.id, project, store.getSessionDefaults());
        await ctx.reply(`${project.name} 예약 토픽을 열었습니다.`);
        return;
      }
      await ctx.reply(
        "사용법: /reserve <프로젝트> <시간> <작업>\n"
        + "예: /reserve ChatKJB 내일 오전 9시 README 점검해줘\n"
        + "예: /reserve ChatKJB 30분 뒤 테스트 돌려줘\n"
        + "예: /reserve ChatKJB 2026-06-30 09:00 README 점검해줘"
      );
      return;
    }
    const project = resolveProject(
      [...config.projects, ...store.listProjects()],
      parsed.projectIdentifier
    );
    if (!project) {
      await ctx.reply("프로젝트 이름 또는 별칭을 찾을 수 없습니다. 직접 고르려면 /reserve browse를 사용하세요.");
      return;
    }
    if (parsed.dueAt <= Date.now() + 5_000) {
      await ctx.reply("예약 시각은 현재보다 5초 이상 뒤여야 합니다.");
      return;
    }
    const defaults = store.getSessionDefaults();
    const task = store.createReservedTask({
      chatId: config.chatId,
      projectName: project.name,
      prompt: parsed.prompt,
      dueAt: parsed.dueAt,
      startOptions: cleanReservedTaskStartOptions(pendingFieldsForDefaults(defaults))
    });
    scheduleReservedTask(task);
    await ctx.reply(
      `예약했습니다.\n`
      + `${project.name} · ${formatTimestamp(task.dueAt)}\n`
      + `${defaultsSummary(defaults, config.modelCatalog)}\n`
      + task.prompt
    );
  });

  bot.command("cancel", async (ctx) => {
    const list = reservedTaskCancelKeyboard();
    if (!list) {
      await ctx.reply("대기 중인 예약 작업이 없습니다.");
      return;
    }
    await ctx.reply("취소할 예약 작업을 선택하세요.", { reply_markup: list });
  });

  bot.callbackQuery(/^rescancel:/, async (ctx) => {
    const taskId = ctx.callbackQuery.data.slice("rescancel:".length);
    const task = store.getReservedTask(taskId);
    if (!task || task.status !== "pending") {
      await ctx.answerCallbackQuery({ text: "취소할 수 있는 예약이 아닙니다.", show_alert: true });
      return;
    }
    cancelReservedTimer(task.id);
    store.updateReservedTask(task.id, { status: "canceled", errorMessage: null });
    await ctx.answerCallbackQuery({ text: "예약을 취소했습니다." });
    await ctx.reply(`예약을 취소했습니다.\n${formatReservedTaskLine(task)}`);
  });

  bot.command("sessions", async (ctx) => {
    const recent = store.listSessions(15);
    if (recent.length === 0) {
      await ctx.reply("저장된 세션이 없습니다.");
      return;
    }
    const text = recent
      .map((session) => {
        const agyHint = session.provider === "agy" && session.agyConversationId
          ? " · 대화 연결됨"
          : "";
        return `${session.title}\n${statusLabel(session)}${agyHint} | ${session.projectName}\n${topicLink(session.chatId, session.topicId)}`;
      })
      .join("\n\n");
    const latestUsage = recent.find((session) => session.usageSnapshot)?.usageSnapshot;
    const usage = latestUsage ? `현재 한도\n${formatUsageSnapshot(latestUsage)}\n\n` : "";
    await ctx.reply(`${usage}${text}`);
  });

  bot.command("status", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    if (topicId) {
      const session = store.getSessionByTopic(config.chatId, topicId);
      if (!session) {
        await ctx.reply("오케스트레이터: 정상 응답\n이 토픽에 연결된 세션이 없습니다.");
        return;
      }
      const inspection = sessions.inspect().find((item) => item.sessionId === session.id);
      const codex = inspection?.codexInFlight && inspection.codexElapsedMs !== null
        ? `\nCodex: 실행 중 ${formatDuration(inspection.codexElapsedMs)}`
        : "";
      // agy 세션이면 저장된 누적 사용량과 라이브 상태를 함께 덧붙인다.
      let agyUsageText = "";
      let agyLiveText = "";
      if (session.provider === "agy") {
        const stored = parseStoredAgyUsage(session.agyUsage);
        agyUsageText = stored
          ? `\n\n${formatAgyUsage(stored)}`
          : "\n\nAntigravity 토큰 사용량: 측정 전 (아직 턴이 실행되지 않았습니다)";
        const live = await sessions.getAgyLiveStatus(session.id);
        if (live.status) {
          const idleLabel = live.status.isIdle === null
            ? "유휴 여부 알 수 없음"
            : live.status.isIdle
              ? "유휴"
              : "작업 중";
          const turnLabel = live.status.turnCount === null
            ? "대화 턴 수 알 수 없음"
            : `대화 턴 ${live.status.turnCount}회`;
          agyLiveText = `\nAntigravity 라이브: ${idleLabel} · ${turnLabel}`;
        } else {
          agyLiveText = `\nAntigravity 라이브: 조회 실패 (${live.error ?? "알 수 없는 원인"})`;
        }
      }
      await ctx.reply(
        `${formatSessionStatus(
          session,
          sessions.isActive(session.id),
          config.modelCatalog,
          config.codexAccountHomes,
          config.claudeCodeOauthTokens.length
        )}`
        + `${codex}${agyUsageText}${agyLiveText}`
      );
      return;
    }

    const now = Date.now();
    const active = sessions.inspect();
    const activeIds = new Set(active.map((inspection) => inspection.sessionId));
    const dashboardSessions = store.listSessions(30).filter((session) => {
      return activeIds.has(session.id)
        || session.status === "queued"
        || session.status === "waiting_approval"
        || session.status === "waiting_limit"
        || session.status === "verification_failed";
    });
    const cards = buildDashboardCards({
      sessions: dashboardSessions,
      inspections: active,
      reservedTasks: store.listRecentReservedTasks(20),
      now
    });
    await ctx.reply([
      "오케스트레이터: 정상 응답",
      `프로세스: PID ${process.pid} · 가동 ${formatDuration(process.uptime() * 1000)}`,
      `저장된 세션: ${store.countSessions()}개`,
      active.length > 0
        ? `현재 실행 중인 작업: ${active.length}개`
        : "현재 실행 중인 작업이 없습니다.",
      formatDashboard(cards, now)
    ].join("\n\n"));
  });

  bot.command("doctor", async (ctx) => {
    const report = await runDoctor({
      config,
      store,
      getTelegramMe: () => bot.api.getMe()
    });
    for (let offset = 0; offset < report.length; offset += 3900) {
      await ctx.reply(report.slice(offset, offset + 3900));
    }
  });

  bot.command("usage", async (ctx) => {
    // 토픽 안에서 호출되고 해당 세션이 agy이면 네이티브 토큰 사용량을 먼저 보여준다.
    const topicId = ctx.message?.message_thread_id;
    const topicSession = topicId
      ? store.getSessionByTopic(config.chatId, topicId)
      : undefined;
    if (topicSession?.provider === "agy") {
      const stored = parseStoredAgyUsage(topicSession.agyUsage);
      if (stored) {
        await ctx.reply(
          formatAgyUsage(stored) + "\n원천: Antigravity CLI 이전 API 측정값 (CLI 백엔드는 토큰 사용량 미제공)"
        );
      } else {
        await ctx.reply(
          "Antigravity 토큰 사용량: 측정 전\n"
          + "(이 세션에서 아직 턴이 실행되지 않았습니다. 첫 턴 완료 후 다시 확인하세요.)"
        );
      }
      return;
    }
    // 토픽 밖 전역 호출에서는 agy 토큰 사용량(대화 단위)을 임의 세션으로 보여주지 않고,
    // 기존대로 Claude/Codex 한도(rate-limit) 스냅샷을 보여준다. agy 네이티브 토큰은
    // 해당 agy 토픽 안에서 /usage를 호출할 때만 표시한다.
    const liveResults = await sessions.fetchCurrentUsageSnapshots(
      config.projects[0]?.cwd ?? process.cwd()
    );
    // Claude/Codex 외에 agy·grok 사용량도 함께 표시한다. agy는 세션 단위 저장 측정값을 합산하고,
    // grok은 grok.com 과금 API에서 크레딧 한도를 실시간 조회한다.
    const grokUsage = await fetchGrokLiveUsage({ grokExecutable: config.grokExecutable });
    const agyGrokText = `\n\n${formatAgyAccountUsage(store.listSessions(200))}\n\n${formatGrokUsage(grokUsage)}`;
    const liveWithSnapshots = liveResults.filter((result) => result.snapshot);
    if (liveWithSnapshots.length > 0) {
      const codexSnapshots = await sessions.fetchCurrentCodexUsageSnapshots(
        config.projects[0]?.cwd ?? process.cwd()
      );
      const multiple = liveResults.length > 1;
      const sections = liveWithSnapshots.map((result) => {
        const snapshot = result.snapshot!;
        const measuredAt = new Date(snapshot.capturedAt).toLocaleString(appLocale(), {
          timeZone: appTimeZone()
        });
        const heading = multiple ? `토큰 #${result.tokenIndex}\n` : "";
        const scopeWarning = snapshot.rateLimitsAvailable ? "" : `\n${usageRateLimitWarning()}`;
        return `${heading}${formatUsageSnapshot(snapshot)}\n측정: ${measuredAt}${scopeWarning}`;
      });
      const failed = liveResults
        .filter((result) => !result.snapshot)
        .map((result) => `토큰 #${result.tokenIndex}: 조회 실패${result.error ? ` (${result.error})` : ""}`);
      const failedText = failed.length > 0 ? `\n\n${failed.join("\n")}` : "";
      const codexText = `\n\n${formatCodexAccountUsage(codexSnapshots)}`;
      await ctx.reply(
        `${sections.join("\n\n")}\n원천: Claude 서버 실시간 조회${failedText}${codexText}${agyGrokText}`
      );
      return;
    }

    const latest = store.listSessions(50).find((session) => session.usageSnapshot);
    const codexSnapshots = await sessions.fetchCurrentCodexUsageSnapshots(
      config.projects[0]?.cwd ?? process.cwd()
    );
    const codexText = `\n\n${formatCodexAccountUsage(codexSnapshots)}`;
    if (!latest?.usageSnapshot) {
      await ctx.reply(
        "실시간 사용량 조회에 실패했고, 저장된 한도 사용량도 없습니다."
        + (liveResults.length > 0
          ? `\n${liveResults.map((result) =>
            `토큰 #${result.tokenIndex}: ${result.error ?? "사용량 없음"}`
          ).join("\n")}`
          : "")
        + codexText
        + agyGrokText
      );
      return;
    }
    await ctx.reply(
      `실시간 사용량 조회에 실패해 마지막 저장값을 표시합니다.`
      + (liveResults.length > 0
        ? `\n${liveResults.map((result) =>
          `토큰 #${result.tokenIndex}: ${result.error ?? "사용량 없음"}`
        ).join("\n")}`
        : "")
      + `\n\n${formatUsageSnapshot(latest.usageSnapshot)}\n측정: ${new Date(latest.usageSnapshot.capturedAt).toLocaleString(appLocale(), { timeZone: appTimeZone() })}`
      + codexText
      + agyGrokText
    );
  });

  // /usage가 "남은 한도"라면 /ustoken은 "지금까지 쓴 총량"이다. 로컬 기록만 훑으므로 네트워크를
  // 타지 않지만 트랜스크립트가 많으면 수 초 걸릴 수 있어 먼저 안내 메시지를 보낸다.
  bot.command("ustoken", async (ctx) => {
    const notice = await ctx.reply("누적 토큰 집계 중…");
    const report = await collectLocalTokenUsage(store.listSessions(1000));
    const text = formatLocalTokenUsage(report);
    try {
      await ctx.api.editMessageText(notice.chat.id, notice.message_id, text);
    } catch {
      // 편집이 실패하면(메시지가 지워진 경우 등) 새 메시지로 보낸다.
      await ctx.reply(text);
    }
  });

  bot.command("delete", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!topicId || !session) {
      await ctx.reply("삭제할 세션 토픽 안에서 사용하세요.");
      return;
    }
    const keyboard = new InlineKeyboard()
      .text("토픽과 로컬 세션 삭제", `del:${session.id}`)
      .row()
      .text("취소", `delcancel:${session.id}`);
    await ctx.reply(
      "이 토픽, 로컬 세션 기록, Claude 대화 원본을 모두 삭제합니다. 되돌릴 수 없습니다.",
      { reply_markup: keyboard }
    );
  });

  // 프로젝트를 고르면 현재 기본값(제공자·모델·thinking)을 그대로 적용하고 바로 작업 입력을
  // 기다린다. 매번 모델/thinking을 누를 필요 없이 기본값 패널로 미리 정해 둔 값을 쓴다.

  bot.callbackQuery(/^delcancel:/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "삭제를 취소했습니다." });
    await ctx.editMessageText("삭제를 취소했습니다.");
  });

  bot.callbackQuery(/^del:/, async (ctx) => {
    const sessionId = ctx.callbackQuery.data.slice("del:".length);
    const topicId = ctx.callbackQuery.message?.message_thread_id;
    const session = store.getSession(sessionId);
    if (!session || topicId !== session.topicId || session.chatId !== config.chatId) {
      await ctx.answerCallbackQuery({ text: "세션을 찾을 수 없습니다.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: "삭제 중입니다." });
    try {
      await transport.deleteTopic(session.chatId, session.topicId);
    } catch (error) {
      console.error(
        "Telegram topic deletion failed:",
        safeErrorMessage(error, [config.telegramBotToken, ...config.claudeCodeOauthTokens])
      );
      await ctx.reply("토픽을 삭제하지 못했습니다. 봇의 Delete Messages 권한을 확인하세요.");
      return;
    }

    for (const userId of config.allowedUserIds) {
      pendingStarts.delete(pendingStartKey(userId, session.topicId));
    }
    await sessions.deleteSession(session);
  });
}
