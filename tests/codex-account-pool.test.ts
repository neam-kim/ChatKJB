import { describe, expect, it } from "vitest";
import { CodexAccountPool } from "../src/codex-account-pool.js";

const A = "/home/.codex-a";
const B = "/home/.codex-b";

describe("CodexAccountPool", () => {
  it("requires at least one home and de-duplicates", () => {
    expect(() => new CodexAccountPool([])).toThrow();
    expect(() => new CodexAccountPool(["  "])).toThrow();
    expect(new CodexAccountPool([A, A, B]).size).toBe(2);
  });

  it("prefers the first home initially", () => {
    const pool = new CodexAccountPool([A, B]);
    expect(pool.select()).toBe(A);
  });

  it("stays on the same home across calls while healthy (sticky)", () => {
    const pool = new CodexAccountPool([A, B]);
    expect(pool.select()).toBe(A);
    expect(pool.select()).toBe(A);
    expect(pool.select()).toBe(A);
  });

  it("fails over to next home when current is sealed, then sticks", () => {
    const now = 1_000_000;
    const pool = new CodexAccountPool([A, B]);
    expect(pool.select(now)).toBe(A);
    pool.markFailed(A, now, now + 5000);
    expect(pool.select(now)).toBe(B);
    expect(pool.select(now)).toBe(B);
  });

  it("does not return to A after A recovers (sticky stays on B)", () => {
    const now = 1_000_000;
    const pool = new CodexAccountPool([A, B]);
    pool.markFailed(A, now, now + 5000);
    expect(pool.select(now)).toBe(B);
    expect(pool.select(now + 6000)).toBe(B);
  });

  it("fails over back to A when B is also sealed and A recovered", () => {
    const now = 1_000_000;
    const pool = new CodexAccountPool([A, B]);
    pool.markFailed(A, now, now + 5000);
    expect(pool.select(now)).toBe(B);
    pool.markFailed(B, now + 6000, now + 20000);
    expect(pool.select(now + 6000)).toBe(A);
  });

  it("returns soonest-recovering home when all sealed", () => {
    const now = 1_000_000;
    const pool = new CodexAccountPool([A, B]);
    pool.markFailed(A, now, now + 8000);
    pool.markFailed(B, now, now + 3000);
    expect(pool.select(now)).toBe(B);
  });

  it("recoversAt is null while any home healthy, else soonest", () => {
    const now = 1_000_000;
    const pool = new CodexAccountPool([A, B]);
    pool.markFailed(A, now, now + 5000);
    expect(pool.recoversAt(now)).toBeNull();
    pool.markFailed(B, now, now + 3000);
    expect(pool.recoversAt(now)).toBe(now + 3000);
    expect(pool.recoversAt(now + 3001)).toBeNull();
  });

  it("markFailed without until uses default backoff and does not overwrite an exact later reset", () => {
    const now = 1_000_000;
    const pool = new CodexAccountPool([A, B], { defaultBackoffMs: 3_600_000 });
    pool.markFailed(A, now, now + 60000);
    pool.markFailed(A, now + 1000);
    expect(pool.isExhausted(A, now + 1000)).toBe(true);
    expect(pool.select(now)).toBe(B);
    expect(pool.isExhausted(A, now)).toBe(true);
  });
});

