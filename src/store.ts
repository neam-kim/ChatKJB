import type { PermissionMode, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_AGY_MODEL,
  DEFAULT_CLAUDE_EFFORT,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING,
  DEFAULT_GROK_MODEL,
  DEFAULT_GROK_REASONING,
  DEFAULT_THINKING_LEVEL,
  resolveAgyThinkingLevel
} from "./model-catalog.js";
import type {
  ApprovalRecord,
  ProjectConfig,
  ProviderKind,
  ReservedTaskRecord,
  ReservedTaskStartOptions,
  ReservedTaskStatus,
  SessionDefaults,
  SessionRecord,
  SessionStatus,
  UsageSnapshot
} from "./types.js";

function normalizeProvider(value: string | null | undefined): ProviderKind {
  return value === "codex" || value === "agy" || value === "grok" || value === "cline"
    ? value
    : "claude";
}

const SESSION_DEFAULT_SEED: SessionDefaults = {
  provider: "claude",
  claudeModel: DEFAULT_CLAUDE_MODEL,
  claudeTokenIndex: 0,
  codexModel: DEFAULT_CODEX_MODEL,
  agyModel: DEFAULT_AGY_MODEL,
  grokModel: DEFAULT_GROK_MODEL,
  grokReasoning: DEFAULT_GROK_REASONING,
  clineProviderId: "",
  clineModel: "",
  clineReasoning: "high",
  thinking: DEFAULT_THINKING_LEVEL,
  claudeEffort: DEFAULT_CLAUDE_EFFORT,
  codexReasoning: DEFAULT_CODEX_REASONING,
  codexHome: null,
  subagentModel: null,
  subagentReasoning: null,
  subagentEffort: null,
  agyThinkingLevel: ""
};

function normalizeDefaultAgyThinkingLevel(value: string | null | undefined): string {
  const normalized = resolveAgyThinkingLevel(value ?? "");
  return normalized === "minimal" ? "" : normalized ?? "";
}

function normalizeDefaultIndex(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

// 저장된 새 세션 기본 권한 모드를 정규화한다. 알 수 없는 값이나 미설정이면 undefined를
// 반환해 새 세션이 프로젝트 defaultMode를 따르게 한다.
function normalizeDefaultPermissionMode(value: string | null | undefined): PermissionMode | undefined {
  const modes: PermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"];
  return value && modes.includes(value as PermissionMode) ? (value as PermissionMode) : undefined;
}

interface SessionRow {
  id: string;
  sdk_session_id: string | null;
  chat_id: number;
  topic_id: number;
  project_name: string;
  cwd: string;
  title: string;
  status: SessionStatus;
  permission_mode: PermissionMode;
  provider: string | null;
  model: string | null;
  thinking: string | null;
  claude_effort: string | null;
  claude_token_index: number | null;
  codex_model: string | null;
  codex_reasoning: string | null;
  subagent_model: string | null;
  subagent_reasoning: string | null;
  subagent_effort: string | null;
  codex_home: string | null;
  codex_thread_id: string | null;
  agy_model: string | null;
  agy_thinking_level: string | null;
  agy_conversation_id: string | null;
  agy_usage: string | null;
  grok_usage: string | null;
  grok_model: string | null;
  grok_reasoning: string | null;
  grok_session_id: string | null;
  cline_provider_id: string | null;
  cline_model: string | null;
  cline_reasoning: string | null;
  cline_session_id: string | null;
  cline_usage: string | null;
  handoff_summary: string | null;
  goal_condition: string | null;
  lean_mode: number;
  usage_snapshot: string | null;
  always_allowed_tools: string;
  created_at: number;
  updated_at: number;
}

interface ProjectRow {
  name: string;
  cwd: string;
  default_mode: PermissionMode;
}

interface ApprovalRow {
  nonce: string;
  tool_use_id: string;
  session_id: string;
  tool_name: string;
  input_json: string;
  suggestions_json: string;
  status: ApprovalRecord["status"];
  expires_at: number;
  message_id: number | null;
}

interface ReservedTaskRow {
  id: string;
  chat_id: number;
  project_name: string;
  prompt: string;
  due_at: number;
  status: ReservedTaskStatus;
  error_message: string | null;
  topic_id: number | null;
  session_id: string | null;
  start_options_json: string;
  created_at: number;
  updated_at: number;
}

export class StateStore {
  readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        name TEXT PRIMARY KEY,
        cwd TEXT NOT NULL UNIQUE,
        default_mode TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        sdk_session_id TEXT UNIQUE,
        chat_id INTEGER NOT NULL,
        topic_id INTEGER NOT NULL,
        project_name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        model TEXT,
        thinking TEXT,
        claude_token_index INTEGER,
        codex_model TEXT,
        subagent_model TEXT,
        subagent_reasoning TEXT,
        subagent_effort TEXT,
        codex_home TEXT,
        codex_thread_id TEXT,
        agy_model TEXT,
        grok_model TEXT,
        grok_reasoning TEXT,
        grok_session_id TEXT,
        cline_provider_id TEXT,
        cline_model TEXT,
        cline_reasoning TEXT,
        cline_session_id TEXT,
        cline_usage TEXT,
        agy_conversation_id TEXT,
        handoff_summary TEXT,
        lean_mode INTEGER NOT NULL DEFAULT 1,
        usage_snapshot TEXT,
        always_allowed_tools TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(project_name) REFERENCES projects(name)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS sessions_topic_idx
        ON sessions(chat_id, topic_id);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_approvals (
        nonce TEXT PRIMARY KEY,
        tool_use_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        suggestions_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        message_id INTEGER,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS reserved_tasks (
        id TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        project_name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        topic_id INTEGER,
        session_id TEXT,
        start_options_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(project_name) REFERENCES projects(name)
      );

      CREATE INDEX IF NOT EXISTS reserved_tasks_due_idx
        ON reserved_tasks(status, due_at);

    `);
    this.db.exec(`
      DROP TABLE IF EXISTS plan_evidence;
      DROP TABLE IF EXISTS plan_criteria;
      DROP TABLE IF EXISTS plan_runs;
    `);
    const sessionColumns = this.db
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string; }>;
    const reservedTaskColumns = this.db
      .prepare("PRAGMA table_info(reserved_tasks)")
      .all() as Array<{ name: string; }>;
    if (!reservedTaskColumns.some((column) => column.name === "start_options_json")) {
      this.db.exec("ALTER TABLE reserved_tasks ADD COLUMN start_options_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!sessionColumns.some((column) => column.name === "usage_snapshot")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN usage_snapshot TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "model")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "thinking")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN thinking TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "lean_mode")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN lean_mode INTEGER NOT NULL DEFAULT 1");
    }
    if (!sessionColumns.some((column) => column.name === "codex_reasoning")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN codex_reasoning TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "codex_home")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN codex_home TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "claude_effort")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN claude_effort TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "claude_token_index")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN claude_token_index INTEGER");
    }
    if (!sessionColumns.some((column) => column.name === "goal_condition")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN goal_condition TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "provider")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'");
    }
    if (!sessionColumns.some((column) => column.name === "codex_model")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN codex_model TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "subagent_model")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN subagent_model TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "subagent_reasoning")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN subagent_reasoning TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "subagent_effort")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN subagent_effort TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "codex_thread_id")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN codex_thread_id TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "handoff_summary")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN handoff_summary TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "agy_model")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN agy_model TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "grok_model")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN grok_model TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "grok_reasoning")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN grok_reasoning TEXT");
    }
    // Grok CLI 세션 재개 UUID. 기존 행은 null(첫 grok 턴에서 새 세션 생성).
    if (!sessionColumns.some((column) => column.name === "grok_session_id")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN grok_session_id TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "agy_conversation_id")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN agy_conversation_id TEXT");
    }
    // agy thinking_level 축 신설(Phase 2). 기존 행은 null(모델 기본) 기본값.
    if (!sessionColumns.some((column) => column.name === "agy_thinking_level")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN agy_thinking_level TEXT");
    }
    // agy 네이티브 토큰 사용량(Phase 3). JSON 문자열 또는 null. 기존 행은 null.
    if (!sessionColumns.some((column) => column.name === "agy_usage")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN agy_usage TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "grok_usage")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN grok_usage TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "cline_provider_id")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN cline_provider_id TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "cline_model")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN cline_model TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "cline_reasoning")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN cline_reasoning TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "cline_session_id")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN cline_session_id TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "cline_usage")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN cline_usage TEXT");
    }
    this.db.exec(`
      UPDATE sessions
      SET provider = 'claude'
      WHERE provider IS NULL OR provider NOT IN ('claude', 'codex', 'agy', 'grok', 'cline');

      UPDATE app_settings
      SET value = 'claude'
      WHERE key = 'default.provider'
        AND value NOT IN ('claude', 'codex', 'agy', 'grok', 'cline');
    `);
    const agyThinkingDefault = this.db
      .prepare("SELECT value FROM app_settings WHERE key = 'default.agyThinkingLevel'")
      .get() as { value: string; } | undefined;
    if (agyThinkingDefault && !resolveAgyThinkingLevel(agyThinkingDefault.value)) {
      this.db.prepare(
        "INSERT INTO app_settings(key, value) VALUES ('default.agyThinkingLevel', ?) "
        + "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(SESSION_DEFAULT_SEED.agyThinkingLevel);
    }
  }

  syncProjects(projects: ProjectConfig[]): void {
    const statement = this.db.prepare(`
      INSERT INTO projects(name, cwd, default_mode, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        cwd = excluded.cwd,
        default_mode = excluded.default_mode,
        updated_at = excluded.updated_at
    `);
    const now = Date.now();
    this.db.transaction(() => {
      for (const project of projects) {
        statement.run(project.name, project.cwd, project.defaultMode, now);
      }
    })();
  }

  listProjects(): ProjectConfig[] {
    const rows = this.db
      .prepare("SELECT name, cwd, default_mode FROM projects ORDER BY name COLLATE NOCASE")
      .all() as ProjectRow[];
    return rows.map((row) => this.mapProject(row));
  }

  getProjectByCwd(cwd: string): ProjectConfig | undefined {
    const row = this.db
      .prepare("SELECT name, cwd, default_mode FROM projects WHERE cwd = ?")
      .get(cwd) as ProjectRow | undefined;
    return row ? this.mapProject(row) : undefined;
  }

  countSessionsByProject(name: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE project_name = ?")
      .get(name) as { count: number; };
    return row.count;
  }

  deleteProject(name: string): boolean {
    const result = this.db.prepare("DELETE FROM projects WHERE name = ?").run(name);
    return result.changes > 0;
  }

  createSession(session: SessionRecord): void {
    this.db.prepare(`
      INSERT INTO sessions(
        id, sdk_session_id, chat_id, topic_id, project_name, cwd, title,
        status, permission_mode, provider, model, thinking, claude_effort,
        claude_token_index, codex_model, codex_reasoning, subagent_model, subagent_reasoning, subagent_effort, codex_home, codex_thread_id, agy_model, grok_model, grok_reasoning, grok_session_id, agy_thinking_level,
        agy_conversation_id, agy_usage, grok_usage,
        cline_provider_id, cline_model, cline_reasoning, cline_session_id, cline_usage,
        handoff_summary, goal_condition, lean_mode, usage_snapshot,
        always_allowed_tools, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.sdkSessionId,
      session.chatId,
      session.topicId,
      session.projectName,
      session.cwd,
      session.title,
      session.status,
      session.permissionMode,
      session.provider,
      session.model,
      session.thinking,
      session.claudeEffort ?? null,
      session.claudeTokenIndex ?? null,
      session.codexModel ?? null,
      session.codexReasoning ?? null,
      session.subagentModel ?? null,
      session.subagentReasoning ?? null,
      session.subagentEffort ?? null,
      session.codexHome ?? null,
      session.codexThreadId ?? null,
      session.agyModel ?? null,
      session.grokModel ?? null,
      session.grokReasoning ?? null,
      session.grokSessionId ?? null,
      session.agyThinkingLevel ?? null,
      session.agyConversationId ?? null,
      session.agyUsage ?? null,
      session.grokUsage ?? null,
      session.clineProviderId ?? null,
      session.clineModel ?? null,
      session.clineReasoning ?? null,
      session.clineSessionId ?? null,
      session.clineUsage ?? null,
      session.handoffSummary ?? null,
      session.goalCondition ?? null,
      session.leanMode ? 1 : 0,
      session.usageSnapshot ? JSON.stringify(session.usageSnapshot) : null,
      "[]",
      session.createdAt,
      session.updatedAt
    );
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  getSessionByTopic(chatId: number, topicId: number): SessionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE chat_id = ? AND topic_id = ?")
      .get(chatId, topicId) as SessionRow | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  listSessions(limit = 20): SessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as SessionRow[];
    return rows.map((row) => this.mapSession(row));
  }

  countSessions(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
      count: number;
    };
    return row.count;
  }

  updateSession(
    id: string,
    fields: Partial<Pick<
      SessionRecord,
      "sdkSessionId" | "title" | "status" | "permissionMode" | "provider" | "model" | "thinking" | "claudeEffort" | "claudeTokenIndex" | "codexModel" | "codexReasoning" | "subagentReasoning" | "subagentEffort" | "codexHome" | "codexThreadId" | "agyModel" | "grokModel" | "grokReasoning" | "grokSessionId" | "agyThinkingLevel" | "agyConversationId" | "agyUsage" | "grokUsage" | "clineProviderId" | "clineModel" | "clineReasoning" | "clineSessionId" | "clineUsage" | "handoffSummary" | "goalCondition" | "leanMode" | "usageSnapshot"
    >>
  ): void {
    const entries: Array<[string, unknown]> = [];
    if ("sdkSessionId" in fields) entries.push(["sdk_session_id", fields.sdkSessionId]);
    if ("title" in fields) entries.push(["title", fields.title]);
    if ("status" in fields) entries.push(["status", fields.status]);
    if ("permissionMode" in fields) entries.push(["permission_mode", fields.permissionMode]);
    if ("provider" in fields) entries.push(["provider", fields.provider]);
    if ("model" in fields) entries.push(["model", fields.model]);
    if ("thinking" in fields) entries.push(["thinking", fields.thinking]);
    if ("claudeEffort" in fields) entries.push(["claude_effort", fields.claudeEffort]);
    if ("claudeTokenIndex" in fields) entries.push(["claude_token_index", fields.claudeTokenIndex]);
    if ("codexModel" in fields) entries.push(["codex_model", fields.codexModel]);
    if ("codexReasoning" in fields) entries.push(["codex_reasoning", fields.codexReasoning]);
    if ("subagentReasoning" in fields) entries.push(["subagent_reasoning", fields.subagentReasoning]);
    if ("subagentEffort" in fields) entries.push(["subagent_effort", fields.subagentEffort]);
    if ("codexHome" in fields) entries.push(["codex_home", fields.codexHome]);
    if ("codexThreadId" in fields) entries.push(["codex_thread_id", fields.codexThreadId]);
    if ("agyModel" in fields) entries.push(["agy_model", fields.agyModel]);
    if ("grokModel" in fields) entries.push(["grok_model", fields.grokModel]);
    if ("grokReasoning" in fields) entries.push(["grok_reasoning", fields.grokReasoning]);
    if ("grokSessionId" in fields) entries.push(["grok_session_id", fields.grokSessionId ?? null]);
    if ("agyThinkingLevel" in fields) entries.push(["agy_thinking_level", fields.agyThinkingLevel]);
    if ("agyConversationId" in fields) entries.push(["agy_conversation_id", fields.agyConversationId]);
    if ("agyUsage" in fields) entries.push(["agy_usage", fields.agyUsage ?? null]);
    if ("grokUsage" in fields) entries.push(["grok_usage", fields.grokUsage ?? null]);
    if ("clineProviderId" in fields) entries.push(["cline_provider_id", fields.clineProviderId ?? null]);
    if ("clineModel" in fields) entries.push(["cline_model", fields.clineModel ?? null]);
    if ("clineReasoning" in fields) entries.push(["cline_reasoning", fields.clineReasoning ?? null]);
    if ("clineSessionId" in fields) entries.push(["cline_session_id", fields.clineSessionId ?? null]);
    if ("clineUsage" in fields) entries.push(["cline_usage", fields.clineUsage ?? null]);
    if ("handoffSummary" in fields) entries.push(["handoff_summary", fields.handoffSummary]);
    if ("goalCondition" in fields) entries.push(["goal_condition", fields.goalCondition]);
    if ("leanMode" in fields) entries.push(["lean_mode", fields.leanMode ? 1 : 0]);
    if ("usageSnapshot" in fields) {
      entries.push([
        "usage_snapshot",
        fields.usageSnapshot ? JSON.stringify(fields.usageSnapshot) : null
      ]);
    }
    if (entries.length === 0) return;

    entries.push(["updated_at", Date.now()]);
    const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
    this.db.prepare(`UPDATE sessions SET ${assignments} WHERE id = ?`).run(
      ...entries.map(([, value]) => value),
      id
    );
  }

  deleteSession(id: string): boolean {
    const result = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // 새 세션 기본값(전역 1벌). app_settings의 default.* 키에 저장하고, 없는 값은 시드로 채운다.
  getSessionDefaults(): SessionDefaults {
    const rows = this.db
      .prepare("SELECT key, value FROM app_settings WHERE key LIKE 'default.%'")
      .all() as Array<{ key: string; value: string; }>;
    const stored = new Map(rows.map((row) => [row.key.slice("default.".length), row.value]));
    const defaultPermissionMode = normalizeDefaultPermissionMode(stored.get("defaultPermissionMode"));
    return {
      provider: normalizeProvider(stored.get("provider")),
      claudeModel: stored.get("claudeModel") ?? SESSION_DEFAULT_SEED.claudeModel,
      claudeTokenIndex: normalizeDefaultIndex(stored.get("claudeTokenIndex")),
      codexModel: stored.get("codexModel") ?? SESSION_DEFAULT_SEED.codexModel,
      agyModel: stored.get("agyModel") ?? SESSION_DEFAULT_SEED.agyModel,
      grokModel: stored.get("grokModel") ?? SESSION_DEFAULT_SEED.grokModel,
      grokReasoning: stored.get("grokReasoning") ?? SESSION_DEFAULT_SEED.grokReasoning,
      clineProviderId: stored.get("clineProviderId") ?? SESSION_DEFAULT_SEED.clineProviderId ?? "",
      clineModel: stored.get("clineModel") ?? SESSION_DEFAULT_SEED.clineModel ?? "",
      clineReasoning: stored.get("clineReasoning") ?? SESSION_DEFAULT_SEED.clineReasoning ?? "high",
      thinking: stored.get("thinking") ?? SESSION_DEFAULT_SEED.thinking,
      claudeEffort: stored.get("claudeEffort") ?? SESSION_DEFAULT_SEED.claudeEffort,
      codexReasoning: stored.get("codexReasoning") ?? SESSION_DEFAULT_SEED.codexReasoning,
      codexHome: stored.get("codexHome") ?? SESSION_DEFAULT_SEED.codexHome,
      subagentModel: stored.get("subagentModel") || null,
      subagentReasoning: stored.get("subagentReasoning") || null,
      subagentEffort: stored.get("subagentEffort") || null,
      agyThinkingLevel: normalizeDefaultAgyThinkingLevel(stored.get("agyThinkingLevel")),
      ...(defaultPermissionMode ? { defaultPermissionMode } : {})
    };
  }

  updateSessionDefaults(fields: Partial<SessionDefaults>): SessionDefaults {
    const statement = this.db.prepare(
      "INSERT INTO app_settings(key, value) VALUES (?, ?) "
      + "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        const normalized = key === "agyThinkingLevel"
          ? normalizeDefaultAgyThinkingLevel(String(value))
          : key === "claudeTokenIndex"
            ? String(normalizeDefaultIndex(String(value)))
            : String(value);
        statement.run(`default.${key}`, normalized);
      }
    })();
    return this.getSessionDefaults();
  }

  createReservedTask(input: {
    chatId: number;
    projectName: string;
    prompt: string;
    dueAt: number;
    topicId?: number | null;
    startOptions?: ReservedTaskStartOptions;
  }): ReservedTaskRecord {
    const now = Date.now();
    const task: ReservedTaskRecord = {
      id: randomUUID(),
      chatId: input.chatId,
      projectName: input.projectName,
      prompt: input.prompt,
      dueAt: input.dueAt,
      status: "pending",
      errorMessage: null,
      topicId: input.topicId ?? null,
      sessionId: null,
      startOptions: input.startOptions ?? {},
      createdAt: now,
      updatedAt: now
    };
    this.db.prepare(`
      INSERT INTO reserved_tasks(
        id, chat_id, project_name, prompt, due_at, status, error_message,
        topic_id, session_id, start_options_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.chatId,
      task.projectName,
      task.prompt,
      task.dueAt,
      task.status,
      task.errorMessage,
      task.topicId,
      task.sessionId,
      JSON.stringify(task.startOptions),
      task.createdAt,
      task.updatedAt
    );
    return task;
  }

  getReservedTask(id: string): ReservedTaskRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM reserved_tasks WHERE id = ?")
      .get(id) as ReservedTaskRow | undefined;
    return row ? this.mapReservedTask(row) : undefined;
  }

  listPendingReservedTasks(): ReservedTaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM reserved_tasks WHERE status = 'pending' ORDER BY due_at ASC")
      .all() as ReservedTaskRow[];
    return rows.map((row) => this.mapReservedTask(row));
  }

  listRecentReservedTasks(limit = 20): ReservedTaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM reserved_tasks ORDER BY due_at DESC LIMIT ?")
      .all(limit) as ReservedTaskRow[];
    return rows.map((row) => this.mapReservedTask(row));
  }

  updateReservedTask(
    id: string,
    fields: Partial<Pick<
      ReservedTaskRecord,
      "status" | "errorMessage" | "topicId" | "sessionId"
    >>
  ): void {
    const entries: Array<[string, unknown]> = [];
    if ("status" in fields) entries.push(["status", fields.status]);
    if ("errorMessage" in fields) entries.push(["error_message", fields.errorMessage ?? null]);
    if ("topicId" in fields) entries.push(["topic_id", fields.topicId ?? null]);
    if ("sessionId" in fields) entries.push(["session_id", fields.sessionId ?? null]);
    if (entries.length === 0) return;
    entries.push(["updated_at", Date.now()]);
    const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
    this.db.prepare(`UPDATE reserved_tasks SET ${assignments} WHERE id = ?`).run(
      ...entries.map(([, value]) => value),
      id
    );
  }

  getAppSetting(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(key) as { value: string; } | undefined;
    return row?.value ?? null;
  }

  setAppSetting(key: string, value: string): void {
    this.db.prepare(
      "INSERT INTO app_settings(key, value) VALUES (?, ?) "
      + "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, value);
  }

  interruptIncompleteSessions(): SessionRecord[] {
    // 재기동 직전에 살아 있던 세션만 별도로 보존한다. 이미 과거에 중단된 세션까지
    // 자동 재개하면 오래된 작업이 뜻밖에 다시 실행될 수 있다.
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE status IN ('queued', 'running', 'waiting_approval', 'waiting_limit')
    `).all() as SessionRow[];
    const interrupted = rows.map((row) => this.mapSession(row));
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE sessions
        SET status = 'interrupted', updated_at = ?
        WHERE status IN ('queued', 'running', 'waiting_approval', 'waiting_limit')
      `).run(Date.now());
      this.db.prepare(`
        UPDATE pending_approvals
        SET status = 'expired'
        WHERE status = 'pending'
      `).run();
    })();
    return interrupted;
  }

  createApproval(approval: ApprovalRecord): void {
    this.db.prepare(`
      INSERT INTO pending_approvals(
        nonce, tool_use_id, session_id, tool_name, input_json,
        suggestions_json, status, expires_at, message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      approval.nonce,
      approval.toolUseId,
      approval.sessionId,
      approval.toolName,
      JSON.stringify(approval.input),
      JSON.stringify(approval.suggestions),
      approval.status,
      approval.expiresAt,
      approval.messageId
    );
  }

  getApproval(nonce: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM pending_approvals WHERE nonce = ?")
      .get(nonce) as ApprovalRow | undefined;
    if (!row) return undefined;
    return {
      nonce: row.nonce,
      toolUseId: row.tool_use_id,
      sessionId: row.session_id,
      toolName: row.tool_name,
      input: JSON.parse(row.input_json) as Record<string, unknown>,
      suggestions: JSON.parse(row.suggestions_json) as PermissionUpdate[],
      status: row.status,
      expiresAt: row.expires_at,
      messageId: row.message_id
    };
  }

  updateApproval(nonce: string, status: ApprovalRecord["status"], messageId?: number): void {
    if (messageId === undefined) {
      this.db.prepare("UPDATE pending_approvals SET status = ? WHERE nonce = ?").run(status, nonce);
      return;
    }
    this.db
      .prepare("UPDATE pending_approvals SET status = ?, message_id = ? WHERE nonce = ?")
      .run(status, messageId, nonce);
  }

  private mapSession(row: SessionRow): SessionRecord {
    return {
      id: row.id,
      sdkSessionId: row.sdk_session_id,
      chatId: row.chat_id,
      topicId: row.topic_id,
      projectName: row.project_name,
      cwd: row.cwd,
      title: row.title,
      status: row.status,
      permissionMode: row.permission_mode,
      provider: normalizeProvider(row.provider),
      model: row.model,
      thinking: row.thinking,
      claudeEffort: row.claude_effort,
      claudeTokenIndex: row.claude_token_index,
      codexModel: row.codex_model,
      codexReasoning: row.codex_reasoning,
      subagentModel: row.subagent_model,
      subagentReasoning: row.subagent_reasoning,
      subagentEffort: row.subagent_effort,
      codexHome: row.codex_home,
      codexThreadId: row.codex_thread_id,
      agyModel: row.agy_model,
      grokModel: row.grok_model,
      grokReasoning: row.grok_reasoning,
      grokSessionId: row.grok_session_id,
      clineProviderId: row.cline_provider_id,
      clineModel: row.cline_model,
      clineReasoning: row.cline_reasoning,
      clineSessionId: row.cline_session_id,
      clineUsage: row.cline_usage,
      agyThinkingLevel: row.agy_thinking_level,
      agyConversationId: row.agy_conversation_id,
      agyUsage: row.agy_usage,
      grokUsage: row.grok_usage,
      handoffSummary: row.handoff_summary,
      goalCondition: row.goal_condition,
      leanMode: row.lean_mode !== 0,
      usageSnapshot: this.parseUsageSnapshot(row.usage_snapshot),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapProject(row: ProjectRow): ProjectConfig {
    return {
      name: row.name,
      cwd: row.cwd,
      defaultMode: row.default_mode
    };
  }

  private mapReservedTask(row: ReservedTaskRow): ReservedTaskRecord {
    return {
      id: row.id,
      chatId: row.chat_id,
      projectName: row.project_name,
      prompt: row.prompt,
      dueAt: row.due_at,
      status: row.status,
      errorMessage: row.error_message,
      topicId: row.topic_id,
      sessionId: row.session_id,
      startOptions: this.parseReservedTaskStartOptions(row.start_options_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private parseReservedTaskStartOptions(value: string): ReservedTaskStartOptions {
    try {
      const parsed = JSON.parse(value) as ReservedTaskStartOptions;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private parseUsageSnapshot(value: string | null): UsageSnapshot | null {
    if (!value) return null;
    try {
      return JSON.parse(value) as UsageSnapshot;
    } catch {
      return null;
    }
  }

}
