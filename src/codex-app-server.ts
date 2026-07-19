import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { terminateChildTree } from "./child-process.js";
import { buildCodexEnvironment } from "./session-environment.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_STDERR_BYTES = 16 * 1024;

type JsonObject = Record<string, unknown>;

export interface CodexGoalClient {
  setGoal(
    threadId: string,
    objective: string,
    options?: { codexHome?: string | null; tokenBudget?: number | null; }
  ): Promise<void>;
  clearGoal(threadId: string, options?: { codexHome?: string | null; }): Promise<boolean>;
}

interface PendingRequest {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexAppServerGoalClient implements CodexGoalClient {
  constructor(
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly codexCommand = process.env.CODEX_EXECUTABLE || "codex"
  ) {}

  async setGoal(
    threadId: string,
    objective: string,
    options: { codexHome?: string | null; tokenBudget?: number | null; } = {}
  ): Promise<void> {
    await this.request(
      "thread/goal/set",
      {
        threadId,
        objective,
        status: "active",
        tokenBudget: options.tokenBudget ?? null
      },
      options.codexHome
    );
  }

  async clearGoal(threadId: string, options: { codexHome?: string | null; } = {}): Promise<boolean> {
    const result = await this.request("thread/goal/clear", { threadId }, options.codexHome);
    return result.cleared === true;
  }

  private request(method: string, params: JsonObject, codexHome?: string | null): Promise<JsonObject> {
    const child = spawn(this.codexCommand, ["app-server", "--stdio"], {
      // LaunchAgent PATH에는 nvm의 node/codex가 없으므로 일반 Codex 실행과 같은 환경
      // 보정을 사용한다. 선택 계정의 CODEX_HOME과 구독 전용 API-key 제거도 함께 맞춘다.
      env: buildCodexEnvironment(codexHome ?? undefined),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });
    const pending = new Map<number, PendingRequest>();
    let stderr = "";
    let nextId = 1;
    let settled = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    const lines = createInterface({ input: child.stdout });
    const childClosed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    let cleanupStarted = false;

    const cleanup = async () => {
      if (cleanupStarted) return childClosed;
      cleanupStarted = true;
      for (const item of pending.values()) clearTimeout(item.timer);
      pending.clear();
      lines.close();
      child.stdin.end();
      terminationTimer ??= terminateChildTree(child);
      await childClosed;
      if (terminationTimer) clearTimeout(terminationTimer);
    };

    const failAll = (error: Error) => {
      if (settled) return;
      settled = true;
      for (const item of pending.values()) item.reject(error);
      void cleanup();
    };

    const send = (requestMethod: string, requestParams: JsonObject | null, timeoutLabel: string) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        failAll(new Error(`Codex app-server ${timeoutLabel} 요청 시간이 초과되었습니다.`));
      }, this.timeoutMs);
      timer.unref();
      const promise = new Promise<JsonObject>((resolve, reject) => {
        pending.set(id, { resolve, reject, timer });
      });
      child.stdin.write(JSON.stringify({
        id,
        method: requestMethod,
        params: requestParams
      }) + "\n");
      return promise;
    };

    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message: JsonObject;
      try {
        message = JSON.parse(line) as JsonObject;
      } catch {
        return;
      }
      const id = message.id;
      if (typeof id !== "number") return;
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id);
      clearTimeout(item.timer);
      if (message.error) {
        item.reject(new Error(`Codex app-server ${method} 실패: ${JSON.stringify(message.error)}`));
        return;
      }
      const result = message.result;
      item.resolve(result && typeof result === "object" && !Array.isArray(result)
        ? result as JsonObject
        : {});
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (error) => failAll(error));
    child.on("close", (code) => {
      if (terminationTimer) clearTimeout(terminationTimer);
      if (settled || pending.size === 0) return;
      failAll(new Error(
        `Codex app-server가 응답 전에 종료되었습니다(code=${code}). ${stderr.trim()}`
      ));
    });

    return send(
      "initialize",
      {
        clientInfo: { name: "chatkjb", version: "0.1.0" },
        capabilities: null
      },
      "initialize"
    ).then(async () => {
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      const result = await send(method, params, method);
      settled = true;
      await cleanup();
      return result;
    }).catch(async (error) => {
      await cleanup();
      throw error;
    });
  }
}
