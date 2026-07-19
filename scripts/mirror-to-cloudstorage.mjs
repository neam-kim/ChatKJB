#!/usr/bin/env node
// 로컬 작업본을 CloudStorage(또는 다른 로컬 폴더)로 미러링한다(선택적 개인 백업).
// Synology Drive 등이 그 폴더를 NAS로 동기화하면 결과적으로 로컬 → NAS 미러가 된다.
//
// 필수 환경변수:
//   CHATKJB_MIRROR_DEST  미러 대상 절대 경로
// 선택:
//   CHATKJB_PROJECT_DIR  미설정 시 이 스크립트 기준 저장소 루트
//
// 설계 요점:
//  - 심링크는 `-L`로 내용을 풀어 복사한다. node_modules 등 저장소 밖을 가리키는
//    절대 심링크가 CloudStorage에서 잘려 `*_Conflict` churn을 내는 것을 원천 차단한다.
//  - node_modules·dist·.claude/worktrees는 재생성 가능하거나 로컬 전용이라 --delete-excluded로 배제.
//  - launchd 컨텍스트에서 /bin/bash는 CloudStorage(File Provider) 접근이 거부되지만 node는
//    허용되므로, 이 스크립트를 node로 실행하고 rsync를 자식으로 띄운다. 로그는 CloudStorage 밖.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = process.env.CHATKJB_PROJECT_DIR
  ? resolve(process.env.CHATKJB_PROJECT_DIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = process.env.CHATKJB_MIRROR_DEST?.trim();

function log(m) {
  console.log(`[mirror ${new Date().toISOString()}] ${m}`);
}

if (!dest) {
  log("CHATKJB_MIRROR_DEST 가 없습니다. 예: export CHATKJB_MIRROR_DEST=$HOME/Library/CloudStorage/…/ChatKJB");
  log("이 기능은 선택적 개인 백업입니다. 일반 설치에는 필요하지 않습니다.");
  process.exit(1);
}

// 미러 대상 상위 경로가 없으면(=드라이브 미마운트) 조용히 종료한다.
if (!existsSync(dirname(dest))) {
  log(`미러 상위 경로 없음, 스킵: ${dest}`);
  process.exit(0);
}

const rsync = existsSync("/usr/bin/rsync") ? "/usr/bin/rsync" : "rsync";
const args = [
  "-aL",
  "--delete",
  "--delete-excluded",
  "--exclude",
  "node_modules*",
  "--exclude",
  "dist",
  "--exclude",
  ".DS_Store",
  "--exclude",
  ".claude/worktrees",
  `${projectDir}/`,
  `${dest}/`
];

log(`rsync ${projectDir} → ${dest}`);
try {
  execFileSync(rsync, args, { stdio: "inherit" });
  log("미러 완료");
} catch (e) {
  log(`미러 실패: ${e?.message ?? e}`);
  process.exit(1);
}
