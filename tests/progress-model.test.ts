import { describe, expect, it } from "vitest";
import {
  LEDGER_SOFT_LIMIT,
  TaskLedger,
  emptyRemainingPlan,
  remainingPlanFromCounts,
  truncateSummary,
  waitReasonFromSessionStatus
} from "../src/session/progress-model.js";
import {
  degradedPlanForProvider,
  normalizeClaudeTool,
  normalizeCodexItem,
  steerCapabilityNote
} from "../src/session/provider-progress.js";
import type { ThreadItem } from "@openai/codex-sdk";

describe("TaskLedger", () => {
  it("appends and truncates long summaries", () => {
    const ledger = new TaskLedger();
    ledger.append("tool", "x".repeat(400));
    expect(ledger.size).toBe(1);
    expect(ledger.displayEntries()[0]!.summary.length).toBeLessThanOrEqual(180);
  });

  it("compacts when soft limit is exceeded", () => {
    const ledger = new TaskLedger();
    for (let i = 0; i < LEDGER_SOFT_LIMIT + 10; i += 1) {
      ledger.append("note", `entry-${i}`);
    }
    expect(ledger.size).toBeLessThanOrEqual(LEDGER_SOFT_LIMIT);
    expect(ledger.toJSON().some((entry) => /축약/.test(entry.summary))).toBe(true);
  });

  it("formats display lines with kind prefixes", () => {
    const ledger = new TaskLedger();
    ledger.append("decision", "조향: 테스트");
    ledger.append("tool", "Read: a.ts");
    const lines = ledger.formatLines();
    expect(lines.some((line) => line.includes("결정"))).toBe(true);
    expect(lines.some((line) => line.includes("도구"))).toBe(true);
  });
});

describe("waitReasonFromSessionStatus", () => {
  it("maps approval/limit/queue and subagent override", () => {
    expect(waitReasonFromSessionStatus("waiting_approval").kind).toBe("approval");
    expect(waitReasonFromSessionStatus("waiting_limit").label).toContain("한도");
    expect(waitReasonFromSessionStatus("queued").kind).toBe("queue");
    expect(waitReasonFromSessionStatus("running", { openSubagents: 2 }).kind).toBe("subagent");
    expect(waitReasonFromSessionStatus("running", { toolWaiting: true }).kind).toBe("tool");
    expect(waitReasonFromSessionStatus("running").kind).toBe("none");
  });
});

describe("remaining plan", () => {
  it("computes percent and degrades when empty", () => {
    const plan = remainingPlanFromCounts(2, 5, ["a", "b", "c"]);
    expect(plan.percent).toBe(40);
    expect(plan.degraded).toBe(false);
    expect(plan.label).toContain("ETA 미제공");
    expect(emptyRemainingPlan().degraded).toBe(true);
  });
});

describe("provider normalizers", () => {
  it("normalizes Claude tools", () => {
    const event = normalizeClaudeTool("Read", { file_path: "/tmp/a.ts" });
    expect(event.kind).toBe("tool");
    expect(event.summary).toContain("Read");
  });

  it("normalizes Codex todo list into remaining plan", () => {
    const item = {
      type: "todo_list",
      items: [
        { text: "one", completed: true },
        { text: "two", completed: false },
        { text: "three", completed: false }
      ]
    } as ThreadItem;
    const event = normalizeCodexItem(item);
    expect(event?.kind).toBe("plan");
    expect(event?.remainingPlan?.completed).toBe(1);
    expect(event?.remainingPlan?.total).toBe(3);
    expect(event?.remainingPlan?.items).toContain("two");
  });

  it("provides explicit degrade labels per provider", () => {
    expect(degradedPlanForProvider("grok").label).toContain("Grok");
    expect(degradedPlanForProvider("cline").label).toContain("Cline");
    expect(steerCapabilityNote("claude")).toContain("라이브");
    expect(steerCapabilityNote("codex")).toContain("재시작");
    expect(steerCapabilityNote("agy")).toContain("제한");
  });

  it("truncateSummary is stable", () => {
    expect(truncateSummary("short")).toBe("short");
    expect(truncateSummary("a".repeat(200)).endsWith("…")).toBe(true);
  });
});
