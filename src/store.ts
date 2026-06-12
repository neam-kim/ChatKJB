import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { PermissionMode, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type {
  ApprovalRecord,
  ProjectConfig,
  SessionRecord,
  SessionStatus,
  UsageSnapshot
} from "./types.js";

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
  usage_snapshot: string | null;
  always_allowed_tools: string;
  created_at: number;
  updated_at: number;
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
        usage_snapshot TEXT,
        always_allowed_tools TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(project_name) REFERENCES projects(name)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS sessions_topic_idx
        ON sessions(chat_id, topic_id);

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
    `);
    const sessionColumns = this.db
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "usage_snapshot")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN usage_snapshot TEXT");
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

  createSession(session: SessionRecord): void {
    this.db.prepare(`
      INSERT INTO sessions(
        id, sdk_session_id, chat_id, topic_id, project_name, cwd, title,
        status, permission_mode, usage_snapshot, always_allowed_tools, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  updateSession(
    id: string,
    fields: Partial<Pick<
      SessionRecord,
      "sdkSessionId" | "title" | "status" | "permissionMode" | "usageSnapshot"
    >>
  ): void {
    const entries: Array<[string, unknown]> = [];
    if ("sdkSessionId" in fields) entries.push(["sdk_session_id", fields.sdkSessionId]);
    if ("title" in fields) entries.push(["title", fields.title]);
    if ("status" in fields) entries.push(["status", fields.status]);
    if ("permissionMode" in fields) entries.push(["permission_mode", fields.permissionMode]);
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

  interruptIncompleteSessions(): number {
    const result = this.db.prepare(`
      UPDATE sessions
      SET status = 'interrupted', updated_at = ?
      WHERE status IN ('queued', 'running', 'waiting_approval')
    `).run(Date.now());
    this.db.prepare(`
      UPDATE pending_approvals
      SET status = 'expired'
      WHERE status = 'pending'
    `).run();
    return result.changes;
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
      usageSnapshot: this.parseUsageSnapshot(row.usage_snapshot),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
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
