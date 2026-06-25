#!/usr/bin/env node
// 오케스트레이터 세션 트랜스크립트를 Markdown으로 덤프해 LLM Wiki(10-inbox)의 소스로 공급한다.
//
// 동작 개요
//   orchestrator 세션 DB(data/state.sqlite)를 인덱스로 삼아 각 세션의 provider별 ID로
//   원천 트랜스크립트를 찾아 파싱하고, 사람 대화(user/assistant 텍스트)만 추려 .md 한 벌로 쓴다.
//   직접 20-raw/30-wiki에 쓰지 않는다 — 볼트 규약상 위키화는 /compile의 몫이므로 진입점인
//   10-inbox/에만 떨어뜨린다.
//
//   provider별 원천:
//     claude : ~/.claude/projects/<encoded-cwd>/<sdk_session_id>.jsonl
//     codex  : ~/.codex/sessions/**/rollout-*-<thread_id>.jsonl
//     agy    : ~/.local/share/telegram-claude-orchestrator/agy-conversations/<conv_id>.db (protobuf steps)
//
//   증분/중복 방지:
//     - 종료 상태 세션만 처리한다.
//     - 대화를 user→assistant 묶음(chunk)으로 나눠 SHA-256 지문을 만든다.
//     - 같은 세션의 이미 덤프한 chunk와 다른 세션의 완전 동일 chunk는 다시 쓰지 않는다.
//     - 재개된 세션은 전체 대화가 아니라 새 chunk만 part 파일로 쓴다.
//     - 상태 파일이 사라져도 inbox/raw frontmatter의 chunk 지문과 turn 범위로 복구한다.
//
// 환경변수 오버라이드(기본값은 아래 상수):
//   ORCH_STATE_DB, WIKI_VAULT, CLAUDE_PROJECTS_DIR, CODEX_SESSIONS_DIR, AGY_CONV_DIR
//   RESULT_SEARCH_ROOTS (macOS에서는 :로 구분), RESULT_MERGED_FILE
//   DUMP_FORCE=1  (워터마크 무시하고 전부 재덤프)
//   DUMP_DRY_RUN=1 (파일 쓰지 않고 계획만 출력)

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";

// node 내장 SQLite(node:sqlite)를 쓴다 — better-sqlite3 네이티브 빌드와 달리
// node 버전 ABI에 묶이지 않아 어떤 런타임으로 실행해도 동작한다.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 스케줄(launchd) 실행 시엔 셸 환경이 없어 CODEX_ACCOUNT_HOMES 같은 설정이 비어 있다.
// 오케스트레이터와 같은 프로젝트 .env를 Node 내장 loader로 읽어 채운다(무의존성). 이미 설정된
// 환경변수는 덮어쓰지 않으며, .env가 없으면 기본값으로 진행한다.
try {
  process.loadEnvFile(join(REPO_ROOT, ".env"));
} catch {
  /* .env 없음 — 기본값 유지 */
}

const STATE_DB =
  process.env.ORCH_STATE_DB || join(REPO_ROOT, "data", "state.sqlite");
const WIKI_VAULT =
  process.env.WIKI_VAULT ||
  "/Users/neam/Library/CloudStorage/SynologyDrive-neam/AI/LLM-Wiki";
const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
// Codex는 계정 풀(여러 CODEX_HOME)로 실행될 수 있고, rollout은 그 세션을 실행한 홈의
// sessions/ 아래에만 저장된다. 오케스트레이터와 동일한 CODEX_ACCOUNT_HOMES를 읽어 모든 홈의
// sessions 디렉토리를 스캔 대상으로 삼는다(기본 ~/.codex 또는 CODEX_SESSIONS_DIR override 포함,
// 중복 제거). 한 곳만 보던 과거엔 다계정 rollout이 통째로 "소스누락"으로 잡혔다.
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
  join(
    homedir(),
    ".local",
    "share",
    "telegram-claude-orchestrator",
    "agy-conversations"
  );
const SYNOLOGY_DRIVE_ROOT =
  "/Users/neam/Library/CloudStorage/SynologyDrive-neam";
const RESULT_SEARCH_ROOTS = process.env.RESULT_SEARCH_ROOTS
  ? process.env.RESULT_SEARCH_ROOTS.split(delimiter).filter(Boolean).map(resolve)
  : [homedir(), SYNOLOGY_DRIVE_ROOT];

const INBOX_DIR = join(WIKI_VAULT, "10-inbox");
const RAW_DIR = join(WIKI_VAULT, "20-raw");
const STATE_FILE = join(WIKI_VAULT, "_meta", ".transcript-dump-state.json");
const RESULT_MERGED_FILE =
  process.env.RESULT_MERGED_FILE ||
  join(INBOX_DIR, "global-project-results.md");
const FORCE = process.env.DUMP_FORCE === "1";
const DRY_RUN = process.env.DUMP_DRY_RUN === "1";
// 오케스트레이터를 거치지 않은 데스크톱 단독 세션(Claude Code / Codex)도 덤프한다.
// DUMP_INCLUDE_DESKTOP=0 으로 끌 수 있다(기본 켜짐).
const INCLUDE_DESKTOP = process.env.DUMP_INCLUDE_DESKTOP !== "0";
// 진행 중 세션을 중간에 덤프하지 않도록, 파일이 이만큼 조용해진(정착된) 세션만 처리한다.
const DESKTOP_SETTLE_MS =
  Math.max(0, Number(process.env.DUMP_DESKTOP_SETTLE_MINUTES || 30)) * 60_000;
// 실행 요약 텔레그램 통지(.env의 TELEGRAM_BOT_TOKEN/CHAT_ID). DUMP_NOTIFY=0 으로 끈다.
const NOTIFY = process.env.DUMP_NOTIFY !== "0";
const ENV_FILE = join(REPO_ROOT, ".env");

const log = (...a) => console.log("[dump-transcripts]", ...a);
const TERMINAL_STATUSES = new Set([
  "done",
  "verification_failed",
  "aborted",
  "error",
  "interrupted",
]);

// ── orchestrator 세션 DB 읽기 ──────────────────────────────────────────────
function loadSessions() {
  const db = new DatabaseSync(STATE_DB, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT id, provider, project_name, title, status, cwd,
                sdk_session_id, codex_thread_id, agy_conversation_id,
                model, codex_model, agy_model,
                created_at, updated_at
         FROM sessions
         ORDER BY updated_at ASC`
      )
      .all();
  } finally {
    db.close();
  }
}

// ── 증분 워터마크 ───────────────────────────────────────────────────────────
function loadWatermark() {
  if (FORCE || !existsSync(STATE_FILE)) {
    return { version: 2, sessions: {}, emittedChunkHashes: {}, emittedResultHashes: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return {
      version: 2,
      sessions: parsed.sessions || {},
      emittedChunkHashes: parsed.emittedChunkHashes || {},
      emittedResultHashes: parsed.emittedResultHashes || [],
    };
  } catch {
    return { version: 2, sessions: {}, emittedChunkHashes: {}, emittedResultHashes: [] };
  }
}

function saveWatermark(state) {
  if (DRY_RUN) return;
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        version: 2,
        updatedAt: new Date().toISOString(),
        sessions: state.sessions,
        emittedChunkHashes: state.emittedChunkHashes,
        emittedResultHashes: state.emittedResultHashes || [],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

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
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

function scanExistingTranscriptSources(directories = [INBOX_DIR, RAW_DIR]) {
  const sessions = {};
  const emittedChunkHashes = {};
  for (const dir of directories) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = join(dir, entry.name);
      const fm = readFrontmatter(file);
      if (!fm?.session_id) continue;
      const sessionId = fm.session_id;
      const turnEnd = Number(fm.turn_end || fm.turns || 0);
      const part = Number(fm.part || (entry.name.match(/-part-(\d+)\.md$/)?.[1] ?? 1));
      const current = sessions[sessionId] || { maxTurnEnd: 0, maxPart: 0 };
      current.maxTurnEnd = Math.max(current.maxTurnEnd, Number.isFinite(turnEnd) ? turnEnd : 0);
      current.maxPart = Math.max(current.maxPart, Number.isFinite(part) ? part : 1);
      sessions[sessionId] = current;

      if (fm.chunk_hashes_json) {
        try {
          const hashes = JSON.parse(fm.chunk_hashes_json);
          if (Array.isArray(hashes)) {
            for (const hash of hashes) emittedChunkHashes[hash] = sessionId;
          }
        } catch {
          // 오래되거나 수동 편집된 frontmatter는 turn 범위 복구만 사용한다.
        }
      }
    }
  }
  return { sessions, emittedChunkHashes };
}

// ── claude: encoded-cwd 디렉터리에서 <sdk_session_id>.jsonl 찾기 ─────────────
function encodeClaudeCwd(cwd) {
  // Claude Code는 cwd의 비영숫자(/ . _ 공백 등)를 '-'로 치환한 폴더명을 쓴다.
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function findClaudeFile(session) {
  if (!session.sdk_session_id) return null;
  const enc = encodeClaudeCwd(session.cwd);
  const direct = join(CLAUDE_PROJECTS_DIR, enc, `${session.sdk_session_id}.jsonl`);
  if (existsSync(direct)) return direct;
  // 치환 규칙이 어긋날 경우를 대비해 전 디렉터리에서 파일명으로 폴백 탐색.
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;
  for (const d of readdirSync(CLAUDE_PROJECTS_DIR)) {
    const p = join(CLAUDE_PROJECTS_DIR, d, `${session.sdk_session_id}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

function parseClaude(file) {
  const turns = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "user" && o.type !== "assistant") continue;
    const role = o.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractClaudeText(o.message.content);
    if (text) turns.push({ role, text, ts: o.timestamp });
  }
  return turns;
}

function extractClaudeText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  // tool_use / tool_result는 위키 소스로서 노이즈 — 사람 대화 텍스트만.
  const parts = content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text.trim())
    .filter(Boolean);
  return parts.join("\n\n");
}

// ── codex: rollout-*-<thread_id>.jsonl 찾기 ─────────────────────────────────
function findCodexFile(session) {
  if (!session.codex_thread_id) return null;
  const id = session.codex_thread_id;
  let found = null;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (found) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(`${id}.jsonl`)) found = p;
    }
  };
  // 모든 Codex 계정 홈의 sessions/를 순회한다. 어느 홈에서 실행됐는지 DB에 별도 기록이 없으므로
  // 전 홈을 훑되, 찾는 즉시 멈춘다.
  for (const root of CODEX_SESSIONS_DIRS) {
    if (found) break;
    if (!existsSync(root)) continue;
    walk(root);
  }
  return found;
}

function parseCodex(file) {
  const turns = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "response_item") continue;
    const p = o.payload;
    if (p?.type !== "message") continue;
    // developer/system 메시지(주입 프롬프트)는 제외.
    if (p.role !== "user" && p.role !== "assistant") continue;
    let text = extractCodexText(p.content);
    if (p.role === "user") text = stripCodexPreamble(text);
    if (!text) continue;
    turns.push({ role: p.role, text, ts: o.timestamp });
  }
  return turns;
}

function extractCodexText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c) =>
        (c.type === "input_text" || c.type === "output_text" || c.type === "text") &&
        typeof c.text === "string"
    )
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

// codex는 claude와 달리 시스템 프롬프트를 user 메시지에 prepend해 보낸다:
//   - 첫 user 턴 = "# AGENTS.md instructions ..." (CLAUDE.md/AGENTS.md 통째) → 발화 없음, 통째 제거
//   - 실제 발화 user 턴 = [환경 프리앰블(현재 시각/메모리/LEAN/권한/Obsidian 등)] + 진짜 발화
//     orchestrator가 매 턴 prepend하므로, 프리앰블 끝 마커 뒤의 실제 발화만 살린다.
//
// 프리앰블은 전역 CLAUDE.md 마지막 줄로 끝난다(.result.md 안내). 이 마커 뒤를 발화로 본다.
const CODEX_PREAMBLE_END_MARKERS = [
  "summarizing the request, suggestion, decision, approval/rejection, and result.",
  ".result.md file within each project folder",
];

// 발화가 전혀 없는 순수 주입 턴(첫 AGENTS.md 턴 등)을 식별하는 시작 마커.
const CODEX_PURE_INJECTION_PREFIXES = [
  "# AGENTS.md instructions",
  "<user_instructions>",
  "<environment_context>",
];

function stripCodexPreamble(text) {
  if (!text) return "";
  // 발화 없는 순수 주입 턴은 통째 버린다.
  if (CODEX_PURE_INJECTION_PREFIXES.some((p) => text.startsWith(p))) {
    // 단, AGENTS.md 본문 뒤에도 발화가 붙을 수 있으니 끝마커 뒤가 있으면 그것을 취한다.
    const tail = afterLastPreambleMarker(text);
    return tail !== null ? tail : "";
  }
  const tail = afterLastPreambleMarker(text);
  return tail !== null ? tail : text;
}

function afterLastPreambleMarker(text) {
  let best = -1;
  for (const m of CODEX_PREAMBLE_END_MARKERS) {
    const idx = text.lastIndexOf(m);
    if (idx >= 0) best = Math.max(best, idx + m.length);
  }
  if (best < 0) return null;
  let tail = text.slice(best).trim();
  // 프리앰블을 감싼 닫는 태그(</INSTRUCTIONS> 등) 잔재 제거.
  tail = tail.replace(/^<\/[A-Za-z_][\w-]*>\s*/g, "").trim();
  // 한 user 메시지에 주입 블록이 여러 개 중첩될 수 있다(AGENTS.md + environment_context 등).
  // 끝마커 뒤 잔여가 또 다른 주입 블록으로 시작하면 실제 발화가 없는 것 → 버린다.
  const stillInjected =
    /^<\/?[A-Za-z_][\w-]*>/.test(tail) || // <environment_context> 등 태그로 시작
    CODEX_PURE_INJECTION_PREFIXES.some((p) => tail.startsWith(p));
  if (stillInjected) return "";
  return tail;
}

// ── agy: protobuf steps 에서 user/assistant 텍스트 추출 ─────────────────────
function findAgyFile(session) {
  if (!session.agy_conversation_id) return null;
  const p = join(AGY_CONV_DIR, `${session.agy_conversation_id}.db`);
  return existsSync(p) ? p : null;
}

function parseAgy(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const turns = [];
  try {
    const rows = db
      .prepare(
        "SELECT idx, step_type, step_payload FROM steps ORDER BY idx ASC"
      )
      .all();
    for (const r of rows) {
      if (!r.step_payload) continue;
      // 관측상 step_type 14=user, 15=assistant. 그 외 타입(도구/메타)은 건너뛴다.
      const role =
        r.step_type === 14 ? "user" : r.step_type === 15 ? "assistant" : null;
      if (!role) continue;
      const text = extractAgyText(Buffer.from(r.step_payload));
      if (text) turns.push({ role, text });
    }
  } finally {
    db.close();
  }
  return turns;
}

// agy step_payload(protobuf)에서 메시지 본문을 추출한다.
//
// 관측된 구조: 본문은 중첩 메시지 안의 leaf string 필드에 들어 있고, 같은 step에
// conversation_id(32 hex), 토큰형 id(공백 없는 base64형 장문), 본문 중복본이 섞인다.
// 따라서 leaf string만 모두 모은 뒤, 잡음을 걸러 "자연어 본문"을 택한다.
function extractAgyText(buf) {
  const leaves = collectProtoLeafStrings(buf)
    .map((s) => s.replace(/[ --]/g, "").trim())
    .filter((s) => s.length >= 1)
    .filter((s) => !/^[0-9a-f]{32}$/i.test(s)) // conversation id
    .filter((s) => !(/^[A-Za-z0-9_+/=-]{16,}$/.test(s) && !/\s/.test(s))); // 토큰형 id
  if (!leaves.length) return "";
  // 동일 본문이 중복 저장되므로 dedup. 본문 후보는 가장 긴 고유 문자열을 택한다
  // (SAVED 같은 짧은 답변도 토큰을 걸러낸 뒤엔 최장 후보가 된다).
  const uniq = [...new Set(leaves)];
  uniq.sort((a, b) => b.length - a.length);
  return uniq[0];
}

// protobuf를 재귀로 워크하며 leaf(더 파싱되지 않는) UTF-8 문자열만 수집한다.
// length-delimited 필드는 우선 중첩 메시지로 재귀 파싱을 시도하고, 유효한 하위
// 필드가 나오면 그 leaf들을 쓰고, 아니면 자신을 leaf 문자열로 간주한다.
function collectProtoLeafStrings(buf) {
  const out = [];
  let i = 0;
  const readVarint = () => {
    let shift = 0;
    let result = 0;
    while (i < buf.length) {
      const b = buf[i++];
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) return null;
    }
    return result;
  };
  while (i < buf.length) {
    const key = readVarint();
    if (key === null) break;
    const wire = key & 0x7;
    if (wire === 2) {
      const len = readVarint();
      if (len === null || i + len > buf.length) break;
      const slice = buf.subarray(i, i + len);
      i += len;
      const nested = tryParseNested(slice);
      if (nested && nested.length) {
        for (const inner of nested) out.push(inner);
      } else {
        const s = decodeUtf8(slice);
        if (s !== null && isReadable(s)) out.push(s);
      }
    } else if (wire === 0) {
      if (readVarint() === null) break;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      break;
    }
  }
  return out;
}

// slice가 유효한 protobuf 중첩 메시지로 완전히 소비되면 그 leaf 문자열을 반환,
// 아니면 null(=이 slice 자체가 leaf 데이터).
function tryParseNested(slice) {
  if (slice.length < 2) return null;
  let i = 0;
  const out = [];
  const readVarint = () => {
    let shift = 0;
    let result = 0;
    while (i < slice.length) {
      const b = slice[i++];
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) return null;
    }
    return result;
  };
  while (i < slice.length) {
    const key = readVarint();
    if (key === null) return null;
    const wire = key & 0x7;
    const field = key >>> 3;
    if (field === 0) return null;
    if (wire === 2) {
      const len = readVarint();
      if (len === null || i + len > slice.length) return null;
      const sub = slice.subarray(i, i + len);
      i += len;
      const nested = tryParseNested(sub);
      if (nested && nested.length) for (const x of nested) out.push(x);
      else {
        const s = decodeUtf8(sub);
        if (s !== null && isReadable(s)) out.push(s);
      }
    } else if (wire === 0) {
      if (readVarint() === null) return null;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      return null;
    }
  }
  return i === slice.length ? out : null;
}

function decodeUtf8(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

function isReadable(s) {
  if (!s) return false;
  // 제어문자(개행/탭 제외) 비율이 높으면 바이너리로 간주.
  let ctrl = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x20 && c !== 0x0a && c !== 0x09 && c !== 0x0d) ctrl++;
  }
  return ctrl / s.length < 0.15;
}

// ── 대화 chunk 및 지문 ─────────────────────────────────────────────────────
function normalizeFingerprintText(text) {
  return String(text)
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fingerprintTurns(turns) {
  const canonical = turns
    .map((turn) => `${turn.role}\u0000${normalizeFingerprintText(turn.text)}`)
    .join("\u0001");
  return createHash("sha256").update(canonical).digest("hex");
}

function fingerprintResultEntry(text) {
  return fingerprintTurns([{ role: "assistant", text }]);
}

function chunkTurns(turns) {
  const chunks = [];
  let current = [];
  let start = 1;

  const flush = (end) => {
    if (!current.length) return;
    chunks.push({
      turns: current,
      start,
      end,
      hash: fingerprintTurns(current),
    });
    current = [];
  };

  turns.forEach((turn, index) => {
    const position = index + 1;
    if (turn.role === "user" && current.length) {
      flush(position - 1);
      start = position;
    } else if (!current.length) {
      start = position;
    }
    current.push(turn);
  });
  flush(turns.length);
  return chunks;
}

// ── Markdown 생성 ───────────────────────────────────────────────────────────
function yamlEscape(s) {
  return String(s ?? "").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function pickModel(session) {
  if (session.provider === "codex") return session.codex_model || "";
  if (session.provider === "agy") return session.agy_model || "";
  return session.model || "";
}

function shortTitle(title) {
  // "프로젝트 - 첫 메시지" 패턴에서 첫 메시지 부분만 살려 60자 제한.
  const t = String(title || "untitled");
  const dash = t.indexOf(" - ");
  const body = dash >= 0 ? t.slice(dash + 3) : t;
  return body.replace(/\s+/g, " ").trim().slice(0, 60) || "untitled";
}

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "session"
  );
}

function buildMarkdown(session, chunks, part) {
  const turns = chunks.flatMap((chunk) => chunk.turns);
  const date = isoDate(session.created_at);
  const model = pickModel(session);
  const titleBody = shortTitle(session.title);
  const turnStart = chunks[0].start;
  const turnEnd = chunks[chunks.length - 1].end;
  const chunkHashes = chunks.map((chunk) => chunk.hash);
  const contentHash = createHash("sha256")
    .update(chunkHashes.join("\n"))
    .digest("hex");
  const summary =
    `${session.provider} 세션 트랜스크립트 (${session.project_name}). ` +
    `키워드: ${session.provider} ${session.project_name} ${titleBody}`.slice(0, 200);

  const fm = [
    "---",
    "type: source",
    `title: "${yamlEscape(titleBody)}"`,
    "source_file: 20-raw/",
    `topic: "${yamlEscape(session.project_name)}"`,
    `summary: "${yamlEscape(summary)}"`,
    `ingested: ${isoDate(Date.now())}`,
    `author: "${session.provider}"`,
    'url: ""',
    `tags: [transcript, ${session.provider}, ${slugify(session.project_name)}]`,
    "provenance: extracted",
    `provider: ${session.provider}`,
    `model: "${yamlEscape(model)}"`,
    `session_id: ${session.id}`,
    `source_key: "transcript:${session.id}"`,
    `part: ${part}`,
    `turn_start: ${turnStart}`,
    `turn_end: ${turnEnd}`,
    `content_sha256: ${contentHash}`,
    `chunk_hashes_json: '${JSON.stringify(chunkHashes)}'`,
    `session_date: ${date}`,
    `turns: ${turns.length}`,
    "---",
    "",
  ].join("\n");

  const head = [
    `# ${titleBody}`,
    "",
    `**TL;DR:** ${session.provider}(${model || "기본 모델"}) · 프로젝트 \`${session.project_name}\` · ${date} · ${turns.length} turns. 텔레그램 오케스트레이터로 진행한 에이전트 대화 기록.`,
    "",
    "## Conversation",
    "",
  ].join("\n");

  const body = turns
    .map((t) => {
      const who = t.role === "user" ? "👤 User" : "🤖 Assistant";
      return `### ${who}\n\n${t.text}\n`;
    })
    .join("\n");

  return fm + head + body;
}

// ── 전역 .result.md 병합 ──────────────────────────────────────────────────
function collectResultFiles(roots = RESULT_SEARCH_ROOTS) {
  const normalizedRoots = [...new Set(roots.map((root) => resolve(root)))];
  const rootSet = new Set(normalizedRoots);
  const found = new Set();

  const walk = (directory, activeRoot) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === ".result.md") {
        found.add(resolve(path));
        continue;
      }
      if (!entry.isDirectory()) continue;
      const resolvedPath = resolve(path);
      // 홈 아래의 Synology Drive처럼 별도 루트로 지정된 하위 트리는 해당 루트
      // 차례에 한 번만 순회한다.
      if (resolvedPath !== activeRoot && rootSet.has(resolvedPath)) continue;
      walk(resolvedPath, activeRoot);
    }
  };

  for (const root of normalizedRoots) {
    if (existsSync(root)) walk(root, root);
  }
  return [...found].sort();
}

function parseResultEntries(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*+]\s+/, "").trim())
    .filter(Boolean);
}

function collectMergedResultEntries(
  roots = RESULT_SEARCH_ROOTS,
  files = collectResultFiles(roots)
) {
  const normalizedRoots = [...new Set(roots.map((root) => resolve(root)))];
  const seen = new Set();
  const sources = [];

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const entries = [];
    for (const rawEntry of parseResultEntries(text)) {
      const normalized = normalizeFingerprintText(rawEntry);
      if (!normalized) continue;
      const hash = fingerprintResultEntry(normalized);
      if (seen.has(hash)) continue;
      seen.add(hash);
      entries.push({ text: rawEntry, hash });
    }
    if (!entries.length) continue;

    const projectDirectory = dirname(file);
    const containingRoot =
      normalizedRoots
        .filter(
          (root) =>
            projectDirectory === root ||
            projectDirectory.startsWith(`${root}${sep}`)
        )
        .sort((a, b) => b.length - a.length)[0] || homedir();
    sources.push({
      file,
      projectDirectory,
      relativePath: relative(containingRoot, projectDirectory) || ".",
      root: containingRoot,
      entries,
    });
  }
  return { sources, hashes: [...seen] };
}

function buildMergedResultsMarkdown(
  merged,
  generatedAt = new Date()
) {
  const allEntries = merged.sources.flatMap((source) => source.entries);
  const contentHash = createHash("sha256")
    .update(merged.hashes.join("\n"))
    .digest("hex");
  const frontmatter = [
    "---",
    "type: source",
    'title: "Global project result log"',
    "source_file: 20-raw/",
    'topic: "project results"',
    'summary: "로컬 홈과 Synology Drive의 .result.md 기록을 하나로 병합하고 정규화 지문으로 중복 제거한 전역 작업 결과 로그."',
    `ingested: ${generatedAt.toISOString().slice(0, 10)}`,
    'author: "local agents"',
    'url: ""',
    "tags: [result-log, local, synology-drive]",
    "provenance: extracted",
    'source_key: "result-files:global"',
    `content_sha256: ${contentHash}`,
    `entry_hashes_json: '${JSON.stringify(merged.hashes)}'`,
    `source_files: ${merged.sources.length}`,
    `entries: ${allEntries.length}`,
    "---",
    "",
  ].join("\n");

  const body = merged.sources
    .map((source) => {
      const lines = [
        `## ${source.relativePath}`,
        "",
        `Source: \`${source.file}\``,
        "",
        ...source.entries.map((entry) => `- ${entry.text}`),
        "",
      ];
      return lines.join("\n");
    })
    .join("\n");

  return (
    frontmatter +
    "# Global project result log\n\n" +
    `로컬 홈과 Synology Drive에서 수집한 ${allEntries.length}개의 고유 작업 결과입니다.\n\n` +
    body
  );
}

// 결과 로그 병합본도 트랜스크립트와 동일한 증분 방식으로 떨군다.
// 이미 inbox/raw로 나간 항목(frontmatter entry_hashes_json) + 상태파일에 누적된
// 지문을 제외하고 신규 항목만 델타 파일로 쓴다. 신규가 없으면 쓰지 않는다.
// raw 파일명 충돌을 피하려 타임스탬프 파일명을 쓰되 source_key는 고정이라
// 컴파일이 같은 논리 소스의 증분으로 처리한다.
function scanEmittedResultHashes(directories = [INBOX_DIR, RAW_DIR]) {
  const hashes = new Set();
  for (const dir of directories) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const fm = readFrontmatter(join(dir, entry.name));
      if (!fm?.entry_hashes_json) continue;
      try {
        const arr = JSON.parse(fm.entry_hashes_json);
        if (Array.isArray(arr)) for (const h of arr) hashes.add(h);
      } catch {
        // 손상되거나 수동 편집된 frontmatter는 건너뛴다.
      }
    }
  }
  return hashes;
}

function dumpMergedResults(state) {
  const files = collectResultFiles();
  const merged = collectMergedResultEntries(RESULT_SEARCH_ROOTS, files);

  const emitted = new Set(state?.emittedResultHashes || []);
  for (const h of scanEmittedResultHashes()) emitted.add(h);

  // 이미 나간 항목을 제외하고 신규 항목만 남긴다(소스별로 비면 통째로 제외).
  const newSources = [];
  const newHashes = [];
  for (const source of merged.sources) {
    const entries = source.entries.filter((e) => !emitted.has(e.hash));
    if (!entries.length) continue;
    for (const e of entries) newHashes.push(e.hash);
    newSources.push({ ...source, entries });
  }

  if (!newHashes.length) {
    log(`result merge — 신규 항목 없음, 건너뜀 (files=${files.length})`);
    return;
  }

  const delta = { sources: newSources, hashes: newHashes };
  const markdown = buildMergedResultsMarkdown(delta);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const dest = join(
    dirname(RESULT_MERGED_FILE),
    `global-project-results-${stamp}.md`
  );

  if (DRY_RUN) {
    log(
      `would write ${dest} ` +
        `(${files.length} result files, ${newHashes.length} new entries)`
    );
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, markdown, "utf8");
  if (state) state.emittedResultHashes = [...emitted, ...newHashes];
  log(
    `result merge — files=${files.length} new-entries=${newHashes.length} dest=${dest}`
  );
}

// ── 데스크톱 단독 세션(오케스트레이터 미경유) 열거 ──────────────────────────
// 오케스트레이터 state.sqlite에 없는 Claude Code / Codex 세션을 디스크에서 직접
// 찾아 합성 세션 레코드로 만든다. 이미 오케스트레이터가 가진 ID는 제외하고,
// mtime이 DESKTOP_SETTLE_MS 이상 지난(=진행 종료로 간주) 파일만 처리한다.
const CODEX_UUID_RE =
  /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

function scanClaudeMeta(file) {
  let cwd = "";
  let model = "";
  let firstUser = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
    if (!model && o.type === "assistant" && o.message?.model) model = o.message.model;
    if (!firstUser && o.type === "user" && o.message?.role === "user") {
      const t = extractClaudeText(o.message.content);
      if (t) firstUser = t;
    }
    if (cwd && model && firstUser) break;
  }
  return { cwd, model, firstUser };
}

function scanCodexMeta(file) {
  let cwd = "";
  let model = "";
  let firstUser = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o.payload;
    if (!cwd) {
      const c = p?.cwd || o.cwd || p?.turn_context?.cwd;
      if (typeof c === "string") cwd = c;
    }
    if (!model) {
      const m = p?.model || o.model;
      if (typeof m === "string") model = m;
    }
    if (
      !firstUser &&
      o.type === "response_item" &&
      p?.type === "message" &&
      p.role === "user"
    ) {
      const t = stripCodexPreamble(extractCodexText(p.content));
      if (t) firstUser = t;
    }
    if (cwd && model && firstUser) break;
  }
  return { cwd, model, firstUser };
}

function makeDesktopRecord({ provider, id, cwd, st, model, firstUser }) {
  const projectName = cwd
    ? cwd.split(sep).filter(Boolean).pop() || `${provider}-desktop`
    : `${provider}-desktop`;
  const title =
    (firstUser || projectName).replace(/\s+/g, " ").trim().slice(0, 80) ||
    projectName;
  const created =
    Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0
      ? st.birthtimeMs
      : st.mtimeMs;
  return {
    id,
    provider,
    project_name: projectName,
    title,
    status: "done", // 정착된 파일만 들어오므로 종료로 간주
    cwd: cwd || "",
    sdk_session_id: provider === "claude" ? id : null,
    codex_thread_id: provider === "codex" ? id : null,
    agy_conversation_id: null,
    model: provider === "claude" ? model || "" : "",
    codex_model: provider === "codex" ? model || "" : "",
    agy_model: "",
    created_at: Math.round(created),
    updated_at: Math.round(st.mtimeMs),
    desktop: true,
  };
}

function enumerateDesktopSessions(orchestratorSessions) {
  if (!INCLUDE_DESKTOP) return [];
  const claudeOwned = new Set(
    orchestratorSessions.map((s) => s.sdk_session_id).filter(Boolean)
  );
  const codexOwned = new Set(
    orchestratorSessions.map((s) => s.codex_thread_id).filter(Boolean)
  );
  const now = Date.now();
  const out = [];

  // claude: ~/.claude/projects/<encoded-cwd>/<sdk_session_id>.jsonl
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
        if (claudeOwned.has(id)) continue;
        const file = join(dirPath, name);
        let st;
        try {
          st = statSync(file);
        } catch {
          continue;
        }
        if (now - st.mtimeMs < DESKTOP_SETTLE_MS) continue;
        let meta;
        try {
          meta = scanClaudeMeta(file);
        } catch {
          continue;
        }
        if (!meta.cwd && !meta.firstUser) continue;
        out.push(
          makeDesktopRecord({ provider: "claude", id, cwd: meta.cwd, st, ...meta })
        );
      }
    }
  }

  // codex: 모든 계정 홈의 sessions/**/rollout-*-<thread_id>.jsonl
  const codexRoots = CODEX_SESSIONS_DIRS.filter((root) => existsSync(root));
  if (codexRoots.length) {
    const stack = [...codexRoots];
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
        if (codexOwned.has(id)) continue;
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (now - st.mtimeMs < DESKTOP_SETTLE_MS) continue;
        let meta;
        try {
          meta = scanCodexMeta(p);
        } catch {
          continue;
        }
        if (!meta.cwd && !meta.firstUser) continue;
        out.push(
          makeDesktopRecord({ provider: "codex", id, cwd: meta.cwd, st, ...meta })
        );
      }
    }
  }
  return out;
}

// ── 텔레그램 통지 ────────────────────────────────────────────────────────────
function readEnvValue(key) {
  try {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // .env 없으면 프로세스 환경으로 폴백
  }
  return process.env[key] || "";
}

async function notifyTelegram(text) {
  if (!NOTIFY || DRY_RUN) return;
  const token = readEnvValue("TELEGRAM_BOT_TOKEN");
  const chatId = readEnvValue("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    log("telegram 통지 건너뜀: 토큰/chat_id 없음");
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = JSON.stringify({ chat_id: Number(chatId), text });
  // 1차: fetch. 일부 실행 환경의 undici가 ETIMEDOUT을 내므로 실패 시 curl로 폴백한다.
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    if (res.ok) return;
    log(`telegram fetch HTTP ${res.status} — curl 폴백`);
  } catch (e) {
    log(`telegram fetch 실패(${e?.cause?.code || e?.message || e}) — curl 폴백`);
  }
  // 2차: curl(시스템 경로). macOS 기본 /usr/bin/curl, 없으면 PATH의 curl.
  for (const bin of ["/usr/bin/curl", "curl"]) {
    try {
      execFileSync(
        bin,
        [
          "-sS",
          "-m",
          "15",
          "-X",
          "POST",
          url,
          "-H",
          "content-type: application/json",
          "-d",
          payload,
        ],
        { stdio: "ignore" }
      );
      return;
    } catch (e) {
      if (bin === "curl") log("telegram 통지 실패(curl):", e?.message || e);
    }
  }
}

// ── provider 디스패치 ───────────────────────────────────────────────────────
function findAndParse(session) {
  try {
    if (session.provider === "claude") {
      const f = findClaudeFile(session);
      return f ? { file: f, turns: parseClaude(f) } : null;
    }
    if (session.provider === "codex") {
      const f = findCodexFile(session);
      return f ? { file: f, turns: parseCodex(f) } : null;
    }
    if (session.provider === "agy") {
      const f = findAgyFile(session);
      return f ? { file: f, turns: parseAgy(f) } : null;
    }
  } catch (e) {
    log(`parse error (${session.provider} ${session.id}):`, e.message);
  }
  return null;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const state = loadWatermark();
  dumpMergedResults(state);
  if (!existsSync(STATE_DB)) {
    log("orchestrator DB 없음:", STATE_DB);
    process.exit(1);
  }
  const sessions = loadSessions();
  const desktopSessions = enumerateDesktopSessions(sessions);
  const allSessions = sessions.concat(desktopSessions);
  const existing = scanExistingTranscriptSources();
  for (const [hash, owner] of Object.entries(existing.emittedChunkHashes)) {
    state.emittedChunkHashes[hash] ||= owner;
  }

  let written = 0;
  let desktopWritten = 0;
  let skipped = 0;
  let missing = 0;
  let deferred = 0;
  let duplicateChunks = 0;

  if (!DRY_RUN) mkdirSync(INBOX_DIR, { recursive: true });

  for (const s of allSessions) {
    if (!TERMINAL_STATUSES.has(s.status)) {
      deferred++;
      continue;
    }

    const previous = state.sessions[s.id];
    const previousUpdatedAt =
      typeof previous === "number" ? previous : Number(previous?.updatedAt || 0);
    // v1의 숫자 워터마크는 기존 source의 turn 범위와 대조해 v2 chunk 상태로
    // 한 번 마이그레이션해야 하므로, 시각이 같아도 파싱을 수행한다.
    if (!FORCE && typeof previous === "object" && previousUpdatedAt >= s.updated_at) {
      skipped++;
      continue;
    }
    const parsed = findAndParse(s);
    if (!parsed) {
      missing++;
      continue;
    }
    if (!parsed.turns.length) {
      state.sessions[s.id] = {
        updatedAt: s.updated_at,
        emittedChunkHashes:
          typeof previous === "object" ? previous.emittedChunkHashes || [] : [],
        nextPart:
          typeof previous === "object"
            ? previous.nextPart || 1
            : (existing.sessions[s.id]?.maxPart || 0) + 1,
      };
      skipped++;
      continue;
    }

    const chunks = chunkTurns(parsed.turns);
    const recoveredTurnEnd = existing.sessions[s.id]?.maxTurnEnd || 0;
    const emittedForSession = new Set(
      typeof previous === "object" ? previous.emittedChunkHashes || [] : []
    );

    // v1 워터마크 또는 상태 파일 유실 시 기존 source의 turn 범위까지 복구한다.
    for (const chunk of chunks) {
      if (chunk.end <= recoveredTurnEnd) {
        emittedForSession.add(chunk.hash);
        state.emittedChunkHashes[chunk.hash] ||= s.id;
      }
    }

    const novel = [];
    for (const chunk of chunks) {
      if (emittedForSession.has(chunk.hash)) continue;
      const owner = state.emittedChunkHashes[chunk.hash];
      if (owner && owner !== s.id) {
        duplicateChunks++;
        emittedForSession.add(chunk.hash);
        continue;
      }
      novel.push(chunk);
    }

    const nextPart =
      typeof previous === "object"
        ? previous.nextPart || 1
        : (existing.sessions[s.id]?.maxPart || 0) + 1;

    if (!novel.length) {
      state.sessions[s.id] = {
        updatedAt: s.updated_at,
        emittedChunkHashes: [...emittedForSession],
        nextPart,
      };
      skipped++;
      continue;
    }

    const md = buildMarkdown(s, novel, nextPart);
    const base = `${isoDate(s.created_at)}-${s.provider}-${slugify(
      shortTitle(s.title)
    )}-${s.id.slice(0, 8)}`;
    const fname = `${base}${nextPart > 1 ? `-part-${String(nextPart).padStart(3, "0")}` : ""}.md`;
    const dest = join(INBOX_DIR, fname);
    if (DRY_RUN) {
      log(`would write ${fname} (${novel.length} chunks, ${novel.flatMap((c) => c.turns).length} turns)`);
    } else {
      writeFileSync(dest, md, "utf8");
    }
    for (const chunk of novel) {
      emittedForSession.add(chunk.hash);
      state.emittedChunkHashes[chunk.hash] = s.id;
    }
    state.sessions[s.id] = {
      updatedAt: s.updated_at,
      emittedChunkHashes: [...emittedForSession],
      nextPart: nextPart + 1,
    };
    written++;
    if (s.desktop) desktopWritten++;
  }

  saveWatermark(state);
  const summaryLine =
    `done — written=${written} (desktop=${desktopWritten}) skipped=${skipped} ` +
    `deferred=${deferred} duplicate-chunks=${duplicateChunks} ` +
    `source-missing=${missing} total=${allSessions.length}` +
    (DRY_RUN ? " [DRY RUN]" : "");
  log(summaryLine);

  // 덤프가 inbox/결과 로그를 갱신한 직후 같은 실행에서 강점 사전을 재집계한다.
  // 집계 실패는 덤프 결과를 가리지 않도록 격리한다(파이프라인 본체는 덤프).
  await refreshAgentStrengths();

  // 실행 요약을 텔레그램으로 best-effort 통지(실패해도 덤프 결과엔 영향 없음).
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const flag = missing > 0 ? "⚠️" : "✅";
  await notifyTelegram(
    `${flag} transcript-dump ${stamp}\n` +
      `· 새 소스: ${written}건 (데스크톱 ${desktopWritten})\n` +
      `· 건너뜀: ${skipped} · 보류: ${deferred} · 중복청크: ${duplicateChunks}\n` +
      `· 소스누락: ${missing} · 총 세션: ${allSessions.length}` +
      (desktopSessions.length
        ? `\n· 데스크톱 후보: ${desktopSessions.length}건`
        : "")
  );
}

async function refreshAgentStrengths() {
  try {
    const { runAggregation } = await import("./aggregate-agent-strengths.mjs");
    runAggregation();
  } catch (e) {
    log("agent-strengths 집계 건너뜀:", e?.message || e);
  }
}

export {
  buildMarkdown,
  buildMergedResultsMarkdown,
  chunkTurns,
  collectMergedResultEntries,
  collectResultFiles,
  fingerprintTurns,
  normalizeFingerprintText,
  parseResultEntries,
  readFrontmatter,
  scanExistingTranscriptSources,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve(main()).catch((e) => {
    log("실행 실패:", e?.message || e);
    process.exit(1);
  });
}
