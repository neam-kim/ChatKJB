import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCodexAccountHomes } from "../src/config.js";

const tmpDir = mkdtempSync(join(tmpdir(), "codex-test-"));

let createdDirs: string[] = [];

function makeHome(authMode?: string | null): string {
  const dir = mkdtempSync(join(tmpDir, "home-"));
  createdDirs.push(dir);
  if (authMode === null) {
    // Do not create auth.json
  } else if (authMode === undefined) {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  } else {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: authMode }));
  }
  return dir;
}

afterEach(() => {
  createdDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  createdDirs = [];
});

describe("parseCodexAccountHomes", () => {
  it("returns fallbackHome for undefined raw", () => {
    const result = parseCodexAccountHomes(undefined, "/tmp/fallback-home");
    expect(result).toEqual(["/tmp/fallback-home"]);
  });

  it("returns fallbackHome for empty raw", () => {
    const result = parseCodexAccountHomes("", "/tmp/fallback-home");
    expect(result).toEqual(["/tmp/fallback-home"]);
  });

  it("returns absolute paths for valid CSV input", () => {
    const home1 = makeHome();
    const home2 = makeHome();
    const result = parseCodexAccountHomes(`${home1},${home2}`, "/tmp/fallback-home");
    expect(result).toEqual([home1, home2]);
  });

  it("de-duplicates paths, keeping first occurrence", () => {
    const home = makeHome();
    const result = parseCodexAccountHomes(`${home},${home}`, "/tmp/fallback-home");
    expect(result).toEqual([home]);
  });

  it("throws when a dir is missing auth.json", () => {
    const home = makeHome(null);
    expect(() => parseCodexAccountHomes(home, "/tmp/fallback-home")).toThrow(/auth.json/);
  });

  it("throws when auth.json has wrong auth_mode", () => {
    const home = makeHome("other");
    expect(() => parseCodexAccountHomes(home, "/tmp/fallback-home")).toThrow(/chatgpt/);
  });

  it("throws for non-existent directory", () => {
    const nonExistent = join(tmpdir(), "definitely-missing-xyz");
    expect(() => parseCodexAccountHomes(nonExistent, "/tmp/fallback-home")).toThrow(/디렉터리/);
  });
});

