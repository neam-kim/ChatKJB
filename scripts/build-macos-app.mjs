#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as bundleWithEsbuild } from "esbuild";
import { buildAppIcon } from "./macos-icon.mjs";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = join(projectDir, ".artifacts");
const buildDir = join(artifactsDir, `.macos-build-${process.pid}`);
const appPath = join(artifactsDir, "ChatKJB Terminal.app");
const contents = join(appPath, "Contents");
const executableDir = join(contents, "MacOS");
const executablePath = join(executableDir, "ChatKJBTerminal");
const resourcesDir = join(contents, "Resources");
const backendDir = join(resourcesDir, "Backend");
const backendWebDir = join(backendDir, "web");
const bundledBackendPath = join(backendDir, "gui-entry.mjs");
const runtimeDir = join(resourcesDir, "Runtime");
const runtimePath = join(runtimeDir, "node");
const licensesDir = join(resourcesDir, "Licenses");
const packageLicensesDir = join(licensesDir, "Packages");
const sourceBackendPath = join(projectDir, "dist", "gui-entry.js");
const sourceWebDir = join(projectDir, "dist", "gui", "web");
const swiftSource = join(projectDir, "native", "macos", "ChatKJBTerminal.swift");
const cSource = join(projectDir, "native", "macos", "backend_spawn.c");
const cObject = join(buildDir, "backend_spawn.o");
const iconSource = join(projectDir, "native", "macos", "jb-logo.svg");
const expectedIconSourceSha256 = "884f0791c73f826f12180ad7acb2cfa2dd286e8baf1d9153c348fafbfa7f7b76";
const webAssetNames = ["app.js", "index.html", "manifest.webmanifest", "styles.css"];

if (process.platform !== "darwin") throw new Error("ChatKJB Terminal.app can only be built on macOS");
if (process.arch !== "arm64") throw new Error("This build currently targets the verified arm64 Mac runtime");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packageNameFromInput(input) {
  return input.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/|$)/)?.[1] ?? null;
}

function packageLicenseDirectoryName(packageName) {
  return packageName.replace(/^@/, "at-").replaceAll("/", "__");
}

function copyBundledPackageLicenses(metafile) {
  const inputCounts = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const packageName = packageNameFromInput(input);
    if (packageName) inputCounts.set(packageName, (inputCounts.get(packageName) ?? 0) + 1);
  }

  const packages = [];
  for (const packageName of [...inputCounts.keys()].sort()) {
    const packageRoot = join(projectDir, "node_modules", ...packageName.split("/"));
    const packageJsonPath = join(packageRoot, "package.json");
    if (!statSync(packageRoot).isDirectory() || !statSync(packageJsonPath).isFile()) {
      throw new Error(`Bundled package metadata is unavailable: ${packageName}`);
    }
    const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const rootFiles = readdirSync(packageRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    let legalFiles = rootFiles.filter((name) => /^(?:licen[cs]e|notice|copying)(?:[._-].*)?$/i.test(name));
    if (legalFiles.length === 0) {
      legalFiles = rootFiles.filter((name) => /^readme(?:[._-].*)?$/i.test(name)).slice(0, 1);
    }
    if (legalFiles.length === 0) throw new Error(`Bundled package has no license or notice text: ${packageName}`);

    const destinationDirectory = join(packageLicensesDir, packageLicenseDirectoryName(packageName));
    mkdirSync(destinationDirectory, { recursive: true, mode: 0o755 });
    const files = [];
    for (const filename of legalFiles.sort()) {
      const source = join(packageRoot, filename);
      const destination = join(destinationDirectory, filename);
      copyFileSync(source, destination);
      const manifestPath = relative(licensesDir, destination).replaceAll("\\", "/");
      files.push({ path: manifestPath, sha256: sha256(destination) });
    }
    packages.push({
      name: packageName,
      version: typeof metadata.version === "string" ? metadata.version : "unknown",
      license: typeof metadata.license === "string" ? metadata.license : "SEE_BUNDLED_TEXT",
      inputCount: inputCounts.get(packageName),
      files
    });
  }
  return packages;
}

mkdirSync(artifactsDir, { recursive: true });
rmSync(buildDir, { recursive: true, force: true });
rmSync(appPath, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
mkdirSync(executableDir, { recursive: true });
mkdirSync(backendWebDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(packageLicensesDir, { recursive: true });

try {
  const iconSourceSha256 = sha256(iconSource);
  if (iconSourceSha256 !== expectedIconSourceSha256) {
    throw new Error("Canonical ChatKJB icon SVG does not match the attached source hash");
  }
  // 데몬 래퍼 앱(ChatKJB.app)과 같은 생성기를 쓴다.
  buildAppIcon({
    projectDir,
    buildDir,
    outputIcnsPath: join(resourcesDir, "AppIcon.icns")
  });

  const bundleResult = await bundleWithEsbuild({
    absWorkingDir: projectDir,
    entryPoints: [relative(projectDir, sourceBackendPath)],
    outfile: bundledBackendPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    banner: {
      js: 'import { createRequire as __chatkjbCreateRequire } from "node:module"; const require = __chatkjbCreateRequire(import.meta.url);'
    },
    metafile: true,
    preserveSymlinks: true,
    sourcemap: false,
    sourcesContent: false,
    legalComments: "none",
    logLevel: "info"
  });
  for (const name of webAssetNames) copyFileSync(join(sourceWebDir, name), join(backendWebDir, name));

  const runtimeSource = realpathSync(process.execPath);
  if (!lstatSync(runtimeSource).isFile()) throw new Error("Node runtime must be a regular file");
  copyFileSync(runtimeSource, runtimePath);
  chmodSync(runtimePath, 0o755);
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign", "-",
    "--timestamp=none",
    runtimePath
  ], { cwd: projectDir, stdio: "inherit" });
  const nodeRoot = resolve(dirname(runtimeSource), "..");
  const nodeLicenseSource = join(nodeRoot, "LICENSE");
  if (!statSync(nodeLicenseSource).isFile()) throw new Error("Node.js license file is unavailable");
  const nodeLicenseDir = join(licensesDir, "Node");
  mkdirSync(nodeLicenseDir, { recursive: true });
  const nodeLicensePath = join(nodeLicenseDir, "LICENSE");
  copyFileSync(nodeLicenseSource, nodeLicensePath);

  const packages = copyBundledPackageLicenses(bundleResult.metafile);
  const metafilePath = join(licensesDir, "esbuild-metafile.json");
  writeFileSync(metafilePath, `${JSON.stringify(bundleResult.metafile, null, 2)}\n`, { mode: 0o644 });
  const licenseManifest = {
    schemaVersion: 1,
    node: {
      version: process.versions.node,
      executable: "../Runtime/node",
      sha256: sha256(runtimePath),
      files: [{ path: "Node/LICENSE", sha256: sha256(nodeLicensePath) }]
    },
    backend: {
      entry: "../Backend/gui-entry.mjs",
      sha256: sha256(bundledBackendPath),
      web: webAssetNames.map((name) => ({
        path: `../Backend/web/${name}`,
        sha256: sha256(join(backendWebDir, name))
      }))
    },
    packages
  };
  writeFileSync(join(licensesDir, "manifest.json"), `${JSON.stringify(licenseManifest, null, 2)}\n`, { mode: 0o644 });

  execFileSync("/usr/bin/xcrun", [
    "clang",
    "-c",
    "-O2",
    "-arch", "arm64",
    "-mmacosx-version-min=14.0",
    cSource,
    "-o", cObject
  ], { cwd: projectDir, stdio: "inherit" });
  execFileSync("/usr/bin/xcrun", [
    "swiftc",
    "-O",
    "-target", "arm64-apple-macosx14.0",
    "-framework", "AppKit",
    "-framework", "CoreImage",
    "-framework", "WebKit",
    swiftSource,
    cObject,
    "-o", executablePath
  ], { cwd: projectDir, stdio: "inherit" });
  chmodSync(executablePath, 0o755);

  const plist = readFileSync(join(projectDir, "native", "macos", "Info.plist"), "utf8");
  if (/__CHATKJB_|<key>ChatKJB(?:Project|Node|Backend)Path<\/key>/.test(plist)) {
    throw new Error("Info.plist must not contain build-host runtime paths");
  }
  writeFileSync(join(contents, "Info.plist"), plist, { mode: 0o644 });

  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign", "-",
    "--timestamp=none",
    appPath
  ], { cwd: projectDir, stdio: "inherit" });
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}

process.stdout.write(`${appPath}\n`);
