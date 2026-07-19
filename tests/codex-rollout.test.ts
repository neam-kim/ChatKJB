import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyRolloutToHome, findRolloutFile } from "../src/codex-rollout.js";

const THREAD_ID = "019f2360-797b-7f72-a844-e47c1155771b";
const ROLLOUT_NAME = `rollout-2026-07-05T00-00-00-${THREAD_ID}.jsonl`;

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "codex-rollout-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeHome(name: string): string {
  const home = join(tmpRoot, name);
  mkdirSync(home, { recursive: true });
  return home;
}

function placeRollout(home: string, content = '{"type":"session_meta"}'): string {
  const dir = join(home, "sessions", "2026", "07", "05");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, ROLLOUT_NAME);
  writeFileSync(p, content);
  return p;
}

describe("findRolloutFile", () => {
  it("중첩 디렉토리에서 threadId 파일을 찾는다", () => {
    const home = makeHome("home-a");
    const expected = placeRollout(home);
    expect(findRolloutFile(home, THREAD_ID)).toBe(expected);
  });

  it("sessions 폴더가 없으면 null을 반환한다", () => {
    const home = makeHome("home-empty");
    expect(findRolloutFile(home, THREAD_ID)).toBeNull();
  });

  it("threadId가 없으면 null을 반환한다", () => {
    const home = makeHome("home-a");
    placeRollout(home);
    expect(findRolloutFile(home, "")).toBeNull();
  });

  it("다른 threadId의 파일은 무시한다", () => {
    const home = makeHome("home-a");
    const dir = join(home, "sessions", "2026", "07", "05");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-2026-07-05T00-00-00-other-id.jsonl"), "{}");
    expect(findRolloutFile(home, THREAD_ID)).toBeNull();
  });
});

describe("copyRolloutToHome", () => {
  it("원본 파일을 대상 홈의 동일 상대경로로 복사한다", () => {
    const fromHome = makeHome("from");
    const toHome = makeHome("to");
    const content = '{"type":"session_meta","payload":{"id":"test"}}';
    placeRollout(fromHome, content);

    const dest = copyRolloutToHome(fromHome, toHome, THREAD_ID);
    expect(dest).not.toBeNull();
    expect(existsSync(dest!)).toBe(true);
    expect(readFileSync(dest!, "utf8")).toBe(content);
    // 상대경로(YYYY/MM/DD/파일명)가 그대로 유지되는지 확인
    expect(dest).toContain(join("sessions", "2026", "07", "05", ROLLOUT_NAME));
  });

  it("원본이 없으면 null을 반환한다", () => {
    const fromHome = makeHome("from-empty");
    const toHome = makeHome("to");
    expect(copyRolloutToHome(fromHome, toHome, THREAD_ID)).toBeNull();
  });

  it("대상에 이미 파일이 있으면 복사를 생략하고 경로를 반환한다(멱등)", () => {
    const fromHome = makeHome("from");
    const toHome = makeHome("to");
    placeRollout(fromHome, "original");

    const first = copyRolloutToHome(fromHome, toHome, THREAD_ID);
    expect(first).not.toBeNull();
    writeFileSync(first!, "already-there");

    // 두 번째 호출: 덮어쓰지 않고 경로만 반환
    const second = copyRolloutToHome(fromHome, toHome, THREAD_ID);
    expect(second).toBe(first);
    expect(readFileSync(second!, "utf8")).toBe("already-there");
  });

  it("3홈 연속 회전: A→B, B→C 체인 복사가 동작한다", () => {
    const homeA = makeHome("home-a");
    const homeB = makeHome("home-b");
    const homeC = makeHome("home-c");
    placeRollout(homeA);

    // A→B 복사
    const destB = copyRolloutToHome(homeA, homeB, THREAD_ID);
    expect(destB).not.toBeNull();
    expect(existsSync(destB!)).toBe(true);

    // B→C 복사 (B의 사본 기준)
    const destC = copyRolloutToHome(homeB, homeC, THREAD_ID);
    expect(destC).not.toBeNull();
    expect(existsSync(destC!)).toBe(true);
  });
});
