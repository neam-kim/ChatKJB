#!/usr/bin/env node

import { resolve } from "node:path";
import { loadTelegramGuiConfig } from "../dist/config.js";
import { TelegramUserClient } from "../dist/gui/telegram-user-client.js";

function topicIdArgument() {
  const index = process.argv.indexOf("--topic-id");
  const raw = index === -1 ? undefined : process.argv[index + 1];
  if (!process.argv.includes("--live") || !raw || !/^\d+$/.test(raw)) {
    throw new Error("Live integration requires --live --topic-id <positive integer>");
  }
  const topicId = Number(raw);
  if (!Number.isSafeInteger(topicId) || topicId <= 0) throw new Error("Invalid live integration topic ID");
  return topicId;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function listAllTopics(client) {
  const topics = [];
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const result = await client.listTopics(cursor, 100);
    topics.push(...result.topics);
    if (!result.nextCursor) return topics;
    cursor = result.nextCursor;
  }
  throw new Error("Live integration topic scan exceeded 2,000 topics");
}

const topicId = topicIdArgument();
const config = await loadTelegramGuiConfig();
let authState = "signed_out";
const updateCounts = { outgoing: 0, incoming: 0 };
const client = new TelegramUserClient({
  apiId: config.apiId,
  apiHash: config.apiHash,
  chatId: config.chatId,
  allowedUserIds: config.allowedUserIds,
  sessionPath: resolve(config.sessionPath),
  onAuthState: (state) => { authState = state.state; },
  onUpdate: (update) => {
    if (update.type !== "message_upsert" || update.message.topicId !== topicId) return;
    updateCounts[update.message.outgoing ? "outgoing" : "incoming"] += 1;
  }
});

try {
  await client.start();
  if (authState !== "ready") throw new Error("Telegram GUI session is not ready; complete QR login first");
  const target = (await listAllTopics(client)).find((topic) => topic.id === topicId);
  if (!target || target.closed || target.hidden) throw new Error("Live integration target is unavailable");

  const before = await client.listMessages(topicId, undefined, 50);
  const beforeMaxId = Math.max(0, ...before.messages.map((message) => message.id));
  await client.sendText(topicId, "/status");

  const command = await waitFor(async () => {
    const page = await client.listMessages(topicId, undefined, 50);
    return page.messages.find(
      (message) => message.id > beforeMaxId && message.outgoing && message.text === "/status"
    );
  }, 15_000, "outgoing status command in Telegram history");

  const reply = await waitFor(async () => {
    const page = await client.listMessages(topicId, undefined, 50);
    return page.messages.find((message) => message.id > command.id && !message.outgoing);
  }, 30_000, "ChatKJB response in the same Telegram topic");

  process.stdout.write(`${JSON.stringify({
    result: "live-roundtrip-complete",
    topicId,
    outgoingCommandConfirmed: command.id > beforeMaxId,
    incomingBotResponseConfirmed: reply.id > command.id,
    sameTopicConfirmed: command.topicId === topicId && reply.topicId === topicId,
    updateCounts
  })}\n`);
} finally {
  await client.stop().catch(() => undefined);
}
