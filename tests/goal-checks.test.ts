import { describe, expect, it } from "vitest";
import { parseGoalChecks, parseGoalVerdict } from "../src/goal-checks.js";

describe("parseGoalChecks", () => {
  it("empty string -> { description: '', checks: [] }", () => {
    expect(parseGoalChecks("")).toEqual({ description: "", checks: [] });
  });

  it("whitespace-only -> { description: '', checks: [] }", () => {
    expect(parseGoalChecks("   \n\t  ")).toEqual({ description: "", checks: [] });
  });

  it("plain goal with no checks -> description equals the trimmed goal, checks empty", () => {
    expect(parseGoalChecks("  Build the app  ")).toEqual({
      description: "Build the app",
      checks: [],
    });
  });

  it("goal + two check lines -> checks === ['npm test','tsc --noEmit'], description is the remaining goal text trimmed", () => {
    const input = `Complete the project
check: npm test
check: tsc --noEmit
Finalize documentation`;
    expect(parseGoalChecks(input)).toEqual({
      description: "Complete the project\nFinalize documentation",
      checks: ["npm test", "tsc --noEmit"],
    });
  });

  it("case-insensitive marker 'CHECK:  pnpm lint  ' -> checks === ['pnpm lint'] (trimmed)", () => {
    expect(parseGoalChecks("check:   pnpm lint  \nother line")).toEqual({
      description: "other line",
      checks: ["pnpm lint"],
    });
  });

  it("duplicate checks ('check: npm test' twice) -> deduped to one", () => {
    const input = `test
check: npm test
check: npm test
check: tsc`;
    expect(parseGoalChecks(input)).toEqual({
      description: "test",
      checks: ["npm test", "tsc"],
    });
  });

  it("mixed: description lines interleaved with check lines -> description preserves the non-check lines joined by newline (trimmed), checks holds the commands in order", () => {
    const input = `First line
check: npm run build
Second line
check: npm test
Third line`;
    expect(parseGoalChecks(input)).toEqual({
      description: "First line\nSecond line\nThird line",
      checks: ["npm run build", "npm test"],
    });
  });
});

describe("parseGoalVerdict", () => {
  it("'GOAL_MET: done' -> { met: true, reason: 'done' }", () => {
    expect(parseGoalVerdict("GOAL_MET: done")).toEqual({ met: true, reason: "done" });
  });

  it("multi-line text ending with 'GOAL_UNMET: missing X' -> { met: false, reason: 'missing X' }", () => {
    const text = "Some analysis here.\nMore details.\nGOAL_UNMET: missing X";
    expect(parseGoalVerdict(text)).toEqual({ met: false, reason: "missing X" });
  });

  it("text with neither GOAL_MET nor GOAL_UNMET marker -> { met: false, reason: trimmed text slice }", () => {
    const text = "No verdict here at all.";
    expect(parseGoalVerdict(text)).toEqual({ met: false, reason: "No verdict here at all." });
  });

  it("GOAL_MET without reason suffix -> reason defaults to '조건 충족'", () => {
    expect(parseGoalVerdict("GOAL_MET")).toEqual({ met: true, reason: "조건 충족" });
  });

  it("last GOAL_MET wins when there are multiple verdict lines", () => {
    const text = "GOAL_UNMET: not yet\nsome work\nGOAL_MET: all done";
    expect(parseGoalVerdict(text)).toEqual({ met: true, reason: "all done" });
  });
});

