import { execFileSync } from "node:child_process";

const label = "com.neam.telegram-claude-orchestrator";
const uid = process.getuid?.();

if (uid === undefined) {
  throw new Error("현재 사용자 ID를 확인할 수 없습니다.");
}

const target = `gui/${uid}/${label}`;
execFileSync("launchctl", ["kickstart", "-k", target], { stdio: "inherit" });
console.log(`LaunchAgent restarted: ${target}`);
