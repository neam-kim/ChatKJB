import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { InlineKeyboard, Keyboard } from "grammy";
import { isAbsolute, relative } from "node:path";
import {
  clineModelsForProvider,
  clineReasoningOptionsForModel,
  normalizeClineReasoning
} from "../cline-sdk.js";
import {
  agyModelLabel,
  agyThinkingLabel,
  agyThinkingOptionsForModel,
  claudeEffortLabel,
  claudeEffortOptionsForModel,
  codexModelLabel,
  codexReasoningLabel,
  codexReasoningOptionsForModel,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  FALLBACK_MODEL_CATALOG,
  grokModelLabel,
  grokReasoningLabel,
  grokReasoningOptions,
  type ModelCatalog,
  modelLabel,
  thinkingToggleOptionsForModel
} from "../model-catalog.js";
import type { ProviderKind, SessionDefaults, SessionRecord } from "../types.js";
import { qwenModelLabel } from "../model-catalog.js";
import type { DriveEntry, FolderBrowserState } from "./drive-browser.js";
import {
  CLINE_MODEL_PAGE_SIZE,
  CLINE_PROVIDER_PAGE_SIZE,
  type ClineSnapshot
} from "./cline-snapshots.js";
import { providerDisplayLabel } from "./formatting.js";
import { selectedClaudeTokenIndex, selectedCodexAccountIndex } from "./pending-keys.js";
import {
  claudeSubagentModelOptions,
  codexSubagentModelOptions,
  grokSubagentModelOptions,
  isQwenSubagentModel
} from "../qwen-subagent.js";

export function driveListText(): string {
  return "드라이브를 선택하세요.";
}

export function driveListKeyboard(drives: DriveEntry[], callbackPrefix: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index] of drives.entries()) {
    keyboard.text(drives[index]!.label, `${callbackPrefix}:d:${index}`).row();
  }
  return keyboard;
}

export function folderBrowserText(state: FolderBrowserState): string {
  const relativePath = relative(state.rootPath, state.currentPath);
  const location = relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)
    ? `${state.driveLabel}/${relativePath}`
    : state.driveLabel;
  return `폴더를 선택하세요.\n${location}`;
}

export function folderBrowserKeyboard(
  state: FolderBrowserState,
  callbackPrefix: string
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, name] of state.directories.entries()) {
    keyboard.text(name, `${callbackPrefix}:o:${index}`).row();
  }
  keyboard.text("이 폴더 선택", `${callbackPrefix}:s`).row();
  const showBack = state.currentPath !== state.rootPath || state.drives !== null;
  if (showBack) keyboard.text("뒤로", `${callbackPrefix}:b`).row();
  return keyboard;
}

// 아직 배선되지 않은 빈 패널 슬롯 라벨. 추후 제공자별 추가 선택 항목을 여기에 연결한다.
// (user 요청: 빈 패널은 '-' 표기, 추후 배선 가능성만 열어둔다.)
const RESERVED_SLOT_LABEL = "➖";

// Cline 새 세션 기본값 패널의 6번째 슬롯 라벨. 미설정도 전역 Auto 기본값을 따른다.
// auto는 승인 요청을 생략하는 모드임을 분명히 표시한다.
function clineDefaultModeLabel(mode: PermissionMode | undefined): string {
  return mode === "plan" ? "🧭 Plan" : "⚠️ Auto";
}

// Cline 기본 모드 토글의 다음 값. plan↔auto 두 값만 순환한다.
function clineToggledDefaultMode(mode: PermissionMode | undefined): PermissionMode {
  return mode === "auto" ? "plan" : "auto";
}

function autoModeConfirmationPrompt(subject: string): string {
  return `⚠️ ${subject} Auto로 변경하면 다음 실행부터 권한 승인 요청을 생략합니다.\n계속하시겠습니까?`;
}

function autoModeConfirmationKeyboard(callbackPrefix: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("⚠️ Auto로 변경", `${callbackPrefix}:y`)
    .text("취소", `${callbackPrefix}:n`);
}

function clineProviderOption(catalog: ModelCatalog, providerId: string | null | undefined) {
  return catalog.clineProviders.find((option) => option.id === providerId)
    ?? catalog.clineProviders[0];
}

function clineModelOption(
  catalog: ModelCatalog,
  providerId: string | null | undefined,
  modelId: string | null | undefined
) {
  const provider = clineProviderOption(catalog, providerId);
  const models = clineModelsForProvider(catalog, provider?.id);
  return models.find((option) => option.id === modelId)
    ?? models.find((option) => option.id === provider?.defaultModelId)
    ?? models[0];
}

function clineReasoningLabel(value: string | null | undefined): string {
  return value || "off";
}

function clineButtonLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 48 ? `${normalized.slice(0, 47)}…` : normalized;
}

function clineSnapshotKeyboard(
  snapshot: ClineSnapshot,
  page: number,
  pageSize: number,
  prefix: "clp" | "clm"
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const pageCount = Math.max(1, Math.ceil(snapshot.items.length / pageSize));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const start = currentPage * pageSize;
  const items = snapshot.items.slice(start, start + pageSize);
  for (const [offset, option] of items.entries()) {
    keyboard.text(clineButtonLabel(option.label), `${prefix}:${snapshot.nonce}:i${start + offset}`).row();
  }
  if (pageCount > 1) {
    if (currentPage > 0) keyboard.text("◀️ 이전", `${prefix}:${snapshot.nonce}:p${currentPage - 1}`);
    keyboard.text(`${currentPage + 1}/${pageCount}`, `noop:cline-page`);
    if (currentPage + 1 < pageCount) keyboard.text("다음 ▶️", `${prefix}:${snapshot.nonce}:p${currentPage + 1}`);
  }
  return keyboard;
}

function clineProviderSnapshotKeyboard(snapshot: ClineSnapshot, page = 0): InlineKeyboard {
  return clineSnapshotKeyboard(snapshot, page, CLINE_PROVIDER_PAGE_SIZE, "clp");
}

function clineModelSnapshotKeyboard(snapshot: ClineSnapshot, page = 0): InlineKeyboard {
  return clineSnapshotKeyboard(snapshot, page, CLINE_MODEL_PAGE_SIZE, "clm");
}

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
      : defaults.provider === "grok"
        ? grokModelLabel(catalog, defaults.grokModel)
        : defaults.provider === "cline"
          ? clineModelOption(catalog, defaults.clineProviderId, defaults.clineModel)?.label ?? "감지된 모델 없음"
        : defaults.provider === "qwen"
          ? qwenModelLabel(catalog, defaults.qwenModel)
        : modelLabel(catalog, defaults.claudeModel);
  const fourth = defaults.provider === "codex"
    ? `💭 추론: ${codexReasoningLabel(defaults.codexReasoning)}`
    : defaults.provider === "agy"
      ? `💭 추론: ${agyThinkingLabel(defaults.agyThinkingLevel)}`
      : defaults.provider === "grok"
        ? `💭 추론: ${grokReasoningLabel(defaults.grokReasoning)}`
        : defaults.provider === "cline"
          ? `💭 추론: ${clineReasoningLabel(defaults.clineReasoning)}`
        : defaults.provider === "qwen"
          ? "💭 추론: 끄기 (Off)"
        : `💭 thinking: ${defaults.thinking === "off" ? "off" : "on"}`;
  const subagentLabel = defaults.subagentModel
    ? (defaults.provider === "codex"
      ? codexSubagentModelOptions(catalog).find((option) => option.id === defaults.subagentModel)?.label
        ?? codexModelLabel(catalog, defaults.subagentModel)
      : defaults.provider === "grok"
        ? grokSubagentModelOptions(catalog).find((option) => option.id === defaults.subagentModel)?.label
          ?? grokModelLabel(catalog, defaults.subagentModel)
      : claudeSubagentModelOptions(catalog).find((option) => option.id === defaults.subagentModel)?.label
        ?? modelLabel(catalog, defaults.subagentModel))
    : "기본 상속";
  // 5번째 슬롯: Codex/Grok의 예약 칸은 하위 에이전트 모델 선택에 사용한다.
  // Claude는 기존 작업량(effort) 버튼을 유지한다.
  const fifth = defaults.provider === "claude"
    ? `🛠️ 작업량: ${claudeEffortLabel(defaults.claudeEffort)}`
    : defaults.provider === "codex"
      ? `🧑‍💻 서브에이전트: ${subagentLabel}`
      : defaults.provider === "grok"
        ? `🧑‍💻 서브에이전트: ${subagentLabel}`
    : defaults.provider === "cline"
      ? `🔌 Cline 제공자: ${clineProviderOption(catalog, defaults.clineProviderId)?.label ?? "감지 없음"}`
      : RESERVED_SLOT_LABEL;
  const codexAccountIndex = selectedCodexAccountIndex(defaults.codexHome, codexAccountHomes);
  const claudeTokenIndex = selectedClaudeTokenIndex(defaults.claudeTokenIndex, claudeTokenCount);
  // 6번째 슬롯: Claude/Codex는 토큰이 여러 개라 토큰 선택 버튼을 둔다.
  // Cline은 토큰이 단수라 이 자리가 남으므로 Plan↔Auto 토글 버튼을 배치한다(user 지시).
  // Claude는 토큰이 하나일 때 남는 칸에 하위 에이전트 모델 선택을 둔다.
  // agy는 예약 슬롯을 유지한다.
  const sixth = defaults.provider === "cline"
    ? clineDefaultModeLabel(defaults.defaultPermissionMode)
    : defaults.provider === "codex" && codexAccountHomes.length > 1 && codexAccountIndex >= 0
      ? `🔑 토큰: #${codexAccountIndex + 1}`
      : defaults.provider === "claude" && claudeTokenCount > 1 && claudeTokenIndex >= 0
        ? `🔑 토큰: #${claudeTokenIndex + 1}`
        : defaults.provider === "claude"
          ? `🧑‍💻 서브에이전트: ${subagentLabel}`
          : defaults.provider === "grok"
            ? RESERVED_SLOT_LABEL
        : RESERVED_SLOT_LABEL;
  const keyboard = new Keyboard()
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
  // Claude 계정이 여러 개이면 여섯 번째 슬롯은 토큰 선택에 쓰인다. 이때도 Qwen MCP
  // 서브에이전트 선택이 숨지 않도록 별도 행을 추가한다.
  if (defaults.provider === "claude" && claudeTokenCount > 1) {
    keyboard.row().text(`🧑‍💻 서브에이전트: ${subagentLabel}`);
  }
  return keyboard;
}

// 기본값 패널의 모델 선택용 인라인 키보드(제공자별). setm:<provider>:<id>
function defaultsModelKeyboard(defaults: SessionDefaults, catalog: ModelCatalog): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const options = defaults.provider === "codex"
    ? catalog.codexModels.map((option) => ({ id: option.id, label: option.label }))
    : defaults.provider === "agy"
      ? catalog.agyModels.map((option) => ({ id: option.id, label: option.label }))
      : defaults.provider === "grok"
        ? catalog.grokModels.map((option) => ({ id: option.id, label: option.label }))
        : defaults.provider === "cline"
          ? []
        : defaults.provider === "qwen"
          ? (catalog.qwenModels ?? []).map((option) => ({ id: option.id, label: option.label }))
        : catalog.claudeModels.map((option) => ({ id: option.id, label: option.label }));
  for (const [index, option] of options.entries()) {
    keyboard.text(option.label, `setm:${defaults.provider}:${option.id}`);
    if (index < options.length - 1) keyboard.row();
  }
  return keyboard;
}

// 새 세션 기본값 패널: Claude/Codex/Grok 하위 에이전트 모델. setsa:<provider>:<id|inherit>
function defaultsSubagentModelKeyboard(defaults: SessionDefaults, catalog: ModelCatalog): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const options = defaults.provider === "codex"
    ? codexSubagentModelOptions(catalog)
    : defaults.provider === "grok"
      ? grokSubagentModelOptions(catalog)
    : claudeSubagentModelOptions(catalog);
  keyboard.text(`${defaults.subagentModel ? "모델 기본값 상속" : "✅ 모델 기본값 상속"}`, `setsa:${defaults.provider}:inherit`).row();
  for (const [index, option] of options.entries()) {
    keyboard.text(`${option.id === defaults.subagentModel ? "✅ " : ""}${option.label}`, `setsa:${defaults.provider}:${option.id}`);
    if (index < options.length - 1) keyboard.row();
  }
  return keyboard;
}

/** 선택한 서브 모델이 실제로 지원하는 조절값만 후속 버튼으로 노출한다. */
function defaultsSubagentTuningKeyboard(
  defaults: SessionDefaults,
  catalog: ModelCatalog
): InlineKeyboard | null {
  const model = defaults.subagentModel;
  if (!model || isQwenSubagentModel(catalog, model)) return null;
  const keyboard = new InlineKeyboard();
  if (defaults.provider === "claude") {
    const options = claudeEffortOptionsForModel(catalog, model);
    keyboard.text(
      `${defaults.subagentEffort ? "작업량 기본값" : "✅ 작업량 기본값"}`,
      "setsae:claude:inherit"
    ).row();
    for (const [index, option] of options.entries()) {
      keyboard.text(
        `${option.id === defaults.subagentEffort ? "✅ " : ""}${option.label}`,
        `setsae:claude:${option.id}`
      );
      if (index < options.length - 1) keyboard.row();
    }
    return keyboard;
  }
  const options = defaults.provider === "codex"
    ? codexReasoningOptionsForModel(catalog, model)
    : defaults.provider === "grok"
      ? grokReasoningOptions(catalog)
      : [];
  if (options.length === 0) return null;
  keyboard.text(
    `${defaults.subagentReasoning ? "추론 기본값" : "✅ 추론 기본값"}`,
    `setsar:${defaults.provider}:inherit`
  ).row();
  for (const [index, option] of options.entries()) {
    keyboard.text(
      `${option.id === defaults.subagentReasoning ? "✅ " : ""}${option.label}`,
      `setsar:${defaults.provider}:${option.id}`
    );
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
      ? agyThinkingOptionsForModel(catalog, defaults.agyModel)
        .map((option) => ({ id: option.id, label: option.label, current: option.id === defaults.agyThinkingLevel }))
      : defaults.provider === "grok"
        ? grokReasoningOptions(catalog)
          .map((option) => ({ id: option.id, label: option.label, current: option.id === defaults.grokReasoning }))
        : defaults.provider === "cline"
          ? (() => {
            const model = clineModelOption(catalog, defaults.clineProviderId, defaults.clineModel);
            const current = normalizeClineReasoning(defaults.clineReasoning, model);
            return clineReasoningOptionsForModel(model)
              .map((id) => ({ id, label: clineReasoningLabel(id), current: id === current }));
          })()
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

function defaultsTokenKeyboard(provider: "claude" | "codex", currentIndex: number, count: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let index = 0; index < count; index += 1) {
    const mark = index === currentIndex ? "✅ " : "";
    keyboard.text(`${mark}#${index + 1}`, `sett:${provider}:${index}`);
    if (index < count - 1) keyboard.row();
  }
  return keyboard;
}

function defaultsSummary(defaults: SessionDefaults, catalog: ModelCatalog): string {
  if (defaults.provider === "codex") {
    return `Codex · ${codexModelLabel(catalog, defaults.codexModel)} · reasoning ${codexReasoningLabel(defaults.codexReasoning)}`;
  }
  if (defaults.provider === "agy") {
    return `Antigravity · ${agyModelLabel(catalog, defaults.agyModel)} · 추론 ${agyThinkingLabel(defaults.agyThinkingLevel)}`;
  }
  if (defaults.provider === "grok") {
    return `Grok · ${grokModelLabel(catalog, defaults.grokModel)} · reasoning ${grokReasoningLabel(defaults.grokReasoning)}`;
  }
  if (defaults.provider === "cline") {
    const provider = clineProviderOption(catalog, defaults.clineProviderId);
    const model = clineModelOption(catalog, provider?.id, defaults.clineModel);
    return `Cline · ${provider?.label ?? "감지 없음"} · ${model?.label ?? "감지된 모델 없음"} · reasoning ${clineReasoningLabel(normalizeClineReasoning(defaults.clineReasoning, model))}`;
  }
  if (defaults.provider === "qwen") {
    return `Qwen · ${qwenModelLabel(catalog, defaults.qwenModel)} · 추론 off`;
  }
  return `Claude · ${modelLabel(catalog, defaults.claudeModel)} · thinking ${defaults.thinking === "off" ? "off" : "on"} · 작업량 ${claudeEffortLabel(defaults.claudeEffort)}`;
}

function modelKeyboard(catalog: ModelCatalog = FALLBACK_MODEL_CATALOG): InlineKeyboard {
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
      ? agyThinkingOptionsForModel(catalog, session.agyModel)
        .map((option) => ({ callback: `power:agy:${option.id}`, label: option.label }))
      : session.provider === "grok"
        ? grokReasoningOptions(catalog)
          .map((option) => ({ callback: `power:grok:${option.id}`, label: option.label }))
        : session.provider === "cline"
          ? (() => {
            const model = clineModelOption(catalog, session.clineProviderId, session.clineModel);
            return clineReasoningOptionsForModel(model)
              .map((id) => ({ callback: `power:cline:${id}`, label: clineReasoningLabel(id) }));
          })()
        : claudeEffortOptionsForModel(catalog, session.model ?? DEFAULT_CLAUDE_MODEL)
          .map((option) => ({ callback: `power:claude:${option.id}`, label: option.label }));
  for (const [index, option] of options.entries()) {
    keyboard.text(option.label, option.callback);
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

// /model에서 세션의 Grok 모델을 고르는 인라인 키보드. gmodel:<id>
function grokModelKeyboard(catalog: ModelCatalog): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, option] of catalog.grokModels.entries()) {
    keyboard.text(option.label, `gmodel:${option.id}`);
    if (index < catalog.grokModels.length - 1) keyboard.row();
  }
  return keyboard;
}

function qwenModelKeyboard(catalog: ModelCatalog): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, option] of (catalog.qwenModels ?? []).entries()) {
    keyboard.text(option.label, `qmodel:${option.id}`);
    if (index < (catalog.qwenModels ?? []).length - 1) keyboard.row();
  }
  return keyboard;
}

// /provider에서 제공자를 고르는 인라인 키보드.
function providerKeyboard(
  current: ProviderKind,
  available: readonly ProviderKind[] = ["claude", "codex", "agy", "grok", "cline", "qwen"]
): InlineKeyboard {
  return providerSelectionKeyboard(current, available, "mprov");
}

// 기본값 패널: 새 세션 기본 제공자 선택. 콜백 dprov:<provider> (mprov:과 의미 다름 — 요약 인계 없음)
function defaultsProviderKeyboard(
  current: ProviderKind,
  available: readonly ProviderKind[] = ["claude", "codex", "agy", "grok", "cline", "qwen"]
): InlineKeyboard {
  return providerSelectionKeyboard(current, available, "dprov");
}

function providerSelectionKeyboard(
  current: ProviderKind,
  available: readonly ProviderKind[],
  callbackPrefix: "mprov" | "dprov"
): InlineKeyboard {
  const allOptions: Array<[ProviderKind, string]> = [
    ["claude", "Claude"],
    ["codex", "Codex"],
    ["agy", "Antigravity"],
    ["grok", "Grok"],
    ["cline", "Cline"],
    ["qwen", "Qwen"]
  ];
  const options = allOptions.filter(([kind]) => available.includes(kind));
  const keyboard = new InlineKeyboard();
  for (const [index, [kind, label]] of options.entries()) {
    const mark = kind === current ? "✅ " : "";
    keyboard.text(`${mark}${label}`, `${callbackPrefix}:${kind}`);
    if (index < options.length - 1) keyboard.row();
  }
  return keyboard;
}

function parseMode(text: string): PermissionMode | undefined {
  const value = text.trim() as PermissionMode;
  return ["default", "acceptEdits", "plan", "dontAsk", "auto"].includes(value)
    ? value
    : undefined;
}

function usageRateLimitWarning(): string {
  return "참고: Claude 서버가 현재 OAuth 토큰에 대해 한도 창(rate_limits)을 반환하지 않았습니다. "
    + "Claude Code의 구독 로그인 세션에서만 정확한 한도 수치가 표시될 수 있습니다. "
    + "`claude auth status`가 claude.ai 구독 로그인으로 표시되는지 확인하십시오.";
}

export {
  agyModelKeyboard,
  autoModeConfirmationKeyboard,
  autoModeConfirmationPrompt,
  clineDefaultModeLabel,
  clineModelOption,
  clineModelSnapshotKeyboard,
  clineProviderOption,
  clineProviderSnapshotKeyboard,
  clineReasoningLabel,
  clineToggledDefaultMode,
  codexModelKeyboard,
  defaultsEffortKeyboard,
  defaultsKeyboard,
  defaultsModelKeyboard,
  defaultsSubagentModelKeyboard,
  defaultsProviderKeyboard,
  defaultsReasoningKeyboard,
  defaultsSubagentTuningKeyboard,
  defaultsSummary,
  defaultsTokenKeyboard,
  grokModelKeyboard,
  qwenModelKeyboard,
  modelKeyboard,
  parseMode,
  powerKeyboardForSession,
  providerKeyboard,
  thinkingKeyboard,
  usageRateLimitWarning
};
