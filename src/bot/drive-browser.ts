import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { displayDriveLabel } from "./formatting.js";

export interface DriveEntry {
  label: string;
  path: string;
}

export interface FolderBrowserState {
  currentPath: string;
  directories: string[];
  drives: DriveEntry[] | null;
  rootPath: string;
  driveLabel: string;
}

export interface DriveDetectionOptions {
  home?: string;
  networkServersPath?: string;
  volumesPath?: string;
}

export function projectNameFromSelectedPath(path: string): string {
  return basename(path)
    .replace(/[^\p{L}\p{N} _.-]/gu, "-")
    .replace(/\s+/g, " ")
    .replace(/^[ ._-]+|[ ._-]+$/g, "")
    .slice(0, 32) || "project";
}

export function uniqueProjectName(baseName: string, existingNames: ReadonlySet<string>): string {
  let candidate = baseName;
  let suffixNumber = 2;
  while (existingNames.has(candidate.toLocaleLowerCase("en-US"))) {
    const suffix = `-${suffixNumber}`;
    candidate = `${baseName.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`;
    suffixNumber += 1;
  }
  return candidate;
}

/** env가 설정된 경우 해당 경로를 직접 루트로 반환. 없으면 undefined. */
export function envFolderBrowserRoot(): string | undefined {
  return process.env.CHATKJB_FOLDER_BROWSER_ROOT?.trim() || undefined;
}

export async function detectDrives(options: DriveDetectionOptions = {}): Promise<DriveEntry[]> {
  const home = options.home ?? homedir();
  const networkServersPath = options.networkServersPath ?? "/Network/Servers";
  const volumesPath = options.volumesPath ?? "/Volumes";
  const drives: DriveEntry[] = [];
  const seen = new Set<string>();

  const tryAdd = async (label: string, rawPath: string): Promise<void> => {
    try {
      const resolved = await realpath(rawPath);
      if (resolved === "/" || seen.has(resolved)) return;
      const info = await stat(resolved);
      if (!info.isDirectory()) return;
      seen.add(resolved);
      drives.push({ label, path: resolved });
    } catch {
      // 존재하지 않거나 접근 불가 — 제외
    }
  };

  // 1. ~/Library/CloudStorage/* 클라우드 마운트
  const cloudStorageDir = join(home, "Library", "CloudStorage");
  try {
    const entries = await readdir(cloudStorageDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith(".")) {
        await tryAdd(displayDriveLabel(entry.name), join(cloudStorageDir, entry.name));
      }
    }
  } catch {
    // CloudStorage 폴더 없음
  }

  // 2. iCloud Drive
  await tryAdd("iCloud Drive", join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"));

  // 3. 홈 디렉토리
  await tryAdd("홈", home);

  // 4. /Volumes/* (외장/네트워크 볼륨). Dirent가 symlink인 마운트도
  // realpath/stat 검증을 통과할 수 있으므로 isDirectory()로 미리 버리지 않는다.
  try {
    const vols = await readdir(volumesPath, { withFileTypes: true });
    for (const vol of vols) {
      if (!vol.name.startsWith(".")) {
        await tryAdd(displayDriveLabel(vol.name), join(volumesPath, vol.name));
      }
    }
  } catch {
    // Volumes 없음
  }

  // 5. macOS automount 네트워크 서버. SMB/NFS가 /Volumes 밖의
  // /Network/Servers 아래에 나타나는 구성도 프로젝트 후보로 포함한다.
  try {
    const servers = await readdir(networkServersPath, { withFileTypes: true });
    for (const server of servers) {
      if (!server.name.startsWith(".")) {
        await tryAdd(displayDriveLabel(server.name), join(networkServersPath, server.name));
      }
    }
  } catch {
    // Network/Servers 없음
  }

  const rank = (drive: DriveEntry): number => {
    if (drive.path.startsWith(cloudStorageDir)) return 0;
    if (drive.label === "iCloud Drive") return 1;
    if (drive.path === home) return 2;
    if (drive.path.startsWith(`${volumesPath}/`)) return 3;
    if (drive.path.startsWith(`${networkServersPath}/`)) return 4;
    return 5;
  };

  return drives.sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    return rankDiff !== 0 ? rankDiff : a.label.localeCompare(b.label, "ko-KR");
  });
}
