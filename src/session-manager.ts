import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  deleteSession as deleteClaudeSession,
  query,
  renameSession,
  type HookCallback,
  type EffortLevel,
  type Options,
  type Query,
  type ThinkingConfig,
  type SDKUserMessage,
  type SDKMessage
} from "@anthropic-ai/claude-agent-sdk";
import { Codex, type ThreadItem } from "@openai/codex-sdk";
import {
  isRetryableMcpError,
  mcpCallKey,
  mcpServerName
} from "./mcp-policy.js";
import { loadClaudeConnectors, loadMergedConnectors, syncAgyMcpConfig } from "./connectors.js";
import { PermissionBroker } from "./permission-broker.js";
import { StateStore } from "./store.js";
import { StreamRenderer } from "./stream-renderer.js";
import { safeErrorMessage } from "./telegram-transport.js";
import { TokenPool } from "./token-pool.js";
import {
  agyModelLabel,
  codexModelLabel,
  codexReasoningLabel,
  DEFAULT_AGY_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING,
  DEFAULT_THINKING_LEVEL,
  type CodexReasoningEffort,
  type ModelCatalog,
  modelLabel,
  normalizeThinkingForModel,
  thinkingLabel
} from "./model-catalog.js";
import type {
  MessageTransport,
  ProjectConfig,
  ProviderKind,
  SessionRecord,
  UsageSnapshot
} from "./types.js";
import {
  mergeUsageSnapshots,
  snapshotFromRateLimitInfo,
  snapshotFromUsageResponse
} from "./usage.js";

// 일시적 과부하(Overloaded/5xx) 자동 재시도 상한과 백오프(지수, 상한 60초).
const MAX_OVERLOAD_RETRIES = 5;
const OVERLOAD_RETRY_BASE_MS = 5_000;
const OVERLOAD_RETRY_CAP_MS = 60_000;
// 모든 토큰이 한도에 도달했을 때, 가장 먼저 회복되는 시각 이후로 자동 재개를 미루는 여유분.
// 한도 초기화 직후의 미세한 시계 오차로 또 거부당하는 것을 막는다.
const LIMIT_RESUME_BUFFER_MS = 10_000;
// /goal: 한 목표를 향해 자동으로 이어 도는 최대 턴 수(폭주·무한 반복 방지).
export const MAX_GOAL_ROUNDS = 25;
// 목표 충족 여부를 판정하는 빠르고 저렴한 모델. 매 턴 한 번만 읽기 전용으로 호출한다.
const GOAL_EVAL_MODEL = "claude-haiku-4-5";
export const CLAUDE_MODEL = DEFAULT_CLAUDE_MODEL;
export const CODEX_MODEL = DEFAULT_CODEX_MODEL;
export const CODEX_REASONING_EFFORT = DEFAULT_CODEX_REASONING;
export const CLAUDE_THINKING = { type: "adaptive" } as const;

export function resolveThinkingConfig(level: string | null | undefined): ThinkingConfig {
  switch (level) {
    case "off":
      return { type: "disabled" };
    case "adaptive":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    default:
      return { type: "adaptive" };
  }
}

export function resolveClaudeEffort(level: string | null | undefined): EffortLevel | undefined {
  switch (level) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return level;
    default:
      return undefined;
  }
}

export function buildLeanInstructions(enabled: boolean): string {
  if (!enabled) return "";
  return [
    "[LEAN_IMPLEMENTATION_POLICY]",
    "구현 전에 아래 순서에서 처음으로 충분한 해법을 선택한다.",
    "1. 실제로 만들 필요가 없는 요구라면 만들지 않고 이유를 짧게 설명한다.",
    "2. 표준 라이브러리로 해결되면 그것을 사용한다.",
    "3. 운영체제, 런타임, 브라우저, DB 등 플랫폼 기본 기능으로 해결되면 그것을 사용한다.",
    "4. 이미 설치된 의존성으로 해결되면 새 의존성을 추가하지 않는다.",
    "5. 그 다음에만 동작하는 최소 범위의 코드를 작성한다.",
    "요청하지 않은 추상화, 미래용 확장점, 중복 래퍼, 불필요한 설정과 의존성을 만들지 않는다.",
    "단, 신뢰 경계 입력 검증, 보안, 데이터 손실 방지 오류 처리, 접근성, 사용자가 명시한 요구사항과 실행 가능한 검증은 축소하지 않는다."
  ].join("\n");
}

interface RunRequest {
  session: SessionRecord;
  prompt: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  operation?: "prompt" | "compact";
  // 한도 오류로 다른 계정 토큰에 자동 전환해 재실행한 횟수. 무한 전환을 막는 가드.
  autoSwitchCount?: number;
  // 일시적 과부하(Overloaded/5xx)로 백오프 후 자동 재시도한 횟수. 무한 재시도를 막는 가드.
  retryCount?: number;
}

interface SessionManagerOptions {
  debounceMs: number;
  claudeCodeOauthToken: string;
  // 한도 도달 시 페일오버할 추가 계정 토큰(선택). 기본 토큰 다음 우선순위로 사용된다.
  additionalOauthTokens?: string[];
  claudeCodeExecutable?: string;
  // agy(Antigravity CLI) 바이너리 경로. 데몬 PATH에 ~/.local/bin이 없을 수 있어 명시 경로를 받는다.
  agyExecutable?: string;
  mcpToolTimeoutMs: number;
  mcpMaxAttempts: number;
  codexMcpTimeoutMs: number;
  codexMcpHeartbeatMs: number;
  longRunningMcpServers: ReadonlySet<string>;
  turnIdleTimeoutMs: number;
  claudeMemoryDir: string;
  modelCatalog: ModelCatalog;
  deleteClaudeSession?: typeof deleteClaudeSession;
}

interface ActiveRun {
  controller: AbortController;
  input: MessageQueue;
  pendingTurns: number;
  startedAt: number;
  query?: Query;
  codexTimers: Map<string, NodeJS.Timeout>;
  codexStarts: Map<string, number>;
  mcpFailures: Map<string, number>;
}

export interface SessionInspection {
  sessionId: string;
  cwd: string;
  title: string;
  startedAt: number;
  pendingTurns: number;
  codexInFlight: boolean;
  codexElapsedMs: number | null;
}

function assistantBlocks(message: SDKMessage): Array<Record<string, unknown>> {
  if (message.type !== "assistant" || !Array.isArray(message.message.content)) return [];
  return message.message.content as unknown as Array<Record<string, unknown>>;
}

function resultText(message: SDKMessage): string {
  if (message.type !== "result") return "";
  if (message.subtype === "success") return message.result;
  return message.errors.join("\n");
}

function codexProgress(item: ThreadItem): string | null {
  if (item.type === "command_execution") {
    return `Codex 명령 완료: ${item.command.split("\n")[0]?.slice(0, 180) ?? ""}`;
  }
  if (item.type === "file_change") {
    const paths = item.changes.map((change) => change.path).slice(0, 4).join(", ");
    return `Codex 파일 변경: ${paths}`;
  }
  if (item.type === "todo_list") {
    const completed = item.items.filter((todo) => todo.completed).length;
    return `Codex 계획 진행: ${completed}/${item.items.length}`;
  }
  if (item.type === "web_search") return `Codex 검색 완료: ${item.query.slice(0, 180)}`;
  if (item.type === "mcp_tool_call") return `Codex MCP 완료: ${item.server}/${item.tool}`;
  if (item.type === "error") return `Codex 오류: ${item.message.slice(0, 180)}`;
  return null;
}

export function buildCodexEnvironment(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if ([
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_API_BASE"
    ].includes(key)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function requireCodexSubscriptionAuth(
  source: NodeJS.ProcessEnv = process.env
): void {
  const codexHome = source.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const authPath = join(codexHome, "auth.json");
  let auth: unknown;
  try {
    auth = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
  } catch {
    throw new Error(
      "Codex 구독 로그인을 확인할 수 없습니다. 로컬 Codex CLI에서 Sign in with ChatGPT를 완료하세요."
    );
  }
  if (
    typeof auth !== "object"
    || auth === null
    || Array.isArray(auth)
    || (auth as Record<string, unknown>)["auth_mode"] !== "chatgpt"
  ) {
    throw new Error(
      "Codex API 키 인증은 허용하지 않습니다. Codex CLI를 ChatGPT 구독 계정으로 로그인하세요."
    );
  }
}

export class StreamingTextCollector {
  private readonly blocks = new Map<number, string>();

  accept(message: SDKMessage): string | null {
    if (message.type !== "stream_event" || message.parent_tool_use_id !== null) return null;
    const event = message.event;
    if (event.type === "content_block_start") {
      if (event.content_block.type === "text") {
        this.blocks.set(event.index, event.content_block.text);
      }
      return null;
    }
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      this.blocks.set(event.index, (this.blocks.get(event.index) ?? "") + event.delta.text);
      return null;
    }
    if (event.type !== "content_block_stop") return null;

    const text = this.blocks.get(event.index)?.trim() ?? "";
    this.blocks.delete(event.index);
    return text || null;
  }
}

export function buildCompactCommand(focus?: string): string {
  const clean = focus?.replace(/\s+/g, " ").trim().slice(0, 500);
  return clean ? `/compact ${clean}` : "/compact";
}

/** /goal 자동 진행 턴에 전달할 작업 프롬프트. reason은 직전 평가에서 무엇이 남았는지. */
export function buildGoalPrompt(condition: string, reason?: string): string {
  const clean = condition.replace(/\s+/g, " ").trim();
  const base = `[GOAL] 다음 목표가 완전히 충족될 때까지 작업을 진행하세요: ${clean}`;
  const tail = reason
    ? `\n직전 턴 평가에서 아직 충족되지 않았습니다: ${reason}\n남은 부분을 끝까지 완료하세요.`
    : "";
  return `${base}${tail}`;
}

/** /goal 충족 여부를 빠른 모델로 판정시키기 위한 읽기 전용 프롬프트. */
export function buildGoalCheckPrompt(condition: string): string {
  const clean = condition.replace(/\s+/g, " ").trim();
  return [
    "다음 목표가 현재 저장소 상태에서 이미 충족되었는지 읽기 전용으로만 확인해 판정하세요.",
    "파일을 수정하지 말고, 필요한 파일·명령 결과를 확인한 뒤 마지막 줄에 정확히 아래 한 형식으로만 답하세요.",
    "GOAL_MET: <한 줄 근거>",
    "GOAL_UNMET: <무엇이 남았는지 한 줄>",
    "",
    `목표: ${clean}`
  ].join("\n");
}

export function buildMemoryPrompt(focus?: string, memoryDir = "~/.claude/memory"): string {
  const clean = focus?.replace(/\s+/g, " ").trim().slice(0, 1000);
  const scope = clean
    ? `사용자가 지정한 저장 초점: ${clean}`
    : "현재 세션 전체에서 앞으로도 반복해서 유용할 내용을 검토한다.";
  // 경로와 파일 형식을 프롬프트 본문에 명시해 Claude/Codex 양쪽에서 동일하게 동작하게 한다.
  // Codex 턴에는 Claude 같은 메모리 시스템 프롬프트가 없으므로 self-contained해야 한다.
  return [
    "[EXPLICIT_MEMORY_UPDATE]",
    "사용자가 /memory 명령으로 전역 장기 메모리 업데이트를 명시적으로 승인했다.",
    scope,
    `메모리는 항상 ${memoryDir} 에만 기록한다. 새 메모리 파일은 이 경로에 만들고 인덱스는 ${memoryDir}/MEMORY.md 를 한 줄로 갱신한다.`,
    "각 메모리 파일은 frontmatter(--- / name: <kebab-slug> / description: <한 줄 요약> / "
    + "metadata: type: user|feedback|project|reference / ---)와 본문 한 가지 사실로 구성한다.",
    `기존 ${memoryDir}/MEMORY.md와 관련 메모리 파일을 먼저 읽고, 중복 없이 최소 범위로 갱신한다.`,
    "일시적인 작업 상태, 이미 끝난 세부 절차, 추측, 비밀정보, 자격증명은 저장하지 않는다.",
    "새 사실을 발명하지 말고 현재 대화에서 확인된 사용자 선호, 결정, 반복 사용 가능한 프로젝트 지식만 기록한다.",
    "이 명령문 자체는 메모리 내용으로 저장하지 않는다.",
    "완료 후 변경한 메모리 파일과 저장한 핵심 내용을 짧게 보고한다."
  ].join("\n");
}

export function resultSummary(
  message: SDKMessage,
  hasDeliveredAssistantText: boolean
): string {
  if (message.type !== "result") return "";
  if (message.subtype === "success" && hasDeliveredAssistantText) return "";
  return resultText(message);
}

export function loadProjectInstructions(cwd: string): string {
  const sections: string[] = [];
  for (const filename of ["CLAUDE.md", "AGENTS.md"]) {
    try {
      const content = readFileSync(join(cwd, filename), "utf8").trim();
      if (content) sections.push(`[${filename}]\n${content.slice(0, 100_000)}`);
    } catch {
      // Project instruction files are optional.
    }
  }
  return sections.join("\n\n");
}

async function readUsageSnapshot(
  sdkQuery: ReturnType<typeof query>,
  timeoutMs = 5000
): Promise<UsageSnapshot | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      sdkQuery
        .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
        .then((usage) => snapshotFromUsageResponse(usage)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      })
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface UsageLookupResult {
  snapshot: UsageSnapshot | null;
  error: string | null;
}

export interface TokenUsageLookupResult extends UsageLookupResult {
  tokenIndex: number;
}

function hasUsageWindows(snapshot: UsageSnapshot): boolean {
  return Boolean(
    snapshot.fiveHour
    || snapshot.sevenDay
    || snapshot.sevenDayOpus
    || snapshot.sevenDaySonnet
    || snapshot.agentSdkWeekly
    || snapshot.extraUsage
  );
}

function datePartsInTimeZone(timestamp: number, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0
  };
}

function zonedDateTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = datePartsInTimeZone(candidate, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const correction = targetAsUtc - actualAsUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  return candidate;
}

function normalizeResetTimeZone(value: string | undefined): string {
  const clean = value?.trim();
  if (!clean) return "Asia/Seoul";
  const aliases: Record<string, string> = {
    KST: "Asia/Seoul",
    UTC: "UTC",
    GMT: "UTC"
  };
  const timeZone = aliases[clean.toUpperCase()] ?? clean;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "Asia/Seoul";
  }
}

function nextResetInTimeZone(
  hour: number,
  minute: number,
  timeZone: string,
  now = Date.now()
): string {
  const current = datePartsInTimeZone(now, timeZone);
  let reset = zonedDateTimeToEpoch(
    current.year,
    current.month,
    current.day,
    hour,
    minute,
    timeZone
  );
  if (reset <= now) {
    const nextDate = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
    reset = zonedDateTimeToEpoch(
      nextDate.getUTCFullYear(),
      nextDate.getUTCMonth() + 1,
      nextDate.getUTCDate(),
      hour,
      minute,
      timeZone
    );
  }
  return new Date(reset).toISOString();
}

export function snapshotFromRateLimitError(error: unknown, capturedAt = Date.now()): UsageSnapshot | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!isRateLimitError(message)) return null;
  const resetMatch = message.match(
    /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i
  );
  let resetsAt: string | null = null;
  if (resetMatch) {
    let hour = Number(resetMatch[1]);
    const minute = resetMatch[2] ? Number(resetMatch[2]) : 0;
    const meridiem = resetMatch[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    const timeZone = normalizeResetTimeZone(resetMatch[4]);
    resetsAt = nextResetInTimeZone(hour, minute, timeZone, capturedAt);
  }
  return {
    capturedAt,
    subscriptionType: null,
    rateLimitsAvailable: true,
    fiveHour: {
      utilization: 100,
      resetsAt
    }
  };
}

// 한도/요금 한계로 턴이 실패했는지 휴리스틱으로 판별한다. utilization 100% 이벤트가
// 오기 전에 곧장 에러로 끝나는 경우를 잡아 다음 세션을 다른 토큰으로 유도하기 위함이다.
export function isRateLimitError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("rate limit")
    || message.includes("rate_limit")
    || message.includes("429")
    || message.includes("usage limit")
    || message.includes("quota")
    || (message.includes("limit") && message.includes("reset"))
  );
}

// 일시적 서버 과부하/장애로 턴이 실패했는지 판별한다. 토큰 한도가 아니라 Anthropic
// 백엔드 전역 과부하(529 Overloaded)나 일시 장애(5xx)이므로, 토큰을 봉인/전환하지 않고
// 짧은 백오프 후 같은 토큰으로 같은 작업을 재시도하면 대부분 회복된다.
export function isOverloadedError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("overloaded")
    || message.includes("529")
    || message.includes("503")
    || message.includes("502")
    || message.includes("service unavailable")
    || message.includes("internal server error")
  );
}

export function resultFailureText(
  message: SDKMessage,
  rateLimitRejected = false
): string | null {
  if (message.type !== "result") return null;
  const text = resultText(message);
  if (rateLimitRejected || isRateLimitError(text) || isOverloadedError(text)) {
    return text || (rateLimitRejected ? "Claude rate limit rejected" : null);
  }
  return message.subtype === "success" ? null : text || "Claude 실행이 실패했습니다.";
}

export function buildClaudeEnvironment(
  oauthToken: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  mcpToolTimeoutMs?: number
): Record<string, string | undefined> {
  return {
    ...baseEnvironment,
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ...(mcpToolTimeoutMs
      ? {
          MCP_TIMEOUT: String(mcpToolTimeoutMs),
          MCP_TOOL_TIMEOUT: String(mcpToolTimeoutMs)
        }
      : {})
  };
}

export function buildUserMessage(
  text: string,
  priority?: "now" | "next"
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {})
  };
}

export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private readonly waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(value: SDKUserMessage): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

export class SessionManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly projectTails = new Map<string, Promise<void>>();
  private readonly queuedCounts = new Map<string, number>();
  private readonly sessionTasks = new Map<string, Promise<void>>();
  private readonly deleting = new Set<string>();
  // 모든 토큰 한도 도달로 멈춘 세션을 회복 시각에 자동 재개하기 위해 거는 타이머.
  private readonly limitWaiters = new Map<string, NodeJS.Timeout>();
  // /goal 자동 진행이 한 목표에서 돈 턴 수(MAX_GOAL_ROUNDS 상한 적용).
  private readonly goalRounds = new Map<string, number>();
  private readonly tokenPool: TokenPool;
  private readonly oauthTokens: string[];

  constructor(
    private readonly store: StateStore,
    private readonly transport: MessageTransport,
    private readonly permissions: PermissionBroker,
    private readonly options: SessionManagerOptions
  ) {
    this.oauthTokens = [
      options.claudeCodeOauthToken,
      ...(options.additionalOauthTokens ?? [])
    ];
    this.tokenPool = new TokenPool(this.oauthTokens);
  }

  createSession(
    project: ProjectConfig,
    chatId: number,
    topicId: number,
    title: string,
    prompt: string,
    resumeSessionId?: string,
    forkSession = false,
    model?: string | null,
    thinking?: string | null,
    claudeEffort?: string | null,
    leanMode = true,
    provider: ProviderKind = "claude",
    codexModel?: string | null,
    codexReasoning?: string | null,
    agyModel?: string | null
  ): SessionRecord {
    const now = Date.now();
    const session: SessionRecord = {
      id: randomUUID(),
      sdkSessionId: forkSession ? null : resumeSessionId ?? null,
      chatId,
      topicId,
      projectName: project.name,
      cwd: project.cwd,
      title,
      status: "queued",
      permissionMode: project.defaultMode,
      provider,
      model: model ?? null,
      thinking: thinking ?? null,
      claudeEffort: claudeEffort ?? null,
      codexModel: codexModel ?? null,
      codexReasoning: codexReasoning ?? null,
      codexThreadId: null,
      agyModel: agyModel ?? null,
      agyConversationId: null,
      handoffSummary: null,
      goalCondition: null,
      leanMode,
      usageSnapshot: null,
      createdAt: now,
      updatedAt: now
    };
    this.store.createSession(session);
    this.enqueue({
      session,
      prompt,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(forkSession ? { forkSession: true } : {})
    });
    return session;
  }

  resume(session: SessionRecord, prompt: string): boolean {
    if (this.active.has(session.id)) return false;
    // Codex 세션은 스레드를 새로 시작할 수 있어 항상 이어 갈 수 있다. Claude 세션은 이어 갈
    // SDK 세션 id가 있어야 한다. 제공사 전환 직후(handoffSummary 보유)에는 양쪽 모두 새
    // 맥락에서 요약을 받아 시작하므로 재개 핸들 없이도 진행한다.
    const canResume = session.provider === "codex"
      || session.provider === "agy"
      || !!session.sdkSessionId
      || !!session.handoffSummary;
    if (!canResume) return false;
    this.store.updateSession(session.id, { status: "queued" });
    this.enqueue({
      session: this.store.getSession(session.id) ?? session,
      prompt,
      ...(session.provider === "claude" && session.sdkSessionId
        ? { resumeSessionId: session.sdkSessionId }
        : {})
    });
    return true;
  }

  compact(session: SessionRecord, focus?: string): boolean {
    if (!session.sdkSessionId || this.active.has(session.id)) return false;
    this.store.updateSession(session.id, { status: "queued" });
    this.enqueue({
      session: this.store.getSession(session.id) ?? session,
      prompt: buildCompactCommand(focus),
      resumeSessionId: session.sdkSessionId,
      operation: "compact"
    });
    return true;
  }

  /** 제공자별 "이어 갈 수 있는 재개 핸들". null이면 아직 한 번도 실행되지 않은 세션이다. */
  private resumeHandle(session: SessionRecord): string | null {
    if (session.provider === "codex") return session.codexThreadId;
    if (session.provider === "agy") return session.agyConversationId;
    return session.sdkSessionId;
  }

  /**
   * 목표를 설정한다. 유휴 상태이고 이어 갈 세션(Claude/Codex/agy)이 있으면 즉시 목표를 향한
   * 턴을 시작한다("queued"). 실행 중이면 현재 턴이 끝날 때 평가한다("active"). 이어 갈 세션이
   * 아직 없으면 저장만 한다("stored").
   */
  setGoal(sessionId: string, condition: string): "queued" | "active" | "stored" {
    const session = this.store.getSession(sessionId);
    if (!session) return "stored";
    const clean = condition.replace(/\s+/g, " ").trim();
    this.store.updateSession(sessionId, { goalCondition: clean });
    this.goalRounds.set(sessionId, 0);
    if (this.active.has(sessionId)) return "active";
    if (!this.resumeHandle(session)) return "stored";
    this.store.updateSession(sessionId, { status: "queued" });
    this.enqueue({
      session: this.store.getSession(sessionId) ?? session,
      prompt: buildGoalPrompt(clean),
      // resumeSessionId는 Claude 전용 재개 핸들이다. codex/agy는 executeX가 스레드/대화 id를
      // 저장소에서 다시 읽어 재개하므로 전달하지 않는다.
      ...(session.provider === "claude" && session.sdkSessionId
        ? { resumeSessionId: session.sdkSessionId }
        : {})
    });
    return "queued";
  }

  /** 목표 자동 진행을 끈다. 끌 목표가 있었으면 true. */
  clearGoal(sessionId: string): boolean {
    const had = !!this.store.getSession(sessionId)?.goalCondition;
    this.goalRounds.delete(sessionId);
    if (this.store.getSession(sessionId)) {
      this.store.updateSession(sessionId, { goalCondition: null });
    }
    return had;
  }

  stop(sessionId: string): boolean {
    // /stop은 진행 중인 목표 자동 진행도 함께 멈춘다.
    this.clearGoal(sessionId);
    // 한도 회복을 기다리며 예약된 자동 재개가 있으면 그것도 중단으로 친다.
    if (this.cancelLimitWaiter(sessionId)) {
      if (this.store.getSession(sessionId)?.status === "waiting_limit") {
        this.store.updateSession(sessionId, { status: "aborted" });
      }
      return true;
    }
    const run = this.active.get(sessionId);
    if (!run) return false;
    run.input.close();
    run.controller.abort();
    // close()는 hang된 for-await가 풀리길 기다리지 않고 CLI 서브프로세스를 즉시
    // 강제 종료한다 — in-flight MCP 호출/transport와 서브에이전트까지 함께 정리되어
    // 종료 후 MCP 호출이 남아 가로막는 문제를 막는다. finally의 close()는 멱등 백업.
    run.query?.close();
    return true;
  }

  async fetchCurrentUsageSnapshots(cwd: string): Promise<TokenUsageLookupResult[]> {
    const results: TokenUsageLookupResult[] = [];
    for (const [index, oauthToken] of this.oauthTokens.entries()) {
      const result = await this.fetchUsageSnapshotForToken(cwd, oauthToken);
      results.push({ tokenIndex: index + 1, ...result });
    }
    return results;
  }

  async fetchCurrentUsageSnapshot(cwd: string): Promise<UsageLookupResult> {
    return this.fetchUsageSnapshotForToken(cwd, this.tokenPool.select());
  }

  private async fetchUsageSnapshotForToken(
    cwd: string,
    oauthToken: string
  ): Promise<UsageLookupResult> {
    const abortController = new AbortController();
    let provisionalSnapshot: UsageSnapshot | null = null;
    const sdkQuery = query({
      prompt: "사용량 확인용 요청입니다. 도구를 쓰지 말고 OK만 답하세요.",
      options: {
        cwd,
        abortController,
        model: DEFAULT_CLAUDE_MODEL,
        thinking: { type: "disabled" },
        maxTurns: 1,
        maxBudgetUsd: 0.01,
        permissionMode: "default",
        allowedTools: [],
        settingSources: [],
        env: buildClaudeEnvironment(
          oauthToken,
          process.env,
          this.options.mcpToolTimeoutMs
        ),
        ...(this.options.claudeCodeExecutable
          ? { pathToClaudeCodeExecutable: this.options.claudeCodeExecutable }
          : {})
      }
    });

    try {
      for await (const message of sdkQuery) {
        if (message.type === "system" && message.subtype === "init") {
          const snapshot = await readUsageSnapshot(sdkQuery, 10_000);
          if (snapshot && hasUsageWindows(snapshot)) {
            this.tokenPool.observe(oauthToken, snapshot);
            return { snapshot, error: null };
          }
          provisionalSnapshot = snapshot;
        }
        if (message.type !== "result") continue;
        const snapshot = await readUsageSnapshot(sdkQuery, 10_000);
        this.tokenPool.observe(oauthToken, snapshot);
        return { snapshot: snapshot ?? provisionalSnapshot, error: null };
      }
      return {
        snapshot: provisionalSnapshot,
        error: provisionalSnapshot ? null : "사용량 조회 세션이 결과 없이 종료되었습니다."
      };
    } catch (error) {
      const limitSnapshot = snapshotFromRateLimitError(error);
      if (limitSnapshot) {
        this.tokenPool.noteRateLimited(
          oauthToken,
          Date.now(),
          limitSnapshot.fiveHour?.resetsAt ? Date.parse(limitSnapshot.fiveHour.resetsAt) : undefined
        );
        return { snapshot: limitSnapshot, error: null };
      }
      if (isRateLimitError(error)) {
        this.tokenPool.noteRateLimited(oauthToken);
      }
      return { snapshot: null, error: safeErrorMessage(error) };
    } finally {
      abortController.abort();
      sdkQuery.close();
    }
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  inspect(): SessionInspection[] {
    const now = Date.now();
    const inspections: SessionInspection[] = [];
    for (const [sessionId, run] of this.active) {
      const session = this.store.getSession(sessionId);
      if (!session) continue;
      const oldestCodexStart = run.codexStarts.size > 0
        ? Math.min(...run.codexStarts.values())
        : null;
      inspections.push({
        sessionId,
        cwd: session.cwd,
        title: session.title,
        startedAt: run.startedAt,
        pendingTurns: run.pendingTurns,
        codexInFlight: oldestCodexStart !== null,
        codexElapsedMs: oldestCodexStart === null ? null : now - oldestCodexStart
      });
    }
    return inspections;
  }

  // 제공사를 전환한다(유휴 상태에서만). 현재 provider로 인계 요약을 만들어 저장하고,
  // 대상 provider의 재개 핸들을 비워 새 맥락에서 요약을 받아 이어 가게 한다. 전환 결과를
  // 돌려주고, 다음 사용자 턴부터 새 provider가 적용된다.
  async switchProvider(
    sessionId: string,
    target: ProviderKind
  ): Promise<{ ok: boolean; reason?: string }> {
    const session = this.store.getSession(sessionId);
    if (!session) return { ok: false, reason: "세션을 찾을 수 없습니다." };
    if (this.active.has(sessionId) || this.sessionTasks.has(sessionId)) {
      return { ok: false, reason: "실행 중에는 전환할 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요." };
    }
    if (session.provider === target) return { ok: false, reason: "이미 해당 제공사를 사용 중입니다." };

    let summary = "";
    try {
      summary = await this.summarizeForHandoff(session);
    } catch (error) {
      console.error("Handoff summary failed:", safeErrorMessage(error, this.oauthTokens));
    }

    if (target === "codex") {
      // 대상=Codex: 새 스레드에서 요약을 받아 시작한다.
      this.store.updateSession(sessionId, {
        provider: "codex",
        codexThreadId: null,
        ...(summary ? { handoffSummary: summary } : {})
      });
    } else if (target === "agy") {
      // 대상=agy: 새 대화에서 요약을 받아 시작한다.
      this.store.updateSession(sessionId, {
        provider: "agy",
        agyConversationId: null,
        ...(summary ? { handoffSummary: summary } : {})
      });
    } else {
      // 대상=Claude: 새 SDK 세션에서 요약을 받아 시작한다.
      this.store.updateSession(sessionId, {
        provider: "claude",
        sdkSessionId: null,
        ...(summary ? { handoffSummary: summary } : {})
      });
    }
    return { ok: true };
  }

  // 현재 provider에게 다음 어시스턴트가 이어받을 인계 요약을 만들게 한다. 한 번도 실행된 적이
  // 없는 세션(재개 핸들 없음)은 인계할 맥락이 없으므로 빈 문자열을 돌려준다.
  private async summarizeForHandoff(session: SessionRecord): Promise<string> {
    const prompt =
      "이 세션에서 지금까지 진행한 대화와 작업을, 다른 AI 어시스턴트가 그대로 이어받아 "
      + "작업을 계속할 수 있도록 한국어로 간결하게 요약하세요. 핵심 목표, 현재까지의 진행/결정, "
      + "수정한 파일과 그 이유, 남은 일과 주의점을 포함하고 요약 본문만 출력하세요.";
    if (session.provider === "claude") {
      if (!session.sdkSessionId) return "";
      const controller = new AbortController();
      const run: ActiveRun = {
        controller,
        input: new MessageQueue(),
        pendingTurns: 0,
        startedAt: Date.now(),
        codexTimers: new Map(),
        codexStarts: new Map(),
        mcpFailures: new Map()
      };
      return this.runReadOnlyClaude(session, controller, run, prompt, this.tokenPool.select());
    }
    if (session.provider === "agy") {
      // agy: 직전 대화를 재개해 요약 한 턴을 받는다(요약 프롬프트는 읽기 전용 의도).
      if (!session.agyConversationId) return "";
      const { stdout } = await this.runAgy(
        [
          "--print", prompt,
          "--dangerously-skip-permissions",
          "--conversation", session.agyConversationId
        ],
        session.cwd
      );
      return this.stripAgyWarning(stdout).trim();
    }
    // Codex: 직전 스레드를 재개해 비스트리밍으로 요약 한 턴을 받는다.
    if (!session.codexThreadId) return "";
    requireCodexSubscriptionAuth();
    const codex = new Codex({ env: buildCodexEnvironment() });
    const thread = codex.resumeThread(session.codexThreadId, {
      workingDirectory: session.cwd,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never"
    });
    const result = await thread.run(prompt);
    return result.finalResponse.trim();
  }

  async deleteSession(session: SessionRecord): Promise<void> {
    this.deleting.add(session.id);
    const wasActive = this.active.has(session.id);
    this.stop(session.id);
    this.store.deleteSession(session.id);

    const task = this.sessionTasks.get(session.id);
    if (wasActive && task) await task.catch(() => undefined);

    const sdkSessionId = session.sdkSessionId ?? session.id;
    const removeClaudeSession = this.options.deleteClaudeSession ?? deleteClaudeSession;
    await removeClaudeSession(sdkSessionId, { dir: session.cwd }).catch((error) => {
      console.error("Claude session deletion failed:", safeErrorMessage(error));
    });
    if (!task || wasActive) this.deleting.delete(session.id);
  }

  steer(sessionId: string, prompt: string): boolean {
    const run = this.active.get(sessionId);
    const clean = prompt.trim();
    if (!run || !clean) return false;
    run.pendingTurns += 1;
    if (run.input.push(buildUserMessage(clean, "now"))) return true;
    run.pendingTurns -= 1;
    return false;
  }

  queueFollowUp(sessionId: string, prompt: string): boolean {
    const run = this.active.get(sessionId);
    const clean = prompt.trim();
    if (!run || !clean) return false;
    run.pendingTurns += 1;
    if (run.input.push(buildUserMessage(clean, "next"))) return true;
    run.pendingTurns -= 1;
    return false;
  }

  /** 예약된 한도-회복 자동 재개 타이머를 취소한다. 실제로 취소했으면 true. */
  private cancelLimitWaiter(sessionId: string): boolean {
    const timer = this.limitWaiters.get(sessionId);
    if (!timer) return false;
    clearTimeout(timer);
    this.limitWaiters.delete(sessionId);
    return true;
  }

  /**
   * 모든 토큰이 한도에 도달해 더 실행할 수 없을 때, 가장 먼저 회복되는 시각에 맞춰
   * 같은 작업을 자동으로 다시 큐에 넣는다. 그 전에 사용자가 새 지시를 보내면(enqueue)
   * 타이머가 취소되어 즉시 재개되고, 데몬이 재시작되면 타이머는 사라지되 세션은
   * interrupted로 복구된다.
   */
  private scheduleLimitResume(
    session: SessionRecord,
    request: RunRequest,
    sdkSessionId: string | null,
    resumeAt: number
  ): void {
    const delayMs = Math.max(0, resumeAt - Date.now()) + LIMIT_RESUME_BUFFER_MS;
    const when = new Date(resumeAt + LIMIT_RESUME_BUFFER_MS).toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul"
    });
    const lead = this.tokenPool.size > 1
      ? "모든 계정 토큰이 한도에 도달했습니다."
      : "토큰이 한도에 도달했습니다.";
    this.store.updateSession(session.id, { status: "waiting_limit" });
    void this.transport.sendText(
      session.chatId,
      session.topicId,
      `${lead} ${when}에 한도가 회복되면 자동으로 이어서 실행합니다. `
      + "(그 전에 새 지시를 보내면 즉시 재개를 시도합니다.)"
    ).catch(() => undefined);
    void this.safeRename(session, `[WAIT] ${session.title}`);

    const resumeId = sdkSessionId ?? request.resumeSessionId;
    const resumeRequest: RunRequest = {
      ...request,
      ...(resumeId ? { resumeSessionId: resumeId } : {}),
      // 회복 후에는 다시 토큰 전환을 시도할 수 있도록 전환 카운터를 초기화한다.
      autoSwitchCount: 0
    };
    this.cancelLimitWaiter(session.id);
    const timer = setTimeout(() => {
      this.limitWaiters.delete(session.id);
      if (this.deleting.has(session.id) || !this.store.getSession(session.id)) return;
      if (this.active.has(session.id)) return;
      this.enqueue(resumeRequest);
    }, delayMs);
    timer.unref();
    this.limitWaiters.set(session.id, timer);
  }

  private enqueue(request: RunRequest): void {
    // 예약된 한도-회복 자동 재개가 있으면 취소한다. 사용자가 먼저 새 지시를 보냈거나
    // 자동 재개 타이머가 직접 enqueue를 호출한 경우 모두, 중복 실행을 막는다.
    this.cancelLimitWaiter(request.session.id);
    const cwd = request.session.cwd;
    const count = this.queuedCounts.get(cwd) ?? 0;
    const waitsForPrevious = this.projectTails.has(cwd);
    this.queuedCounts.set(cwd, count + 1);
    const previous = this.projectTails.get(cwd) ?? Promise.resolve();
    if (waitsForPrevious) {
      const ahead = Math.max(1, count);
      void this.transport.sendText(
        request.session.chatId,
        request.session.topicId,
        `[QUEUED] 같은 프로젝트에서 실행 중인 작업 ${ahead}개가 끝나기를 기다립니다.\n`
        + "앞선 작업이 종료되면 자동으로 시작합니다."
      ).catch((error: unknown) => {
        console.error(
          `Queued status notification failed (${request.session.id}):`,
          safeErrorMessage(error, this.oauthTokens)
        );
      });
    }
    const next = previous
      .catch(() => undefined)
      .then(() => this.dispatch(request))
      .catch((error: unknown) => {
        // execute()의 자체 오류 처리 중 Telegram 전송/토픽 변경까지 실패하면 예외가
        // 여기까지 빠질 수 있다. 이 Promise를 미처리 rejection으로 두면 Node 데몬이
        // 종료되고 launchd 재시작 뒤 토큰 풀이 초기화되어 같은 페일오버를 반복한다.
        console.error(
          `Session execution escaped error (${request.session.id}):`,
          safeErrorMessage(error, this.oauthTokens)
        );
        if (this.store.getSession(request.session.id)) {
          this.store.updateSession(request.session.id, { status: "error" });
        }
        void this.transport.sendText(
          request.session.chatId,
          request.session.topicId,
          "[ERROR] 작업 오류를 처리하는 중 추가 통신 오류가 발생했습니다. "
          + "오케스트레이터는 종료되지 않았습니다. 잠시 후 다시 시도하세요."
        ).catch(() => undefined);
      })
      .finally(() => {
        const remaining = Math.max(0, (this.queuedCounts.get(cwd) ?? 1) - 1);
        this.queuedCounts.set(cwd, remaining);
        if (this.projectTails.get(cwd) === next) this.projectTails.delete(cwd);
        if (this.sessionTasks.get(request.session.id) === next) {
          this.sessionTasks.delete(request.session.id);
        }
        this.deleting.delete(request.session.id);
      });
    this.projectTails.set(cwd, next);
    this.sessionTasks.set(request.session.id, next);
  }

  // 제공사 전환 직후 첫 턴에 직전 provider의 인계 요약을 프롬프트 앞에 붙이고 저장값을
  // 비운다. compact 같은 비대화 작업에는 주입하지 않는다.
  private applyHandoffSummary(request: RunRequest, session: SessionRecord): RunRequest {
    if (!session.handoffSummary || request.operation === "compact") return request;
    const prompt =
      `[이전 어시스턴트로부터 인계받은 작업 요약]\n${session.handoffSummary}\n\n`
      + `[사용자의 새 지시]\n${request.prompt}`;
    this.store.updateSession(session.id, { handoffSummary: null });
    return { ...request, prompt };
  }

  // 큐에서 꺼낸 작업을 현재 저장된 provider에 맞는 실행기로 보낸다. provider는 /model
  // 전환으로 큐 대기 중에 바뀔 수 있으므로 스냅샷이 아닌 최신 값을 다시 읽는다.
  private async dispatch(request: RunRequest): Promise<void> {
    const session = this.store.getSession(request.session.id);
    const provider = session?.provider ?? request.session.provider;
    if (provider === "codex") {
      await this.executeCodex(request);
      return;
    }
    if (provider === "agy") {
      await this.executeAgy(request);
      return;
    }
    await this.execute(request);
  }

  private async execute(request: RunRequest): Promise<void> {
    if (this.deleting.has(request.session.id)) return;
    const session = this.store.getSession(request.session.id);
    if (!session) return;
    // 제공사 전환 직후 첫 턴이면 인계 요약을 프롬프트 앞에 1회 주입하고 비운다.
    request = this.applyHandoffSummary(request, session);
    const renderer = new StreamRenderer(session, this.transport, this.options.debounceMs);
    const abortController = new AbortController();
    const input = new MessageQueue();
    input.push(buildUserMessage(request.prompt));
    const run: ActiveRun = {
      controller: abortController,
      input,
      pendingTurns: 1,
      startedAt: Date.now(),
      codexTimers: new Map(),
      codexStarts: new Map(),
      mcpFailures: new Map()
    };
    this.active.set(session.id, run);
    // 한도에 도달하지 않은 토큰을 고른다. 전부 소진이면 가장 빨리 회복될 토큰을 시도한다.
    const oauthToken = this.tokenPool.select();
    const tokenIndex = this.tokenPool.indexOf(oauthToken);
    let sdkSessionId = request.resumeSessionId ?? session.sdkSessionId;
    // 세션의 usageSnapshot은 텔레그램 표시용 캐시이며 어느 계정 토큰에서 수집됐는지
    // 식별하지 않는다. 토큰 전환 실행에서 이를 새 토큰의 관측값으로 재사용하면,
    // 1번 토큰의 100% 스냅샷 때문에 2번 토큰까지 소진 처리될 수 있다.
    let latestUsage: UsageSnapshot | null = session.usageSnapshot;
    let currentTokenUsage: UsageSnapshot | null = null;
    let lastAssistantText = "";
    let compactSummary = "";
    let finalStatus: "done" | "error" = "done";
    let lastActivityAt = Date.now();
    let idleTimedOut = false;
    let idleWatchdog: NodeJS.Timeout | undefined;
    const streamingText = new StreamingTextCollector();
    const streamedAssistantTexts: string[] = [];
    let hasDeliveredAssistantText = false;
    let rateLimitRejected = false;

    try {
      await this.safeRename(session, `[RUNNING] ${session.title}`);
      await renderer.start(false);
      if (this.tokenPool.size > 1 && tokenIndex > 0) {
        renderer.note(`기본 토큰 한도 도달 → 계정 토큰 #${tokenIndex + 1}로 전환해 실행합니다.`);
      }
      if (this.deleting.has(session.id)) return;
      this.store.updateSession(session.id, { status: "running" });

      const startCodexHeartbeat = (toolName: string, toolUseId: string): void => {
        const serverName = mcpServerName(toolName)?.toLowerCase();
        if (!serverName || !this.options.longRunningMcpServers.has(serverName)) return;
        const timer = setInterval(() => {
          void this.transport.sendText(
            session.chatId,
            session.topicId,
            `[MCP RUNNING] ${toolName} 작업이 계속 진행 중입니다. 완료 또는 실제 연결 실패까지 기다립니다.`
          ).catch(() => undefined);
        }, this.options.codexMcpHeartbeatMs);
        run.codexTimers.set(toolUseId, timer);
        run.codexStarts.set(toolUseId, Date.now());
      };

      const clearToolTimer = (toolUseId: string): void => {
        const timer = run.codexTimers.get(toolUseId);
        if (timer) clearInterval(timer);
        run.codexTimers.delete(toolUseId);
        run.codexStarts.delete(toolUseId);
      };

      const postToolUse: HookCallback = async (hookInput) => {
        if (hookInput.hook_event_name !== "PostToolUse") return {};
        clearToolTimer(hookInput.tool_use_id);
        run.mcpFailures.delete(mcpCallKey(hookInput.tool_name, hookInput.tool_input));
        return {};
      };

      const postToolUseFailure: HookCallback = async (hookInput) => {
        if (hookInput.hook_event_name !== "PostToolUseFailure") return {};
        clearToolTimer(hookInput.tool_use_id);
        if (!isRetryableMcpError(hookInput.tool_name, hookInput.error)) return {};

        const key = mcpCallKey(hookInput.tool_name, hookInput.tool_input);
        const failedAttempts = (run.mcpFailures.get(key) ?? 0) + 1;
        run.mcpFailures.set(key, failedAttempts);
        const server = mcpServerName(hookInput.tool_name) ?? "unknown";

        if (failedAttempts < this.options.mcpMaxAttempts) {
          renderer.note(
            `MCP ${server} 재시도 ${failedAttempts + 1}/${this.options.mcpMaxAttempts}`
          );
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: "PostToolUseFailure",
              additionalContext:
                `[MCP_RETRY ${failedAttempts + 1}/${this.options.mcpMaxAttempts}] `
                + `일시적 MCP 연결 오류입니다. 같은 도구와 같은 입력을 병렬 실행하지 말고 즉시 한 번만 다시 호출하세요.`
            }
          };
        }

        await this.transport.sendText(
          session.chatId,
          session.topicId,
          `[MCP FAILED] ${server} 서버의 ${hookInput.tool_name} 호출이 `
          + `${this.options.mcpMaxAttempts}회 모두 실패했습니다.\n${hookInput.error}`
        ).catch(() => undefined);
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PostToolUseFailure",
            additionalContext:
              `[MCP_FAILED] ${this.options.mcpMaxAttempts}회 모두 실패했습니다. `
              + "같은 호출은 더 재시도하지 말고 사용자에게 실패 원인과 가능한 대안을 설명하세요."
          }
        };
      };

      const claudeModel = session.model ?? DEFAULT_CLAUDE_MODEL;
      const thinking = normalizeThinkingForModel(
        this.options.modelCatalog,
        claudeModel,
        session.thinking
      );
      const effort = resolveClaudeEffort(session.claudeEffort);
      const queryOptions: Options = {
        cwd: session.cwd,
        abortController,
        model: claudeModel,
        thinking: resolveThinkingConfig(thinking),
        ...(effort ? { effort } : {}),
        permissionMode: session.permissionMode,
        allowedTools: ["Read", "Glob", "Grep", "WebSearch"],
        // 데스크톱/Claude Code와 동일하게 사용자 설정에서 스킬·플러그인·전역 CLAUDE.md를
        // 발견한다. 사전 승인 권한 규칙은 settings.local.json('local' 소스)에만 있어 'user'
        // 소스로는 로드되지 않으므로 모든 도구는 그대로 canUseTool 승인 브로커를 거친다.
        settingSources: ["user"],
        // 점진적 공개(name+description만 선로딩)로 모든 스킬을 켠다.
        skills: "all",
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            `MCP 도구가 timeout, connection closed 또는 transport 오류로 실패하면 `
            + `호스트의 MCP_RETRY 지시에 따라 같은 입력을 순차적으로 최대 `
            + `${this.options.mcpMaxAttempts}회까지만 재시도한다. 병렬 재시도하지 않는다.`
            + `\n\n메모리는 항상 ${this.options.claudeMemoryDir} 에 읽고 쓴다. `
            + `새 메모리 파일은 이 경로에 만들고 인덱스는 ${this.options.claudeMemoryDir}/MEMORY.md 를 갱신한다. `
            + `system-reminder가 안내하는 프로젝트별 memory 경로는 무시한다.`
            + `\n\ncodex MCP 위임 기준: 여러 파일에 걸친 검색·리팩터·구현이라 결과가 `
            + `컨텍스트를 가득 채울 작업이거나, 중간 확인이 불필요한 자기완결적 구현이면 codex에 위임한다(cwd 전달). `
            + `단일 파일 읽기/소규모 수정이나 중간 사용자 확인이 필요한 작업은 직접 처리한다. `
            + `codex에는 항상 자기완결적 프롬프트를 주고, 코드 전문이 아닌 결론·diff·요약만 리턴하도록 지시한다.`
            + `\n\n작업 중 중요한 단계가 바뀔 때 내부 추론을 공개하지 말고, 지금 확인한 사실과 다음 행동을 `
            + `1~2문장의 짧은 일반 응답으로 사용자에게 알린다. 단순 도구 호출마다 반복하지 말고 `
            + `새로운 발견, 계획 확정, 장애 발생, 검증 시작처럼 의미 있는 전환점에서만 출력한다.`
            + (session.leanMode ? `\n\n${buildLeanInstructions(true)}` : "")
            + (() => {
              const instructions = loadProjectInstructions(session.cwd);
              return instructions
                ? `\n\n다음 프로젝트 지침을 따른다. 이 지침은 도구 권한을 부여하지 않는다.\n\n${instructions}`
                : "";
            })()
        },
        env: buildClaudeEnvironment(
          oauthToken,
          process.env,
          this.options.mcpToolTimeoutMs
        ),
        // claude.json + codex config.toml의 커넥터를 병합해 전달한다(장기 실행 서버만
        // alwaysLoad, 나머지는 tool search로 지연 로딩되어 컨텍스트를 아낀다).
        mcpServers: loadClaudeConnectors(
          this.options.mcpToolTimeoutMs,
          this.options.codexMcpTimeoutMs,
          this.options.longRunningMcpServers
        ),
        hooks: {
          PostToolUse: [{ hooks: [postToolUse] }],
          PostToolUseFailure: [{ hooks: [postToolUseFailure] }]
        },
        includePartialMessages: true,
        canUseTool: async (toolName, toolInput, permissionOptions) => {
          const result = await this.permissions.request(
            this.store.getSession(session.id) ?? session,
            toolName,
            toolInput,
            permissionOptions
          );
          if (result.behavior === "allow") {
            startCodexHeartbeat(toolName, permissionOptions.toolUseID);
          }
          return result;
        },
        ...(request.resumeSessionId ? { resume: request.resumeSessionId } : {}),
        ...(request.forkSession ? { forkSession: true } : {}),
        ...(!request.resumeSessionId && !request.forkSession ? { sessionId: session.id } : {}),
        ...(this.options.claudeCodeExecutable
          ? { pathToClaudeCodeExecutable: this.options.claudeCodeExecutable }
          : {})
      };

      const sdkQuery = query({ prompt: input, options: queryOptions });
      run.query = sdkQuery;
      lastActivityAt = Date.now();
      idleWatchdog = setInterval(() => {
        if (Date.now() - lastActivityAt <= this.options.turnIdleTimeoutMs) return;
        idleTimedOut = true;
        abortController.abort();
        // 먹통 상태에선 abort만으로 hang된 for-await가 안 풀릴 수 있으므로
        // 서브프로세스/MCP transport를 강제 종료한다.
        run.query?.close();
      }, Math.min(30_000, this.options.turnIdleTimeoutMs));
      for await (const message of sdkQuery) {
        lastActivityAt = Date.now();
        const completedStreamText = streamingText.accept(message);
        if (completedStreamText) {
          streamedAssistantTexts.push(completedStreamText);
          if (!isRateLimitError(completedStreamText) && !isOverloadedError(completedStreamText)) {
            await renderer.text(completedStreamText);
            hasDeliveredAssistantText = true;
          }
        }
        if (message.type === "system" && message.subtype === "init") {
          sdkSessionId = message.session_id;
          this.store.updateSession(session.id, { sdkSessionId });
        }

        if (message.type === "rate_limit_event") {
          if (message.rate_limit_info.status === "rejected") {
            rateLimitRejected = true;
          }
          currentTokenUsage = mergeUsageSnapshots(
            currentTokenUsage,
            snapshotFromRateLimitInfo(message.rate_limit_info)
          );
          latestUsage = currentTokenUsage;
          this.store.updateSession(session.id, { usageSnapshot: latestUsage });
          renderer.usage(latestUsage);
          this.tokenPool.observe(oauthToken, currentTokenUsage);
        }

        if (message.type === "system" && message.subtype === "compact_boundary") {
          const before = message.compact_metadata.pre_tokens.toLocaleString("ko-KR");
          const after = message.compact_metadata.post_tokens?.toLocaleString("ko-KR");
          compactSummary = after
            ? `컨텍스트 압축 완료: ${before} → ${after} 토큰`
            : `컨텍스트 압축 완료: 압축 전 ${before} 토큰`;
        }

        if (
          message.type === "system"
          && message.subtype === "status"
          && message.compact_result === "failed"
        ) {
          throw new Error(message.compact_error || "컨텍스트 압축에 실패했습니다.");
        }

        for (const block of assistantBlocks(message)) {
          if (block.type === "tool_use" && typeof block.name === "string") {
            renderer.tool(
              block.name,
              block.input && typeof block.input === "object"
                ? block.input as Record<string, unknown>
                : {}
            );
          }
          if (block.type === "text" && typeof block.text === "string") {
            lastAssistantText = block.text.trim();
            const streamedIndex = streamedAssistantTexts.indexOf(lastAssistantText);
            if (streamedIndex >= 0) {
              streamedAssistantTexts.splice(streamedIndex, 1);
            } else if (
              !isRateLimitError(lastAssistantText)
              && !isOverloadedError(lastAssistantText)
            ) {
              await renderer.text(block.text);
              hasDeliveredAssistantText = true;
            }
          }
        }

        if (message.type === "result") {
          sdkSessionId = message.session_id;
          const serverUsage = await readUsageSnapshot(sdkQuery);
          if (serverUsage) {
            currentTokenUsage = serverUsage;
            latestUsage = serverUsage;
            renderer.usage(serverUsage);
          }
          this.tokenPool.observe(oauthToken, currentTokenUsage);
          const failureText = resultFailureText(message, rateLimitRejected);
          if (failureText) {
            throw new Error(failureText);
          }
          run.pendingTurns = Math.max(0, run.pendingTurns - 1);
          finalStatus = message.subtype === "success" ? "done" : "error";
          this.store.updateSession(session.id, {
            sdkSessionId,
            usageSnapshot: latestUsage,
            status: run.pendingTurns === 0 ? finalStatus : "running"
          });
          if (run.pendingTurns === 0) {
            input.close();
            await renderer.finish(
              finalStatus,
              request.operation === "compact" && compactSummary
                ? compactSummary
                : resultSummary(message, hasDeliveredAssistantText)
            );
            // 스트리밍 입력 모드의 Query는 다음 사용자 턴을 받기 위해 result 뒤에도
            // 열린 채로 있을 수 있다. 이 호스트는 후속 입력을 pendingTurns로 이미
            // 추적하므로 마지막 턴이면 즉시 루프를 끝내고 finally에서 Query를 닫는다.
            break;
          } else {
            renderer.note(`예약 메시지 ${run.pendingTurns}개 처리 대기`);
          }
        }
      }

      // close()로 스트림이 throw가 아니라 정상 return으로 끝날 수도 있으므로,
      // 중단/유휴로 끝난 경우 아래 정상완료 처리 대신 catch의 통합 분기로 보낸다.
      if (idleTimedOut || abortController.signal.aborted) {
        throw new Error("turn aborted");
      }

      if (sdkSessionId) {
        await renameSession(sdkSessionId, session.title, { dir: session.cwd }).catch(() => undefined);
      }
      const current = this.store.getSession(session.id);
      if (current?.status === "running") {
        this.store.updateSession(session.id, { status: finalStatus });
        await renderer.finish(finalStatus, compactSummary);
      }
      await this.safeRename(
        session,
        `${finalStatus === "done" ? "[DONE]" : "[ERROR]"} ${session.title}`
      );
      // 턴이 정상 완료됐으면 활성 목표 충족 여부를 평가하고, 미충족이면 다음 턴을 자동 예약한다.
      if (finalStatus === "done") {
        await this.maybeContinueGoal(session, request, sdkSessionId);
      }
    } catch (error) {
      if (this.deleting.has(session.id) || !this.store.getSession(session.id)) return;
      console.error(
        `Claude run failed (session=${session.id}, token=#${tokenIndex + 1}):`,
        safeErrorMessage(error, this.oauthTokens)
      );
      if (idleTimedOut) {
        const minutes = Math.round(this.options.turnIdleTimeoutMs / 60_000);
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish(
          "error",
          `${minutes}분간 어떤 진행도 없어 작업을 중단했습니다. `
          + `MCP 서버 또는 SDK가 응답하지 않는(먹통) 상태일 수 있습니다.`
        );
        await this.safeRename(session, `[STALL] ${session.title}`);
      } else if (abortController.signal.aborted) {
        this.store.updateSession(session.id, { status: "aborted" });
        await renderer.finish("aborted", "사용자가 작업을 중단했습니다.");
        await this.safeRename(session, `[STOP] ${session.title}`);
      } else if (isRateLimitError(error)) {
        // 한도 오류로 끝난 토큰을 봉인하고, 살아있는 다른 토큰이 있으면 같은 작업을
        // 그 토큰으로 즉시 자동 재실행한다. 사용자가 "계속" 같은 추가 입력을 보낼 필요가 없다.
        const limitSnapshot = snapshotFromRateLimitError(error);
        const resetsAt = limitSnapshot?.fiveHour?.resetsAt;
        this.tokenPool.noteRateLimited(
          oauthToken,
          Date.now(),
          resetsAt ? Date.parse(resetsAt) : undefined
        );
        const attempts = (request.autoSwitchCount ?? 0) + 1;
        const nextToken = this.tokenPool.select();
        const canAutoSwitch =
          this.tokenPool.size > 1
          && attempts < this.tokenPool.size
          && !this.tokenPool.isExhausted(nextToken);
        if (canAutoSwitch) {
          const nextIndex = this.tokenPool.indexOf(nextToken);
          await this.transport.sendText(
            session.chatId,
            session.topicId,
            `토큰 #${tokenIndex + 1} 한도 도달 → 계정 토큰 #${nextIndex + 1}로 자동 전환해 이어서 실행합니다.`
          ).catch(() => undefined);
          await this.safeRename(session, `[SWITCH] ${session.title}`);
          // 같은 프로젝트 큐의 맨 뒤에 재투입한다. 현재 실행의 finally가 active/렌더러를
          // 정리한 뒤 살아있는 토큰으로 다시 실행된다. resume으로 대화 맥락을 잇는다.
          const resumeId = sdkSessionId ?? request.resumeSessionId;
          this.enqueue({
            ...request,
            ...(resumeId ? { resumeSessionId: resumeId } : {}),
            autoSwitchCount: attempts
          });
          return;
        }
        // 전환할 살아있는 토큰이 없다. 에러로 끝내는 대신, 가장 먼저 회복되는 한도
        // 시각에 맞춰 같은 작업을 자동으로 이어서 실행하도록 예약한다.
        const resumeAt = this.tokenPool.recoversAt();
        if (resumeAt !== null) {
          if (this.tokenPool.size > 1) {
            renderer.note("모든 계정 토큰이 한도에 도달했습니다. 회복 시각에 자동 재개를 예약합니다.");
          }
          this.scheduleLimitResume(session, request, sdkSessionId, resumeAt);
          return;
        }
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", String(error));
        await this.safeRename(session, `[ERROR] ${session.title}`);
      } else if (isOverloadedError(error)) {
        // 일시적 서버 과부하/장애. 토큰을 봉인하지 않고 지수 백오프 후 같은 작업을
        // 자동 재시도한다. 사용자가 직접 "계속"을 보낼 필요가 없다.
        const attempt = (request.retryCount ?? 0) + 1;
        if (attempt <= MAX_OVERLOAD_RETRIES) {
          const delayMs = Math.min(
            OVERLOAD_RETRY_BASE_MS * 2 ** (attempt - 1),
            OVERLOAD_RETRY_CAP_MS
          );
          const seconds = Math.round(delayMs / 1000);
          await this.transport.sendText(
            session.chatId,
            session.topicId,
            `서버 과부하(Overloaded)로 일시 중단 → ${seconds}초 후 자동 재시도합니다. (${attempt}/${MAX_OVERLOAD_RETRIES})`
          ).catch(() => undefined);
          await this.safeRename(session, `[RETRY] ${session.title}`);
          const resumeId = sdkSessionId ?? request.resumeSessionId;
          const retryRequest: RunRequest = {
            ...request,
            ...(resumeId ? { resumeSessionId: resumeId } : {}),
            retryCount: attempt
          };
          setTimeout(() => {
            if (this.deleting.has(session.id)) return;
            this.enqueue(retryRequest);
          }, delayMs).unref();
          return;
        }
        renderer.note(`과부하가 ${MAX_OVERLOAD_RETRIES}회 재시도 후에도 풀리지 않았습니다.`);
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", String(error));
        await this.safeRename(session, `[ERROR] ${session.title}`);
      } else {
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", String(error));
        await this.safeRename(session, `[ERROR] ${session.title}`);
      }
    } finally {
      renderer.dispose();
      input.close();
      if (idleWatchdog) clearInterval(idleWatchdog);
      for (const timer of run.codexTimers.values()) clearInterval(timer);
      run.query?.close();
      this.active.delete(session.id);
    }
  }

  // Codex 제공사 세션의 한 작업(여러 턴)을 실행한다. Claude의 execute()에 대응하며, Codex
  // SDK 스레드로 턴을 돌린다. 웹검색은 항상 켜고 샌드박스는 full-access, 승인은 비대화(never)다.
  // steer/next로 큐에 쌓인 메시지는 같은 스레드에서 이어지는 턴으로 처리한다.
  private async executeCodex(request: RunRequest): Promise<void> {
    if (this.deleting.has(request.session.id)) return;
    let session = this.store.getSession(request.session.id);
    if (!session) return;
    request = this.applyHandoffSummary(request, session);
    session = this.store.getSession(request.session.id) ?? session;

    const renderer = new StreamRenderer(session, this.transport, this.options.debounceMs);
    const controller = new AbortController();
    const input = new MessageQueue();
    input.push(buildUserMessage(request.prompt));
    const run: ActiveRun = {
      controller,
      input,
      pendingTurns: 1,
      startedAt: Date.now(),
      codexTimers: new Map(),
      codexStarts: new Map(),
      mcpFailures: new Map()
    };
    this.active.set(session.id, run);

    let timedOut = false;
    let turnTimeout: NodeJS.Timeout | undefined;
    let lastResponse = "";
    let codexThreadId = session.codexThreadId;

    try {
      await this.safeRename(session, `[RUNNING] ${session.title}`);
      await renderer.start(false);
      this.store.updateSession(session.id, { status: "running" });

      requireCodexSubscriptionAuth();
      const codexModel = session.codexModel ?? DEFAULT_CODEX_MODEL;
      const codexReasoning =
        (session.codexReasoning as CodexReasoningEffort | null) ?? DEFAULT_CODEX_REASONING;
      const threadOptions = {
        model: codexModel,
        modelReasoningEffort: codexReasoning,
        workingDirectory: session.cwd,
        skipGitRepoCheck: true,
        sandboxMode: "danger-full-access" as const,
        approvalPolicy: "never" as const,
        webSearchEnabled: true
      };
      const codex = new Codex({ env: buildCodexEnvironment() });
      const thread = codexThreadId
        ? codex.resumeThread(codexThreadId, threadOptions)
        : codex.startThread(threadOptions);
      renderer.note(
        `Codex 실행 (${codexModelLabel(this.options.modelCatalog, codexModel)} · reasoning ${codexReasoningLabel(codexReasoning)})`
      );

      // Claude는 시스템 프롬프트로 장기기억 위치를 받지만 Codex 턴에는 그게 없다. 첫 턴에
      // 장기기억 경로를 알려 스레드 맥락에 남기면 이후 턴에서도 알아서 참고한다. 기록은
      // /memory(buildMemoryPrompt)로 명시 승인할 때만 한다.
      const memoryNote =
        `장기기억은 ${this.options.claudeMemoryDir} 에 있다. 작업과 관련 있으면 `
        + `${this.options.claudeMemoryDir}/MEMORY.md와 관련 파일을 먼저 읽고 활용하라. `
        + `메모리 기록은 사용자가 /memory로 명시 승인할 때만 한다.`;
      const iterator = input[Symbol.asyncIterator]();
      // 초기 메시지는 위에서 push했으므로 큐에서 꺼내 첫 턴으로 쓴다. 이후 steer/next로
      // 쌓인 메시지는 pendingTurns>0인 동안 같은 스레드에서 이어지는 턴으로 소비한다.
      let pending = await iterator.next();
      let firstTurn = true;
      while (!pending.done) {
        const content = pending.value.message.content;
        const turnPrompt = typeof content === "string" ? content : request.prompt;
        const memoryPrefix = firstTurn ? `${memoryNote}\n\n` : "";
        const leanPrefix = session.leanMode ? `${buildLeanInstructions(true)}\n\n` : "";
        run.codexStarts.set("codex", Date.now());
        if (turnTimeout) clearTimeout(turnTimeout);
        turnTimeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.options.codexMcpTimeoutMs);

        let attemptResponse = "";
        let completed = false;
        try {
          const streamed = await thread.runStreamed(`${memoryPrefix}${leanPrefix}${turnPrompt}`, {
            signal: controller.signal
          });
          for await (const event of streamed.events) {
            if (event.type === "item.completed") {
              if (event.item.type === "agent_message") attemptResponse = event.item.text;
              const progress = codexProgress(event.item);
              if (progress) renderer.note(progress);
            } else if (event.type === "item.updated") {
              // 답변 본문이 자라는 동안 상태 메시지에 미리보기로 흘려보낸다.
              if (event.item.type === "agent_message") renderer.partial(event.item.text);
            } else if (event.type === "turn.completed") {
              completed = true;
            } else if (event.type === "turn.failed") {
              throw new Error(`Codex 실행 실패: ${event.error.message}`);
            } else if (event.type === "error") {
              throw new Error(`Codex 스트림 오류: ${event.message}`);
            }
          }
        } finally {
          run.codexStarts.delete("codex");
          if (turnTimeout) clearTimeout(turnTimeout);
        }
        if (timedOut || controller.signal.aborted) throw new Error("turn aborted");
        if (!completed) throw new Error("Codex 실행이 완료 이벤트 없이 종료되었습니다.");

        if (thread.id && thread.id !== codexThreadId) {
          codexThreadId = thread.id;
          this.store.updateSession(session.id, { codexThreadId });
        }
        lastResponse = attemptResponse || lastResponse;
        if (attemptResponse) await renderer.text(attemptResponse);
        firstTurn = false;

        run.pendingTurns = Math.max(0, run.pendingTurns - 1);
        if (run.pendingTurns === 0) break;
        renderer.note(`예약 메시지 ${run.pendingTurns}개 처리 대기`);
        pending = await iterator.next();
      }

      this.store.updateSession(session.id, { status: "done" });
      await renderer.finish("done", lastResponse ? "" : "Codex가 텍스트 응답 없이 작업을 마쳤습니다.");
      await this.safeRename(session, `[DONE] ${session.title}`);
      // 활성 목표가 있으면 충족 여부를 읽기 전용 Haiku로 평가하고, 미충족이면 다음 턴을 자동 예약한다.
      // codex는 Claude 재개 핸들이 없으므로 sdkSessionId=null로 넘긴다(executeCodex가 스레드를 재개).
      await this.maybeContinueGoal(session, request, null);
    } catch (error) {
      if (this.deleting.has(session.id) || !this.store.getSession(session.id)) return;
      console.error(
        `Codex run failed (session=${session.id}):`,
        safeErrorMessage(error, this.oauthTokens)
      );
      if (timedOut) {
        const minutes = Math.round(this.options.codexMcpTimeoutMs / 60_000);
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", `Codex 턴이 ${minutes}분 제한을 초과해 중단되었습니다.`);
        await this.safeRename(session, `[STALL] ${session.title}`);
      } else if (controller.signal.aborted) {
        this.store.updateSession(session.id, { status: "aborted" });
        await renderer.finish("aborted", "사용자가 작업을 중단했습니다.");
        await this.safeRename(session, `[STOP] ${session.title}`);
      } else {
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", `Codex 실행 실패: ${safeErrorMessage(error)}`);
        await this.safeRename(session, `[ERROR] ${session.title}`);
      }
    } finally {
      if (turnTimeout) clearTimeout(turnTimeout);
      renderer.dispose();
      input.close();
      this.active.delete(session.id);
    }
  }

  private agyBinary(): string {
    return this.options.agyExecutable ?? "agy";
  }

  private agyConversationsDir(): string {
    return join(homedir(), ".gemini", "antigravity-cli", "conversations");
  }

  // 현재 존재하는 agy 대화 id 집합(파일명에서 .db 제거). 디렉터리가 없으면 빈 집합.
  private listAgyConversationIds(): Set<string> {
    try {
      return new Set(
        readdirSync(this.agyConversationsDir())
          .filter((name) => name.endsWith(".db"))
          .map((name) => name.slice(0, -3))
      );
    } catch {
      return new Set();
    }
  }

  // 첫 턴 실행 전후 대화 파일 차집합으로 새 대화 id를 잡는다. agy가 id를 지정하게 두지 않아
  // 직접 잡아야 한다. 동시 생성이 겹치면 가장 최근 mtime을 고른다.
  private captureNewAgyConversationId(before: Set<string>): string | null {
    const dir = this.agyConversationsDir();
    let ids: string[];
    try {
      ids = readdirSync(dir).filter((name) => name.endsWith(".db")).map((name) => name.slice(0, -3));
    } catch {
      return null;
    }
    let newest: { id: string; mtimeMs: number } | null = null;
    for (const id of ids) {
      if (before.has(id)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(dir, `${id}.db`)).mtimeMs;
      } catch {
        continue;
      }
      if (!newest || mtimeMs > newest.mtimeMs) newest = { id, mtimeMs };
    }
    return newest?.id ?? null;
  }

  // agy stdout 선두의 "Warning: conversation ... not found." 한 줄을 제거한다.
  private stripAgyWarning(text: string): string {
    return text.replace(/^Warning: conversation .*not found\.\s*\n?/, "");
  }

  // agy를 한 번 실행한다. signal로 중단하면 SIGTERM 후 잠시 뒤 SIGKILL.
  private runAgy(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    onProgress?: (stdoutSoFar: string) => void
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      // stdin을 ignore(=/dev/null)로 줘야 한다. 안 그러면 agy가 stdin EOF를 기다리며 멈춘다.
      const child = spawn(this.agyBinary(), args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let killTimer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
        killTimer.unref();
      };
      const cleanup = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
        if (killTimer) clearTimeout(killTimer);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (onProgress) onProgress(stdout);
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", (error) => {
        cleanup();
        reject(error);
      });
      child.on("close", (code) => {
        cleanup();
        resolve({ stdout, stderr, code });
      });
    });
  }

  private async executeAgy(request: RunRequest): Promise<void> {
    if (this.deleting.has(request.session.id)) return;
    let session = this.store.getSession(request.session.id);
    if (!session) return;
    request = this.applyHandoffSummary(request, session);
    session = this.store.getSession(request.session.id) ?? session;

    const renderer = new StreamRenderer(session, this.transport, this.options.debounceMs);
    const controller = new AbortController();
    const input = new MessageQueue();
    input.push(buildUserMessage(request.prompt));
    const run: ActiveRun = {
      controller,
      input,
      pendingTurns: 1,
      startedAt: Date.now(),
      codexTimers: new Map(),
      codexStarts: new Map(),
      mcpFailures: new Map()
    };
    this.active.set(session.id, run);

    let timedOut = false;
    let turnTimeout: NodeJS.Timeout | undefined;
    let lastResponse = "";
    let agyConversationId = session.agyConversationId;

    try {
      await this.safeRename(session, `[RUNNING] ${session.title}`);
      await renderer.start(false);
      this.store.updateSession(session.id, { status: "running" });

      const agyModel = session.agyModel ?? DEFAULT_AGY_MODEL;
      // 병합 커넥터(claude.json + codex config)를 agy가 네이티브로 읽는 mcp_config.json에 동기화한다.
      // 스킬·플러그인은 agy가 ~/.gemini/config 아래에서 네이티브로 읽으므로 별도 작업이 없다.
      let agyConnectorCount = 0;
      try {
        const sync = syncAgyMcpConfig(loadMergedConnectors());
        agyConnectorCount = sync.count;
      } catch (error) {
        console.error(
          `agy MCP 동기화 실패 (session=${session.id}):`,
          safeErrorMessage(error)
        );
      }
      renderer.note(
        `agy 실행 (${agyModelLabel(this.options.modelCatalog, agyModel)})`
        + ` · 커넥터 ${agyConnectorCount}개 동기화(~/.gemini/config/mcp_config.json)`
      );

      // agy 턴에는 시스템 프롬프트가 없으므로 첫 턴에 장기기억 위치를 프롬프트로 알린다(Codex와 동일).
      const memoryNote =
        `장기기억은 ${this.options.claudeMemoryDir} 에 있다. 작업과 관련 있으면 `
        + `${this.options.claudeMemoryDir}/MEMORY.md와 관련 파일을 먼저 읽고 활용하라. `
        + `메모리 기록은 사용자가 /memory로 명시 승인할 때만 한다.`;
      const iterator = input[Symbol.asyncIterator]();
      let pending = await iterator.next();
      let firstTurn = true;
      while (!pending.done) {
        const content = pending.value.message.content;
        const turnPrompt = typeof content === "string" ? content : request.prompt;
        const memoryPrefix = firstTurn ? `${memoryNote}\n\n` : "";
        const leanPrefix = session.leanMode ? `${buildLeanInstructions(true)}\n\n` : "";
        const finalPrompt = `${memoryPrefix}${leanPrefix}${turnPrompt}`;

        if (turnTimeout) clearTimeout(turnTimeout);
        turnTimeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.options.codexMcpTimeoutMs);

        // agy --print-timeout 기본값은 5분이라, 이를 넘기면 우리 턴 타임아웃(기본 30분)이
        // 작동하기 전에 agy가 스스로 print 대기를 끊는다. 우리 타임아웃보다 넉넉히 크게 줘서
        // 종료 판정·메시지를 우리 쪽(turnTimeout)이 일관되게 담당하도록 한다.
        const printTimeoutArg = `${Math.ceil(this.options.codexMcpTimeoutMs / 1000) + 60}s`;
        const args = [
          "--print", finalPrompt,
          "--dangerously-skip-permissions",
          "--model", agyModel,
          "--print-timeout", printTimeoutArg
        ];
        if (agyConversationId) args.push("--conversation", agyConversationId);

        // 첫 턴(대화 id 미보유)에는 새로 생기는 대화 id를 잡기 위해 실행 전 목록을 스냅샷한다.
        const before = agyConversationId ? null : this.listAgyConversationIds();
        let result!: { stdout: string; stderr: string; code: number | null };
        try {
          result = await this.runAgy(args, session.cwd, controller.signal, (soFar) => {
            // agy --print stdout이 토막으로 도착하면 경고 배너를 제거한 본문을 미리보기로 흘려보낸다.
            renderer.partial(this.stripAgyWarning(soFar));
          });
        } finally {
          if (turnTimeout) clearTimeout(turnTimeout);
        }
        if (timedOut || controller.signal.aborted) throw new Error("turn aborted");
        if (result.code !== 0) {
          const detail = this.stripAgyWarning(result.stderr || result.stdout).trim();
          throw new Error(`agy 실행 실패 (코드 ${result.code}): ${detail.slice(0, 500)}`);
        }

        if (before) {
          const newId = this.captureNewAgyConversationId(before);
          if (newId && newId !== agyConversationId) {
            agyConversationId = newId;
            this.store.updateSession(session.id, { agyConversationId });
          }
        }

        const attemptResponse = this.stripAgyWarning(result.stdout).trim();
        lastResponse = attemptResponse || lastResponse;
        if (attemptResponse) await renderer.text(attemptResponse);
        firstTurn = false;

        run.pendingTurns = Math.max(0, run.pendingTurns - 1);
        if (run.pendingTurns === 0) break;
        renderer.note(`예약 메시지 ${run.pendingTurns}개 처리 대기`);
        pending = await iterator.next();
      }

      this.store.updateSession(session.id, { status: "done" });
      await renderer.finish("done", lastResponse ? "" : "agy가 텍스트 응답 없이 작업을 마쳤습니다.");
      await this.safeRename(session, `[DONE] ${session.title}`);
      // 활성 목표가 있으면 충족 여부를 읽기 전용 Haiku로 평가하고, 미충족이면 다음 턴을 자동 예약한다.
      // agy는 Claude 재개 핸들이 없으므로 sdkSessionId=null로 넘긴다(executeAgy가 대화를 재개).
      await this.maybeContinueGoal(session, request, null);
    } catch (error) {
      if (this.deleting.has(session.id) || !this.store.getSession(session.id)) return;
      console.error(
        `agy run failed (session=${session.id}):`,
        safeErrorMessage(error, this.oauthTokens)
      );
      if (timedOut) {
        const minutes = Math.round(this.options.codexMcpTimeoutMs / 60_000);
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", `agy 턴이 ${minutes}분 제한을 초과해 중단되었습니다.`);
        await this.safeRename(session, `[STALL] ${session.title}`);
      } else if (controller.signal.aborted) {
        this.store.updateSession(session.id, { status: "aborted" });
        await renderer.finish("aborted", "사용자가 작업을 중단했습니다.");
        await this.safeRename(session, `[STOP] ${session.title}`);
      } else {
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", `agy 실행 실패: ${safeErrorMessage(error)}`);
        await this.safeRename(session, `[ERROR] ${session.title}`);
      }
    } finally {
      if (turnTimeout) clearTimeout(turnTimeout);
      renderer.dispose();
      input.close();
      this.active.delete(session.id);
    }
  }

  /**
   * 모든 토큰 한도로 목표 충족 여부를 아직 평가하지 못했을 때, 회복 시각에 다시 평가·진행하도록
   * 예약한다. 작업 턴의 scheduleLimitResume과 같은 limitWaiters를 쓰므로, 회복 전에 사용자가
   * 새 지시를 보내거나 /stop을 누르면 예약이 취소된다. 데몬 재시작 시에는 interrupted로 복구된다.
   */
  private scheduleGoalRecheck(
    session: SessionRecord,
    request: RunRequest,
    sdkSessionId: string | null,
    resumeAt: number
  ): void {
    const delayMs = Math.max(0, resumeAt - Date.now()) + LIMIT_RESUME_BUFFER_MS;
    const when = new Date(resumeAt + LIMIT_RESUME_BUFFER_MS).toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul"
    });
    this.store.updateSession(session.id, { status: "waiting_limit" });
    void this.transport.sendText(
      session.chatId,
      session.topicId,
      `${this.tokenPool.size > 1 ? "모든 계정 토큰이" : "토큰이"} 한도에 도달해 목표 달성 여부를 `
      + `아직 확인하지 못했습니다. ${when}에 회복되면 자동으로 다시 평가하고 목표 진행을 이어 갑니다.`
    ).catch(() => undefined);
    void this.safeRename(session, `[WAIT] ${session.title}`);
    this.cancelLimitWaiter(session.id);
    const timer = setTimeout(() => {
      this.limitWaiters.delete(session.id);
      if (this.deleting.has(session.id) || !this.store.getSession(session.id)) return;
      if (this.active.has(session.id)) return;
      void this.maybeContinueGoal(session, request, sdkSessionId);
    }, delayMs);
    timer.unref();
    this.limitWaiters.set(session.id, timer);
  }

  /**
   * 한 턴이 정상 종료된 직후 호출한다. 활성 목표가 있으면 빠른 모델로 충족 여부를 판정하고,
   * 미충족이면(상한 안에서) 같은 목표를 향한 다음 턴을 자동으로 큐에 넣는다. 이 후속 턴도
   * 일반 execute 경로를 타므로 토큰 자동 전환·waiting_limit 대기가 그대로 적용된다.
   */
  private async maybeContinueGoal(
    session: SessionRecord,
    request: RunRequest,
    sdkSessionId: string | null
  ): Promise<void> {
    const condition = this.store.getSession(session.id)?.goalCondition;
    if (!condition || this.deleting.has(session.id)) return;

    // 모든 토큰이 한도면 충족 여부 평가 자체가 불가능하다. 멈추지 말고 가장 먼저 회복되는
    // 시각에 다시 평가하도록 예약한다(작업 턴의 waiting_limit과 같은 방식).
    const recoversAt = this.tokenPool.recoversAt();
    if (recoversAt !== null) {
      this.scheduleGoalRecheck(session, request, sdkSessionId, recoversAt);
      return;
    }

    let verdict: { met: boolean; reason: string };
    try {
      verdict = await this.evaluateGoal(session, condition);
    } catch (error) {
      // 평가 도중 모든 토큰이 한도에 닿았으면 회복 시각에 다시 평가한다.
      if (isRateLimitError(error)) {
        const at = this.tokenPool.recoversAt();
        if (at !== null) {
          this.scheduleGoalRecheck(session, request, sdkSessionId, at);
          return;
        }
      }
      await this.transport.sendText(
        session.chatId,
        session.topicId,
        `목표 달성 여부를 평가하지 못해 자동 진행을 멈췄습니다: ${safeErrorMessage(error)}\n`
        + "새 지시를 보내면 다시 평가하고, /goal clear 로 목표를 해제할 수 있습니다."
      ).catch(() => undefined);
      return;
    }

    if (verdict.met) {
      this.goalRounds.delete(session.id);
      this.store.updateSession(session.id, { goalCondition: null });
      await this.transport.sendText(
        session.chatId,
        session.topicId,
        `목표를 달성했습니다 ✅\n조건: ${condition}\n근거: ${verdict.reason}`
      ).catch(() => undefined);
      return;
    }

    const rounds = this.goalRounds.get(session.id) ?? 0;
    if (rounds + 1 >= MAX_GOAL_ROUNDS) {
      this.goalRounds.delete(session.id);
      this.store.updateSession(session.id, { goalCondition: null });
      await this.transport.sendText(
        session.chatId,
        session.topicId,
        `목표 자동 진행을 ${MAX_GOAL_ROUNDS}턴 후 중단합니다(아직 미달성).\n조건: ${condition}\n`
        + `마지막 평가: ${verdict.reason}\n계속하려면 새 지시를 보내거나 /goal 로 다시 설정하세요.`
      ).catch(() => undefined);
      return;
    }

    this.goalRounds.set(session.id, rounds + 1);
    await this.transport.sendText(
      session.chatId,
      session.topicId,
      `목표 미달성 → 자동으로 다음 턴을 진행합니다 (${rounds + 1}/${MAX_GOAL_ROUNDS}).\n남은 점: ${verdict.reason}`
    ).catch(() => undefined);
    const resumeId = sdkSessionId ?? request.resumeSessionId;
    this.store.updateSession(session.id, { status: "queued" });
    this.enqueue({
      session: this.store.getSession(session.id) ?? session,
      prompt: buildGoalPrompt(condition, verdict.reason),
      ...(resumeId ? { resumeSessionId: resumeId } : {})
    });
  }

  /** 목표 충족 여부를 빠른 모델(Haiku)로 읽기 전용 판정한다. 살아있는 토큰을 새로 고른다. */
  private async evaluateGoal(
    session: SessionRecord,
    condition: string
  ): Promise<{ met: boolean; reason: string }> {
    const controller = new AbortController();
    const run: ActiveRun = {
      controller,
      input: new MessageQueue(),
      pendingTurns: 1,
      startedAt: Date.now(),
      codexTimers: new Map(),
      codexStarts: new Map(),
      mcpFailures: new Map()
    };
    const text = await this.runReadOnlyClaude(
      session,
      controller,
      run,
      buildGoalCheckPrompt(condition),
      this.tokenPool.select(),
      false,
      GOAL_EVAL_MODEL
    );
    const line = text
      .split("\n")
      .map((part) => part.trim())
      .reverse()
      .find((part) => /^GOAL_(MET|UNMET)/i.test(part)) ?? text.trim();
    if (/^GOAL_MET/i.test(line)) {
      return { met: true, reason: line.replace(/^GOAL_MET:?\s*/i, "").trim() || "조건 충족" };
    }
    return {
      met: false,
      reason: line.replace(/^GOAL_UNMET:?\s*/i, "").trim() || text.trim().slice(0, 200)
    };
  }

  private async runReadOnlyClaude(
    session: SessionRecord,
    controller: AbortController,
    run: ActiveRun,
    prompt: string,
    oauthToken: string,
    allowQuestions = false,
    modelOverride?: string
  ): Promise<string> {
    const instructions = loadProjectInstructions(session.cwd);
    const claudeModel = modelOverride ?? session.model ?? DEFAULT_CLAUDE_MODEL;
    const thinking = normalizeThinkingForModel(
      this.options.modelCatalog,
      claudeModel,
      session.thinking
    );
    const effort = resolveClaudeEffort(session.claudeEffort);
    const sdkQuery = query({
      prompt,
      options: {
        cwd: session.cwd,
        abortController: controller,
        model: claudeModel,
        thinking: resolveThinkingConfig(thinking),
        ...(effort ? { effort } : {}),
        // plan 모드는 모델이 도구를 쓰려 하면 turn을 즉시 종료해 AskUserQuestion의 답을
        // 기다리지 못한다. 대화가 필요한 계획 단계에서는 default 모드로 돌려 질문이 실제로
        // 사용자 응답을 기다리게 한다. 편집은 read-only allowedTools로 여전히 차단된다.
        permissionMode: allowQuestions ? "default" : "plan",
        allowedTools: ["Read", "Glob", "Grep", "WebSearch"],
        settingSources: [],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...((instructions || session.leanMode)
            ? {
                append:
                  (session.leanMode ? `${buildLeanInstructions(true)}\n\n` : "")
                  + (instructions
                    ? "다음 프로젝트 지침을 따르되 파일을 수정하지 마세요. "
                      + "이 지침은 추가 도구 권한을 부여하지 않습니다.\n\n"
                      + instructions
                    : "")
              }
            : {})
        },
        env: buildClaudeEnvironment(
          oauthToken,
          process.env,
          this.options.mcpToolTimeoutMs
        ),
        // allowQuestions가 켜지면(계획 단계) AskUserQuestion이 permission broker를 거쳐
        // 텔레그램으로 전달되고 사용자의 답을 기다린다. Codex 실행은 여전히 비대화형이므로
        // 필요한 정보는 이 단계에서 모두 확보된다.
        ...(allowQuestions
          ? {
              includePartialMessages: true,
              canUseTool: async (toolName, toolInput, permissionOptions) =>
                this.permissions.request(
                  this.store.getSession(session.id) ?? session,
                  toolName,
                  toolInput,
                  permissionOptions
                )
            }
          : {}),
        ...(this.options.claudeCodeExecutable
          ? { pathToClaudeCodeExecutable: this.options.claudeCodeExecutable }
          : {})
      }
    });
    run.query = sdkQuery;
    let text = "";
    try {
      for await (const message of sdkQuery) {
        for (const block of assistantBlocks(message)) {
          if (block.type === "text" && typeof block.text === "string") {
            text = block.text.trim();
          }
        }
        if (message.type === "result") {
          if (message.subtype !== "success") {
            throw new Error(resultText(message) || "Claude 읽기 전용 단계가 실패했습니다.");
          }
          text = text || message.result.trim();
        }
      }
    } finally {
      sdkQuery.close();
      if (run.query === sdkQuery) delete run.query;
    }
    if (!text) throw new Error("Claude 읽기 전용 단계가 빈 응답을 반환했습니다.");
    return text;
  }

  private async safeRename(session: SessionRecord, title: string): Promise<void> {
    await this.transport.renameTopic(session.chatId, session.topicId, title).catch((error) => {
      console.error("Telegram topic rename failed:", safeErrorMessage(error));
    });
  }
}
