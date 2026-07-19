import type {
  deleteSession as deleteClaudeSession,
  Query
} from "@anthropic-ai/claude-agent-sdk";
import type { CodexGoalClient } from "../../codex-app-server.js";
import type { ModelCatalog } from "../../model-catalog.js";
import type { StateStore } from "../../store.js";
import type { MessageTransport, ProviderKind, SessionRecord } from "../../types.js";
import { MessageQueue } from "../../session-collectors.js";
import {
  buildOrchestratedTurnPrompt,
  buildUserMessage
} from "../../session-prompts.js";
import {
  buildUserInputContinuation,
  parseUserInputRequest,
  type UserInputAnswers,
  type UserInputRequest
} from "../../user-input-protocol.js";
import type { RunRequest } from "../prompt-builders.js";

/** 실행기와 SessionManager가 공유하는 불변 설정 표면. */
export interface ExecutorOptions {
  debounceMs: number;
  claudeCodeOauthToken?: string | undefined;
  additionalOauthTokens?: string[];
  availableProviders?: readonly ProviderKind[] | undefined;
  codexAccountHomes?: string[];
  claudeCodeExecutable?: string;
  codexExecutable?: string;
  agyExecutable?: string | undefined;
  grokExecutable?: string | undefined;
  grokModel?: string | undefined;
  mcpToolTimeoutMs: number;
  mcpMaxAttempts: number;
  codexMcpTimeoutMs: number;
  /** undefined이면 provider 턴에 절대 시간 제한을 적용하지 않는다. */
  providerTurnTimeoutMs?: number | undefined;
  codexTransientStreamRetries?: number | undefined;
  codexMcpHeartbeatMs: number;
  longRunningMcpServers: ReadonlySet<string>;
  turnIdleTimeoutMs: number;
  claudeMemoryDir: string;
  modelCatalog: ModelCatalog;
  /** 세션의 한 작업이 종결 상태에 도달한 직후 실행하는 경량 후처리 훅. */
  onSessionSettled?: (session: SessionRecord) => void | Promise<void>;
  deleteClaudeSession?: typeof deleteClaudeSession;
  codexGoalClient?: CodexGoalClient;
}

/** 제공자 실행 중 SessionManager가 추적하는 공통 수명주기 상태. */
export interface ActiveRun {
  controller: AbortController;
  input: MessageQueue;
  pendingTurns: number;
  startedAt: number;
  /**
   * 데몬 재시작/종료 정리 때문에 실행을 끊는 경우다. 사용자 /stop과 구분하여
   * DB의 running 상태를 보존해야 다음 프로세스가 자동 복구할 수 있다.
   */
  serviceShutdownRequested?: boolean;
  query?: Query;
  stopRequested?: boolean;
  codexCurrentPrompt?: string;
  codexRestartPrompt?: string;
  codexTimers: Map<string, NodeJS.Timeout>;
  codexStarts: Map<string, number>;
  mcpFailures: Map<string, number>;
}

/** 제공자별 파일에 private 필드를 공개하지 않고 필요한 참조만 전달하는 내부 계약. */
export interface BaseExecutorHost {
  store: StateStore;
  transport: MessageTransport;
  options: ExecutorOptions;
  active: Map<string, ActiveRun>;
  deleting: Set<string>;
  applyHandoffSummary(request: RunRequest, session: SessionRecord): RunRequest;
  safeRename(session: SessionRecord, title: string): Promise<void>;
  requestUserInput(
    session: SessionRecord,
    request: UserInputRequest,
    signal: AbortSignal
  ): Promise<UserInputAnswers>;
}

/** 제공자 응답의 선택형 UI 요청을 처리하고 답변을 같은 실행의 다음 턴에 넣는다. */
export async function queueRequestedUserInput(
  host: BaseExecutorHost,
  session: SessionRecord,
  run: ActiveRun,
  input: MessageQueue,
  signal: AbortSignal,
  response: string
): Promise<string> {
  const parsed = parseUserInputRequest(response);
  if (parsed.error) throw new Error(parsed.error);
  if (!parsed.request) return parsed.visibleText;

  const answers = await host.requestUserInput(session, parsed.request, signal);
  const continuation = buildOrchestratedTurnPrompt(buildUserInputContinuation(answers), {
    includeDate: session.provider !== "claude"
  });
  run.pendingTurns += 1;
  if (!input.push(buildUserMessage(continuation, "now"))) {
    run.pendingTurns -= 1;
    throw new Error("사용자 선택 결과를 제공자 다음 턴에 전달하지 못했습니다.");
  }
  return parsed.visibleText;
}
