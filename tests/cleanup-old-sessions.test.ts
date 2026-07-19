import { describe, expect, it } from "vitest";

import {
  isSessionEligibleForCleanup,
  parseTelegramResponse,
} from "../scripts/cleanup-old-sessions.mjs";

describe("old session cleanup eligibility", () => {
  const cutoff = Date.UTC(2026, 6, 6, 5, 28);

  it("cleans an old terminal session without requiring a transcript dump", () => {
    expect(
      isSessionEligibleForCleanup(
        { updated_at: cutoff - 1, status: "done" },
        cutoff
      )
    ).toBe(true);
  });

  it("preserves recent and active sessions", () => {
    expect(
      isSessionEligibleForCleanup({ updated_at: cutoff + 1, status: "done" }, cutoff)
    ).toBe(false);
    expect(
      isSessionEligibleForCleanup({ updated_at: cutoff - 1, status: "running" }, cutoff)
    ).toBe(false);
  });

  it("requires Telegram API confirmation before treating a topic deletion as successful", () => {
    expect(parseTelegramResponse('{"ok":true,"result":true}').ok).toBe(true);
    expect(parseTelegramResponse('{"ok":false,"description":"Bad Request"}').ok).toBe(false);
    expect(parseTelegramResponse("not-json").ok).toBe(false);
  });
});
