import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgyCliSession } from "../src/agy-cli.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeFakeAgy(): { executable: string; cwd: string; logDir: string; } {
  const directory = mkdtempSync(join(tmpdir(), "chatkjb-agy-cli-"));
  directories.push(directory);
  const executable = join(directory, "agy");
  const logDir = join(directory, "logs");
  writeFileSync(executable, `#!/bin/sh
log=""
conversation=""
prompt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --log-file)
      shift
      log="$1"
      ;;
    --conversation)
      shift
      conversation="$1"
      ;;
    --print)
      shift
      prompt="$1"
      ;;
  esac
  shift
done
if [ -z "$conversation" ]; then
  conversation="11111111-2222-3333-4444-555555555555"
fi
mkdir -p "$(dirname "$log")"
printf 'I0000 printmode.go:156] Print mode: conversation=%s, sending message\\n' "$conversation" > "$log"
# 환경변수 노출 여부 검증용: GEMINI_API_KEY가 있으면 응답에 포함
if [ -n "$GEMINI_API_KEY" ]; then
  printf 'GEMINI_LEAKED:%s\\n' "$GEMINI_API_KEY"
else
  printf 'answer:%s\\n' "$prompt"
fi
`);
  chmodSync(executable, 0o755);
  return { executable, cwd: directory, logDir };
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["GEMINI_API_KEY"];
  delete env["GOOGLE_API_KEY"];
  return env;
}

describe("AgyCliSession", () => {
  it("runs print mode and captures the CLI conversation id from the log", async () => {
    const fake = makeFakeAgy();
    const session = new AgyCliSession({
      executable: fake.executable,
      cwd: fake.cwd,
      model: "gemini-3.5-flash",
      permissionArgs: [],
      conversationId: null,
      env: cleanEnv(),
      logDir: fake.logDir
    });

    const result = await session.runTurn("hello");

    expect(result.response).toBe("answer:hello");
    expect(result.conversationId).toBe("11111111-2222-3333-4444-555555555555");
    expect(readdirSync(fake.logDir)).toEqual([]);
  });

  it("passes the stored conversation id to the next print-mode turn", async () => {
    const fake = makeFakeAgy();
    const session = new AgyCliSession({
      executable: fake.executable,
      cwd: fake.cwd,
      model: "gemini-3.5-flash",
      permissionArgs: [],
      conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      env: cleanEnv(),
      logDir: fake.logDir
    });

    const result = await session.runTurn("again");

    expect(result.response).toBe("answer:again");
    expect(result.conversationId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("does not leak GEMINI_API_KEY to the CLI subprocess when excluded from env", async () => {
    const fake = makeFakeAgy();
    // GEMINI_API_KEY가 제거된 env를 넘기면 CLI subprocess에 노출되지 않아야 한다.
    const cleanEnv = { ...process.env };
    delete cleanEnv["GEMINI_API_KEY"];
    delete cleanEnv["GOOGLE_API_KEY"];
    const session = new AgyCliSession({
      executable: fake.executable,
      cwd: fake.cwd,
      model: "Gemini 3.5 Flash (Medium)",
      permissionArgs: [],
      conversationId: null,
      env: cleanEnv,
      logDir: fake.logDir
    });

    const result = await session.runTurn("check-env");

    expect(result.response).not.toContain("GEMINI_LEAKED");
    expect(result.response).toBe("answer:check-env");
  });

  it("settles when the abort signal was already cancelled before launch", async () => {
    const fake = makeFakeAgy();
    const controller = new AbortController();
    controller.abort();
    const session = new AgyCliSession({
      executable: fake.executable,
      cwd: fake.cwd,
      model: "gemini-3.5-flash",
      permissionArgs: [],
      conversationId: null,
      env: cleanEnv(),
      logDir: fake.logDir
    });

    await expect(session.runTurn("cancelled", controller.signal))
      .rejects.toThrow("turn aborted");
  });

  it("confirms that unsanitized env would expose GEMINI_API_KEY (regression guard)", async () => {
    const fake = makeFakeAgy();
    const leakyEnv = { ...process.env, GEMINI_API_KEY: "leaked-key-for-test" };
    const session = new AgyCliSession({
      executable: fake.executable,
      cwd: fake.cwd,
      model: "Gemini 3.5 Flash (Medium)",
      permissionArgs: [],
      conversationId: null,
      env: leakyEnv,
      logDir: fake.logDir
    });

    const result = await session.runTurn("check-env");
    expect(result.response).toContain("GEMINI_LEAKED");
  });
});
