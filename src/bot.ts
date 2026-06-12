import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Bot, InlineKeyboard } from "grammy";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { addProject, resolveProject, type AppConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { PermissionBroker } from "./permission-broker.js";
import { SessionManager } from "./session-manager.js";
import { StateStore } from "./store.js";
import { safeErrorMessage, TelegramTransport } from "./telegram-transport.js";
import type { ProjectConfig, SessionRecord } from "./types.js";
import { formatUsageSnapshot } from "./usage.js";

const execFileAsync = promisify(execFile);

interface PendingStart {
  project: ProjectConfig;
  resumeSessionId?: string;
  forkSession?: boolean;
}

function pendingStartKey(userId: number, topicId?: number): string {
  return `${userId}:${topicId ?? "general"}`;
}

function topicTitle(project: string, prompt: string): string {
  const summary = prompt.replace(/\s+/g, " ").trim().slice(0, 70);
  return `${project} - ${summary || "새 작업"}`;
}

function topicLink(chatId: number, topicId: number): string {
  return `https://t.me/c/${String(chatId).replace(/^-100/, "")}/${topicId}`;
}

function statusLabel(session: SessionRecord): string {
  return session.status;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour12: false
  });
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}시간 ${minutes}분 ${remainder}초`
    : minutes > 0
      ? `${minutes}분 ${remainder}초`
      : `${remainder}초`;
}

export function formatSessionStatus(session: SessionRecord, active: boolean): string {
  const state = session.status === "waiting_approval"
    ? "승인 대기 중"
    : active
      ? "실행 중"
      : session.status === "queued"
      ? "대기 중"
      : "실행 중인 작업 없음";
  return [
    "오케스트레이터: 정상 응답",
    `작업: ${state}`,
    `저장 상태: ${session.status}`,
    `프로젝트: ${session.projectName}`,
    `마지막 상태 변경: ${formatTimestamp(session.updatedAt)}`
  ].join("\n");
}

function projectKeyboard(projects: ProjectConfig[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, project] of projects.entries()) {
    keyboard.text(project.name, `newp:${index}`).row();
  }
  return keyboard;
}

function cleanPathInput(text: string): string {
  const clean = text.trim();
  if (
    clean.length >= 2
    && ((clean.startsWith("\"") && clean.endsWith("\""))
      || (clean.startsWith("'") && clean.endsWith("'")))
  ) {
    return clean.slice(1, -1).trim();
  }
  return clean;
}

function parseMode(text: string): PermissionMode | undefined {
  const value = text.trim() as PermissionMode;
  return ["default", "acceptEdits", "plan", "dontAsk", "auto"].includes(value)
    ? value
    : undefined;
}

export function createBot(config: AppConfig, store: StateStore) {
  const bot = new Bot(config.telegramBotToken);
  const transport = new TelegramTransport(bot.api);
  const permissions = new PermissionBroker(store, transport, config.approvalTimeoutMs);
  const sessions = new SessionManager(store, transport, permissions, {
    debounceMs: config.statusDebounceMs,
    claudeCodeOauthToken: config.claudeCodeOauthToken,
    mcpToolTimeoutMs: config.mcpToolTimeoutMs,
    mcpMaxAttempts: config.mcpMaxAttempts,
    codexMcpTimeoutMs: config.codexMcpTimeoutMs,
    codexMcpHeartbeatMs: config.codexMcpHeartbeatMs,
    longRunningMcpServers: config.longRunningMcpServers,
    turnIdleTimeoutMs: config.turnIdleTimeoutMs,
    claudeMemoryDir: config.claudeMemoryDir,
    ...(config.claudeCodeExecutable
      ? { claudeCodeExecutable: config.claudeCodeExecutable }
      : {})
  });
  const pendingStarts = new Map<string, PendingStart>();
  const pendingProjectPaths = new Set<string>();

  const registerProject = async (path: string): Promise<ProjectConfig> => {
    const project = await addProject(config.projectsPath, config.projects, cleanPathInput(path));
    config.projects.push(project);
    store.syncProjects([project]);
    return project;
  };

  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.allowedUserId) return;
    if (ctx.chat?.id !== config.chatId) return;
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Claude 세션 오케스트레이터\n\n/new 새 작업\n/status 현재 작동 상태\n/doctor 환경 진단\n/plan 계획·실행·검토 파이프라인\n/addp 프로젝트 경로 추가\n/sessions 최근 세션\n/usage 한도 사용량\n/projects 프로젝트 목록\n토픽 안에서 /steer, /next, /stop, /fork, /compact, /mode, /diff, /delete 사용"
    );
  });

  bot.command("new", async (ctx) => {
    const identifier = ctx.match.trim();
    if (identifier) {
      const project = resolveProject(config.projects, identifier);
      if (!project) {
        await ctx.reply("프로젝트 이름 또는 별칭을 찾을 수 없습니다.");
        return;
      }
      pendingStarts.set(
        pendingStartKey(config.allowedUserId, ctx.message?.message_thread_id),
        { project }
      );
      await ctx.reply(`${project.name} 프로젝트에서 실행할 작업을 입력하세요.`);
      return;
    }
    await ctx.reply("프로젝트를 선택하세요.", { reply_markup: projectKeyboard(config.projects) });
  });

  bot.command("projects", async (ctx) => {
    const text = config.projects.map((project) => [
      project.name,
      ...(project.aliases?.length ? [`별칭: ${project.aliases.join(", ")}`] : []),
      project.cwd
    ].join("\n")).join("\n\n");
    await ctx.reply(text);
  });

  bot.command("addp", async (ctx) => {
    const path = ctx.match.trim();
    const key = pendingStartKey(config.allowedUserId, ctx.message?.message_thread_id);
    if (!path) {
      pendingProjectPaths.add(key);
      await ctx.reply("추가할 프로젝트의 절대경로를 입력하세요.");
      return;
    }
    try {
      const project = await registerProject(path);
      pendingProjectPaths.delete(key);
      await ctx.reply(`프로젝트를 추가했습니다.\n${project.name}\n${project.cwd}`);
    } catch (error) {
      await ctx.reply(`프로젝트를 추가하지 못했습니다.\n${safeErrorMessage(error)}`);
    }
  });

  bot.command("sessions", async (ctx) => {
    const recent = store.listSessions(15);
    if (recent.length === 0) {
      await ctx.reply("저장된 세션이 없습니다.");
      return;
    }
    const text = recent
      .map((session) =>
        `${session.title}\n${statusLabel(session)} | ${session.projectName}\n${topicLink(session.chatId, session.topicId)}`
      )
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
      await ctx.reply(`${formatSessionStatus(session, sessions.isActive(session.id))}${codex}`);
      return;
    }

    const now = Date.now();
    const active = sessions.inspect();
    const details = active.flatMap((inspection) => {
      const session = store.getSession(inspection.sessionId);
      if (!session) return [];
      const codex = inspection.codexInFlight && inspection.codexElapsedMs !== null
        ? `\nCodex 실행 중 ${formatDuration(inspection.codexElapsedMs)}`
        : "";
      return [
        `${session.projectName} | ${inspection.title}\n`
        + `${inspection.cwd}\n`
        + `경과 ${formatDuration(now - inspection.startedAt)} · 대기 턴 ${inspection.pendingTurns}${codex}\n`
        + topicLink(session.chatId, session.topicId)
      ];
    });
    await ctx.reply([
      "오케스트레이터: 정상 응답",
      `프로세스: PID ${process.pid} · 가동 ${formatDuration(process.uptime() * 1000)}`,
      `저장된 세션: ${store.countSessions()}개`,
      active.length > 0
        ? `현재 실행 중인 작업: ${active.length}개`
        : "현재 실행 중인 작업이 없습니다.",
      ...details
    ].join("\n\n"));
  });

  bot.command("doctor", async (ctx) => {
    const report = await runDoctor({
      config,
      store,
      getTelegramMe: () => bot.api.getMe(),
      projectDir: process.cwd()
    });
    for (let offset = 0; offset < report.length; offset += 3900) {
      await ctx.reply(report.slice(offset, offset + 3900));
    }
  });

  bot.command("plan", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    const instruction = ctx.match.trim();
    if (!session || !instruction) {
      await ctx.reply("기존 세션 토픽에서 `/plan 구현할 작업` 형식으로 사용하세요.");
      return;
    }
    if (!sessions.runPlanPipeline(session, instruction)) {
      await ctx.reply("이 세션에서 이미 실행 중이거나 대기 중인 작업이 있습니다.");
      return;
    }
    await ctx.reply("계획 작성, Codex 실행, Claude 검토 파이프라인을 예약했습니다.");
  });

  bot.command("usage", async (ctx) => {
    const latest = store.listSessions(50).find((session) => session.usageSnapshot);
    if (!latest?.usageSnapshot) {
      await ctx.reply("아직 저장된 한도 사용량이 없습니다. 작업을 한 번 실행한 뒤 다시 확인하세요.");
      return;
    }
    await ctx.reply(
      `${formatUsageSnapshot(latest.usageSnapshot)}\n측정: ${new Date(latest.usageSnapshot.capturedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`
    );
  });

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

  bot.command("steer", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    const prompt = ctx.match.trim();
    if (!session || !prompt) {
      await ctx.reply("실행 중인 세션 토픽에서 `/steer 수정할 지시` 형식으로 사용하세요.");
      return;
    }
    if (!sessions.steer(session.id, prompt)) {
      await ctx.reply("현재 실행 중인 작업이 없습니다. 일반 메시지로 후속 작업을 시작하세요.");
      return;
    }
    await ctx.reply("현재 실행 중인 작업에 즉시 반영할 메시지를 보냈습니다.");
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
    await ctx.reply("후속 작업을 예약할 수 없습니다. Claude 세션 ID가 아직 생성되지 않았습니다.");
  });

  bot.command("fork", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session?.sdkSessionId) {
      await ctx.reply("분기할 수 있는 완료 세션이 없습니다.");
      return;
    }
    const project = config.projects.find((item) => item.name === session.projectName);
    if (!project) {
      await ctx.reply("프로젝트 설정을 찾을 수 없습니다.");
      return;
    }
    pendingStarts.set(pendingStartKey(config.allowedUserId, topicId), {
      project,
      resumeSessionId: session.sdkSessionId,
      forkSession: true
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
    if (!session.sdkSessionId) {
      await ctx.reply("아직 압축할 Claude 세션 문맥이 없습니다.");
      return;
    }
    if (!sessions.compact(session, ctx.match)) {
      await ctx.reply("현재 작업이 실행 중입니다. 완료하거나 /stop으로 중단한 뒤 압축하세요.");
      return;
    }
    await ctx.reply(
      ctx.match.trim()
        ? `컨텍스트 압축을 시작했습니다.\n보존 초점: ${ctx.match.trim().slice(0, 500)}`
        : "컨텍스트 압축을 시작했습니다."
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
      await ctx.reply(`현재 모드: ${session.permissionMode}\n사용 가능: default, acceptEdits, plan, dontAsk, auto`);
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.reply("실행 중에는 바꿀 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요.");
      return;
    }
    store.updateSession(session.id, { permissionMode: mode });
    await ctx.reply(`다음 실행부터 권한 모드를 ${mode}(으)로 사용합니다.`);
  });

  bot.command("diff", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    try {
      const { stdout } = await execFileAsync("git", ["-C", session.cwd, "diff", "--stat"], {
        maxBuffer: 1024 * 1024
      });
      await ctx.reply(stdout.trim() || "현재 git diff가 없습니다.");
    } catch {
      await ctx.reply("이 프로젝트에서 git diff를 읽을 수 없습니다.");
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

  bot.callbackQuery(/^newp:/, async (ctx) => {
    const projectIndex = Number.parseInt(ctx.callbackQuery.data.slice("newp:".length), 10);
    const project = Number.isInteger(projectIndex)
      ? config.projects[projectIndex]
      : undefined;
    if (!project) {
      await ctx.answerCallbackQuery({ text: "프로젝트를 찾을 수 없습니다." });
      return;
    }
    pendingStarts.set(
      pendingStartKey(config.allowedUserId, ctx.callbackQuery.message?.message_thread_id),
      { project }
    );
    await ctx.answerCallbackQuery({ text: `${project.name} 선택` });
    await ctx.reply("실행할 작업을 입력하세요.");
  });

  bot.callbackQuery(/^stop:/, async (ctx) => {
    const sessionId = ctx.callbackQuery.data.slice("stop:".length);
    const stopped = sessions.stop(sessionId);
    await ctx.answerCallbackQuery({ text: stopped ? "중단 요청을 보냈습니다." : "실행 중이 아닙니다." });
  });

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
        safeErrorMessage(error, [config.telegramBotToken, config.claudeCodeOauthToken])
      );
      await ctx.reply("토픽을 삭제하지 못했습니다. 봇의 Delete Messages 권한을 확인하세요.");
      return;
    }

    pendingStarts.delete(pendingStartKey(config.allowedUserId, session.topicId));
    await sessions.deleteSession(session);
  });

  bot.callbackQuery(/^(ap|q):/, async (ctx) => {
    const answer = await permissions.handleCallback(ctx.callbackQuery.data);
    await ctx.answerCallbackQuery({ text: answer });
  });

  bot.on("message:text", async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    const pendingKey = pendingStartKey(config.allowedUserId, topicId);
    if (pendingProjectPaths.delete(pendingKey)) {
      try {
        const project = await registerProject(ctx.message.text);
        await ctx.reply(`프로젝트를 추가했습니다.\n${project.name}\n${project.cwd}`);
      } catch (error) {
        await ctx.reply(`프로젝트를 추가하지 못했습니다.\n${safeErrorMessage(error)}`);
      }
      return;
    }
    if (ctx.message.text.startsWith("/")) return;
    const existing = topicId
      ? store.getSessionByTopic(config.chatId, topicId)
      : undefined;

    if (existing && await permissions.handleTextInput(existing.id, ctx.message.text)) {
      await ctx.reply("직접 답변을 전달했습니다.");
      return;
    }

    const pending = pendingStarts.get(pendingKey);
    if (pending) {
      pendingStarts.delete(pendingKey);
      const title = topicTitle(pending.project.name, ctx.message.text);
      const newTopicId = await transport.createTopic(config.chatId, title);
      const session = sessions.createSession(
        pending.project,
        config.chatId,
        newTopicId,
        title,
        ctx.message.text,
        pending.resumeSessionId,
        pending.forkSession ?? false
      );
      await ctx.reply(`세션을 시작했습니다.\n${topicLink(config.chatId, session.topicId)}`);
      return;
    }

    if (!existing) {
      await ctx.reply("/new로 새 작업을 시작하거나 세션 토픽에 메시지를 입력하세요.");
      return;
    }
    if (sessions.isActive(existing.id)) {
      await ctx.reply(
        "현재 작업이 실행 중입니다.\n"
        + "현재 작업을 수정하려면 `/steer 지시`, 끝난 뒤 실행하려면 `/next 지시`를 사용하세요."
      );
      return;
    }
    if (!sessions.resume(existing, ctx.message.text)) {
      await ctx.reply("이 세션은 이미 실행 중이거나 아직 Claude 세션 ID가 없습니다.");
      return;
    }
    await ctx.reply("후속 작업을 시작했습니다.");
  });

  bot.catch((error) => {
    console.error(
      "Telegram update failed:",
      safeErrorMessage(error.error, [config.telegramBotToken, config.claudeCodeOauthToken])
    );
  });

  return { bot, sessions, permissions };
}
