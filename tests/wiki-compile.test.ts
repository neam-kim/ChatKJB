import { describe, expect, it } from "vitest";
import {
  TELEGRAM_TEXT_LIMIT,
  buildCompileNotifyText,
  isTransientTelegramError,
  splitTelegramText,
  summarizeCompileOutput
} from "../src/bot/wiki-compile.js";

describe("splitTelegramText", () => {
  it("leaves short text as a single chunk", () => {
    expect(splitTelegramText("hello")).toEqual(["hello"]);
  });

  it("splits oversized text into sequential chunks without discarding content", () => {
    const partA = "a".repeat(3000);
    const partB = "b".repeat(3000);
    const partC = "c".repeat(500);
    const source = `${partA}\n${partB}\n${partC}`;
    const chunks = splitTelegramText(source);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= TELEGRAM_TEXT_LIMIT)).toBe(true);
    expect(chunks.join("")).toBe(source);
  });

  it("hard-splits a single line longer than the limit without loss", () => {
    const source = "x".repeat(TELEGRAM_TEXT_LIMIT + 500);
    const chunks = splitTelegramText(source);
    expect(chunks.length).toBe(2);
    expect(chunks.every((chunk) => chunk.length <= TELEGRAM_TEXT_LIMIT)).toBe(true);
    expect(chunks.join("")).toBe(source);
  });
});

describe("summarizeCompileOutput", () => {
  it("keeps only the last few non-empty lines", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}:${"y".repeat(40)}`);
    const summary = summarizeCompileOutput(lines.join("\n"));
    expect(summary).toContain("line-29");
    expect(summary).toContain("line-22");
    expect(summary).not.toContain("line-0:");
    expect(summary.split("\n")).toHaveLength(8);
  });

  it("preserves a single enormous line so callers can split it for Telegram", () => {
    const summary = summarizeCompileOutput("z".repeat(50_000));
    expect(summary.length).toBe(50_000);
  });
});

describe("buildCompileNotifyText", () => {
  it("keeps the full title and detail so notify can split instead of discard", () => {
    const detail = "detail\n".repeat(5_000) + "x".repeat(20_000);
    const text = buildCompileNotifyText(
      "LLM-Wiki compile 및 KJB Wiki 공개 그래프 배포 완료.",
      detail
    );
    expect(text.startsWith("LLM-Wiki compile")).toBe(true);
    expect(text).toContain("detail");
    expect(text).toContain("x".repeat(100));
    expect(text.length).toBeGreaterThan(TELEGRAM_TEXT_LIMIT);
    const chunks = splitTelegramText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= TELEGRAM_TEXT_LIMIT)).toBe(true);
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
