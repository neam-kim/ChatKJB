import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { PermissionMode, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { redactSensitiveText, redactSensitiveValue } from "./redaction.js";
import type {
  ApprovalRecord,
  PlanCriterionRecord,
  PlanCriterionStatus,
  PlanEvidenceRecord,
  PlanRunRecord,
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
  model: string | null;
  thinking: string | null;
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

interface PlanRunRow {
  id: string;
  session_id: string;
  instruction: string;
  plan_text: string;
  status: PlanRunRecord["status"];
  reviewer_verdict: PlanRunRecord["reviewerVerdict"];
  review_text: string | null;
  codex_result: string | null;
  attempt_count: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface PlanCriterionRow {
  id: string;
  plan_run_id: string;
  ordinal: number;
  description: string;
  status: PlanCriterionStatus;
  evidence_summary: string | null;
  updated_at: number;
}

interface PlanEvidenceRow {
  id: string;
  plan_run_id: string;
  criterion_id: string | null;
  kind: PlanEvidenceRecord["kind"];
  source: PlanEvidenceRecord["source"];
  summary: string;
  details_json: string;
  created_at: number;
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
        model TEXT,
        thinking TEXT,
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

      CREATE TABLE IF NOT EXISTS plan_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        instruction TEXT NOT NULL,
        plan_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        reviewer_verdict TEXT,
        review_text TEXT,
        codex_result TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS plan_runs_session_idx
        ON plan_runs(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS plan_criteria (
        id TEXT PRIMARY KEY,
        plan_run_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence_summary TEXT,
        updated_at INTEGER NOT NULL,
        UNIQUE(plan_run_id, ordinal),
        FOREIGN KEY(plan_run_id) REFERENCES plan_runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS plan_evidence (
        id TEXT PRIMARY KEY,
        plan_run_id TEXT NOT NULL,
        criterion_id TEXT,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        FOREIGN KEY(plan_run_id) REFERENCES plan_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(criterion_id) REFERENCES plan_criteria(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS plan_evidence_run_idx
        ON plan_evidence(plan_run_id, created_at);
    `);
    const sessionColumns = this.db
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "usage_snapshot")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN usage_snapshot TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "model")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
    }
    if (!sessionColumns.some((column) => column.name === "thinking")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN thinking TEXT");
    }
    const planRunColumns = this.db
      .prepare("PRAGMA table_info(plan_runs)")
      .all() as Array<{ name: string }>;
    if (!planRunColumns.some((column) => column.name === "attempt_count")) {
      this.db.exec("ALTER TABLE plan_runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0");
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
        status, permission_mode, model, thinking, usage_snapshot, always_allowed_tools, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      session.model,
      session.thinking,
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
      "sdkSessionId" | "title" | "status" | "permissionMode" | "model" | "thinking" | "usageSnapshot"
    >>
  ): void {
    const entries: Array<[string, unknown]> = [];
    if ("sdkSessionId" in fields) entries.push(["sdk_session_id", fields.sdkSessionId]);
    if ("title" in fields) entries.push(["title", fields.title]);
    if ("status" in fields) entries.push(["status", fields.status]);
    if ("permissionMode" in fields) entries.push(["permission_mode", fields.permissionMode]);
    if ("model" in fields) entries.push(["model", fields.model]);
    if ("thinking" in fields) entries.push(["thinking", fields.thinking]);
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
    this.db.prepare(`
      UPDATE plan_runs
      SET status = 'interrupted', updated_at = ?, completed_at = ?
      WHERE status IN ('planning', 'awaiting_approval', 'executing', 'reviewing')
    `).run(Date.now(), Date.now());
    return result.changes;
  }

  createPlanRun(run: PlanRunRecord): void {
    this.db.prepare(`
      INSERT INTO plan_runs(
        id, session_id, instruction, plan_text, status, reviewer_verdict,
        review_text, codex_result, attempt_count, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.sessionId,
      redactSensitiveText(run.instruction),
      redactSensitiveText(run.planText),
      run.status,
      run.reviewerVerdict,
      run.reviewText ? redactSensitiveText(run.reviewText) : null,
      run.codexResult ? redactSensitiveText(run.codexResult) : null,
      run.attemptCount,
      run.createdAt,
      run.updatedAt,
      run.completedAt
    );
  }

  getPlanRun(id: string): PlanRunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM plan_runs WHERE id = ?").get(id) as
      | PlanRunRow
      | undefined;
    return row ? this.mapPlanRun(row) : undefined;
  }

  getLatestPlanRunForSession(sessionId: string): PlanRunRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM plan_runs
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sessionId) as PlanRunRow | undefined;
    return row ? this.mapPlanRun(row) : undefined;
  }

  updatePlanRun(
    id: string,
    fields: Partial<Pick<
      PlanRunRecord,
      "planText" | "status" | "reviewerVerdict" | "reviewText" | "codexResult" | "attemptCount" | "completedAt"
    >>
  ): void {
    const entries: Array<[string, unknown]> = [];
    if ("planText" in fields) {
      entries.push([
        "plan_text",
        fields.planText === undefined ? undefined : redactSensitiveText(fields.planText)
      ]);
    }
    if ("status" in fields) entries.push(["status", fields.status]);
    if ("reviewerVerdict" in fields) {
      entries.push(["reviewer_verdict", fields.reviewerVerdict]);
    }
    if ("reviewText" in fields) {
      entries.push([
        "review_text",
        fields.reviewText ? redactSensitiveText(fields.reviewText) : fields.reviewText
      ]);
    }
    if ("codexResult" in fields) {
      entries.push([
        "codex_result",
        fields.codexResult ? redactSensitiveText(fields.codexResult) : fields.codexResult
      ]);
    }
    if ("attemptCount" in fields) entries.push(["attempt_count", fields.attemptCount]);
    if ("completedAt" in fields) entries.push(["completed_at", fields.completedAt]);
    if (entries.length === 0) return;

    entries.push(["updated_at", Date.now()]);
    const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
    this.db.prepare(`UPDATE plan_runs SET ${assignments} WHERE id = ?`).run(
      ...entries.map(([, value]) => value),
      id
    );
  }

  replacePlanCriteria(planRunId: string, descriptions: string[]): PlanCriterionRecord[] {
    const now = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO plan_criteria(
        id, plan_run_id, ordinal, description, status, evidence_summary, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', NULL, ?)
    `);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM plan_criteria WHERE plan_run_id = ?").run(planRunId);
      descriptions.forEach((description, index) => {
        insert.run(
          `${planRunId}:criterion:${index + 1}`,
          planRunId,
          index + 1,
          redactSensitiveText(description),
          now
        );
      });
    })();
    return this.listPlanCriteria(planRunId);
  }

  listPlanCriteria(planRunId: string): PlanCriterionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM plan_criteria
      WHERE plan_run_id = ?
      ORDER BY ordinal
    `).all(planRunId) as PlanCriterionRow[];
    return rows.map((row) => this.mapPlanCriterion(row));
  }

  updatePlanCriterion(
    id: string,
    status: PlanCriterionStatus,
    evidenceSummary: string | null
  ): void {
    this.db.prepare(`
      UPDATE plan_criteria
      SET status = ?, evidence_summary = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      evidenceSummary ? redactSensitiveText(evidenceSummary) : evidenceSummary,
      Date.now(),
      id
    );
  }

  addPlanEvidence(evidence: PlanEvidenceRecord): void {
    this.db.prepare(`
      INSERT INTO plan_evidence(
        id, plan_run_id, criterion_id, kind, source, summary, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evidence.id,
      evidence.planRunId,
      evidence.criterionId,
      evidence.kind,
      evidence.source,
      redactSensitiveText(evidence.summary),
      JSON.stringify(redactSensitiveValue(evidence.details)),
      evidence.createdAt
    );
  }

  listPlanEvidence(planRunId: string): PlanEvidenceRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM plan_evidence
      WHERE plan_run_id = ?
      ORDER BY created_at, id
    `).all(planRunId) as PlanEvidenceRow[];
    return rows.map((row) => ({
      id: row.id,
      planRunId: row.plan_run_id,
      criterionId: row.criterion_id,
      kind: row.kind,
      source: row.source,
      summary: row.summary,
      details: this.parseDetails(row.details_json),
      createdAt: row.created_at
    }));
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
      model: row.model,
      thinking: row.thinking,
      usageSnapshot: this.parseUsageSnapshot(row.usage_snapshot),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapPlanRun(row: PlanRunRow): PlanRunRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      instruction: row.instruction,
      planText: row.plan_text,
      status: row.status,
      reviewerVerdict: row.reviewer_verdict,
      reviewText: row.review_text,
      codexResult: row.codex_result,
      attemptCount: row.attempt_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at
    };
  }

  private mapPlanCriterion(row: PlanCriterionRow): PlanCriterionRecord {
    return {
      id: row.id,
      planRunId: row.plan_run_id,
      ordinal: row.ordinal,
      description: row.description,
      status: row.status,
      evidenceSummary: row.evidence_summary,
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

  private parseDetails(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
}
