import { describe, expect, it } from "vitest";

import { appLocale, appTimeZone, isValidTimeZone } from "../src/localization.js";
import { buildLocalDateNote } from "../src/session-prompts.js";

describe("portable localization", () => {
  it("uses an explicit IANA time zone and locale when configured", () => {
    expect(appTimeZone({ TZ: "Europe/Paris" })).toBe("Europe/Paris");
    expect(appLocale({ CHATKJB_LOCALE: "en-GB" })).toBe("en-GB");
  });

  it("validates IANA time zones", () => {
    expect(isValidTimeZone("Asia/Seoul")).toBe(true);
    expect(isValidTimeZone("not/a-time-zone")).toBe(false);
  });

  it("injects the configured deployment time zone into agent calendar guidance", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      expect(buildLocalDateNote()).toContain('timeZone 필드에 "America/New_York"');
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
