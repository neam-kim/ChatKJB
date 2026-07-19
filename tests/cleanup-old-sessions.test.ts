import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isSessionEligibleForCleanup,
  parseTelegramResponse,
} from "../scripts/cleanup-old-sessions.mjs";

describe("old session cleanup eligibility", () => {
  const cutoff = Date.UTC(2026, 6, 6, 5, 28);

  it("cleans an old terminal session without requiring a transcript dump", () => {
    expect(
      isSessionEligibleForCleanup(
        { updated_at: cutoff - 1, status: "done" },
        cutoff
      )
    ).toBe(true);
  });

  it("preserves recent and active sessions", () => {
    expect(
      isSessionEligibleForCleanup({ updated_at: cutoff + 1, status: "done" }, cutoff)
    ).toBe(false);
    expect(
      isSessionEligibleForCleanup({ updated_at: cutoff - 1, status: "running" }, cutoff)
    ).toBe(false);
  });

  it("requires Telegram API confirmation before treating a topic deletion as successful", () => {
    expect(parseTelegramResponse('{"ok":true,"result":true}').ok).toBe(true);
    expect(parseTelegramResponse('{"ok":false,"description":"Bad Request"}').ok).toBe(false);
    expect(parseTelegramResponse("not-json").ok).toBe(false);
  });
});

describe("데스크톱 세션 열거 커버리지", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  async function enumerateWith(claudeDir: string, grokDir: string) {
    vi.resetModules();
    process.env.CLAUDE_PROJECTS_DIR = claudeDir;
    process.env.GROK_SESSIONS_DIR = grokDir;
    process.env.CODEX_SESSIONS_DIR = join(claudeDir, "no-codex-here");
    process.env.CODEX_ACCOUNT_HOMES = "";
    // 모듈 최상위 상수가 import 시점 환경변수를 읽으므로 매번 새로 평가해야 한다.
    const module = await import("../scripts/cleanup-old-sessions.mjs");
    return module.enumerateDesktopFiles(new Set<string>(), new Set<string>());
  }

  it("claude 서브에이전트를 재귀로 찾되 memory 저장소는 건드리지 않는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleanup-claude-"));
    temporaryDirectories.push(root);
    const project = join(root, "-Volumes-project");
    // 서브에이전트 전사는 <프로젝트>/<세션 uuid>/subagents/ 아래에 있어 예전의
    // 한 겹 스윕으로는 영원히 남았다.
    mkdirSync(join(project, "3ad1ef55-a848-4a41-bfc7-994f5c48c329", "subagents"), {
      recursive: true,
    });
    mkdirSync(join(project, "memory"), { recursive: true });
    writeFileSync(join(project, "9f1e2d3c-0000-4000-8000-000000000001.jsonl"), "{}");
    writeFileSync(
      join(project, "3ad1ef55-a848-4a41-bfc7-994f5c48c329", "subagents", "agent-abc.jsonl"),
      "{}"
    );
    // memory/는 세션 기록이 아니라 영속 메모리라 절대 삭제 대상이 되면 안 된다.
    writeFileSync(join(project, "memory", "note.jsonl"), "{}");

    const found = await enumerateWith(root, join(root, "absent-grok"));
    const files = found.map((entry: { file: string; }) => entry.file);
    expect(files.some((file: string) => file.endsWith("agent-abc.jsonl"))).toBe(true);
    expect(files.some((file: string) => file.includes("9f1e2d3c"))).toBe(true);
    expect(files.some((file: string) => file.includes(`${sep}memory${sep}`))).toBe(false);
  });

  it("grok 세션 디렉터리를 모으고 색인·prompt_history는 남긴다", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleanup-grok-"));
    temporaryDirectories.push(root);
    const cwdDir = join(root, "%2FUsers%2Fneam%2FChatKJB");
    const sessionDir = join(cwdDir, "019f54b7-39a6-7801-9084-4a5e709e15d9");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "chat_history.jsonl"), "{}");
    // 덤프 봇이 읽는 색인과 cwd별 prompt_history는 세션이 아니다.
    writeFileSync(join(root, "session_search.sqlite"), "x");
    writeFileSync(join(cwdDir, "prompt_history.jsonl"), "{}");

    const found = await enumerateWith(join(root, "absent-claude"), root);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      provider: "grok",
      file: sessionDir,
      directory: true,
    });
    expect(found[0]?.mtimeMs).toBeGreaterThan(0);
  });
});
