#!/usr/bin/env node

import { existsSync } from "node:fs";
import { loadTelegramGuiConfig } from "../dist/config.js";
import { startGuiServer } from "../dist/gui/server.js";
import { TelegramUserClient } from "../dist/gui/telegram-user-client.js";

if (!process.argv.includes("--live") || !process.argv.includes("--revoke")) {
  throw new Error("Telegram GUI revoke requires explicit --live --revoke");
}

const config = await loadTelegramGuiConfig();
if (!existsSync(config.sessionPath)) throw new Error("Telegram GUI session file is already absent");
let authState = "signed_out";
const client = new TelegramUserClient({
  apiId: config.apiId,
  apiHash: config.apiHash,
  chatId: config.chatId,
  allowedUserIds: config.allowedUserIds,
  sessionPath: config.sessionPath,
  onAuthState: (state) => { authState = state.state; }
});
const server = await startGuiServer({ client });

try {
  await client.start();
  if (authState !== "ready") throw new Error("Telegram GUI session is not ready for revocation");
  const bootstrapUrl = server.takeBootstrapUrl();
  const bootstrap = await fetch(bootstrapUrl, { redirect: "manual" });
  if (bootstrap.status !== 303) throw new Error("GUI bootstrap did not issue the expected redirect");
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("GUI bootstrap did not issue a session cookie");

  const sessionResponse = await fetch(`${server.origin}/api/session`, { headers: { Cookie: cookie } });
  if (!sessionResponse.ok) throw new Error("GUI session bootstrap failed");
  const session = await sessionResponse.json();
  if (typeof session.csrfToken !== "string") throw new Error("GUI session did not issue a CSRF token");

  const logout = await fetch(`${server.origin}/api/logout`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.origin,
      "X-ChatKJB-CSRF": session.csrfToken
    }
  });
  if (logout.status !== 204) throw new Error("GUI logout did not complete");
  if (existsSync(config.sessionPath)) throw new Error("GUI session file remained after server revocation");
  if (authState !== "signed_out") throw new Error("GUI auth state did not return to signed_out");
  process.stdout.write("Telegram GUI server revocation passed: remote logout completed and local GUI session was removed\n");
} finally {
  await server.close().catch(() => undefined);
  await client.stop().catch(() => undefined);
}
