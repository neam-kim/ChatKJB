import { describe, expect, it } from "vitest";

import { filesystemPath } from "../src/filesystem-path.js";

describe("filesystemPath", () => {
  it("macOS SMB URL을 마운트된 POSIX 경로로 변환한다", () => {
    expect(
      filesystemPath("smb://JB_Kim._smb._tcp.local/homes/mac_neam96/Experiment/DSSU%20GC")
    ).toBe("/Volumes/homes/mac_neam96/Experiment/DSSU GC");
  });

  it("이미 파일시스템 경로이면 그대로 둔다", () => {
    expect(filesystemPath("/Volumes/homes/mac_neam96/Experiment")).toBe(
      "/Volumes/homes/mac_neam96/Experiment"
    );
  });
});
