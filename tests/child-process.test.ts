import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateChildTree, type ChildTreeTarget } from "../src/child-process.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("terminateChildTree", () => {
  it("escalates from SIGTERM to SIGKILL when the child has not exited", () => {
    vi.useFakeTimers();
    const kill = vi.fn(() => true);
    const child = { exitCode: null, pid: undefined, kill } as ChildTreeTarget;

    terminateChildTree(child, 100);
    expect(kill).toHaveBeenCalledWith("SIGTERM");

    vi.advanceTimersByTime(100);
    expect(kill).toHaveBeenLastCalledWith("SIGKILL");
  });
});
