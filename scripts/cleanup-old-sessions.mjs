#!/usr/bin/env node
// 10일 지난 세션을 정리한다 — 단, LLM-Wiki로 이미 덤프된(=지식이 보존된) 세션만.
//
// 토큰 0 원칙: 이 스크립트는 LLM/에이전트를 전혀 호출하지 않는다. 순수 파일·SQLite 삭제와
//   텔레그램 HTTP 호출(deleteForumTopic)만 한다. dump-transcripts.mjs와 같은 launchd 규약으로
//   매일 1회(05시, 덤프가 안 도는 04~08시 창) 실행한다.
//
// 동작 개요
//   대상 = 마지막 활동이 RETAIN_DAYS(기본 10일) 이전이고 + LLM-Wiki에 이미 덤프된 세션.
//     · 오케스트레이터 세션(state.sqlite 행): 디스크 원본 트랜스크립트 + DB 행 + 텔레그램 포럼 토픽 삭제
//     · 데스크톱 단독 세션(파일만): 디스크 원본 트랜스크립트 삭제
//   LLM-Wiki 볼트(.md 덤프 결과)는 절대 건드리지 않는다 — 거기에 증류된 지식이 영구 보존된다.
//
//   "이미 덤프됨" 판정(보수적): 다음 중 하나라도 참이면 덤프된 것으로 본다.
//     1) 덤프 워터마크(_meta/.transcript-dump-state.json)의 sessions 키에 id가 있음
//     2) inbox/raw .md frontmatter의 session_id 로 id가 등장
//   둘 다 없으면(아직 한 번도 안 잡힌 세션) 보존한다 — 지식 유실 위험 0.
//
// 안전장치
//   · 오케스트레이터 세션은 종료 상태(terminal)만 삭제한다(진행 중 세션 보호).
//   · 데스크톱 파일은 mtime이 RETAIN_DAYS 이상 지난 것만(=정착된 것만).
//   · CLEANUP_DRY_RUN=1 이면 아무것도 지우지 않고 계획만 출력한다.
//
// 환경변수 오버라이드(기본값은 아래 상수, dump-transcripts.mjs와 동일 키 공유):
//   ORCH_STATE_DB, WIKI_VAULT, CLAUDE_PROJECTS_DIR, CODEX_ACCOUNT_HOMES, CODEX_SESSIONS_DIR,
//   AGY_CONV_DIR, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   CLEANUP_RETAIN_DAYS=10, CLEANUP_DRY_RUN=1, CLEANUP_NOTIFY=0
//   CLEANUP_DELETE_SOURCE=0 / CLEANUP_DELETE_DB=0 / CLEANUP_DELETE_TOPIC=0 (각 단계 끄기)

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// launchd 실행 시 셸 환경이 없으므로 오케스트레이터와 같은 .env를 내장 loader로 읽는다.
try {
  process.loadEnvFile(join(REPO_ROOT, ".env"));
} catch {
  /* .env 없음 — 기본값 유지 */
}

const STATE_DB =
  process.env.ORCH_STATE_DB || join(REPO_ROOT, "data", "state.sqlite");
const WIKI_VAULT =
  process.env.WIKI_VAULT ||
  "smb://JB_Kim._smb._tcp.local/homes/mac_neam96/AI/LLM-Wiki";
const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
const CODEX_SESSIONS_DIRS = (() => {
  const dirs = (process.env.CODEX_ACCOUNT_HOMES || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => join(h, "sessions"));
  dirs.push(process.env.CODEX_SESSIONS_DIR || join(homedir(), ".codex", "sessions"));
  return [...new Set(dirs)];
})();
const AGY_CONV_DIR =
  process.env.AGY_CONV_DIR ||
  join(homedir(), ".local", "share", "telegram-claude-orchestrator", "agy-conversations");

const INBOX_DIR = join(WIKI_VAULT, "10-inbox");
const RAW_DIR = join(WIKI_VAULT, "20-raw");
const STATE_FILE = join(WIKI_VAULT, "_meta", ".transcript-dump-state.json");
const ENV_FILE = join(REPO_ROOT, ".env");

const RETAIN_DAYS = Math.max(1, Number(process.env.CLEANUP_RETAIN_DAYS || 10));
const RETAIN_MS = RETAIN_DAYS * 24 * 60 * 60_000;
const DRY_RUN = process.env.CLEANUP_DRY_RUN === "1";
const NOTIFY = process.env.CLEANUP_NOTIFY !== "0";
const DELETE_SOURCE = process.env.CLEANUP_DELETE_SOURCE !== "0";
const DELETE_DB = process.env.CLEANUP_DELETE_DB !== "0";
const DELETE_TOPIC = process.env.CLEANUP_DELETE_TOPIC !== "0";

const log = (...a) => console.log("[cleanup-old-sessions]", ...a);
const KST = "Asia/Seoul";
function kstStamp(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

// dump-transcripts.mjs와 동일한 종료 상태 집합.
const TERMINAL_STATUSES = new Set([
  "done",
  "verification_failed",
  "aborted",
  "error",
  "interrupted",
]);

// ── "이미 덤프됨" id 집합 수집 ───────────────────────────────────────────────
function readFrontmatter(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  const fields = {};
  for (const line of text.slice(4, end).split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) fields[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

function collectDumpedIds() {
  const ids = new Set();
  // 1) 워터마크 sessions 키
  try {
    const wm = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    for (const id of Object.keys(wm.sessions || {})) ids.add(id);
  } catch {
    /* 워터마크 없음 — frontmatter 스캔으로만 판정 */
  }
  // 2) inbox/raw frontmatter의 session_id
  for (const dir of [INBOX_DIR, RAW_DIR]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const fm = readFrontmatter(join(dir, entry.name));
      if (fm?.session_id) ids.add(String(fm.session_id));
    }
  }
  return ids;
}

// ── 오케스트레이터 세션 ─────────────────────────────────────────────────────
function loadSessions(db) {
  return db
    .prepare(
      `SELECT id, provider, status, chat_id, topic_id, cwd,
              sdk_session_id, codex_thread_id, agy_conversation_id, updated_at
       FROM sessions`
    )
    .all();
}

function encodeClaudeCwd(cwd) {
  return String(cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
}

function findClaudeFile(sdkId, cwd) {
  if (!sdkId) return null;
  const direct = join(CLAUDE_PROJECTS_DIR, encodeClaudeCwd(cwd), `${sdkId}.jsonl`);
  if (existsSync(direct)) return direct;
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;
  for (const d of readdirSync(CLAUDE_PROJECTS_DIR)) {
    const p = join(CLAUDE_PROJECTS_DIR, d, `${sdkId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

function findCodexFile(threadId) {
  if (!threadId) return null;
  let found = null;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(`${threadId}.jsonl`)) found = p;
    }
  };
  for (const root of CODEX_SESSIONS_DIRS) {
    if (found) break;
    if (existsSync(root)) walk(root);
  }
  return found;
}

function findAgyFile(convId) {
  if (!convId) return null;
  const p = join(AGY_CONV_DIR, `${convId}.db`);
  return existsSync(p) ? p : null;
}

function sourceFileForSession(s) {
  if (s.provider === "claude") return findClaudeFile(s.sdk_session_id, s.cwd);
  if (s.provider === "codex") return findCodexFile(s.codex_thread_id);
  if (s.provider === "agy") return findAgyFile(s.agy_conversation_id);
  return null;
}

// ── 데스크톱 단독 세션(오케스트레이터 미소유) 파일 열거 ──────────────────────
const CODEX_UUID_RE =
  /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

function enumerateDesktopFiles(ownedClaude, ownedCodex) {
  const out = []; // { id, provider, file, mtimeMs }
  if (existsSync(CLAUDE_PROJECTS_DIR)) {
    for (const dir of readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const dirPath = join(CLAUDE_PROJECTS_DIR, dir.name);
      let files;
      try {
        files = readdirSync(dirPath);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.endsWith(".jsonl")) continue;
        const id = name.slice(0, -6);
        if (ownedClaude.has(id)) continue;
        const file = join(dirPath, name);
        let st;
        try {
          st = statSync(file);
        } catch {
          continue;
        }
        out.push({ id, provider: "claude", file, mtimeMs: st.mtimeMs });
      }
    }
  }
  for (const root of CODEX_SESSIONS_DIRS) {
    if (!existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          stack.push(p);
          continue;
        }
        if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
        const m = e.name.match(CODEX_UUID_RE);
        if (!m) continue;
        const id = m[1];
        if (ownedCodex.has(id)) continue;
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        out.push({ id, provider: "codex", file: p, mtimeMs: st.mtimeMs });
      }
    }
  }
  return out;
}

// ── 텔레그램 포럼 토픽 삭제 ──────────────────────────────────────────────────
function readEnvValue(key) {
  try {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* .env 없으면 프로세스 환경으로 폴백 */
  }
  return process.env[key] || "";
}

function telegramPost(method, body) {
  const token = readEnvValue("TELEGRAM_BOT_TOKEN");
  if (!token) return false;
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const payload = JSON.stringify(body);
  // fetch는 일부 환경 undici에서 ETIMEDOUT을 내므로 실패 시 curl로 폴백한다(동기 best-effort).
  for (const bin of ["/usr/bin/curl", "curl"]) {
    try {
      execFileSync(
        bin,
        ["-sS", "-m", "15", "-X", "POST", url, "-H", "content-type: application/json", "-d", payload],
        { stdio: "ignore" }
      );
      return true;
    } catch (e) {
      if (bin === "curl") log(`telegram ${method} 실패:`, e?.message || e);
    }
  }
  return false;
}

function deleteForumTopic(chatId, topicId) {
  if (!chatId || !topicId) return false;
  return telegramPost("deleteForumTopic", {
    chat_id: Number(chatId),
    message_thread_id: Number(topicId),
  });
}

function notifyTelegram(text) {
  if (!NOTIFY || DRY_RUN) return;
  const chatId = readEnvValue("TELEGRAM_CHAT_ID");
  if (!chatId) {
    log("telegram 통지 건너뜀: chat_id 없음");
    return;
  }
  telegramPost("sendMessage", { chat_id: Number(chatId), text });
}

// 안전: 삭제 대상 경로가 LLM-Wiki 볼트 밖인지 확인(볼트는 절대 건드리지 않는다).
function isInsideVault(p) {
  const norm = p.endsWith(sep) ? p : p + sep;
  const vault = WIKI_VAULT.endsWith(sep) ? WIKI_VAULT : WIKI_VAULT + sep;
  return norm.startsWith(vault);
}

function removeFile(file) {
  if (!file) return false;
  if (isInsideVault(file)) {
    log("거부: 볼트 내부 파일은 삭제하지 않음:", file);
    return false;
  }
  if (DRY_RUN) return true;
  try {
    rmSync(file, { force: true });
    return true;
  } catch (e) {
    log("파일 삭제 실패:", file, e?.message || e);
    return false;
  }
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  if (!existsSync(STATE_DB)) {
    log("orchestrator DB 없음:", STATE_DB);
    process.exit(1);
  }
  const dumpedIds = collectDumpedIds();
  log(`덤프 완료 id 수집: ${dumpedIds.size}건`);

  const now = Date.now();
  const cutoff = now - RETAIN_MS;
  const counters = {
    orchSourceDeleted: 0,
    orchRowDeleted: 0,
    topicDeleted: 0,
    desktopDeleted: 0,
    skippedNotDumped: 0,
    skippedRecent: 0,
    skippedActive: 0,
  };

  const db = new DatabaseSync(STATE_DB, { readOnly: false });
  db.exec("PRAGMA foreign_keys = ON;");
  let sessions;
  try {
    sessions = loadSessions(db);
    const ownedClaude = new Set(
      sessions.map((s) => s.sdk_session_id).filter(Boolean)
    );
    const ownedCodex = new Set(
      sessions.map((s) => s.codex_thread_id).filter(Boolean)
    );

    // ── Pass A: 오케스트레이터 세션 ──
    const delRow = db.prepare("DELETE FROM sessions WHERE id = ?");
    for (const s of sessions) {
      if (s.updated_at > cutoff) {
        counters.skippedRecent++;
        continue;
      }
      if (!TERMINAL_STATUSES.has(s.status)) {
        counters.skippedActive++;
        continue;
      }
      if (!dumpedIds.has(String(s.id))) {
        counters.skippedNotDumped++;
        continue;
      }
      // 1) 디스크 원본 트랜스크립트
      if (DELETE_SOURCE) {
        const file = sourceFileForSession(s);
        if (file && removeFile(file)) counters.orchSourceDeleted++;
      }
      // 2) 텔레그램 포럼 토픽
      if (DELETE_TOPIC && s.chat_id && s.topic_id) {
        if (DRY_RUN) {
          counters.topicDeleted++;
        } else if (deleteForumTopic(s.chat_id, s.topic_id)) {
          counters.topicDeleted++;
        }
      }
      // 3) 오케스트레이터 DB 행(pending_approvals는 FK CASCADE로 함께 삭제)
      if (DELETE_DB) {
        if (DRY_RUN) {
          counters.orchRowDeleted++;
        } else {
          const r = delRow.run(s.id);
          if (r.changes > 0) counters.orchRowDeleted++;
        }
      }
    }

    // ── Pass B: 데스크톱 단독 세션(파일만) ──
    if (DELETE_SOURCE) {
      for (const f of enumerateDesktopFiles(ownedClaude, ownedCodex)) {
        if (f.mtimeMs > cutoff) {
          counters.skippedRecent++;
          continue;
        }
        if (!dumpedIds.has(String(f.id))) {
          counters.skippedNotDumped++;
          continue;
        }
        if (removeFile(f.file)) counters.desktopDeleted++;
      }
    }
  } finally {
    db.close();
  }

  const summary =
    `정리 대상 ${RETAIN_DAYS}일 경과 + 덤프완료 세션\n` +
    `· 오케스트레이터: 원본 ${counters.orchSourceDeleted} · DB행 ${counters.orchRowDeleted} · 토픽 ${counters.topicDeleted}\n` +
    `· 데스크톱 원본: ${counters.desktopDeleted}\n` +
    `· 보존(미덤프): ${counters.skippedNotDumped} · 최근 ${counters.skippedRecent} · 진행중 ${counters.skippedActive}` +
    (DRY_RUN ? " [DRY RUN]" : "");
  log(summary.replace(/\n/g, " | "));
  notifyTelegram(`🧹 session-cleanup ${kstStamp()}\n${summary}`);
}

main();
