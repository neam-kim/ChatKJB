import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;

export interface CodexGoalClient {
  setGoal(
    threadId: string,
    objective: string,
    options?: { codexHome?: string | null; tokenBudget?: number | null }
  ): Promise<void>;
  clearGoal(threadId: string, options?: { codexHome?: string | null }): Promise<boolean>;
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
    options: { codexHome?: string | null; tokenBudget?: number | null } = {}
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

  async clearGoal(threadId: string, options: { codexHome?: string | null } = {}): Promise<boolean> {
    const result = await this.request("thread/goal/clear", { threadId }, options.codexHome);
    return result.cleared === true;
  }

  private request(method: string, params: JsonObject, codexHome?: string | null): Promise<JsonObject> {
    const child = spawn(this.codexCommand, ["app-server", "--stdio"], {
      env: {
        ...process.env,
        ...(codexHome && codexHome.trim() ? { CODEX_HOME: codexHome } : {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const pending = new Map<number, PendingRequest>();
    const stderr: string[] = [];
    let nextId = 1;
    let settled = false;

    const cleanup = () => {
      for (const item of pending.values()) clearTimeout(item.timer);
      pending.clear();
      if (!child.killed) child.kill("SIGTERM");
    };

    const failAll = (error: Error) => {
      if (settled) return;
      settled = true;
      for (const item of pending.values()) item.reject(error);
      cleanup();
    };

    const send = (requestMethod: string, requestParams: JsonObject | null, timeoutLabel: string) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
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

    const lines = createInterface({ input: child.stdout });
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
      stderr.push(String(chunk));
    });
    child.on("error", (error) => failAll(error));
    child.on("close", (code) => {
      if (settled || pending.size === 0) return;
      failAll(new Error(
        `Codex app-server가 응답 전에 종료되었습니다(code=${code}). ${stderr.join("").trim()}`
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
      cleanup();
      return result;
    }).catch((error) => {
      cleanup();
      throw error;
    });
  }
}
