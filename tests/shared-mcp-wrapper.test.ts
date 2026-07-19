import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function closed(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; }> {
  return new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`file was not created: ${path}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

describe("shared MCP wrapper", () => {
  it("starts one connector owner per Codex parent and drops child duplicates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-mcp-owner-test-"));
    cleanup.push(directory);
    const starts = join(directory, "starts.txt");
    const fakeServer = join(directory, "fake-server.cjs");
    writeFileSync(fakeServer, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(starts)}, String(process.pid) + "\\n");
setInterval(() => {}, 1000);
`);
    chmodSync(fakeServer, 0o700);
    const registry = join(directory, "connectors.json");
    writeFileSync(registry, JSON.stringify({
      sample: { type: "stdio", command: process.execPath, args: [fakeServer] }
    }));
    const wrapper = resolve("scripts/run-shared-mcp.mjs");
    const args = [wrapper, registry, "sample", "--single-owner-per-parent"];
    const owner = spawn(process.execPath, args, { stdio: "ignore" });

    try {
      await waitForFile(starts);
      const duplicate = spawn(process.execPath, args, { stdio: "ignore" });
      const duplicateExit = await closed(duplicate);

      expect(duplicateExit).toEqual({ code: 0, signal: null });
      expect(readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      owner.kill("SIGTERM");
      await closed(owner);
    }
  }, 5_000);
});
