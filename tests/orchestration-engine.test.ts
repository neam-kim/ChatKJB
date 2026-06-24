import { describe, expect, it } from "vitest";
import {
  classifyRisk,
  checkpointsForRisk,
  frontierPacketBudgetTokens,
  escalationTarget,
  tierPathForRisk,
  isValidCheckpointDecision,
  type RiskSignals,
  type EscalationSignals
} from "../src/orchestration/engine.js";

function makeZeroedRiskSignals(): RiskSignals {
  return {
    docsOrFormatOnly: false,
    securityOrDataIntegrity: false,
    schemaOrMigration: false,
    architectureChange: false,
    multiService: false,
    publicApiChange: false,
    multiFileIntegration: false,
    changedFiles: 0
  };
}

function makeZeroedEscalationSignals(): EscalationSignals {
  return {
    localPatchTooLarge: false,
    testsFailAfterLocalRepair: false,
    minimalDiffRewriteNeeded: false,
    subtleBugSuspected: false,
    architectureBoundaryUnclear: false,
    publicApiImpactPossible: false,
    dependencyGraphChange: false,
    schemaOrMigrationImpact: false,
    securityOrDataRisk: false,
    checkpointDecisionRequired: false,
    l4CriticalChange: false,
    rollbackRiskHigh: false,
    ambiguousRequirement: false,
    irreversibleMigration: false
  };
}

describe("classifyRisk", () => {
  it("should classify L0 when docsOrFormatOnly is true", () => {
    const signals = makeZeroedRiskSignals();
    signals.docsOrFormatOnly = true;
    expect(classifyRisk(signals)).toBe("L0");
  });

  it("should classify L1 with single changed file", () => {
    const signals = makeZeroedRiskSignals();
    signals.changedFiles = 1;
    expect(classifyRisk(signals)).toBe("L1");
  });

  it("should classify L2 with 3 changed files", () => {
    const signals = makeZeroedRiskSignals();
    signals.changedFiles = 3;
    expect(classifyRisk(signals)).toBe("L2");
  });

  it("should classify L3 with publicApiChange", () => {
    const signals = makeZeroedRiskSignals();
    signals.publicApiChange = true;
    expect(classifyRisk(signals)).toBe("L3");
  });

  it("should classify L3 with changedFiles > 8", () => {
    const signals = makeZeroedRiskSignals();
    signals.changedFiles = 9;
    expect(classifyRisk(signals)).toBe("L3");
  });

  it("should classify L4 with securityOrDataIntegrity", () => {
    const signals = makeZeroedRiskSignals();
    signals.securityOrDataIntegrity = true;
    expect(classifyRisk(signals)).toBe("L4");
  });

  it("should classify L4 with schemaOrMigration", () => {
    const signals = makeZeroedRiskSignals();
    signals.schemaOrMigration = true;
    expect(classifyRisk(signals)).toBe("L4");
  });
});

describe("checkpointsForRisk", () => {
  it("should return correct checkpoints for L0", () => {
    expect(checkpointsForRisk("L0")).toEqual([]);
  });

  it("should return correct checkpoints for L1", () => {
    expect(checkpointsForRisk("L1")).toEqual(["final"]);
  });

  it("should return correct checkpoints for L2", () => {
    expect(checkpointsForRisk("L2")).toEqual(["plan", "final"]);
  });

  it("should return correct checkpoints for L3", () => {
    expect(checkpointsForRisk("L3")).toEqual(["plan", "vertical_slice", "midpoint", "final"]);
  });

  it("should return correct checkpoints for L4", () => {
    expect(checkpointsForRisk("L4")).toEqual(["plan", "vertical_slice", "midpoint", "test_hardening", "final", "human_approval"]);
  });
});

describe("frontierPacketBudgetTokens", () => {
  it("should return correct tokens for L0", () => {
    expect(frontierPacketBudgetTokens("L0")).toBe(10000);
  });

  it("should return correct tokens for L1", () => {
    expect(frontierPacketBudgetTokens("L1")).toBe(10000);
  });

  it("should return correct tokens for L2", () => {
    expect(frontierPacketBudgetTokens("L2")).toBe(20000);
  });

  it("should return correct tokens for L3", () => {
    expect(frontierPacketBudgetTokens("L3")).toBe(40000);
  });

  it("should return correct tokens for L4", () => {
    expect(frontierPacketBudgetTokens("L4")).toBe(80000);
  });
});

describe("escalationTarget", () => {
  it("should return human when l4CriticalChange is true even with other flags", () => {
    const signals = makeZeroedEscalationSignals();
    signals.l4CriticalChange = true;
    signals.architectureBoundaryUnclear = true;
    signals.localPatchTooLarge = true;
    expect(escalationTarget(signals)).toBe("human");
  });

  it("should return tier5 when architectureBoundaryUnclear is true", () => {
    const signals = makeZeroedEscalationSignals();
    signals.architectureBoundaryUnclear = true;
    expect(escalationTarget(signals)).toBe("tier5");
  });

  it("should return tier4b when localPatchTooLarge is true", () => {
    const signals = makeZeroedEscalationSignals();
    signals.localPatchTooLarge = true;
    expect(escalationTarget(signals)).toBe("tier4b");
  });

  it("should return none when all flags are false", () => {
    const signals = makeZeroedEscalationSignals();
    expect(escalationTarget(signals)).toBe("none");
  });
});

describe("tierPathForRisk", () => {
  it("should return correct path for L2", () => {
    expect(tierPathForRisk("L2")).toEqual([
      "Tier_0",
      "Tier_5_Plan",
      "Tier_2",
      "Tier_3",
      "Tier_4b",
      "Tier_5_Final"
    ]);
  });
});

describe("isValidCheckpointDecision", () => {
  it("should return true for valid decision", () => {
    expect(isValidCheckpointDecision("continue")).toBe(true);
  });

  it("should return false for invalid decision", () => {
    expect(isValidCheckpointDecision("nope")).toBe(false);
  });
});
