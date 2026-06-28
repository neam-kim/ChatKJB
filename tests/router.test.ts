import { describe, expect, it } from "vitest";

import {
  agentStrengthsPath,
  classifyTaskType,
  parseStrengthHints,
  routeProvider,
  wikiVaultPath,
} from "../src/router.js";

describe("작업유형 분류", () => {
  it("프롬프트 키워드로 작업유형을 가른다", () => {
    expect(classifyTaskType("이 버그를 수정하고 테스트를 추가해줘")).toBe("coding");
    expect(classifyTaskType("이 PDF를 요약해줘")).toBe("multimodal"); // pdf 우선
    expect(classifyTaskType("두 라이브러리를 비교 분석해줘")).toBe("research");
    expect(classifyTaskType("회의록을 번역해줘")).toBe("writing");
    expect(classifyTaskType("매일 도는 cron 작업을 만들어")).toBe("automation");
    expect(classifyTaskType("새 MCP 서버를 연동해줘")).toBe("integration");
    expect(classifyTaskType("점심 뭐 먹을까")).toBe("other");
  });
});

describe("강점 힌트 파싱", () => {
  it("라우팅 힌트 라인에서 작업유형→provider를 추출한다", () => {
    const md = [
      "## 라우팅 힌트 (자동 도출)",
      "",
      "- 작업유형 `coding` → 관측상 codex가 가장 많이 담당 (3건).",
      "- 작업유형 `multimodal` → 관측상 agy가 가장 많이 담당 (2건).",
      "- 잡음 라인",
    ].join("\n");
    expect(parseStrengthHints(md)).toEqual({ coding: "codex", multimodal: "agy" });
  });

  it("형식이 어긋나거나 빈 입력이면 빈 맵을 돌려준다", () => {
    expect(parseStrengthHints("")).toEqual({});
    expect(parseStrengthHints("무관한 텍스트")).toEqual({});
  });
});

describe("provider 라우팅", () => {
  it("코딩은 기본 규칙상 codex로 보낸다", () => {
    const d = routeProvider("이 함수를 리팩터링해줘");
    expect(d.taskType).toBe("coding");
    expect(d.provider).toBe("codex");
    expect(d.usedHint).toBe(false);
  });

  it("멀티모달은 agy로 보낸다", () => {
    expect(routeProvider("이 이미지를 분석해줘").provider).toBe("agy");
  });

  it("이력 힌트가 규칙과 다르면 힌트를 우선하고 표시한다", () => {
    const d = routeProvider("이 함수를 구현해줘", { coding: "claude" });
    expect(d.provider).toBe("claude");
    expect(d.usedHint).toBe(true);
  });

  it("권장 provider를 쓸 수 없으면 안전 순서로 폴백한다", () => {
    // 코딩 권장=codex이지만 codex 미가용 → claude 폴백.
    const d = routeProvider("버그 수정", {}, ["claude", "agy"]);
    expect(d.provider).toBe("claude");
    expect(d.reason).toContain("폴백");
  });

  it("힌트 provider가 미가용이면 규칙으로 되돌아간다", () => {
    const d = routeProvider("이 함수를 구현해줘", { coding: "agy" }, ["claude", "codex"]);
    expect(d.provider).toBe("codex"); // 규칙 기본
    expect(d.usedHint).toBe(false);
  });
});

describe("LLM-Wiki 경로", () => {
  it("WIKI_VAULT가 있으면 그 값을 쓴다", () => {
    expect(wikiVaultPath({ WIKI_VAULT: "/tmp/wiki" } as NodeJS.ProcessEnv)).toBe("/tmp/wiki");
  });

  it("WIKI_VAULT가 없으면 기본 경로로 폴백한다", () => {
    expect(wikiVaultPath({} as NodeJS.ProcessEnv)).toBe(
      "/Volumes/homes/mac_neam96/AI/LLM-Wiki"
    );
  });

  it("강점 사전 경로는 vault 아래 _meta/agent-strengths.md다", () => {
    expect(agentStrengthsPath({ WIKI_VAULT: "/tmp/wiki" } as NodeJS.ProcessEnv)).toBe(
      "/tmp/wiki/_meta/agent-strengths.md"
    );
  });

  it("STRENGTHS_OUT은 vault보다 우선한다", () => {
    expect(
      agentStrengthsPath({ WIKI_VAULT: "/tmp/wiki", STRENGTHS_OUT: "/tmp/out.md" } as NodeJS.ProcessEnv)
    ).toBe("/tmp/out.md");
  });
});
