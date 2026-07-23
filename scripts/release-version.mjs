import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MACOS_VERSION_PLACEHOLDER = "__CHATKJB_VERSION__";
export const MACOS_BUILD_NUMBER_PLACEHOLDER = "__CHATKJB_BUILD_NUMBER__";

// CFBundleVersion은 양의 정수 하나로 고정한다. 각 SemVer 구성요소를 세 자리로
// 배정하면 SemVer 순서가 그대로 유지되고 최대 999,999,999라 안전한 정수 범위다.
const MAX_VERSION_COMPONENT = 999;
const SEMVER_RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function releaseVersionFromSemver(version) {
  if (typeof version !== "string") throw new Error("package.json version must be a string");
  const match = version.match(SEMVER_RELEASE);
  if (!match) {
    throw new Error(
      "package.json version must be a release SemVer (major.minor.patch without prerelease or build metadata)"
    );
  }

  const components = match.slice(1).map(Number);
  if (components.some((component) => component > MAX_VERSION_COMPONENT)) {
    throw new Error(
      `package.json version components must be at most ${MAX_VERSION_COMPONENT} for a safe CFBundleVersion`
    );
  }

  const [major, minor, patch] = components;
  const buildNumber = (major * 1_000_000) + (minor * 1_000) + patch;
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) {
    throw new Error("package.json version must produce a positive safe CFBundleVersion");
  }

  return {
    shortVersion: version,
    buildNumber: String(buildNumber)
  };
}

export function readReleaseVersion(projectDir) {
  const packageJson = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
  return releaseVersionFromSemver(packageJson.version);
}

export function renderMacosInfoPlist(template, releaseVersion) {
  const placeholders = [MACOS_VERSION_PLACEHOLDER, MACOS_BUILD_NUMBER_PLACEHOLDER];
  for (const placeholder of placeholders) {
    const count = template.split(placeholder).length - 1;
    if (count !== 1) throw new Error(`Info.plist template must contain ${placeholder} exactly once`);
  }

  const rendered = template
    .replace(MACOS_VERSION_PLACEHOLDER, releaseVersion.shortVersion)
    .replace(MACOS_BUILD_NUMBER_PLACEHOLDER, releaseVersion.buildNumber);
  if (rendered.includes("__CHATKJB_")) throw new Error("Info.plist has an unresolved build placeholder");
  return rendered;
}
