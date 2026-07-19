import { describe, expect, it } from "vitest";
import {
  COMPILE_NOTIFY_BODY_LIMIT,
  TELEGRAM_TEXT_LIMIT,
  buildCompileNotifyText,
  fitTelegramText,
  isTransientTelegramError,
  summarizeCompileOutput
} from "../src/bot/wiki-compile.js";

describe("fitTelegramText", () => {
  it("leaves short text unchanged", () => {
    expect(fitTelegramText("hello")).toBe("hello");
  });

  it("caps at the Telegram hard limit", () => {
    const huge = "x".repeat(TELEGRAM_TEXT_LIMIT + 500);
    const fitted = fitTelegramText(huge);
    expect(fitted.length).toBe(TELEGRAM_TEXT_LIMIT);
    expect(fitted.endsWith("...")).toBe(true);
  });
});

describe("summarizeCompileOutput", () => {
  it("keeps only the last few lines and respects the body limit", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}:${"y".repeat(200)}`);
    const summary = summarizeCompileOutput(lines.join("\n"));
    expect(summary.length).toBeLessThanOrEqual(COMPILE_NOTIFY_BODY_LIMIT);
    expect(summary).toContain("line-29");
    expect(summary).not.toContain("line-0:");
  });

  it("handles a single enormous line without newlines", () => {
    const summary = summarizeCompileOutput("z".repeat(50_000));
    expect(summary.length).toBeLessThanOrEqual(COMPILE_NOTIFY_BODY_LIMIT);
  });
});

describe("buildCompileNotifyText", () => {
  it("never exceeds the Telegram message limit even with a huge detail body", () => {
    const text = buildCompileNotifyText(
      "LLM-Wiki compile 및 KJB Wiki 공개 그래프 배포 완료.",
      "detail\n".repeat(5_000) + "x".repeat(20_000)
    );
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(text.startsWith("LLM-Wiki compile")).toBe(true);
  });
});

describe("isTransientTelegramError", () => {
  it("treats message-is-too-long as non-retryable", () => {
    expect(isTransientTelegramError({
      error_code: 400,
      description: "Bad Request: message is too long"
    })).toBe(false);
    expect(isTransientTelegramError(new Error(
      "GrammyError: Call to 'sendMessage' failed! (400: Bad Request: message is too long)"
    ))).toBe(false);
  });

  it("treats network-style failures as retryable", () => {
    expect(isTransientTelegramError(new Error(
      "HttpError: Network request for 'sendMessage' failed!"
    ))).toBe(true);
    expect(isTransientTelegramError({ error_code: 429, parameters: { retry_after: 2 } }))
      .toBe(true);
  });
});
