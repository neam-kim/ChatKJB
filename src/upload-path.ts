import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * 세션 프로젝트(cwd) 기준 상대경로만 허용해 안전하게 실제 파일 경로로 해석한다.
 * 절대경로·프로젝트 밖 경로·일반 파일이 아닌 경로는 거부한다.
 * /upload 명령과 에이전트 파일 전송 마커가 공유하는 단일 보안 관문이다.
 */
export async function resolveUploadPath(cwd: string, inputPath: string): Promise<string> {
  if (isAbsolute(inputPath)) {
    throw new Error("절대경로 업로드는 허용하지 않습니다. 세션 프로젝트 기준 상대경로를 입력하세요.");
  }
  const root = await realpath(cwd);
  const requested = resolve(root, inputPath);
  const actual = await realpath(requested);
  const offset = relative(root, actual);
  if (offset.startsWith("..") || isAbsolute(offset)) {
    throw new Error("세션 프로젝트 밖의 파일은 업로드할 수 없습니다.");
  }
  const info = await stat(actual);
  if (!info.isFile()) {
    throw new Error("일반 파일만 업로드할 수 있습니다.");
  }
  return actual;
}
