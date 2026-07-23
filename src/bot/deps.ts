import type { InlineKeyboard, Keyboard } from "grammy";
import type { AppConfig } from "../config.js";
import type { GuiClaudeUsageDto } from "../usage-contract.js";
import type { PermissionBroker } from "../permission-broker.js";
import type { SessionManager } from "../session-manager.js";
import type { StateStore } from "../store.js";
import type { TelegramTransport } from "../telegram-transport.js";
import type {
  ProjectConfig,
  ReservedTaskRecord,
  ReservedTaskStartOptions,
  SessionDefaults,
  SessionRecord
} from "../types.js";
import type { DriveEntry, FolderBrowserState } from "./drive-browser.js";
import type { PendingStart, PendingStartOptions } from "./pending-keys.js";

interface PendingReserveBase {
  topicId: number;
  startOptions: ReservedTaskStartOptions;
  defaultsSummaryText: string;
}

export type PendingReserve = PendingReserveBase & (
  | { kind: "project"; project: ProjectConfig; }
  | { kind: "auto-project"; selectionDefaults: SessionDefaults; }
);

export interface FileHandlerContext {
  from?: { id: number; };
  message?: { message_thread_id?: number; caption?: string; };
  reply: (text: string) => Promise<unknown>;
}

export interface FileDescriptor {
  fileId: string;
  filename: string;
  fileType: string;
  transcribe?: boolean;
}

export interface BotDeps {
  config: AppConfig;
  store: StateStore;
  transport: TelegramTransport;
  permissions: PermissionBroker;
  sessions: SessionManager;
  /** Terminal 사용량 바와 같은 Claude 웹 구독 수치 조회. */
  fetchClaudeUsage: () => Promise<GuiClaudeUsageDto | null>;
  pendingStarts: Map<string, PendingStart>;
  pendingReserves: Map<string, PendingReserve>;
  folderBrowsers: Map<string, FolderBrowserState>;
  defaultPanelKeyboard: (defaults: SessionDefaults) => Keyboard;
  pendingFieldsForDefaults: (defaults: SessionDefaults) => Partial<PendingStartOptions>;
  startSessionFromOptions: (
    project: ProjectConfig,
    prompt: string | ((session: SessionRecord) => string),
    options: Partial<PendingStartOptions>,
    topicId?: number | null,
    titlePrompt?: string
  ) => Promise<SessionRecord>;
  openPendingStartTopic: (
    userId: number,
    project: ProjectConfig,
    defaults: SessionDefaults,
    options: Partial<PendingStartOptions>
  ) => Promise<void>;
  openPendingAutoStartTopic: (
    userId: number,
    defaults: SessionDefaults,
    options: Partial<PendingStartOptions>
  ) => Promise<void>;
  showFolderBrowserRoot: (
    key: string,
    callbackPrefix: string,
    send: (text: string, keyboard: InlineKeyboard) => Promise<unknown>
  ) => Promise<void>;
  showFolderBrowser: (
    key: string,
    path: string,
    drives: DriveEntry[] | null,
    rootPath: string,
    driveLabel: string,
    callbackPrefix: string,
    send: (text: string, keyboard: InlineKeyboard) => Promise<unknown>
  ) => Promise<void>;
  projectFromSelectedFolder: (path: string) => ProjectConfig;
  openPendingReserveTopic: (userId: number, project: ProjectConfig, defaults: SessionDefaults) => Promise<number>;
  openPendingAutoReserveTopic: (userId: number, defaults: SessionDefaults) => Promise<number>;
  selectProjectForTask: (task: string, defaults: SessionDefaults) => Promise<ProjectConfig>;
  refreshProjectCatalog: () => Promise<number>;
  scheduleReservedTask: (task: ReservedTaskRecord) => void;
  cancelReservedTimer: (taskId: string) => void;
  reservedTaskCancelKeyboard: () => InlineKeyboard | null;
  handleFile: (
    ctx: FileHandlerContext,
    fileId: string,
    filename: string,
    fileType: string,
    caption: string | undefined,
    options?: { transcribe?: boolean; }
  ) => Promise<void>;
  handleMediaMessage: (
    ctx: FileHandlerContext,
    item: FileDescriptor,
    mediaGroupId: string | undefined,
    caption: string | undefined
  ) => Promise<void>;
  resolveSessionUploadPath: (cwd: string, inputPath: string) => Promise<string>;
}
