import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { Agent as HttpsAgent, get as httpsGet } from "node:https";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { Bot, InlineKeyboard, Keyboard } from "grammy";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { addProject, removeProject, resolveProject, type AppConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import {
  agyModelLabel,
  agyThinkingLabel,
  agyThinkingOptions,
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
  DEFAULT_THINKING_LEVEL,
  FALLBACK_MODEL_CATALOG,
  type ModelCatalog,
  modelLabel,
  normalizeThinkingForModel,
  resolveAgyModel,
  resolveAgyThinkingLevel,
  resolveCodexModel,
  resolveModel,
  thinkingLabel,
  thinkingToggleOptionsForModel
} from "./model-catalog.js";
import { PermissionBroker } from "./permission-broker.js";
import {
  buildMemoryPrompt,
  MAX_GOAL_ROUNDS,
  SessionManager
} from "./session-manager.js";
import { StateStore } from "./store.js";
import { agentStrengthsPath, loadStrengthHints, routeProvider, wikiVaultPath } from "./router.js";
import { safeErrorMessage, TelegramTransport } from "./telegram-transport.js";
import type { ProjectConfig, ProviderKind, SessionDefaults, SessionRecord } from "./types.js";
import {
  formatAgyUsage,
  formatCodexAccountUsage,
  formatUsageSnapshot,
  parseStoredAgyUsage
} from "./usage.js";

const execFileAsync = promisify(execFile);

interface PendingStart {
  project: ProjectConfig;
  resumeSessionId?: string;
  forkSession?: boolean;
  provider?: ProviderKind | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  claudeEffort?: string | undefined;
  claudeTokenIndex?: number | null | undefined;
  codexModel?: string | undefined;
  codexReasoning?: string | undefined;
  codexHome?: string | null | undefined;
  agyThinkingLevel?: string | undefined;
  agyModel?: string | undefined;
  handoffSummary?: string | undefined;
  leanMode?: boolean | undefined;
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

function parseTokenId(input: string): number | null {
  const value = Number.parseInt(input.trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
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

function codexAccountLabel(
  codexHome: string | null | undefined,
  codexAccountHomes: readonly string[]
): string | null {
  if (!codexHome) return null;
  const accountIndex = codexAccountHomes.findIndex((home) => home === codexHome);
  return accountIndex >= 0
    ? `Codex 계정: #${accountIndex + 1}`
    : "Codex 계정: 지정됨";
}

function selectedCodexAccountIndex(
  codexHome: string | null | undefined,
  codexAccountHomes: readonly string[]
): number {
  if (codexAccountHomes.length === 0) return -1;
  if (!codexHome) return 0;
  const index = codexAccountHomes.findIndex((home) => home === codexHome);
  return index >= 0 ? index : 0;
}

function selectedClaudeTokenIndex(
  claudeTokenIndex: number | null | undefined,
  claudeTokenCount: number
): number {
  if (claudeTokenCount <= 0) return -1;
  if (typeof claudeTokenIndex !== "number" || !Number.isInteger(claudeTokenIndex)) return 0;
  return claudeTokenIndex >= 0 && claudeTokenIndex < claudeTokenCount ? claudeTokenIndex : 0;
}

export function formatSessionStatus(
  session: SessionRecord,
  active: boolean,
  catalog: ModelCatalog = FALLBACK_MODEL_CATALOG,
  codexAccountHomes: readonly string[] = [],
  claudeTokenCount = 1
): string {
  const state = session.status === "waiting_approval"
    ? "승인 대기 중"
    : session.status === "waiting_limit"
      ? "한도 회복 대기 중 (회복 시 자동 재개)"
    : session.status === "verification_failed"
      ? "완료 검증 실패"
    : active
      ? "실행 중"
      : session.status === "queued"
      ? "대기 중"
      : "실행 중인 작업 없음";
  const codexAccount = codexAccountLabel(session.codexHome, codexAccountHomes);
  const claudeTokenIndex = selectedClaudeTokenIndex(session.claudeTokenIndex, claudeTokenCount);
  const providerLines = session.provider === "codex"
    ? [
        "제공자: Codex",
        `Codex 모델: ${codexModelLabel(catalog, session.codexModel ?? DEFAULT_CODEX_MODEL)} · reasoning ${codexReasoningLabel(session.codexReasoning ?? DEFAULT_CODEX_REASONING)}`,
        ...(codexAccount ? [codexAccount] : [])
      ]
    : session.provider === "agy"
    ? [
        "제공자: agy (Antigravity CLI)",
        `agy 모델: ${agyModelLabel(catalog, session.agyModel ?? DEFAULT_AGY_MODEL)}`,
        `agy 추론 강도: ${agyThinkingLabel(session.agyThinkingLevel ?? DEFAULT_AGY_THINKING_LEVEL)}`,
        "MCP: ~/.gemini/config/mcp_config.json"
      ]
    : [
        "제공자: Claude",
        `모델: ${modelLabel(catalog, session.model ?? DEFAULT_CLAUDE_MODEL)}`,
        `thinking: ${thinkingLabel(session.thinking ?? DEFAULT_THINKING_LEVEL)}`,
        `Claude 작업량: ${claudeEffortLabel(session.claudeEffort ?? DEFAULT_CLAUDE_EFFORT)}`,
        ...(claudeTokenCount > 1 && claudeTokenIndex >= 0 ? [`Claude 토큰: #${claudeTokenIndex + 1}`] : [])
      ];
  return [
    "오케스트레이터: 정상 응답",
    `작업: ${state}`,
    `저장 상태: ${session.status}`,
    `프로젝트: ${session.projectName}`,
    ...providerLines,
    `권한 모드: ${session.permissionMode}`,
    `lean: ${session.leanMode ? "on" : "off"}`,
    ...(session.goalCondition ? [`목표(자동 진행): ${session.goalCondition}`] : []),
    `마지막 상태 변경: ${formatTimestamp(session.updatedAt)}`
  ].join("\n");
}

// 새 세션 기본값을 보여주는 상시 reply 키보드(ChatKJB식). 좌상 라벨, 우상 모델,
// 좌하 제공자, 우하 thinking(Claude) 또는 추론 강도(Codex).
function providerDisplayLabel(provider: ProviderKind): string {
  if (provider === "codex") return "Codex";
  if (provider === "agy") return "agy";
  return "Claude";
}

// 아직 배선되지 않은 빈 패널 슬롯 라벨. 추후 제공자별 추가 선택 항목을 여기에 연결한다.
// (user 요청: 빈 패널은 '-' 표기, 추후 배선 가능성만 열어둔다.)
const RESERVED_SLOT_LABEL = "➖";

function defaultsKeyboard(
  defaults: SessionDefaults,
  catalog: ModelCatalog,
  codexAccountHomes: readonly string[] = [],
  claudeTokenCount = 1
): Keyboard {
  const providerLabel = providerDisplayLabel(defaults.provider);
  const modelText = defaults.provider === "codex"
    ? codexModelLabel(catalog, defaults.codexModel)
    : defaults.provider === "agy"
    ? agyModelLabel(catalog, defaults.agyModel)
    : modelLabel(catalog, defaults.claudeModel);
  const fourth = defaults.provider === "codex"
    ? `💭 추론: ${codexReasoningLabel(defaults.codexReasoning)}`
    : defaults.provider === "agy"
    ? `💭 추론: ${agyThinkingLabel(defaults.agyThinkingLevel)}`
    : `💭 thinking: ${defaults.thinking === "off" ? "off" : "on"}`;
  // 5번째 슬롯: Claude는 작업량(effort)을 thinking과 별개 축으로 토글한다.
  // Codex·agy는 추론 강도(💭)가 작업량을 겸하므로 추가로 고를 게 없어 예약('-') 처리한다.
  const fifth = defaults.provider === "claude"
    ? `🛠️ 작업량: ${claudeEffortLabel(defaults.claudeEffort)}`
    : RESERVED_SLOT_LABEL;
  const codexAccountIndex = selectedCodexAccountIndex(defaults.codexHome, codexAccountHomes);
  const claudeTokenIndex = selectedClaudeTokenIndex(defaults.claudeTokenIndex, claudeTokenCount);
  // 6번째 슬롯: Claude/Codex 제공자에서는 토큰 선택 버튼, agy는 예약 슬롯.
  const sixth = defaults.provider === "codex" && codexAccountHomes.length > 1 && codexAccountIndex >= 0
    ? `🔑 토큰: #${codexAccountIndex + 1}`
    : defaults.provider === "claude" && claudeTokenCount > 1 && claudeTokenIndex >= 0
    ? `🔑 토큰: #${claudeTokenIndex + 1}`
    : RESERVED_SLOT_LABEL;
  return new Keyboard()
    .text("⚙️ 새 세션 기본값")
    .text(`🧠 모델: ${modelText}`)
    .row()
    .text(`🤖 제공자: ${providerLabel}`)
    .text(fourth)
    .row()
    .text(fifth)
    .text(sixth)
    .resized()
    .persistent();
}

// 기본값 패널의 모델 선택용 인라인 키보드(제공자별). setm:<provider>:<id>
function defaultsModelKeyboard(defaults: SessionDefaults, catalog: ModelCatalog): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const options = defaults.provider === "codex"
    ? catalog.codexModels.map((option) => ({ id: option.id, label: option.label }))
    : defaults.provider === "agy"
    ? catalog.agyModels.map((option) => ({ id: option.id, label: option.label }))
    : catalog.claudeModels.map((option) => ({ id: option.id, label: option.label }));
  for (const [index, option] of options.entries()) {
    keyboard.text(option.label, `setm:${defaults.provider}:${option.id}`);
    if (index < options.length - 1) keyboard.row();
  }
  return keyboard;
}

// 기본값 패널의 추론 강도/thinking 선택용 인라인 키보드(제공자별). setr:<provider>:<id>
// 현재 선택값에는 ✅를 붙인다. Claude는 thinking on/off 두 선택지로 노출한다.
function defaultsReasoningKeyboard(defaults: SessionDefaults, catalog: ModelCatalog): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const options = defaults.provider === "codex"
    ? codexReasoningOptionsForModel(catalog, defaults.codexModel)
        .map((option) => ({ id: option.id, label: option.label, current: option.id === defaults.codexReasoning }))
    : defaults.provider === "agy"
    ? agyThinkingOptions()
        .map((option) => ({ id: option.id, label: option.label, current: option.id === defaults.agyThinkingLevel }))
    : [
        { id: "adaptive", label: "on", current: defaults.thinking !== "off" },
        { id: "off", label: "off", current: defaults.thinking === "off" }
      ];
  for (const [index, option] of options.entries()) {
    const mark = option.current ? "✅ " : "";
    keyboard.text(`${mark}${option.label}`, `setr:${defaults.provider}:${option.id}`);
    if (index < options.length - 1) keyboard.row();
  }
  return keyboard;
}

// 기본값 패널의 Claude 작업량(effort) 선택용 인라인 키보드. sete:<provider>:<id>
// thinking(💭, on/off)과는 별개의 축이며 Claude 전용이다. 현재 선택값에는 ✅를 붙인다.
function defaultsEffortKeyboard(defaults: SessionDefaults, catalog: ModelCatalog): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const options = claudeEffortOptionsForModel(catalog, defaults.claudeModel)
    .map((option) => ({ id: option.id, label: option.label, current: option.id === defaults.claudeEffort }));
  for (const [index, option] of options.entries()) {
    const mark = option.current ? "✅ " : "";
    keyboard.text(`${mark}${option.label}`, `sete:${defaults.provider}:${option.id}`);
    if (index < options.length - 1) keyboard.row();
  }
  return keyboard;
}

function defaultsSummary(defaults: SessionDefaults, catalog: ModelCatalog): string {
  if (defaults.provider === "codex") {
    return `Codex · ${codexModelLabel(catalog, defaults.codexModel)} · reasoning ${codexReasoningLabel(defaults.codexReasoning)}`;
  }
  if (defaults.provider === "agy") {
    return `agy · ${agyModelLabel(catalog, defaults.agyModel)} · 추론 ${agyThinkingLabel(defaults.agyThinkingLevel)}`;
  }
  return `Claude · ${modelLabel(catalog, defaults.claudeModel)} · thinking ${defaults.thinking === "off" ? "off" : "on"} · 작업량 ${claudeEffortLabel(defaults.claudeEffort)}`;
}

// 새 세션 기본값을 PendingStart 필드로 변환한다. provider에 따라 해당 제공자 설정만 채운다.
function pendingFieldsFromDefaults(defaults: SessionDefaults): Partial<PendingStart> {
  if (defaults.provider === "codex") {
    return {
      provider: "codex",
      codexModel: defaults.codexModel,
      codexReasoning: defaults.codexReasoning,
      codexHome: defaults.codexHome,
      leanMode: true
    };
  }
  if (defaults.provider === "agy") {
    return {
      provider: "agy",
      agyThinkingLevel: defaults.agyThinkingLevel,
      agyModel: defaults.agyModel,
      leanMode: true
    };
  }
  return {
      provider: "claude",
      model: defaults.claudeModel,
      thinking: defaults.thinking,
      claudeEffort: defaults.claudeEffort,
      claudeTokenIndex: defaults.claudeTokenIndex,
      leanMode: true
    };
}

function projectKeyboard(projects: ProjectConfig[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, project] of projects.entries()) {
    keyboard.text(project.name, `newp:${index}`).row();
  }
  return keyboard;
}

export function modelKeyboard(catalog: ModelCatalog = FALLBACK_MODEL_CATALOG): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, option] of catalog.claudeModels.entries()) {
    keyboard.text(option.label, `model:${option.id}`);
    if (index < catalog.claudeModels.length - 1) keyboard.row();
  }
  return keyboard;
}

function thinkingKeyboard(catalog: ModelCatalog, modelId: string | null | undefined): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const options = thinkingToggleOptionsForModel(catalog, modelId);
  for (const [index, option] of options.entries()) {
    keyboard.text(option.label, `think:${option.id}`);
    if (index < options.length - 1) keyboard.row();
  }
  return keyboard;
}

function powerKeyboardForSession(session: SessionRecord, catalog: ModelCatalog): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const options = session.provider === "codex"
    ? codexReasoningOptionsForModel(catalog, session.codexModel ?? DEFAULT_CODEX_MODEL)
      .map((option) => ({ callback: `power:codex:${option.id}`, label: option.label }))
    : session.provider === "agy"
    ? agyThinkingOptions()
      .map((option) => ({ callback: `power:agy:${option.id}`, label: option.label }))
    : claudeEffortOptionsForModel(catalog, session.model ?? DEFAULT_CLAUDE_MODEL)
      .map((option) => ({ callback: `power:claude:${option.id}`, label: option.label }));
  for (const [index, option] of options.entries()) {
    keyboard.text(option.label, option.callback);
    if (index < options.length - 1) keyboard.row();
  }
  return keyboard;
}

function agyThinkingKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const options = agyThinkingOptions();
  for (const [index, option] of options.entries()) {
    keyboard.text(option.label, `power:agy:${option.id}`);
    if (index < options.length - 1) keyboard.row();
  }
  return keyboard;
}

// /model에서 세션의 Codex 모델을 고르는 인라인 키보드. cmodel:<id>
function codexModelKeyboard(catalog: ModelCatalog): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, option] of catalog.codexModels.entries()) {
    keyboard.text(option.label, `cmodel:${option.id}`);
    if (index < catalog.codexModels.length - 1) keyboard.row();
  }
  return keyboard;
}

// /model에서 세션의 agy 모델을 고르는 인라인 키보드. amodel:<id>
function agyModelKeyboard(catalog: ModelCatalog): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, option] of catalog.agyModels.entries()) {
    keyboard.text(option.label, `amodel:${option.id}`);
    if (index < catalog.agyModels.length - 1) keyboard.row();
  }
  return keyboard;
}

// /model에서 제공자를 고르는 인라인 키보드. mprov:claude|codex|agy
function providerKeyboard(current: ProviderKind): InlineKeyboard {
  return new InlineKeyboard()
    .text(`${current === "claude" ? "✅ " : ""}Claude`, "mprov:claude")
    .text(`${current === "codex" ? "✅ " : ""}Codex`, "mprov:codex")
    .row()
    .text(`${current === "agy" ? "✅ " : ""}agy`, "mprov:agy");
}

// 기본값 패널: 새 세션 기본 제공자 선택. 콜백 dprov:<provider> (mprov:과 의미 다름 — 요약 인계 없음)
function defaultsProviderKeyboard(current: ProviderKind): InlineKeyboard {
  const options: Array<[ProviderKind, string]> = [
    ["claude", "Claude"],
    ["codex", "Codex"],
    ["agy", "agy"]
  ];
  const keyboard = new InlineKeyboard();
  for (const [index, [kind, label]] of options.entries()) {
    const mark = kind === current ? "✅ " : "";
    keyboard.text(`${mark}${label}`, `dprov:${kind}`);
    if (index < options.length - 1) keyboard.row();
  }
  return keyboard;
}

function effortKeyboard(catalog: ModelCatalog): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const options = codexReasoningOptionsForModel(catalog, DEFAULT_CODEX_MODEL);
  for (const [index, option] of options.entries()) {
    keyboard.text(option.label, `effort:${option.id}`);
    if (index < options.length - 1) keyboard.row();
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

function usageRateLimitWarning(): string {
  return "참고: Claude 서버가 현재 OAuth 토큰에 대해 한도 창(rate_limits)을 반환하지 않았습니다. "
    + "`claude setup-token`을 다시 실행해 사용량 조회 권한이 포함된 토큰으로 갱신해야 정확한 한도 수치가 표시됩니다.";
}

export function createBot(config: AppConfig, store: StateStore) {
  // 이 Mac에서는 api.telegram.org의 IPv6 경로가 간헐적으로 연결만 성립한 채
  // 응답 없이 시간 초과된다. Bot API 트래픽을 정상 동작하는 IPv4 경로에 고정한다.
  // 파일 다운로드(아래 downloadFile)도 같은 에이전트를 공유해 IPv6로 새지 않게 한다.
  const ipv4Agent = new HttpsAgent({ family: 4, keepAlive: true });
  const bot = new Bot(config.telegramBotToken, {
    client: {
      baseFetchConfig: {
        agent: ipv4Agent
      }
    }
  });
  const transport = new TelegramTransport(bot.api);
  const permissions = new PermissionBroker(store, transport, config.approvalTimeoutMs);
  const sessions = new SessionManager(store, transport, permissions, {
    debounceMs: config.statusDebounceMs,
    claudeCodeOauthToken: config.claudeCodeOauthToken,
    additionalOauthTokens: config.claudeCodeOauthTokens.slice(1),
    codexAccountHomes: config.codexAccountHomes,
    mcpToolTimeoutMs: config.mcpToolTimeoutMs,
    mcpMaxAttempts: config.mcpMaxAttempts,
    codexMcpTimeoutMs: config.codexMcpTimeoutMs,
    codexMcpHeartbeatMs: config.codexMcpHeartbeatMs,
    longRunningMcpServers: config.longRunningMcpServers,
    turnIdleTimeoutMs: config.turnIdleTimeoutMs,
    claudeMemoryDir: config.claudeMemoryDir,
    geminiApiKey: config.geminiApiKey,
    agySdkPython: config.agySdkPython,
    modelCatalog: config.modelCatalog,
    ...(config.claudeCodeExecutable
      ? { claudeCodeExecutable: config.claudeCodeExecutable }
      : {}),
    ...(config.agyExecutable
      ? { agyExecutable: config.agyExecutable }
      : {})
  });
  const pendingStarts = new Map<string, PendingStart>();
  const pendingProjectPaths = new Set<string>();
  const defaultPanelKeyboard = (defaults: SessionDefaults) =>
    defaultsKeyboard(
      defaults,
      config.modelCatalog,
      config.codexAccountHomes,
      config.claudeCodeOauthTokens.length
    );
  const pendingFieldsForDefaults = (defaults: SessionDefaults): Partial<PendingStart> => {
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

  const registerProject = async (path: string): Promise<ProjectConfig> => {
    const project = await addProject(config.projectsPath, config.projects, cleanPathInput(path));
    const existingIndex = config.projects.findIndex((item) => item.name === project.name);
    if (existingIndex === -1) {
      config.projects.push(project);
    } else {
      config.projects[existingIndex] = project;
    }
    store.syncProjects([project]);
    return project;
  };

  const unregisterProject = async (identifier: string): Promise<ProjectConfig> => {
    const project = await removeProject(config.projectsPath, config.projects, identifier);
    const index = config.projects.findIndex((item) => item.name === project.name);
    if (index !== -1) config.projects.splice(index, 1);
    // 세션이 참조하지 않을 때만 저장소 행을 지운다(외래키 무결성 유지).
    if (store.countSessionsByProject(project.name) === 0) {
      store.deleteProject(project.name);
    }
    return project;
  };

  const confirmDeleteProjectKeyboard = (index: number): InlineKeyboard =>
    new InlineKeyboard()
      .text("프로젝트 삭제", `delproj:${index}`)
      .row()
      .text("취소", "delprojcancel");

  const deleteProjectConfirmText = (project: ProjectConfig): string =>
    `프로젝트를 등록 목록에서 삭제합니다. 되돌릴 수 없습니다.\n`
    + `폴더의 실제 파일은 지우지 않습니다.\n\n`
    + `${project.name}\n${project.cwd}`;

  bot.use(async (ctx, next) => {
    if (!ctx.from || !config.allowedUserIds.includes(ctx.from.id)) return;
    if (ctx.chat?.id !== config.chatId) return;
    await next();
  });

  async function downloadFile(fileId: string, filename: string): Promise<string> {
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
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const req = httpsGet(url, { agent: ipv4Agent }, (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.resume();
          reject(new Error(`다운로드 실패: ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      });
      req.on("error", reject);
    });
    await writeFile(dest, buffer);
    return dest;
  }

  async function handleFile(
    ctx: { message?: { message_thread_id?: number; caption?: string }; reply: (text: string) => Promise<unknown> },
    fileId: string,
    filename: string,
    fileType: string,
    caption: string | undefined
  ): Promise<void> {
    const topicId = (ctx.message as { message_thread_id?: number } | undefined)?.message_thread_id;
    const pendingKey = pendingStartKey(config.allowedUserId, topicId);

    let savedPath: string;
    try {
      savedPath = await downloadFile(fileId, filename);
    } catch (error) {
      await (ctx as { reply: (text: string) => Promise<unknown> }).reply(`파일 다운로드 실패: ${safeErrorMessage(error)}`);
      return;
    }

    const parts = ["[첨부 파일]", `종류: ${fileType}`, `파일명: ${filename}`, `저장 경로: ${savedPath}`];
    if (caption) parts.push(`캡션: ${caption}`);
    const fileMessage = parts.join("\n");

    if (pendingProjectPaths.has(pendingKey)) {
      await (ctx as { reply: (text: string) => Promise<unknown> }).reply(`파일 저장: ${savedPath}\n경로 추가 중에는 텍스트로 절대경로를 입력하세요.`);
      return;
    }

    const existing = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (existing && await permissions.handleTextInput(existing.id, fileMessage)) {
      await (ctx as { reply: (text: string) => Promise<unknown> }).reply(`파일 저장: ${savedPath}\n승인 대기 중인 세션에 전달했습니다.`);
      return;
    }

    const pending = pendingStarts.get(pendingKey);
    if (pending) {
      pendingStarts.delete(pendingKey);
      const title = topicTitle(pending.project.name, caption || filename);
      const newTopicId = await transport.createTopic(config.chatId, title);
      const session = sessions.createSession(
        pending.project, config.chatId, newTopicId, title,
        fileMessage, pending.resumeSessionId, pending.forkSession ?? false,
        pending.model ?? null, pending.thinking ?? null,
        pending.claudeEffort ?? null, pending.leanMode ?? true,
        pending.provider ?? "claude", pending.codexModel ?? null,
        pending.codexReasoning ?? null, pending.agyThinkingLevel ?? null, pending.agyModel ?? null,
        pending.handoffSummary ?? null, pending.codexHome ?? null, pending.claudeTokenIndex ?? null
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
      );
      return;
    }

    if (!existing) {
      await (ctx as { reply: (text: string) => Promise<unknown> }).reply(`파일 저장: ${savedPath}\n/new로 새 세션을 시작하거나 세션 토픽에서 전송하세요.`);
      return;
    }

    if (sessions.isActive(existing.id)) {
      sessions.steer(existing.id, fileMessage);
      await (ctx as { reply: (text: string) => Promise<unknown> }).reply(`파일 저장: ${savedPath}\n실행 중인 세션에 전달했습니다.`);
      return;
    }

    if (!sessions.resume(existing, fileMessage)) {
      await (ctx as { reply: (text: string) => Promise<unknown> }).reply("이 세션은 이미 실행 중이거나 이어 갈 대화 문맥이 없습니다.");
      return;
    }
    await (ctx as { reply: (text: string) => Promise<unknown> }).reply(`파일 저장: ${savedPath}\n파일 정보로 후속 작업을 시작했습니다.`);
  }

  bot.command("start", async (ctx) => {
    const defaults = store.getSessionDefaults();
    await ctx.reply(
      "Claude/Codex/agy 세션 오케스트레이터\n\n/new 새 작업\n/status 현재 작동 상태\n/doctor 환경 진단\n/addp 프로젝트 경로 추가\n/deltp 프로젝트 삭제\n/sessions 최근 세션\n/usage 한도 사용량\n/projects 프로젝트 목록\n토픽 안에서 /steer, /next, /goal, /stop, /reset, /fork, /compact, /memory, /mode, /model, /thinking, /power, /lean, /diff, /upload, /delete 사용\n\n아래 기본값 패널 버튼으로 새 세션 기본값(제공자·모델·thinking/추론·작업량·토큰)을 클릭만으로 바꿀 수 있습니다.",
      { reply_markup: defaultPanelKeyboard(defaults) }
    );
  });

  bot.command("new", async (ctx) => {
    const defaults = store.getSessionDefaults();
    const identifier = ctx.match.trim();
    if (identifier) {
      const project = resolveProject(config.projects, identifier);
      if (!project) {
        await ctx.reply("프로젝트 이름 또는 별칭을 찾을 수 없습니다.");
        return;
      }
      pendingStarts.set(
        pendingStartKey(config.allowedUserId, ctx.message?.message_thread_id),
        { project, ...pendingFieldsForDefaults(defaults) }
      );
      await ctx.reply(
        `${project.name} 프로젝트 · ${defaultsSummary(defaults, config.modelCatalog)}\n실행할 작업을 입력하세요. (기본값은 아래 패널에서 변경)`,
        { reply_markup: defaultPanelKeyboard(defaults) }
      );
      return;
    }
    await ctx.reply("프로젝트를 선택하세요.", { reply_markup: projectKeyboard(config.projects) });
  });

  bot.command("tokenid", async (ctx) => {
    const pendingKey = pendingStartKey(config.allowedUserId, ctx.message?.message_thread_id);
    const pending = pendingStarts.get(pendingKey);
    if (!pending) {
      await ctx.reply("/new로 프로젝트를 먼저 선택한 뒤 첫 작업 메시지 전에 사용하세요.\n예: /tokenid 2");
      return;
    }
    if ((pending.provider ?? "claude") !== "codex") {
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

  bot.command("deltp", async (ctx) => {
    if (config.projects.length === 0) {
      await ctx.reply("등록된 프로젝트가 없습니다.");
      return;
    }
    const identifier = ctx.match.trim();
    if (!identifier) {
      const keyboard = new InlineKeyboard();
      for (const [index, project] of config.projects.entries()) {
        keyboard.text(project.name, `delp:${index}`).row();
      }
      await ctx.reply("삭제할 프로젝트를 선택하세요.", { reply_markup: keyboard });
      return;
    }
    const index = config.projects.findIndex((project) =>
      resolveProject([project], identifier) !== undefined
    );
    const project = config.projects[index];
    if (!project) {
      await ctx.reply("등록된 프로젝트를 찾을 수 없습니다. /projects 로 이름을 확인하세요.");
      return;
    }
    await ctx.reply(deleteProjectConfirmText(project), {
      reply_markup: confirmDeleteProjectKeyboard(index)
    });
  });

  // agy 영속 대화 파일(.db)이 존재하는지 확인하는 헬퍼.
  // save_dir은 scripts/agy-sdk-bridge.py의 LocalAgentConfig(save_dir=...) 값과 동기화.
  const agyConvDbPath = (convId: string) =>
    join(homedir(), ".local", "share", "telegram-claude-orchestrator", "agy-conversations", convId + ".db");

  bot.command("sessions", async (ctx) => {
    const recent = store.listSessions(15);
    if (recent.length === 0) {
      await ctx.reply("저장된 세션이 없습니다.");
      return;
    }
    const text = recent
      .map((session) => {
        // agy 세션이고 conversation_id가 있으면 재개 가능 여부를 힌트로 표시한다.
        let agyHint = "";
        if (session.provider === "agy" && session.agyConversationId) {
          const resumable = existsSync(agyConvDbPath(session.agyConversationId));
          agyHint = resumable ? " · 재개 가능" : " · 대화 파일 없음";
        }
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
          : "\n\nagy 토큰 사용량: 측정 전 (아직 턴이 실행되지 않았습니다)";
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
          agyLiveText = `\nagy 라이브: ${idleLabel} · ${turnLabel}`;
        } else {
          agyLiveText = `\nagy 라이브: 조회 실패 (${live.error ?? "알 수 없는 원인"})`;
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

  bot.command("usage", async (ctx) => {
    // 토픽 안에서 호출되고 해당 세션이 agy이면 네이티브 토큰 사용량을 먼저 보여준다.
    const topicId = ctx.message?.message_thread_id;
    const topicSession = topicId
      ? store.getSessionByTopic(config.chatId, topicId)
      : undefined;
    if (topicSession?.provider === "agy") {
      const stored = parseStoredAgyUsage(topicSession.agyUsage);
      if (stored) {
        await ctx.reply(formatAgyUsage(stored) + "\n원천: agy SDK 네이티브 (대화 누적)");
      } else {
        await ctx.reply(
          "agy 토큰 사용량: 측정 전\n"
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
    const liveWithSnapshots = liveResults.filter((result) => result.snapshot);
    if (liveWithSnapshots.length > 0) {
      const multiple = liveResults.length > 1;
      const sections = liveWithSnapshots.map((result) => {
        const snapshot = result.snapshot!;
        const measuredAt = new Date(snapshot.capturedAt).toLocaleString("ko-KR", {
          timeZone: "Asia/Seoul"
        });
        const heading = multiple ? `토큰 #${result.tokenIndex}\n` : "";
        const scopeWarning = snapshot.rateLimitsAvailable ? "" : `\n${usageRateLimitWarning()}`;
        return `${heading}${formatUsageSnapshot(snapshot)}\n측정: ${measuredAt}${scopeWarning}`;
      });
      const failed = liveResults
        .filter((result) => !result.snapshot)
        .map((result) => `토큰 #${result.tokenIndex}: 조회 실패${result.error ? ` (${result.error})` : ""}`);
      const failedText = failed.length > 0 ? `\n\n${failed.join("\n")}` : "";
      const codexText = `\n\n${formatCodexAccountUsage(sessions.getCodexUsageSnapshots())}`;
      await ctx.reply(
        `${sections.join("\n\n")}\n원천: Claude 서버 실시간 조회${failedText}${codexText}`
      );
      return;
    }

    const latest = store.listSessions(50).find((session) => session.usageSnapshot);
    const codexText = `\n\n${formatCodexAccountUsage(sessions.getCodexUsageSnapshots())}`;
    if (!latest?.usageSnapshot) {
      await ctx.reply(
        "실시간 사용량 조회에 실패했고, 저장된 한도 사용량도 없습니다."
        + (liveResults.length > 0
          ? `\n${liveResults.map((result) =>
              `토큰 #${result.tokenIndex}: ${result.error ?? "사용량 없음"}`
            ).join("\n")}`
          : "")
        + codexText
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
      + `\n\n${formatUsageSnapshot(latest.usageSnapshot)}\n측정: ${new Date(latest.usageSnapshot.capturedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`
      + codexText
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
    const hasContext = session.provider === "claude"
      ? !!session.sdkSessionId
      : session.provider === "codex"
      ? !!session.codexThreadId
      : !!session.agyConversationId;
    if (!hasContext || sessions.isActive(session.id)) {
      await ctx.reply("분기할 수 있는 완료 세션이 없습니다.");
      return;
    }
    const project = config.projects.find((item) => item.name === session.projectName);
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
    pendingStarts.set(pendingStartKey(config.allowedUserId, topicId), {
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
    const hasContext = session.provider === "claude"
      ? !!session.sdkSessionId
      : session.provider === "codex"
      ? !!session.codexThreadId
      : !!session.agyConversationId;
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
        + "Claude는 텔레그램 승인 브로커를 사용하고, Codex·agy는 같은 모드를 샌드박스와 실행 지침으로 적용합니다."
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
        + `agy는 다음 메시지부터 같은 대화${hasConv ? `(${session.agyConversationId!.slice(0, 8)}…)` : ""}를 `
        + `유지한 채 새 모드로 재구성됩니다.`
      );
      return;
    }
    await ctx.reply(`다음 실행부터 권한 모드를 ${mode}(으)로 사용합니다.`);
  });

  // /model: 제공자(Claude/Codex/agy)와 모델을 확인·변경한다. 제공자 전환은 버튼(mprov:)으로만
  // 하며, 전환 시 직전 provider가 만든 요약을 새 provider에 인계한다(SessionManager.switchProvider).
  bot.command("model", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const input = ctx.match.trim();
    if (!input) {
      const current = session.provider === "codex"
        ? `현재: Codex · ${codexModelLabel(config.modelCatalog, session.codexModel ?? DEFAULT_CODEX_MODEL)}`
        : session.provider === "agy"
        ? `현재: agy · ${agyModelLabel(config.modelCatalog, session.agyModel ?? DEFAULT_AGY_MODEL)}`
        : `현재: Claude · ${modelLabel(config.modelCatalog, session.model ?? DEFAULT_CLAUDE_MODEL)}`;
      const modelBoard = session.provider === "codex"
        ? codexModelKeyboard(config.modelCatalog)
        : session.provider === "agy"
        ? agyModelKeyboard(config.modelCatalog)
        : modelKeyboard(config.modelCatalog);
      await ctx.reply(
        `${current}\n제공자를 바꾸려면 아래에서 선택하세요(직전 대화 요약이 새 제공자로 인계됩니다).`,
        { reply_markup: providerKeyboard(session.provider) }
      );
      await ctx.reply(
        `현재 제공자(${providerDisplayLabel(session.provider)})의 모델을 바꾸려면 선택하세요.`,
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
        await ctx.reply("지원하지 않는 agy 모델입니다. /model 버튼의 모델을 사용하세요.");
        return;
      }
      store.updateSession(session.id, { agyModel });
      // agy는 런타임 setModel API가 없으므로, 다음 턴에 같은 conversation_id로
      // 브리지를 재구성하여 새 ModelTarget을 적용한다. 대화 문맥은 유지된다.
      const hasConv = !!session.agyConversationId;
      await ctx.reply(
        `agy 모델을 ${agyModelLabel(config.modelCatalog, agyModel)}(으)로 변경했습니다.\n`
        + `다음 메시지부터 같은 대화${hasConv ? `(${session.agyConversationId!.slice(0, 8)}…)` : ""}를 `
        + `유지한 채 새 모델로 재구성됩니다.`
      );
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
      await ctx.reply("/thinking은 Claude 전용입니다. Codex·agy는 /power를 사용하세요.");
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
        options?: { reply_markup?: InlineKeyboard }
      ) => Promise<unknown>;
      message?: { message_thread_id?: number } | undefined;
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
          : `현재 agy 추론 강도: ${agyThinkingLabel(session.agyThinkingLevel ?? DEFAULT_AGY_THINKING_LEVEL)}`;
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

    if (input === "reset" || input === "default") {
      if (sessions.isActive(session.id)) {
        await ctx.reply("실행 중에는 바꿀 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요.");
        return;
      }
      store.updateSession(session.id, { agyThinkingLevel: null });
      await ctx.reply(`agy 추론 강도를 API 기본(레벨 미지정)으로 초기화했습니다. 다음 실행부터 적용됩니다.${aliasSuffix}`);
      return;
    }
    const resolved = resolveAgyThinkingLevel(input);
    if (!resolved) {
      await ctx.reply(`지원하지 않는 추론 강도입니다.\n사용 가능: minimal, low, medium, high (또는 reset)${aliasSuffix}`);
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.reply("실행 중에는 바꿀 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요.");
      return;
    }
    store.updateSession(session.id, { agyThinkingLevel: resolved });
    await ctx.reply(`다음 실행부터 agy 추론 강도를 ${agyThinkingLabel(resolved)}(으)로 사용합니다.${aliasSuffix}`);
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

  bot.command("goal", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const arg = ctx.match.trim();
    if (!arg) {
      await ctx.reply(
        session.goalCondition
          ? `현재 목표: ${session.goalCondition}\n해제하려면 /goal clear`
          : "설정된 목표가 없습니다.\n예: /goal 모든 테스트가 통과하고 lint가 깨끗하다\n"
            + "코딩뿐 아니라 요약·조사·문서 작성 같은 일반 작업에도 쓸 수 있습니다.\n"
            + "결정론적 검증을 넣으려면 줄마다 `check: <명령>`을 추가하세요(예: check: npm test).\n"
            + "그 명령들을 먼저 실행해 객관적으로 판정하고, 나머지는 판관 모델이 확인합니다.\n"
            + "조건이 충족될 때까지 자동으로 턴을 이어 갑니다.\n"
            + "자동 진행은 매 턴 모델을 호출하므로, Sonnet 4.6·gpt-5.4-mini 같은 가벼운 모델은 "
            + "작업량 '보통(중간)'·thinking off로 두고 쓰길 권합니다(/power, /thinking)."
      );
      return;
    }
    if (arg.toLowerCase() === "clear") {
      const had = sessions.clearGoal(session.id);
      await ctx.reply(had ? "목표를 해제했습니다. 자동 진행을 멈춥니다." : "해제할 목표가 없습니다.");
      return;
    }
    const result = sessions.setGoal(session.id, arg);
    if (result === "queued") {
      await ctx.reply(
        `목표를 설정하고 작업을 시작합니다.\n조건: ${arg}\n`
        + `충족될 때까지 자동으로 턴을 이어 가며 최대 ${MAX_GOAL_ROUNDS}턴까지 진행합니다. `
        + "매 턴 종료 후 `check:` 명령(있으면)을 먼저 실행해 객관 판정하고, 나머지는 판관 모델이 평가합니다. /goal clear 또는 /stop 으로 중단."
      );
    } else if (result === "active") {
      await ctx.reply(
        `목표를 설정했습니다. 현재 실행 중인 작업이 끝나면 달성 여부를 평가하고 미달성이면 자동으로 이어 갑니다.\n조건: ${arg}`
      );
    } else {
      await ctx.reply(
        `목표를 저장했습니다. 이 토픽에서 작업을 한 번 실행(메시지 전송)하면 그 이후부터 목표를 향해 자동 진행합니다.\n조건: ${arg}`
      );
    }
  });

  // /route <작업 설명>: 강점 사전(매일 03:00 갱신)과 작업유형 규칙으로 적합한 제공자를
  // 추천한다. 1단계 라우터 — 추천만 하고 자동 배정은 하지 않는다(어르신이 보고 판단).
  bot.command("route", async (ctx) => {
    const arg = ctx.match.trim();
    if (!arg) {
      await ctx.reply(
        "작업 설명과 함께 사용하세요.\n예: /route 이 PDF를 요약해줘\n"
        + "작업유형과 이력 기반 강점 사전을 보고 Claude·Codex·agy 중 적합한 제공자를 추천합니다."
      );
      return;
    }
    const hints = loadStrengthHints(agentStrengthsPath());
    const decision = routeProvider(arg, hints);
    const hintNote = Object.keys(hints).length === 0
      ? "\n(강점 사전이 아직 비어 있어 기본 규칙으로만 판단했습니다.)"
      : decision.usedHint
        ? "\n(이력 기반 강점 사전이 기본 규칙을 보정했습니다.)"
        : "";
    await ctx.reply(
      `추천 제공자: ${providerDisplayLabel(decision.provider)}\n`
      + `작업유형: ${decision.taskType}\n`
      + `근거: ${decision.reason}${hintNote}`
    );
  });

  // /synth <작업>: 병렬 종합. Claude·Codex·agy를 읽기 전용으로 동시에 시키고, Claude
  // Opus 4.8 high 심사자(실패 시 첫 후보 채택)가 최우수 답을 고른 뒤 승자가
  // 통합해 최종답을 낸다.
  // 읽기·조언 작업 전용(파일 수정 안 함). 토큰·시간이 N배인 비싼 경로.
  bot.command("synth", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const arg = ctx.match.trim();
    if (!arg) {
      await ctx.reply(
        "작업 설명과 함께 사용하세요.\n예: /synth 이 설계의 위험 요소를 분석해줘\n"
        + "Claude·Codex·agy를 읽기 전용으로 동시에 실행하고 Opus 4.8 high 심사자가 최우수 답을 골라 통합합니다. "
        + "읽기·조언 작업 전용이며 토큰·시간이 더 듭니다."
      );
      return;
    }
    await ctx.reply(
      "병렬 종합을 시작합니다. Claude·Codex·agy를 읽기 전용으로 동시 실행 → 심사 → 통합. "
      + "잠시 걸립니다."
    );
    try {
      const result = await sessions.runSynthesis(session, arg);
      if (!result.ok) {
        await ctx.reply(`병렬 종합을 완료하지 못했습니다: ${result.reason ?? "원인 불명"}`);
        return;
      }
      const judgeLabel = result.verdict
        ? result.verdict.judge === "claude"
          ? "Claude Opus 4.8 high"
          : "폴백(첫 후보)"
        : "단일 후보(심사 생략)";
      const candidateLabels = (result.candidates ?? [])
        .map((p) => providerDisplayLabel(p))
        .join("·");
      const tail =
        `\n\n———\n후보: ${candidateLabels} / 심사: ${judgeLabel}`
        + (result.synthesizedBy ? ` / 통합: ${providerDisplayLabel(result.synthesizedBy)}` : "")
        + (result.verdict ? `\n근거: ${result.verdict.reason}` : "");
      await ctx.reply(`${result.answer ?? ""}${tail}`);
    } catch (error) {
      await ctx.reply(`병렬 종합 중 오류가 발생했습니다: ${safeErrorMessage(error)}`);
    }
  });

  // /query <질문>: LLM-Wiki에 질문한다. 현재 세션 에이전트(Claude/Codex/agy)에게 위키
  // 규약(.claude/commands/query.md)을 먼저 읽고 그대로 수행하라고 주입한다. 봇은 규약
  // 본문을 복제하지 않으므로 위키 규약이 바뀌어도 자동으로 따라간다. 검색 대상은 항상
  // LLM-Wiki(절대경로)이며 현재 세션 프로젝트 cwd와 무관하다.
  bot.command("query", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const arg = ctx.match.trim();
    if (!arg) {
      await ctx.reply(
        "질문과 함께 사용하세요.\n예: /query 멀티모델 오케스트레이션이 뭐야?\n"
        + "현재 세션 에이전트가 LLM-Wiki를 query.md 규약대로 검색해 인용과 함께 답합니다."
      );
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.reply("현재 세션이 작업 중입니다. 끝난 뒤 다시 시도하거나 /steer로 지시하세요.");
      return;
    }
    const vault = wikiVaultPath();
    const prompt =
      `다음 질문에 LLM-Wiki로 답하라.\n\n`
      + `질문: ${arg}\n\n`
      + `절차: 먼저 \`${vault}/.claude/commands/query.md\`를 읽고, 그 규약(2단 라우팅 `
      + `Route→Search, 근거 인용, 지어내기 금지)을 그대로 따른다. 검색 대상 저장소 루트는 `
      + `\`${vault}\` 이며, 현재 작업 디렉터리가 아니라 이 절대경로 안의 파일만 읽는다. `
      + `규약대로 회수한 페이지 내용으로만, 각 주장에 \`[[페이지]]\` 인용을 붙여 답하라. `
      + `근거가 없으면 "위키에 없음 — /ingest 필요"라고 답하고 지어내지 마라. 위키 파일을 `
      + `수정하지 말고(읽기 전용) 답변만 작성하라.`;
    if (!sessions.resume(session, prompt)) {
      await ctx.reply("질의를 시작하지 못했습니다. 세션 상태를 확인하세요.");
      return;
    }
    await ctx.reply(`LLM-Wiki에 질의합니다: ${arg}`);
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

  // 프로젝트를 고르면 현재 기본값(제공자·모델·thinking)을 그대로 적용하고 바로 작업 입력을
  // 기다린다. 매번 모델/thinking을 누를 필요 없이 기본값 패널로 미리 정해 둔 값을 쓴다.
  bot.callbackQuery(/^newp:/, async (ctx) => {
    const projectIndex = Number.parseInt(ctx.callbackQuery.data.slice("newp:".length), 10);
    const project = Number.isInteger(projectIndex)
      ? config.projects[projectIndex]
      : undefined;
    if (!project) {
      await ctx.answerCallbackQuery({ text: "프로젝트를 찾을 수 없습니다." });
      return;
    }
    const defaults = store.getSessionDefaults();
    pendingStarts.set(
      pendingStartKey(config.allowedUserId, ctx.callbackQuery.message?.message_thread_id),
      { project, ...pendingFieldsForDefaults(defaults) }
    );
    await ctx.answerCallbackQuery({ text: `${project.name} 선택` });
    await ctx.reply(
      `${project.name} 프로젝트 · ${defaultsSummary(defaults, config.modelCatalog)}\n실행할 작업을 입력하세요. (기본값은 아래 패널에서 변경)`,
      { reply_markup: defaultPanelKeyboard(defaults) }
    );
  });

  bot.callbackQuery(/^stop:/, async (ctx) => {
    const sessionId = ctx.callbackQuery.data.slice("stop:".length);
    const stopped = sessions.stop(sessionId);
    await ctx.answerCallbackQuery({ text: stopped ? "중단 요청을 보냈습니다." : "실행 중이 아닙니다." });
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
      answerCallbackQuery: (args?: { text?: string; show_alert?: boolean }) => Promise<unknown>;
      reply: (text: string) => Promise<unknown>;
      callbackQuery: { data: string; message?: { message_thread_id?: number } };
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

    const resolved = optionId === "reset" || optionId === "default"
      ? null
      : resolveAgyThinkingLevel(optionId);
    if (resolved === undefined) {
      await ctx.answerCallbackQuery({ text: "지원하지 않는 추론 강도입니다.", show_alert: true });
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.answerCallbackQuery({ text: "실행 중에는 바꿀 수 없습니다.", show_alert: true });
      return;
    }
    store.updateSession(session.id, { agyThinkingLevel: resolved });
    await ctx.answerCallbackQuery({
      text: resolved ? `${agyThinkingLabel(resolved)} 선택` : "API 기본 선택"
    });
    await ctx.reply(
      resolved
        ? `다음 실행부터 agy 추론 강도를 ${agyThinkingLabel(resolved)}(으)로 사용합니다.`
        : "agy 추론 강도를 API 기본(레벨 미지정)으로 초기화했습니다. 다음 실행부터 적용됩니다."
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
    if ((first === "claude" || first === "codex" || first === "agy") && second && rest.length === 0) {
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

  // /model 제공자 전환. 직전 provider의 요약을 새 provider로 인계한다(요약 생성에 시간이
  // 걸릴 수 있어 먼저 안내한다).
  bot.callbackQuery(/^mprov:/, async (ctx) => {
    const target = ctx.callbackQuery.data.slice("mprov:".length) as ProviderKind;
    if (target !== "claude" && target !== "codex" && target !== "agy") {
      await ctx.answerCallbackQuery({ text: "알 수 없는 제공자입니다.", show_alert: true });
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
      ? `agy · ${agyModelLabel(config.modelCatalog, updated?.agyModel ?? DEFAULT_AGY_MODEL)}`
      : `Claude · ${modelLabel(config.modelCatalog, updated?.model ?? DEFAULT_CLAUDE_MODEL)}`;
    await ctx.reply(
      `제공자를 ${label}로 전환했습니다. 다음 메시지부터 새 제공자가 직전 작업 요약을 이어받아 진행합니다.`
    );
  });

  // 기본값 패널 제공자 선택. mprov:(세션 전환·요약 인계)와 달리 새 세션 기본값만 바꾼다.
  bot.callbackQuery(/^dprov:/, async (ctx) => {
    const target = ctx.callbackQuery.data.slice("dprov:".length) as ProviderKind;
    if (target !== "claude" && target !== "codex" && target !== "agy") {
      await ctx.answerCallbackQuery();
      return;
    }
    const defaults = store.updateSessionDefaults({ provider: target });
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
      await ctx.answerCallbackQuery({ text: "지원하지 않는 agy 모델입니다.", show_alert: true });
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
    store.updateSession(session.id, { agyModel: option.id });
    await ctx.answerCallbackQuery({ text: `${option.label} 선택` });
    // agy는 런타임 setModel API가 없으므로, 다음 턴에 같은 conversation_id로
    // 브리지를 재구성하여 새 ModelTarget을 적용한다. 대화 문맥은 유지된다.
    const hasConv = !!session.agyConversationId;
    await ctx.reply(
      `agy 모델을 ${option.label}(으)로 변경했습니다.\n`
      + `다음 메시지부터 같은 대화${hasConv ? `(${session.agyConversationId!.slice(0, 8)}…)` : ""}를 `
      + `유지한 채 새 모델로 재구성됩니다.`
    );
  });

  bot.callbackQuery(/^agygo:/, async (ctx) => {
    const sessionId = ctx.callbackQuery.data.slice("agygo:".length);
    const session = store.getSession(sessionId);
    if (!session || session.provider !== "agy") {
      await ctx.answerCallbackQuery({ text: "agy 세션을 찾을 수 없습니다.", show_alert: true });
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

  // 새 세션 기본값 패널: 모델 선택. setm:<provider>:<id>
  bot.callbackQuery(/^setm:/, async (ctx) => {
    const rest = ctx.callbackQuery.data.slice("setm:".length);
    const sep = rest.indexOf(":");
    const provider = rest.slice(0, sep) as ProviderKind;
    const modelId = rest.slice(sep + 1);
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
      const defaults = store.updateSessionDefaults({ agyModel: option.id });
      await ctx.answerCallbackQuery({ text: `${option.label} 기본값` });
      await ctx.reply(`새 세션 기본 agy 모델: ${option.label}`, {
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
      const option = agyThinkingOptions().find((item) => item.id === valueId);
      if (!option) {
        await ctx.answerCallbackQuery({ text: "지원하지 않는 추론 강도입니다.", show_alert: true });
        return;
      }
      const defaults = store.updateSessionDefaults({ agyThinkingLevel: option.id });
      await ctx.answerCallbackQuery({ text: `${option.label} 기본값` });
      await ctx.reply(`새 세션 기본 agy 추론 강도: ${option.label}`, {
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

  bot.callbackQuery(/^delp:/, async (ctx) => {
    const index = Number.parseInt(ctx.callbackQuery.data.slice("delp:".length), 10);
    const project = Number.isInteger(index) ? config.projects[index] : undefined;
    if (!project) {
      await ctx.answerCallbackQuery({ text: "프로젝트를 찾을 수 없습니다.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: `${project.name} 선택` });
    await ctx.reply(deleteProjectConfirmText(project), {
      reply_markup: confirmDeleteProjectKeyboard(index)
    });
  });

  bot.callbackQuery(/^delprojcancel$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "삭제를 취소했습니다." });
    await ctx.editMessageText("프로젝트 삭제를 취소했습니다.");
  });

  bot.callbackQuery(/^delproj:/, async (ctx) => {
    const index = Number.parseInt(ctx.callbackQuery.data.slice("delproj:".length), 10);
    const project = Number.isInteger(index) ? config.projects[index] : undefined;
    if (!project) {
      await ctx.answerCallbackQuery({ text: "프로젝트를 찾을 수 없습니다.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "삭제 중입니다." });
    try {
      const removed = await unregisterProject(project.name);
      const linked = store.countSessionsByProject(removed.name);
      const note = linked > 0
        ? `\n이 프로젝트의 기존 세션 ${linked}개는 그대로 유지됩니다.`
        : "";
      await ctx.editMessageText(`프로젝트를 삭제했습니다.\n${removed.name}\n${removed.cwd}${note}`);
    } catch (error) {
      await ctx.editMessageText(`프로젝트를 삭제하지 못했습니다.\n${safeErrorMessage(error)}`);
    }
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
        safeErrorMessage(error, [config.telegramBotToken, ...config.claudeCodeOauthTokens])
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
    const filePath = isAbsolute(inputPath) ? inputPath : join(session.cwd, inputPath);
    try {
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
      { reply_markup: defaultsProviderKeyboard(current.provider) }
    );
  });

  bot.hears(/^🧠 모델/, async (ctx) => {
    const defaults = store.getSessionDefaults();
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
      ? "새 세션 기본 agy 추론 강도를 선택하세요."
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
        "작업량(effort)은 Claude 기본값 전용입니다. Codex·agy는 추론 강도(💭)가 작업량을 겸합니다.",
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
      const nextIndex = (Math.max(0, currentIndex) + 1) % config.claudeCodeOauthTokens.length;
      const updated = store.updateSessionDefaults({ claudeTokenIndex: nextIndex });
      const pendingKey = pendingStartKey(config.allowedUserId, ctx.message?.message_thread_id);
      const pending = pendingStarts.get(pendingKey);
      if (pending && (pending.provider ?? "claude") === "claude") {
        pendingStarts.set(pendingKey, { ...pending, claudeTokenIndex: nextIndex });
      }
      await ctx.reply(`새 Claude 세션 기본 토큰: #${nextIndex + 1}`, {
        reply_markup: defaultPanelKeyboard(updated)
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
    const nextIndex = (Math.max(0, currentIndex) + 1) % config.codexAccountHomes.length;
    const nextHome = config.codexAccountHomes[nextIndex] ?? null;
    const updated = store.updateSessionDefaults({ codexHome: nextHome });
    const pendingKey = pendingStartKey(config.allowedUserId, ctx.message?.message_thread_id);
    const pending = pendingStarts.get(pendingKey);
    if (pending && (pending.provider ?? "claude") === "codex") {
      pendingStarts.set(pendingKey, { ...pending, codexHome: nextHome });
    }
    await ctx.reply(`새 Codex 세션 기본 토큰: #${nextIndex + 1}`, {
      reply_markup: defaultPanelKeyboard(updated)
    });
  });

  bot.hears(/^➖/, async (ctx) => {
    // 예약 슬롯: 아직 배선되지 않았다. 추후 제공자별 추가 선택 항목을 여기에 연결한다.
    await ctx.reply("아직 배선되지 않은 예약 슬롯입니다(추후 추가 예정).");
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
        pending.forkSession ?? false,
        pending.model ?? null,
        pending.thinking ?? null,
        pending.claudeEffort ?? null,
        pending.leanMode ?? true,
        pending.provider ?? "claude",
        pending.codexModel ?? null,
        pending.codexReasoning ?? null,
        pending.agyThinkingLevel ?? null,
        pending.agyModel ?? null,
        pending.handoffSummary ?? null,
        pending.codexHome ?? null,
        pending.claudeTokenIndex ?? null
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
      );
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
      await ctx.reply("이 세션은 이미 실행 중이거나 아직 이어 갈 대화 문맥이 없습니다.");
      return;
    }
    await ctx.reply("후속 작업을 시작했습니다.");
  });

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1)!;
    await handleFile(ctx, photo.file_id, `photo_${photo.file_unique_id}.jpg`, "사진", ctx.message.caption);
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    await handleFile(ctx, doc.file_id, doc.file_name ?? `document_${doc.file_unique_id}`, "문서", ctx.message.caption);
  });

  bot.on("message:audio", async (ctx) => {
    const audio = ctx.message.audio;
    await handleFile(ctx, audio.file_id, audio.file_name ?? `audio_${audio.file_unique_id}.mp3`, "오디오", ctx.message.caption);
  });

  bot.on("message:voice", async (ctx) => {
    const voice = ctx.message.voice;
    await handleFile(ctx, voice.file_id, `voice_${voice.file_unique_id}.ogg`, "음성 메시지", ctx.message.caption);
  });

  bot.on("message:video", async (ctx) => {
    const video = ctx.message.video;
    await handleFile(ctx, video.file_id, video.file_name ?? `video_${video.file_unique_id}.mp4`, "동영상", ctx.message.caption);
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

  bot.catch((error) => {
    console.error(
      "Telegram update failed:",
      safeErrorMessage(error.error, [config.telegramBotToken, ...config.claudeCodeOauthTokens])
    );
  });

  return { bot, sessions, permissions };
}
