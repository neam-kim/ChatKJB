import {
  deleteSession as deleteClaudeSession,
  query
} from "@anthropic-ai/claude-agent-sdk";
import { Codex, type Usage as CodexSdkUsage } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAccountPool } from "./codex-account-pool.js";
import type { CodexGoalClient } from "./codex-app-server.js";
import { fetchCodexLiveUsage } from "./codex-live-usage.js";
import {
  loadClaudeConnectors
} from "./connectors.js";
import { seedClineConnection } from "./cline-sdk.js";
import { runGrokCli } from "./grok-cli.js";
import {
  buildJudgePrompt,
  buildPeerCritiquePrompt,
  buildRevisionPrompt,
  buildSynthesisPrompt,
  parseJudgeResponse,
  type JudgeCandidate,
  type JudgeVerdict,
  type SynthCritique
} from "./judge.js";
import { appLocale, appTimeZone } from "./localization.js";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING,
  DEFAULT_GROK_MODEL,
  DEFAULT_GROK_REASONING,
  latestClaudeFableModel,
  normalizeThinkingForModel,
  type CodexReasoningEffort
} from "./model-catalog.js";
import { PermissionBroker } from "./permission-broker.js";
import { MessageQueue } from "./session-collectors.js";
import {
  buildClaudeEnvironment,
  buildCodexEnvironment,
  requireCodexSubscriptionAuth
} from "./session-environment.js";
import {
  assistantBlocks,
  buildCodexSteeredPrompt,
  buildCompactCommand,
  buildGoalCommand,
  buildLeanInstructions,
  buildOrchestratedTurnPrompt,
  buildProviderBootstrap,
  buildRolloverSummaryPrompt,
  buildUserMessage,
  loadProjectInstructions,
  normalizeGoalCondition,
  resultText
} from "./session-prompts.js";
import {
  hasUsageWindows,
  isRateLimitError,
  readUsageSnapshot,
  snapshotFromRateLimitError,
  type TokenUsageLookupResult,
  type UsageLookupResult
} from "./session-usage.js";
import {
  limitResumeRequest,
  resolveClaudeEffort,
  resolveThinkingConfig,
  type RunRequest
} from "./session/prompt-builders.js";
import type {
  ActiveRun,
  BaseExecutorHost,
  ExecutorOptions
} from "./session/executors/shared.js";
import {
  AgyExecutor,
  type AgyLiveStatusResult
} from "./session/executors/agy.js";
import { ClaudeExecutor } from "./session/executors/claude.js";
import {
  buildCodexThreadOptions,
  CodexExecutor,
  createCodexClient
} from "./session/executors/codex.js";
import { executeGrok as executeGrokProvider } from "./session/executors/grok.js";
import { ClineExecutor } from "./session/executors/cline.js";
import { isCodexUsageSnapshot } from "./session/provider-progress.js";
import { StateStore } from "./store.js";
import { safeErrorMessage } from "./telegram-transport.js";
import { TokenPool } from "./token-pool.js";
import type {
  CodexAccountUsageSnapshot,
  CodexLiveUsageSnapshot,
  CodexUsageSnapshot,
  MessageTransport,
  ProjectConfig,
  ProviderKind,
  SessionDefaults,
  SessionRecord,
  SessionStatus,
  UsageSnapshot
} from "./types.js";
// 한도/사용량 파서는 session-usage.ts로 이동했으나 기존 import 경로 호환을 위해 재export한다.
export {
  hasUsageWindows, isNoRolloutError,
  isOverloadedError,
  isRateLimitError,
  isTransientStreamError,
  parseResetTimestamp,
  readUsageSnapshot,
  snapshotFromRateLimitError, type TokenUsageLookupResult,
  type UsageLookupResult
} from "./session-usage.js";
// 프롬프트·지침 빌더는 session-prompts.ts로 이동했으나 기존 import 경로 호환을 위해 재export한다.
export {
  buildCodexSteeredPrompt, buildCompactCommand,
  buildGoalCommand, buildLeanInstructions, buildLimitResumePrompt, buildMemoryPrompt, buildOrchestratedTurnPrompt, buildOrchestrationBoundaryInstructions, buildPermissionModeInstructions, buildPublicProgressInstructions, buildRolloverSummaryPrompt, buildUserMessage, loadGlobalInstructions, loadProjectInstructions, normalizeGoalCondition, resultSummary
} from "./session-prompts.js";
// 실행 환경·권한 매핑 빌더는 session-environment.ts로 이동했으나 기존 import 경로 호환을 위해 재export한다.
export {
  agyPermissionArgs,
  buildClaudeEnvironment, buildCodexEnvironment, codexSandboxMode, codexSharedResourceConfig,
  ensureCodexMcpConfigForHome, requireCodexSubscriptionAuth
} from "./session-environment.js";
// 스트리밍 수집기·입력 큐는 session-collectors.ts로 이동했으나 기존 import 경로 호환을 위해 재export한다.
export {
  GrokProgressCollector, MessageQueue, ProgressiveParagraphCollector,
  StreamingTextCollector
} from "./session-collectors.js";
export {
  resolveClaudeEffort,
  resolveThinkingConfig
} from "./session/prompt-builders.js";
export {
  agyFailureFromLog,
  agyRequestsProceed,
  resultFailureText
} from "./session/provider-progress.js";
export type { AgyLiveStatusResult } from "./session/executors/agy.js";

// 모든 토큰이 한도에 도달했을 때, 가장 먼저 회복되는 시각 이후로 자동 재개를 미루는 여유분.

export { parseGrokTranscript } from "./session/executors/grok.js";
// 한도 초기화 직후의 미세한 시계 오차로 또 거부당하는 것을 막는다.
const LIMIT_RESUME_BUFFER_MS = 10_000;
const CODEX_LIVE_USAGE_FALLBACK_BACKOFF_MS = 60 * 60 * 1000;
// /synth 다중후보 판관은 시작 시 Claude SDK에서 만든 동적 모델 카탈로그의 최신 Fable을 쓴다.
// Fable 판관이 없거나 실패하면 다른 모델로 바꾸지 않고 첫 후보를 그대로 채택한다.
const SYNTH_JUDGE_CLAUDE_THINKING = "high";

const SYNTH_JUDGE_CLAUDE_EFFORT = "high";
// /synth는 인증된 제공자들을 동시에 띄운다. SDK/CLI 초기화(모듈 동적 import + 서브프로세스
// spawn)가 같은 순간에 겹치면 저수준 read 실패(errno 11)·fd 스파이크로 데몬이 내려간 정황이
// 있었다. 시작을 이 간격만큼 어긋나게 해 초기화 버스트를 분산한다. 정상 대기 구간은 여전히
// 병렬이므로 전체 지연은 (가장 느린 제공자 + 2×간격) 수준에 그친다.
const SYNTH_PROVIDER_STAGGER_MS = 400;
const CODEX_ACCOUNT_STATE_SETTING = "codex.accountState.v1";
const CLAUDE_TOKEN_STATE_SETTING = "claude.tokenState.v1";
export const CLAUDE_MODEL = DEFAULT_CLAUDE_MODEL;
export const CODEX_MODEL = DEFAULT_CODEX_MODEL;
export const CODEX_REASONING_EFFORT = DEFAULT_CODEX_REASONING;
export const CLAUDE_THINKING = { type: "adaptive" } as const;

interface PersistedCodexAccountState {
  version: 1;
  accounts: Array<{
    home: string;
    exhaustedUntil: number | null;
    latestUsage: CodexUsageSnapshot | null;
  }>;
}

// Claude 토큰 한도 상태를 SQLite에 영속화한다. OAuth 토큰 원문은 비밀이라 저장하지 않고,
// TokenPool이 만든 비가역 지문(fingerprint)으로만 슬롯을 식별·복원한다.
interface PersistedClaudeTokenState {
  version: 1;
  tokens: Array<{
    fingerprint: string;
    exhaustedUntil: number | null;
  }>;
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

export interface ResetContextResult {
  ok: boolean;
  reason?: string;
}

export type ClineSessionSelection = Pick<
  SessionRecord,
  "clineProviderId" | "clineModel" | "clineReasoning"
>;

export type InitialSessionPrompt = string | ((session: SessionRecord) => string);

export type GoalSetResult = "active" | "stored" | "native" | "unsupported";

export interface SynthesisResult {
  ok: boolean;
  reason?: string;
  // 최종 종합 답변(ok일 때).
  answer?: string;
  // 후보로 실제 응답한 provider들.
  candidates?: ProviderKind[];
  // 심사 결과(투명성). 단일 후보면 생략될 수 있다.
  verdict?: JudgeVerdict;
  // 종합자로 쓴 provider.
  synthesizedBy?: ProviderKind;
}

interface SilentReadOnlyOptions {
  claudeModelOverride?: string;
  claudeThinkingOverride?: string;
  claudeEffortOverride?: string;
  codexModelOverride?: string;
  codexReasoningOverride?: CodexReasoningEffort;
  timeoutMs?: number;
  toolFree?: boolean;
}

interface OneOffTaskOptions {
  provider: ProviderKind;
  defaults: SessionDefaults;
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  allowProviderFallback?: boolean;
}

export interface ReadOnlyTaskOptions {
  provider: ProviderKind;
  defaults: SessionDefaults;
  cwd: string;
  prompt: string;
  timeoutMs: number;
}

function isTerminalSessionStatus(status: SessionStatus): boolean {
  return status === "done"
    || status === "verification_failed"
    || status === "aborted"
    || status === "error"
    || status === "interrupted";
}

function parseFutureTime(value: string | null, now: number): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now ? parsed : null;
}

export function codexExhaustedUntilFromLiveUsage(
  snapshot: CodexLiveUsageSnapshot,
  now: number = Date.now()
): number | null {
  const primaryReset = parseFutureTime(snapshot.primary?.resetsAt ?? null, now);
  const secondaryReset = parseFutureTime(snapshot.secondary?.resetsAt ?? null, now);
  const primaryExhausted = (snapshot.primary?.usedPercent ?? 0) >= 100;
  const secondaryExhausted = (snapshot.secondary?.usedPercent ?? 0) >= 100;

  if (secondaryExhausted) {
    return secondaryReset ?? primaryReset ?? now + CODEX_LIVE_USAGE_FALLBACK_BACKOFF_MS;
  }

  if (primaryExhausted) {
    return primaryReset ?? now + CODEX_LIVE_USAGE_FALLBACK_BACKOFF_MS;
  }

  if (snapshot.rateLimitReachedType) {
    return primaryReset ?? secondaryReset ?? now + CODEX_LIVE_USAGE_FALLBACK_BACKOFF_MS;
  }

  return null;
}


export class SessionManager {
  private disposed = false;
  private readonly active = new Map<string, ActiveRun>();
  private readonly projectTails = new Map<string, Promise<void>>();
  private readonly queuedCounts = new Map<string, number>();
  private readonly sessionTasks = new Map<string, Promise<void>>();
  private readonly readOnlyTasks = new Set<Promise<string>>();
  private readonly silentControllers = new Set<AbortController>();
  private readonly deleting = new Set<string>();
  // 모든 토큰/계정 한도 도달로 멈춘 세션을 회복 시각에 자동 재개하기 위해 거는 타이머.
  private readonly limitWaiters = new Map<string, NodeJS.Timeout>();
  private readonly nativeGoalSynced = new Set<string>();
  private readonly nativeGoalClearPending = new Set<string>();
  private readonly agyExecutor: AgyExecutor;
  private readonly claudeExecutor: ClaudeExecutor;
  private readonly codexExecutor: CodexExecutor;
  private readonly clineExecutor: ClineExecutor;
  private readonly tokenPool: TokenPool;
  private readonly oauthTokens: string[];
  // Codex 다중 계정 풀(CODEX_HOME 디렉터리 기준, sticky 선택 + reactive 페일오버).
  private readonly codexAccountPool: CodexAccountPool;
  private readonly codexUsageByHome = new Map<string, CodexUsageSnapshot>();
  private readonly codexGoalClient: CodexGoalClient | undefined;

  constructor(
    private readonly store: StateStore,
    private readonly transport: MessageTransport,
    private readonly permissions: PermissionBroker,
    private readonly options: ExecutorOptions
  ) {
    this.oauthTokens = [
      options.claudeCodeOauthToken,
      ...(options.additionalOauthTokens ?? [])
    ].filter((token): token is string => typeof token === "string" && token.trim().length > 0);
    this.tokenPool = new TokenPool(this.oauthTokens, {
      // 소진 상태가 바뀔 때마다 SQLite에 영속화해 데몬 재시작 후에도 살아있는 토큰을 바로 고른다.
      onExhaustionChange: () => this.persistClaudeTokenState()
    });
    this.restoreClaudeTokenState();
    this.permissions.setProgressHook((sessionId, phase) => {
      const run = this.active.get(sessionId);
      if (!run) return;
      if (phase === "waiting") {
        run.progressNote?.("승인 대기 중 — 토픽에서 허용/거절");
      } else {
        run.progressNote?.("승인 응답 반영 — 작업 재개");
      }
      run.progressFlush?.();
    });
    this.claudeExecutor = new ClaudeExecutor({
      ...this.baseExecutorHost(),
      permissions: this.permissions,
      tokenPool: this.tokenPool,
      oauthTokens: this.oauthTokens,
      selectToken: (session, model) => this.selectClaudeToken(session, model),
      markRateLimited: (token, error) => this.markClaudeRateLimited(token, error),
      enqueue: (request) => this.enqueue(request),
      scheduleLimitResume: (session, request, resumeSessionId, resumeAt) => {
        this.scheduleLimitResume(session, request, resumeSessionId, resumeAt);
      },
      handleGoalCompletion: (session, request) => {
        this.handleClaudeGoalCompletion(session, request);
      }
    });
    // 계정 홈이 주어지지 않으면 기본 홈(CODEX_HOME 또는 ~/.codex) 1개로 단일 계정 동작.
    const codexHomes = options.codexAccountHomes && options.codexAccountHomes.length > 0
      ? options.codexAccountHomes
      : [process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")];
    this.codexAccountPool = new CodexAccountPool(codexHomes);
    this.codexGoalClient = options.codexGoalClient;
    this.restoreCodexAccountState();
    this.codexExecutor = new CodexExecutor({
      ...this.baseExecutorHost(),
      accountPool: this.codexAccountPool,
      oauthTokens: this.oauthTokens,
      goalClientAvailable: !!this.codexGoalClient,
      selectHome: (session, selectOptions) => this.selectCodexHome(session, selectOptions),
      recordUsage: (home, usage, model, reasoning) => {
        this.recordCodexUsage(home, usage, model, reasoning);
      },
      setNativeGoal: (session, condition) => this.setCodexNativeGoal(session, condition),
      clearGoal: (sessionId) => this.clearGoal(sessionId),
      markRateLimited: (home, error) => this.markCodexRateLimited(home, error),
      reconcileAccounts: (cwd, reconcileOptions) =>
        this.reconcileCodexAccountsFromLiveUsage(cwd, reconcileOptions),
      enqueue: (request) => this.enqueue(request),
      scheduleLimitResume: (session, request, resumeSessionId, resumeAt) => {
        this.scheduleLimitResume(session, request, resumeSessionId, resumeAt);
      }
    });
    this.agyExecutor = new AgyExecutor(this.baseExecutorHost());
    this.clineExecutor = new ClineExecutor({
      ...this.baseExecutorHost(),
      permissions: this.permissions
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.limitWaiters.values()) clearTimeout(timer);
    this.limitWaiters.clear();
    for (const controller of this.silentControllers) controller.abort();
    this.claudeExecutor.dispose();
    for (const run of this.active.values()) {
      // 정상 데몬 재시작은 사용자 /stop이 아니다. 실행기 error handler가 이 abort를
      // aborted로 저장하면 새 프로세스의 interruptIncompleteSessions()가 재개할 작업을
      // 찾지 못하므로, 서비스 종료 신호임을 먼저 표시하고 running 상태를 보존한다.
      if (!run.stopRequested) run.serviceShutdownRequested = true;
      run.controller.abort();
      run.input.cancel();
      run.query?.close();
      for (const timer of run.codexTimers.values()) clearInterval(timer);
    }
    this.agyExecutor.dispose();
    const tasks = [...new Set([
      ...this.sessionTasks.values(),
      ...this.projectTails.values(),
      ...this.readOnlyTasks.values()
    ])];
    await Promise.allSettled(tasks);
    await this.clineExecutor.dispose();
    this.active.clear();
    this.projectTails.clear();
    this.queuedCounts.clear();
    this.sessionTasks.clear();
    this.readOnlyTasks.clear();
    this.silentControllers.clear();
    this.deleting.clear();
    this.nativeGoalSynced.clear();
    this.nativeGoalClearPending.clear();
  }

  private isProviderAvailable(provider: ProviderKind): boolean {
    return (this.options.availableProviders ?? ["claude", "codex", "agy", "grok", "cline"])
      .includes(provider);
  }

  private defaultProvider(): ProviderKind {
    return this.options.availableProviders?.[0] ?? "claude";
  }

  /** 제공자 실행 모듈에 private 필드 자체를 공개하지 않고 필요한 참조만 건넨다. */
  private baseExecutorHost(): BaseExecutorHost {
    return {
      store: this.store,
      transport: this.transport,
      options: this.options,
      active: this.active,
      deleting: this.deleting,
      applyHandoffSummary: (request, session) => this.applyHandoffSummary(request, session),
      safeRename: (session, title) => this.safeRename(session, title),
      requestUserInput: (session, request, signal) =>
        this.permissions.requestUserInput(session, request, signal)
    };
  }

  createSession(
    project: ProjectConfig,
    chatId: number,
    topicId: number,
    title: string,
    prompt: InitialSessionPrompt,
    resumeSessionId?: string,
    forkSession = false,
    model?: string | null,
    thinking?: string | null,
    claudeEffort?: string | null,
    leanMode = true,
    provider?: ProviderKind,
    codexModel?: string | null,
    codexReasoning?: string | null,
    agyThinkingLevel?: string | null,
    agyModel?: string | null,
    grokModel?: string | null,
    handoffSummary?: string | null,
    codexHome?: string | null,
    claudeTokenIndex?: number | null,
    grokReasoning?: string | null,
    clineProviderId?: string | null,
    clineModel?: string | null,
    clineReasoning?: string | null,
    permissionMode?: SessionRecord["permissionMode"] | null
  ): SessionRecord {
    if (this.disposed) throw new Error("세션 관리자가 종료되어 새 세션을 만들 수 없습니다.");
    const selectedProvider = provider ?? this.defaultProvider();
    if (!this.isProviderAvailable(selectedProvider)) {
      throw new Error(`${selectedProvider} 제공자는 인증되지 않아 사용할 수 없습니다.`);
    }
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
      permissionMode: permissionMode ?? project.defaultMode,
      provider: selectedProvider,
      model: model ?? null,
      thinking: thinking ?? null,
      claudeEffort: claudeEffort ?? null,
      claudeTokenIndex: claudeTokenIndex ?? null,
      codexModel: codexModel ?? null,
      codexReasoning: codexReasoning ?? null,
      codexHome: codexHome ?? null,
      codexThreadId: null,
      agyModel: agyModel ?? null,
      grokModel: grokModel ?? null,
      grokReasoning: grokReasoning ?? null,
      agyThinkingLevel: agyThinkingLevel || null,
      agyConversationId: null,
      agyUsage: null,
      grokUsage: null,
      clineProviderId: clineProviderId ?? null,
      clineModel: clineModel ?? null,
      clineReasoning: clineReasoning ?? null,
      clineSessionId: null,
      clineUsage: null,
      handoffSummary: handoffSummary ?? null,
      goalCondition: null,
      leanMode,
      usageSnapshot: null,
      createdAt: now,
      updatedAt: now
    };
    const initialPrompt = typeof prompt === "function" ? prompt(session) : prompt;
    this.store.createSession(session);
    this.enqueue({
      session,
      prompt: initialPrompt,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(forkSession ? { forkSession: true } : {})
    });
    return session;
  }

  async runOneOffTask(options: OneOffTaskOptions): Promise<string> {
    if (!this.isProviderAvailable(options.provider) && options.allowProviderFallback === false) {
      throw new Error(`${options.provider} 제공자는 인증되지 않아 사용할 수 없습니다.`);
    }
    const session = this.createOneOffSession(
      options.provider,
      options.defaults,
      options.cwd,
      "bypassPermissions"
    );

    const providers = options.allowProviderFallback === false
      ? [options.provider]
      : this.oneOffProviderOrder(options.provider);
    let lastLimitError: unknown;
    for (const provider of providers) {
      try {
        return await this.runOneOffTaskWithProvider(session, options, provider);
      } catch (error) {
        if (!isRateLimitError(error)) throw error;
        lastLimitError = error;
      }
    }
    throw lastLimitError ?? new Error("one-off 작업을 실행할 수 있는 제공자가 없습니다.");
  }

  async runReadOnlyTask(options: ReadOnlyTaskOptions): Promise<string> {
    if (this.disposed) throw new Error("세션 관리자가 종료되어 프로젝트를 선택할 수 없습니다.");
    const task = this.runToolFreeTask(options);
    this.readOnlyTasks.add(task);
    try {
      return await task;
    } finally {
      this.readOnlyTasks.delete(task);
    }
  }

  private async runToolFreeTask(options: ReadOnlyTaskOptions): Promise<string> {
    const provider = this.toolFreeProvider(options.provider);
    const session = this.createOneOffSession(
      provider,
      options.defaults,
      options.cwd,
      "plan"
    );
    return this.runSilentReadOnly(session, provider, options.prompt, {
      timeoutMs: options.timeoutMs,
      toolFree: true
    });
  }

  private toolFreeProvider(preferred: ProviderKind): ProviderKind {
    const candidates: ProviderKind[] = [preferred, "claude", "codex", "grok", "cline"];
    const provider = candidates.find((candidate, index) =>
      candidate !== "agy"
      && candidates.indexOf(candidate) === index
      && this.isProviderAvailable(candidate)
    );
    if (!provider) {
      throw new Error(
        "프로젝트 자동 선택에는 도구 없는 분류를 지원하는 Claude, Codex, Grok 또는 Cline 인증이 필요합니다. "
        + "/new browse 또는 /reserve browse로 직접 선택하세요."
      );
    }
    return provider;
  }

  private createOneOffSession(
    provider: ProviderKind,
    defaults: SessionDefaults,
    cwd: string,
    permissionMode: SessionRecord["permissionMode"]
  ): SessionRecord {
    const now = Date.now();
    return {
      id: `oneoff:${randomUUID()}`,
      sdkSessionId: null,
      chatId: 0,
      topicId: 0,
      projectName: "one-off",
      cwd,
      title: "one-off",
      status: "running",
      permissionMode,
      provider,
      model: defaults.claudeModel ?? null,
      thinking: defaults.thinking ?? null,
      claudeEffort: defaults.claudeEffort ?? null,
      claudeTokenIndex: defaults.claudeTokenIndex ?? null,
      codexModel: defaults.codexModel ?? null,
      codexReasoning: defaults.codexReasoning ?? null,
      codexHome: defaults.codexHome ?? null,
      codexThreadId: null,
      agyModel: defaults.agyModel ?? null,
      grokModel: defaults.grokModel ?? null,
      grokReasoning: defaults.grokReasoning ?? null,
      agyThinkingLevel: defaults.agyThinkingLevel || null,
      agyConversationId: null,
      agyUsage: null,
      grokUsage: null,
      clineProviderId: defaults.clineProviderId ?? null,
      clineModel: defaults.clineModel ?? null,
      clineReasoning: defaults.clineReasoning ?? null,
      clineSessionId: null,
      clineUsage: null,
      handoffSummary: null,
      goalCondition: null,
      leanMode: true,
      usageSnapshot: null,
      createdAt: now,
      updatedAt: now
    };
  }

  private createToolFreeCodexClient(codexHome: string): {
    codex: Codex;
    workspace: string;
    dispose: () => void;
  } {
    requireCodexSubscriptionAuth(codexHome);
    const root = mkdtempSync(join(tmpdir(), "chatkjb-codex-classifier-"));
    const isolatedHome = join(root, "home");
    const workspace = join(root, "workspace");
    try {
      mkdirSync(isolatedHome, { mode: 0o700 });
      mkdirSync(workspace, { mode: 0o700 });
      const authPath = join(isolatedHome, "auth.json");
      copyFileSync(join(codexHome, "auth.json"), authPath);
      chmodSync(authPath, 0o600);
      const codex = new Codex({
        ...(this.options.codexExecutable
          ? { codexPathOverride: this.options.codexExecutable }
          : {}),
        env: buildCodexEnvironment(isolatedHome),
        config: {
          features: {
            apps: false,
            browser_use: false,
            browser_use_external: false,
            code_mode: false,
            code_mode_host: false,
            computer_use: false,
            goals: false,
            hooks: false,
            image_generation: false,
            memories: false,
            multi_agent: false,
            plugins: false,
            shell_tool: false,
            unified_exec: false,
            apply_patch_freeform: false
          }
        }
      });
      return {
        codex,
        workspace,
        dispose: () => rmSync(root, { recursive: true, force: true })
      };
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  private oneOffProviderOrder(preferred: ProviderKind): ProviderKind[] {
    const providers: ProviderKind[] = [preferred, "claude", "codex", "agy", "grok", "cline"];
    return providers.filter((provider, index) => {
      if (providers.indexOf(provider) !== index) return false;
      return this.isProviderAvailable(provider);
    });
  }

  private async runOneOffTaskWithProvider(
    baseSession: SessionRecord,
    options: OneOffTaskOptions,
    provider: ProviderKind
  ): Promise<string> {
    if (!this.isProviderAvailable(provider)) {
      throw new Error(`${provider} 제공자는 인증되지 않아 사용할 수 없습니다.`);
    }
    const session: SessionRecord = {
      ...baseSession,
      id: `${baseSession.id}:${provider}`,
      provider
    };

    if (provider === "claude") {
      const claudeModel = session.model ?? DEFAULT_CLAUDE_MODEL;
      const tried = new Set<string>();
      let lastLimitError: unknown;
      for (let attempt = 0; attempt < this.tokenPool.size; attempt += 1) {
        const oauthToken = this.selectClaudeToken(session, claudeModel);
        if (tried.has(oauthToken)) break;
        tried.add(oauthToken);
        const abortController = new AbortController();
        const timeout = options.timeoutMs === undefined
          ? null
          : setTimeout(() => abortController.abort(), options.timeoutMs);
        const thinking = normalizeThinkingForModel(
          this.options.modelCatalog,
          claudeModel,
          session.thinking
        );
        const effort = resolveClaudeEffort(session.claudeEffort);
        const sdkQuery = query({
          prompt: options.prompt,
          options: {
            cwd: options.cwd,
            abortController,
            model: claudeModel,
            thinking: resolveThinkingConfig(thinking),
            ...(effort ? { effort } : {}),
            permissionMode: "bypassPermissions",
            settingSources: ["user"],
            skills: "all",
            env: buildClaudeEnvironment(oauthToken, process.env, this.options.mcpToolTimeoutMs),
            mcpServers: loadClaudeConnectors(
              this.options.mcpToolTimeoutMs,
              this.options.codexMcpTimeoutMs,
              this.options.longRunningMcpServers
            ),
            ...(this.options.claudeCodeExecutable
              ? { pathToClaudeCodeExecutable: this.options.claudeCodeExecutable }
              : {})
          }
        });
        try {
          let text = "";
          for await (const message of sdkQuery) {
            for (const block of assistantBlocks(message)) {
              if (block.type === "text" && typeof block.text === "string") text = block.text.trim();
            }
            if (message.type === "result") {
              if (message.subtype !== "success") {
                throw new Error(resultText(message) || "Claude one-off 작업이 실패했습니다.");
              }
              text = text || message.result.trim();
            }
          }
          return text;
        } catch (error) {
          if (!isRateLimitError(error)) throw error;
          lastLimitError = error;
          this.markClaudeRateLimited(oauthToken, error);
        } finally {
          if (timeout) clearTimeout(timeout);
          abortController.abort();
          sdkQuery.close();
        }
      }
      throw lastLimitError ?? new Error("Claude one-off 작업 실패: 사용 가능한 토큰이 없습니다.");
    }

    if (provider === "codex") {
      const tried = new Set<string>();
      let lastLimitError: unknown;
      for (let attempt = 0; attempt < this.codexAccountPool.size; attempt += 1) {
        const codexHome = this.selectCodexHome(session);
        if (tried.has(codexHome)) break;
        tried.add(codexHome);
        const codex = createCodexClient(this.options, codexHome);
        const model = session.codexModel ?? DEFAULT_CODEX_MODEL;
        const reasoning =
          (session.codexReasoning as CodexReasoningEffort | null) ?? DEFAULT_CODEX_REASONING;
        const thread = codex.startThread(
          buildCodexThreadOptions(session, model, reasoning)
        );
        const controller = new AbortController();
        const timeout = options.timeoutMs === undefined
          ? null
          : setTimeout(() => controller.abort(), options.timeoutMs);
        try {
          const result = await thread.run(options.prompt, { signal: controller.signal });
          return result.finalResponse.trim();
        } catch (error) {
          if (!isRateLimitError(error)) throw error;
          lastLimitError = error;
          this.markCodexRateLimited(codexHome, error);
        } finally {
          if (timeout) clearTimeout(timeout);
          controller.abort();
        }
      }
      throw lastLimitError ?? new Error("Codex one-off 작업 실패: 사용 가능한 계정이 없습니다.");
    }

    if (provider === "grok") {
      const result = await runGrokCli(options.prompt, {
        executable: this.options.grokExecutable ?? "grok",
        cwd: options.cwd,
        model: session.grokModel ?? this.options.grokModel ?? DEFAULT_GROK_MODEL,
        reasoningEffort: session.grokReasoning ?? DEFAULT_GROK_REASONING,
        supportedReasoningEfforts: this.options.modelCatalog.grokReasoningEfforts,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        permissionMode: session.permissionMode,
        rules: buildProviderBootstrap(session, this.options.claudeMemoryDir, {
          includeInteractiveProtocols: false,
          permissionMode: session.permissionMode
        })
      });
      return result.text;
    }

    if (provider === "cline") {
      return this.clineExecutor.runReadOnly(session, options.prompt, {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
      });
    }

    return this.agyExecutor.runOneOff(session, options.prompt, "bypassPermissions");
  }

  private selectCodexHome(
    session?: SessionRecord,
    options: { rotateFromSession?: boolean; } = {}
  ): string {
    if (options.rotateFromSession) {
      return this.codexAccountPool.selectNext(session?.codexHome ?? null);
    }
    // 세션에 명시된 계정(/tokenid·기본 계정·이전 sticky 저장)은 풀 소진 봉인보다 우선한다.
    // 과거 usage-limit 오류로 남은 봉인이 live 여유 계정을 가로채 #1로 몰리는 것을 막는다.
    // 실제 한도 도달은 스트림 오류 경로의 markRateLimited + selectNext 페일오버가 담당한다.
    if (
      session?.codexHome
      && this.codexAccountPool.indexOf(session.codexHome) !== -1
    ) {
      return session.codexHome;
    }
    return this.codexAccountPool.select();
  }

  private selectClaudeToken(session: SessionRecord, claudeModel: string): string {
    const index = session.claudeTokenIndex;
    if (typeof index === "number" && Number.isInteger(index) && index >= 0) {
      const preferred = this.oauthTokens[index];
      if (preferred && !this.tokenPool.isExhausted(preferred)) return preferred;
    }
    return this.tokenPool.select(Date.now(), claudeModel);
  }

  private markClaudeRateLimited(oauthToken: string, error: unknown): void {
    const resetsAt = snapshotFromRateLimitError(error)?.fiveHour?.resetsAt;
    this.tokenPool.noteRateLimited(
      oauthToken,
      Date.now(),
      resetsAt ? Date.parse(resetsAt) : undefined
    );
  }

  private markCodexRateLimited(codexHome: string, error: unknown): void {
    const resetsAt = snapshotFromRateLimitError(error)?.fiveHour?.resetsAt;
    this.codexAccountPool.markFailed(
      codexHome,
      Date.now(),
      resetsAt ? Date.parse(resetsAt) : undefined
    );
    this.persistCodexAccountState();
  }

  resume(session: SessionRecord, prompt: string): boolean {
    const current = this.store.getSession(session.id) ?? session;
    if (this.active.has(session.id) && !isTerminalSessionStatus(current.status)) return false;
    // Codex 세션은 스레드를 새로 시작할 수 있어 항상 이어 갈 수 있다. Claude 세션은 이어 갈
    // SDK 세션 id가 있어야 한다. 제공사 전환 직후(handoffSummary 보유)에는 양쪽 모두 새
    // 맥락에서 요약을 받아 시작하므로 재개 핸들 없이도 진행한다.
    const canResume = current.provider === "codex"
      || current.provider === "agy"
      || current.provider === "grok"
      || current.provider === "cline"
      || !!current.sdkSessionId
      || !!current.handoffSummary;
    if (!canResume) return false;
    this.store.updateSession(current.id, { status: "queued" });
    this.enqueue({
      session: this.store.getSession(current.id) ?? current,
      prompt,
      ...(current.provider === "claude" && current.sdkSessionId
        ? { resumeSessionId: current.sdkSessionId }
        : {})
    });
    return true;
  }

  compact(session: SessionRecord, focus?: string): boolean {
    if (!this.resumeHandle(session) || this.active.has(session.id)) return false;
    this.store.updateSession(session.id, { status: "queued" });
    this.enqueue({
      session: this.store.getSession(session.id) ?? session,
      prompt: session.provider === "claude"
        ? buildCompactCommand(focus)
        : buildRolloverSummaryPrompt(focus),
      ...(session.provider === "claude" && session.sdkSessionId
        ? { resumeSessionId: session.sdkSessionId }
        : {}),
      operation: "compact"
    });
    return true;
  }

  runNativeSlashCommand(session: SessionRecord, commandText: string): boolean {
    const clean = commandText.trim();
    if (!clean.startsWith("/") || this.active.has(session.id) || !this.resumeHandle(session)) return false;
    this.store.updateSession(session.id, { status: "queued" });
    this.enqueue({
      session: this.store.getSession(session.id) ?? session,
      prompt: clean,
      ...(session.provider === "claude" && session.sdkSessionId
        ? { resumeSessionId: session.sdkSessionId }
        : {}),
      operation: "native_command"
    });
    return true;
  }

  async prepareFork(session: SessionRecord): Promise<string | null> {
    if (this.active.has(session.id) || !this.resumeHandle(session)) return null;
    return this.summarizeForHandoff(session);
  }

  /** 제공자별 "이어 갈 수 있는 재개 핸들". null이면 아직 한 번도 실행되지 않은 세션이다. */
  private resumeHandle(session: SessionRecord): string | null {
    if (session.provider === "codex") return session.codexThreadId;
    if (session.provider === "agy") return session.agyConversationId;
    if (session.provider === "grok") return session.grokSessionId ?? null;
    if (session.provider === "cline") return session.clineSessionId ?? null;
    return session.sdkSessionId;
  }

  /**
   * 목표를 설정한다. Claude는 세션 재개 턴에 네이티브 /goal 명령을 보내고, Codex는
   * app-server goal API를 사용한다. 동등한 네이티브 기능이 없는 제공자에는 설정하지 않는다.
   */
  async setGoal(sessionId: string, condition: string): Promise<GoalSetResult> {
    const session = this.store.getSession(sessionId);
    if (!session) return "stored";
    if (session.provider !== "claude" && session.provider !== "codex") {
      this.clearGoal(sessionId);
      return "unsupported";
    }
    if (session.provider === "codex" && !this.codexGoalClient) {
      this.clearGoal(sessionId);
      return "unsupported";
    }
    const clean = normalizeGoalCondition(condition);
    this.store.updateSession(sessionId, { goalCondition: clean });
    this.nativeGoalSynced.delete(sessionId);
    this.nativeGoalClearPending.delete(sessionId);

    if (session.provider === "claude" && session.sdkSessionId) {
      if (this.active.has(sessionId)) return "active";
      this.setClaudeNativeGoal(session, clean);
      return "native";
    }

    if (session.provider === "codex" && session.codexThreadId && this.codexGoalClient) {
      try {
        await this.setCodexNativeGoal(session, clean);
        return "native";
      } catch (error) {
        this.clearGoal(sessionId);
        throw error;
      }
    }

    if (this.active.has(sessionId)) return "active";
    return "stored";
  }

  private setClaudeNativeGoal(session: SessionRecord, condition: string): void {
    if (!session.sdkSessionId) return;
    this.nativeGoalSynced.add(session.id);
    this.store.updateSession(session.id, { status: "queued" });
    this.enqueue({
      session: this.store.getSession(session.id) ?? session,
      prompt: buildGoalCommand(condition),
      resumeSessionId: session.sdkSessionId,
      operation: "goal_native"
    });
  }

  private async setCodexNativeGoal(session: SessionRecord, condition: string): Promise<void> {
    if (!session.codexThreadId || !this.codexGoalClient) return;
    const codexHome = this.selectCodexHome(session);
    await this.codexGoalClient.setGoal(session.codexThreadId, condition, { codexHome });
    if (session.codexHome !== codexHome) {
      this.store.updateSession(session.id, { codexHome });
    }
  }

  /** 저장소에 남긴 목표 상태를 끈다. 끌 목표가 있었으면 true. */
  clearGoal(sessionId: string): boolean {
    const had = !!this.store.getSession(sessionId)?.goalCondition;
    this.nativeGoalSynced.delete(sessionId);
    this.nativeGoalClearPending.delete(sessionId);
    if (this.store.getSession(sessionId)) {
      this.store.updateSession(sessionId, { goalCondition: null });
    }
    return had;
  }

  async clearGoalForCommand(sessionId: string): Promise<boolean> {
    const session = this.store.getSession(sessionId);
    if (!session) return false;
    const had = !!session.goalCondition;

    if (session.provider === "codex" && session.codexThreadId) {
      if (!this.codexGoalClient) {
        throw new Error("Codex 네이티브 goal API를 사용할 수 없습니다.");
      }
      const codexHome = this.selectCodexHome(session);
      const cleared = await this.codexGoalClient.clearGoal(session.codexThreadId, { codexHome });
      this.clearGoal(sessionId);
      return had || cleared;
    }

    if (session.provider === "claude" && session.sdkSessionId && !this.active.has(sessionId)) {
      this.store.updateSession(session.id, { status: "queued" });
      this.enqueue({
        session: this.store.getSession(session.id) ?? session,
        prompt: "/goal clear",
        resumeSessionId: session.sdkSessionId,
        operation: "goal_native"
      });
      this.clearGoal(sessionId);
      return true;
    }

    if (session.provider === "claude" && this.active.has(sessionId)) {
      this.clearGoal(sessionId);
      this.nativeGoalClearPending.add(sessionId);
      return had;
    }

    this.clearGoal(sessionId);
    return had;
  }

  stop(sessionId: string): boolean {
    // /stop은 ChatKJB 실행과 함께 제공자 네이티브 목표 상태도 정리한다.
    this.clearGoal(sessionId);
    void this.clearProviderGoal(sessionId).catch((error: unknown) => {
      console.error(`Native goal clear failed: ${safeErrorMessage(error, this.oauthTokens)}`);
    });
    // 한도 회복을 기다리며 예약된 자동 재개가 있으면 그것도 중단으로 친다.
    const canceledClaudeRetry = this.claudeExecutor.cancelRetry(sessionId);
    const canceledLimitWaiter = this.cancelLimitWaiter(sessionId);
    if (canceledLimitWaiter || canceledClaudeRetry) {
      if (canceledClaudeRetry || this.store.getSession(sessionId)?.status === "waiting_limit") {
        this.store.updateSession(sessionId, { status: "aborted" });
      }
      return true;
    }
    const run = this.active.get(sessionId);
    if (!run) return false;
    run.stopRequested = true;
    run.input.cancel();
    run.controller.abort();
    this.agyExecutor.interrupt(sessionId);
    // close()는 hang된 for-await가 풀리길 기다리지 않고 CLI 서브프로세스를 즉시
    // 강제 종료한다 — in-flight MCP 호출/transport와 서브에이전트까지 함께 정리되어
    // 종료 후 MCP 호출이 남아 가로막는 문제를 막는다. finally의 close()는 멱등 백업.
    run.query?.close();
    return true;
  }

  private async clearProviderGoal(sessionId: string): Promise<boolean> {
    const session = this.store.getSession(sessionId);
    if (!session) return false;
    if (session.provider === "codex" && session.codexThreadId && this.codexGoalClient) {
      return this.codexGoalClient.clearGoal(session.codexThreadId, {
        codexHome: this.selectCodexHome(session)
      });
    }
    return false;
  }

  cancelLimitResume(sessionId: string): boolean {
    const canceled = this.cancelLimitWaiter(sessionId);
    if (!canceled) return false;
    const session = this.store.getSession(sessionId);
    if (session?.status === "waiting_limit") {
      this.store.updateSession(sessionId, { status: "aborted" });
    }
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
    if (!this.isProviderAvailable("claude")) {
      return { snapshot: null, error: "Claude OAuth 인증 없음" };
    }
    return this.fetchUsageSnapshotForToken(cwd, this.tokenPool.select());
  }

  getCodexUsageSnapshots(now: number = Date.now()): CodexAccountUsageSnapshot[] {
    if (!this.isProviderAvailable("codex")) return [];
    return this.codexAccountPool.statuses(now).map((status) => ({
      accountIndex: status.index,
      available: status.available,
      exhaustedUntil: status.available ? null : status.exhaustedUntil,
      latestUsage: this.codexUsageByHome.get(status.home) ?? null
    }));
  }

  async fetchCurrentCodexUsageSnapshots(cwd: string): Promise<CodexAccountUsageSnapshot[]> {
    if (!this.isProviderAvailable("codex")) return [];
    const results: CodexAccountUsageSnapshot[] = [];
    for (const status of this.codexAccountPool.statuses()) {
      const live = await fetchCodexLiveUsage({
        cwd,
        codexExecutable: this.options.codexExecutable,
        env: buildCodexEnvironment(status.home),
        timeoutMs: 15_000
      });
      if (live.snapshot) {
        this.codexAccountPool.setExhaustion(
          status.home,
          codexExhaustedUntilFromLiveUsage(live.snapshot)
        );
        this.persistCodexAccountState();
      }
      const updated = this.codexAccountPool.statuses().find((item) => item.home === status.home) ?? status;
      results.push({
        accountIndex: updated.index,
        available: updated.available,
        exhaustedUntil: updated.available ? null : updated.exhaustedUntil,
        latestUsage: this.codexUsageByHome.get(status.home) ?? null,
        liveUsage: live.snapshot,
        liveUsageError: live.error
      });
    }
    return results;
  }

  private async reconcileCodexAccountsFromLiveUsage(
    cwd: string,
    options: { excludeHome?: string | null; } = {}
  ): Promise<void> {
    let changed = false;
    for (const status of this.codexAccountPool.statuses()) {
      if (status.home === options.excludeHome) continue;
      const live = await fetchCodexLiveUsage({
        cwd,
        codexExecutable: this.options.codexExecutable,
        env: buildCodexEnvironment(status.home),
        timeoutMs: 15_000
      }).catch(() => ({ snapshot: null, error: "live usage lookup failed" }));
      if (!live.snapshot) continue;
      this.codexAccountPool.setExhaustion(
        status.home,
        codexExhaustedUntilFromLiveUsage(live.snapshot)
      );
      changed = true;
    }
    if (changed) this.persistCodexAccountState();
  }

  private restoreCodexAccountState(): void {
    const raw = this.store.getAppSetting(CODEX_ACCOUNT_STATE_SETTING);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedCodexAccountState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) return;
      for (const account of parsed.accounts) {
        if (!account || typeof account.home !== "string") continue;
        if (this.codexAccountPool.indexOf(account.home) === -1) continue;
        if (typeof account.exhaustedUntil === "number" && Number.isFinite(account.exhaustedUntil)) {
          this.codexAccountPool.restoreExhaustion(account.home, account.exhaustedUntil);
        }
        if (isCodexUsageSnapshot(account.latestUsage)) {
          this.codexUsageByHome.set(account.home, account.latestUsage);
        }
      }
    } catch (error) {
      console.error("Codex account state restore failed:", safeErrorMessage(error));
    }
  }

  private persistCodexAccountState(): void {
    const state: PersistedCodexAccountState = {
      version: 1,
      accounts: this.codexAccountPool.statuses().map((status) => ({
        home: status.home,
        exhaustedUntil: status.exhaustedUntil,
        latestUsage: this.codexUsageByHome.get(status.home) ?? null
      }))
    };
    this.store.setAppSetting(CODEX_ACCOUNT_STATE_SETTING, JSON.stringify(state));
  }

  private restoreClaudeTokenState(): void {
    const raw = this.store.getAppSetting(CLAUDE_TOKEN_STATE_SETTING);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedClaudeTokenState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.tokens)) return;
      for (const token of parsed.tokens) {
        if (!token || typeof token.fingerprint !== "string") continue;
        if (typeof token.exhaustedUntil === "number" && Number.isFinite(token.exhaustedUntil)) {
          this.tokenPool.restoreExhaustion(token.fingerprint, token.exhaustedUntil);
        }
      }
    } catch (error) {
      console.error("Claude token state restore failed:", safeErrorMessage(error));
    }
  }

  private persistClaudeTokenState(): void {
    const state: PersistedClaudeTokenState = {
      version: 1,
      tokens: this.tokenPool.statuses().map((status) => ({
        fingerprint: status.fingerprint,
        exhaustedUntil: status.exhaustedUntil
      }))
    };
    this.store.setAppSetting(CLAUDE_TOKEN_STATE_SETTING, JSON.stringify(state));
  }

  private recordCodexUsage(
    home: string,
    usage: CodexSdkUsage,
    model: string,
    reasoning: string
  ): void {
    const inputTokens = usage.input_tokens;
    const cachedInputTokens = usage.cached_input_tokens;
    const outputTokens = usage.output_tokens;
    const reasoningOutputTokens = usage.reasoning_output_tokens;
    this.codexUsageByHome.set(home, {
      capturedAt: Date.now(),
      model,
      reasoning,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens: inputTokens + outputTokens
    });
    this.persistCodexAccountState();
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
        const resolvedSnapshot = snapshot ?? provisionalSnapshot;
        if (resolvedSnapshot && hasUsageWindows(resolvedSnapshot)) {
          this.tokenPool.observe(oauthToken, resolvedSnapshot);
          return { snapshot: resolvedSnapshot, error: null };
        }
        const subscriptionSnapshot = await this.fetchSubscriptionUsageSnapshot(cwd);
        if (subscriptionSnapshot && hasUsageWindows(subscriptionSnapshot)) {
          this.tokenPool.observe(oauthToken, subscriptionSnapshot);
          return { snapshot: subscriptionSnapshot, error: null };
        }
        this.tokenPool.observe(oauthToken, resolvedSnapshot);
        return { snapshot: resolvedSnapshot, error: null };
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

  private async fetchSubscriptionUsageSnapshot(cwd: string): Promise<UsageSnapshot | null> {
    const abortController = new AbortController();
    const env = {
      ...process.env,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined
    };
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
        env,
        ...(this.options.claudeCodeExecutable
          ? { pathToClaudeCodeExecutable: this.options.claudeCodeExecutable }
          : {})
      }
    });

    try {
      for await (const message of sdkQuery) {
        if (message.type !== "system" || message.subtype !== "init") continue;
        return await readUsageSnapshot(sdkQuery, 10_000);
      }
      return null;
    } catch {
      return null;
    } finally {
      abortController.abort();
      sdkQuery.close();
    }
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  isFinalizing(sessionId: string): boolean {
    const session = this.store.getSession(sessionId);
    return !!session && this.active.has(sessionId) && isTerminalSessionStatus(session.status);
  }

  /** 유휴 Cline 세션의 연결 설정을 SDK와 DB에 원자적으로 반영한다. */
  async updateClineConnection(
    sessionId: string,
    fields: Partial<ClineSessionSelection>
  ): Promise<ResetContextResult> {
    const previous = this.store.getSession(sessionId);
    if (!previous || previous.provider !== "cline") {
      return { ok: false, reason: "Cline 세션을 찾을 수 없습니다." };
    }
    if (this.active.has(sessionId) || this.sessionTasks.has(sessionId)) {
      return { ok: false, reason: "실행 중에는 바꿀 수 없습니다. /stop 후 다시 시도하세요." };
    }
    this.store.updateSession(sessionId, fields);
    const updated = this.store.getSession(sessionId) ?? previous;
    try {
      await this.clineExecutor.updateConnection(updated);
      return { ok: true };
    } catch (error) {
      this.store.updateSession(sessionId, {
        clineProviderId: previous.clineProviderId ?? null,
        clineModel: previous.clineModel ?? null,
        clineReasoning: previous.clineReasoning ?? null
      });
      return { ok: false, reason: safeErrorMessage(error) };
    }
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
  ): Promise<{ ok: boolean; reason?: string; }> {
    if (!this.isProviderAvailable(target)) {
      return { ok: false, reason: `${target} 제공자는 인증되지 않아 사용할 수 없습니다.` };
    }
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
    this.agyExecutor.resetContext(session.id);

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
    } else if (target === "grok") {
      // 대상=Grok: 새 grok 세션에서 요약을 받아 시작한다(grokSessionId를 비워
      // 다음 턴이 --session-id로 새 세션을 만들게 한다).
      this.store.updateSession(sessionId, {
        provider: "grok",
        grokSessionId: null,
        ...(summary ? { handoffSummary: summary } : {})
      });
    } else if (target === "cline") {
      // 대상=Cline: 새 Cline 세션에서 요약을 받아 시작한다. 내부 제공자·모델을 함께 확정하지
      // 않으면 세션이 빈 연결값으로 남아 /model 패널이 선택을 계속 거부한다.
      const seeded = seedClineConnection(this.options.modelCatalog, session);
      this.store.updateSession(sessionId, {
        provider: "cline",
        clineSessionId: null,
        clineUsage: null,
        ...seeded,
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

  async resetContext(sessionId: string): Promise<ResetContextResult> {
    const session = this.store.getSession(sessionId);
    if (!session) return { ok: false, reason: "세션을 찾을 수 없습니다." };
    if (this.active.has(sessionId) || this.sessionTasks.has(sessionId)) {
      return { ok: false, reason: "실행 중에는 문맥을 초기화할 수 없습니다. /stop 후 다시 시도하세요." };
    }

    try {
      if (session.provider === "claude") {
        await this.resetClaudeContext(session);
        this.store.updateSession(session.id, {
          sdkSessionId: null,
          handoffSummary: null,
          usageSnapshot: null
        });
      } else if (session.provider === "codex") {
        this.store.updateSession(session.id, {
          codexThreadId: null,
          handoffSummary: null
        });
      } else if (session.provider === "agy") {
        this.agyExecutor.resetContext(session.id);
        this.store.updateSession(session.id, {
          agyConversationId: null,
          agyUsage: null,
          grokUsage: null,
          handoffSummary: null
        });
      } else if (session.provider === "cline") {
        await this.clineExecutor.reset(session);
        this.store.updateSession(session.id, {
          clineSessionId: null,
          clineUsage: null,
          handoffSummary: null
        });
      } else {
        // grok(및 그 외): grok 세션 마커를 비워 다음 턴이 새 grok 세션을 만들게 한다.
        this.store.updateSession(session.id, {
          grokSessionId: null,
          handoffSummary: null
        });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: safeErrorMessage(error, this.oauthTokens) };
    }
  }

  async getAgyLiveStatus(sessionId: string): Promise<AgyLiveStatusResult> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return { status: null, error: "세션을 찾을 수 없습니다." };
    }
    if (session.provider !== "agy") {
      return { status: null, error: "Antigravity 세션이 아닙니다." };
    }
    return this.agyExecutor.getLiveStatus(session);
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
      // agy: 영속 대화식 세션을 읽기 전용 권한으로 재개해 요약 한 턴을 받는다.
      if (!session.agyConversationId) return "";
      return this.agyExecutor.summarizeForHandoff(session, prompt);
    }
    if (session.provider === "grok") {
      if (!session.grokSessionId) return "";
      const result = await runGrokCli(prompt, {
        executable: this.options.grokExecutable ?? "grok",
        cwd: session.cwd,
        model: session.grokModel ?? this.options.grokModel ?? DEFAULT_GROK_MODEL,
        reasoningEffort: session.grokReasoning ?? DEFAULT_GROK_REASONING,
        supportedReasoningEfforts: this.options.modelCatalog.grokReasoningEfforts,
        ...(this.options.providerTurnTimeoutMs
          ? { timeoutMs: this.options.providerTurnTimeoutMs }
          : {}),
        permissionMode: "plan",
        rules: buildProviderBootstrap(session, this.options.claudeMemoryDir, {
          includeInteractiveProtocols: false,
          permissionMode: "plan"
        }),
        sessionId: session.grokSessionId,
        resume: true
      });
      return result.text.trim();
    }
    if (session.provider === "cline") {
      if (!session.clineSessionId) return "";
      return this.clineExecutor.summarizeForHandoff(session, prompt);
    }
    // Codex: 직전 스레드를 재개해 비스트리밍으로 요약 한 턴을 받는다.
    if (!session.codexThreadId) return "";
    const codexHome = this.selectCodexHome(session);
    const codex = createCodexClient(this.options, codexHome);
    const thread = codex.resumeThread(
      session.codexThreadId,
      buildCodexThreadOptions(
        session,
        session.codexModel ?? DEFAULT_CODEX_MODEL,
        (session.codexReasoning as CodexReasoningEffort | null) ?? DEFAULT_CODEX_REASONING,
        "plan",
        false
      )
    );
    const result = await thread.run(prompt);
    return result.finalResponse.trim();
  }

  private async resetClaudeContext(session: SessionRecord): Promise<void> {
    if (!session.sdkSessionId) return;
    const removeClaudeSession = this.options.deleteClaudeSession ?? deleteClaudeSession;
    await removeClaudeSession(session.sdkSessionId, { dir: session.cwd });
  }

  async deleteSession(session: SessionRecord): Promise<void> {
    // Bot API /delete와 MTProto 직접-삭제 감지가 같은 토픽 삭제를 동시에 볼 수 있다.
    // DB 행을 먼저 지운 경로가 있으면 provider 원본과 실행 정리를 중복 호출하지 않는다.
    if (!this.store.getSession(session.id)) return;
    this.deleting.add(session.id);
    const wasActive = this.active.has(session.id);
    this.stop(session.id);
    this.agyExecutor.resetContext(session.id);
    if (session.clineSessionId) {
      await this.clineExecutor.reset(session).catch((error) => {
        console.error("Cline session deletion failed:", safeErrorMessage(error));
      });
    }
    this.store.deleteSession(session.id);

    const task = this.sessionTasks.get(session.id);
    if (wasActive && task) await task.catch(() => undefined);

    if (session.sdkSessionId) {
      await this.resetClaudeContext(session).catch((error) => {
        console.error("Claude session deletion failed:", safeErrorMessage(error));
      });
    }

    if (!task || wasActive) this.deleting.delete(session.id);
  }

  steer(sessionId: string, prompt: string): "restarted" | "queued" | false {
    const run = this.active.get(sessionId);
    const clean = prompt.trim();
    if (!run || !clean) return false;
    const session = this.store.getSession(sessionId);
    if (session?.provider === "codex" && run.codexCurrentPrompt) {
      const base = run.codexRestartPrompt ?? run.codexCurrentPrompt;
      run.codexRestartPrompt = buildOrchestratedTurnPrompt(buildCodexSteeredPrompt(base, clean));
      run.progressDecision?.(`조향(Codex 재시작): ${clean.slice(0, 160)}`);
      run.progressFlush?.();
      run.controller.abort();
      return "restarted";
    }
    run.pendingTurns += 1;
    if (run.input.push(buildUserMessage(buildOrchestratedTurnPrompt(clean, {
      includeDate: session?.provider !== "claude"
    }), "now"))) {
      const provider = session?.provider ?? "claude";
      const label = provider === "claude"
        ? "조향(라이브 주입)"
        : provider === "codex"
          ? "조향(큐)"
          : `조향(큐 · ${provider} 라이브 제한)`;
      run.progressDecision?.(`${label}: ${clean.slice(0, 160)}`);
      run.progressFlush?.();
      return "queued";
    }
    run.pendingTurns -= 1;
    return false;
  }

  queueFollowUp(sessionId: string, prompt: string): boolean {
    const run = this.active.get(sessionId);
    const clean = prompt.trim();
    if (!run || !clean) return false;
    const session = this.store.getSession(sessionId);
    run.pendingTurns += 1;
    if (run.input.push(buildUserMessage(buildOrchestratedTurnPrompt(clean, {
      includeDate: session?.provider !== "claude"
    }), "next"))) return true;
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
   * 모든 토큰/계정이 한도에 도달해 더 실행할 수 없을 때 세션을 대기 상태로 두고
   * provider가 알려준 회복 시각 이후 같은 요청을 자동 재개한다.
   */
  private scheduleLimitResume(
    session: SessionRecord,
    request: RunRequest,
    sdkSessionId: string | null,
    resumeAt: number
  ): void {
    const when = new Date(resumeAt + LIMIT_RESUME_BUFFER_MS).toLocaleString(appLocale(), {
      timeZone: appTimeZone()
    });
    const lead = session.provider === "codex"
      ? (this.codexAccountPool.size > 1 ? "모든 Codex 계정이 한도에 도달했습니다." : "Codex 계정이 한도에 도달했습니다.")
      : (this.tokenPool.size > 1 ? "모든 계정 토큰이 한도에 도달했습니다." : "토큰이 한도에 도달했습니다.");
    this.store.updateSession(session.id, { status: "waiting_limit" });
    const limitRun = this.active.get(session.id);
    limitRun?.progressNote?.("한도 회복 대기");
    limitRun?.progressFlush?.();
    void this.transport.sendText(
      session.chatId,
      session.topicId,
      `${lead} provider가 알려준 회복 시각은 ${when}입니다. `
      + "해당 시각 이후 자동 재개를 예약했습니다. 취소하려면 /restop 을 보내십시오."
    ).catch(() => undefined);
    void this.safeRename(session, `[WAIT] ${session.title}`);
    this.cancelLimitWaiter(session.id);
    const delayMs = Math.max(0, resumeAt + LIMIT_RESUME_BUFFER_MS - Date.now());
    const resumeRequest: RunRequest = {
      // Codex rollout이 실제로 유실되면 executor의 no-rollout 복구가 원 요청을 한 번만
      // 되살린다. 정상 resume에는 긴 원문을 다시 붙이지 않는다.
      ...limitResumeRequest(request, false),
      // 모든 Codex 계정이 한도에 닿아 대기한 뒤에는 직전 실패 계정에 고정하지 않고,
      // 다음 사용 가능 계정부터 다시 고른다.
      ...(session.provider === "codex" ? { codexRotateOnStart: true } : {}),
      ...(sdkSessionId ? { resumeSessionId: sdkSessionId } : {})
    };
    const timer = setTimeout(() => {
      this.limitWaiters.delete(session.id);
      if (this.deleting.has(session.id)) return;
      const latest = this.store.getSession(session.id);
      if (!latest || latest.status !== "waiting_limit") return;
      this.store.updateSession(session.id, { status: "queued" });
      this.enqueue({ ...resumeRequest, session: this.store.getSession(session.id) ?? latest });
    }, delayMs);
    timer.unref();
    this.limitWaiters.set(session.id, timer);
  }

  private enqueue(request: RunRequest): void {
    if (this.disposed) return;
    // 과거 버전이나 테스트 주입으로 남은 한도-회복 타이머가 있으면 새 지시가 우선이므로 취소한다.
    this.cancelLimitWaiter(request.session.id);
    this.claudeExecutor.cancelRetry(request.session.id);
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
      .finally(async () => {
        const settled = this.store.getSession(request.session.id);
        if (settled && isTerminalSessionStatus(settled.status)) {
          await Promise.resolve(this.options.onSessionSettled?.(settled)).catch((error: unknown) => {
            console.error(
              `Session settled hook failed (${request.session.id}):`,
              safeErrorMessage(error, this.oauthTokens)
            );
          });
        }
        const remaining = Math.max(0, (this.queuedCounts.get(cwd) ?? 1) - 1);
        if (remaining === 0) this.queuedCounts.delete(cwd);
        else this.queuedCounts.set(cwd, remaining);
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

  // 큐에서 꺼낸 작업을 현재 저장된 provider에 맞는 실행기로 보낸다. provider는 /provider
  // 전환으로 큐 대기 중에 바뀔 수 있으므로 스냅샷이 아닌 최신 값을 다시 읽는다.
  private async dispatch(request: RunRequest): Promise<void> {
    if (this.disposed) return;
    const session = this.store.getSession(request.session.id);
    const provider = session?.provider ?? request.session.provider;
    if (!this.isProviderAvailable(provider)) {
      if (session) this.store.updateSession(session.id, { status: "error" });
      await this.transport.sendText(
        request.session.chatId,
        request.session.topicId,
        `[ERROR] ${provider} 제공자는 현재 인증되어 있지 않습니다. /firstp 또는 /provider에서 인증된 제공자를 선택하세요.`
      ).catch(() => undefined);
      return;
    }
    if (provider === "codex") {
      await this.executeCodex(request);
      return;
    }
    if (provider === "agy") {
      await this.executeAgy(request);
      return;
    }
    if (provider === "grok") {
      await this.executeGrok(request);
      return;
    }
    if (provider === "cline") {
      await this.clineExecutor.execute(request);
      return;
    }
    await this.execute(request);
  }

  private async executeGrok(request: RunRequest): Promise<void> {
    await executeGrokProvider(this.baseExecutorHost(), request);
  }
  private handleClaudeGoalCompletion(session: SessionRecord, request: RunRequest): void {
    if (
      request.operation !== "goal_native"
      && session.provider === "claude"
      && session.sdkSessionId
      && this.nativeGoalClearPending.delete(session.id)
    ) {
      this.store.updateSession(session.id, { status: "queued" });
      this.enqueue({
        session: this.store.getSession(session.id) ?? session,
        prompt: "/goal clear",
        resumeSessionId: session.sdkSessionId,
        operation: "goal_native"
      });
      return;
    }
    if (
      request.operation !== "goal_native"
      && session.provider === "claude"
      && session.sdkSessionId
      && session.goalCondition
      && !this.nativeGoalSynced.has(session.id)
    ) {
      this.setClaudeNativeGoal(session, session.goalCondition);
    }
  }

  private async execute(request: RunRequest): Promise<void> {
    await this.claudeExecutor.execute(request);
  }

  // Codex 제공사 세션의 한 작업(여러 턴)을 실행한다. Claude의 execute()에 대응하며, Codex
  // SDK 스레드로 턴을 돌린다. 웹검색은 항상 켜고 저장된 권한 모드를 Codex 샌드박스에 매핑한다.
  // steer/next로 큐에 쌓인 메시지는 같은 스레드에서 이어지는 턴으로 처리한다.
  private async executeCodex(request: RunRequest): Promise<void> {
    await this.codexExecutor.execute(request);
  }

  private async executeAgy(request: RunRequest): Promise<void> {
    await this.agyExecutor.execute(request);
  }
  private async runReadOnlyClaude(
    session: SessionRecord,
    controller: AbortController,
    run: ActiveRun,
    prompt: string,
    oauthToken: string,
    allowQuestions = false,
    modelOverride?: string,
    thinkingOverride?: string,
    effortOverride?: string,
    toolFree = false
  ): Promise<string> {
    const instructions = toolFree ? "" : loadProjectInstructions(session.cwd);
    const claudeModel = modelOverride ?? session.model ?? DEFAULT_CLAUDE_MODEL;
    const thinking = normalizeThinkingForModel(
      this.options.modelCatalog,
      claudeModel,
      thinkingOverride ?? session.thinking
    );
    const effort = resolveClaudeEffort(effortOverride ?? session.claudeEffort);
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
        settingSources: [],
        ...(toolFree
          ? {
              tools: [],
              allowedTools: [],
              mcpServers: {},
              strictMcpConfig: true,
              skills: [],
              agents: {},
              systemPrompt: "도구를 전혀 사용하지 말고 제공된 텍스트만 분류하여 요청된 JSON만 출력하십시오."
            }
          : {
              allowedTools: ["Read", "Glob", "Grep", "WebSearch"],
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
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
              }
            }),
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

  // ── 다단계 병렬 종합 ─────────────────────────────────────────────────────
  // 같은 작업을 인증된 제공자들에 읽기 전용으로 동시에 시킨다(파일 충돌 없음). Claude
  // OAuth가 있으면 동적으로 감지한 최신 Fable 심사자가 가장 나은 답을 고른다. 단, 바로 승자를 정하지 않고 먼저
  // 각 provider가 서로의 원답을 비판하고, 원 provider가 자기 답을 보완한 뒤 승점제
  // 리그 방식으로 재심사한다.
  // 마지막에는 승자 provider가 다른 보완 후보의 더 나은 부분을 통합해 최종답을 만든다.
  // /synth 명령으로만 호출되는 비싼 경로다.
  async runSynthesis(session: SessionRecord, prompt: string): Promise<SynthesisResult> {
    if (this.active.has(session.id)) {
      return { ok: false, reason: "실행 중에는 병렬 종합을 시작할 수 없습니다. 작업 완료 또는 /stop 후 다시 시도하세요." };
    }
    const providers = (["claude", "codex", "agy", "grok", "cline"] as const)
      .filter((provider): provider is ProviderKind => this.isProviderAvailable(provider));
    // 인증된 제공자들을 동시에 시작하되 초기화 버스트만 SYNTH_PROVIDER_STAGGER_MS 간격으로 어긋나게
    // 한다(동시 모듈 로딩·spawn 스파이크로 인한 errno 11 크래시 완화). 일단 시작된 뒤의 대기는
    // 병렬로 진행된다.
    const settled = await Promise.allSettled(
      providers.map(async (provider, index) => {
        if (index > 0) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, index * SYNTH_PROVIDER_STAGGER_MS));
        }
        return this.runSilentReadOnly(session, provider, prompt);
      })
    );
    const candidates: JudgeCandidate[] = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled" && result.value.trim()) {
        candidates.push({ provider: providers[index]!, text: result.value.trim() });
      }
    }

    if (candidates.length === 0) {
      return { ok: false, reason: "후보 제공자가 모두 응답하지 못했습니다." };
    }
    const candidateProviders = candidates.map((c) => c.provider);

    // 후보가 하나뿐이면 심사·종합 없이 그대로 반환한다.
    if (candidates.length === 1) {
      return {
        ok: true,
        answer: candidates[0]!.text,
        candidates: candidateProviders,
        synthesizedBy: candidates[0]!.provider
      };
    }

    const critiques = await this.collectPeerCritiques(session, prompt, candidates);
    const revisedCandidates = await this.reviseCandidates(session, prompt, candidates, critiques);
    const judgedCandidates = revisedCandidates.length >= 2 ? revisedCandidates : candidates;
    const judgedProviders = judgedCandidates.map((c) => c.provider);

    const verdict = await this.judgeCandidates(session, prompt, judgedCandidates);
    const winner = judgedCandidates[verdict.winner - 1] ?? judgedCandidates[0]!;

    // 승자 기반 통합: 승자 provider에게 후보들을 주고 최종본을 합치게 한다(읽기 전용).
    const synthPrompt = buildSynthesisPrompt(prompt, judgedCandidates, verdict);
    let answer = winner.text;
    try {
      answer = (await this.runSilentReadOnly(session, winner.provider, synthPrompt)).trim() || winner.text;
    } catch (error) {
      // 종합 실패 시 승자 답을 그대로 쓴다(품질은 낮아도 답은 보존).
      console.error("Synthesis merge failed:", safeErrorMessage(error, this.oauthTokens));
    }

    return {
      ok: true,
      answer,
      candidates: judgedProviders,
      verdict,
      synthesizedBy: winner.provider
    };
  }

  private async collectPeerCritiques(
    session: SessionRecord,
    question: string,
    candidates: JudgeCandidate[]
  ): Promise<SynthCritique[]> {
    const settled = await Promise.allSettled(
      candidates.map(async (candidate, index) => {
        if (index > 0) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, index * SYNTH_PROVIDER_STAGGER_MS));
        }
        const critiquePrompt = buildPeerCritiquePrompt(question, candidates, candidate.provider);
        return {
          provider: candidate.provider,
          text: (await this.runSilentReadOnly(session, candidate.provider, critiquePrompt)).trim()
        };
      })
    );
    const critiques: SynthCritique[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value.text) {
        critiques.push(result.value);
      }
    }
    return critiques;
  }

  private async reviseCandidates(
    session: SessionRecord,
    question: string,
    candidates: JudgeCandidate[],
    critiques: SynthCritique[]
  ): Promise<JudgeCandidate[]> {
    if (critiques.length === 0) return [];
    const settled = await Promise.allSettled(
      candidates.map(async (candidate, index) => {
        if (index > 0) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, index * SYNTH_PROVIDER_STAGGER_MS));
        }
        const revisionPrompt = buildRevisionPrompt(question, candidate, candidates, critiques);
        return {
          provider: candidate.provider,
          text: (await this.runSilentReadOnly(session, candidate.provider, revisionPrompt)).trim()
        };
      })
    );
    const revised: JudgeCandidate[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value.text) {
        revised.push(result.value);
      }
    }
    return revised;
  }

  // 후보들을 승점제 리그 방식으로 심사한다. 최신 Claude Fable이 없거나 실패하면 1번 후보.
  private async judgeCandidates(
    session: SessionRecord,
    question: string,
    candidates: JudgeCandidate[]
  ): Promise<JudgeVerdict> {
    const judgePrompt = buildJudgePrompt(question, candidates);

    const fable = this.isProviderAvailable("claude")
      ? latestClaudeFableModel(this.options.modelCatalog)
      : undefined;
    if (fable) {
      try {
        // Fable 판관도 runSilentReadOnly를 통해 토큰을 회전한다: 한 토큰이 한도여도
        // 살아있는 다른 토큰이 있으면 첫 후보 폴백 대신 정상 심사를 마친다.
        const text = await this.runSilentReadOnly(session, "claude", judgePrompt, {
          claudeModelOverride: fable.id,
          claudeThinkingOverride: SYNTH_JUDGE_CLAUDE_THINKING,
          claudeEffortOverride: SYNTH_JUDGE_CLAUDE_EFFORT
        });
        const parsed = parseJudgeResponse(text, candidates.length);
        if (parsed) return { ...parsed, judge: "claude", judgeModel: fable.id };
      } catch (error) {
        console.error(`Claude Fable synthesis judge failed (${fable.id}):`, safeErrorMessage(error, this.oauthTokens));
      }
    }

    // Fable 판정이 실패하면 다른 모델로 폴백하지 않고
    // 첫 후보를 그대로 채택한다(투명성을 위해 judge: "fallback"으로 표기).
    return {
      winner: 1,
      reason: fable
        ? `승점제 심사자(${fable.label})를 사용할 수 없어 첫 후보를 선택했습니다.`
        : this.isProviderAvailable("claude")
          ? "Claude 모델 카탈로그에서 Fable을 찾지 못해 첫 후보를 선택했습니다."
          : "Claude OAuth가 없어 Claude 전용 심사를 건너뛰고 첫 후보를 선택했습니다.",
      judge: "fallback"
    };
  }

  // provider 하나에 같은 프롬프트를 읽기 전용·새 맥락으로 1회 실행해 최종 텍스트만 받는다.
  // 텔레그램 토픽·active 맵·렌더러에 흘리지 않는다(병렬 종합 전용 조용한 실행).
  private async runSilentReadOnly(
    session: SessionRecord,
    provider: ProviderKind,
    prompt: string,
    options: SilentReadOnlyOptions = {}
  ): Promise<string> {
    if (!this.isProviderAvailable(provider)) {
      throw new Error(`${provider} 제공자는 인증되지 않아 사용할 수 없습니다.`);
    }
    if (provider === "claude") {
      // synth 조용한 경로도 일반 실행처럼 토큰을 회전한다: 고른 토큰이 한도(rate-limit)면
      // 그 토큰을 봉인(noteRateLimited)하고 풀의 다음 살아있는 토큰으로 즉시 재시도한다.
      // 살아있는 토큰이 2개 이상이면 한 토큰 한도로 후보가 통째로 탈락하는 일이 줄어든다.
      // 한도 외 오류는 회전하지 않고 그대로 던지고, 모든 토큰이 소진됐으면 마지막 오류를 던진다.
      const tried = new Set<string>();
      let lastError: unknown;
      for (let attempt = 0; attempt < this.tokenPool.size; attempt += 1) {
        const claudeModel = options.claudeModelOverride ?? session.model ?? DEFAULT_CLAUDE_MODEL;
        const oauthToken = this.selectClaudeToken(session, claudeModel);
        if (tried.has(oauthToken)) break; // 더 시도할 새 토큰이 없다(전부 소진).
        tried.add(oauthToken);
        const controller = new AbortController();
        this.silentControllers.add(controller);
        const run: ActiveRun = {
          controller,
          input: new MessageQueue(),
          pendingTurns: 0,
          startedAt: Date.now(),
          codexTimers: new Map(),
          codexStarts: new Map(),
          mcpFailures: new Map()
        };
        const timeout = options.timeoutMs
          ? setTimeout(() => controller.abort(), options.timeoutMs)
          : null;
        try {
          return await this.runReadOnlyClaude(
            session,
            controller,
            run,
            prompt,
            oauthToken,
            false,
            options.claudeModelOverride,
            options.claudeThinkingOverride,
            options.claudeEffortOverride,
            options.toolFree ?? false
          );
        } catch (error) {
          lastError = error;
          if (!isRateLimitError(error)) throw error;
          const resetsAt = snapshotFromRateLimitError(error)?.fiveHour?.resetsAt;
          this.tokenPool.noteRateLimited(
            oauthToken,
            Date.now(),
            resetsAt ? Date.parse(resetsAt) : undefined
          );
        } finally {
          if (timeout) clearTimeout(timeout);
          controller.abort();
          this.silentControllers.delete(controller);
        }
      }
      throw lastError ?? new Error("Claude 읽기 전용 단계 실패: 사용 가능한 토큰이 없습니다.");
    }
    if (provider === "codex") {
      // Codex 계정도 동일하게 회전한다: 현재 계정이 한도면 markFailed로 봉인(+SQLite 영속)하고
      // 다음 살아있는 계정으로 재시도한다. 한도 외 오류(예: auth 만료)는 그대로 던진다.
      const tried = new Set<string>();
      let lastError: unknown;
      for (let attempt = 0; attempt < this.codexAccountPool.size; attempt += 1) {
        const codexHome = this.selectCodexHome(session);
        if (tried.has(codexHome)) break;
        tried.add(codexHome);
        let isolated: ReturnType<SessionManager["createToolFreeCodexClient"]> | null = null;
        try {
          isolated = options.toolFree ? this.createToolFreeCodexClient(codexHome) : null;
          const codex = isolated?.codex ?? createCodexClient(this.options, codexHome);
          const model = options.codexModelOverride ?? session.codexModel ?? DEFAULT_CODEX_MODEL;
          const reasoning = options.codexReasoningOverride
            ?? (session.codexReasoning as CodexReasoningEffort | null)
            ?? DEFAULT_CODEX_REASONING;
          const threadSession = isolated ? { ...session, cwd: isolated.workspace } : session;
          const thread = codex.startThread(
            buildCodexThreadOptions(threadSession, model, reasoning, "plan", false)
          );
          const controller = new AbortController();
          this.silentControllers.add(controller);
          const timeout = options.timeoutMs
            ? setTimeout(() => controller.abort(), options.timeoutMs)
            : null;
          try {
            const result = await thread.run(prompt, { signal: controller.signal });
            return result.finalResponse.trim();
          } finally {
            if (timeout) clearTimeout(timeout);
            controller.abort();
            this.silentControllers.delete(controller);
          }
        } catch (error) {
          lastError = error;
          if (!isRateLimitError(error)) throw error;
          const resetsAt = snapshotFromRateLimitError(error)?.fiveHour?.resetsAt;
          this.codexAccountPool.markFailed(
            codexHome,
            Date.now(),
            resetsAt ? Date.parse(resetsAt) : undefined
          );
          this.persistCodexAccountState();
        } finally {
          isolated?.dispose();
        }
      }
      throw lastError ?? new Error("Codex 읽기 전용 단계 실패: 사용 가능한 계정이 없습니다.");
    }
    if (provider === "grok") {
      const timeoutMs = options.timeoutMs ?? this.options.providerTurnTimeoutMs;
      const controller = new AbortController();
      this.silentControllers.add(controller);
      const timeout = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const result = await runGrokCli(prompt, {
          executable: this.options.grokExecutable ?? "grok",
          cwd: session.cwd,
          model: session.grokModel ?? this.options.grokModel ?? DEFAULT_GROK_MODEL,
          reasoningEffort: session.grokReasoning ?? DEFAULT_GROK_REASONING,
          supportedReasoningEfforts: this.options.modelCatalog.grokReasoningEfforts,
          ...(timeoutMs ? { timeoutMs } : {}),
          permissionMode: "plan",
          ...(options.toolFree
            ? { toolFree: true }
            : {
                rules: buildProviderBootstrap(session, this.options.claudeMemoryDir, {
                  includeInteractiveProtocols: false,
                  permissionMode: "plan"
                })
              })
        }, controller.signal);
        return result.text.trim();
      } finally {
        if (timeout) clearTimeout(timeout);
        controller.abort();
        this.silentControllers.delete(controller);
      }
    }
    if (provider === "cline") {
      return this.clineExecutor.runReadOnly(session, prompt, {
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.toolFree !== undefined ? { toolFree: options.toolFree } : {})
      });
    }
    const tempSession: SessionRecord = {
      ...session,
      id: `${session.id}:synth:${randomUUID()}`,
      permissionMode: "plan"
    };
    const controller = new AbortController();
    this.silentControllers.add(controller);
    const timeout = options.timeoutMs
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : null;
    try {
      return await this.agyExecutor.runOneOff(tempSession, prompt, "plan", controller.signal);
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
      this.silentControllers.delete(controller);
    }
  }
  private async safeRename(session: SessionRecord, title: string): Promise<void> {
    await this.transport.renameTopic(session.chatId, session.topicId, title).catch((error) => {
      console.error("Telegram topic rename failed:", safeErrorMessage(error));
    });
  }
}
