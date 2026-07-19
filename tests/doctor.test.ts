import { describe, expect, it } from "vitest";
import { firstVersionLine, formatAgentCliVersionLine } from "../src/doctor.js";

describe("doctor CLI version formatting", () => {
  it("uses the first non-empty line from mixed stdout and stderr output", () => {
    expect(firstVersionLine("\n\ncodex-cli 0.142.5\nextra detail")).toBe("codex-cli 0.142.5");
    expect(firstVersionLine("\n  1.0.16  \n")).toBe("1.0.16");
    expect(firstVersionLine("\n\n")).toBeNull();
  });

  it("prints the executable path with the version used by the bot", () => {
    expect(formatAgentCliVersionLine("Codex CLI", "/opt/homebrew/bin/codex", "codex-cli 0.142.5"))
      .toBe("✅ Codex CLI: /opt/homebrew/bin/codex · 버전 codex-cli 0.142.5");
    expect(formatAgentCliVersionLine("Grok CLI", "/Users/me/.local/bin/grok", "grok 1.2.3"))
      .toBe("✅ Grok CLI: /Users/me/.local/bin/grok · 버전 grok 1.2.3");
  });
});
