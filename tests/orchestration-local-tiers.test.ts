import { describe, expect, it } from "vitest";
import type { TaskContract } from "../src/orchestration/types.js";
import {
  ollamaConfig,
  ollamaTimeoutForModel,
  estimateNumCtx,
  OLLAMA_DEFAULT_TIMEOUT_MS,
  OLLAMA_MAX_NUM_CTX,
  OLLAMA_MIN_NUM_CTX,
  buildTier1Prompt,
  buildTier3Prompt,
  extractCodeBlocks,
} from "../src/orchestration/local-tiers.js";

describe("ollamaConfig", () => {
  it("defaults timeout to 300 seconds when env is empty", () => {
    const config = ollamaConfig({});
    expect(config).toEqual({
      url: "http://localhost:11434/api/chat",
      timeoutMs: OLLAMA_DEFAULT_TIMEOUT_MS,
    });
    expect(OLLAMA_DEFAULT_TIMEOUT_MS).toBe(300000);
  });

  it("honors OLLAMA_TIMEOUT_MS override", () => {
    expect(ollamaConfig({ OLLAMA_TIMEOUT_MS: "45000" }).timeoutMs).toBe(45000);
  });
});

describe("ollamaTimeoutForModel", () => {
  it("returns config timeout regardless of model", () => {
    const config = { url: "x", timeoutMs: 300000 };
    expect(ollamaTimeoutForModel("qwen3.6:27b-96k", config)).toBe(300000);
    expect(ollamaTimeoutForModel("qwen3-coder:30b-96k", config)).toBe(300000);
  });

  it("does not special-case any model", () => {
    const config = { url: "x", timeoutMs: 45000 };
    expect(ollamaTimeoutForModel("qwen3.6:27b-96k", config)).toBe(45000);
    expect(ollamaTimeoutForModel("qwen3-coder:30b-96k", config)).toBe(45000);
  });
});

describe("estimateNumCtx", () => {
  it("clamps tiny prompts to the minimum context", () => {
    expect(estimateNumCtx({ system: "a", user: "b" })).toBe(OLLAMA_MIN_NUM_CTX);
  });

  it("clamps huge prompts to the 96k maximum", () => {
    expect(estimateNumCtx({ system: "a".repeat(500000), user: "b".repeat(500000) })).toBe(
      OLLAMA_MAX_NUM_CTX,
    );
  });

  it("scales between min and max for medium prompts and rounds to 1024", () => {
    const ctx = estimateNumCtx({ system: "a".repeat(30000), user: "b".repeat(30000) });
    expect(ctx).toBeGreaterThan(OLLAMA_MIN_NUM_CTX);
    expect(ctx).toBeLessThan(OLLAMA_MAX_NUM_CTX);
    expect(ctx % 1024).toBe(0);
  });
});

describe("buildTier1Prompt", () => {
  it("trims user input and includes forbidden keywords", () => {
    const prompt = buildTier1Prompt("  hi  ");
    expect(prompt.user).toBe("hi");
    expect(prompt.system).toContain("FORBIDDEN");
    expect(prompt.system).toContain("금지");
  });
});

describe("buildTier3Prompt", () => {
  it("includes all contract fields in user string", () => {
    const contract: TaskContract = {
      goal: "fix bug",
      allowedFiles: ["src/a.ts"],
      forbiddenFiles: ["src/b.ts"],
      forbiddenChanges: ["public API 변경 금지"],
      inputs: ["log.txt"],
      expectedOutput: ["fixed"],
      acceptanceCriteria: ["works"],
      stopConditions: [],
      diffBudget: { maxChangedFiles: 3, maxAddedLoc: 200, maxDeletedLoc: 120 },
    };
    const prompt = buildTier3Prompt(contract);
    expect(prompt.user).toContain("src/a.ts");
    expect(prompt.user).toContain("public API 변경 금지");
    expect(prompt.user).toContain("maxChangedFiles:3");
    expect(prompt.user).toContain("maxAddedLoc:200");
    expect(prompt.user).toContain("maxDeletedLoc:120");
  });
});

describe("extractCodeBlocks", () => {
  it("parses two code blocks correctly", () => {
    const input = `
\`\`\`typescript
// src/x.ts
const x = 1;
\`\`\`

\`\`\`javascript
console.log("hello");
\`\`\`
`;
    const result = extractCodeBlocks(input);
    expect(result).toEqual([
      { path: "src/x.ts", code: "// src/x.ts\nconst x = 1;" },
      { path: null, code: 'console.log("hello");' },
    ]);
  });
});
