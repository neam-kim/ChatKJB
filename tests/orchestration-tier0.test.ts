import { describe, expect, it } from "vitest";
import { parseRipgrep, parseTypecheck, parseVitest } from "../src/orchestration/tier0.js";

describe("parseRipgrep", () => {
  it("parses valid lines correctly", () => {
    const input = `src/a.ts:42:const x = 1
src/b.ts:7:foo()
`;
    const result = parseRipgrep(input);
    expect(result).toEqual([
      { kind: "ripgrep", pointer: "src/a.ts:42", summary: "const x = 1" },
      { kind: "ripgrep", pointer: "src/b.ts:7", summary: "foo()" }
    ]);
  });

  it("ignores blank and invalid lines", () => {
    const input = `
src/a.ts:42:const x = 1

invalid-line
src/b.ts:7:foo()
`;
    const result = parseRipgrep(input);
    expect(result).toEqual([
      { kind: "ripgrep", pointer: "src/a.ts:42", summary: "const x = 1" },
      { kind: "ripgrep", pointer: "src/b.ts:7", summary: "foo()" }
    ]);
  });
});

describe("parseTypecheck", () => {
  it("parses error lines correctly", () => {
    const input = `src/a.ts(12,5): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.
`;
    const result = parseTypecheck(input);
    expect(result).toEqual({
      passed: false,
      evidence: [
        {
          kind: "typecheck",
          pointer: "src/a.ts(12,5)",
          summary: "Argument of type 'number' is not assignable to parameter of type 'string'."
        }
      ]
    });
  });

  it("returns passed true for clean output", () => {
    const result = parseTypecheck("");
    expect(result).toEqual({ passed: true, evidence: [] });
  });
});

describe("parseVitest", () => {
  it("detects passed tests correctly", () => {
    const input = `Tests  19 passed (19)
`;
    const result = parseVitest(input);
    expect(result).toEqual({ passed: true, evidence: [] });
  });

  it("detects failed tests and captures evidence", () => {
    const input = `
 1 failed
FAIL  tests/x.test.ts > name
`;
    const result = parseVitest(input);
    expect(result).toEqual({
      passed: false,
      evidence: [
        {
          kind: "test",
          pointer: "tests/x.test.ts",
          summary: "FAIL  tests/x.test.ts > name"
        }
      ]
    });
  });
});
