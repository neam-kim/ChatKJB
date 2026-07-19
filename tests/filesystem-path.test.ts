import { describe, expect, it } from "vitest";

import { filesystemPath } from "../src/filesystem-path.js";

describe("filesystemPath", () => {
  it("macOS SMB URL을 마운트된 POSIX 경로로 변환한다", () => {
    expect(
      filesystemPath("smb://nas.local/shared/Experiment/DSSU%20GC")
    ).toBe("/Volumes/shared/Experiment/DSSU GC");
  });

  it("이미 파일시스템 경로이면 그대로 둔다", () => {
    expect(filesystemPath("/Users/me/Library/CloudStorage/SynologyDrive-account/Experiment")).toBe(
      "/Users/me/Library/CloudStorage/SynologyDrive-account/Experiment"
    );
  });
});
