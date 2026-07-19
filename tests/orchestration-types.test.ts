// tests/orchestration-types.test.ts
import { describe, expect, it } from "vitest";
import {
  DIFF_BUDGET_DEFAULTS,
  diffBudgetForRisk,
  isWithinDiffBudget,
  ReviewPacket,
  validateReviewPacket,
  validateTaskContract
} from "../src/orchestration/types.js";

describe("diffBudgetForRisk", () => {
  it("returns correct budget for L0", () => {
    expect(diffBudgetForRisk("L0")).toEqual(DIFF_BUDGET_DEFAULTS.L0);
  });

  it("returns correct budget for L1", () => {
    expect(diffBudgetForRisk("L1")).toEqual(DIFF_BUDGET_DEFAULTS.L1);
  });

  it("returns correct budget for L2", () => {
    expect(diffBudgetForRisk("L2")).toEqual(DIFF_BUDGET_DEFAULTS.L2);
  });

  it("returns correct budget for L3", () => {
    expect(diffBudgetForRisk("L3")).toEqual(DIFF_BUDGET_DEFAULTS.L3);
  });

  it("returns correct budget for L4 with infinity", () => {
    const budget = diffBudgetForRisk("L4");
    expect(budget.maxChangedFiles).toBe(Infinity);
    expect(budget.maxAddedLoc).toBe(Infinity);
    expect(budget.maxDeletedLoc).toBe(Infinity);
  });
});

describe("isWithinDiffBudget", () => {
  it("returns true when all stats are within budget", () => {
    const stats = { changedFiles: 1, addedLoc: 50, deletedLoc: 50 };
    const budget = { maxChangedFiles: 2, maxAddedLoc: 80, maxDeletedLoc: 80 };
    expect(isWithinDiffBudget(stats, budget)).toBe(true);
  });

  it("returns false when changedFiles exceeds budget", () => {
    const stats = { changedFiles: 3, addedLoc: 50, deletedLoc: 50 };
    const budget = { maxChangedFiles: 2, maxAddedLoc: 80, maxDeletedLoc: 80 };
    expect(isWithinDiffBudget(stats, budget)).toBe(false);
  });

  it("returns false when addedLoc exceeds budget", () => {
    const stats = { changedFiles: 1, addedLoc: 90, deletedLoc: 50 };
    const budget = { maxChangedFiles: 2, maxAddedLoc: 80, maxDeletedLoc: 80 };
    expect(isWithinDiffBudget(stats, budget)).toBe(false);
  });

  it("returns false when deletedLoc exceeds budget", () => {
    const stats = { changedFiles: 1, addedLoc: 50, deletedLoc: 90 };
    const budget = { maxChangedFiles: 2, maxAddedLoc: 80, maxDeletedLoc: 80 };
    expect(isWithinDiffBudget(stats, budget)).toBe(false);
  });

  it("returns true when stats equal to budget", () => {
    const stats = { changedFiles: 2, addedLoc: 80, deletedLoc: 80 };
    const budget = { maxChangedFiles: 2, maxAddedLoc: 80, maxDeletedLoc: 80 };
    expect(isWithinDiffBudget(stats, budget)).toBe(true);
  });
});

describe("validateTaskContract", () => {
  it("returns empty array for valid contract", () => {
    const contract = {
      goal: "Implement feature",
      allowedFiles: ["src/a.ts"],
      forbiddenFiles: ["src/b.ts"],
      forbiddenChanges: [],
      inputs: [],
      expectedOutput: [],
      acceptanceCriteria: ["criteria"],
      diffBudget: DIFF_BUDGET_DEFAULTS.L0,
      stopConditions: [],
    };
    expect(validateTaskContract(contract)).toEqual([]);
  });

  it("includes 'goal is empty' for empty goal", () => {
    const contract = {
      goal: "",
      allowedFiles: ["src/a.ts"],
      forbiddenFiles: [],
      forbiddenChanges: [],
      inputs: [],
      expectedOutput: [],
      acceptanceCriteria: ["criteria"],
      diffBudget: DIFF_BUDGET_DEFAULTS.L0,
      stopConditions: [],
    };
    expect(validateTaskContract(contract)).toContain("goal is empty");
  });

  it("includes 'allowedFiles is empty' for empty allowedFiles", () => {
    const contract = {
      goal: "Implement feature",
      allowedFiles: [],
      forbiddenFiles: [],
      forbiddenChanges: [],
      inputs: [],
      expectedOutput: [],
      acceptanceCriteria: ["criteria"],
      diffBudget: DIFF_BUDGET_DEFAULTS.L0,
      stopConditions: [],
    };
    expect(validateTaskContract(contract)).toContain("allowedFiles is empty");
  });

  it("includes 'acceptanceCriteria is empty' for empty acceptanceCriteria", () => {
    const contract = {
      goal: "Implement feature",
      allowedFiles: ["src/a.ts"],
      forbiddenFiles: [],
      forbiddenChanges: [],
      inputs: [],
      expectedOutput: [],
      acceptanceCriteria: [],
      diffBudget: DIFF_BUDGET_DEFAULTS.L0,
      stopConditions: [],
    };
    expect(validateTaskContract(contract)).toContain("acceptanceCriteria is empty");
  });

  it("includes 'diffBudget has negative values' for negative budget", () => {
    const contract = {
      goal: "Implement feature",
      allowedFiles: ["src/a.ts"],
      forbiddenFiles: [],
      forbiddenChanges: [],
      inputs: [],
      expectedOutput: [],
      acceptanceCriteria: ["criteria"],
      diffBudget: { maxChangedFiles: -1, maxAddedLoc: 0, maxDeletedLoc: 0 },
      stopConditions: [],
    };
    expect(validateTaskContract(contract)).toContain("diffBudget has negative values");
  });

  it("includes conflicting file messages for paths in both allowed and forbidden", () => {
    const contract = {
      goal: "Implement feature",
      allowedFiles: ["src/a.ts", "src/b.ts"],
      forbiddenFiles: ["src/b.ts", "src/c.ts"],
      forbiddenChanges: [],
      inputs: [],
      expectedOutput: [],
      acceptanceCriteria: ["criteria"],
      diffBudget: DIFF_BUDGET_DEFAULTS.L0,
      stopConditions: [],
    };
    expect(validateTaskContract(contract)).toContain("conflicting file: src/b.ts");
  });
});

describe("validateReviewPacket", () => {
  it("returns empty array for valid packet", () => {
    const packet: ReviewPacket = {
      originalGoal: "Implement feature",
      currentTaskContract: {
        goal: "Implement feature",
        allowedFiles: ["src/a.ts"],
        forbiddenFiles: [],
        forbiddenChanges: [],
        inputs: [],
        expectedOutput: [],
        acceptanceCriteria: ["criteria"],
        diffBudget: DIFF_BUDGET_DEFAULTS.L0,
        stopConditions: [],
      },
      riskLevel: "L0",
      allowedFiles: ["src/a.ts"],
      forbiddenChanges: [],
      architectureNotes: "",
      changedFileInventory: [],
      diffSummary: "",
      testResultSummary: "",
      typecheckSummary: "",
      lintSummary: "",
      coverageSummary: "",
      unresolvedBlockers: [],
      reviewQuestions: ["q1"],
      rawEvidencePointers: ["e1"],
    };
    expect(validateReviewPacket(packet)).toEqual([]);
  });

  it("includes 'reviewQuestions is empty' for empty reviewQuestions", () => {
    const packet: ReviewPacket = {
      originalGoal: "Implement feature",
      currentTaskContract: {
        goal: "Implement feature",
        allowedFiles: ["src/a.ts"],
        forbiddenFiles: [],
        forbiddenChanges: [],
        inputs: [],
        expectedOutput: [],
        acceptanceCriteria: ["criteria"],
        diffBudget: DIFF_BUDGET_DEFAULTS.L0,
        stopConditions: [],
      },
      riskLevel: "L0",
      allowedFiles: ["src/a.ts"],
      forbiddenChanges: [],
      architectureNotes: "",
      changedFileInventory: [],
      diffSummary: "",
      testResultSummary: "",
      typecheckSummary: "",
      lintSummary: "",
      coverageSummary: "",
      unresolvedBlockers: [],
      reviewQuestions: [],
      rawEvidencePointers: ["e1"],
    };
    expect(validateReviewPacket(packet)).toContain("reviewQuestions is empty");
  });

  it("includes 'rawEvidencePointers is empty' for empty rawEvidencePointers", () => {
    const packet: ReviewPacket = {
      originalGoal: "Implement feature",
      currentTaskContract: {
        goal: "Implement feature",
        allowedFiles: ["src/a.ts"],
        forbiddenFiles: [],
        forbiddenChanges: [],
        inputs: [],
        expectedOutput: [],
        acceptanceCriteria: ["criteria"],
        diffBudget: DIFF_BUDGET_DEFAULTS.L0,
        stopConditions: [],
      },
      riskLevel: "L0",
      allowedFiles: ["src/a.ts"],
      forbiddenChanges: [],
      architectureNotes: "",
      changedFileInventory: [],
      diffSummary: "",
      testResultSummary: "",
      typecheckSummary: "",
      lintSummary: "",
      coverageSummary: "",
      unresolvedBlockers: [],
      reviewQuestions: ["q1"],
      rawEvidencePointers: [],
    };
    expect(validateReviewPacket(packet)).toContain("rawEvidencePointers is empty");
  });
});
