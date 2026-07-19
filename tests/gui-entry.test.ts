import { describe, expect, it } from "vitest";
import {
  GUI_RUNTIME_SELF_TEST_MARKER,
  isGuiRuntimeSelfTestMode,
  parseGuiControlFd
} from "../src/gui-entry.js";

describe("GUI entry dispatch", () => {
  it("selects runtime self-test only for the exact top-level flag", () => {
    expect(isGuiRuntimeSelfTestMode(["--runtime-self-test"])).toBe(true);
    for (const argv of [
      [],
      ["--runtime-self-test", "extra"],
      ["--control-fd", "3"],
      ["extra", "--runtime-self-test"]
    ]) expect(isGuiRuntimeSelfTestMode(argv)).toBe(false);
    expect(GUI_RUNTIME_SELF_TEST_MARKER).toBe("CHATKJB_GUI_RUNTIME_SELF_TEST_OK");
  });

  it("preserves the inherited control-fd parser for service mode", () => {
    expect(parseGuiControlFd(["--control-fd", "3"])).toBe(3);
    expect(parseGuiControlFd(["ignored", "--control-fd", "1024"])).toBe(1024);
    for (const argv of [
      [],
      ["--control-fd", "2"],
      ["--control-fd", "1025"],
      ["--control-fd", "not-a-number"]
    ]) expect(() => parseGuiControlFd(argv)).toThrow(/control-fd/);
  });
});
