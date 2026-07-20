import {
  ALL_DEFAULT_TOOL_NAMES,
  ClineCore,
  computePatchChanges,
  createBuiltinTools,
  createDefaultExecutors,
  type AgentResult,
  type AgentTool,
  type AgentToolContext,
  type ApplyPatchInput,
  type ApplyPatchExecutor,
  type CoreSessionEvent,
  type EditFileInput,
  type EditorExecutor,
  type PatchFileChange,
  type ShellExecutor,
  type StructuredCommandInput,
  type ToolApprovalRequest,
  type ToolApprovalResult
} from "@cline/sdk";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  CLINE_AUDITED_TOOL_NAMES,
  classifyClineAutoCommand,
  clineToolBoundary,
  isPathWithinWorkspace
} from "../../cline-permissions.js";
import { resolveClineConnection } from "../../cline-sdk.js";
import type { PermissionBroker } from "../../permission-broker.js";
import { MessageQueue } from "../../session-collectors.js";
import { buildProviderBootstrap, buildUserMessage } from "../../session-prompts.js";
import { StreamRenderer } from "../../stream-renderer.js";
import { safeErrorMessage } from "../../telegram-transport.js";
import type { SessionRecord } from "../../types.js";
import { promptForCodexRequest, type RunRequest } from "../prompt-builders.js";
import {
  queueRequestedUserInput,
  type ActiveRun,
  type BaseExecutorHost
} from "./shared.js";

export interface ClineExecutorHost extends BaseExecutorHost {
  permissions: PermissionBroker;
}

export interface ClineCoreLike {
  start: ClineCore["start"];
  send: ClineCore["send"];
  abort: ClineCore["abort"];
  dispose: ClineCore["dispose"];
  delete: ClineCore["delete"];
  get: ClineCore["get"];
  readMessages: ClineCore["readMessages"];
  getAccumulatedUsage: ClineCore["getAccumulatedUsage"];
  updateSessionConnection: ClineCore["updateSessionConnection"];
  subscribe: ClineCore["subscribe"];
}

export interface ClineExecutorDependencies {
  createCore: (requestApproval: (request: ToolApprovalRequest) => Promise<ToolApprovalResult>) => Promise<ClineCoreLike>;
  resolveConnection: typeof resolveClineConnection;
  createSessionId: () => string;
}

const DEFAULT_DEPENDENCIES: ClineExecutorDependencies = {
  createCore: (requestApproval) => ClineCore.create({
    clientName: "chatkjb",
    backendMode: "local",
    capabilities: { requestToolApproval: requestApproval }
  }),
  resolveConnection: resolveClineConnection,
  createSessionId: randomUUID
};

function inputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function assertWorkspacePath(path: string, cwd: string): void {
  const absolute = resolve(cwd, path);
  if (isPathWithinWorkspace(absolute, cwd)) return;
  // 새 파일의 realpath는 아직 없으므로 기존 부모도 확인한다.
  if (isPathWithinWorkspace(dirname(absolute), cwd)) return;
  throw new Error("Cline 파일 작업이 프로젝트 작업공간 밖을 가리켜 거부되었습니다.");
}

function collectPublicText(event: CoreSessionEvent): string | null {
  if (event.type !== "agent_event") return null;
  const agentEvent = event.payload.event;
  if (agentEvent.type === "content_end" && agentEvent.contentType === "text") {
    return agentEvent.text?.trim() || null;
  }
  if (agentEvent.type === "done") return agentEvent.text.trim() || null;
  return null;
}

export class ClineExecutor {
  private corePromise: Promise<ClineCoreLike> | null = null;
  private readonly hydrated = new Set<string>();
  private readonly hydration = new Map<string, Promise<void>>();
  private readonly chatSessionByClineId = new Map<string, string>();

  constructor(
    private readonly host: ClineExecutorHost,
    private readonly dependencies: ClineExecutorDependencies = DEFAULT_DEPENDENCIES
  ) {}

  private core(): Promise<ClineCoreLike> {
    this.corePromise ??= this.dependencies.createCore((request) => this.requestApproval(request));
    return this.corePromise;
  }

  private async requestApproval(request: ToolApprovalRequest): Promise<ToolApprovalResult> {
    const chatSessionId = this.chatSessionByClineId.get(request.sessionId);
    const session = chatSessionId ? this.host.store.getSession(chatSessionId) : undefined;
    const run = chatSessionId ? this.host.active.get(chatSessionId) : undefined;
    if (!session || !run || run.controller.signal.aborted) {
      return { approved: false, reason: "ChatKJB 실행 세션을 확인할 수 없습니다." };
    }
    try {
      const result = await this.host.permissions.request(
        session,
        request.toolName,
        inputRecord(request.input),
        {
          signal: run.controller.signal,
          toolUseID: request.toolCallId,
          suggestions: [],
          title: `[CLINE APPROVAL] ${request.toolName}`
        }
      );
      return result.behavior === "allow"
        ? { approved: true }
        : { approved: false, reason: result.message || "사용자가 거부했습니다." };
    } catch {
      return { approved: false, reason: "승인 요청을 처리하지 못해 기본 거부했습니다." };
    }
  }

  private selection(session: SessionRecord) {
    const providerId = session.clineProviderId?.trim()
      || this.host.options.modelCatalog.clineProviders?.[0]?.id;
    if (!providerId) throw new Error("실행 가능한 Cline 내부 제공자가 없습니다.");
    const provider = this.host.options.modelCatalog.clineProviders?.find((item) => item.id === providerId);
    const modelId = session.clineModel?.trim()
      || provider?.defaultModelId
      || this.host.options.modelCatalog.clineModelsByProvider?.[providerId]?.[0]?.id;
    if (!modelId) throw new Error(`Cline 제공자 ${providerId}에서 사용할 모델을 찾지 못했습니다.`);
    return { providerId, modelId };
  }

  private async connection(session: SessionRecord) {
    const { providerId, modelId } = this.selection(session);
    return this.dependencies.resolveConnection(providerId, modelId, session.clineReasoning);
  }

  private tools(session: SessionRecord, readOnly = false, toolFree = false) {
    if (toolFree) return { tools: [], policies: {} };
    const boundary = clineToolBoundary(session.permissionMode, readOnly);
    const defaults = createDefaultExecutors({
      editor: { restrictToCwd: true },
      applyPatch: { restrictToCwd: true },
      bash: { timeoutMs: this.host.options.providerTurnTimeoutMs ?? 30_000 }
    });
    const editor: EditorExecutor = async (
      input: EditFileInput,
      cwd: string,
      context: AgentToolContext
    ) => {
      assertWorkspacePath(input.path, cwd);
      if (!defaults.editor) throw new Error("Cline editor executor가 없습니다.");
      return defaults.editor(input, cwd, context);
    };
    const applyPatch: ApplyPatchExecutor = async (
      input: ApplyPatchInput,
      cwd: string,
      context: AgentToolContext
    ) => {
      const patch = input.input;
      const preview = await computePatchChanges(patch, cwd, { restrictToCwd: true });
      for (const [path, change] of Object.entries(preview.changes) as Array<[string, PatchFileChange]>) {
        assertWorkspacePath(path, cwd);
        if (change.movePath) assertWorkspacePath(change.movePath, cwd);
      }
      if (!defaults.applyPatch) throw new Error("Cline apply_patch executor가 없습니다.");
      return defaults.applyPatch(input, cwd, context);
    };
    const bash: ShellExecutor = async (
      command: string | StructuredCommandInput,
      cwd: string,
      context: AgentToolContext
    ) => {
      if (session.permissionMode === "plan" || readOnly || session.permissionMode === "dontAsk") {
        throw new Error("현재 ChatKJB 권한 모드에서는 Cline 명령 실행이 금지됩니다.");
      }
      const text = typeof command === "string" ? command : command.command;
      if (session.permissionMode === "auto") {
        const classification = classifyClineAutoCommand(text, cwd);
        if (!classification.allowed) {
          throw new Error(`Cline 자동 명령 거부: ${classification.reason ?? "안전성을 입증할 수 없음"}`);
        }
      }
      if (!defaults.bash) throw new Error("Cline shell executor가 없습니다.");
      return defaults.bash(command, cwd, context);
    };
    const tools = createBuiltinTools({
      cwd: session.cwd,
      enableReadFiles: boundary.enableReadFiles,
      enableSearch: boundary.enableSearch,
      enableWebFetch: boundary.enableWebFetch,
      enableEditor: boundary.enableEditor,
      enableApplyPatch: boundary.enableApplyPatch,
      enableBash: boundary.enableBash,
      enableSkills: boundary.enableSkills,
      enableAskQuestion: boundary.enableAskQuestion,
      enableSubmitAndExit: false,
      executors: {
        ...defaults,
        editor,
        applyPatch,
        bash,
        askQuestion: async (question: string, options: string[], context: AgentToolContext) => {
          const answers = await this.host.requestUserInput(session, {
            questions: [{
              header: "Cline 질문",
              question,
              options: options.map((label: string) => ({ label })),
              multiSelect: false
            }]
          }, context.signal ?? new AbortController().signal);
          const answer = answers[question];
          return Array.isArray(answer) ? answer.join(", ") : answer ?? "";
        }
      }
    });
    const actual = new Set(tools.map((tool: AgentTool) => tool.name));
    for (const name of actual) {
      if (!CLINE_AUDITED_TOOL_NAMES.includes(name as never)) {
        throw new Error(`감사되지 않은 Cline 도구가 생성되어 실행을 거부했습니다: ${name}`);
      }
    }
    // 고정 SDK의 public catalog가 바뀌면 알려지지 않은 도구를 자동 등록하지 않고 시작을 중단한다.
    const known = new Set(ALL_DEFAULT_TOOL_NAMES);
    for (const name of CLINE_AUDITED_TOOL_NAMES) {
      if (!known.has(name)) throw new Error(`Cline SDK 도구 카탈로그 불일치: ${name}`);
    }
    return { tools, policies: boundary.policies };
  }

  private async config(session: SessionRecord, clineSessionId: string, readOnly = false, toolFree = false) {
    const connection = await this.connection(session);
    const { tools, policies } = this.tools(session, readOnly, toolFree);
    return {
      config: {
        ...connection,
        sessionId: clineSessionId,
        cwd: session.cwd,
        workspaceRoot: session.cwd,
        systemPrompt: buildProviderBootstrap(session, this.host.options.claudeMemoryDir, {
          includeInteractiveProtocols: !readOnly,
          permissionMode: readOnly ? "plan" : session.permissionMode
        }),
        mode: readOnly ? "plan" as const : "act" as const,
        enableTools: false,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        disableMcpSettingsTools: true
      },
      localRuntime: { extraTools: tools },
      capabilities: { requestToolApproval: (request: ToolApprovalRequest) => this.requestApproval(request) },
      toolPolicies: policies,
      interactive: true
    };
  }

  private async ensureHydrated(core: ClineCoreLike, session: SessionRecord, clineSessionId: string): Promise<void> {
    if (this.hydrated.has(clineSessionId)) return;
    const existing = this.hydration.get(clineSessionId);
    if (existing) return existing;
    const task = (async () => {
      const record = await core.get(clineSessionId);
      if (!record) throw new Error("저장된 Cline 세션 artifact를 찾지 못했습니다. /reset 후 다시 시작하세요.");
      const initialMessages = await core.readMessages(clineSessionId);
      await core.start({
        ...await this.config(session, clineSessionId),
        initialMessages
      });
      this.hydrated.add(clineSessionId);
    })().finally(() => this.hydration.delete(clineSessionId));
    this.hydration.set(clineSessionId, task);
    return task;
  }

  async execute(request: RunRequest): Promise<void> {
    let session = this.host.store.getSession(request.session.id);
    if (!session || this.host.deleting.has(session.id)) return;
    request = this.host.applyHandoffSummary(request, session);
    session = this.host.store.getSession(session.id) ?? session;
    const renderer = new StreamRenderer(session, this.host.transport, this.host.options.debounceMs);
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
      mcpFailures: new Map()
    };
    this.host.active.set(session.id, run);
    this.host.store.updateSession(session.id, { status: "running" });
    const core = await this.core();
    const clineSessionId = session.clineSessionId ?? this.dependencies.createSessionId();
    this.chatSessionByClineId.set(clineSessionId, session.id);
    const abort = () => { void core.abort(clineSessionId).catch(() => undefined); };
    controller.signal.addEventListener("abort", abort, { once: true });
    let lastResponse = "";
    let first = session.clineSessionId == null;
    try {
      await this.host.safeRename(session, `[RUNNING] ${session.title}`);
      await renderer.start(false);
      const selected = this.selection(session);
      renderer.note(`Cline SDK 실행 (${selected.providerId} · ${selected.modelId})`);
      const iterator = input[Symbol.asyncIterator]();
      let pending = await iterator.next();
      while (!pending.done) {
        const content = pending.value.message.content;
        const prompt = typeof content === "string" ? content : request.prompt;
        let eventText = "";
        let delivery = Promise.resolve();
        const unsubscribe = core.subscribe((event: CoreSessionEvent) => {
          const text = collectPublicText(event);
          if (!text || text === eventText) return;
          eventText = text;
          delivery = delivery.then(() => renderer.text(text));
        }, { sessionId: clineSessionId });
        try {
          let result: AgentResult | undefined;
          if (first) {
            const started = await core.start({
              ...await this.config(session, clineSessionId),
              prompt
            });
            result = started.result;
            this.hydrated.add(clineSessionId);
            this.host.store.updateSession(session.id, { clineSessionId });
            first = false;
          } else {
            await this.ensureHydrated(core, session, clineSessionId);
            result = await core.send({ sessionId: clineSessionId, prompt });
          }
          if (controller.signal.aborted || run.stopRequested) {
            throw new Error("aborted");
          }
          await delivery;
          const response = result?.text?.trim() || eventText || "Cline 실행 완료";
          lastResponse = await queueRequestedUserInput(
            this.host,
            session,
            run,
            input,
            controller.signal,
            response
          ) || lastResponse;
          const usage = await core.getAccumulatedUsage(clineSessionId);
          this.host.store.updateSession(session.id, {
            clineSessionId,
            ...(usage ? { clineUsage: JSON.stringify(usage) } : {})
          });
        } finally {
          unsubscribe();
        }
        run.pendingTurns = Math.max(0, run.pendingTurns - 1);
        if (run.pendingTurns === 0) break;
        pending = await iterator.next();
      }
      this.host.store.updateSession(session.id, { status: "done" });
      await renderer.finish("done", lastResponse || "Cline 실행 완료");
      await this.host.safeRename(session, `[DONE] ${session.title}`);
    } catch (error) {
      if (this.host.deleting.has(session.id) || !this.host.store.getSession(session.id)) return;
      if (run.serviceShutdownRequested && controller.signal.aborted) return;
      const aborted = controller.signal.aborted || run.stopRequested === true;
      this.host.store.updateSession(session.id, { status: aborted ? "aborted" : "error" });
      await renderer.finish(
        aborted ? "aborted" : "error",
        aborted ? "사용자가 작업을 중단했습니다." : `Cline 실행 실패: ${safeErrorMessage(error)}`
      );
      await this.host.safeRename(session, `${aborted ? "[STOP]" : "[ERROR]"} ${session.title}`);
    } finally {
      controller.signal.removeEventListener("abort", abort);
      renderer.dispose();
      run.input.cancel();
      this.chatSessionByClineId.delete(clineSessionId);
      if (this.host.active.get(session.id) === run) this.host.active.delete(session.id);
    }
  }

  async runReadOnly(session: SessionRecord, prompt: string, options: {
    timeoutMs?: number;
    toolFree?: boolean;
  } = {}): Promise<string> {
    const core = await this.core();
    const id = this.dependencies.createSessionId();
    const readOnlySession = { ...session, permissionMode: "plan" as const };
    const timeout = options.timeoutMs
      ? setTimeout(() => { void core.abort(id).catch(() => undefined); }, options.timeoutMs)
      : null;
    try {
      const result = await core.start({
        ...await this.config(readOnlySession, id, true, options.toolFree ?? false),
        prompt,
        interactive: false
      });
      const text = result.result?.text?.trim();
      if (!text) throw new Error("Cline 읽기 전용 단계가 빈 응답을 반환했습니다.");
      return text;
    } finally {
      if (timeout) clearTimeout(timeout);
      await core.delete(id).catch(() => false);
    }
  }

  async updateConnection(session: SessionRecord): Promise<void> {
    if (!session.clineSessionId) return;
    const core = await this.core();
    await core.updateSessionConnection(session.clineSessionId, await this.connection(session));
  }

  async summarizeForHandoff(session: SessionRecord, prompt: string): Promise<string> {
    if (!session.clineSessionId) return "";
    const core = await this.core();
    await this.ensureHydrated(core, session, session.clineSessionId);
    const result = await core.send({
      sessionId: session.clineSessionId,
      prompt,
      mode: "plan"
    });
    return result?.text?.trim() ?? "";
  }

  async reset(session: SessionRecord): Promise<void> {
    if (!session.clineSessionId) return;
    const core = await this.core();
    await core.abort(session.clineSessionId).catch(() => undefined);
    await core.delete(session.clineSessionId);
    this.hydrated.delete(session.clineSessionId);
    this.hydration.delete(session.clineSessionId);
    this.chatSessionByClineId.delete(session.clineSessionId);
  }

  async dispose(): Promise<void> {
    const core = this.corePromise ? await this.corePromise.catch(() => null) : null;
    if (core) await core.dispose("chatkjb_shutdown");
    this.corePromise = null;
    this.hydrated.clear();
    this.hydration.clear();
    this.chatSessionByClineId.clear();
  }
}
