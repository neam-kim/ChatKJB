import { describe, expect, it } from "vitest";
import type { TaskContract } from "../src/orchestration/types.js";
import {
  ollamaConfig,
  ollamaTimeoutForModel,
  TIER2_JUDGE_TIMEOUT_MS,
  buildTier1Prompt,
  buildTier3Prompt,
  extractCodeBlocks,
} from "../src/orchestration/local-tiers.js";

describe("ollamaConfig", () => {
  it("returns defaults when env is empty", () => {
    const config = ollamaConfig({});
    expect(config).toEqual({
      url: "http://localhost:11434/api/chat",
      timeoutMs: 120000,
    });
  });
});

describe("ollamaTimeoutForModel", () => {
  it("forces qwen3.6 judge calls to 300 seconds", () => {
    expect(ollamaTimeoutForModel("qwen3.6:27b-96k", {
      url: "http://localhost:11434/api/chat",
      timeoutMs: 120000,
    })).toBe(TIER2_JUDGE_TIMEOUT_MS);
  });

  it("keeps configured timeout for other local models", () => {
    expect(ollamaTimeoutForModel("qwen3-coder:30b-96k", {
      url: "http://localhost:11434/api/chat",
      timeoutMs: 45000,
    })).toBe(45000);
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
