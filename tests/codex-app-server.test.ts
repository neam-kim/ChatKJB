import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerGoalClient } from "../src/codex-app-server.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CodexAppServerGoalClient", () => {
  it("uses the shared Codex environment for launchd PATH and account selection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-codex-goal-env-"));
    cleanup.push(directory);
    const executable = join(directory, "fake-codex");
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require("node:readline");
if (process.env.CODEX_HOME !== process.env.EXPECT_CODEX_HOME) process.exit(21);
if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) process.exit(22);
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (typeof message.id !== "number") return;
  process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
});
`);
    chmodSync(executable, 0o700);

    const previous = {
      PATH: process.env.PATH,
      CODEX_HOME: process.env.CODEX_HOME,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      EXPECT_CODEX_HOME: process.env.EXPECT_CODEX_HOME
    };
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    process.env.CODEX_HOME = "/tmp/wrong-codex-home";
    process.env.OPENAI_API_KEY = "must-not-leak";
    process.env.CODEX_API_KEY = "must-not-leak";
    process.env.EXPECT_CODEX_HOME = directory;
    try {
      // 전체 Vitest 병렬 실행에서는 Node shebang 자식의 콜드스타트가 1초를 넘을 수 있다.
      const client = new CodexAppServerGoalClient(3_000, executable);
      await expect(client.setGoal("thread-1", "테스트 통과", { codexHome: directory }))
        .resolves.toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("rejects a request when app-server never responds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-codex-goal-"));
    cleanup.push(directory);
    const executable = join(directory, "hanging-codex");
    writeFileSync(executable, "#!/bin/sh\nsleep 10\n");
    chmodSync(executable, 0o700);
    const client = new CodexAppServerGoalClient(20, executable);

    await expect(client.setGoal("thread-1", "테스트 통과"))
      .rejects.toThrow("initialize 요청 시간이 초과되었습니다");
  });
});
