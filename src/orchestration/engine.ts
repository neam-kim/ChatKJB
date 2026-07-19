import type { CheckpointDecision, RiskLevel } from "./types.js";
export { diffBudgetForRisk } from "./types.js";

export interface RiskSignals {
  docsOrFormatOnly: boolean;
  securityOrDataIntegrity: boolean;
  schemaOrMigration: boolean;
  architectureChange: boolean;
  multiService: boolean;
  publicApiChange: boolean;
  multiFileIntegration: boolean;
  changedFiles: number;
}

export function classifyRisk(s: RiskSignals): RiskLevel {
  if (s.securityOrDataIntegrity || s.schemaOrMigration || s.architectureChange || s.multiService) {
    return "L4";
  } else if (s.publicApiChange || s.multiFileIntegration || s.changedFiles > 8) {
    return "L3";
  } else if (s.docsOrFormatOnly) {
    return "L0";
  } else if (s.changedFiles > 1) {
    return "L2";
  } else {
    return "L1";
  }
}

export function checkpointsForRisk(risk: RiskLevel): string[] {
  switch (risk) {
    case "L0": return [];
    case "L1": return ["final"];
    case "L2": return ["plan", "final"];
    case "L3": return ["plan", "vertical_slice", "midpoint", "final"];
    case "L4": return ["plan", "vertical_slice", "midpoint", "test_hardening", "final", "human_approval"];
  }
}

export function frontierPacketBudgetTokens(risk: RiskLevel): number {
  switch (risk) {
    case "L0": return 10000;
    case "L1": return 10000;
    case "L2": return 20000;
    case "L3": return 40000;
    case "L4": return 80000;
  }
}

export interface EscalationSignals {
  localPatchTooLarge: boolean;
  testsFailAfterLocalRepair: boolean;
  minimalDiffRewriteNeeded: boolean;
  subtleBugSuspected: boolean;
  architectureBoundaryUnclear: boolean;
  publicApiImpactPossible: boolean;
  dependencyGraphChange: boolean;
  schemaOrMigrationImpact: boolean;
  securityOrDataRisk: boolean;
  checkpointDecisionRequired: boolean;
  l4CriticalChange: boolean;
  rollbackRiskHigh: boolean;
  ambiguousRequirement: boolean;
  irreversibleMigration: boolean;
}

export type EscalationTarget = "none" | "tier4b" | "tier5" | "human";

export function escalationTarget(s: EscalationSignals): EscalationTarget {
  if (s.l4CriticalChange || s.rollbackRiskHigh || s.ambiguousRequirement || s.irreversibleMigration || s.securityOrDataRisk) {
    return "human";
  } else if (s.architectureBoundaryUnclear || s.publicApiImpactPossible || s.dependencyGraphChange || s.schemaOrMigrationImpact || s.checkpointDecisionRequired) {
    return "tier5";
  } else if (s.localPatchTooLarge || s.testsFailAfterLocalRepair || s.minimalDiffRewriteNeeded || s.subtleBugSuspected) {
    return "tier4b";
  } else {
    return "none";
  }
}

export const TIER_PATH: Record<RiskLevel, string[]> = {
  L0: ["Tier_0", "Tier_1", "Tier_4a"],
  L1: ["Tier_0", "Tier_2", "Tier_3", "Tier_4b"],
  L2: ["Tier_0", "Tier_5_Plan", "Tier_2", "Tier_3", "Tier_4b", "Tier_5_Final"],
  L3: ["Tier_0", "Tier_5_Plan", "Tier_2", "Tier_3", "Tier_4b", "Tier_5_Vertical_Slice", "Tier_3", "Tier_4b", "Tier_5_Midpoint", "Tier_4b_Test_Hardening", "Tier_5_Final"],
  L4: ["Tier_0", "Tier_5_Plan", "Tier_2", "Tier_3", "Tier_4b", "Tier_5_Vertical_Slice", "Tier_3", "Tier_4b", "Tier_5_Midpoint", "Tier_4b_Test_Hardening", "Tier_5_Test_Hardening_Review", "Tier_5_Final", "Human_Approval"]
};

export function tierPathForRisk(risk: RiskLevel): string[] {
  return TIER_PATH[risk];
}

export const CHECKPOINT_DECISIONS: readonly CheckpointDecision[] = ["continue", "redirect", "rollback", "escalate_to_human"] as const;

export function isValidCheckpointDecision(x: string): x is CheckpointDecision {
  return CHECKPOINT_DECISIONS.includes(x as CheckpointDecision);
}
