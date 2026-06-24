import { describe, expect, it } from "vitest";
import type { ReviewPacket, TaskContract } from "../src/orchestration/types.js";
import { buildFrontierReviewPrompt, parseFrontierDecision } from "../src/orchestration/frontier-review.js";

describe("frontier review", () => {
  const sampleTaskContract: TaskContract = {
    goal: "Implement user authentication",
    allowedFiles: ["src/auth/login.ts", "src/auth/types.ts"],
    forbiddenFiles: [],
    forbiddenChanges: ["modify database schema", "change API endpoints"],
    inputs: [],
    expectedOutput: [],
    acceptanceCriteria: [],
    diffBudget: { maxChangedFiles: 8, maxAddedLoc: 600, maxDeletedLoc: 300 },
    stopConditions: []
  };

  const samplePacket: ReviewPacket = {
    originalGoal: "Add login functionality",
    currentTaskContract: sampleTaskContract,
    riskLevel: "L2",
    allowedFiles: ["src/auth/login.ts", "src/auth/types.ts"],
    forbiddenChanges: ["modify database schema", "change API endpoints"],
    architectureNotes: "Use JWT tokens for session management",
    changedFileInventory: ["src/auth/login.ts", "src/auth/types.ts"],
    diffSummary: "Added login function, updated types",
    testResultSummary: "All tests pass",
    typecheckSummary: "No TypeScript errors",
    lintSummary: "No linting issues",
    coverageSummary: "95% coverage",
    unresolvedBlockers: ["Need to handle edge cases"],
    reviewQuestions: ["Is the implementation secure?"],
    rawEvidencePointers: ["auth_test.ts", "login_function.ts"]
  };

  it("buildFrontierReviewPrompt includes all required sections", () => {
    const prompt = buildFrontierReviewPrompt(samplePacket);
    expect(prompt).toContain(samplePacket.originalGoal);
    expect(prompt).toContain("src/auth/login.ts");
    expect(prompt).toContain("modify database schema");
    expect(prompt).toContain("Is the implementation secure?");
  });

  it("buildFrontierReviewPrompt handles empty arrays", () => {
    const emptyPacket: ReviewPacket = {
      ...samplePacket,
      allowedFiles: [],
      forbiddenChanges: [],
      unresolvedBlockers: [],
      reviewQuestions: [],
      rawEvidencePointers: []
    };
    const prompt = buildFrontierReviewPrompt(emptyPacket);
    expect(prompt).toContain("- (none)");
  });

  it("parseFrontierDecision handles valid JSON", () => {
    const json = `{"decision":"continue","approved":true,"requiredChanges":[],"riskLevel":"L2","architecturalNotes":"ok"}`;
    const result = parseFrontierDecision(json);
    expect(result).toEqual({
      decision: "continue",
      approved: true,
      requiredChanges: [],
      riskLevel: "L2",
      architecturalNotes: "ok"
    });
  });

  it("parseFrontierDecision handles messy JSON with code fence", () => {
    const messy = `
    Here is the result:
    \`\`\`json
    {"decision":"redirect","approved":false,"requiredChanges":["fix linting"],"riskLevel":"L3","architecturalNotes":"not good"}
    \`\`\`
    `;
    const result = parseFrontierDecision(messy);
    expect(result?.decision).toBe("redirect");
  });

  it("parseFrontierDecision defaults approved to true when decision is continue", () => {
    const json = `{"decision":"continue","requiredChanges":[],"riskLevel":"L1","architecturalNotes":""}`;
    const result = parseFrontierDecision(json);
    expect(result?.approved).toBe(true);
  });

  it("parseFrontierDecision returns null for invalid decision", () => {
    const json = `{"decision":"maybe","approved":true,"requiredChanges":[],"riskLevel":"L2","architecturalNotes":""}`;
    const result = parseFrontierDecision(json);
    expect(result).toBeNull();
  });

  it("parseFrontierDecision returns null for garbage input", () => {
    const result = parseFrontierDecision("hello world");
    expect(result).toBeNull();
  });
});
