#!/usr/bin/env node
// 7일 지난 종료 세션을 정리한다.
//
// 토큰 0 원칙: 이 스크립트는 LLM/에이전트를 전혀 호출하지 않는다. 순수 파일·SQLite 삭제와
//   텔레그램 HTTP 호출(deleteForumTopic)만 한다. dump-transcripts.mjs와 같은 launchd 규약으로
//   매일 1회(05시, 덤프가 안 도는 04~08시 창) 실행한다.
//
// 동작 개요
//   대상 = 마지막 활동이 RETAIN_DAYS(기본 7일) 이전인 종료 세션.
//     · 오케스트레이터 세션(state.sqlite 행): 디스크 원본 트랜스크립트 + DB 행 + 텔레그램 포럼 토픽 삭제
//     · 데스크톱 단독 세션(파일만): 디스크 원본 트랜스크립트 삭제
// 안전장치
//   · 오케스트레이터 세션은 종료 상태(terminal)만 삭제한다(진행 중 세션 보호).
//   · 데스크톱 파일은 mtime이 RETAIN_DAYS 이상 지난 것만(=정착된 것만).
//   · CLEANUP_DRY_RUN=1 이면 아무것도 지우지 않고 계획만 출력한다.
//
// 환경변수 오버라이드(기본값은 아래 상수, dump-transcripts.mjs와 동일 키 공유):
//   ORCH_STATE_DB, CLAUDE_PROJECTS_DIR, CODEX_ACCOUNT_HOMES, CODEX_SESSIONS_DIR,
//   GROK_SESSIONS_DIR, CLINE_SESSIONS_DIR, CLINE_STATE_DB,
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   CLEANUP_RETAIN_DAYS=7, CLEANUP_DRY_RUN=1, CLEANUP_NOTIFY=0
//   CLEANUP_DELETE_SOURCE=0 / CLEANUP_DELETE_DB=0 / CLEANUP_DELETE_TOPIC=0 (각 단계 끄기)
//   CLEANUP_AUDIT=1 이면 삭제 대상 경로를 한 줄씩 찍는다. CLEANUP_DRY_RUN=1과 함께 쓰면
//   memory/·session_search.sqlite 같은 비세션 자산이 섞이지 않았는지 확인할 수 있다.

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
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
function defaultWikiVaultPath() {
  const configured = process.env.LLM_WIKI_ROOT || process.env.WIKI_VAULT;
  if (configured) return configured;
  const candidates = [
    ...mountedVolumeWikiCandidates(),
    ...cloudStorageWikiCandidates(),
    resolve(REPO_ROOT, "..", "LLM-Wiki"),
    join(homedir(), "LLM-Wiki"),
    join(homedir(), "Documents", "LLM-Wiki"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function mountedVolumeWikiCandidates() {
  const candidates = [];
  try {
    for (const entry of readdirSync("/Volumes", { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const candidate = join("/Volumes", entry.name, "LLM-Wiki");
      if (existsSync(candidate)) candidates.push(candidate);
    }
  } catch {
    /* /Volumes may not exist on non-macOS hosts. */
  }
  return [...new Set(candidates)];
}

function cloudStorageWikiCandidates() {
  const cloudStorage = join(homedir(), "Library", "CloudStorage");
  const candidates = [];
  try {
    for (const entry of readdirSync(cloudStorage, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = join(cloudStorage, entry.name);
      if (/^GoogleDrive(?:[-_ ].*)?$/i.test(entry.name)) {
        candidates.push(...googleDriveWikiCandidates(root));
      } else if (/^SynologyDrive(?:[-_ ].*)?$/i.test(entry.name)) {
        candidates.push(join(root, "AI", "LLM-Wiki"), join(root, "LLM-Wiki"));
      } else {
        candidates.push(join(root, "LLM-Wiki"));
      }
    }
  } catch {
    /* CloudStorage may not exist on non-macOS hosts. */
  }
  return [...new Set(candidates)];
}

function googleDriveWikiCandidates(root) {
  const candidates = [
    join(root, "내 드라이브", "LLM-Wiki"),
    join(root, "My Drive", "LLM-Wiki"),
    join(root, "LLM-Wiki")
  ];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".Trash") continue;
      const child = join(root, entry.name);
      if (entry.name.normalize("NFC") === "내 드라이브" || entry.name === "My Drive") {
        candidates.push(join(child, "LLM-Wiki"), join(child, "AI", "LLM-Wiki"));
      } else {
        candidates.push(join(child, "LLM-Wiki"));
      }
    }
  } catch {
    /* Google Drive may not be mounted or readable. */
  }
  return candidates;
}

const WIKI_VAULT = defaultWikiVaultPath();
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
// grok은 세션당 파일 하나가 아니라 <인코딩된 cwd>/<세션 uuid>/ 디렉터리 한 벌
// (chat_history.jsonl 등)을 쓴다. 정리 단위도 그 디렉터리다.
const GROK_SESSIONS_DIR =
  process.env.GROK_SESSIONS_DIR || join(homedir(), ".grok", "sessions");
// cline도 grok처럼 세션당 디렉터리 한 벌(<id>.json + <id>.messages.json)을 쓴다. 다만
// 세션 id가 uuid만이 아니라 SDK가 만드는 <epoch>_<suffix> 형태도 있어 이름 패턴 대신
// "<id>/<id>.json이 있으면 세션"으로 판별한다. 형제 db/·logs/·settings/는 세션이 아니다.
const CLINE_SESSIONS_DIR =
  process.env.CLINE_SESSIONS_DIR || join(homedir(), ".cline", "data", "sessions");
// cline CLI는 세션 디렉터리와 별개로 자체 레지스트리(sessions 테이블)를 둔다. 디렉터리만
// 지우면 행이 고아로 남으므로 같은 판정으로 함께 지운다. 기본 경로는 세션 디렉터리에서
// 유도해 CLINE_SESSIONS_DIR만 바꿔도 짝이 유지되게 한다.
const CLINE_STATE_DB =
  process.env.CLINE_STATE_DB || join(dirname(CLINE_SESSIONS_DIR), "db", "sessions.db");
const ENV_FILE = join(REPO_ROOT, ".env");

const RETAIN_DAYS = Math.max(1, Number(process.env.CLEANUP_RETAIN_DAYS || 7));
const RETAIN_MS = RETAIN_DAYS * 24 * 60 * 60_000;
const DRY_RUN = process.env.CLEANUP_DRY_RUN === "1";
const NOTIFY = process.env.CLEANUP_NOTIFY !== "0";
const DELETE_SOURCE = process.env.CLEANUP_DELETE_SOURCE !== "0";
const DELETE_DB = process.env.CLEANUP_DELETE_DB !== "0";
const DELETE_TOPIC = process.env.CLEANUP_DELETE_TOPIC !== "0";

const log = (...a) => console.log("[cleanup-old-sessions]", ...a);
const APP_TIME_ZONE = process.env.TZ?.trim()
  || Intl.DateTimeFormat().resolvedOptions().timeZone
  || "UTC";
function localStamp(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: APP_TIME_ZONE,
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

function isSessionEligibleForCleanup(session, cutoff) {
  return session.updated_at <= cutoff && TERMINAL_STATUSES.has(session.status);
}

// ── 오케스트레이터 세션 ─────────────────────────────────────────────────────
function loadSessions(db) {
  return db
    .prepare(
      `SELECT id, provider, title, status, chat_id, topic_id, cwd,
              sdk_session_id, codex_thread_id, agy_conversation_id,
              created_at, updated_at
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

function sourceFileForSession(s) {
  if (s.provider === "claude") return findClaudeFile(s.sdk_session_id, s.cwd);
  if (s.provider === "codex") return findCodexFile(s.codex_thread_id);
  return null;
}

// ── 데스크톱 단독 세션(오케스트레이터 미소유) 파일 열거 ──────────────────────
const CODEX_UUID_RE =
  /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;
const SESSION_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function enumerateDesktopFiles(ownedClaude, ownedCodex) {
  const out = []; // { id, provider, file, mtimeMs }
  // claude는 서브에이전트 전사를 <프로젝트>/<세션 uuid>/ 아래에 둔다. 예전에는 최상위
  // 한 겹만 읽어 그 파일들이 영원히 남았다. 재귀로 훑되 memory/는 건드리지 않는다 —
  // 세션 기록이 아니라 영속 메모리 저장소다.
  if (existsSync(CLAUDE_PROJECTS_DIR)) {
    const stack = [CLAUDE_PROJECTS_DIR];
    while (stack.length) {
      const dirPath = stack.pop();
      let entries;
      try {
        entries = readdirSync(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const p = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "memory") stack.push(p);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const id = entry.name.slice(0, -6);
        // 서브에이전트 파일은 자신의 uuid를 쓰기도 하고 부모 세션 디렉터리 아래
        // 임의 이름을 쓰기도 한다. 둘 중 하나라도 소유 세션이면 보존한다.
        if (ownedClaude.has(id) || ownedClaude.has(basename(dirPath))) continue;
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        out.push({ id, provider: "claude", file: p, mtimeMs: st.mtimeMs });
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
  // grok: <sessions>/<인코딩된 cwd>/<세션 uuid>/ 디렉터리 한 벌이 세션 하나다.
  // sessions 루트의 session_search.sqlite(덤프 봇이 읽는 색인)와 cwd별
  // prompt_history.jsonl은 세션이 아니므로 uuid 디렉터리만 고른다.
  if (existsSync(GROK_SESSIONS_DIR)) {
    for (const cwdEntry of safeReadDir(GROK_SESSIONS_DIR)) {
      if (!cwdEntry.isDirectory()) continue;
      const cwdPath = join(GROK_SESSIONS_DIR, cwdEntry.name);
      for (const sessionEntry of safeReadDir(cwdPath)) {
        if (!sessionEntry.isDirectory()) continue;
        const id = sessionEntry.name;
        if (!SESSION_UUID_RE.test(id)) continue;
        const dir = join(cwdPath, id);
        // 세션 디렉터리 안의 가장 최근 수정 시각을 정착 기준으로 삼는다.
        let mtimeMs = 0;
        for (const file of safeReadDir(dir)) {
          if (!file.isFile()) continue;
          try {
            mtimeMs = Math.max(mtimeMs, statSync(join(dir, file.name)).mtimeMs);
          } catch {
            /* 사라진 파일은 건너뛴다. */
          }
        }
        if (mtimeMs === 0) continue;
        out.push({ id, provider: "grok", file: dir, directory: true, mtimeMs });
      }
    }
  }
  // cline: <sessions>/<세션 id>/ 디렉터리 한 벌이 세션 하나다. 세션 id 형식이 여러 가지라
  // 자기 이름과 같은 <id>.json이 있는 디렉터리만 세션으로 인정한다.
  if (existsSync(CLINE_SESSIONS_DIR)) {
    for (const sessionEntry of safeReadDir(CLINE_SESSIONS_DIR)) {
      if (!sessionEntry.isDirectory()) continue;
      const id = sessionEntry.name;
      const dir = join(CLINE_SESSIONS_DIR, id);
      if (!existsSync(join(dir, `${id}.json`))) continue;
      // grok과 같이 디렉터리 안 가장 최근 수정 시각을 정착 기준으로 삼는다.
      let mtimeMs = 0;
      for (const file of safeReadDir(dir)) {
        if (!file.isFile()) continue;
        try {
          mtimeMs = Math.max(mtimeMs, statSync(join(dir, file.name)).mtimeMs);
        } catch {
          /* 사라진 파일은 건너뛴다. */
        }
      }
      if (mtimeMs === 0) continue;
      out.push({ id, provider: "cline", file: dir, directory: true, mtimeMs });
    }
  }
  return out;
}

// ── cline 레지스트리 정리 ────────────────────────────────────────────────────
// 지운 세션 디렉터리의 행과, 디렉터리가 이미 사라졌는데 남아 있는 고아 행을 함께 지운다.
// 진행 중 세션은 디렉터리 mtime이 최근이라 애초에 후보에 들지 않지만, 고아 행은 mtime을
// 볼 수 없으므로 updated_at으로 한 번 더 거른다.
function pruneClineRegistry(deletedIds, cutoff) {
  const result = { rowsDeleted: 0, queueRowsDeleted: 0 };
  if (!existsSync(CLINE_STATE_DB)) return result;
  const cutoffIso = new Date(cutoff).toISOString();
  let db;
  try {
    // DRY RUN은 세기만 하므로 허브 데몬과 쓰기 락을 다툴 이유가 없다.
    db = new DatabaseSync(CLINE_STATE_DB, { readOnly: DRY_RUN });
  } catch (e) {
    // 허브 데몬이 락을 잡고 있을 수 있다. 다음 실행에서 다시 시도한다.
    log("cline 레지스트리 열기 실패:", e?.message || e);
    return result;
  }
  try {
    const doomed = new Set(deletedIds);
    for (const row of db.prepare("SELECT session_id, updated_at FROM sessions").all()) {
      if (doomed.has(row.session_id)) continue;
      if (existsSync(join(CLINE_SESSIONS_DIR, String(row.session_id)))) continue;
      if (String(row.updated_at || "") > cutoffIso) continue;
      doomed.add(row.session_id);
    }
    if (doomed.size === 0) return result;
    if (DRY_RUN) {
      result.rowsDeleted = doomed.size;
      return result;
    }
    const delSession = db.prepare("DELETE FROM sessions WHERE session_id = ?");
    const delQueue = db.prepare("DELETE FROM subagent_spawn_queue WHERE root_session_id = ?");
    for (const id of doomed) {
      result.rowsDeleted += delSession.run(id).changes;
      result.queueRowsDeleted += delQueue.run(id).changes;
    }
  } catch (e) {
    log("cline 레지스트리 정리 실패:", e?.message || e);
  } finally {
    db.close();
  }
  return result;
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
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

function parseTelegramResponse(response) {
  try {
    const parsed = JSON.parse(response);
    return {
      ok: parsed.ok === true,
      description: String(parsed.description || "알 수 없는 API 오류"),
    };
  } catch {
    return { ok: false, description: "유효하지 않은 Telegram API 응답" };
  }
}

function telegramPost(method, body) {
  const token = readEnvValue("TELEGRAM_BOT_TOKEN");
  if (!token) return false;
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const payload = JSON.stringify(body);
  // fetch는 일부 환경 undici에서 ETIMEDOUT을 내므로 실패 시 curl로 폴백한다(동기 best-effort).
  for (const bin of ["/usr/bin/curl", "curl"]) {
    try {
      const response = execFileSync(
        bin,
        ["-sS", "-m", "15", "-X", "POST", url, "-H", "content-type: application/json", "-d", payload],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      const parsed = parseTelegramResponse(response);
      if (parsed.ok) return true;
      log(`telegram ${method} 거부:`, parsed.description);
      return false;
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

// grok 세션은 파일 하나가 아니라 디렉터리 한 벌이라 recursive 제거가 필요하다.
function removeFile(file, recursiveDirectory = false) {
  if (!file) return false;
  if (isInsideVault(file)) {
    log("거부: 볼트 내부 파일은 삭제하지 않음:", file);
    return false;
  }
  if (DRY_RUN) return true;
  try {
    rmSync(file, { force: true, ...(recursiveDirectory ? { recursive: true } : {}) });
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
  const now = Date.now();
  const cutoff = now - RETAIN_MS;
  const counters = {
    orchSourceDeleted: 0,
    orchRowDeleted: 0,
    topicDeleted: 0,
    skippedTopicFailure: 0,
    desktopDeleted: 0,
    desktopByProvider: {},
    clineRowDeleted: 0,
    clineQueueRowDeleted: 0,
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
      if (!isSessionEligibleForCleanup(s, cutoff)) {
        if (s.updated_at > cutoff) counters.skippedRecent++;
        else counters.skippedActive++;
        continue;
      }
      // 1) 디스크 원본 트랜스크립트
      if (DELETE_SOURCE) {
        const file = sourceFileForSession(s);
        if (file && removeFile(file)) counters.orchSourceDeleted++;
      }
      // 2) 텔레그램 포럼 토픽
      if (DELETE_TOPIC) {
        if (!s.chat_id || !s.topic_id) {
          counters.skippedTopicFailure++;
          continue;
        }
        if (DRY_RUN) {
          counters.topicDeleted++;
        } else if (deleteForumTopic(s.chat_id, s.topic_id)) {
          counters.topicDeleted++;
        } else {
          counters.skippedTopicFailure++;
          continue;
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
    const deletedClineIds = [];
    if (DELETE_SOURCE) {
      for (const f of enumerateDesktopFiles(ownedClaude, ownedCodex)) {
        if (f.mtimeMs > cutoff) {
          counters.skippedRecent++;
          continue;
        }
        if (process.env.CLEANUP_AUDIT === "1") log("AUDIT", f.provider, f.file);
        if (!removeFile(f.file, f.directory === true)) continue;
        counters.desktopDeleted++;
        counters.desktopByProvider[f.provider] =
          (counters.desktopByProvider[f.provider] || 0) + 1;
        if (f.provider === "cline") deletedClineIds.push(f.id);
      }
    }

    // ── Pass C: cline 레지스트리 행(디렉터리 삭제와 짝) ──
    if (DELETE_DB) {
      const pruned = pruneClineRegistry(deletedClineIds, cutoff);
      counters.clineRowDeleted = pruned.rowsDeleted;
      counters.clineQueueRowDeleted = pruned.queueRowsDeleted;
    }
  } finally {
    db.close();
  }

  const summary =
    `정리 대상 ${RETAIN_DAYS}일 경과 종료 세션\n` +
    `· 오케스트레이터: 원본 ${counters.orchSourceDeleted} · DB행 ${counters.orchRowDeleted} · 토픽 ${counters.topicDeleted}\n` +
    `· 데스크톱 원본: ${counters.desktopDeleted}` +
    (counters.desktopDeleted > 0
      ? ` (${Object.entries(counters.desktopByProvider)
          .map(([provider, count]) => `${provider} ${count}`)
          .join(" · ")})`
      : "") +
    "\n" +
    (counters.clineRowDeleted > 0
      ? `· cline 레지스트리: 행 ${counters.clineRowDeleted}` +
        (counters.clineQueueRowDeleted > 0
          ? ` · 서브에이전트 큐 ${counters.clineQueueRowDeleted}`
          : "") +
        "\n"
      : "") +
    `· 보존: 최근 ${counters.skippedRecent} · 진행중 ${counters.skippedActive} · 토픽삭제 실패 ${counters.skippedTopicFailure}` +
    (DRY_RUN ? " [DRY RUN]" : "");
  log(summary.replace(/\n/g, " | "));
  notifyTelegram(`🧹 session-cleanup ${localStamp()}\n${summary}`);
}

export {
  enumerateDesktopFiles,
  isSessionEligibleForCleanup,
  parseTelegramResponse,
  pruneClineRegistry,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
