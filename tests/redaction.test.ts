import { describe, expect, it } from "vitest";
import { redactSensitiveText, redactSensitiveValue } from "../src/redaction.js";

describe("persistent evidence redaction", () => {
  it("redacts subscription tokens, API keys, bearer tokens, and Telegram bot tokens", () => {
    const oauthToken = `sk-ant-oat01-${"secret_value"}`;
    const apiKey = `sk-${"a".repeat(24)}`;
    const telegramToken = `123456789:${"A".repeat(32)}`;
    const text = [
      `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`,
      `OPENAI_API_KEY=${apiKey}`,
      "Authorization: Bearer abc.def-ghi",
      `bot=${telegramToken}`
    ].join("\n");

    const redacted = redactSensitiveText(text);
    expect(redacted).not.toContain("secret_value");
    expect(redacted).not.toContain(apiKey);
    expect(redacted).not.toContain("abc.def-ghi");
    expect(redacted).not.toContain(telegramToken);
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBe(4);
  });

  it("redacts nested evidence values without changing non-string fields", () => {
    expect(redactSensitiveValue({
      output: "PASSWORD=hunter2",
      exitCode: 0,
      nested: ["Bearer token-value"]
    })).toEqual({
      output: "PASSWORD=[REDACTED]",
      exitCode: 0,
      nested: ["[REDACTED]"]
    });
  });
});
