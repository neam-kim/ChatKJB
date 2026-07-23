export interface ReleaseVersion {
  shortVersion: string;
  buildNumber: string;
}

export const MACOS_VERSION_PLACEHOLDER: "__CHATKJB_VERSION__";
export const MACOS_BUILD_NUMBER_PLACEHOLDER: "__CHATKJB_BUILD_NUMBER__";

export function releaseVersionFromSemver(version: unknown): ReleaseVersion;
export function readReleaseVersion(projectDir: string): ReleaseVersion;
export function renderMacosInfoPlist(template: string, releaseVersion: ReleaseVersion): string;
