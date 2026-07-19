import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// 운영 위키는 마운트된 로컬 볼륨을 우선한다. CloudStorage 후보는 기존 설치와
// 외부 호스트의 호환 폴백으로만 유지한다.
export function wikiVaultCandidates(home: string): string[] {
  return [...mountedVolumeWikiCandidates(), ...cloudStorageWikiCandidates(home)];
}

// 마운트된 볼륨은 기기마다 다르므로, 실제로 LLM-Wiki가 존재하는 것만 후보로 돌려준다.
// 존재하지 않는 경로까지 넣으면 부팅 볼륨(/Volumes/Macintosh HD 등)이 항상 첫 후보가 되어
// 폴백 경로를 가로챈다.
export function mountedVolumeWikiCandidates(): string[] {
  const candidates: string[] = [];
  try {
    for (const entry of readdirSync("/Volumes", { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const candidate = join("/Volumes", entry.name, "LLM-Wiki");
      if (existsSync(candidate)) candidates.push(candidate);
    }
  } catch {
    /* /Volumes may not exist on non-macOS hosts. */
  }
  return [...new Set(candidates)];
}

export function cloudStorageWikiCandidates(home: string): string[] {
  const cloudStorage = join(home, "Library", "CloudStorage");
  const candidates: string[] = [];
  try {
    for (const entry of readdirSync(cloudStorage, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = join(cloudStorage, entry.name);
      if (/^GoogleDrive(?:[-_ ].*)?$/i.test(entry.name)) {
        candidates.push(...googleDriveWikiCandidates(root));
      } else if (/^SynologyDrive(?:[-_ ].*)?$/i.test(entry.name)) {
        candidates.push(join(root, "AI", "LLM-Wiki"), join(root, "LLM-Wiki"));
      } else {
        candidates.push(join(root, "LLM-Wiki"));
      }
    }
  } catch {
    /* CloudStorage may not exist on non-macOS hosts. */
  }
  return [...new Set(candidates)];
}

export function googleDriveWikiCandidates(root: string): string[] {
  const candidates = [
    join(root, "내 드라이브", "LLM-Wiki"),
    join(root, "My Drive", "LLM-Wiki"),
    join(root, "LLM-Wiki")
  ];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".Trash") continue;
      const child = join(root, entry.name);
      if (entry.name.normalize("NFC") === "내 드라이브" || entry.name === "My Drive") {
        candidates.push(join(child, "LLM-Wiki"), join(child, "AI", "LLM-Wiki"));
      } else {
        candidates.push(join(child, "LLM-Wiki"));
      }
    }
  } catch {
    /* Google Drive may not be mounted or readable. */
  }
  return candidates;
}
