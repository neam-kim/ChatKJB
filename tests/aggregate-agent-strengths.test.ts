import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  aggregate,
  buildMarkdown,
  classifyOutcome,
  classifyTaskType,
  collectTranscripts,
  deriveHints,
  providersMentioned,
} from "../scripts/aggregate-agent-strengths.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function transcriptFrontmatter(fields: Record<string, string>): string {
  const lines = ["---", "type: source"];
  for (const [key, value] of Object.entries(fields)) lines.push(`${key}: ${value}`);
  lines.push("---", "", "# 본문", "");
  return lines.join("\n");
}

describe("작업유형 분류", () => {
  it("코딩·멀티모달·조사·기타를 키워드로 가른다", () => {
    expect(classifyTaskType("버그 수정 및 리팩터링")).toBe("coding");
    expect(classifyTaskType("앱 아이콘 이미지 교체")).toBe("multimodal");
    expect(classifyTaskType("타당성 검토 및 비교 분석")).toBe("research");
    expect(classifyTaskType("README 문서 작성")).toBe("writing");
    expect(classifyTaskType("점심 메뉴 추천")).toBe("other");
  });
});

describe("성공/보류/실패 신호 휴리스틱", () => {
  it("부정·보류 표현이 성공 키워드보다 우선한다", () => {
    expect(classifyOutcome("전체 테스트 통과를 확인하였습니다.")).toBe("success");
    expect(classifyOutcome("구현은 아직 승인되지 않은 상태입니다.")).toBe("hold");
    expect(classifyOutcome("실행이 실패하였습니다.")).toBe("failure");
    expect(classifyOutcome("그냥 한 줄 메모.")).toBe("unknown");
  });
});

describe("제공자 언급 추출", () => {
  it("한·영 별칭과 다중 언급을 모은다", () => {
    expect(providersMentioned("Claude·Codex 세 제공자")).toEqual(["claude", "codex"]);
    expect(providersMentioned("agy(Gemini)가 한도 소진")).toEqual(["agy"]);
    expect(providersMentioned("일반 텍스트")).toEqual([]);
  });
});

describe("트랜스크립트 수집", () => {
  it("provider가 박힌 source만 모으고 결과 로그·잡파일은 제외한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "strengths-inbox-"));
    temporaryDirectories.push(dir);

    writeFileSync(
      join(dir, "a.md"),
      transcriptFrontmatter({
        provider: "claude",
        model: '"claude-opus-4-8"',
        topic: '"ChatKJB"',
        title: '"버그 수정"',
        turns: "12",
        session_date: "2026-06-22",
      })
    );
    // provider 없는 병합 결과 로그류는 제외되어야 한다.
    writeFileSync(
      join(dir, "results.md"),
      ["---", "type: source", 'topic: "project results"', "---", "", "본문"].join("\n")
    );
    // 알 수 없는 provider도 제외.
    writeFileSync(
      join(dir, "b.md"),
      transcriptFrontmatter({ provider: "unknown-llm", title: '"x"' })
    );

    const records = collectTranscripts([dir]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: "claude",
      taskType: "coding",
      turns: 12,
      topic: "ChatKJB",
    });
  });
});

describe("집계와 마크다운", () => {
  it("트랜스크립트와 결과 항목을 provider별로 합산한다", () => {
    const transcripts = [
      { provider: "claude", model: "opus", topic: "ChatKJB", turns: 10, taskType: "coding", date: "2026-06-22" },
      { provider: "claude", model: "opus", topic: "Wiki", turns: 20, taskType: "writing", date: "2026-06-22" },
      { provider: "agy", model: "gemini", topic: "Wiki", turns: 4, taskType: "multimodal", date: "2026-06-22" },
    ] as const;
    const resultEntries = [
      "어르신께서 Claude로 구현을 요청하셨고 전체 테스트 통과를 확인하였습니다.",
      "agy(Gemini) 활용 방안을 제안하였으며 구현은 하지 않았습니다.",
    ];

    const byProvider = aggregate(transcripts, resultEntries);

    expect(byProvider.claude.sessions).toBe(2);
    expect(byProvider.claude.totalTurns).toBe(30);
    expect(byProvider.claude.outcomes.success).toBe(1);
    expect(byProvider.agy.sessions).toBe(1);
    expect(byProvider.agy.outcomes.hold).toBe(1);
    expect(byProvider.codex.sessions).toBe(0);

    const markdown = buildMarkdown(byProvider, {
      generatedAt: new Date("2026-06-22T00:00:00Z"),
      transcriptCount: transcripts.length,
      resultEntryCount: resultEntries.length,
    });
    expect(markdown).toContain("type: meta");
    expect(markdown).toContain("Agent strengths dictionary");
    expect(markdown).toContain("| claude | 2 |");
    // 한계 고지가 반드시 들어가야 한다(과대 해석 방지).
    expect(markdown).toContain("한계:");
  });

  it("작업유형별 최다 담당 제공자를 라우팅 힌트로 도출한다", () => {
    const byProvider = aggregate(
      [
        { provider: "codex", model: "", topic: "", turns: 1, taskType: "coding", date: "" },
        { provider: "codex", model: "", topic: "", turns: 1, taskType: "coding", date: "" },
        { provider: "claude", model: "", topic: "", turns: 1, taskType: "coding", date: "" },
        { provider: "agy", model: "", topic: "", turns: 1, taskType: "multimodal", date: "" },
      ] as const,
      []
    );
    const hints = deriveHints(byProvider);
    expect(hints.join("\n")).toContain("`coding` → 관측상 codex");
    expect(hints.join("\n")).toContain("`multimodal` → 관측상 agy");
  });
});
