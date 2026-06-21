import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const START_TIMEOUT_MS = 30_000;
/** cancel을 보낸 뒤 브리지가 turn 종료 이벤트(done/error)를 반환하는 최대 대기 시간.
 *  이 안에 종료 이벤트가 오지 않으면 폴백으로 SIGTERM을 보낸다. */
const CANCEL_FALLBACK_MS = 3_000;
const CONTROL_TIMEOUT_MS = 5_000;

export interface AgyInteractiveOptions {
  pythonPath: string;
  bridgePath: string;
  cwd: string;
  model: string;
  /** GeminiModelOptions.thinking_level(minimal/low/medium/high). null이면 API 기본. */
  thinkingLevel: string | null;
  permissionMode: string;
  conversationId: string | null;
  systemInstructions: string;
  connectorRegistry: string;
  skillsPaths: string[];
  env: NodeJS.ProcessEnv;
}

/** agy SDK UsageMetadata 필드. 값 없으면 null. */
export interface AgyUsage {
  promptTokenCount: number | null;
  cachedContentTokenCount: number | null;
  candidatesTokenCount: number | null;
  thoughtsTokenCount: number | null;
  totalTokenCount: number | null;
}

export interface AgyInteractiveTurnResult {
  response: string;
  conversationId: string | null;
  /** 이 턴의 토큰 사용량. 브리지가 usage_metadata를 반환하지 않으면 undefined. */
  usage?: AgyUsage;
  /** 대화 누적 토큰 사용량. 브리지가 total_usage를 반환하지 않으면 undefined. */
  totalUsage?: AgyUsage;
}

export interface AgyLiveStatus {
  isIdle: boolean | null;
  turnCount: number | null;
  conversationId: string | null;
}

interface PendingTurn {
  id: string;
  text: string;
  onPartial?: (text: string) => void;
  resolve: (result: AgyInteractiveTurnResult) => void;
  reject: (error: Error) => void;
  abortCleanup?: () => void;
}

interface PendingControl<T> {
  id: string;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** 브리지 turn 메시지에 실을 단일 첨부 파일 기술자. agy turn 전용. */
export interface AgyAttachment {
  /** 로컬 디스크의 절대 경로. */
  path: string;
  /** 파일의 MIME 타입. */
  mimeType: string;
}

interface BridgeEvent {
  type?: string;
  id?: string;
  text?: string;
  message?: string;
  conversationId?: string | null;
  isIdle?: boolean | null;
  turnCount?: number | null;
  /** 이 턴의 usage_metadata (done 이벤트 전용). */
  usage?: Record<string, unknown> | null;
  /** 대화 누적 total_usage (done 이벤트 전용). */
  totalUsage?: Record<string, unknown> | null;
}

export function agyApiModel(model: string): string {
  const clean = model.trim();
  if (/^gemini-[a-z0-9.-]+$/i.test(clean)) return clean.toLowerCase();
  if (/3\.5\s*flash/i.test(clean)) return "gemini-3.5-flash";
  if (/3\.1\s*pro/i.test(clean)) return "gemini-3.1-pro-preview";
  if (/3\.1\s*flash\s*lite/i.test(clean)) return "gemini-3.1-flash-lite-preview";
  if (/3(?:\.0)?\s*pro/i.test(clean)) return "gemini-3-pro-preview";
  if (/flash/i.test(clean)) return "gemini-3.5-flash";
  return "gemini-3.1-pro-preview";
}

/** 브리지 이벤트의 usage 객체를 AgyUsage로 변환한다. 숫자 필드만 추출하고 나머지는 null. */
function parseAgyUsage(raw: Record<string, unknown> | null | undefined): AgyUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r: Record<string, unknown> = raw;
  function num(key: string): number | null {
    const v = r[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return {
    promptTokenCount: num("prompt_token_count"),
    cachedContentTokenCount: num("cached_content_token_count"),
    candidatesTokenCount: num("candidates_token_count"),
    thoughtsTokenCount: num("thoughts_token_count"),
    totalTokenCount: num("total_token_count")
  };
}

export function normalizeAgyResponse(text: string): string {
  const clean = text.trim();
  if (clean.length % 2 === 0) {
    const midpoint = clean.length / 2;
    if (clean.slice(0, midpoint) === clean.slice(midpoint)) {
      return clean.slice(0, midpoint).trim();
    }
  }
  return clean;
}

export class AgyInteractiveSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private pending: PendingTurn | null = null;
  private pendingControls = new Map<string, PendingControl<unknown>>();
  private stderr = "";
  private conversationId: string | null;
  /** cancel 전송 후 설치한 폴백 SIGTERM 타이머 해제 콜백.
   *  pending은 cancel 시 즉시 null이 되므로 타이머 해제 핸들을 세션 레벨에 둔다.
   *  turn 종료 이벤트(done/error)나 child close 시 해제한다. */
  private pendingCancelTimer: { clear: () => void } | null = null;

  constructor(private readonly options: AgyInteractiveOptions) {
    this.conversationId = options.conversationId;
  }

  get alive(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  async start(): Promise<void> {
    if (this.alive) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.pythonPath, [this.options.bridgePath], {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;
      this.stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Antigravity SDK 시작 시간이 초과되었습니다."));
        this.close();
      }, START_TIMEOUT_MS);
      timeout.unref();

      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => this.handleLine(line, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      }));
      child.stderr.on("data", (chunk: Buffer) => {
        this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-20_000);
      });
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
        this.failPending(error);
      });
      child.on("close", (code) => {
        const detail = this.stderr.trim();
        const error = new Error(
          `Antigravity SDK 프로세스가 종료되었습니다 (코드 ${code ?? "unknown"})`
          + (detail ? `: ${detail.slice(-1000)}` : "")
        );
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
        this.failPending(error);
        this.child = null;
        this.startPromise = null;
      });

      this.write({
        type: "init",
        cwd: this.options.cwd,
        model: agyApiModel(this.options.model),
        // thinkingLevel이 null이면 전달하지 않아 브리지가 API 기본 동작을 유지한다.
        ...(this.options.thinkingLevel ? { thinkingLevel: this.options.thinkingLevel } : {}),
        permissionMode: this.options.permissionMode,
        conversationId: this.conversationId,
        systemInstructions: this.options.systemInstructions,
        connectorRegistry: this.options.connectorRegistry,
        skillsPaths: this.options.skillsPaths
      });
    });
    return this.startPromise;
  }

  async runTurn(
    prompt: string,
    signal?: AbortSignal,
    onPartial?: (text: string) => void,
    /** agy 네이티브 멀티모달 첨부. 비어 있거나 미지정이면 텍스트 프롬프트만 전송한다.
     *  Claude/Codex turn에는 사용하지 않는다(executeAgy에서만 채운다). */
    attachments?: AgyAttachment[]
  ): Promise<AgyInteractiveTurnResult> {
    await this.start();
    if (this.pending) throw new Error("Antigravity SDK가 이미 다른 턴을 실행 중입니다.");
    const id = randomUUID();
    return new Promise<AgyInteractiveTurnResult>((resolve, reject) => {
      // AbortSignal 수신 시: SIGTERM 대신 cancel 메시지를 보내고 브리지/Agent를 살린다.
      const onAbort = () => {
        this.sendCancelWithFallback();
      };
      const pending: PendingTurn = {
        id,
        text: "",
        ...(onPartial ? { onPartial } : {}),
        resolve,
        reject,
        ...(signal ? {
          abortCleanup: () => signal.removeEventListener("abort", onAbort)
        } : {})
      };
      this.pending = pending;
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      // attachments가 있을 때만 포함(빈 배열은 제외해 기존 브리지 동작 유지)
      const turnMsg: Record<string, unknown> = { type: "turn", id, prompt };
      if (attachments && attachments.length > 0) {
        turnMsg["attachments"] = attachments;
      }
      this.write(turnMsg);
    });
  }

  async clearHistory(): Promise<void> {
    const result = await this.sendControlRequest<{ conversationId: string | null }>({
      type: "clear_history"
    });
    this.conversationId = result.conversationId ?? this.conversationId;
  }

  async getStatus(): Promise<AgyLiveStatus> {
    return this.sendControlRequest<AgyLiveStatus>({ type: "status" });
  }

  /** 현재 turn을 네이티브 취소한다.
   *  브리지에 {type:"cancel"}을 보내고 CANCEL_FALLBACK_MS 안에
   *  turn 종료 이벤트(done/error)가 오지 않으면 폴백으로 SIGTERM을 보낸다.
   *  child 프로세스는 turn 종료 이벤트를 받은 시점까지 살아 있어
   *  다음 turn을 같은 세션에서 이어 실행할 수 있다. */
  interrupt(): void {
    if (!this.pending) return;
    this.sendCancelWithFallback();
  }

  /** turn을 네이티브 취소하고 pending을 "aborted"로 reject 한다.
   *  pending이 이미 없으면 아무 동작도 하지 않는다.
   *  child는 SIGTERM 폴백 타이머가 만료될 때까지 살아 있다. */
  private sendCancelWithFallback(): void {
    const pending = this.pending;
    if (!pending) return;

    // 브리지에 네이티브 취소 메시지를 보낸다.
    this.write({ type: "cancel" });

    // turn 종료 이벤트는 브리지가 취소 처리를 마친 뒤에야 오므로,
    // 호출자에게는 즉시 aborted로 실패를 알리고 pending을 비운다.
    this.pending = null;
    pending.abortCleanup?.();
    pending.reject(new Error("turn aborted"));

    // 안전망: CANCEL_FALLBACK_MS 안에 turn 종료 이벤트가 오지 않으면
    // 브리지가 먹통이라 보고 SIGTERM으로 종료한다. 종료 이벤트(done/error)나
    // child close 시 handleLine·close 핸들러가 이 타이머를 해제한다.
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) return;

    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
      }
    }, CANCEL_FALLBACK_MS);
    timer.unref();

    const clearTimer = () => {
      if (!timerFired) clearTimeout(timer);
    };
    child.once("close", clearTimer);
    this.pendingCancelTimer = { clear: clearTimer };
  }

  private async sendControlRequest<T>(
    message: Record<string, unknown>
  ): Promise<T> {
    await this.start();
    if (!this.child || this.child.stdin.destroyed) {
      throw new Error("Antigravity SDK 세션이 종료되었습니다.");
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(id);
        reject(new Error("Antigravity SDK 제어 요청 시간이 초과되었습니다."));
      }, CONTROL_TIMEOUT_MS);
      timer.unref();
      this.pendingControls.set(id, { id, resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ ...message, id });
    });
  }

  close(): void {
    const wasPending = !!this.pending;
    this.failPending(new Error("Antigravity SDK 세션이 종료되었습니다."));
    if (this.child && this.child.exitCode === null) {
      const child = this.child;
      if (wasPending) child.kill("SIGTERM");
      else this.write({ type: "close" });
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000).unref();
    }
    this.child = null;
    this.startPromise = null;
  }

  private handleLine(line: string, onReady: () => void): void {
    let event: BridgeEvent;
    try {
      event = JSON.parse(line) as BridgeEvent;
    } catch {
      return;
    }
    if (event.type === "ready") {
      this.conversationId = event.conversationId ?? this.conversationId;
      onReady();
      return;
    }

    // turn 종료 이벤트(done/error): 폴백 타이머가 있으면 해제한다.
    if (event.type === "done" || event.type === "error") {
      this.pendingCancelTimer?.clear();
      this.pendingCancelTimer = null;
    }

    if (event.type === "status_result" || event.type === "clear_history_result" || event.type === "control_error") {
      const control = event.id ? this.pendingControls.get(event.id) : undefined;
      if (!control) {
        return;
      }
      this.pendingControls.delete(control.id);
      clearTimeout(control.timer);
      if (event.type === "control_error") {
        control.reject(new Error(event.message || "Antigravity SDK 제어 요청에 실패했습니다."));
        return;
      }
      if (event.type === "clear_history_result") {
        control.resolve({
          conversationId: event.conversationId ?? this.conversationId
        });
        return;
      }
      control.resolve({
        isIdle: event.isIdle ?? null,
        turnCount: event.turnCount ?? null,
        conversationId: event.conversationId ?? this.conversationId
      });
      return;
    }

    const pending = this.pending;
    if (!pending || event.id !== pending.id) return;
    if (event.type === "text_delta") {
      pending.text += event.text ?? "";
      pending.onPartial?.(pending.text);
      return;
    }
    if (event.type === "done") {
      this.pending = null;
      pending.abortCleanup?.();
      this.conversationId = event.conversationId ?? this.conversationId;
      const usage = parseAgyUsage(event.usage ?? null);
      const totalUsage = parseAgyUsage(event.totalUsage ?? null);
      pending.resolve({
        response: normalizeAgyResponse(event.text ?? pending.text),
        conversationId: this.conversationId,
        ...(usage !== undefined ? { usage } : {}),
        ...(totalUsage !== undefined ? { totalUsage } : {})
      });
      return;
    }
    if (event.type === "error") {
      this.failPending(new Error(event.message || "Antigravity SDK 실행에 실패했습니다."));
      return;
    }

  }

  private write(message: Record<string, unknown>): void {
    if (!this.child || this.child.stdin.destroyed) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (pending) {
      this.pending = null;
      pending.abortCleanup?.();
      pending.reject(error);
    }
    for (const control of this.pendingControls.values()) {
      clearTimeout(control.timer);
      control.reject(error);
    }
    this.pendingControls.clear();
  }
}
