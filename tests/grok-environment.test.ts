import { describe, expect, it } from "vitest";
import { buildGrokSubscriptionEnvironment } from "../src/grok-environment.js";

describe("buildGrokSubscriptionEnvironment", () => {
  it("removes API-key credentials while preserving the subscription CLI environment", () => {
    const base = {
      PATH: "/usr/bin",
      HOME: "/tmp/grok-home",
      XAI_API_KEY: "api-key",
      GROK_CODE_XAI_API_KEY: "legacy-api-key",
      CHATKJB_MARKER: "keep"
    };

    expect(buildGrokSubscriptionEnvironment(base)).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/grok-home",
      CHATKJB_MARKER: "keep"
    });
    expect(base.XAI_API_KEY).toBe("api-key");
  });
});
