import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgyInteractiveSession } from "../src/agy-interactive.js";

const enabled = process.env.AGY_LIVE_TEST === "1" && Boolean(process.env.GEMINI_API_KEY?.trim());
const liveDescribe = enabled ? describe : describe.skip;

function liveOptions() {
  const pythonPath = process.env.AGY_SDK_PYTHON?.trim() || "python3";
  const bridgePath = join(process.cwd(), "scripts", "agy-sdk-bridge.py");
  const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY가 없습니다.");
  }
  return {
    pythonPath,
    bridgePath,
    cwd: process.cwd(),
    model: "gemini-3.5-flash",
    thinkingLevel: "minimal",
    permissionMode: "default",
    conversationId: null,
    systemInstructions: "You are a concise assistant for a live cancellation test.",
    connectorRegistry: join(homedir(), ".claude", "shared-resources", "connectors.json"),
    mcpServerNames: [],
    skillsPaths: [
      join(homedir(), ".claude", "skills"),
      join(homedir(), ".codex", "skills"),
      join(homedir(), ".gemini", "config", "skills")
    ],
    env: {
      ...process.env,
      GEMINI_API_KEY: geminiApiKey,
      PYTHONUNBUFFERED: "1"
    }
  };
}

liveDescribe("AgyInteractiveSession live cancel integration", () => {
  it(
    "interrupts a real streamed turn and reuses the bridge for a second turn",
    { timeout: 120_000 },
    async () => {
      const session = new AgyInteractiveSession(liveOptions());
      let firstDeltaAt = 0;
      let cancelAt = 0;
      let settledAt = 0;
      let interrupted = false;

      try {
        const turnPromise = session.runTurn(
          "한국어로 1500자 이상, 12개 이상의 항목을 포함해 cancellable streaming test를 설명해 주세요. "
          + "도구는 사용하지 말고 가능한 한 자세히 쓰세요.",
          undefined,
          (partial) => {
            if (interrupted || !partial) return;
            firstDeltaAt ||= Date.now();
            interrupted = true;
            cancelAt = Date.now();
            session.interrupt();
          }
        );

        await expect(turnPromise).rejects.toThrow(/turn aborted|aborted/i);
        settledAt = Date.now();

        const diag = {
          firstDeltaMs: firstDeltaAt ? firstDeltaAt - cancelAt : null,
          cancelToSettleMs: cancelAt && settledAt ? settledAt - cancelAt : null
        };
        expect(firstDeltaAt, `첫 delta가 오지 않았습니다: ${JSON.stringify(diag)}`).toBeGreaterThan(0);
        expect(cancelAt, `cancel 시각이 기록되지 않았습니다: ${JSON.stringify(diag)}`).toBeGreaterThan(0);
        expect(settledAt, `turn 종료 시각이 기록되지 않았습니다: ${JSON.stringify(diag)}`).toBeGreaterThan(0);

        const second = await session.runTurn("짧게 OK 한 단어만 답하세요.");
        expect(second.response.trim().length).toBeGreaterThan(0);
      } finally {
        session.close();
      }
    }
  );
});
