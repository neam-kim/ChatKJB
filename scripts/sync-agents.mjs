#!/usr/bin/env node
// 주기적 에이전트 리컨실러 — 설치된 5개 에이전트 CLI를 봇 런타임에 반영한다.
//
// 배경(봇의 에이전트 호출 방식마다 반영 특성이 다르다):
//   - Claude : 외부 `claude` CLI를 매 턴 스폰(pathToClaudeCodeExecutable). ~/.local/bin/claude
//              고정 심링크가 최신 버전을 가리키므로 in-place 업데이트는 이미 자동 반영된다.
//   - Grok   : 외부 grok 바이너리를 스폰. 시작 시점에 경로를 1회 해석하지만, 같은 경로가
//              in-place로 갱신되면 다음 턴 스폰이 새 바이너리를 쓴다(자동). 경로 자체가
//              바뀐 경우에만 재해석(=재시작)이 필요하다.
//   - agy    : Grok과 동일.
//   - Codex  : codex-sdk(npm)가 codexPathOverride로 외부 codex CLI를 구동하되, SDK JS와
//              codex CLI는 프로토콜 **락스텝**이라 버전이 어긋나면 깨진다. 전역 codex가
//              봇 codex-sdk와 다르면 codex-sdk를 맞춰야 한다(유일한 수동성 항목).
//   - Cline  : @cline/sdk(npm)를 봇 프로세스 안에서 직접 쓰되, 도구 실행은 전역 `cline`이
//              띄우는 허브 데몬(`cline --cline-hub-daemon`)에 붙는다. codex와 달리 SDK와 CLI가
//              서로 다른 버전 라인이라 **락스텝이 없다** — 전역 CLI만 최신으로 올리고, SDK는
//              package.json 핀을 그대로 둔다(버전은 보고에만 싣는다).
//
// 이 스크립트의 정책:
//   0) 먼저 5개 CLI를 최신으로 능동 업데이트한다(codex·cline은 self-update 명령이 없어 전역 npm으로,
//      claude/grok/agy는 각자 `update` 서브커맨드로). 각 업데이트는 타임아웃·에러 격리되어,
//      하나가 실패해도 나머지 업데이트와 아래 리컨실 단계는 계속 진행된다.
//   1) 업데이트로 전역 codex 버전이 봇 codex-sdk 버전과 달라지면 codex-sdk를 안전 절차로 락스텝
//      → 재시작(즉 "codex CLI 업데이트 후 봇이 새 버전으로 동작"까지 자동 완결).
//   2) Claude/Grok/agy는 같은 경로 in-place 갱신이라 다음 스폰에 자동 반영 — 해석 경로가 바뀐
//      경우에만 재시작(버전만 바뀌면 재시작 불필요).
//   3) 아무 변동이 없으면 재시작하지 않는다. 텔레그램 보고는 매 실행 후 보낸다
//      (AGENT_SYNC_NOTIFY=0 이면 비활성).
//   위험한 npm 작업(공유 node_modules 갱신)은 codex 버전이 실제로 바뀐 경우에만 실행하며,
//   @openai 스코프 백업 → 검증 → 실패 시 롤백(재시작 안 함)으로 봇을 항상 살려둔다.
//   AGENT_SYNC_SKIP_UPDATE=1 이면 능동 업데이트 단계를 건너뛰고 리컨실만 수행한다.
//
// 데몬 런타임:
//   LaunchAgent는 macOS 권한 화면 식별을 위해 ChatKJB.app 번들로 이 스크립트를 실행한다.
//   process.execPath 는 번들 MacOS 경로라 npm/codex 형제가 없다. 설치 시 기록한
//   CHATKJB_NODE_BIN(실제 Node bin)을 npm·codex·PATH 해석에 우선 사용한다.
//
// 환경변수:
//   CHATKJB_PROJECT_DIR, CHATKJB_NODE_BIN, AGENT_SYNC_SKIP_UPDATE, AGENT_SYNC_NOTIFY=0
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (프로젝트 .env 또는 프로세스 환경)

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const label = "com.chatkjb.bot";
const projectDir =
  process.env.CHATKJB_PROJECT_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "..");

// launchd 실행 시 셸 환경이 없으므로 오케스트레이터와 같은 .env를 내장 loader로 읽는다.
try {
  process.loadEnvFile(join(projectDir, ".env"));
} catch {
  /* .env 없음 — 기본값 유지 */
}

const ENV_FILE = join(projectDir, ".env");
const NOTIFY = process.env.AGENT_SYNC_NOTIFY !== "0";
const APP_TIME_ZONE =
  process.env.TZ?.trim() ||
  Intl.DateTimeFormat().resolvedOptions().timeZone ||
  "Asia/Seoul";

// ChatKJB.app 번들로 실행되면 execPath 옆에는 npm이 없다. 설치 시점 Node bin을 우선한다.
function resolveNodeBinDir(env = process.env, execPath = process.execPath) {
  const candidates = [];
  const recorded = env.CHATKJB_NODE_BIN?.trim();
  if (recorded) candidates.push(recorded);
  candidates.push(dirname(execPath));
  for (const dir of candidates) {
    if (!dir) continue;
    if (existsSync(join(dir, "npm")) || existsSync(join(dir, "node"))) return dir;
  }
  return candidates.find(Boolean) ?? dirname(execPath);
}

const nodeBinDir = resolveNodeBinDir();
const nodePath = existsSync(join(nodeBinDir, "node"))
  ? join(nodeBinDir, "node")
  : process.execPath;
const npmCli = join(nodeBinDir, "npm");
// launchd 컨텍스트의 PATH는 빈약해 `#!/usr/bin/env node` 셰방(codex.js, npm)이 node를
// 못 찾는다. 자식 프로세스 PATH 앞에 실제 Node bin을 넣어 해결한다.
const childEnv = {
  ...process.env,
  PATH: `${nodeBinDir}:${process.env.PATH ?? ""}`
};
const home = homedir();
const shareBase = join(home, ".local", "share", "chatkjb");
const sharedNm = join(shareBase, "node_modules");
const stateFile = join(shareBase, "agent-sync-state.json");
const uid = process.getuid?.() ?? 501;
const nowTag = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

function log(msg) {
  console.log(`[sync-agents ${new Date().toISOString()}] ${msg}`);
}

function localStamp(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

// PATH가 빈약한 launchd 컨텍스트에서도 바이너리를 찾도록, cli-resolver.ts의 후보 순서를 흉내낸다.
function resolveBin(name, candidates, pathValue = process.env.PATH) {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  const pathDirs = (pathValue ?? "").split(":");
  for (const d of pathDirs) {
    if (!d) continue;
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveProviderBins(binDir = nodeBinDir, pathValue = childEnv.PATH) {
  return {
    // 전역 codex는 실제 Node/npm bin에 설치되므로 그 형제 경로를 우선한다.
    codex: resolveBin(
      "codex",
      [
        join(binDir, "codex"),
        join(home, ".local/bin/codex"),
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex"
      ],
      pathValue
    ),
    claude: resolveBin(
      "claude",
      [
        join(home, ".local/bin/claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude"
      ],
      pathValue
    ),
    // cli-resolver.ts와 같은 순서. `grok update`는 버전이 박힌 새 파일을 받고 ~/.grok/bin/grok
    // 심링크만 옮기므로, 최초 설치본 downloads/grok-macos-aarch64를 먼저 보면 stale 바이너리로
    // 업데이트를 돌리게 되고 봇도 구버전을 스폰한다.
    grok: resolveBin(
      "grok",
      [
        join(home, ".grok/bin/grok"),
        join(home, ".local/bin/grok"),
        "/opt/homebrew/bin/grok",
        "/usr/local/bin/grok",
        join(home, ".grok/downloads/grok-macos-aarch64")
      ],
      pathValue
    ),
    agy: resolveBin(
      "agy",
      [
        join(home, ".local/bin/agy"),
        "/opt/homebrew/bin/agy",
        "/usr/local/bin/agy"
      ],
      pathValue
    ),
    // 전역 cline은 codex와 같이 npm -g 설치라 Node bin 형제를 우선한다.
    cline: resolveBin(
      "cline",
      [
        join(binDir, "cline"),
        join(home, ".local/bin/cline"),
        "/opt/homebrew/bin/cline",
        "/usr/local/bin/cline"
      ],
      pathValue
    )
  };
}

const bins = resolveProviderBins();

function binVersion(bin) {
  if (!bin) return null;
  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: childEnv
    });
    const m = out.match(/\d+\.\d+\.\d+/);
    return m ? m[0] : out.trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

function pkgVersion(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

function loadState() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  mkdirSync(shareBase, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function restartDaemon(reason) {
  log(`데몬 재시작: ${reason}`);
  try {
    execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], {
      stdio: "inherit"
    });
    return true;
  } catch (e) {
    log(`재시작 실패: ${e?.message ?? e}`);
    return false;
  }
}

// codex-sdk를 targetVer에 맞춘다. 성공 시 true.
//
// 공유 node_modules를 **직접** 갱신한다(프로젝트/심링크/CloudStorage 미접촉):
// 이 CloudStorage(Synology Drive)는 심링크를 수 초 내 지우므로, 프로젝트에서 npm install을
// 돌리는 방식은 불안정하다. 대신 공유 dir에 프로젝트의 전체 manifest(package.json +
// package-lock.json)를 두고 `npm install --prefix <shared>`로 codex-sdk만 올린다. 전체
// manifest가 있으면 다른 의존성은 트리에 속해 prune되지 않고, 이미 설치된 native(better-sqlite3)
// 도 재빌드되지 않는다(검증필: "changed N, removed 0").
function relockstepCodex(targetVer) {
  const projPkg = join(projectDir, "package.json");
  const projLock = join(projectDir, "package-lock.json");
  const sharedPkg = join(shareBase, "package.json");
  const sharedLock = join(shareBase, "package-lock.json");
  const openaiDir = join(sharedNm, "@openai");
  const openaiBak = join(shareBase, `@openai.bak-${nowTag}`);
  log(`codex 락스텝 시작 → codex-sdk@${targetVer}`);

  if (!existsSync(npmCli)) {
    log(`codex 락스텝 실패 → npm 미발견: ${npmCli}`);
    return false;
  }

  // 롤백용 백업(@openai 스코프만 바뀐다).
  rmSync(openaiBak, { recursive: true, force: true });
  cpSync(openaiDir, openaiBak, { recursive: true });

  try {
    // 1) 프로젝트 package.json 핀 갱신(dev 일관성용 — 일반 파일이라 CloudStorage에서도 안전).
    const pkgRaw = readFileSync(projPkg, "utf8");
    const bumped = pkgRaw.replace(
      /("@openai\/codex-sdk"\s*:\s*")\^?\d+\.\d+\.\d+(")/,
      `$1^${targetVer}$2`
    );
    if (bumped !== pkgRaw) writeFileSync(projPkg, bumped);

    // 2) 공유 dir에 전체 manifest를 둔다(prune 방지).
    copyFileSync(projPkg, sharedPkg);
    if (existsSync(projLock)) copyFileSync(projLock, sharedLock);

    // 3) 공유 node_modules를 직접 갱신.
    execFileSync(npmCli, ["install", "--prefix", shareBase, `@openai/codex-sdk@${targetVer}`], {
      cwd: shareBase,
      stdio: "inherit",
      env: childEnv
    });

    // 4) 갱신된 lock을 프로젝트로 되돌려 일관성 유지(일반 파일).
    if (existsSync(sharedLock)) copyFileSync(sharedLock, projLock);

    // 5) 검증: codex-sdk 버전 일치 + better-sqlite3 네이티브 실제 로드(공유 dir 기준).
    const got = pkgVersion(join(sharedNm, "@openai", "codex-sdk"));
    if (got !== targetVer) throw new Error(`codex-sdk 버전 불일치: ${got} != ${targetVer}`);
    execFileSync(
      nodePath,
      ["-e", "require('better-sqlite3')(':memory:').prepare('select 1 as x').get()"],
      { cwd: shareBase, stdio: "ignore", env: childEnv }
    );

    rmSync(openaiBak, { recursive: true, force: true });
    log(`codex 락스텝 성공: codex-sdk@${targetVer}`);
    return true;
  } catch (e) {
    log(`codex 락스텝 실패 → 롤백: ${e?.message ?? e}`);
    try {
      rmSync(openaiDir, { recursive: true, force: true });
      cpSync(openaiBak, openaiDir, { recursive: true });
      rmSync(openaiBak, { recursive: true, force: true });
      log("롤백 완료(봇은 기존 버전 유지, 재시작 안 함).");
    } catch (re) {
      log(`롤백 중 오류: ${re?.message ?? re} — 수동 점검 필요.`);
    }
    return false;
  }
}

// 각 CLI를 최신으로 업데이트한다. 실패는 격리(로그만)하고 다음으로 진행 — 하나가 실패해도
// 나머지 업데이트·리컨실은 계속되어야 봇을 항상 살려둔다. execFileSync timeout으로 무인 잡의
// 멈춤을 방지한다(각 명령은 claude/grok/agy `update`, codex는 전역 npm으로 실증 완료: 비대화형).
const UPDATE_TIMEOUT_MS = 300_000;

/** @typedef {{ name: string, status: 'updated'|'latest'|'failed'|'skipped', before?: string|null, after?: string|null, error?: string }} UpdateLine */

/**
 * @param {string} name
 * @param {string|null} bin
 * @param {string[]} argv
 * @returns {UpdateLine}
 */
function runUpdate(name, bin, argv) {
  if (!bin) {
    log(`${name} 바이너리 미발견 — 업데이트 건너뜀.`);
    return { name, status: "skipped", error: "바이너리 미발견" };
  }
  const before = binVersion(bin);
  try {
    execFileSync(bin, argv, { stdio: "inherit", env: childEnv, timeout: UPDATE_TIMEOUT_MS });
  } catch (e) {
    const error = String(e?.message ?? e);
    log(`${name} 업데이트 실패(무시하고 계속): ${error}`);
    return { name, status: "failed", before, after: binVersion(bin), error };
  }
  const after = binVersion(bin);
  if (after !== before) {
    log(`${name} CLI: ${before} → ${after}`);
    return { name, status: "updated", before, after };
  }
  log(`${name} CLI: 최신(${after ?? "?"})`);
  return { name, status: "latest", before, after };
}

// self-update 서브커맨드가 없는 CLI(codex·cline)를 전역 npm으로 올린다. 설치 후 bins[name]을
// 다시 해석해 두어(이전에 null이었을 수 있다) 이어지는 리컨실 단계가 새 경로를 보게 한다.
/**
 * @param {string} name
 * @param {string} spec  npm 패키지 스펙(@latest 포함)
 * @param {string[]} binCandidates
 * @returns {UpdateLine}
 */
function runNpmGlobalUpdate(name, spec, binCandidates) {
  const before = binVersion(bins[name]);
  if (!existsSync(npmCli)) {
    const error = `npm 미발견: ${npmCli}`;
    log(`${name} CLI 업데이트 실패(무시하고 계속): ${error}`);
    return { name, status: "failed", before, after: before, error };
  }
  try {
    execFileSync(npmCli, ["install", "-g", spec], {
      stdio: "inherit",
      env: childEnv,
      timeout: UPDATE_TIMEOUT_MS
    });
    const bin = resolveBin(name, binCandidates.filter(Boolean), childEnv.PATH);
    if (bin) bins[name] = bin;
    const after = binVersion(bins[name]);
    if (after !== before) {
      log(`${name} CLI: ${before} → ${after}`);
      return { name, status: "updated", before, after };
    }
    log(`${name} CLI: 최신(${after ?? "?"})`);
    return { name, status: "latest", before, after };
  } catch (e) {
    const error = String(e?.message ?? e);
    log(`${name} CLI 업데이트 실패(무시하고 계속): ${error}`);
    return { name, status: "failed", before, after: binVersion(bins[name]), error };
  }
}

/**
 * @returns {UpdateLine[]}
 */
function updateAllClis() {
  /** @type {UpdateLine[]} */
  const lines = [];
  if (process.env.AGENT_SYNC_SKIP_UPDATE === "1") {
    log("AGENT_SYNC_SKIP_UPDATE=1 — CLI 능동 업데이트 건너뜀(리컨실만 수행).");
    return [
      { name: "codex", status: "skipped", error: "AGENT_SYNC_SKIP_UPDATE=1" },
      { name: "claude", status: "skipped", error: "AGENT_SYNC_SKIP_UPDATE=1" },
      { name: "grok", status: "skipped", error: "AGENT_SYNC_SKIP_UPDATE=1" },
      { name: "agy", status: "skipped", error: "AGENT_SYNC_SKIP_UPDATE=1" },
      { name: "cline", status: "skipped", error: "AGENT_SYNC_SKIP_UPDATE=1" }
    ];
  }

  // codex: self-update 명령이 없어 전역 npm으로 올린다. 이후 main()의 리컨실 단계가 새 CLI
  // 버전을 감지해 codex-sdk 락스텝 + 데몬 재시작까지 자동 완결한다.
  lines.push(
    runNpmGlobalUpdate("codex", "@openai/codex@latest", [
      join(nodeBinDir, "codex"),
      bins.codex,
      join(home, ".local/bin/codex")
    ])
  );

  // cline: codex와 같이 self-update 명령이 없다. 다만 @cline/sdk와 락스텝이 아니므로
  // 전역 CLI만 올리고 npm 작업은 여기서 끝난다(허브 데몬은 다음 스폰에 새 CLI를 쓴다).
  lines.push(
    runNpmGlobalUpdate("cline", "cline@latest", [
      join(nodeBinDir, "cline"),
      bins.cline,
      join(home, ".local/bin/cline"),
      "/opt/homebrew/bin/cline"
    ])
  );

  // claude/grok/agy: 각자 self-update 서브커맨드(같은 경로 in-place 갱신 → 다음 스폰 자동 반영).
  lines.push(runUpdate("claude", bins.claude, ["update"]));
  lines.push(runUpdate("grok", bins.grok, ["update"]));
  lines.push(runUpdate("agy", bins.agy, ["update"]));
  return lines;
}

// ── 텔레그램 보고 ────────────────────────────────────────────────────────────
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
      description: String(parsed.description || "알 수 없는 API 오류")
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
      log(`telegram ${method} 거부: ${parsed.description}`);
      return false;
    } catch (e) {
      if (bin === "curl") log(`telegram ${method} 실패: ${e?.message || e}`);
    }
  }
  return false;
}

function notifyTelegram(text) {
  if (!NOTIFY) return false;
  const chatId = readEnvValue("TELEGRAM_CHAT_ID");
  if (!chatId) {
    log("telegram 통지 건너뜀: chat_id 없음");
    return false;
  }
  return telegramPost("sendMessage", { chat_id: Number(chatId), text });
}

/**
 * @param {{
 *   updates: UpdateLine[],
 *   current: { codexCli: string|null, codexSdk: string|null, claude: string|null, grok: string|null, agy: string|null, clineCli?: string|null, clineSdk?: string|null },
 *   lockstep?: { from: string|null, to: string, ok: boolean }|null,
 *   restartReason?: string|null,
 *   outcome?: string|null,
 * }} report
 */
function formatAgentSyncReport(report, date = new Date()) {
  const lines = [`🔄 agent-sync ${localStamp(date)}`];
  for (const u of report.updates) {
    if (u.status === "updated") {
      lines.push(`· ${u.name}: ${u.before ?? "?"} → ${u.after ?? "?"}`);
    } else if (u.status === "latest") {
      lines.push(`· ${u.name}: 최신(${u.after ?? "?"})`);
    } else if (u.status === "failed") {
      lines.push(`· ${u.name}: 실패 — ${u.error ?? "unknown"}`);
    } else {
      lines.push(`· ${u.name}: 건너뜀${u.error ? ` (${u.error})` : ""}`);
    }
  }
  const cur = report.current;
  if (cur) {
    lines.push(
      `· 현재: codexCLI=${cur.codexCli ?? "null"} codexSDK=${cur.codexSdk ?? "null"} ` +
        `claude=${cur.claude ?? "null"} grok=${cur.grok ?? "null"} agy=${cur.agy ?? "null"} ` +
        `clineCLI=${cur.clineCli ?? "null"} clineSDK=${cur.clineSdk ?? "null"}`
    );
  }
  if (report.lockstep) {
    lines.push(
      report.lockstep.ok
        ? `· 락스텝: codex-sdk ${report.lockstep.from ?? "?"} → ${report.lockstep.to} 성공`
        : `· 락스텝: codex-sdk ${report.lockstep.from ?? "?"} → ${report.lockstep.to} 실패`
    );
  }
  if (report.restartReason) {
    lines.push(`· 데몬 재시작: ${report.restartReason}`);
  } else if (report.outcome) {
    lines.push(`· ${report.outcome}`);
  }
  return lines.join("\n");
}

function main() {
  log(`nodeBinDir=${nodeBinDir} npm=${existsSync(npmCli) ? npmCli : "MISSING"}`);

  // (0) 4개 CLI를 최신으로 능동 업데이트한 뒤 아래에서 현재 버전을 다시 읽는다.
  const updates = updateAllClis();

  const prev = loadState();
  // 업데이트 과정에서 bins.codex가 채워졌을 수 있으므로 최종 해석을 한 번 더 반영.
  const liveBins = resolveProviderBins();
  Object.assign(bins, liveBins);

  const cur = {
    codexCli: binVersion(bins.codex),
    codexSdk: pkgVersion(join(sharedNm, "@openai", "codex-sdk")),
    // cline SDK는 락스텝 대상이 아니라 보고용으로만 읽는다. 배치에 따라 공유 dir이 아니라
    // 프로젝트 node_modules에만 있을 수 있으므로 둘 다 본다.
    clineSdk:
      pkgVersion(join(sharedNm, "@cline", "sdk")) ??
      pkgVersion(join(projectDir, "node_modules", "@cline", "sdk")),
    claude: { path: bins.claude, ver: binVersion(bins.claude) },
    grok: { path: bins.grok, ver: binVersion(bins.grok) },
    agy: { path: bins.agy, ver: binVersion(bins.agy) },
    cline: { path: bins.cline, ver: binVersion(bins.cline) }
  };
  log(
    `현재: codexCLI=${cur.codexCli} codexSDK=${cur.codexSdk} ` +
      `claude=${cur.claude.ver} grok=${cur.grok.ver} agy=${cur.agy.ver} ` +
      `clineCLI=${cur.cline.ver} clineSDK=${cur.clineSdk}`
  );

  let restartReason = null;
  /** @type {{ from: string|null, to: string, ok: boolean }|null} */
  let lockstep = null;
  let outcome = null;

  // (1) Codex 락스텝 — 유일하게 npm 작업이 필요한 항목.
  if (cur.codexCli && cur.codexSdk && cur.codexCli !== cur.codexSdk) {
    log(`codex 드리프트 감지: CLI ${cur.codexSdk} → ${cur.codexCli}`);
    const ok = relockstepCodex(cur.codexCli);
    lockstep = { from: cur.codexSdk, to: cur.codexCli, ok };
    if (ok) {
      cur.codexSdk = cur.codexCli;
      restartReason = `codex 락스텝 ${cur.codexCli}`;
    } else {
      // 실패: 상태 저장하지 않고 종료(다음 주기에 재시도), 재시작 없음.
      outcome = "codex 락스텝 실패로 종료(재시도는 다음 주기)";
      log(outcome);
      const text = formatAgentSyncReport({
        updates,
        current: {
          codexCli: cur.codexCli,
          codexSdk: cur.codexSdk,
          claude: cur.claude.ver,
          grok: cur.grok.ver,
          agy: cur.agy.ver,
          clineCli: cur.cline.ver,
          clineSdk: cur.clineSdk
        },
        lockstep,
        restartReason: null,
        outcome
      });
      log(text.replace(/\n/g, " | "));
      notifyTelegram(text);
      return;
    }
  }

  // (2) Claude/Grok/agy/cline — 경로가 바뀐 경우에만 재해석 위해 재시작(버전만 바뀌면 자동).
  for (const name of ["claude", "grok", "agy", "cline"]) {
    const p = prev[name];
    if (p && p.path && cur[name].path && p.path !== cur[name].path) {
      restartReason = restartReason
        ? `${restartReason}; ${name} 경로 변경`
        : `${name} 경로 변경(${p.path} → ${cur[name].path})`;
    }
  }

  if (restartReason) {
    const restarted = restartDaemon(restartReason);
    if (!restarted) outcome = `재시작 실패: ${restartReason}`;
  } else {
    const changed = updates.some((u) => u.status === "updated");
    const failed = updates.some((u) => u.status === "failed");
    if (changed || failed) {
      outcome = failed
        ? "일부 업데이트 실패 · 재시작 없음(다음 스폰/주기에 반영·재시도)"
        : "CLI 갱신 반영 · 재시작 없음(다음 스폰에 자동 적용)";
    } else {
      outcome = "변동 없음 — 무동작";
    }
    log(outcome);
  }

  saveState({ ...cur, updatedAt: new Date().toISOString() });

  const text = formatAgentSyncReport({
    updates,
    current: {
      codexCli: cur.codexCli,
      codexSdk: cur.codexSdk,
      claude: cur.claude.ver,
      grok: cur.grok.ver,
      agy: cur.agy.ver,
      clineCli: cur.cline.ver,
      clineSdk: cur.clineSdk
    },
    lockstep,
    restartReason,
    outcome: restartReason ? null : outcome
  });
  log(text.replace(/\n/g, " | "));
  notifyTelegram(text);
}

export {
  formatAgentSyncReport,
  parseTelegramResponse,
  resolveNodeBinDir,
  resolveBin
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
