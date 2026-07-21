import { randomUUID } from "node:crypto";
import { runGrokCli } from "../../grok-cli.js";
import {
  DEFAULT_GROK_MODEL,
  DEFAULT_GROK_REASONING,
  grokModelLabel,
  grokReasoningLabel
} from "../../model-catalog.js";
import { GrokProgressCollector, MessageQueue } from "../../session-collectors.js";
import {
  buildGrokOutputInstructions,
  buildProviderBootstrap,
  buildUserMessage
} from "../../session-prompts.js";
import { StreamRenderer } from "../../stream-renderer.js";
import { safeErrorMessage } from "../../telegram-transport.js";
import { addGrokUsage, parseStoredGrokUsage } from "../../usage.js";
import { promptForCodexRequest, type RunRequest } from "../prompt-builders.js";
import {
  queueRequestedUserInput,
  type ActiveRun,
  type BaseExecutorHost
} from "./shared.js";

type GrokTranscript = {
  progress: string[];
  final: string;
};

export interface GrokExecutorDependencies {
  runGrok: typeof runGrokCli;
  createSessionId: () => string;
}

const DEFAULT_DEPENDENCIES: GrokExecutorDependencies = {
  runGrok: runGrokCli,
  createSessionId: randomUUID
};

/** Grok 공개 출력의 제어 표지를 제거하고 Telegram에 보낼 진행문·최종문으로 나눈다. */
export function parseGrokTranscript(text: string): GrokTranscript {
  const progress: string[] = [];
  const final: string[] = [];
  const marker = /\[(PROGRESS|FINAL)\]\s*/gi;
  const matches = [...text.matchAll(marker)];
  if (matches.length === 0) {
    return { progress, final: text.trim() };
  }
  const leading = text.slice(0, matches[0]?.index ?? 0).trim();
  if (leading) progress.push(leading);
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    if (!current) continue;
    const start = (current.index ?? 0) + current[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const content = text.slice(start, end)
      .replace(/\[\/(?:PROGRESS|FINAL)\]/gi, "")
      .trim();
    if (!content) continue;
    if (current[1]?.toUpperCase() === "FINAL") final.push(content);
    else progress.push(content);
  }
  return { progress, final: final.join("\n\n") };
}

function withoutGrokControlMarkers(text: string): string {
  return text.replace(/\[\/?(?:PROGRESS|FINAL)\]\s*/gi, "").trim();
}

/** Grok CLI 턴의 전체 수명주기를 전용 모듈에서 실행한다. */
export async function executeGrok(
  host: BaseExecutorHost,
  request: RunRequest,
  dependencies: GrokExecutorDependencies = DEFAULT_DEPENDENCIES
): Promise<void> {
  const session = host.store.getSession(request.session.id);
  if (!session || host.deleting.has(session.id)) return;
  request = host.applyHandoffSummary(request, session);
  const renderer = new StreamRenderer(session, host.transport, host.options.debounceMs);
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
  host.active.set(session.id, run);
  host.store.updateSession(session.id, { status: "running" });
  const model = session.grokModel ?? host.options.grokModel ?? DEFAULT_GROK_MODEL;
  const reasoning = session.grokReasoning ?? DEFAULT_GROK_REASONING;
  const rules = [
    buildProviderBootstrap(session, host.options.claudeMemoryDir),
    buildGrokOutputInstructions()
  ].join("\n\n");
  let grokSessionId = session.grokSessionId ?? dependencies.createSessionId();
  let resume = session.grokSessionId !== null && session.grokSessionId !== undefined;
  let queuedProgress: string | null = null;
  let progressDelivery: Promise<void> | null = null;
  let progressError: unknown;
  const deliverProgress = async () => {
    while (queuedProgress !== null) {
      const message = queuedProgress;
      queuedProgress = null;
      await renderer.text(message);
    }
  };
  const emitGrokProgress = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    // Telegram 전송이 느릴 때 모든 중간문을 Promise 체인에 보존하지 않고 최신 상태 하나로 합친다.
    queuedProgress = clean;
    progressDelivery ??= deliverProgress()
      .catch((error: unknown) => {
        progressError = error;
      })
      .finally(() => {
        progressDelivery = null;
      });
  };
  let lastResponse = "";
  try {
    await host.safeRename(session, `[RUNNING] ${session.title}`);
    await renderer.start();
    renderer.note(
      `Grok 실행 (${grokModelLabel(host.options.modelCatalog, model)}`
      + ` · reasoning ${grokReasoningLabel(reasoning)})`
    );
    const iterator = input[Symbol.asyncIterator]();
    let pending = await iterator.next();
    while (!pending.done) {
      const content = pending.value.message.content;
      const turnPrompt = typeof content === "string" ? content : request.prompt;
      const publicMessages = new GrokProgressCollector();
      const streamGrokProgress = (textEvent: string) => {
        for (const message of publicMessages.accept(textEvent)) {
          emitGrokProgress(withoutGrokControlMarkers(message));
        }
      };
      const { text, usage } = await dependencies.runGrok(turnPrompt, {
        executable: host.options.grokExecutable ?? "grok",
        cwd: session.cwd,
        model,
        reasoningEffort: reasoning,
        supportedReasoningEfforts: host.options.modelCatalog.grokReasoningEfforts,
        ...(host.options.providerTurnTimeoutMs
          ? { timeoutMs: host.options.providerTurnTimeoutMs }
          : {}),
        permissionMode: session.permissionMode,
        // rules(부트스트랩)는 새 Grok 세션의 첫 턴에만 넣는다. resume된 세션은 첫 턴의
        // rules를 이미 대화 기록에 보유하므로 이후 턴에서는 생략한다(Codex/agy와 같은 정책).
        ...(resume ? {} : { rules }),
        sessionId: grokSessionId,
        resume
      }, controller.signal, streamGrokProgress);
      for (const message of publicMessages.finish()) {
        emitGrokProgress(withoutGrokControlMarkers(message));
      }
      if (progressDelivery) await progressDelivery;
      if (progressError) throw progressError;
      const response = parseGrokTranscript(text).final || "Grok 실행 완료";
      const visibleResponse = await queueRequestedUserInput(
        host,
        session,
        run,
        input,
        controller.signal,
        response
      );
      lastResponse = visibleResponse || lastResponse;
      const latest = host.store.getSession(session.id) ?? session;
      host.store.updateSession(session.id, {
        ...(resume ? {} : { grokSessionId }),
        ...(usage
          ? { grokUsage: JSON.stringify(addGrokUsage(parseStoredGrokUsage(latest.grokUsage), usage)) }
          : {})
      });
      resume = true;
      grokSessionId = host.store.getSession(session.id)?.grokSessionId ?? grokSessionId;
      run.pendingTurns = Math.max(0, run.pendingTurns - 1);
      if (run.pendingTurns === 0) break;
      pending = await iterator.next();
    }
    host.store.updateSession(session.id, {
      status: "done"
    });
    await renderer.finish("done", lastResponse || "Grok 실행 완료");
    await host.safeRename(session, `[DONE] ${session.title}`);
  } catch (error) {
    if (host.deleting.has(session.id) || !host.store.getSession(session.id)) return;
    // 서비스 재시작 정리 abort는 새 데몬의 자동 복구가 이어받도록 running 상태를 남긴다.
    if (run.serviceShutdownRequested && controller.signal.aborted) return;
    const aborted = controller.signal.aborted || run.stopRequested === true;
    const message = safeErrorMessage(error, []);
    host.store.updateSession(session.id, { status: aborted ? "aborted" : "error" });
    await renderer.finish(
      aborted ? "aborted" : "error",
      aborted ? "사용자가 작업을 중단했습니다." : `Grok 실행 실패: ${message}`
    );
    await host.safeRename(session, `${aborted ? "[STOP]" : "[ERROR]"} ${session.title}`);
  } finally {
    renderer.dispose();
    run.input.cancel();
    if (host.active.get(session.id) === run) host.active.delete(session.id);
  }
}
