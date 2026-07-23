import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MACOS_BUILD_NUMBER_PLACEHOLDER,
  MACOS_VERSION_PLACEHOLDER,
  readReleaseVersion,
  releaseVersionFromSemver,
  renderMacosInfoPlist
} from "../scripts/release-version.mjs";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const plistTemplate = readFileSync(resolve(root, "native/macos/Info.plist"), "utf8");

describe("출시 버전 정본 계약", () => {
  it("package.json의 정식 SemVer를 macOS 표시 버전과 안전한 정수 빌드 번호로 고정 변환한다", () => {
    const version = readReleaseVersion(root);
    expect(version.shortVersion).toBe(packageJson.version);
    expect(version.buildNumber).toMatch(/^[1-9]\d*$/);
    expect(Number.isSafeInteger(Number(version.buildNumber))).toBe(true);
    expect(releaseVersionFromSemver("1.2.3")).toEqual({ shortVersion: "1.2.3", buildNumber: "1002003" });
  });

  it("macOS plist 템플릿의 두 버전 필드를 package.json 정본으로만 주입한다", () => {
    const version = readReleaseVersion(root);
    const plist = renderMacosInfoPlist(plistTemplate, version);
    expect(plistTemplate).toContain(MACOS_VERSION_PLACEHOLDER);
    expect(plistTemplate).toContain(MACOS_BUILD_NUMBER_PLACEHOLDER);
    expect(plist).toContain(`<string>${version.shortVersion}</string>`);
    expect(plist).toContain(`<string>${version.buildNumber}</string>`);
    expect(plist).not.toContain("__CHATKJB_");
  });

  it("Apple 번들에 주입할 수 없는 버전과 안전한 범위를 넘는 구성요소를 거부한다", () => {
    for (const version of ["0.0.0", "1.2.3-rc.1", "1.2.3+build.4", "1.2", "1.2.1000"]) {
      expect(() => releaseVersionFromSemver(version)).toThrow();
    }
  });
});
