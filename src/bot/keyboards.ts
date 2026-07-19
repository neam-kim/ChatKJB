import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { InlineKeyboard, Keyboard } from "grammy";
import { isAbsolute, relative } from "node:path";
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
import type { DriveEntry, FolderBrowserState } from "./drive-browser.js";
import { providerDisplayLabel } from "./formatting.js";
import { selectedClaudeTokenIndex, selectedCodexAccountIndex } from "./pending-keys.js";

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
        : modelLabel(catalog, defaults.claudeModel);
  const fourth = defaults.provider === "codex"
    ? `💭 추론: ${codexReasoningLabel(defaults.codexReasoning)}`
    : defaults.provider === "agy"
      ? `💭 추론: ${agyThinkingLabel(defaults.agyThinkingLevel)}`
      : defaults.provider === "grok"
        ? `💭 추론: ${grokReasoningLabel(defaults.grokReasoning)}`
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
      : defaults.provider === "grok"
        ? catalog.grokModels.map((option) => ({ id: option.id, label: option.label }))
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
      ? agyThinkingOptionsForModel(catalog, defaults.agyModel)
        .map((option) => ({ id: option.id, label: option.label, current: option.id === defaults.agyThinkingLevel }))
      : defaults.provider === "grok"
        ? grokReasoningOptions(catalog)
          .map((option) => ({ id: option.id, label: option.label, current: option.id === defaults.grokReasoning }))
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

// /provider에서 제공자를 고르는 인라인 키보드. mprov:claude|codex|agy|grok
function providerKeyboard(
  current: ProviderKind,
  available: readonly ProviderKind[] = ["claude", "codex", "agy", "grok"]
): InlineKeyboard {
  return providerSelectionKeyboard(current, available, "mprov");
}

// 기본값 패널: 새 세션 기본 제공자 선택. 콜백 dprov:<provider> (mprov:과 의미 다름 — 요약 인계 없음)
function defaultsProviderKeyboard(
  current: ProviderKind,
  available: readonly ProviderKind[] = ["claude", "codex", "agy", "grok"]
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
    ["grok", "Grok"]
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
  codexModelKeyboard,
  defaultsEffortKeyboard,
  defaultsKeyboard,
  defaultsModelKeyboard,
  defaultsProviderKeyboard,
  defaultsReasoningKeyboard,
  defaultsSummary,
  defaultsTokenKeyboard,
  grokModelKeyboard,
  modelKeyboard,
  parseMode,
  powerKeyboardForSession,
  providerKeyboard,
  thinkingKeyboard,
  usageRateLimitWarning
};
