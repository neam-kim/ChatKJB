import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function makeFakeAgy(): { executable: string; cwd: string; logDir: string } {
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
printf 'answer:%s\\n' "$prompt"
`);
  chmodSync(executable, 0o755);
  return { executable, cwd: directory, logDir };
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
      env: process.env,
      logDir: fake.logDir
    });

    const result = await session.runTurn("hello");

    expect(result.response).toBe("answer:hello");
    expect(result.conversationId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("passes the stored conversation id to the next print-mode turn", async () => {
    const fake = makeFakeAgy();
    const session = new AgyCliSession({
      executable: fake.executable,
      cwd: fake.cwd,
      model: "gemini-3.5-flash",
      permissionArgs: [],
      conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      env: process.env,
      logDir: fake.logDir
    });

    const result = await session.runTurn("again");

    expect(result.response).toBe("answer:again");
    expect(result.conversationId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });
});
