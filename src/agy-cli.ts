import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeAgyResponse, type AgyInteractiveTurnResult, type AgyLiveStatus } from "./agy-interactive.js";
import { terminateChildTree } from "./child-process.js";

const DEFAULT_PRINT_TIMEOUT_MS = 30 * 60_000;
const CONVERSATION_RE = /Print mode: conversation=([0-9a-f-]{36}), sending message/i;

export interface AgyCliSessionOptions {
  executable: string;
  cwd: string;
  model: string;
  permissionArgs: string[];
  conversationId: string | null;
  env: NodeJS.ProcessEnv;
  printTimeoutMs?: number;
  logDir?: string;
}

export class AgyCliSession {
  private child: ChildProcess | null = null;
  private terminationTimer: NodeJS.Timeout | undefined;
  private conversationId: string | null;

  constructor(private readonly options: AgyCliSessionOptions) {
    this.conversationId = options.conversationId;
  }

  get alive(): boolean {
    return !!this.child && this.child.exitCode === null;
  }

  async runTurn(
    prompt: string,
    signal?: AbortSignal
  ): Promise<AgyInteractiveTurnResult> {
    if (this.alive) throw new Error("Antigravity CLI가 이미 다른 턴을 실행 중입니다.");
    const logFile = this.nextLogFile();
    const timeoutMs = this.options.printTimeoutMs ?? DEFAULT_PRINT_TIMEOUT_MS;
    const args = [
      ...this.options.permissionArgs,
      "--model",
      this.options.model,
      "--log-file",
      logFile,
      "--print-timeout",
      `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
      ...(this.conversationId ? ["--conversation", this.conversationId] : []),
      "--print",
      prompt
    ];

    return new Promise<AgyInteractiveTurnResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let pendingError: Error | null = null;
      this.clearTerminationTimer();
      const child = spawn(this.options.executable, args, {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true
      });
      this.child = child;

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const onAbort = () => {
        pendingError = new Error("turn aborted");
        this.terminate(child);
      };
      if (signal) {
        if (!signal.aborted) signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-20_000);
      });
      child.on("error", (error) => {
        this.clearTerminationTimer();
        signal?.removeEventListener("abort", onAbort);
        if (this.child === child) this.child = null;
        rmSync(logFile, { force: true });
        finishReject(error);
      });
      child.on("close", (code) => {
        this.clearTerminationTimer();
        signal?.removeEventListener("abort", onAbort);
        if (this.child === child) this.child = null;
        if (settled) return;
        if (pendingError) {
          rmSync(logFile, { force: true });
          finishReject(pendingError);
          return;
        }
        if (code !== 0) {
          rmSync(logFile, { force: true });
          finishReject(new Error(
            `Antigravity CLI 실행 실패 (코드 ${code ?? "unknown"})`
            + (stderr.trim() ? `: ${stderr.trim().slice(-1000)}` : "")
          ));
          return;
        }
        const parsedConversationId = this.readConversationId(logFile);
        rmSync(logFile, { force: true });
        this.conversationId = parsedConversationId ?? this.conversationId;
        const response = normalizeAgyResponse(stdout);
        if (!response) {
          finishReject(new Error("Antigravity CLI가 성공 종료와 함께 빈 응답을 반환했습니다."));
          return;
        }
        settled = true;
        resolve({
          response,
          conversationId: this.conversationId
        });
      });
      if (signal?.aborted) onAbort();
    });
  }

  async getStatus(): Promise<AgyLiveStatus> {
    return {
      isIdle: !this.alive,
      turnCount: null,
      conversationId: this.conversationId
    };
  }

  interrupt(): void {
    if (this.child && this.child.exitCode === null) this.terminate(this.child);
  }

  close(): void {
    if (this.child && this.child.exitCode === null) this.terminate(this.child);
  }

  private terminate(child: ChildProcess): void {
    this.terminationTimer ??= terminateChildTree(child);
  }

  private clearTerminationTimer(): void {
    if (this.terminationTimer) clearTimeout(this.terminationTimer);
    this.terminationTimer = undefined;
  }

  private nextLogFile(): string {
    const dir = this.options.logDir ?? join(homedir(), ".gemini", "antigravity-cli", "log");
    mkdirSync(dir, { recursive: true });
    return join(dir, `chatkjb-${Date.now()}-${randomUUID()}.log`);
  }

  private readConversationId(logFile: string): string | null {
    if (!existsSync(logFile)) return null;
    const text = readFileSync(logFile, "utf8");
    return text.match(CONVERSATION_RE)?.[1] ?? null;
  }
}
