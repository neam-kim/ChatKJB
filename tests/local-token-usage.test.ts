import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectLocalTokenUsage } from "../src/local-token-usage.js";
import type { SessionRecord } from "../src/types.js";

let home: string;

function write(path: string, lines: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
}

function session(fields: Partial<SessionRecord>): SessionRecord {
  return { agyUsage: null, grokUsage: null, ...fields } as SessionRecord;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ustoken-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("collectLocalTokenUsage", () => {
  it("sums Claude transcripts and drops entries duplicated across files", async () => {
    const usage = {
      input_tokens: 10,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 20,
      output_tokens: 7
    };
    const entry = { requestId: "req-1", message: { id: "msg-1", usage } };
    // 같은 응답이 두 트랜스크립트에 복제돼도 한 번만 세야 한다.
    write(join(home, ".claude/projects/a/one.jsonl"), [entry]);
    write(join(home, ".claude/projects/b/two.jsonl"), [
      entry,
      { requestId: "req-2", message: { id: "msg-2", usage } }
    ]);

    const report = await collectLocalTokenUsage([], home);
    const claude = report.providers.find((p) => p.provider === "Claude")!;
    expect(claude.units).toBe(2);
    expect(claude.inputTokens).toBe(20);
    expect(claude.cachedTokens).toBe(50);
    expect(claude.outputTokens).toBe(14);
    expect(claude.totalTokens).toBe(84);
  });

  it("takes only the last cumulative rollout entry, across every CODEX_HOME", async () => {
    // total_token_usage는 세션 누적치라 마지막 값만 취해야 한다. 전부 더하면 이중 계산된다.
    const rollout = (total: number) => [
      { payload: { info: { total_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 2 } } } },
      { payload: { info: { total_token_usage: { input_tokens: total - 10, cached_input_tokens: 40, output_tokens: 10, total_tokens: total } } } }
    ];
    write(join(home, ".codex/sessions/2026/rollout-a.jsonl"), rollout(100));
    write(join(home, ".codex-acct-b/sessions/2026/rollout-b.jsonl"), rollout(200));

    const report = await collectLocalTokenUsage([], home);
    const codex = report.providers.find((p) => p.provider === "Codex")!;
    expect(codex.units).toBe(2);
    expect(codex.totalTokens).toBe(300);
    // Codex의 input_tokens는 캐시를 포함하므로 캐시 제외 입력으로 정규화된다.
    expect(codex.cachedTokens).toBe(80);
    expect(codex.inputTokens).toBe(90 - 40 + (190 - 40));
  });

  it("reads grok and agy totals from bot sessions and adds every provider up", async () => {
    const report = await collectLocalTokenUsage([
      session({
        grokUsage: JSON.stringify({
          inputTokens: 100,
          cacheReadInputTokens: 50,
          outputTokens: 25,
          reasoningTokens: 5,
          totalTokens: 175
        })
      }),
      session({
        agyUsage: JSON.stringify({
          promptTokenCount: 60,
          cachedContentTokenCount: 10,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 5,
          totalTokenCount: 85
        })
      })
    ], home);

    const grok = report.providers.find((p) => p.provider === "Grok")!;
    expect(grok.totalTokens).toBe(175);
    const agy = report.providers.find((p) => p.provider === "agy")!;
    expect(agy.totalTokens).toBe(85);
    expect(agy.inputTokens).toBe(50);
    expect(report.totalTokens).toBe(260);
  });

  it("counts cline cache reads inside inputTokens rather than adding them on top", async () => {
    // @cline/core 규약: inputTokens는 캐시 read/write를 이미 포함한다.
    const report = await collectLocalTokenUsage([
      session({
        provider: "cline",
        clineUsage: JSON.stringify({
          aggregateUsage: {
            inputTokens: 100, outputTokens: 20,
            cacheReadTokens: 70, cacheWriteTokens: 10, totalCost: 0.5
          }
        })
      })
    ], home);

    const cline = report.providers.find((p) => p.provider === "Cline")!;
    expect(cline.units).toBe(1);
    expect(cline.cachedTokens).toBe(80);
    expect(cline.inputTokens).toBe(20);
    expect(cline.outputTokens).toBe(20);
    expect(cline.totalTokens).toBe(120);
  });

  it("returns zeroed providers rather than throwing when nothing is on disk", async () => {
    const report = await collectLocalTokenUsage([], home);
    expect(report.totalTokens).toBe(0);
    expect(report.providers.map((p) => p.provider))
      .toEqual(["Claude", "Codex", "agy", "Grok", "Cline"]);
  });
});
