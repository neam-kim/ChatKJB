// src/orchestration/types.ts
export type RiskLevel = "L0" | "L1" | "L2" | "L3" | "L4";

export interface DiffBudget {
  maxChangedFiles: number;
  maxAddedLoc: number;
  maxDeletedLoc: number;
}

export const DIFF_BUDGET_DEFAULTS: Record<RiskLevel, DiffBudget> = {
  L0: { maxChangedFiles: 2, maxAddedLoc: 80, maxDeletedLoc: 80 },
  L1: { maxChangedFiles: 3, maxAddedLoc: 200, maxDeletedLoc: 120 },
  L2: { maxChangedFiles: 8, maxAddedLoc: 600, maxDeletedLoc: 300 },
  L3: { maxChangedFiles: 15, maxAddedLoc: 1200, maxDeletedLoc: 800 },
  L4: { maxChangedFiles: Infinity, maxAddedLoc: Infinity, maxDeletedLoc: Infinity },
};

export function diffBudgetForRisk(risk: RiskLevel): DiffBudget {
  return DIFF_BUDGET_DEFAULTS[risk];
}

export interface DiffStats {
  changedFiles: number;
  addedLoc: number;
  deletedLoc: number;
}

export function isWithinDiffBudget(stats: DiffStats, budget: DiffBudget): boolean {
  return (
    stats.changedFiles <= budget.maxChangedFiles &&
    stats.addedLoc <= budget.maxAddedLoc &&
    stats.deletedLoc <= budget.maxDeletedLoc
  );
}

export type CheckpointDecision =
  | "continue"
  | "redirect"
  | "rollback"
  | "escalate_to_human";

export interface TaskContract {
  goal: string;
  allowedFiles: string[];
  forbiddenFiles: string[];
  forbiddenChanges: string[];
  inputs: string[];
  expectedOutput: string[];
  acceptanceCriteria: string[];
  diffBudget: DiffBudget;
  stopConditions: string[];
}

export function validateTaskContract(contract: TaskContract): string[] {
  const problems: string[] = [];

  if (!contract.goal || contract.goal.trim() === "") {
    problems.push("goal is empty");
  }

  if (contract.allowedFiles.length === 0) {
    problems.push("allowedFiles is empty");
  }

  if (contract.acceptanceCriteria.length === 0) {
    problems.push("acceptanceCriteria is empty");
  }

  const { maxChangedFiles, maxAddedLoc, maxDeletedLoc } = contract.diffBudget;
  if (maxChangedFiles < 0 || maxAddedLoc < 0 || maxDeletedLoc < 0) {
    problems.push("diffBudget has negative values");
  }

  for (const path of contract.allowedFiles) {
    if (contract.forbiddenFiles.includes(path)) {
      problems.push(`conflicting file: ${path}`);
    }
  }

  return problems;
}

export interface ReviewPacket {
  originalGoal: string;
  currentTaskContract: TaskContract;
  riskLevel: RiskLevel;
  allowedFiles: string[];
  forbiddenChanges: string[];
  architectureNotes: string;
  changedFileInventory: string[];
  diffSummary: string;
  testResultSummary: string;
  typecheckSummary: string;
  lintSummary: string;
  coverageSummary: string;
  unresolvedBlockers: string[];
  reviewQuestions: string[];
  rawEvidencePointers: string[];
}

export function validateReviewPacket(packet: ReviewPacket): string[] {
  const problems: string[] = [];

  if (!packet.originalGoal || packet.originalGoal.trim() === "") {
    problems.push("originalGoal is empty");
  }

  if (packet.reviewQuestions.length === 0) {
    problems.push("reviewQuestions is empty");
  }

  if (packet.rawEvidencePointers.length === 0) {
    problems.push("rawEvidencePointers is empty");
  }

  return problems;
}
