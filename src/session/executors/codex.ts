import {
  Codex,
  type Thread,
  type ThreadOptions,
  type Usage as CodexSdkUsage
} from "@openai/codex-sdk";
import { copyRolloutToHome } from "../../codex-rollout.js";
import type { CodexAccountPool } from "../../codex-account-pool.js";
import {
  codexModelLabel,
  codexReasoningLabel,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING,
  type CodexReasoningEffort
} from "../../model-catalog.js";
import { syncSharedResourcesCached } from "../../resource-sync.js";
import { MessageQueue } from "../../session-collectors.js";
import {
  buildCodexEnvironment,
  codexSandboxMode,
  codexSharedResourceConfig,
  ensureCodexMcpConfigForHome,
  requireCodexSubscriptionAuth
} from "../../session-environment.js";
import { buildProviderBootstrap, buildUserMessage } from "../../session-prompts.js";
import { isQwenSubagentModel, QWEN_SUBAGENT_TOOL_NAME } from "../../qwen-subagent.js";
import {
  isNoRolloutError,
  isRateLimitError,
  isTransientStreamError
} from "../../session-usage.js";
import {
  limitResumeRequest,
  promptForCodexRequest,
  type RunRequest
} from "../prompt-builders.js";
import {
  degradedPlanForProvider,
  normalizeCodexItem
} from "../provider-progress.js";
import { StreamRenderer } from "../../stream-renderer.js";
import { safeErrorMessage } from "../../telegram-transport.js";
import type { SessionRecord } from "../../types.js";
import {
  queueRequestedUserInput,
  type ActiveRun,
  type BaseExecutorHost,
  type ExecutorOptions
} from "./shared.js";

const DEFAULT_CODEX_TRANSIENT_STREAM_RETRIES = 3;

export interface CodexRunContext {
  request: RunRequest;
  session: SessionRecord;
  renderer: StreamRenderer;
  run: ActiveRun;
  controller: AbortController;
  input: MessageQueue;
  timedOut: boolean;
  turnTimeout?: NodeJS.Timeout | undefined;
  lastResponse: string;
  lastAgentMessage: string;
  codexThreadId: string | null;
  codexHome: string;
  /** prepareRun에서 계정 로테이션을 이미 적용했는지 — startRun 재선택 시 유지한다. */
  accountRotateApplied: boolean;
  codexGoalSyncedThreadId?: string | null;
}

interface CodexExecutionState {
  codexModel: string;
  codexReasoning: CodexReasoningEffort;
  thread: Thread;
  bootstrap: string;
  iterator: AsyncIterator<ReturnType<typeof buildUserMessage>>;
  pending: IteratorResult<ReturnType<typeof buildUserMessage>>;
  firstTurn: boolean;
}

export interface CodexExecutorHost extends BaseExecutorHost {
  accountPool: CodexAccountPool;
  oauthTokens: string[];
  goalClientAvailable: boolean;
  selectHome: (
    session?: SessionRecord,
    options?: { rotateFromSession?: boolean }
  ) => string;
  recordUsage: (
    codexHome: string,
    usage: CodexSdkUsage,
    model: string,
    reasoning: string
  ) => void;
  setNativeGoal: (session: SessionRecord, condition: string) => Promise<unknown>;
  clearGoal: (sessionId: string) => void;
  markRateLimited: (codexHome: string, error: unknown) => void;
  reconcileAccounts: (
    cwd: string,
    options: { excludeHome?: string }
  ) => Promise<void>;
  enqueue: (request: RunRequest) => void;
  scheduleLimitResume: (
    session: SessionRecord,
    request: RunRequest,
    resumeSessionId: string | null,
    resumeAt: number
  ) => void;
}

export interface CodexExecutorDependencies {
  createClient: typeof createCodexClient;
  copyRollout: typeof copyRolloutToHome;
}

const DEFAULT_DEPENDENCIES: CodexExecutorDependencies = {
  createClient: createCodexClient,
  copyRollout: copyRolloutToHome
};

/** 인증·공유 리소스·환경 설정을 한 번의 공통 경로로 구성한다. */
function isAlibabaTokenPlanModel(options: ExecutorOptions, model: string): boolean {
  return Boolean(options.alibabaTokenPlan) && options.modelCatalog.codexModels.some((option) =>
    option.source === "token-plan" && option.id.toLowerCase() === model.toLowerCase()
  );
}

export function createCodexClient(
  options: ExecutorOptions,
  codexHome: string,
  model: string,
  subagentModel?: string | null,
  subagentReasoning?: string | null
): Codex {
  requireCodexSubscriptionAuth(codexHome);
  syncSharedResourcesCached();
  // 계정 전환·앱 재배포 뒤에도 선택 계정이 현재 공유 MCP 레지스트리를 즉시 쓰게 한다.
  ensureCodexMcpConfigForHome(codexHome);
  const usesAlibabaTokenPlan = isAlibabaTokenPlanModel(options, model);
  const alibaba = options.alibabaTokenPlan;
  const qwenSubagent = isQwenSubagentModel(options.modelCatalog, subagentModel);
  return new Codex({
    ...(options.codexExecutable ? { codexPathOverride: options.codexExecutable } : {}),
    env: buildCodexEnvironment(codexHome),
    config: {
      ...codexSharedResourceConfig(
        subagentModel,
        qwenSubagent ? subagentModel : null,
        subagentReasoning
      ),
      ...(usesAlibabaTokenPlan && alibaba ? {
        model_provider: "alibaba_token_plan",
        model_providers: {
          alibaba_token_plan: {
            name: "Alibaba Cloud Model Studio Token Plan",
            base_url: alibaba.baseUrl,
            env_key: "DASHSCOPE_API_KEY",
            wire_api: "chat"
          }
        }
      } : {})
    }
  });
}

export function buildCodexThreadOptions(
  session: SessionRecord,
  model: string,
  reasoning: CodexReasoningEffort,
  permissionMode: SessionRecord["permissionMode"] = session.permissionMode,
  webSearchEnabled = true
): ThreadOptions {
  return {
    model,
    modelReasoningEffort: reasoning,
    workingDirectory: session.cwd,
    skipGitRepoCheck: true,
    sandboxMode: codexSandboxMode(permissionMode),
    approvalPolicy: "never",
    webSearchEnabled
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("turn aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("turn aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Codex SDK 스레드, 스트림 재시도, 계정 전환과 실행 자원을 전담한다. */
export class CodexExecutor {
  constructor(
    private readonly host: CodexExecutorHost,
    private readonly dependencies: CodexExecutorDependencies = DEFAULT_DEPENDENCIES
  ) {}

  async execute(request: RunRequest): Promise<void> {
    const ctx = this.prepareRun(request);
    if (!ctx) return;
    try {
      const state = await this.startRun(ctx);
      await this.runTurnLoop(ctx, state);
      await this.finalizeRun(ctx);
    } catch (error) {
      await this.handleRunError(error, ctx);
    } finally {
      this.cleanupRun(ctx);
    }
  }

  private prepareRun(request: RunRequest): CodexRunContext | null {
    if (this.host.deleting.has(request.session.id)) return null;
    let session = this.host.store.getSession(request.session.id);
    if (!session) return null;
    request = this.host.applyHandoffSummary(request, session);
    session = this.host.store.getSession(request.session.id) ?? session;
    const accountRotateApplied = request.codexRotateOnStart === true;
    const codexHome = this.host.selectHome(session, {
      rotateFromSession: accountRotateApplied
    });
    if (accountRotateApplied) request = { ...request, codexRotateOnStart: false };

    const renderer = new StreamRenderer(
      session,
      this.host.transport,
      this.host.options.debounceMs,
      {
        resolveStatus: () => this.host.store.getSession(session.id)?.status
      }
    );
    renderer.setRemainingPlan(degradedPlanForProvider("codex"));
    const controller = new AbortController();
    const input = new MessageQueue();
    input.push(buildUserMessage(promptForCodexRequest(request)));
    const run: ActiveRun = {
      controller,
      input,
      pendingTurns: 1,
      startedAt: Date.now(),
      codexTimers: new Map(),
      codexStarts: new Map(),
      mcpFailures: new Map(),
      progressNote: (message) => renderer.note(message),
      progressDecision: (message) => renderer.decision(message),
      progressFlush: () => renderer.flushNow()
    };
    this.host.active.set(session.id, run);
    return {
      request,
      session,
      renderer,
      run,
      controller,
      input,
      timedOut: false,
      lastResponse: "",
      lastAgentMessage: "",
      codexThreadId: session.codexThreadId,
      codexHome,
      accountRotateApplied,
      codexGoalSyncedThreadId: null
    };
  }

  private persistThreadId(ctx: CodexRunContext, state: CodexExecutionState): boolean {
    if (!state.thread.id || state.thread.id === ctx.codexThreadId) return false;
    ctx.codexThreadId = state.thread.id;
    this.host.store.updateSession(ctx.session.id, { codexThreadId: ctx.codexThreadId });
    return true;
  }

  private async startRun(ctx: CodexRunContext): Promise<CodexExecutionState> {
    await this.host.safeRename(ctx.session, `[RUNNING] ${ctx.session.title}`);
    await ctx.renderer.start(false);
    this.host.store.updateSession(ctx.session.id, { status: "running" });

    // 시작 직전 live 한도로 소진 봉인을 갱신한다. 재시작 복원·과거 오류 봉인이
    // 여유 있는 #2/#3을 막고 soonest #1로 몰아넣는 경로를 여기서 끊는다.
    await this.host.reconcileAccounts(ctx.session.cwd, {});
    ctx.codexHome = this.host.selectHome(ctx.session, {
      rotateFromSession: ctx.accountRotateApplied
    });
    // 명시 계정이 없고 자동 선택 홈만 소진된 경우에 한해 다른 가용 홈으로 옮긴다.
    // 세션에 codexHome이 있으면 selectHome이 이미 그 홈을 반환하므로 가로채지 않는다.
    if (
      !ctx.session.codexHome
      && this.host.accountPool.isExhausted(ctx.codexHome)
    ) {
      ctx.codexHome = this.host.selectHome(ctx.session);
    }
    if (ctx.session.codexHome !== ctx.codexHome) {
      this.host.store.updateSession(ctx.session.id, { codexHome: ctx.codexHome });
      ctx.session = this.host.store.getSession(ctx.session.id) ?? ctx.session;
    }
    const codexModel = ctx.session.codexModel ?? DEFAULT_CODEX_MODEL;
    const codexReasoning =
      (ctx.session.codexReasoning as CodexReasoningEffort | null) ?? DEFAULT_CODEX_REASONING;
    const codex = this.dependencies.createClient(
      this.host.options,
      ctx.codexHome,
      codexModel,
      ctx.session.subagentModel,
      ctx.session.subagentReasoning
    );
    const threadOptions = buildCodexThreadOptions(
      ctx.session,
      codexModel,
      codexReasoning
    );
    const thread = ctx.codexThreadId
      ? codex.resumeThread(ctx.codexThreadId, threadOptions)
      : codex.startThread(threadOptions);
    ctx.renderer.note(
      `Codex 실행 (${codexModelLabel(this.host.options.modelCatalog, codexModel)}`
      + ` · reasoning ${codexReasoningLabel(codexReasoning)})`
    );
    // native thread에는 첫 ChatKJB 턴에서만 정적 harness를 넣는다. 재개 thread는 이미
    // 같은 내용을 대화 기록에 보유하므로 매 execute마다 다시 넣지 않는다.
    const firstTurn = ctx.codexThreadId === null;
    const qwenSubagent = isQwenSubagentModel(
      this.host.options.modelCatalog,
      ctx.session.subagentModel
    );
    const bootstrap = firstTurn
      ? buildProviderBootstrap(ctx.session, this.host.options.claudeMemoryDir, {
        prefixSections: qwenSubagent
          ? [
            `Qwen 하위 작업은 반드시 ${QWEN_SUBAGENT_TOOL_NAME} 도구로 위임하십시오. `
            + "요청을 작고 독립적으로 나누고, 필요한 파일 내용과 조사 결과를 context에 함께 전달한 뒤 응답을 직접 검증·통합하십시오."
          ]
          : []
      })
      : "";
    const iterator = ctx.input[Symbol.asyncIterator]();
    const pending = await iterator.next();
    return { codexModel, codexReasoning, thread, bootstrap, iterator, pending, firstTurn };
  }

  private async runAttempt(
    ctx: CodexRunContext,
    state: CodexExecutionState,
    initialPrompt: string
  ): Promise<string> {
    let turnPrompt = initialPrompt;
    let attemptResponse = "";
    let transientRetries = 0;
    const maxTransientRetries =
      this.host.options.codexTransientStreamRetries ?? DEFAULT_CODEX_TRANSIENT_STREAM_RETRIES;
    while (true) {
      ctx.controller = new AbortController();
      ctx.run.controller = ctx.controller;
      ctx.run.codexCurrentPrompt = turnPrompt;
      delete ctx.run.codexRestartPrompt;
      const memoryPrefix = state.firstTurn && ctx.request.operation !== "native_command"
        ? `${state.bootstrap}\n\n`
        : "";
      ctx.run.codexStarts.set("codex", Date.now());
      ctx.timedOut = false;
      if (ctx.turnTimeout) clearTimeout(ctx.turnTimeout);
      ctx.turnTimeout = undefined;
      if (this.host.options.providerTurnTimeoutMs) {
        ctx.turnTimeout = setTimeout(() => {
          ctx.timedOut = true;
          ctx.controller.abort();
        }, this.host.options.providerTurnTimeoutMs);
      }
      let hasVisibleOutput = false;
      const noVisibleOutputNotice = setTimeout(() => {
        if (
          hasVisibleOutput
          || ctx.timedOut
          || ctx.run.stopRequested
          || ctx.controller.signal.aborted
        ) return;
        ctx.renderer.note(
          "Codex가 아직 답변 본문 없이 추론 중입니다. 계속 기다리거나 중단 후 reasoning을 낮춰 다시 시도할 수 있습니다."
        );
      }, 30_000);

      let completed = false;
      let transientRetry = 0;
      try {
        const streamed = await state.thread.runStreamed(`${memoryPrefix}${turnPrompt}`, {
          signal: ctx.controller.signal
        });
        for await (const event of streamed.events) {
          this.persistThreadId(ctx, state);
          if (event.type === "item.completed") {
            if (event.item.type === "agent_message") {
              hasVisibleOutput = true;
              attemptResponse = event.item.text;
              ctx.lastAgentMessage = event.item.text;
              await ctx.renderer.text(event.item.text);
            }
            const progress = normalizeCodexItem(event.item);
            if (progress) {
              hasVisibleOutput = true;
              if (progress.remainingPlan) {
                ctx.renderer.setRemainingPlan(progress.remainingPlan);
              }
              if (progress.kind === "plan") {
                ctx.renderer.setActivity(progress.summary);
                ctx.renderer.note(progress.summary);
              } else {
                ctx.renderer.note(progress.summary);
              }
            }
          } else if (event.type === "item.updated") {
            if (event.item.type === "agent_message") {
              hasVisibleOutput = true;
              ctx.renderer.partial(event.item.text);
            }
          } else if (event.type === "turn.completed") {
            completed = true;
            this.host.recordUsage(
              ctx.codexHome,
              event.usage,
              state.codexModel,
              state.codexReasoning
            );
          } else if (event.type === "turn.failed") {
            throw new Error(`Codex 실행 실패: ${event.error.message}`);
          } else if (event.type === "error") {
            throw new Error(`Codex 스트림 오류: ${event.message}`);
          }
        }
      } catch (error) {
        if (
          !ctx.controller.signal.aborted
          || !ctx.run.codexRestartPrompt
          || ctx.timedOut
          || ctx.run.stopRequested
        ) {
          if (
            !ctx.timedOut
            && !ctx.run.stopRequested
            && !ctx.controller.signal.aborted
            && !isRateLimitError(error)
            && isTransientStreamError(error)
            && transientRetries < maxTransientRetries
          ) {
            transientRetries += 1;
            transientRetry = Math.min(2_000 * transientRetries, 8_000);
            ctx.renderer.note(
              `Codex 스트림이 서버에서 끊겼습니다. ${Math.round(transientRetry / 1000)}초 후 같은 스레드로 재시도합니다 (${transientRetries}/${maxTransientRetries}).`
            );
          } else {
            throw error;
          }
        }
      } finally {
        ctx.run.codexStarts.delete("codex");
        delete ctx.run.codexCurrentPrompt;
        if (ctx.turnTimeout) clearTimeout(ctx.turnTimeout);
        clearTimeout(noVisibleOutputNotice);
      }
      if (transientRetry > 0) {
        await abortableDelay(transientRetry, ctx.controller.signal);
        continue;
      }
      if (ctx.run.codexRestartPrompt && !ctx.timedOut && !ctx.run.stopRequested) {
        turnPrompt = ctx.run.codexRestartPrompt;
        delete ctx.run.codexRestartPrompt;
        attemptResponse = "";
        ctx.renderer.note("Codex 현재 턴을 /steer 지시로 중단하고 다시 시작합니다.");
        continue;
      }
      if (ctx.timedOut || ctx.controller.signal.aborted) throw new Error("turn aborted");
      if (!completed) throw new Error("Codex 실행이 완료 이벤트 없이 종료되었습니다.");
      return attemptResponse;
    }
  }

  private async runTurnLoop(ctx: CodexRunContext, state: CodexExecutionState): Promise<void> {
    while (!state.pending.done) {
      const content = state.pending.value.message.content;
      const turnPrompt = typeof content === "string" ? content : ctx.request.prompt;
      const response = await this.runAttempt(ctx, state, turnPrompt);
      const visibleResponse = await queueRequestedUserInput(
        this.host,
        ctx.session,
        ctx.run,
        ctx.input,
        ctx.controller.signal,
        response
      );
      this.persistThreadId(ctx, state);
      if (ctx.codexThreadId && ctx.codexGoalSyncedThreadId !== ctx.codexThreadId) {
        const updated = this.host.store.getSession(ctx.session.id);
        if (updated?.goalCondition && this.host.goalClientAvailable) {
          await this.host.setNativeGoal(updated, updated.goalCondition).catch((error: unknown) => {
            this.host.clearGoal(updated.id);
            const message = safeErrorMessage(error, this.host.oauthTokens);
            console.warn(`Codex native goal sync failed: ${message}`);
            void this.host.transport.sendText(
              updated.chatId,
              updated.topicId,
              `Codex 네이티브 goal 전달에 실패했습니다: ${message}`
            ).catch(() => undefined);
          });
        }
        ctx.codexGoalSyncedThreadId = ctx.codexThreadId;
      }
      ctx.lastResponse = visibleResponse || ctx.lastResponse;
      state.firstTurn = false;
      ctx.run.pendingTurns = Math.max(0, ctx.run.pendingTurns - 1);
      if (ctx.run.pendingTurns === 0) break;
      ctx.renderer.note(`예약 메시지 ${ctx.run.pendingTurns}개 처리 대기`);
      state.pending = await state.iterator.next();
    }
  }

  private async finalizeRun(ctx: CodexRunContext): Promise<void> {
    if (ctx.request.operation === "compact") {
      this.host.store.updateSession(ctx.session.id, {
        status: "done",
        codexThreadId: null,
        handoffSummary: ctx.lastResponse
      });
      await ctx.renderer.finish(
        "done",
        "컨텍스트 압축 완료: 다음 턴은 압축 요약으로 새 Codex 스레드에서 이어집니다."
      );
    } else {
      this.host.store.updateSession(ctx.session.id, { status: "done" });
      await ctx.renderer.finish(
        "done",
        ctx.lastResponse ? "" : "Codex가 텍스트 응답 없이 작업을 마쳤습니다."
      );
    }
    await this.host.safeRename(ctx.session, `[DONE] ${ctx.session.title}`);
  }

  private async replayLastAgentMessage(ctx: CodexRunContext): Promise<void> {
    if (ctx.lastAgentMessage.trim()) {
      await ctx.renderer.text(ctx.lastAgentMessage).catch(() => undefined);
    }
  }

  private async handleRunError(error: unknown, ctx: CodexRunContext): Promise<void> {
    if (this.host.deleting.has(ctx.session.id) || !this.host.store.getSession(ctx.session.id)) return;
    if (ctx.timedOut) {
      console.error(
        `Codex run failed (session=${ctx.session.id}):`,
        safeErrorMessage(error, this.host.oauthTokens)
      );
      await this.replayLastAgentMessage(ctx);
      const minutes = Math.round((this.host.options.providerTurnTimeoutMs ?? 0) / 60_000);
      this.host.store.updateSession(ctx.session.id, { status: "error" });
      await ctx.renderer.finish("error", `Codex 턴이 ${minutes}분 제한을 초과해 중단되었습니다.`);
      await this.host.safeRename(ctx.session, `[STALL] ${ctx.session.title}`);
      return;
    }
    // 서비스 재시작 정리 abort는 새 데몬의 자동 복구가 이어받도록 running 상태를 남긴다.
    if (ctx.run.serviceShutdownRequested && ctx.controller.signal.aborted) return;
    console.error(
      `Codex run failed (session=${ctx.session.id}):`,
      safeErrorMessage(error, this.host.oauthTokens)
    );
    if (ctx.controller.signal.aborted) {
      await this.replayLastAgentMessage(ctx);
      this.host.store.updateSession(ctx.session.id, { status: "aborted" });
      await ctx.renderer.finish("aborted", "사용자가 작업을 중단했습니다.");
      await this.host.safeRename(ctx.session, `[STOP] ${ctx.session.title}`);
      return;
    }
    if (
      isNoRolloutError(error)
      && ctx.codexThreadId
      && (ctx.request.rolloutResetCount ?? 0) < 1
    ) {
      await this.host.transport.sendText(
        ctx.session.chatId,
        ctx.session.topicId,
        "Codex 스레드 기록(rollout)이 유실되어 새 스레드로 이어서 다시 실행합니다."
      ).catch(() => undefined);
      await this.host.safeRename(ctx.session, `[RETRY] ${ctx.session.title}`);
      this.host.store.updateSession(ctx.session.id, { status: "queued", codexThreadId: null });
      this.host.enqueue({
        ...limitResumeRequest(ctx.request, true),
        rolloutResetCount: (ctx.request.rolloutResetCount ?? 0) + 1
      });
      return;
    }
    if (isRateLimitError(error)) {
      await this.handleRateLimit(error, ctx);
      return;
    }
    await this.finishGenericError(error, ctx);
  }

  private async handleRateLimit(error: unknown, ctx: CodexRunContext): Promise<void> {
    this.host.markRateLimited(ctx.codexHome, error);
    const attempts = (ctx.request.autoSwitchCount ?? 0) + 1;
    let nextHome = this.host.accountPool.selectNext(ctx.codexHome);
    let canAutoSwitch = this.host.accountPool.size > 1
      && attempts < this.host.accountPool.size
      && !this.host.accountPool.isExhausted(nextHome);
    if (!canAutoSwitch && this.host.accountPool.size > 1) {
      await this.host.reconcileAccounts(ctx.session.cwd, { excludeHome: ctx.codexHome });
      nextHome = this.host.accountPool.selectNext(ctx.codexHome);
      canAutoSwitch = nextHome !== ctx.codexHome
        && attempts < this.host.accountPool.size
        && !this.host.accountPool.isExhausted(nextHome);
    }
    if (canAutoSwitch) {
      const fromIndex = this.host.accountPool.indexOf(ctx.codexHome);
      const nextIndex = this.host.accountPool.indexOf(nextHome);
      let carried = false;
      if (ctx.codexThreadId) {
        carried = this.dependencies.copyRollout(
          ctx.codexHome,
          nextHome,
          ctx.codexThreadId
        ) !== null;
      }
      await this.host.transport.sendText(
        ctx.session.chatId,
        ctx.session.topicId,
        carried
          ? `Codex 계정 #${fromIndex + 1} 한도 도달 → 계정 #${nextIndex + 1}로 자동 전환해 같은 스레드로 이어서 실행합니다.`
          : `Codex 계정 #${fromIndex + 1} 한도 도달 → 계정 #${nextIndex + 1}로 자동 전환해 새 스레드로 이어서 실행합니다.`
      ).catch(() => undefined);
      await this.host.safeRename(ctx.session, `[SWITCH] ${ctx.session.title}`);
      this.host.store.updateSession(
        ctx.session.id,
        carried
          ? { status: "queued", codexHome: nextHome }
          : { status: "queued", codexThreadId: null, codexHome: nextHome }
      );
      this.host.enqueue({
        ...limitResumeRequest(ctx.request, !carried),
        autoSwitchCount: attempts
      });
      return;
    }
    const resumeAt = this.host.accountPool.recoversAt();
    if (resumeAt !== null) {
      ctx.renderer.note(
        this.host.accountPool.size > 1
          ? "모든 Codex 계정이 한도에 도달했습니다. Codex 회복 시각에 자동 재개를 예약합니다."
          : "Codex 계정이 한도에 도달했습니다. Codex 회복 시각에 자동 재개를 예약합니다."
      );
      this.host.scheduleLimitResume(ctx.session, ctx.request, null, resumeAt);
      return;
    }
    await this.finishGenericError(error, ctx);
  }

  private async finishGenericError(error: unknown, ctx: CodexRunContext): Promise<void> {
    await this.replayLastAgentMessage(ctx);
    this.host.store.updateSession(ctx.session.id, { status: "error" });
    await ctx.renderer.finish("error", `Codex 실행 실패: ${safeErrorMessage(error)}`);
    await this.host.safeRename(ctx.session, `[ERROR] ${ctx.session.title}`);
  }

  private cleanupRun(ctx: CodexRunContext): void {
    if (ctx.turnTimeout) clearTimeout(ctx.turnTimeout);
    ctx.renderer.dispose();
    ctx.input.cancel();
    if (this.host.active.get(ctx.session.id) === ctx.run) {
      this.host.active.delete(ctx.session.id);
    }
  }
}
