import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectDrives } from "../src/bot/drive-browser.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("drive detection", () => {
  it("includes CloudStorage symlinks and mounted network storage roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "chatkjb-drive-detection-"));
    directories.push(root);
    const home = join(root, "home");
    const cloudStorage = join(home, "Library", "CloudStorage");
    const cloudTarget = join(root, "cloud-target");
    const volumesPath = join(root, "Volumes");
    const smbShare = join(volumesPath, "Team SMB");
    const networkServersPath = join(root, "Network", "Servers");
    const nfsServer = join(networkServersPath, "lab-server");
    mkdirSync(cloudStorage, { recursive: true });
    mkdirSync(cloudTarget);
    mkdirSync(smbShare, { recursive: true });
    mkdirSync(nfsServer, { recursive: true });
    symlinkSync(cloudTarget, join(cloudStorage, "SynologyDrive-account"));
    symlinkSync("/", join(volumesPath, "Macintosh HD"));

    const drives = await detectDrives({ home, volumesPath, networkServersPath });

    expect(drives).toEqual(expect.arrayContaining([
      { label: "SynologyDrive", path: realpathSync(cloudTarget) },
      { label: "Team SMB", path: realpathSync(smbShare) },
      { label: "lab-server", path: realpathSync(nfsServer) }
    ]));
    expect(drives.some((drive) => drive.path === "/")).toBe(false);
  });
});
