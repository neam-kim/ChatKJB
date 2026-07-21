import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminateChildTree } from "./child-process.js";
import { buildGrokSubscriptionEnvironment } from "./grok-environment.js";
import { normalizeGrokReasoningEffort } from "./model-catalog.js";
import type { GrokTokenUsage } from "./types.js";

/**
 * Grok의 `streaming-json` 출력에서 사용자에게 보여 줄 `text` 이벤트만 누적한다.
 * `thought` 이벤트는 모델의 비공개 추론이므로 Telegram으로 절대 전달하지 않는다.
 */
function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export class GrokStreamingJsonCollector {
  private pending = "";
  private visibleText = "";
  private readonly visibleEvents: string[] = [];
  private tokenUsage: GrokTokenUsage | null = null;

  accept(chunk: string): string {
    this.pending += chunk;
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, newline).trim();
      this.pending = this.pending.slice(newline + 1);
      this.acceptLine(line);
    }
    return this.visibleText;
  }

  finish(): string {
    this.acceptLine(this.pending.trim());
    this.pending = "";
    return this.visibleText.trim();
  }

  /** 가장 최근 `accept`/`finish`에서 완결된 공개 text 이벤트를 한 번만 꺼낸다. */
  takeVisibleEvents(): string[] {
    return this.visibleEvents.splice(0);
  }

  /** `end`(또는 `error`) 이벤트가 실어 온 이번 턴의 토큰 사용량. grok 0.2.99 미만은 null. */
  usage(): GrokTokenUsage | null {
    return this.tokenUsage;
  }

  private acceptLine(line: string): void {
    if (!line) return;
    try {
      const event = JSON.parse(line) as { type?: unknown; data?: unknown; usage?: unknown; };
      if (event.type === "text" && typeof event.data === "string") {
        this.visibleText += event.data;
        this.visibleEvents.push(event.data);
        return;
      }
      // grok 0.2.99+는 `end`/`error`에 이번 턴의 spend를 싣는다. 구버전은 이 필드가 없어 null로 남는다.
      if ((event.type === "end" || event.type === "error") && event.usage) {
        this.tokenUsage = usageFromEndEvent(event.usage);
      }
    } catch {
      // streaming-json 모드의 비정상 행은 공개 답변으로 취급하지 않는다.
    }
  }
}

/** grok `end` 이벤트의 snake_case usage 객체를 GrokTokenUsage로 정규화한다. */
export function usageFromEndEvent(value: unknown): GrokTokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const usage: GrokTokenUsage = {
    inputTokens: tokenCount(record.input_tokens),
    cacheReadInputTokens: tokenCount(record.cache_read_input_tokens),
    outputTokens: tokenCount(record.output_tokens),
    reasoningTokens: tokenCount(record.reasoning_tokens),
    totalTokens: tokenCount(record.total_tokens)
  };
  // total_tokens = input + cache_read + output (grok 문서). 누락 시 직접 합산한다.
  if (usage.totalTokens === 0) {
    usage.totalTokens = usage.inputTokens + usage.cacheReadInputTokens + usage.outputTokens;
  }
  return usage.totalTokens > 0 ? usage : null;
}

export interface GrokCliOptions {
  executable: string;
  cwd: string;
  model: string;
  reasoningEffort?: string;
  supportedReasoningEfforts?: readonly string[] | undefined;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  permissionMode?: PermissionMode;
  rules?: string;
  toolFree?: boolean;
  sessionId?: string;
  resume?: boolean;
}

// 봇 세션의 permissionMode를 grok CLI `--permission-mode`가 실제로 실효하는 값으로 매핑한다.
// grok 문서(22-permissions-and-safety.md / 14-headless-mode.md)상 이 플래그는 오직
// `bypassPermissions`만 실효하고, `auto`/`dontAsk`/`acceptEdits`는 "accepted but not yet
// enforced"라 무시되며 실제 정책은 `.claude/settings.json`의 defaultMode(미설정 시 default)를
// 따른다. 그 결과 헤드리스 실행에서 Gmail 같은 MCP 도구가 매 호출마다 대화형 승인 프롬프트에
// 걸려 응답 주체 부재로 turn이 permission_cancelled로 끊긴다. 따라서 자율 실행 계열
// (auto/dontAsk/acceptEdits/bypassPermissions)은 grok에 `bypassPermissions`로 넘겨 프롬프트
// 없이 도구를 끝까지 실행하게 한다. `plan`은 실행 금지 의도를 보존해 그대로 두고, `default`는
// 사용자가 명시적으로 고른 신중 모드이므로 grok의 프롬프트 정책을 유지한다. deny 규칙과
// PreToolUse hook은 어떤 경우에도 계속 적용된다.
export function grokPermissionMode(mode: PermissionMode | undefined): string {
  switch (mode) {
    case "plan":
      return "plan";
    case "default":
      return "default";
    default:
      // auto / dontAsk / acceptEdits / bypassPermissions / undefined
      return "bypassPermissions";
  }
}

export interface GrokCliResult {
  text: string;
  /** grok 0.2.99+의 `end` 이벤트가 준 이번 턴 토큰 사용량. 구버전 CLI에서는 null. */
  usage: GrokTokenUsage | null;
  /**
   * true면 프로세스는 비정상 종료(code≠0)했지만 streaming-json 공개 text가 있어
   * 그 결과를 살려 세션을 완료로 처리한다(HTTP 522 등 후반 단절 대비).
   */
  salvaged?: boolean;
}

/** Grok CLI stderr를 사용자 안내 문장으로 짧게 정리한다. */
export function formatGrokCliFailure(code: number | null, stderr: string): string {
  const detail = stderr.trim().slice(-1000);
  const httpMatch = detail.match(/HTTP\s+(\d{3})/i)
    ?? detail.match(/status[_\s]?(\d{3})/i)
    ?? detail.match(/\(status\s+(\d{3})/i);
  const status = httpMatch?.[1];
  if (status === "522" || /timed out or was interrupted/i.test(detail)) {
    return "Grok API 연결이 끊겼거나 시간 초과되었습니다(HTTP 522). "
      + "같은 토픽에서 이어서 보내 주시면 재개할 수 있습니다."
      + (detail ? ` 원문: ${detail.slice(0, 280)}` : "");
  }
  if (status === "429" || /rate limit|too many requests/i.test(detail)) {
    return "Grok API 요청 한도에 걸렸습니다. 잠시 후 같은 토픽에서 다시 시도해 주세요."
      + (detail ? ` 원문: ${detail.slice(0, 280)}` : "");
  }
  return `Grok CLI 실행 실패 (코드 ${code ?? "unknown"})`
    + (detail ? `: ${detail}` : "");
}

/**
 * 프로세스 종료 코드와 수집된 공개 text로 성공·salvage·실패를 결정한다.
 * abort/timeout 등 pendingError가 있으면 항상 실패한다.
 */
export function resolveGrokProcessExit(input: {
  code: number | null;
  visibleText: string;
  stderr: string;
  pendingError: Error | null;
}): { ok: true; text: string; salvaged: boolean; } | { ok: false; error: Error; } {
  if (input.pendingError) return { ok: false, error: input.pendingError };
  const text = input.visibleText.trim();
  if (input.code === 0) {
    if (!text) {
      return {
        ok: false,
        error: new Error("Grok CLI가 성공 종료와 함께 빈 응답을 반환했습니다.")
      };
    }
    return { ok: true, text, salvaged: false };
  }
  // 비정상 종료라도 이미 스트리밍된 공개 답변이 있으면 세션을 ERROR로 버리지 않는다.
  // 긴 작업 후 --check/후속 turn에서 HTTP 522가 나도 본문 결과는 보존한다.
  if (text) return { ok: true, text, salvaged: true };
  return {
    ok: false,
    error: new Error(formatGrokCliFailure(input.code, input.stderr))
  };
}

export function grokToolFreeArgs(): string[] {
  return [
    "--tools",
    "",
    "--disallowed-tools",
    "Bash,Read,Glob,Grep,WebSearch,WebFetch,Task,Edit,Write,NotebookEdit",
    "--deny",
    "*",
    "--disable-web-search",
    "--no-subagents",
    "--no-memory",
    "--max-turns",
    "1",
    "--verbatim"
  ];
}

export async function runGrokCli(
  prompt: string,
  options: GrokCliOptions,
  signal?: AbortSignal,
  // streaming-json의 각 공개 text 이벤트. 누적 전체 문자열이 아니라 이번 이벤트의 조각이다.
  onPartial?: (text: string) => void
): Promise<GrokCliResult> {
  const tempDir = mkdtempSync(join(tmpdir(), "chatkjb-grok-"));
  const promptFile = join(tempDir, "prompt.md");
  writeFileSync(promptFile, prompt, "utf8");
  try {
    const reasoningEffort = normalizeGrokReasoningEffort(
      options.reasoningEffort,
      options.supportedReasoningEfforts
    );
    const args = [
      "--cwd",
      options.cwd,
      "--model",
      options.model,
      ...(reasoningEffort ? ["--reasoning-effort", reasoningEffort] : []),
      "--permission-mode",
      grokPermissionMode(options.permissionMode),
      // 도구를 쓰는 헤드리스 작업은 계획·진행문만 낸 뒤 끝날 수 있으므로,
      // Grok의 자체 검증 루프를 넣어 요청한 결과가 실제로 완결됐는지 재확인한다.
      ...(options.toolFree ? grokToolFreeArgs() : ["--check"]),
      "--output-format",
      "streaming-json",
      ...(options.rules ? ["--rules", options.rules] : []),
      ...(options.sessionId
        ? options.resume
          ? ["--resume", options.sessionId]
          : ["--session-id", options.sessionId]
        : []),
      "--prompt-file",
      promptFile
    ];
    return await runGrokProcess(options.executable, args, options, signal, onPartial);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runGrokProcess(
  executable: string,
  args: string[],
  options: GrokCliOptions,
  signal?: AbortSignal,
  onPartial?: (text: string) => void
): Promise<GrokCliResult> {
  return new Promise((resolve, reject) => {
    const output = new GrokStreamingJsonCollector();
    let stderr = "";
    let settled = false;
    let pendingError: Error | null = null;
    let terminationTimer: NodeJS.Timeout | undefined;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: buildGrokSubscriptionEnvironment(options.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });

    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        pendingError = new Error("Grok CLI 실행 시간이 초과되었습니다.");
        terminationTimer ??= terminateChildTree(child);
      }, options.timeoutMs)
      : undefined;
    const onAbort = () => {
      pendingError = new Error("turn aborted");
      terminationTimer ??= terminateChildTree(child);
    };
    if (signal) {
      if (!signal.aborted) signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      output.accept(chunk.toString("utf8"));
      for (const visibleEvent of output.takeVisibleEvents()) onPartial?.(visibleEvent);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-20_000);
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      signal?.removeEventListener("abort", onAbort);
      finishReject(error);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      const response = output.finish();
      for (const visibleEvent of output.takeVisibleEvents()) onPartial?.(visibleEvent);
      const decided = resolveGrokProcessExit({
        code,
        visibleText: response,
        stderr,
        pendingError
      });
      if (!decided.ok) {
        finishReject(decided.error);
        return;
      }
      settled = true;
      resolve({
        text: decided.text,
        usage: output.usage(),
        ...(decided.salvaged ? { salvaged: true } : {})
      });
    });
    if (signal?.aborted) onAbort();
  });
}
