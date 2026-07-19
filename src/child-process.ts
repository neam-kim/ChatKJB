import type { ChildProcess } from "node:child_process";

export type ChildTreeTarget = Pick<ChildProcess, "exitCode" | "kill" | "pid">;

export function signalChildTree(
  child: ChildTreeTarget,
  signal: NodeJS.Signals
): void {
  if (child.exitCode !== null) return;
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
    }
  }
  child.kill(signal);
}

/** SIGTERM 뒤에도 남은 detached 프로세스 트리를 짧은 유예 후 SIGKILL로 정리한다. */
export function terminateChildTree(
  child: ChildTreeTarget,
  graceMs = 1_500
): NodeJS.Timeout | undefined {
  if (child.exitCode !== null) return undefined;
  signalChildTree(child, "SIGTERM");
  const timer = setTimeout(() => signalChildTree(child, "SIGKILL"), graceMs);
  timer.unref();
  return timer;
}
