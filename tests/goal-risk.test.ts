import { describe, it, expect } from "vitest";
import { estimateGoalRisk } from "../src/goal-checks.js";

describe("estimateGoalRisk", () => {
  it("returns L0 for '오타 수정' with no check lines", () => {
    expect(estimateGoalRisk("오타 수정")).toBe("L0");
  });

  it("returns L4 for '보안 취약점 패치'", () => {
    expect(estimateGoalRisk("보안 취약점 패치")).toBe("L4");
  });

  it("returns L4 for 'DB schema 마이그레이션'", () => {
    expect(estimateGoalRisk("DB schema 마이그레이션")).toBe("L4");
  });

  it("returns L1 for a plain '함수 하나 고쳐줘' with no keywords and no checks", () => {
    expect(estimateGoalRisk("함수 하나 고쳐줘")).toBe("L1");
  });

  it("returns L2 for two distinct check: lines and no risk keywords", () => {
    expect(estimateGoalRisk(`check: pnpm build\ncheck: pnpm lint`)).toBe("L2");
  });

  it("returns L3 for 'public api 변경'", () => {
    expect(estimateGoalRisk("public api 변경")).toBe("L3");
  });

  it("returns L3 for nine distinct check lines, no keywords", () => {
    // parseGoalChecks dedupes identical commands, so each check must be distinct.
    const condition = Array.from({ length: 9 }, (_, i) => `check: step${i}`).join("\n");
    expect(estimateGoalRisk(condition)).toBe("L3");
  });
});
