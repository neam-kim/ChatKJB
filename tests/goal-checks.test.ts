import { describe, expect, it } from "vitest";
import { parseGoalChecks } from "../src/goal-checks.js";

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

