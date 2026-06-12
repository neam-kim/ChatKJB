import { describe, expect, it } from "vitest";
import { safeErrorMessage } from "../src/telegram-transport.js";

describe("Telegram transport logging", () => {
  it("redacts Telegram and Claude credentials from error messages", () => {
    const telegramToken = "123456789:secret-token";
    const oauthToken = "sk-ant-oat01-secret_token";
    const error = new Error(
      `request to https://api.telegram.org/bot${telegramToken}/send failed with ${oauthToken}`
    );

    const message = safeErrorMessage(error, [telegramToken, oauthToken]);

    expect(message).not.toContain(telegramToken);
    expect(message).not.toContain(oauthToken);
    expect(message).toContain("[REDACTED]");
  });
});
