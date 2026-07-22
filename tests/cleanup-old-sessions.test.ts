import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isSessionEligibleForCleanup,
  parseTelegramResponse,
} from "../scripts/cleanup-old-sessions.mjs";
import {
  isConformingResultLog,
  parseResultLogBlocks,
  pruneExpiredResultBlocks,
} from "../scripts/result-logs.mjs";

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

describe("결과 로그 7일 보존", () => {
  const oldBlock = [
    "## 2026-07-01T10:00:00+09:00",
    "- Request: 오래된 요청",
    "- Decision: 보관",
    "- Result: 오래된 결과",
  ].join("\n");
  const recentBlock = [
    "## 2026-07-21T10:00:00+09:00",
    "- Request: 최근 요청",
    "- Decision: 보관",
    "- Result: 최근 결과",
  ].join("\n");

  it("유효한 KST 블록만 7일 경과 시 작업 단위로 제거한다", () => {
    const cutoff = Date.parse("2026-07-15T12:00:00+09:00");
    const result = pruneExpiredResultBlocks(`${oldBlock}\n\n${recentBlock}\n`, cutoff);

    expect(result.removed).toBe(1);
    expect(result.text).not.toContain("오래된 요청");
    expect(result.text).toContain("최근 요청");
    expect(isConformingResultLog(result.text)).toBe(true);
  });

  it("새 규약 밖의 내용은 자동 보존 대상으로 표시한다", () => {
    const parsed = parseResultLogBlocks(`${oldBlock}\n\n이전 자유 형식 메모\n`);

    expect(parsed.blocks).toHaveLength(0);
    expect(parsed.nonconforming).toBe(true);
    expect(isConformingResultLog(`${oldBlock}\n\n이전 자유 형식 메모\n`)).toBe(false);
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

  async function enumerateWith(claudeDir: string, grokDir: string, clineDir?: string) {
    vi.resetModules();
    process.env.CLAUDE_PROJECTS_DIR = claudeDir;
    process.env.GROK_SESSIONS_DIR = grokDir;
    process.env.CLINE_SESSIONS_DIR = clineDir ?? join(claudeDir, "no-cline-here");
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

  it("cline 세션 디렉터리를 id 형식과 무관하게 모으고 db·logs는 남긴다", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleanup-cline-"));
    temporaryDirectories.push(root);
    // SDK가 만드는 <epoch>_<suffix>와 uuid 두 형식이 섞여 있다.
    const legacyId = "1784560110695_4f1go";
    const uuidId = "8b8bedae-aedd-43c2-ab7f-88b9fe10ddef";
    for (const id of [legacyId, uuidId]) {
      const sessionDir = join(root, id);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, `${id}.json`), "{}");
      writeFileSync(join(sessionDir, `${id}.messages.json`), "[]");
    }
    // 형제 디렉터리(db·logs·settings)는 세션이 아니므로 자기 이름 .json이 없다.
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(join(root, "logs", "cline.log"), "x");

    const found = await enumerateWith(
      join(root, "absent-claude"),
      join(root, "absent-grok"),
      root
    );
    expect(found).toHaveLength(2);
    expect(found.every((entry: { provider: string; directory?: boolean; }) =>
      entry.provider === "cline" && entry.directory === true)).toBe(true);
    expect(found.map((entry: { id: string; }) => entry.id).sort()).toEqual(
      [legacyId, uuidId].sort()
    );
    expect(found.every((entry: { mtimeMs: number; }) => entry.mtimeMs > 0)).toBe(true);
  });
});

describe("cline 레지스트리 정리", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
    delete process.env.CLEANUP_DRY_RUN;
    vi.resetModules();
  });

  const cutoff = Date.UTC(2026, 6, 14, 5, 0);
  const stale = new Date(cutoff - 60_000).toISOString();
  const fresh = new Date(cutoff + 60_000).toISOString();

  function seedRegistry() {
    const root = mkdtempSync(join(tmpdir(), "cleanup-cline-db-"));
    temporaryDirectories.push(root);
    const sessionsDir = join(root, "sessions");
    mkdirSync(join(root, "db"), { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    // 살아있는 세션(디렉터리 존재 + 최근 updated_at)은 보존되어야 한다.
    mkdirSync(join(sessionsDir, "keep-live"), { recursive: true });
    const databasePath = join(root, "db", "sessions.db");
    const db = new DatabaseSync(databasePath);
    db.exec(
      "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL);" +
        "CREATE TABLE subagent_spawn_queue (id INTEGER PRIMARY KEY AUTOINCREMENT," +
        " root_session_id TEXT NOT NULL);"
    );
    const insert = db.prepare("INSERT INTO sessions VALUES (?, ?)");
    insert.run("deleted-now", stale); // 이번 실행에서 디렉터리를 지운 세션
    insert.run("orphan-old", stale); // 디렉터리가 이미 사라진 고아 행
    insert.run("orphan-recent", fresh); // 디렉터리는 없지만 아직 최근 — 보존
    insert.run("keep-live", fresh);
    db.prepare("INSERT INTO subagent_spawn_queue (root_session_id) VALUES (?)").run(
      "deleted-now"
    );
    db.close();
    return { root, sessionsDir, databasePath };
  }

  async function loadWith(sessionsDir: string) {
    vi.resetModules();
    process.env.CLINE_SESSIONS_DIR = sessionsDir;
    delete process.env.CLINE_STATE_DB; // 세션 디렉터리에서 유도되는지 함께 확인한다.
    return import("../scripts/cleanup-old-sessions.mjs");
  }

  it("지운 세션 행과 오래된 고아 행만 제거한다", async () => {
    const { sessionsDir, databasePath } = seedRegistry();
    const module = await loadWith(sessionsDir);

    const result = module.pruneClineRegistry(["deleted-now"], cutoff);
    expect(result).toMatchObject({ rowsDeleted: 2, queueRowsDeleted: 1 });

    const db = new DatabaseSync(databasePath);
    const remaining = db
      .prepare("SELECT session_id FROM sessions ORDER BY session_id")
      .all()
      .map((row) => row.session_id);
    const queue = db.prepare("SELECT count(*) AS n FROM subagent_spawn_queue").get();
    db.close();
    expect(remaining).toEqual(["keep-live", "orphan-recent"]);
    expect(queue?.n).toBe(0);
  });

  it("DRY RUN에서는 세어만 보고 실제로 지우지 않는다", async () => {
    const { sessionsDir, databasePath } = seedRegistry();
    process.env.CLEANUP_DRY_RUN = "1";
    const module = await loadWith(sessionsDir);

    expect(module.pruneClineRegistry(["deleted-now"], cutoff).rowsDeleted).toBe(2);

    const db = new DatabaseSync(databasePath);
    const count = db.prepare("SELECT count(*) AS n FROM sessions").get();
    db.close();
    expect(count?.n).toBe(4);
  });

  it("레지스트리 DB가 없으면 조용히 넘어간다", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleanup-cline-nodb-"));
    temporaryDirectories.push(root);
    const module = await loadWith(join(root, "sessions"));
    expect(module.pruneClineRegistry(["whatever"], cutoff)).toMatchObject({
      rowsDeleted: 0,
      queueRowsDeleted: 0,
    });
  });
});
