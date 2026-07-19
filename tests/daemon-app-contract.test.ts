import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const daemonApp = readFileSync(resolve(root, "scripts/build-daemon-app.mjs"), "utf8");
const installAgent = readFileSync(resolve(root, "scripts/install-launch-agent.mjs"), "utf8");
const installSyncAgent = readFileSync(resolve(root, "scripts/install-agent-sync-agent.mjs"), "utf8");
const installCleanupAgent = readFileSync(resolve(root, "scripts/install-cleanup-agent.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

// LaunchAgent가 Node 실행 파일을 직접 실행하면 macOS 권한 화면에 "node"로만 표시된다.
// 데몬을 ChatKJB.app 번들로 감싸 이름과 아이콘이 드러나게 하는 계약을 고정한다.
describe("ChatKJB 데몬 래퍼 앱 계약", () => {
  it("권한 화면에 드러날 번들 신원을 ChatKJB로 고정한다", () => {
    expect(daemonApp).toContain('DAEMON_APP_NAME = "ChatKJB"');
    expect(daemonApp).toContain('DAEMON_BUNDLE_ID = "com.chatkjb.bot"');
    expect(daemonApp).toContain("<key>CFBundleName</key>");
    expect(daemonApp).toContain("<key>CFBundleDisplayName</key>");
    expect(daemonApp).toContain("<key>CFBundleIdentifier</key>");
    expect(daemonApp).toContain("<string>APPL</string>");
  });

  it("ChatKJB Terminal과 같은 아이콘 생성기를 재사용한다", () => {
    expect(daemonApp).toContain('from "./macos-icon.mjs"');
    expect(daemonApp).toContain("buildAppIcon(");
    expect(daemonApp).toContain("<key>CFBundleIconFile</key>");
    expect(daemonApp).toContain("<string>AppIcon</string>");
  });

  it("백그라운드 데몬이므로 Dock에 노출하지 않는다", () => {
    expect(daemonApp).toContain("<key>LSUIElement</key>");
  });

  it("Node 실행 파일을 번들의 주 실행 파일로 복사하고 ad-hoc 서명한다", () => {
    expect(daemonApp).toContain("copyFileSync(nodeSource, executablePath)");
    expect(daemonApp).toContain('"/usr/bin/codesign"');
    expect(daemonApp).toContain('"--sign", "-"');
  });

  it("Node가 그대로면 다시 만들지 않아 부여된 권한을 유지한다", () => {
    expect(daemonApp).toContain("isBundleCurrent(");
    expect(daemonApp).toContain("nodeSha256");
    expect(daemonApp).toContain("build-receipt.json");
  });

  it("저장소가 아니라 사용자 라이브러리의 고정 경로에 설치한다", () => {
    expect(daemonApp).toContain('"Library",');
    expect(daemonApp).toContain('"Application Support",');
    expect(daemonApp).toContain('"ChatKJB",');
  });

  it("LaunchAgent가 Node 대신 번들 실행 파일을 실행한다", () => {
    expect(installAgent).toContain('from "./build-daemon-app.mjs"');
    expect(installAgent).toContain("buildDaemonApp(");
    expect(installAgent).toContain("const nodePath = daemonApp.executablePath");
    expect(installAgent).not.toContain("const nodePath = process.execPath");
  });

  it("보조 LaunchAgent도 Node 대신 번들 실행 파일을 실행한다", () => {
    // 하나라도 raw node로 남으면 권한 목록에 node 항목을 지울 수 없다.
    for (const source of [installSyncAgent, installCleanupAgent]) {
      expect(source).toContain('from "./build-daemon-app.mjs"');
      expect(source).toContain("buildDaemonApp(");
      expect(source).toContain("const nodePath = buildDaemonApp(");
      expect(source).not.toContain("const nodePath = process.execPath");
    }
  });

  it("번들만 따로 만들 수 있는 npm 스크립트를 제공한다", () => {
    expect(packageJson.scripts["launchd:app"]).toContain("build-daemon-app.mjs");
    expect(packageJson.scripts["launchd:install"]).toContain("install-launch-agent.mjs");
    expect(packageJson.scripts["agents:install-sync-agent"]).toContain("install-agent-sync-agent.mjs");
    expect(packageJson.scripts["agents:install-cleanup-agent"]).toContain("install-cleanup-agent.mjs");
  });
});
