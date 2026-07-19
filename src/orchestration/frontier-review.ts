import type { CheckpointDecision, ReviewPacket, RiskLevel } from "./types.js";

export interface FrontierDecision {
  decision: CheckpointDecision;
  approved: boolean;
  requiredChanges: string[];
  riskLevel: RiskLevel;
  architecturalNotes: string;
}

export const FRONTIER_REVIEW_SYSTEM: string = `You are a Tier 5 architect/judge reviewing code changes. You receive a compressed review packet, not raw context. Do NOT implement any changes. Answer with ONE JSON object only:
{"decision": "continue|redirect|rollback|escalate_to_human", "approved": true|false, "requiredChanges": [...], "riskLevel": "L0|L1|L2|L3|L4", "architecturalNotes": ".."}`;

export function buildFrontierReviewPrompt(packet: ReviewPacket): string {
  const {
    originalGoal,
    currentTaskContract,
    riskLevel,
    allowedFiles,
    forbiddenChanges,
    architectureNotes,
    changedFileInventory,
    diffSummary,
    testResultSummary,
    typecheckSummary,
    lintSummary,
    coverageSummary,
    unresolvedBlockers,
    reviewQuestions,
    rawEvidencePointers
  } = packet;

  const renderArray = (arr: string[], noneMessage: string = "(none)") => {
    return arr.length ? arr.map(item => `- ${item}`).join("\n") : `- ${noneMessage}`;
  };

  return `# Review Packet

## Original Goal
${originalGoal}

## Current Task Contract
### Goal
${currentTaskContract.goal}

## Risk Level
${riskLevel}

## Allowed Files
${renderArray(allowedFiles)}

## Forbidden Changes
${renderArray(forbiddenChanges)}

## Architecture Notes
${architectureNotes}

## Changed File Inventory
${renderArray(changedFileInventory)}

## Diff Summary
${diffSummary}

## Test Result Summary
${testResultSummary}

## Typecheck Summary
${typecheckSummary}

## Lint Summary
${lintSummary}

## Coverage Summary
${coverageSummary}

## Unresolved Blockers
${renderArray(unresolvedBlockers)}

## Review Questions
${renderArray(reviewQuestions)}

## Raw Evidence Pointers
${renderArray(rawEvidencePointers)}

---

### Review Questions

1. Is the change contractually compliant?
2. Does the architecture align with existing patterns?
3. Are tests sufficient and passing?
4. Is the diff quality acceptable?

Answer with ONE JSON object only, matching the schema in the system prompt.`;
}

export function parseFrontierDecision(content: string): FrontierDecision | null {
  // Find first JSON object
  const jsonMatch = content.match(/\{[^{}]*\}/);
  if (!jsonMatch) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  const { decision, approved, requiredChanges, riskLevel, architecturalNotes } = parsed;

  // Validate decision
  const validDecisions: CheckpointDecision[] = ["continue", "redirect", "rollback", "escalate_to_human"];
  if (!validDecisions.includes(decision)) return null;

  // Validate risk level
  const validRiskLevels: RiskLevel[] = ["L0", "L1", "L2", "L3", "L4"];
  if (!validRiskLevels.includes(riskLevel)) return null;

  // Default values
  const finalApproved = approved !== undefined ? approved : (decision === "continue");
  const finalRequiredChanges = Array.isArray(requiredChanges) ? requiredChanges.filter(item => typeof item === 'string') : [];
  const finalArchitecturalNotes = architecturalNotes || "";

  return {
    decision,
    approved: finalApproved,
    requiredChanges: finalRequiredChanges,
    riskLevel,
    architecturalNotes: finalArchitecturalNotes
  };
}
