import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeExecutablePath,
  resolveCliExecutable
} from "../src/cli-resolver.js";

describe("CLI resolver", () => {
  it("normalizes explicit executable paths", () => {
    expect(normalizeExecutablePath("./bin/tool")).toMatch(/\/bin\/tool$/);
  });

  it("prefers explicit paths over candidates and PATH", () => {
    expect(resolveCliExecutable({
      explicit: "/tmp/custom-tool",
      binaryName: "tool",
      candidates: ["/tmp/other-tool"],
      env: { PATH: "" }
    })).toBe("/tmp/custom-tool");
  });

  it("uses executable candidates before PATH lookup", () => {
    const dir = mkdtempSync(join(tmpdir(), "chatkjb-cli-"));
    const candidate = join(dir, "tool");
    writeFileSync(candidate, "#!/bin/sh\nexit 0\n");
    chmodSync(candidate, 0o755);
    expect(resolveCliExecutable({
      binaryName: "tool",
      candidates: [candidate],
      env: { PATH: "" }
    })).toBe(candidate);
  });

  it("falls back to PATH lookup and then the binary name", () => {
    const dir = mkdtempSync(join(tmpdir(), "chatkjb-cli-path-"));
    const candidate = join(dir, "tool");
    writeFileSync(candidate, "#!/bin/sh\nexit 0\n");
    chmodSync(candidate, 0o755);
    expect(resolveCliExecutable({
      binaryName: "tool",
      env: { PATH: dir }
    })).toBe(candidate);
    expect(resolveCliExecutable({
      binaryName: "missing-tool",
      env: { PATH: "" }
    })).toBe("missing-tool");
  });

  it("finds provider CLIs in the Node bin recorded by the LaunchAgent", () => {
    const dir = mkdtempSync(join(tmpdir(), "chatkjb-cli-node-bin-"));
    const candidate = join(dir, "provider-cli");
    writeFileSync(candidate, "#!/bin/sh\nexit 0\n");
    chmodSync(candidate, 0o755);

    expect(resolveCliExecutable({
      binaryName: "provider-cli",
      env: {
        PATH: "/usr/bin:/bin",
        CHATKJB_NODE_BIN: dir
      }
    })).toBe(candidate);
  });
});
