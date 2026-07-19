import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { projectSourceDir } from "../src/runtime-paths.js";

const originalProjectDir = process.env.CHATKJB_PROJECT_DIR;

afterEach(() => {
  if (originalProjectDir === undefined) delete process.env.CHATKJB_PROJECT_DIR;
  else process.env.CHATKJB_PROJECT_DIR = originalProjectDir;
});

describe("projectSourceDir", () => {
  it("resolves the repository root independently of the process working directory", () => {
    delete process.env.CHATKJB_PROJECT_DIR;
    const expected = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    expect(projectSourceDir()).toBe(expected);
  });

  it("keeps an explicit deployment root override", () => {
    process.env.CHATKJB_PROJECT_DIR = "~/chatkjb-runtime";
    expect(projectSourceDir()).toBe(resolve(homedir(), "chatkjb-runtime"));
  });
});
