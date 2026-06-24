import { describe, expect, it } from "vitest";
import { runGoalChecks } from "../src/goal-checks.js";

describe("runGoalChecks", () => {
  it("empty checks -> { allPassed: true, results: [] }", async () => {
    const result = await runGoalChecks([], process.cwd());
    expect(result.allPassed).toBe(true);
    expect(result.results).toEqual([]);
  });

  it("a passing command: [\"true\"] -> allPassed true, results length 1, results[0].passed true, command \"true\"", async () => {
    const result = await runGoalChecks(["true"], process.cwd());
    expect(result.allPassed).toBe(true);
    expect(result.results.length).toBe(1);
    const r = result.results[0];
    expect(r).toBeDefined();
    expect(r?.passed).toBe(true);
    expect(r?.command).toBe("true");
  });

  it("a failing command: [\"false\"] -> allPassed false, results[0].passed false", async () => {
    const result = await runGoalChecks(["false"], process.cwd());
    expect(result.allPassed).toBe(false);
    const r = result.results[0];
    expect(r).toBeDefined();
    expect(r?.passed).toBe(false);
  });

  it("captures output: [\"echo hello123\"] -> results[0].passed true and results[0].outputTail contains \"hello123\"", async () => {
    const result = await runGoalChecks(["echo hello123"], process.cwd());
    expect(result.allPassed).toBe(true);
    const r = result.results[0];
    expect(r).toBeDefined();
    expect(r?.passed).toBe(true);
    expect(r?.outputTail).toContain("hello123");
  });

  it("mixed: [\"true\", \"false\", \"echo done\"] -> allPassed false; results map passed === [true,false,true]; the \"echo done\" still ran (results length 3)", async () => {
    const result = await runGoalChecks(["true", "false", "echo done"], process.cwd());
    expect(result.allPassed).toBe(false);
    expect(result.results.length).toBe(3);
    expect(result.results.map(x => x.passed)).toEqual([true, false, true]);
  });

  it("failing command captures stderr/message: [\"ls /nonexistent_path_xyz_12345\"] -> results[0].passed false and outputTail is a non-empty string", async () => {
    const result = await runGoalChecks(["ls /nonexistent_path_xyz_12345"], process.cwd());
    const r = result.results[0];
    expect(r).toBeDefined();
    expect(r?.passed).toBe(false);
    expect(r?.outputTail).toBeDefined();
    expect(r?.outputTail.length).toBeGreaterThan(0);
  });
});

