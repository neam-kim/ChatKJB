import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const swift = readFileSync(resolve(root, "native/macos/ChatKJBTerminal.swift"), "utf8");
const spawnSource = readFileSync(resolve(root, "native/macos/backend_spawn.c"), "utf8");
const plist = readFileSync(resolve(root, "native/macos/Info.plist"), "utf8");
const web = readFileSync(resolve(root, "src/gui/web/app.js"), "utf8");
const entry = readFileSync(resolve(root, "src/gui-entry.ts"), "utf8");
const audit = readFileSync(resolve(root, "scripts/audit-macos-app.mjs"), "utf8");
const runner = readFileSync(resolve(root, "script/build_and_run.sh"), "utf8");
const build = readFileSync(resolve(root, "scripts/build-macos-app.mjs"), "utf8");
// 아이콘 생성기는 Terminal 앱과 데몬 래퍼 앱이 공유한다.
const iconBuilder = readFileSync(resolve(root, "scripts/macos-icon.mjs"), "utf8");
const smoke = readFileSync(resolve(root, "scripts/smoke-macos-app.mjs"), "utf8");
const icon = readFileSync(resolve(root, "native/macos/jb-logo.svg"));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));

describe("ChatKJB Terminal macOS shell contract", () => {
  it("uses only a non-persistent WebKit store and the exact loopback origin", () => {
    expect(swift).toContain(".nonPersistent()")
    expect(swift).toContain('url.host == "127.0.0.1"');
    expect(swift).toContain('url.path == "/bootstrap"');
    expect(swift).toContain('url?.path == "/"');
    for (const forbidden of ["localhost", "NSAllowsArbitraryLoads", "javaScriptEnabled = false"]) {
      expect(swift).not.toContain(forbidden);
    }
  });

  it("spawns the fixed backend without a shell in its own close-on-exec process group", () => {
    expect(swift).not.toContain('URL(fileURLWithPath: "/bin/sh")');
    expect(spawnSource).toContain("POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP");
    expect(spawnSource).toContain("posix_spawnattr_setpgroup(&attributes, 0)");
    expect(spawnSource).toContain("posix_spawn_file_actions_adddup2(&actions, descriptors[1], 3)");
    expect(spawnSource).toContain('strdup("PATH=/usr/bin:/bin:/usr/sbin:/sbin")');
    expect(spawnSource).toContain('"CHATKJB_CONFIG_BASE_DIR"');
    for (const forbidden of ["NODE_OPTIONS", "NODE_PATH", "DYLD_", "TELEGRAM_API_HASH", "TELEGRAM_BOT_TOKEN"]) {
      expect(spawnSource).not.toContain(forbidden);
    }
  });

  it("watches the parent through private heartbeats and bounded group termination", () => {
    expect(entry).toContain('{ type: "heartbeat"; }');
    expect(entry).toContain("process.ppid !== expectedParentPid");
    expect(entry).toContain('!emitPrivate({ type: "heartbeat" })');
    expect(spawnSource).toContain("chatkjb_run_backend_supervisor");
    expect(spawnSource).toContain("getppid() != expected_parent_pid");
    expect(spawnSource).toContain("stop_and_reap_node(node_pid)");
    expect(spawnSource).toContain('"--backend-supervisor"');
    expect(swift).toContain("kill(processGroup, SIGTERM)");
    expect(swift).toContain("kill(processGroup, SIGKILL)");
    expect(swift).toContain("waitpid(pid, &status");
    expect(swift).toContain("terminateRemainingProcessGroup(pid)");
  });

  it("keeps QR and logout inside the private native boundary", () => {
    expect(swift).toContain('let value = "tg://login?token=\\(token)"');
    expect(swift).toContain('CIFilter(name: "CIQRCodeGenerator")');
    expect(swift).toContain("decodedToken.count == 34");
    expect(swift).toContain('"^[A-Za-z0-9_-]{46}$"');
    expect(web).toContain('Object.defineProperty(window, "chatkjbNativeLogout"');
    expect(web).toContain('await request("/api/logout", { method: "POST" })');
    expect(swift).toContain("return await window.chatkjbNativeLogout();");
    expect(entry).toContain('if (latestAuthState === "signed_out")');
    expect(entry).toContain("void client.beginQrLogin().catch(() => undefined)");
  });

  it("connects HTML file inputs to a single-file Finder sheet", () => {
    expect(swift).toContain("runOpenPanelWith parameters: WKOpenPanelParameters");
    expect(swift).toContain("initiatedByFrame frame: WKFrameInfo");
    expect(swift).toContain("let panel = NSOpenPanel()");
    expect(swift).toContain("panel.canChooseFiles = true");
    expect(swift).toContain("panel.canChooseDirectories = false");
    expect(swift).toContain("panel.allowsMultipleSelection = false");
    expect(swift).toContain("panel.beginSheetModal(for: window)");
    expect(swift).toContain("completionHandler(response == .OK ? panel.urls : nil)");
  });

  it("routes window.alert and window.confirm through WKUIDelegate native panels", () => {
    // 이 핸들러가 없으면 WKWebView에서 confirm이 즉시 false가 되어 토픽 삭제가 무동작한다.
    expect(swift).toContain("runJavaScriptAlertPanelWithMessage message: String");
    expect(swift).toContain("runJavaScriptConfirmPanelWithMessage message: String");
    expect(swift).toContain("completionHandler: @escaping (Bool) -> Void");
    expect(swift).toContain("completionHandler(response == .alertFirstButtonReturn)");
    expect(swift).toMatch(/if noninteractive \{\s*completionHandler\(false\)/);
    expect(web).toContain("window.confirm(");
  });

  it("declares local networking without a broad ATS exception", () => {
    expect(plist).toContain("<key>NSAllowsLocalNetworking</key>");
    expect(plist).not.toContain("NSAllowsArbitraryLoads");
    expect(plist).not.toContain("CFBundleURLTypes");
    expect(plist).not.toContain("CFBundleDocumentTypes");
    for (const forbidden of ["ChatKJBProjectPath", "ChatKJBNodePath", "ChatKJBBackendPath"]) {
      expect(plist).not.toContain(forbidden);
    }
  });

  it("pins esbuild directly and creates a self-contained backend and runtime", () => {
    expect(packageJson.devDependencies.esbuild).toBe("0.28.1");
    expect(packageLock.packages[""].devDependencies.esbuild).toBe("0.28.1");
    expect(build).toContain("build as bundleWithEsbuild");
    expect(build).toContain('format: "esm"');
    expect(build).toContain('const require = __chatkjbCreateRequire(import.meta.url)');
    expect(build).toContain("metafile: true");
    expect(build).toContain("preserveSymlinks: true");
    expect(build).toContain("sourcemap: false");
    expect(build).toContain('const backendDir = join(resourcesDir, "Backend")');
    expect(build).toContain('const bundledBackendPath = join(backendDir, "gui-entry.mjs")');
    expect(build).toContain('const runtimeDir = join(resourcesDir, "Runtime")');
    expect(build).toContain('const runtimePath = join(runtimeDir, "node")');
    expect(build).toContain('const webAssetNames = ["app.js", "index.html", "manifest.webmanifest", "styles.css"]');
    expect(build).toContain("const runtimeSource = realpathSync(process.execPath)");
    expect(build).toContain('"esbuild-metafile.json"');
    expect(build).toContain('"manifest.json"');
    expect(build.indexOf('"--timestamp=none",\n    runtimePath')).toBeLessThan(
      build.indexOf('"--timestamp=none",\n    appPath')
    );
    expect(build).not.toContain("__CHATKJB_PROJECT_PATH__");
  });

  it("builds the exact attached SVG into the selected multi-resolution app icon", () => {
    expect(createHash("sha256").update(icon).digest("hex"))
      .toBe("884f0791c73f826f12180ad7acb2cfa2dd286e8baf1d9153c348fafbfa7f7b76");
    expect(plist).toContain("<key>CFBundleIconFile</key>");
    expect(plist).toContain("<string>AppIcon</string>");
    expect(build).toContain("buildAppIcon(");
    expect(iconBuilder).toContain('"/usr/bin/qlmanage"');
    expect(iconBuilder).toContain('"/usr/bin/iconutil"');
    expect(iconBuilder).toContain('["icon_512x512@2x.png", 1024]');
    expect(audit).toContain('"Contents/Resources/AppIcon.icns"');
    expect(audit).toContain("expectedIconSourceSha256");
    expect(audit).toContain("expectedRepresentations");
  });

  it("표준 편집 단축키가 동작하도록 편집 메뉴를 제공한다", () => {
    // 편집 메뉴가 없으면 macOS가 ⌘C/⌘V/⌘A를 웹뷰로 전달하지 않는다.
    expect(swift).toContain('NSMenu(title: "편집")');
    // undo/redo는 Swift에 노출된 선택자가 없어 문자열 형태를 유지한다.
    for (const selector of ["undo:", "redo:"]) {
      expect(swift).toContain(`Selector(("${selector}"))`);
    }
    for (const action of ["cut", "copy", "paste", "selectAll"]) {
      expect(swift).toContain(`#selector(NSText.${action}(_:))`);
    }
    expect(swift).toContain('keyEquivalent: "c"');
    expect(swift).toContain('keyEquivalent: "v"');
    expect(swift).toContain('keyEquivalent: "a"');
  });

  it("does not log private control payloads", () => {
    expect(swift).not.toContain("print(bootstrap");
    expect(swift).not.toContain("print(token");
    expect(swift).not.toContain("os_log");
    expect(swift).toContain("CHATKJB_GUI_SMOKE_READY");
  });

  it("rejects malformed control events and unsafe download names", () => {
    expect(swift).toContain("controlProtocolRejected");
    expect(swift).toContain('rejectControlEvent("CONTROL_EVENT_UNKNOWN")');
    expect(swift).toContain('Set(object.keys) == Set(["type", "origin", "bootstrapUrl"])');
    expect(swift).toContain("CharacterSet.controlCharacters");
    expect(swift).toContain("\\u{202E}");
  });

  it("audits the ad-hoc signature and requires an entitlement-free bundle", () => {
    expect(audit).toContain('details.includes("Signature=adhoc")');
    expect(audit).toContain('details.includes("TeamIdentifier=not set")');
    expect(audit).toContain('["-d", "--entitlements", "-", path]');
    expect(audit).toContain("must not carry entitlements");
    expect(audit).toContain('execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]');
    expect(audit).toContain("expectedFiles");
    expect(audit).toContain("Esbuild metafile contains a non-portable input path");
    expect(audit).toContain("Bundled package licenses do not correspond to the esbuild metafile");
    expect(audit).toContain("CHATKJB_GUI_RUNTIME_SELF_TEST_OK");
    expect(audit).toContain("assertArm64SystemBinary(runtimePath)");
  });

  it("smokes a relocated copy with isolated configuration and no host Node path", () => {
    expect(smoke).toContain("mkdtempSync(join(tmpdir()");
    expect(smoke).toContain('"Portable App Copy"');
    expect(smoke).toContain('"Runtime", "node"');
    expect(smoke).toContain('"Backend", "gui-entry.mjs"');
    expect(smoke).toContain('writeFileSync(join(configRoot, ".env")');
    expect(smoke).toContain('mode: 0o600, flag: "wx"');
    expect(smoke).toContain("CHATKJB_GUI_CONFIG_SELF_TEST_OK");
    expect(smoke).toContain("CHATKJB_GUI_RUNTIME_SELF_TEST_OK");
    expect(smoke).toContain("CHATKJB_GUI_SMOKE_AUTH_SIGNED_OUT");
    expect(smoke).toContain("CHATKJB_GUI_SMOKE_AUTH_READY");
    expect(smoke).toContain("CHATKJB_GUI_SMOKE_READY");
    expect(smoke).not.toContain("NODE_PATH");
  });

  it("fails closed when WebKit navigation or its content process fails", () => {
    expect(swift).toContain("didFailProvisionalNavigation");
    expect(swift).toContain("webViewWebContentProcessDidTerminate");
    expect(swift).toContain("pageTimer = Timer.scheduledTimer");
    expect(swift).toContain('webView.url?.path == "/"');
  });

  it("distinguishes the main app from its supervisor in the run entrypoint", () => {
    expect(runner).toContain("main_app_pids()");
    expect(runner).toContain("supervisor_pgids()");
    expect(runner).toContain('NODE_RUNTIME="$APP_BUNDLE/Contents/Resources/Runtime/node"');
    expect(runner).toContain('BACKEND_ENTRY="$APP_BUNDLE/Contents/Resources/Backend/gui-entry.mjs"');
    expect(runner).toContain('node "$ROOT_DIR/scripts/smoke-macos-app.mjs"');
    expect(runner).not.toContain('BACKEND_ENTRY="$ROOT_DIR/dist/gui-entry.js"');
    expect(runner).not.toContain('pkill -TERM -x "$APP_NAME"');
    expect(runner).not.toContain('pgrep -x "$APP_NAME"');
  });
});
