import { join } from "node:path";

export function filesystemPath(path: string): string {
  if (!path.startsWith("smb://")) return path;
  const url = new URL(path);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const share = parts.shift();
  if (!share) {
    throw new Error(`SMB 경로에 공유 이름이 없습니다: ${path}`);
  }
  return join("/Volumes", share, ...parts);
}
