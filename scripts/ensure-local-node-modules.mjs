// launchd 기동 사전 점검 프리로드.
//
// 프로젝트가 SynologyDrive/iCloud 등 File Provider(CloudStorage) 경로에 있으면
// better-sqlite3 같은 네이티브 .node 모듈을 launchd 백그라운드가 mmap하지 못해
// (errno=11) 데몬이 크래시 루프에 빠진다. 이 모듈은 `node --import`로 메인 모듈
// (그리고 그 의존성인 better-sqlite3)이 로드되기 *전에* 실행되어, node_modules가
// 클라우드 동기화 트리 밖의 로컬 경로에 있도록 보장한다. `npm ci`처럼 심링크를
// 실디렉터리로 되살리는 명령 뒤에도 다음 기동 때 자동 교정된다.
//
// 셸 래퍼(run-daemon.sh)를 쓰지 않는 이유: launchd 컨텍스트의 /bin/bash는
// CloudStorage 경로 접근이 거부되지만(Operation not permitted), node는 허용된다.

import { cpSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = process.env.CHATKJB_PROJECT_DIR
  ? resolve(process.env.CHATKJB_PROJECT_DIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(projectDir, "node_modules");
const localNm = join(homedir(), ".local", "share", "telegram-claude-orchestrator", "node_modules");

// 동일 볼륨이 아니면 renameSync는 EXDEV로 실패하므로 복사 후 삭제로 폴백한다.
function relocate(from, to) {
  try {
    renameSync(from, to);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

try {
  const stat = existsSync(nm) ? lstatSync(nm) : null;
  if (stat?.isSymbolicLink()) {
    // 이미 심링크 — 정상. 아무것도 하지 않는다.
  } else if (stat?.isDirectory()) {
    mkdirSync(dirname(localNm), { recursive: true });
    if (existsSync(localNm)) rmSync(localNm, { recursive: true, force: true });
    relocate(nm, localNm);
    symlinkSync(localNm, nm);
    console.error(`[preload] node_modules를 비클라우드 경로로 이전했습니다: ${localNm}`);
  } else if (!stat && existsSync(localNm)) {
    symlinkSync(localNm, nm); // 심링크만 사라진 경우 복구
  }
} catch (error) {
  // 점검 실패가 곧 기동 실패가 되지 않도록 로그만 남기고 계속 진행한다.
  console.error(`[preload] node_modules 사전 점검 실패(계속 진행): ${error?.message ?? error}`);
}
