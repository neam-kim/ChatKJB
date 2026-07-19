import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * 주어진 홈의 sessions 디렉토리에서 threadId로 끝나는 rollout 파일 절대경로를 찾는다.
 * 없으면 null.
 */
export function findRolloutFile(home: string, threadId: string): string | null {
  const root = join(home, "sessions");
  if (!threadId || !existsSync(root)) return null;
  let found: string | null = null;
  const walk = (dir: string): void => {
    if (found) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(`${threadId}.jsonl`)) found = p;
    }
  };
  walk(root);
  return found;
}

/**
 * fromHome의 rollout 파일을 toHome의 동일 상대경로로 복사한다.
 * 성공하면 대상 절대경로, 실패/원본없음이면 null.
 * 대상에 이미 있으면 복사를 생략하고 경로를 반환한다(멱등).
 */
export function copyRolloutToHome(
  fromHome: string,
  toHome: string,
  threadId: string
): string | null {
  const src = findRolloutFile(fromHome, threadId);
  if (!src) return null;
  const fromRoot = join(fromHome, "sessions");
  const rel = relative(fromRoot, src);
  const dest = join(toHome, "sessions", rel);
  try {
    if (existsSync(dest)) return dest;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return dest;
  } catch {
    return null;
  }
}
