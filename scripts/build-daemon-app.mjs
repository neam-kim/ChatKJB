#!/usr/bin/env node
// 백그라운드 봇 데몬을 감싸는 최소 macOS 앱 번들(ChatKJB.app)을 만든다.
//
// 왜 필요한가
//   LaunchAgent가 Node 실행 파일을 직접 실행하면, macOS의 개인정보 보호 및 보안
//   화면과 권한 요청 대화상자에 프로세스가 "node"로 표시된다. 어떤 node인지
//   구분할 수 없어 전체 디스크 접근 같은 권한을 안전하게 부여하기 어렵다.
//
//   macOS는 실행 파일이 .app 번들의 주 실행 파일일 때 그 번들의 CFBundleName과
//   아이콘으로 프로세스를 표시한다. 그래서 Node 실행 파일을 그대로 복사해
//   Contents/MacOS/ChatKJB 로 두고, 전용 Info.plist와 ChatKJB Terminal과 같은
//   아이콘을 붙인다. 실행되는 바이너리는 여전히 Node이므로 동작은 같다.
//
// TCC(권한) 유지
//   권한은 번들 경로·번들 ID·코드 서명으로 식별된다. 서명이 바뀌면 macOS가 다른
//   앱으로 보고 권한을 다시 묻는다. 그래서 Node 실행 파일이 실제로 바뀐 경우에만
//   번들을 다시 만든다. 기존 번들이 최신이면 그대로 두고 경로만 돌려준다.
//
// 사용
//   node scripts/build-daemon-app.mjs [--force] [--print-path]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAppIcon } from "./macos-icon.mjs";
import { readReleaseVersion } from "./release-version.mjs";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DAEMON_APP_NAME = "ChatKJB";
export const DAEMON_BUNDLE_ID = "com.chatkjb.bot";
// 이 값은 영수증의 런타임 배포 형식도 식별한다. 형식이 바뀌면 기존 번들을
// 최신으로 오인하지 않고 다시 생성해야 한다.
export const DAEMON_NODE_RUNTIME_FORMAT = "self-contained-static-v1";

// 앱 번들은 Finder와 LaunchServices가 일반 응용 프로그램으로 인식하는
// 시스템 응용 프로그램 폴더에 둔다.
export function daemonAppPath() {
  return join("/Applications", `${DAEMON_APP_NAME}.app`);
}

export function daemonExecutablePath() {
  return join(daemonAppPath(), "Contents", "MacOS", DAEMON_APP_NAME);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function receiptPath(appPath) {
  return join(appPath, "Contents", "Resources", "build-receipt.json");
}

/** `otool -L` 출력에서 동적 라이브러리 경로만 뽑는다. universal binary의
 * architecture 헤더는 들여쓰기가 없으므로 의존성으로 오인하지 않는다. */
export function parseOtoolDynamicDependencies(output) {
  return String(output)
    .split(/\r?\n/u)
    .filter((line) => /^\s/u.test(line))
    .map((line) => /^\s*(\S+)\s+\(/u.exec(line)?.[1])
    .filter((path) => typeof path === "string");
}

/**
 * macOS 기본 런타임만 참조하는 Node만 단일 실행 파일로 배포할 수 있다.
 * 이 함수는 I/O가 없는 순수 함수여서 정책을 독립적으로 회귀 검증한다.
 */
export function classifyNodeDynamicDependencies(dependencies) {
  const normalizedDependencies = dependencies
    .map((path) => path.trim())
    .filter(Boolean);
  const nonSystemDependencies = normalizedDependencies.filter(
    (path) => !path.startsWith("/System/Library/") && !path.startsWith("/usr/lib/")
  );
  const selfContainedStatic = nonSystemDependencies.length === 0;

  return {
    kind: selfContainedStatic ? "self-contained-static" : "unsupported-dynamic",
    runtimeFormat: selfContainedStatic ? DAEMON_NODE_RUNTIME_FORMAT : null,
    dependencies: normalizedDependencies,
    nonSystemDependencies
  };
}

function inspectNodeRuntime(nodeSource) {
  const output = execFileSync("/usr/bin/otool", ["-L", nodeSource], { encoding: "utf8" });
  return classifyNodeDynamicDependencies(parseOtoolDynamicDependencies(output));
}

function assertSelfContainedNodeRuntime(nodeRuntime) {
  if (nodeRuntime.kind === "self-contained-static") return;
  const dependencies = nodeRuntime.nonSystemDependencies.join(", ");
  throw new Error(
    `Refusing to replace daemon app: Node runtime has non-system dynamic dependencies (${dependencies}). `
    + "Use a self-contained Node runtime; partial dynamic-library bundling is not supported."
  );
}

function daemonExecutablePathFor(appPath) {
  return join(appPath, "Contents", "MacOS", DAEMON_APP_NAME);
}

function hasLibnodeReceiptValue(receipt) {
  return ["nodeLibrarySha256", "nodeLibrarySource", "nodeLibraryName"]
    .some((field) => receipt[field] != null);
}

export function isDaemonAppReceiptCurrent(receipt, {
  nodeSha256,
  iconSha256,
  nodeRuntime,
  releaseVersion
}) {
  return Boolean(receipt)
    && receipt.nodeSha256 === nodeSha256
    && receipt.iconSha256 === iconSha256
    && receipt.bundleId === DAEMON_BUNDLE_ID
    && receipt.nodeRuntimeFormat === nodeRuntime.runtimeFormat
    && JSON.stringify(receipt.nodeDynamicDependencies) === JSON.stringify(nodeRuntime.dependencies)
    && receipt.shortVersion === releaseVersion.shortVersion
    && receipt.buildNumber === releaseVersion.buildNumber
    && !hasLibnodeReceiptValue(receipt);
}

// 이미 만들어진 번들이 현재 Node·런타임 형식·아이콘 원본 기준으로 최신인지 확인한다.
function isBundleCurrent(appPath, nodeSha256, iconSha256, nodeRuntime, releaseVersion) {
  const executable = daemonExecutablePathFor(appPath);
  const librariesDir = join(appPath, "Contents", "lib");
  if (!existsSync(executable) || existsSync(librariesDir) || !existsSync(receiptPath(appPath))) return false;
  try {
    const receipt = JSON.parse(readFileSync(receiptPath(appPath), "utf8"));
    return isDaemonAppReceiptCurrent(receipt, {
      nodeSha256,
      iconSha256,
      nodeRuntime,
      releaseVersion
    });
  } catch {
    return false;
  }
}

function infoPlist(releaseVersion) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>ko</string>
  <key>CFBundleExecutable</key>
  <string>${DAEMON_APP_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>${DAEMON_BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${DAEMON_APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${DAEMON_APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${releaseVersion.shortVersion}</string>
  <key>CFBundleVersion</key>
  <string>${releaseVersion.buildNumber}</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSBackgroundOnly</key>
  <false/>
  <key>NSHumanReadableCopyright</key>
  <string>ChatKJB contributors</string>
</dict>
</plist>
`;
}

export function buildDaemonApp({
  force = false,
  log = () => {},
  appPath = daemonAppPath(),
  nodeSource = realpathSync(process.execPath),
  inspectRuntime = inspectNodeRuntime,
  removeTree = rmSync
} = {}) {
  // 이 검사는 기존 앱이나 staging 경로를 지우기 전에 반드시 끝나야 한다.
  const nodeRuntime = inspectRuntime(nodeSource);
  assertSelfContainedNodeRuntime(nodeRuntime);
  const nodeSha256 = sha256File(nodeSource);
  const iconSource = join(projectDir, "native", "macos", "jb-logo.svg");
  const iconSha256 = sha256File(iconSource);
  const releaseVersion = readReleaseVersion(projectDir);

  if (!force && isBundleCurrent(appPath, nodeSha256, iconSha256, nodeRuntime, releaseVersion)) {
    log(`daemon app is current: ${appPath}`);
    return { appPath, executablePath: daemonExecutablePathFor(appPath), rebuilt: false };
  }

  const contentsDir = join(appPath, "Contents");
  const macosDir = join(contentsDir, "MacOS");
  const resourcesDir = join(contentsDir, "Resources");
  const buildDir = join("/Applications", ".build-daemon-app");

  removeTree(appPath, { recursive: true, force: true });
  removeTree(buildDir, { recursive: true, force: true });
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });

  try {
    writeFileSync(join(contentsDir, "Info.plist"), infoPlist(releaseVersion), "utf8");

    // Node 실행 파일을 번들의 주 실행 파일로 복사한다. 실행되는 코드는 동일하고
    // 표시되는 신원만 ChatKJB가 된다.
    const executablePath = daemonExecutablePathFor(appPath);
    copyFileSync(nodeSource, executablePath);
    chmodSync(executablePath, 0o755);

    buildAppIcon({
      projectDir,
      buildDir,
      outputIcnsPath: join(resourcesDir, "AppIcon.icns")
    });

    writeFileSync(
      receiptPath(appPath),
      `${JSON.stringify({
        bundleId: DAEMON_BUNDLE_ID,
        nodeSha256,
        nodeVersion: process.versions.node,
        nodeSource,
        nodeRuntimeFormat: nodeRuntime.runtimeFormat,
        nodeDynamicDependencies: nodeRuntime.dependencies,
        iconSha256,
        shortVersion: releaseVersion.shortVersion,
        buildNumber: releaseVersion.buildNumber
      }, null, 2)}\n`,
      "utf8"
    );

    // ad-hoc 서명. 서명이 있어야 macOS가 번들 신원을 안정적으로 인식한다.
    execFileSync("/usr/bin/codesign", [
      "--force",
      "--sign", "-",
      "--timestamp=none",
      appPath
    ], { cwd: projectDir, stdio: "inherit" });

    log(`daemon app built: ${appPath}`);
    return { appPath, executablePath, rebuilt: true };
  } finally {
    removeTree(buildDir, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const force = process.argv.includes("--force");
  const result = buildDaemonApp({ force, log: (message) => console.log(message) });
  if (process.argv.includes("--print-path")) process.stdout.write(`${result.appPath}\n`);
}
