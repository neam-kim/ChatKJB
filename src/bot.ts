import { Bot, InlineKeyboard } from "grammy";
import { createWriteStream, realpathSync } from "node:fs";
import { mkdir, readdir, realpath, unlink } from "node:fs/promises";
import { Agent as HttpsAgent, get as httpsGet } from "node:https";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { BotDeps, FileDescriptor, FileHandlerContext, PendingReserve } from "./bot/deps.js";
import {
  detectDrives,
  envFolderBrowserRoot,
  projectNameFromSelectedPath,
  uniqueProjectName,
  type DriveEntry,
  type FolderBrowserState
} from "./bot/drive-browser.js";
import {
  codexAccountLabel,
  displayDriveLabel,
  formatTimestamp,
  topicLink,
  topicTitle
} from "./bot/formatting.js";
import { registerBotHandlers } from "./bot/handlers/index.js";
import {
  defaultsKeyboard,
  defaultsSummary,
  driveListKeyboard,
  driveListText,
  folderBrowserKeyboard,
  folderBrowserText
} from "./bot/keyboards.js";
import {
  pendingFieldsFromDefaults,
  pendingStartKey,
  selectedClaudeTokenIndex,
  selectedCodexAccountIndex,
  type PendingStart,
  type PendingStartOptions
} from "./bot/pending-keys.js";
import {
  cleanReservedTaskStartOptions,
  MAX_RESERVE_TIMEOUT_MS
} from "./bot/time-parse.js";
import { TransientMap } from "./bot/transient-store.js";
import { CodexAppServerGoalClient, type CodexGoalClient } from "./codex-app-server.js";
import { fetchClaudeWebUsage } from "./claude-web-usage.js";
import { resolveProject, type AppConfig } from "./config.js";
import type { GuiClaudeUsageDto } from "./usage-contract.js";
import {
  normalizeAgyModelForCatalog
} from "./model-catalog.js";
import {
  clineModelsForProvider,
  normalizeClineReasoning
} from "./cline-sdk.js";
import { PermissionBroker } from "./permission-broker.js";
import {
  buildProjectSelectionPrompt,
  parseProjectSelection,
  ProjectCatalog,
  renderProjectCatalog
} from "./project-catalog.js";
import {
  SessionManager
} from "./session-manager.js";
import { StateStore } from "./store.js";
import { transcribeAudio } from "./stt.js";
import { safeErrorMessage, TelegramTransport } from "./telegram-transport.js";
import {
  TelegramTopicDeletionMonitor,
  TeleprotoTopicDeletionSource,
  type TopicDeletionSource
} from "./telegram-topic-deletion.js";
import type {
  ProjectConfig,
  ReservedTaskRecord,
  SessionDefaults,
  SessionRecord
} from "./types.js";
import { resolveUploadPath } from "./upload-path.js";

export { displayDriveLabel, formatSessionStatus } from "./bot/formatting.js";
export { modelKeyboard } from "./bot/keyboards.js";
export { parseReserveCommand, parseReserveTime } from "./bot/time-parse.js";

const MAX_FOLDER_BROWSER_ENTRIES = 40;

const TRANSIENT_UI_TTL_MS = 60 * 60 * 1000;
const MAX_TRANSIENT_UI_ENTRIES = 256;

export interface BotRuntimeDependencies {
  codexGoalClient?: CodexGoalClient;
  downloadFile?: (fileId: string, filename: string) => Promise<string>;
  projectCatalogRoots?: () => Promise<readonly string[]>;
  runProjectSelector?: (prompt: string, defaults: SessionDefaults) => Promise<string>;
  topicDeletionSource?: TopicDeletionSource;
  /** 테스트 등에서 Claude 웹 구독 사용량 조회를 대체한다. */
  fetchClaudeUsage?: () => Promise<GuiClaudeUsageDto | null>;
}

export async function resolveSessionUploadPath(cwd: string, inputPath: string): Promise<string> {
  return resolveUploadPath(cwd, inputPath);
}

const removeReplyKeyboard = { remove_keyboard: true } as const;

export function createBot(
  config: AppConfig,
  store: StateStore,
  runtime: BotRuntimeDependencies = {}
) {
  const storedDefaults = store.getSessionDefaults();
  if (!config.availableProviders.includes(storedDefaults.provider)) {
    store.updateSessionDefaults({ provider: config.defaultProvider });
  }
  const normalizedAgyDefault = normalizeAgyModelForCatalog(
    config.modelCatalog,
    storedDefaults.agyModel
  );
  if (normalizedAgyDefault !== storedDefaults.agyModel) {
    store.updateSessionDefaults({ agyModel: normalizedAgyDefault });
  }
  const clineProvider = config.modelCatalog.clineProviders.find(
    (provider) => provider.id === storedDefaults.clineProviderId
  ) ?? config.modelCatalog.clineProviders[0];
  if (clineProvider) {
    const models = clineModelsForProvider(config.modelCatalog, clineProvider.id);
    const clineModel = models.find((model) => model.id === storedDefaults.clineModel)
      ?? models.find((model) => model.id === clineProvider.defaultModelId)
      ?? models[0];
    if (clineModel) {
      const clineReasoning = normalizeClineReasoning(storedDefaults.clineReasoning, clineModel);
      if (
        storedDefaults.clineProviderId !== clineProvider.id
        || storedDefaults.clineModel !== clineModel.id
        || storedDefaults.clineReasoning !== clineReasoning
      ) {
        store.updateSessionDefaults({
          clineProviderId: clineProvider.id,
          clineModel: clineModel.id,
          clineReasoning
        });
      }
    }
  }
  // 기본값은 운영체제의 네트워크 선택을 따른다. 특정 호스트에서 IPv4/IPv6 경로에 문제가
  // 있을 때만 TELEGRAM_IP_FAMILY로 고정하며, 파일 다운로드도 같은 에이전트를 공유한다.
  const telegramAgent = config.telegramIpFamily === "auto"
    ? undefined
    : new HttpsAgent({ family: Number(config.telegramIpFamily) as 4 | 6, keepAlive: true });
  const bot = new Bot(config.telegramBotToken, {
    client: {
      baseFetchConfig: {
        ...(telegramAgent ? { agent: telegramAgent } : {})
      }
    }
  });
  const transport = new TelegramTransport(bot.api);
  const fetchClaudeUsage = runtime.fetchClaudeUsage ?? fetchClaudeWebUsage;
  const permissions = new PermissionBroker(store, transport, config.approvalTimeoutMs);
  const projectCatalog = new ProjectCatalog({
    catalogPath: join(dirname(config.databasePath), "project-catalog.md"),
    roots: runtime.projectCatalogRoots ?? (async () => {
      const configuredRoot = envFolderBrowserRoot();
      if (configuredRoot) return [configuredRoot];
      return (await detectDrives()).map((drive) => drive.path);
    }),
    knownProjects: () => [...config.projects, ...store.listProjects()],
    onError: (error) => {
      console.error("Project catalog refresh failed:", safeErrorMessage(error));
    }
  });
  const sessions = new SessionManager(store, transport, permissions, {
    debounceMs: config.statusDebounceMs,
    claudeCodeOauthToken: config.claudeCodeOauthToken,
    additionalOauthTokens: config.claudeCodeOauthTokens.slice(1),
    availableProviders: config.availableProviders,
    codexAccountHomes: config.codexAccountHomes,
    mcpToolTimeoutMs: config.mcpToolTimeoutMs,
    mcpMaxAttempts: config.mcpMaxAttempts,
    codexMcpTimeoutMs: config.codexMcpTimeoutMs,
    providerTurnTimeoutMs: config.providerTurnTimeoutMs,
    codexTransientStreamRetries: config.codexTransientStreamRetries,
    codexMcpHeartbeatMs: config.codexMcpHeartbeatMs,
    longRunningMcpServers: config.longRunningMcpServers,
    turnIdleTimeoutMs: config.turnIdleTimeoutMs,
    claudeMemoryDir: config.claudeMemoryDir,
    modelCatalog: config.modelCatalog,
    onSessionSettled: (session) => projectCatalog.refreshProject(session.cwd).then(() => undefined),
    ...(config.claudeCodeExecutable
      ? { claudeCodeExecutable: config.claudeCodeExecutable }
      : {}),
    ...(config.codexExecutable
      ? { codexExecutable: config.codexExecutable }
      : {}),
    ...(config.agyExecutable
      ? { agyExecutable: config.agyExecutable }
      : {}),
    ...(config.grokExecutable
      ? { grokExecutable: config.grokExecutable }
      : {}),
    ...(config.grokModel
      ? { grokModel: config.grokModel }
      : {}),
    codexGoalClient: runtime.codexGoalClient
      ?? new CodexAppServerGoalClient(10_000, config.codexExecutable)
  });
  const pendingStarts = new TransientMap<string, PendingStart>({
    ttlMs: TRANSIENT_UI_TTL_MS,
    maxEntries: MAX_TRANSIENT_UI_ENTRIES
  });
  const pendingReserves = new TransientMap<string, PendingReserve>({
    ttlMs: TRANSIENT_UI_TTL_MS,
    maxEntries: MAX_TRANSIENT_UI_ENTRIES
  });
  const folderBrowsers = new TransientMap<string, FolderBrowserState>({
    ttlMs: TRANSIENT_UI_TTL_MS,
    maxEntries: MAX_TRANSIENT_UI_ENTRIES
  });
  const reserveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const topicDeletionMonitor = config.telegramMtproto
    ? new TelegramTopicDeletionMonitor({
        chatId: config.chatId,
        store,
        sessions,
        source: runtime.topicDeletionSource ?? new TeleprotoTopicDeletionSource({
          ...config.telegramMtproto,
          botToken: config.telegramBotToken,
          chatId: config.chatId
        }),
        additionalTopicIds: () => [
          ...[...pendingStarts.values()]
            .map((pending) => pending.pendingTopicId)
            .filter((topicId): topicId is number => topicId !== undefined),
          ...[...pendingReserves.values()].map((pending) => pending.topicId),
          ...store.listPendingReservedTasks()
            .filter((task) => task.chatId === config.chatId && task.topicId !== null)
            .map((task) => task.topicId as number)
        ],
        beforeDelete: (topicId) => {
          for (const [key, pending] of pendingStarts) {
            if (pending.pendingTopicId === topicId) pendingStarts.delete(key);
          }
          for (const [key, pending] of pendingReserves) {
            if (pending.topicId === topicId) pendingReserves.delete(key);
          }
          for (const userId of config.allowedUserIds) {
            folderBrowsers.delete(pendingStartKey(userId, topicId));
          }
          for (const task of store.listPendingReservedTasks()) {
            if (task.chatId !== config.chatId || task.topicId !== topicId) continue;
            const timer = reserveTimers.get(task.id);
            if (timer) clearTimeout(timer);
            reserveTimers.delete(task.id);
            store.updateReservedTask(task.id, { status: "canceled", errorMessage: null });
          }
        }
      })
    : null;
  const defaultPanelKeyboard = (defaults: SessionDefaults) =>
    defaultsKeyboard(
      defaults,
      config.modelCatalog,
      config.codexAccountHomes,
      config.claudeCodeOauthTokens.length
    );
  const pendingFieldsForDefaults = (defaults: SessionDefaults): Partial<PendingStartOptions> => {
    const fields = pendingFieldsFromDefaults(defaults);
    if (defaults.provider === "claude") {
      const index = selectedClaudeTokenIndex(defaults.claudeTokenIndex, config.claudeCodeOauthTokens.length);
      return {
        ...fields,
        claudeTokenIndex: index >= 0 ? index : null
      };
    }
    if (defaults.provider !== "codex") return fields;
    const index = selectedCodexAccountIndex(defaults.codexHome, config.codexAccountHomes);
    return {
      ...fields,
      codexHome: index >= 0 ? config.codexAccountHomes[index] ?? null : null
    };
  };
  const startSessionFromOptions = async (
    project: ProjectConfig,
    prompt: string | ((session: SessionRecord) => string),
    options: Partial<PendingStartOptions>,
    topicId?: number | null,
    titlePrompt?: string
  ): Promise<SessionRecord> => {
    const title = topicTitle(
      project.name,
      titlePrompt ?? (typeof prompt === "string" ? prompt : "새 작업")
    );
    const newTopicId = topicId ?? await transport.createTopic(config.chatId, title);
    if (topicId) {
      await transport.renameTopic(config.chatId, topicId, title).catch((error) => {
        console.error("Telegram reserved topic rename failed:", safeErrorMessage(error));
      });
    }
    const session = sessions.createSession(
      project,
      config.chatId,
      newTopicId,
      title,
      prompt,
      options.resumeSessionId,
      options.forkSession ?? false,
      options.model ?? null,
      options.thinking ?? null,
      options.claudeEffort ?? null,
      options.leanMode ?? true,
      options.provider ?? config.defaultProvider,
      options.codexModel ?? null,
      options.codexReasoning ?? null,
      options.agyThinkingLevel ?? null,
      options.agyModel ?? null,
      options.grokModel ?? null,
      options.handoffSummary ?? null,
      options.codexHome ?? null,
      options.claudeTokenIndex ?? null,
      options.grokReasoning ?? null,
      options.clineProviderId ?? null,
      options.clineModel ?? null,
      options.clineReasoning ?? null,
      options.permissionMode ?? null,
      options.subagentModel ?? null,
      options.subagentReasoning ?? null,
      options.subagentEffort ?? null
    );
    const codexAccount = session.provider === "codex"
      ? codexAccountLabel(session.codexHome, config.codexAccountHomes)
      : null;
    const claudeTokenIndex = selectedClaudeTokenIndex(session.claudeTokenIndex, config.claudeCodeOauthTokens.length);
    const claudeToken = session.provider === "claude" && config.claudeCodeOauthTokens.length > 1 && claudeTokenIndex >= 0
      ? `Claude 토큰: #${claudeTokenIndex + 1}`
      : null;
    await transport.sendText(
      config.chatId,
      session.topicId,
      `세션을 시작했습니다.${codexAccount ? `\n${codexAccount}` : ""}${claudeToken ? `\n${claudeToken}` : ""}\n${topicLink(config.chatId, session.topicId)}`
    ).catch((error) => {
      // 세션은 이미 DB에 저장되고 실행 큐에 들어갔다. 안내 전송 실패를 생성 실패로
      // 되던지면 /goal 후처리 등이 유실되므로 best-effort 알림으로만 취급한다.
      console.error(
        "Telegram session start notification failed:",
        safeErrorMessage(error, [config.telegramBotToken, ...config.claudeCodeOauthTokens])
      );
    });
    return session;
  };

  const runReservedTask = async (taskId: string): Promise<void> => {
    reserveTimers.delete(taskId);
    const task = store.getReservedTask(taskId);
    if (!task || task.status !== "pending") return;
    store.updateReservedTask(task.id, { status: "running", errorMessage: null });
    try {
      const project = resolveProject(
        [...config.projects, ...store.listProjects()],
        task.projectName
      );
      if (!project) throw new Error(`예약 프로젝트를 찾을 수 없습니다: ${task.projectName}`);
      const session = await startSessionFromOptions(project, task.prompt, task.startOptions, task.topicId);
      store.updateReservedTask(task.id, {
        status: "done",
        topicId: session.topicId,
        sessionId: session.id,
        errorMessage: null
      });
    } catch (error) {
      const message = safeErrorMessage(error);
      store.updateReservedTask(task.id, { status: "error", errorMessage: message });
      await bot.api.sendMessage(
        config.chatId,
        `예약 작업 실행 실패\n${task.projectName}\n${formatTimestamp(task.dueAt)}\n${message}`
      ).catch(() => undefined);
    }
  };

  const openPendingStartTopic = async (
    userId: number,
    project: ProjectConfig,
    defaults: SessionDefaults,
    options: Partial<PendingStartOptions>
  ): Promise<void> => {
    const storedProject = existingProjectByPath(project.cwd) ?? project;
    store.syncProjects([storedProject]);
    const title = topicTitle(storedProject.name, "새 작업");
    const topicId = await transport.createTopic(config.chatId, title);
    pendingStarts.set(
      pendingStartKey(userId, topicId),
      { kind: "project", project: storedProject, ...options, pendingTopicId: topicId }
    );
    await bot.api.sendMessage(
      config.chatId,
      `${storedProject.name} 프로젝트 · ${defaultsSummary(defaults, config.modelCatalog)}\n이 토픽에 실행할 작업을 입력하세요.`,
      {
        message_thread_id: topicId,
        reply_markup: removeReplyKeyboard
      }
    );
  };

  const openPendingAutoStartTopic = async (
    userId: number,
    defaults: SessionDefaults,
    options: Partial<PendingStartOptions>
  ): Promise<void> => {
    const title = "새 작업 · 프로젝트 자동 선택";
    const topicId = await transport.createTopic(config.chatId, title);
    pendingStarts.set(
      pendingStartKey(userId, topicId),
      { kind: "auto-project", selectionDefaults: defaults, ...options, pendingTopicId: topicId }
    );
    await bot.api.sendMessage(
      config.chatId,
      `프로젝트 자동 선택 · ${defaultsSummary(defaults, config.modelCatalog)}\n`
      + "이 토픽에 실행할 작업을 자연어로 입력하세요. 카탈로그에서 적절한 프로젝트를 고른 뒤 같은 토픽에서 시작합니다.",
      { message_thread_id: topicId, reply_markup: removeReplyKeyboard }
    );
  };

  const readFolderBrowserState = async (
    path: string,
    drives: DriveEntry[] | null,
    rootPath: string,
    driveLabel: string
  ): Promise<FolderBrowserState> => {
    const current = await realpath(path);
    const root = await realpath(rootPath);
    const entries = await readdir(current, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, "ko-KR"))
      .slice(0, MAX_FOLDER_BROWSER_ENTRIES);
    return { currentPath: current, directories, drives, rootPath: root, driveLabel };
  };

  /**
   * 드라이브 목록 레벨을 보여준다. env 루트가 설정된 경우에는 드라이브 목록을 건너뛰고
   * 직접 폴더 브라우저를 연다(기존 테스트 하위호환).
   */
  const showFolderBrowserRoot = async (
    key: string,
    callbackPrefix: string,
    send: (text: string, keyboard: InlineKeyboard) => Promise<unknown>
  ): Promise<void> => {
    const envRoot = envFolderBrowserRoot();
    if (envRoot) {
      const state = await readFolderBrowserState(envRoot, null, envRoot, displayDriveLabel(basename(envRoot) || envRoot));
      folderBrowsers.set(key, state);
      await send(folderBrowserText(state), folderBrowserKeyboard(state, callbackPrefix));
      return;
    }
    const drives = await detectDrives();
    const dummyState: FolderBrowserState = {
      currentPath: "",
      directories: [],
      drives,
      rootPath: "",
      driveLabel: ""
    };
    folderBrowsers.set(key, dummyState);
    await send(driveListText(), driveListKeyboard(drives, callbackPrefix));
  };

  const showFolderBrowser = async (
    key: string,
    path: string,
    drives: DriveEntry[] | null,
    rootPath: string,
    driveLabel: string,
    callbackPrefix: string,
    send: (text: string, keyboard: InlineKeyboard) => Promise<unknown>
  ): Promise<void> => {
    const state = await readFolderBrowserState(path, drives, rootPath, driveLabel);
    folderBrowsers.set(key, state);
    await send(folderBrowserText(state), folderBrowserKeyboard(state, callbackPrefix));
  };

  const canonicalProjectPath = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };

  const sameProjectPath = (left: string, right: string): boolean =>
    canonicalProjectPath(left) === canonicalProjectPath(right);

  const existingProjectByPath = (path: string): ProjectConfig | undefined =>
    store.getProjectByCwd(path)
    ?? store.listProjects().find((project) => sameProjectPath(project.cwd, path))
    ?? config.projects.find((project) => sameProjectPath(project.cwd, path));

  const projectFromSelectedFolder = (path: string): ProjectConfig => {
    const existing = existingProjectByPath(path);
    // 선택 직전에 검증한 canonical 경로만 실행 cwd로 사용한다. 기존 프로젝트의
    // 이름·별칭·모드는 재사용하되 저장된 symlink 경로를 되살리지 않는다.
    if (existing) return { ...existing, cwd: path };

    const existingNames = new Set(
      [...config.projects, ...store.listProjects()]
        .map((project) => project.name.toLocaleLowerCase("en-US"))
    );
    return {
      name: uniqueProjectName(projectNameFromSelectedPath(path), existingNames),
      cwd: path,
      defaultMode: "auto"
    };
  };

  const selectProjectForTask = async (
    task: string,
    defaults: SessionDefaults
  ): Promise<ProjectConfig> => {
    const snapshot = await projectCatalog.current();
    if (snapshot.entries.length === 0) {
      throw new Error("프로젝트 카탈로그가 비어 있습니다. 카탈로그 갱신 후 다시 시도하세요.");
    }
    let projectId: string;
    let reason = "유일한 카탈로그 프로젝트";
    if (snapshot.entries.length === 1) {
      projectId = snapshot.entries[0]!.id;
    } else {
      const prompt = buildProjectSelectionPrompt(task, renderProjectCatalog(snapshot));
      const response = runtime.runProjectSelector
        ? await runtime.runProjectSelector(prompt, defaults)
        : await sessions.runReadOnlyTask({
            provider: defaults.provider,
            defaults,
            cwd: dirname(config.databasePath),
            prompt,
            timeoutMs: 60_000
          });
      const parsed = parseProjectSelection(response);
      if (!parsed) {
        throw new Error("프로젝트 선택기가 유효한 카탈로그 ID를 반환하지 않았습니다.");
      }
      projectId = parsed.projectId;
      reason = parsed.reason;
    }
    const entry = await projectCatalog.resolve(projectId);
    if (!entry) {
      throw new Error("프로젝트 선택 결과가 현재 카탈로그에 없거나 경로 검증에 실패했습니다.");
    }
    const project = projectFromSelectedFolder(entry.path);
    store.syncProjects([project]);
    console.log(`Project auto-selected: ${project.name} (${project.cwd})${reason ? ` - ${reason}` : ""}`);
    return project;
  };

  const openPendingReserveTopic = async (
    userId: number,
    project: ProjectConfig,
    defaults: SessionDefaults
  ): Promise<number> => {
    const storedProject = existingProjectByPath(project.cwd) ?? project;
    store.syncProjects([storedProject]);
    const topicId = await transport.createTopic(config.chatId, `예약 - ${storedProject.name}`);
    const defaultsSummaryText = defaultsSummary(defaults, config.modelCatalog);
    pendingReserves.set(
      pendingStartKey(userId, topicId),
      {
        kind: "project",
        project: storedProject,
        topicId,
        startOptions: cleanReservedTaskStartOptions(pendingFieldsForDefaults(defaults)),
        defaultsSummaryText
      }
    );
    await bot.api.sendMessage(
      config.chatId,
      `${storedProject.name} 예약 · ${defaultsSummaryText}\n이 토픽에 예약할 시간과 작업을 입력하세요.\n예: 내일 오전 9시 README 점검해줘`,
      {
        message_thread_id: topicId,
        reply_markup: removeReplyKeyboard
      }
    );
    return topicId;
  };

  const openPendingAutoReserveTopic = async (userId: number, defaults: SessionDefaults): Promise<number> => {
    const topicId = await transport.createTopic(config.chatId, "예약 · 프로젝트 자동 선택");
    const defaultsSummaryText = defaultsSummary(defaults, config.modelCatalog);
    pendingReserves.set(
      pendingStartKey(userId, topicId),
      {
        kind: "auto-project",
        selectionDefaults: defaults,
        topicId,
        startOptions: cleanReservedTaskStartOptions(pendingFieldsForDefaults(defaults)),
        defaultsSummaryText
      }
    );
    await bot.api.sendMessage(
      config.chatId,
      `프로젝트 자동 선택 예약 · ${defaultsSummaryText}\n`
      + "이 토픽에 예약할 시간과 작업을 입력하세요.\n예: 내일 오전 9시 README 점검해줘",
      { message_thread_id: topicId, reply_markup: removeReplyKeyboard }
    );
    return topicId;
  };

  const scheduleReservedTask = (task: ReservedTaskRecord): void => {
    if (task.status !== "pending") return;
    const existing = reserveTimers.get(task.id);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, task.dueAt - Date.now());
    const timeout = setTimeout(() => {
      if (task.dueAt > Date.now()) {
        const latest = store.getReservedTask(task.id);
        if (latest) scheduleReservedTask(latest);
        return;
      }
      void runReservedTask(task.id);
    }, Math.min(delay, MAX_RESERVE_TIMEOUT_MS));
    reserveTimers.set(task.id, timeout);
  };

  const cancelReservedTimer = (taskId: string): void => {
    const timer = reserveTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    reserveTimers.delete(taskId);
  };

  const reservedTaskCancelKeyboard = (): InlineKeyboard | null => {
    const tasks = store.listPendingReservedTasks();
    if (tasks.length === 0) return null;
    const keyboard = new InlineKeyboard();
    for (const task of tasks) {
      keyboard.text(
        `${task.projectName} · ${formatTimestamp(task.dueAt)}`,
        `rescancel:${task.id}`
      ).row();
    }
    return keyboard;
  };

  for (const task of store.listPendingReservedTasks()) {
    scheduleReservedTask(task);
  }

  bot.use(async (ctx, next) => {
    if (!ctx.from || !config.allowedUserIds.includes(ctx.from.id)) return;
    if (ctx.chat?.id !== config.chatId) return;
    await next();
  });

  async function downloadTelegramFile(fileId: string, filename: string): Promise<string> {
    const file = await bot.api.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) throw new Error("Telegram이 파일 경로를 제공하지 않습니다 (20MB 초과?).");
    await mkdir(config.fileInboxDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safe = filename.replace(/[^\w가-힣.-]/g, "_").slice(0, 80);
    const dest = join(config.fileInboxDir, `${timestamp}_${safe}`);
    const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
    // 글로벌 fetch(undici)는 agent 옵션을 무시해 IPv6로 새어나가 멈춘다.
    // Bot API 호출과 동일한 IPv4 에이전트를 쓰는 node:https로 받는다.
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpsGet(url, telegramAgent ? { agent: telegramAgent } : {}, (res) => {
          const status = res.statusCode ?? 0;
          if (status !== 200) {
            res.resume();
            reject(new Error(`다운로드 실패: ${status}`));
            return;
          }
          void pipeline(res, createWriteStream(dest)).then(() => resolve(), reject);
        });
        req.on("error", reject);
      });
    } catch (error) {
      await unlink(dest).catch(() => undefined);
      throw error;
    }
    return dest;
  }

  const downloadFile = runtime.downloadFile ?? downloadTelegramFile;

  // 앨범(미디어 그룹)은 Telegram이 사진마다 별개 업데이트로 보내므로, 같은 media_group_id를
  // 짧게 버퍼링해 한 번에 처리한다. 그렇지 않으면 첫 사진만 세션을 시작하고 나머지는 후속
  // steer로 흩어져 사실상 유실된다.
  const mediaGroups = new Map<string, {
    ctx: FileHandlerContext;
    items: FileDescriptor[];
    caption?: string | undefined;
    timer: NodeJS.Timeout;
  }>();
  const MEDIA_GROUP_DEBOUNCE_MS = 1500;

  function flushMediaGroup(groupId: string): void {
    const group = mediaGroups.get(groupId);
    if (!group) return;
    mediaGroups.delete(groupId);
    void handleFiles(group.ctx, group.items, group.caption).catch((error) => {
      console.error("미디어 그룹 처리 실패:", safeErrorMessage(error));
    });
  }

  async function handleMediaMessage(
    ctx: FileHandlerContext,
    item: FileDescriptor,
    mediaGroupId: string | undefined,
    caption: string | undefined
  ): Promise<void> {
    if (!mediaGroupId) {
      await handleFiles(ctx, [item], caption);
      return;
    }
    const existing = mediaGroups.get(mediaGroupId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push(item);
      if (!existing.caption && caption) existing.caption = caption;
      existing.ctx = ctx;
      existing.timer = setTimeout(() => flushMediaGroup(mediaGroupId), MEDIA_GROUP_DEBOUNCE_MS);
      return;
    }
    mediaGroups.set(mediaGroupId, {
      ctx,
      items: [item],
      caption,
      timer: setTimeout(() => flushMediaGroup(mediaGroupId), MEDIA_GROUP_DEBOUNCE_MS)
    });
  }

  // 단일 파일 경로는 다중 처리 함수에 1개짜리 배열로 위임한다(형식은 그대로 유지).
  async function handleFile(
    ctx: FileHandlerContext,
    fileId: string,
    filename: string,
    fileType: string,
    caption: string | undefined,
    options?: { transcribe?: boolean; }
  ): Promise<void> {
    await handleFiles(
      ctx,
      [{ fileId, filename, fileType, ...(options?.transcribe ? { transcribe: true } : {}) }],
      caption
    );
  }

  async function handleFiles(
    ctx: FileHandlerContext,
    items: FileDescriptor[],
    caption: string | undefined
  ): Promise<void> {
    if (items.length === 0) return;
    // grammy Context.reply는 프로토타입 메서드라 this.msg를 본다. 메서드만 뽑으면
    // this가 끊겨 "Cannot read properties of undefined (reading 'msg')"로 첨부 처리가
    // 통째로 실패한다. 호출 시점에 ctx에서 호출해 this를 유지한다.
    const reply = (text: string) => ctx.reply(text);
    const topicId = (ctx.message as { message_thread_id?: number; } | undefined)?.message_thread_id;
    const userId = ctx.from?.id;
    if (!Number.isSafeInteger(userId) || (userId ?? 0) <= 0) {
      await reply("파일을 보낸 사용자를 확인할 수 없습니다.");
      return;
    }
    const pendingKey = pendingStartKey(userId!, topicId);

    // 각 파일을 순차 다운로드·전사한다. 일부 실패는 건너뛰고 성공분만 진행한다.
    const saved: {
      filename: string;
      fileType: string;
      savedPath: string;
      transcript: string | null;
      transcriptError: string | null;
    }[] = [];
    const downloadErrors: string[] = [];
    for (const item of items) {
      let savedPath: string;
      try {
        savedPath = await downloadFile(item.fileId, item.filename);
      } catch (error) {
        downloadErrors.push(`${item.filename}: ${safeErrorMessage(error)}`);
        continue;
      }
      // 음성/오디오는 로컬 whisper.cpp로 받아쓰기(STT)해 텍스트를 함께 전달한다.
      // 실패해도 파일 저장·경로 전달은 유지하고 안내만 덧붙인다(완만한 강등).
      let transcript: string | null = null;
      let transcriptError: string | null = null;
      if (item.transcribe && config.stt.enabled) {
        try {
          transcript = await transcribeAudio(savedPath, config.stt);
        } catch (error) {
          transcriptError = safeErrorMessage(error);
          console.error("음성 받아쓰기 실패:", transcriptError);
        }
      }
      saved.push({ filename: item.filename, fileType: item.fileType, savedPath, transcript, transcriptError });
    }

    if (saved.length === 0) {
      await reply(`파일 다운로드 실패:\n${downloadErrors.join("\n")}`);
      return;
    }

    // 첨부 메시지를 구성한다. 각 파일의 '저장 경로:' 줄은 provider-progress의 첨부 파서가
    // 그대로 읽으므로 파일마다 한 줄씩 유지해야 한다.
    let fileMessage: string;
    if (saved.length === 1) {
      const only = saved[0]!;
      const parts = ["[첨부 파일]", `종류: ${only.fileType}`, `파일명: ${only.filename}`, `저장 경로: ${only.savedPath}`];
      if (only.transcript) parts.push(`받아쓰기: ${only.transcript}`);
      else if (only.transcriptError) parts.push(`받아쓰기 실패: ${only.transcriptError}`);
      if (caption) parts.push(`캡션: ${caption}`);
      fileMessage = parts.join("\n");
    } else {
      const parts = [`[첨부 파일 ${saved.length}개]`];
      saved.forEach((file, index) => {
        parts.push(`${index + 1}. 종류: ${file.fileType} · 파일명: ${file.filename}`);
        parts.push(`저장 경로: ${file.savedPath}`);
        if (file.transcript) parts.push(`받아쓰기: ${file.transcript}`);
        else if (file.transcriptError) parts.push(`받아쓰기 실패: ${file.transcriptError}`);
      });
      if (caption) parts.push(`캡션: ${caption}`);
      fileMessage = parts.join("\n");
    }

    // 새 세션 토픽 제목 등에 쓸 대표 문구: 캡션 > 받아쓰기 > 파일명 순.
    const firstTranscript = saved.find((file) => file.transcript)?.transcript ?? null;
    const fileLabel = caption
      || firstTranscript
      || (saved.length > 1 ? `첨부 ${saved.length}개` : saved[0]!.filename);
    // 사용자 회신에 덧붙일 저장/받아쓰기 안내.
    const savedNote = saved.length === 1
      ? `파일 저장: ${saved[0]!.savedPath}`
      : `파일 ${saved.length}개 저장:\n${saved.map((file) => `- ${file.savedPath}`).join("\n")}`;
    const transcriptNoteLines = saved
      .map((file) => file.transcript
        ? `받아쓰기: ${file.transcript}`
        : file.transcriptError
          ? `받아쓰기 실패: ${file.transcriptError}`
          : null)
      .filter((line): line is string => line !== null);
    const transcriptNote = transcriptNoteLines.length > 0 ? `\n${transcriptNoteLines.join("\n")}` : "";
    const downloadNote = downloadErrors.length > 0
      ? `\n일부 파일 다운로드 실패:\n${downloadErrors.join("\n")}`
      : "";
    const replyNote = `${savedNote}${transcriptNote}${downloadNote}`;

    const existing = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (existing && await permissions.handleTextInput(existing.id, fileMessage)) {
      await reply(`${replyNote}\n승인 대기 중인 세션에 전달했습니다.`);
      return;
    }

    const pending = pendingStarts.get(pendingKey);
    if (pending) {
      pendingStarts.delete(pendingKey);
      let project: ProjectConfig;
      try {
        project = pending.kind === "project"
          ? pending.project
          : await selectProjectForTask(fileMessage, pending.selectionDefaults);
        await startSessionFromOptions(
          project,
          fileMessage,
          pending,
          pending.pendingTopicId,
          fileLabel
        );
      } catch (error) {
        if (!topicId || !store.getSessionByTopic(config.chatId, topicId)) {
          pendingStarts.set(pendingKey, pending);
        }
        await reply(`${replyNote}\n프로젝트 자동 선택 실패: ${safeErrorMessage(error)}\n이 토픽은 유지되므로 다시 시도하실 수 있습니다.`);
        return;
      }
      return;
    }

    if (!existing) {
      await reply(`${replyNote}\n/new로 새 세션을 시작하거나 세션 토픽에서 전송하세요.`);
      return;
    }

    if (sessions.isActive(existing.id) && !sessions.isFinalizing(existing.id)) {
      if (!sessions.steer(existing.id, fileMessage)) {
        await reply("실행 중인 세션에 파일 정보를 전달하지 못했습니다. 잠시 후 다시 시도하세요.");
        return;
      }
      await reply(`${replyNote}\n실행 중인 세션에 전달했습니다.`);
      return;
    }

    if (!sessions.resume(existing, fileMessage)) {
      await reply("이 세션은 이미 실행 중이거나 이어 갈 대화 문맥이 없습니다.");
      return;
    }
    await reply(`${replyNote}\n파일 정보로 후속 작업을 시작했습니다.`);
  }

  const deps: BotDeps = {
    config,
    store,
    transport,
    permissions,
    sessions,
    fetchClaudeUsage,
    pendingStarts,
    pendingReserves,
    folderBrowsers,
    defaultPanelKeyboard,
    pendingFieldsForDefaults,
    startSessionFromOptions,
    openPendingStartTopic,
    openPendingAutoStartTopic,
    showFolderBrowserRoot,
    showFolderBrowser,
    projectFromSelectedFolder,
    openPendingReserveTopic,
    openPendingAutoReserveTopic,
    selectProjectForTask,
    refreshProjectCatalog: async () => (await projectCatalog.refreshAll()).entries.length,
    scheduleReservedTask,
    cancelReservedTimer,
    reservedTaskCancelKeyboard,
    handleFile,
    handleMediaMessage,
    resolveSessionUploadPath
  };

  registerBotHandlers(bot, deps);

  bot.catch((error) => {
    console.error(
      "Telegram update failed:",
      safeErrorMessage(error.error, [config.telegramBotToken, ...config.claudeCodeOauthTokens])
    );
  });

  let disposePromise: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposePromise = (async () => {
      await topicDeletionMonitor?.stop().catch((error: unknown) => {
        console.error("MTProto topic deletion monitor shutdown failed:", safeErrorMessage(error));
      });
      for (const timer of reserveTimers.values()) clearTimeout(timer);
      reserveTimers.clear();
      for (const group of mediaGroups.values()) clearTimeout(group.timer);
      mediaGroups.clear();
      pendingStarts.dispose();
      pendingReserves.dispose();
      folderBrowsers.dispose();
      try {
        await sessions.dispose();
      } finally {
        try {
          await projectCatalog.dispose();
        } finally {
          permissions.dispose();
          telegramAgent?.destroy();
        }
      }
    })();
    return disposePromise;
  };

  const startTopicDeletionMonitor = async (): Promise<boolean> => {
    if (!topicDeletionMonitor) return false;
    await topicDeletionMonitor.start();
    return true;
  };

  const startProjectCatalog = async (): Promise<number> =>
    (await projectCatalog.start()).entries.length;

  return {
    bot,
    sessions,
    permissions,
    projectCatalog,
    startProjectCatalog,
    startTopicDeletionMonitor,
    dispose
  };
}
