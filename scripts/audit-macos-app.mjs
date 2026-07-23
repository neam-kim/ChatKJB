#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { readReleaseVersion } from "./release-version.mjs";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appPath = join(projectDir, ".artifacts", "ChatKJB Terminal.app");
const executablePath = join(appPath, "Contents", "MacOS", "ChatKJBTerminal");
const runtimePath = join(appPath, "Contents", "Resources", "Runtime", "node");
const backendPath = join(appPath, "Contents", "Resources", "Backend", "gui-entry.mjs");
const licensesDir = join(appPath, "Contents", "Resources", "Licenses");
const manifestPath = join(licensesDir, "manifest.json");
const metafilePath = join(licensesDir, "esbuild-metafile.json");
const iconSource = join(projectDir, "native", "macos", "jb-logo.svg");
const expectedIconSourceSha256 = "884f0791c73f826f12180ad7acb2cfa2dd286e8baf1d9153c348fafbfa7f7b76";
const webAssetNames = ["app.js", "index.html", "manifest.webmanifest", "styles.css"];
const nodeBuiltinModules = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const releaseVersion = readReleaseVersion(projectDir);

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("App bundle must not contain symbolic links");
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function parseEnvironment(path) {
  if (!existsSync(path)) return new Map();
  const values = new Map();
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function signatureDetails(path) {
  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Unable to inspect code signature: ${relative(appPath, path)}`);
  const details = `${result.stdout}${result.stderr}`;
  if (!details.includes("Signature=adhoc") || !details.includes("TeamIdentifier=not set")) {
    throw new Error(`Bundle code must use an ad-hoc signature: ${relative(appPath, path)}`);
  }
}

function assertNoEntitlements(path) {
  const result = spawnSync("/usr/bin/codesign", ["-d", "--entitlements", "-", path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Unable to inspect entitlements: ${relative(appPath, path)}`);
  if (/<(?:plist|key)>/.test(`${result.stdout}${result.stderr}`)) {
    throw new Error(`App bundle code must not carry entitlements: ${relative(appPath, path)}`);
  }
}

function assertArm64SystemBinary(path) {
  const architectures = execFileSync("/usr/bin/lipo", ["-archs", path], { encoding: "utf8" }).trim().split(/\s+/);
  if (architectures.length !== 1 || architectures[0] !== "arm64") {
    throw new Error(`Bundle executable must be the verified arm64 build: ${relative(appPath, path)}`);
  }
  const linkedLibraries = execFileSync("/usr/bin/otool", ["-L", path], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ", 1)[0])
    .filter(Boolean);
  for (const library of linkedLibraries) {
    if (!library.startsWith("/System/Library/") && !library.startsWith("/usr/lib/")) {
      throw new Error(`Bundle executable links a non-system library: ${library}`);
    }
  }
}

function packageNameFromInput(input) {
  return input.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/|$)/)?.[1] ?? null;
}

function safeLicenseManifestPath(value) {
  return typeof value === "string"
    && /^Packages\/(?:at-[A-Za-z0-9._-]+__)?[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)
    && !value.includes("..");
}

if (!existsSync(appPath) || !lstatSync(appPath).isDirectory()) {
  throw new Error("Build ChatKJB Terminal.app before auditing it");
}
const artifactsRoot = realpathSync(join(projectDir, ".artifacts")) + sep;
if (!realpathSync(appPath).startsWith(artifactsRoot)) throw new Error("App bundle escaped the artifact directory");

for (const required of [executablePath, runtimePath, backendPath, manifestPath, metafilePath]) {
  if (!existsSync(required) || !lstatSync(required).isFile()) {
    throw new Error(`Required bundle file is missing: ${relative(appPath, required)}`);
  }
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const metafile = JSON.parse(readFileSync(metafilePath, "utf8"));
if (manifest.schemaVersion !== 1 || !manifest.node || !manifest.backend || !Array.isArray(manifest.packages)) {
  throw new Error("License manifest has an invalid schema");
}

const expectedFiles = new Set([
  "Contents/Info.plist",
  "Contents/MacOS/ChatKJBTerminal",
  "Contents/Resources/AppIcon.icns",
  "Contents/Resources/Backend/gui-entry.mjs",
  ...webAssetNames.map((name) => `Contents/Resources/Backend/web/${name}`),
  "Contents/Resources/Runtime/node",
  "Contents/Resources/Licenses/Node/LICENSE",
  "Contents/Resources/Licenses/esbuild-metafile.json",
  "Contents/Resources/Licenses/manifest.json",
  "Contents/_CodeSignature/CodeResources"
]);

const manifestPackageNames = new Set();
for (const item of manifest.packages) {
  if (
    !item
    || typeof item.name !== "string"
    || manifestPackageNames.has(item.name)
    || typeof item.version !== "string"
    || typeof item.license !== "string"
    || !Number.isSafeInteger(item.inputCount)
    || item.inputCount < 1
    || !Array.isArray(item.files)
    || item.files.length < 1
  ) throw new Error("License manifest contains invalid package metadata");
  manifestPackageNames.add(item.name);
  for (const file of item.files) {
    if (!file || !safeLicenseManifestPath(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`License manifest contains an unsafe package file: ${item.name}`);
    }
    const path = join(licensesDir, file.path);
    if (!statSync(path).isFile() || statSync(path).size < 1 || sha256(path) !== file.sha256) {
      throw new Error(`Bundled package license does not match its manifest: ${item.name}`);
    }
    expectedFiles.add(`Contents/Resources/Licenses/${file.path}`);
  }
}

const metafileInputCounts = new Map();
for (const input of Object.keys(metafile.inputs ?? {})) {
  if (input.startsWith("/") || input.includes("..")) throw new Error("Esbuild metafile contains a non-portable input path");
  const packageName = packageNameFromInput(input);
  if (packageName) metafileInputCounts.set(packageName, (metafileInputCounts.get(packageName) ?? 0) + 1);
}
if (
  JSON.stringify([...manifestPackageNames].sort()) !== JSON.stringify([...metafileInputCounts.keys()].sort())
) throw new Error("Bundled package licenses do not correspond to the esbuild metafile");
for (const item of manifest.packages) {
  if (metafileInputCounts.get(item.name) !== item.inputCount) {
    throw new Error(`Bundled package input count does not match the esbuild metafile: ${item.name}`);
  }
}
for (const output of Object.values(metafile.outputs ?? {})) {
  for (const dependency of output.imports ?? []) {
    if (!dependency.external || !nodeBuiltinModules.has(dependency.path.replace(/^node:/, ""))) {
      throw new Error(`Portable backend has an unexpected external import: ${dependency.path}`);
    }
  }
}

if (
  manifest.node.executable !== "../Runtime/node"
  || manifest.node.sha256 !== sha256(runtimePath)
  || !Array.isArray(manifest.node.files)
  || manifest.node.files.length !== 1
  || manifest.node.files[0]?.path !== "Node/LICENSE"
  || manifest.node.files[0]?.sha256 !== sha256(join(licensesDir, "Node", "LICENSE"))
) throw new Error("Bundled Node runtime does not match its license manifest");
if (
  manifest.backend.entry !== "../Backend/gui-entry.mjs"
  || manifest.backend.sha256 !== sha256(backendPath)
  || !Array.isArray(manifest.backend.web)
  || manifest.backend.web.length !== webAssetNames.length
) throw new Error("Bundled backend does not match its manifest");
for (const name of webAssetNames) {
  const record = manifest.backend.web.find((item) => item?.path === `../Backend/web/${name}`);
  const path = join(appPath, "Contents", "Resources", "Backend", "web", name);
  if (!record || record.sha256 !== sha256(path)) throw new Error(`Bundled web asset does not match its manifest: ${name}`);
}

const bundleFiles = filesUnder(appPath);
for (const path of bundleFiles) {
  const name = relative(appPath, path).replaceAll("\\", "/");
  if (!expectedFiles.has(name)) throw new Error(`Unexpected app bundle file: ${name}`);
  if (/(^|\/)(?:\.env|data)(?:\/|$)|\.(?:session|sqlite|sqlite3|db|map|d\.ts)$/i.test(name)) {
    throw new Error(`Forbidden credential, data, or source artifact: ${name}`);
  }
  const bytes = readFileSync(path);
  if (
    name.startsWith("Contents/Resources/Backend/")
    && bytes.includes(Buffer.from("sourceMappingURL="))
  ) throw new Error(`Source map reference is forbidden: ${name}`);
  for (const forbidden of [projectDir, realpathSync(process.execPath), "/.nvm/"]) {
    if (bytes.includes(Buffer.from(forbidden))) throw new Error(`Build-host absolute runtime path leaked into app bundle: ${name}`);
  }
}
if (bundleFiles.length !== expectedFiles.size) throw new Error("App bundle allowlist is incomplete");

execFileSync("/usr/bin/plutil", ["-lint", join(appPath, "Contents", "Info.plist")], { stdio: "ignore" });
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "ignore" });
execFileSync("/usr/bin/codesign", ["--verify", "--strict", runtimePath], { stdio: "ignore" });
signatureDetails(runtimePath);
signatureDetails(appPath);
assertNoEntitlements(runtimePath);
assertNoEntitlements(appPath);
assertArm64SystemBinary(executablePath);
assertArm64SystemBinary(runtimePath);

const plist = JSON.parse(execFileSync("/usr/bin/plutil", [
  "-convert", "json", "-o", "-", join(appPath, "Contents", "Info.plist")
], { encoding: "utf8" }));
if (plist.CFBundleIdentifier !== "com.chatkjb.terminal") throw new Error("Info.plist bundle identifier changed");
if (plist.CFBundleIconFile !== "AppIcon") throw new Error("Info.plist must select the bundled AppIcon");
if (
  plist.CFBundleShortVersionString !== releaseVersion.shortVersion
  || plist.CFBundleVersion !== releaseVersion.buildNumber
) throw new Error("Info.plist version fields do not match package.json");
for (const forbidden of ["ChatKJBProjectPath", "ChatKJBNodePath", "ChatKJBBackendPath"]) {
  if (forbidden in plist) throw new Error(`Info.plist contains a build-host path key: ${forbidden}`);
}
const transport = plist.NSAppTransportSecurity;
if (!transport || transport.NSAllowsLocalNetworking !== true || Object.keys(transport).length !== 1) {
  throw new Error("Info.plist must allow local networking and no broader transport exception");
}

const environment = parseEnvironment(join(projectDir, ".env"));
const secretBuffers = [];
for (const [name, value] of environment) {
  if (!/(?:TOKEN|API_HASH|API_KEY|SECRET|PASSWORD)$/i.test(name)) continue;
  if (value.length < 12 || /replace-me|your-|example/i.test(value)) continue;
  secretBuffers.push(Buffer.from(value));
}
for (const name of ["TELEGRAM_GUI_SESSION_PATH", "TELEGRAM_MTPROTO_SESSION_PATH"]) {
  const configured = environment.get(name);
  if (!configured) continue;
  const path = resolve(projectDir, configured);
  if (existsSync(path) && lstatSync(path).isFile()) {
    const bytes = readFileSync(path);
    if (bytes.length > 0 && bytes.length <= 16 * 1024 * 1024) secretBuffers.push(bytes);
  }
}
for (const path of bundleFiles) {
  const bytes = readFileSync(path);
  if (secretBuffers.some((secret) => bytes.includes(secret))) {
    throw new Error("App bundle contains a configured secret or Telegram session payload");
  }
}

const runtimeVersion = execFileSync(runtimePath, ["--version"], {
  cwd: appPath,
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
  encoding: "utf8"
}).trim();
if (runtimeVersion !== `v${manifest.node.version}`) throw new Error("Bundled Node runtime version does not match its manifest");

const auditRoot = mkdtempSync(join(tmpdir(), "chatkjb-bundle-audit-"));
try {
  const configRoot = join(auditRoot, "Config Root");
  const homeRoot = join(auditRoot, "Home");
  const temporaryRoot = join(auditRoot, "Tmp");
  for (const path of [configRoot, homeRoot, temporaryRoot]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const runtimeSelfTest = spawnSync(runtimePath, [backendPath, "--runtime-self-test"], {
    cwd: configRoot,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: homeRoot,
      TMPDIR: temporaryRoot,
      USER: "chatkjb-audit",
      LOGNAME: "chatkjb-audit",
      LANG: "C",
      CHATKJB_CONFIG_BASE_DIR: configRoot
    },
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 64 * 1024
  });
  if (
    runtimeSelfTest.status !== 0
    || !runtimeSelfTest.stdout.includes("CHATKJB_GUI_RUNTIME_SELF_TEST_OK")
  ) throw new Error("Bundled backend runtime self-test failed in a sanitized environment");
} finally {
  rmSync(auditRoot, { recursive: true, force: true });
}

const iconSourceSha256 = sha256(iconSource);
if (iconSourceSha256 !== expectedIconSourceSha256) throw new Error("Canonical ChatKJB icon SVG hash changed");
const iconAuditDir = join(projectDir, ".artifacts", `.icon-audit-${process.pid}.iconset`);
rmSync(iconAuditDir, { recursive: true, force: true });
mkdirSync(iconAuditDir, { recursive: true });
try {
  execFileSync("/usr/bin/iconutil", [
    "-c", "iconset",
    join(appPath, "Contents", "Resources", "AppIcon.icns"),
    "-o", iconAuditDir
  ], { stdio: "ignore" });
  const expectedRepresentations = new Map([
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024]
  ]);
  for (const [name, size] of expectedRepresentations) {
    const path = join(iconAuditDir, name);
    if (!existsSync(path)) throw new Error(`App icon is missing ${name}`);
    const properties = execFileSync("/usr/bin/sips", [
      "-g", "pixelWidth",
      "-g", "pixelHeight",
      path
    ], { encoding: "utf8" });
    if (!properties.includes(`pixelWidth: ${size}`) || !properties.includes(`pixelHeight: ${size}`)) {
      throw new Error(`App icon representation has the wrong size: ${name}`);
    }
  }
} finally {
  rmSync(iconAuditDir, { recursive: true, force: true });
}

process.stdout.write(`ChatKJB Terminal portable bundle audit passed: ${bundleFiles.length} allowlisted files, embedded arm64 Node/backend, licenses matched to metafile, sanitized runtime self-test, exact SVG-derived icon 16-1024, ad-hoc signatures\n`);
