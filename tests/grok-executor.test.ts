import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeGrok } from "../src/session/executors/grok.js";
import type {
  ActiveRun,
  BaseExecutorHost,
  ExecutorOptions
} from "../src/session/executors/shared.js";
import { buildUserMessage } from "../src/session-prompts.js";
import { StateStore } from "../src/store.js";
import type { MessageTransport, SessionRecord } from "../src/types.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function session(cwd: string): SessionRecord {
  return {
    id: "grok-session",
    sdkSessionId: null,
    chatId: -1001,
    topicId: 42,
    projectName: "test",
    cwd,
    title: "Grok test",
    status: "queued",
    permissionMode: "default",
    provider: "grok",
    model: null,
    thinking: null,
    claudeEffort: null,
    codexModel: null,
    codexReasoning: null,
    codexThreadId: null,
    agyModel: null,
    agyThinkingLevel: null,
    agyConversationId: null,
    agyUsage: null,
    grokUsage: null,
    grokModel: null,
    grokReasoning: "high",
    grokSessionId: null,
    handoffSummary: null,
    goalCondition: null,
    leanMode: true,
    usageSnapshot: null,
    createdAt: 0,
    updatedAt: 0
  };
}

function setup(): {
  host: BaseExecutorHost;
  store: StateStore;
  active: Map<string, ActiveRun>;
  sent: string[];
  renames: string[];
} {
  const directory = mkdtempSync(join(tmpdir(), "chatkjb-grok-executor-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.sqlite"));
  store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
  store.createSession(session(directory));
  const sent: string[] = [];
  const transport: MessageTransport = {
    async sendText(_chatId, _topicId, text) { sent.push(text); return sent.length; },
    async editText(_chatId, _messageId, text) { sent.push(text); },
    async createTopic() { return 1; },
    async renameTopic() {},
    async deleteTopic() {},
    async sendDocument() {},
    async sendChatAction() {},
    async sendFile() {}
  };
  const options: ExecutorOptions = {
    debounceMs: 0,
    availableProviders: ["grok"],
    mcpToolTimeoutMs: 1_000,
    mcpMaxAttempts: 1,
    codexMcpTimeoutMs: 1_000,
    codexMcpHeartbeatMs: 1_000,
    longRunningMcpServers: new Set(),
    turnIdleTimeoutMs: 1_000,
    claudeMemoryDir: directory,
    modelCatalog: {
      clineProviders: [],
      clineModelsByProvider: {},
      claudeModels: [],
      codexModels: [],
      agyModels: [],
      grokModels: [
        { id: "grok-code-fast-1", label: "Grok Code Fast 1", source: "fallback" }
      ]
    }
  };
  const active = new Map<string, ActiveRun>();
  const renames: string[] = [];
  return {
    store,
    active,
    sent,
    renames,
    host: {
      store,
      transport,
      options,
      active,
      deleting: new Set(),
      applyHandoffSummary: (request) => request,
      safeRename: async (_session, title) => { renames.push(title); },
      requestUserInput: async () => ({})
    }
  };
}

describe("Grok executor", () => {
  it("turns a structured choice request into a same-session continuation", async () => {
    const { host, store, sent, renames } = setup();
    const prompts: string[] = [];
    const resumes: boolean[] = [];
    host.requestUserInput = vi.fn(async () => ({ "설치 범위는?": "로컬" }));
    const runGrok = vi.fn(async (prompt, options) => {
      prompts.push(prompt);
      resumes.push(options.resume);
      return {
        text: prompts.length === 1
          ? `[FINAL][[REQUEST_USER_INPUT]]
{"questions":[{"question":"설치 범위는?","options":[{"label":"로컬"},{"label":"전역"}]}]}
[[/REQUEST_USER_INPUT]][/FINAL]`
          : "[FINAL]로컬 설치를 완료했습니다.[/FINAL]",
        usage: null
      };
    });

    await executeGrok(host, {
      session: store.getSession("grok-session")!,
      prompt: "설치해 줘"
    }, { runGrok, createSessionId: () => "choice-grok-id" });

    expect(host.requestUserInput).toHaveBeenCalledOnce();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('"설치 범위는?": "로컬"');
    expect(resumes).toEqual([false, true]);
    expect(sent.join("\n")).not.toContain("REQUEST_USER_INPUT");
    expect(sent.join("\n")).toContain("로컬 설치를 완료했습니다.");
    expect(store.getSession("grok-session")?.status).toBe("done");
    expect(renames).toEqual(["[RUNNING] Grok test", "[DONE] Grok test"]);
  });

  it("persists the session and drains follow-up input on the same Grok conversation", async () => {
    const { host, store, active } = setup();
    const prompts: string[] = [];
    const resumes: boolean[] = [];
    const rules: string[] = [];
    const runGrok = vi.fn(async (prompt, options, _signal, onPartial) => {
      prompts.push(prompt);
      resumes.push(options.resume);
      rules.push(options.rules ?? "");
      onPartial?.("[PROGRESS]확인 중[/PROGRESS]");
      if (prompts.length === 1) {
        const run = active.get("grok-session")!;
        run.pendingTurns += 1;
        run.input.push(buildUserMessage("후속 지시", "next"));
      }
      return {
        text: `[FINAL]응답 ${prompts.length}[/FINAL]`,
        usage: {
          inputTokens: 10,
          cacheReadInputTokens: 0,
          outputTokens: 5,
          reasoningTokens: 0,
          totalTokens: 15
        }
      };
    });

    await executeGrok(host, {
      session: store.getSession("grok-session")!,
      prompt: "첫 지시"
    }, { runGrok, createSessionId: () => "fixed-grok-id" });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("후속 지시");
    expect(resumes).toEqual([false, true]);
    expect(rules[0]).toBe(rules[1]);
    expect(rules[0]).not.toContain("현재 시각은");
    expect(prompts[0]).toContain("현재 시각은");
    expect(store.getSession("grok-session")?.grokSessionId).toBe("fixed-grok-id");
    expect(JSON.parse(store.getSession("grok-session")?.grokUsage ?? "{}").totalTokens)
      .toBe(30);
    expect(store.getSession("grok-session")?.status).toBe("done");
    expect(active.size).toBe(0);
  });

  it("records a user stop as aborted and releases the active run", async () => {
    const { host, store, active, renames } = setup();
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const runGrok = vi.fn(async (_prompt, _options, signal) => {
      started();
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    });

    const execution = executeGrok(host, {
      session: store.getSession("grok-session")!,
      prompt: "중단할 작업"
    }, { runGrok, createSessionId: () => "fixed-grok-id" });
    await running;
    const run = active.get("grok-session")!;
    run.stopRequested = true;
    run.controller.abort();
    await execution;

    expect(store.getSession("grok-session")?.status).toBe("aborted");
    expect(active.size).toBe(0);
    expect(renames).toEqual(["[RUNNING] Grok test", "[STOP] Grok test"]);
  });

  it("marks the topic as errored when the Grok CLI fails", async () => {
    const { host, store, renames } = setup();
    const runGrok = vi.fn(async () => { throw new Error("grok cli exploded"); });

    await executeGrok(host, {
      session: store.getSession("grok-session")!,
      prompt: "실패할 작업"
    }, { runGrok, createSessionId: () => "fixed-grok-id" });

    expect(store.getSession("grok-session")?.status).toBe("error");
    expect(renames).toEqual(["[RUNNING] Grok test", "[ERROR] Grok test"]);
  });
});
