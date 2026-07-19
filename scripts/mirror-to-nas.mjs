#!/usr/bin/env node
// 로컬 작업본을 NAS에 직접 미러(선택적 개인 백업 — CloudStorage 경유 미러와 별개).
//
// 필수 환경변수:
//   CHATKJB_NAS_SSH   예: user@nas-host
// 선택 환경변수:
//   CHATKJB_NAS_PORT  기본 22
//   CHATKJB_PROJECT_DIR  미설정 시 이 스크립트 기준 저장소 루트
//   CHATKJB_NAS_REMOTE_DIR  원격 백업 상위 디렉터리 기본 $HOME/backups
//
// 일부 NAS는 rsync/SFTP/SCP subsystem이 꺼져 있어, tar를 표준입력으로 SSH에 넘겨
// 원격에서 푸는 tar-over-SSH 방식만 동작한다.
//
// - 심링크는 tar -h로 내용을 풀어 담는다(외부 절대 심링크가 원격에서 깨지는 것 방지).
// - node_modules/dist/.claude worktrees는 제외(재생성 가능·로컬 전용).
// - 원격은 스테이징 dir에 풀고 성공 시 스왑(원자적 교체).

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = process.env.CHATKJB_PROJECT_DIR
  ? resolve(process.env.CHATKJB_PROJECT_DIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const remote = process.env.CHATKJB_NAS_SSH?.trim();
const port = (process.env.CHATKJB_NAS_PORT || "22").trim();
const remoteBackupParent = (process.env.CHATKJB_NAS_REMOTE_DIR || "$HOME/backups").trim();

function log(m) {
  console.log(`[nas-mirror ${new Date().toISOString()}] ${m}`);
}
function q(s) {
  return "'" + String(s).replaceAll("'", `'\\''`) + "'";
}

if (!remote) {
  log("CHATKJB_NAS_SSH 가 없습니다. 예: export CHATKJB_NAS_SSH=user@nas-host");
  log("이 기능은 선택적 개인 백업입니다. 일반 설치에는 필요하지 않습니다.");
  process.exit(1);
}

// 원격: 스테이징에 풀고 성공 시 원자적 스왑.
// remoteBackupParent는 셸에서 확장되도록 따옴표 없이 둔다($HOME 등).
const remoteParentShell = remoteBackupParent.includes("'")
  ? q(remoteBackupParent)
  : remoteBackupParent;
const remoteCmd = [
  "set -e",
  `D=${remoteParentShell}`,
  'mkdir -p "$D"',
  'rm -rf "$D/ChatKJB.tmp"',
  'mkdir -p "$D/ChatKJB.tmp"',
  'tar xzf - -C "$D/ChatKJB.tmp"',
  'rm -rf "$D/ChatKJB"',
  'mv "$D/ChatKJB.tmp" "$D/ChatKJB"',
  'echo "[nas] extracted $(find "$D/ChatKJB" -type f | wc -l) files into $D/ChatKJB"'
].join("; ");

const pipeline =
  "set -o pipefail; " +
  `tar -czh -C ${q(projectDir)} ` +
  "--exclude=./node_modules --exclude='./*/node_modules' --exclude=./dist " +
  "--exclude=.DS_Store --exclude='./.claude/worktrees' -f - . " +
  `| ssh -p ${port} -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new ${remote} ${q(remoteCmd)}`;

log(`tar-over-SSH ${projectDir} → ${remote}:${remoteBackupParent}/ChatKJB`);
const r = spawnSync("/bin/bash", ["-c", pipeline], {
  stdio: ["ignore", "inherit", "inherit"]
});
if (r.status !== 0) {
  log(`실패 (exit ${r.status ?? "signal " + r.signal})`);
  process.exit(1);
}
log(`완료 (NAS ${remoteBackupParent}/ChatKJB 갱신)`);
