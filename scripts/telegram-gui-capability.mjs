#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Api, InlineKeyboard } from "grammy";
import { loadConfig } from "../dist/config.js";
import { GENERAL_TOPIC_ID } from "../dist/gui/protocol.js";
import { TelegramUserClient } from "../dist/gui/telegram-user-client.js";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const qrHelper = join(projectDir, "scripts", "telegram-gui-qr.swift");
const userSessionPath = join(projectDir, "data", "telegram-gui.session");
const activeChildren = new Set();
let client = null;
let passwordTask = null;
let latestAuthState = "signed_out";
let qrDisplayProcess = null;
let qrDisplayTask = Promise.resolve();
let qrGeneration = 0;
let qrFailure = null;
let expectedMarker = null;
let markerObservedViaUpdate = false;
let activeCallbackFixture = null;
let cleanupPromise = null;
let cleaningUp = false;

function trackChild(child) {
  activeChildren.add(child);
  child.once("close", () => activeChildren.delete(child));
  return child;
}

function runProcess(file, args, { captureStdout = false } = {}) {
  if (cleaningUp) return Promise.reject(new Error("Capability helper is shutting down"));
  return new Promise((resolveProcess, rejectProcess) => {
    const child = trackChild(spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] }));
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => {
      if (captureStdout) stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.reduce((total, item) => total + item.length, 0) < 4096) stderr.push(Buffer.from(chunk));
    });
    child.once("error", rejectProcess);
    child.once("close", (code) => {
      if (code === 0) {
        resolveProcess(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      rejectProcess(new Error(`Local helper failed (${code ?? "signal"})${detail ? `: ${detail}` : ""}`));
    });
  });
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolveClosed) => child.once("close", resolveClosed));
  child.kill("SIGTERM");
  await Promise.race([closed, new Promise((resolveWait) => setTimeout(resolveWait, 750))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await closed;
  }
}

async function terminateHelperProcesses() {
  await Promise.all([...activeChildren].map((child) => terminateChild(child)));
}

async function withTimeout(task, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function deleteActiveCallbackFixture() {
  const fixture = activeCallbackFixture;
  if (!fixture) return true;
  if (fixture.deleteTask) return await fixture.deleteTask;

  fixture.deleteTask = (async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const deleted = await withTimeout(
          fixture.api.deleteMessage(fixture.chatId, fixture.messageId),
          5_000,
          "Callback fixture deletion timed out"
        );
        if (deleted) {
          if (activeCallbackFixture === fixture) activeCallbackFixture = null;
          return true;
        }
      } catch {
        // Retry below. Telegram errors are intentionally not logged because they may carry request metadata.
      }
      if (attempt < 2) await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    fixture.deleteTask = null;
    return false;
  })();
  return await fixture.deleteTask;
}

async function showQrCode(token, expiresAt, generation) {
  if (cleaningUp || generation !== qrGeneration || Date.now() >= expiresAt - 1_000) return;
  await terminateChild(qrDisplayProcess);
  if (cleaningUp || generation !== qrGeneration || Date.now() >= expiresAt - 1_000) return;

  const uri = `tg://login?token=${Buffer.from(token).toString("base64url")}`;
  const child = trackChild(spawn("/usr/bin/swift", [qrHelper], { stdio: ["pipe", "pipe", "pipe"] }));
  qrDisplayProcess = child;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 4096) stderr += String(chunk);
  });
  child.stdin.end(uri);

  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("QR display did not become ready")), 15_000);
    const inspect = () => {
      if (!stdout.includes("READY")) return;
      clearTimeout(timeout);
      resolveReady();
    };
    child.stdout.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (!stdout.includes("READY")) {
        rejectReady(new Error(`QR display failed (${code ?? "signal"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      }
    });
    inspect();
  });

  if (generation !== qrGeneration || Date.now() >= expiresAt - 1_000) {
    await terminateChild(child);
    return;
  }
  console.log("Telegram QR login window opened locally. Scan it with the Telegram mobile app.");
  const remaining = Math.max(0, expiresAt - Date.now());
  const expiryTimer = setTimeout(() => {
    void terminateChild(child);
  }, remaining);
  child.once("close", () => clearTimeout(expiryTimer));
}

async function requestHiddenPassword() {
  const script = [
    "const app = Application.currentApplication();",
    "app.includeStandardAdditions = true;",
    "const result = app.displayDialog('Telegram 2FA 비밀번호를 입력하십시오.', {",
    "  defaultAnswer: '', hiddenAnswer: true,",
    "  buttons: ['취소', '확인'], defaultButton: '확인', cancelButton: '취소',",
    "  withTitle: 'ChatKJB Terminal'",
    "});",
    "result.textReturned;"
  ].join("\n");
  const stdout = await runProcess("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
    captureStdout: true
  });
  return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function liveOptions() {
  const live = process.argv.includes("--live");
  const sendMarker = process.argv.includes("--send-marker");
  const markRead = process.argv.includes("--mark-read");
  const typing = process.argv.includes("--typing");
  const callbackFixture = process.argv.includes("--callback-fixture");
  const rawObserveSeconds = optionValue("--observe-seconds");
  const rawTopicId = optionValue("--topic-id");
  if (!live && (
    sendMarker || markRead || typing || callbackFixture || rawObserveSeconds !== null || rawTopicId !== null
  )) {
    throw new Error("Mutation flags require --live");
  }
  if (!live) {
    return { live, sendMarker, markRead, typing, callbackFixture, observeSeconds: 0, topicId: null };
  }
  if (!rawTopicId || !/^\d+$/.test(rawTopicId)) throw new Error("--live requires --topic-id <positive integer>");
  const topicId = Number(rawTopicId);
  if (!Number.isSafeInteger(topicId) || topicId <= 0) throw new Error("--topic-id must be a positive integer");
  const observeSeconds = rawObserveSeconds === null ? 0 : Number(rawObserveSeconds);
  if (!Number.isSafeInteger(observeSeconds) || observeSeconds < 0 || observeSeconds > 300) {
    throw new Error("--observe-seconds must be an integer from 0 to 300");
  }
  if (!sendMarker && !markRead && !typing && !callbackFixture && observeSeconds === 0) {
    throw new Error(
      "--live requires an explicit action: --send-marker, --mark-read, --typing, " +
        "--callback-fixture, or --observe-seconds"
    );
  }
  return { live, sendMarker, markRead, typing, callbackFixture, observeSeconds, topicId };
}

async function verifyPrerequisites(config) {
  if (process.platform !== "darwin") throw new Error("Telegram GUI capability probe requires macOS");
  await Promise.all([
    access("/usr/bin/swiftc"),
    access("/usr/bin/osascript"),
    access(qrHelper)
  ]);
  await runProcess("/usr/bin/swiftc", ["-typecheck", qrHelper]);
  await runProcess("/usr/bin/osascript", ["-l", "JavaScript", "-e", "true;"]);
  if (!config.telegramMtproto) throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required");
  if (resolve(config.telegramMtproto.sessionPath) === resolve(userSessionPath)) {
    throw new Error("Telegram bot and GUI user sessions must use different files");
  }
}

async function cleanup() {
  if (cleanupPromise) return await cleanupPromise;
  cleaningUp = true;
  qrGeneration += 1;
  qrDisplayProcess?.kill("SIGTERM");
  client?.cancelLogin();
  cleanupPromise = (async () => {
    await deleteActiveCallbackFixture();
    await terminateHelperProcesses();
    await qrDisplayTask.catch(() => undefined);
    await terminateHelperProcesses();
    await client?.stop().catch(() => undefined);
    await passwordTask?.catch(() => undefined);
    await terminateHelperProcesses();
  })();
  return await cleanupPromise;
}

async function pollForMarker(topicId, marker) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const page = await client.listMessages(topicId, undefined, 30);
    if (page.messages.some((message) => message.text === marker)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  return false;
}

async function listVerifiedTopics() {
  const topics = [];
  let cursor = undefined;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = await client.listTopics(cursor, 100);
    topics.push(...page.topics);
    if (!page.nextCursor) return topics;
    cursor = page.nextCursor;
  }
  throw new Error("Telegram forum topic scan exceeded the 2,000-topic capability limit");
}

async function exerciseControlledCallbackFixture(config, target) {
  const api = new Api(config.telegramBotToken);
  const nonce = crypto.randomUUID();
  const fixtureText = `[ChatKJB Terminal G001 callback fixture ${nonce}]`;
  const rawCallbackData = `noop:g001:${nonce}`;
  const expectedCallbackData = Buffer.from(rawCallbackData).toString("base64url");
  const options = {
    reply_markup: new InlineKeyboard().text("G001 noop", rawCallbackData),
    ...(target.id === GENERAL_TOPIC_ID ? {} : { message_thread_id: target.id })
  };
  let sentMessage;
  let callbackPressed = false;
  let fixtureDeleted = false;
  let callbackError = null;

  try {
    sentMessage = await api.sendMessage(config.chatId, fixtureText, options);
    activeCallbackFixture = {
      api,
      chatId: config.chatId,
      messageId: sentMessage.message_id,
      deleteTask: null
    };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const page = await client.listMessages(target.id, undefined, 30);
      const fixture = page.messages.find(
        (message) => message.id === sentMessage.message_id && message.text === fixtureText
      );
      const callback = fixture?.buttons
        .flat()
        .find((button) => button.kind === "callback" && button.callbackData === expectedCallbackData);
      if (callback?.callbackData) {
        await client.pressCallback(fixture.id, callback.callbackData);
        callbackPressed = true;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    if (!callbackPressed) throw new Error("Controlled callback fixture was not available through Telegram history");
  } catch (error) {
    callbackError = error;
  } finally {
    if (sentMessage) fixtureDeleted = await deleteActiveCallbackFixture();
  }

  if (callbackError && sentMessage && !fixtureDeleted) {
    throw new AggregateError(
      [callbackError, new Error("Controlled callback fixture could not be deleted after verification failure")],
      "Controlled callback verification and cleanup both failed"
    );
  }
  if (callbackError) throw callbackError;
  if (!fixtureDeleted) throw new Error("Controlled callback fixture could not be deleted after verification");
  return { callbackPressed, fixtureDeleted };
}

async function main() {
  const actions = liveOptions();
  const config = await loadConfig();
  await verifyPrerequisites(config);
  if (process.argv.includes("--check")) {
    console.log("Telegram GUI capability prerequisites are ready.");
    return;
  }

  const updateCounts = new Map();
  const targetUpdateCounts = {
    messageUpsert: 0,
    editedUpsert: 0,
    messageDelete: 0,
    topicDelete: 0
  };
  client = new TelegramUserClient({
    apiId: config.telegramMtproto.apiId,
    apiHash: config.telegramMtproto.apiHash,
    chatId: config.chatId,
    allowedUserIds: config.allowedUserIds,
    sessionPath: userSessionPath,
    onAuthState: (state) => {
      latestAuthState = state.state;
      console.log(`Telegram user authorization state: ${state.state}`);
      if (!cleaningUp && state.state === "waiting_password" && !passwordTask) {
        passwordTask = requestHiddenPassword()
          .then((password) => client?.submitPassword(password))
          .catch(() => client?.cancelLogin())
          .finally(() => {
            passwordTask = null;
          });
      }
    },
    onQrCode: (token, expiresAt) => {
      if (cleaningUp) return;
      const generation = ++qrGeneration;
      qrDisplayProcess?.kill("SIGTERM");
      qrDisplayTask = qrDisplayTask
        .catch(() => undefined)
        .then(async () => {
          if (generation !== qrGeneration) return;
          await showQrCode(token, expiresAt, generation);
        })
        .catch((error) => {
          if (generation !== qrGeneration) return;
          qrFailure = error;
          client?.cancelLogin();
        });
    },
    onUpdate: (update) => {
      updateCounts.set(update.type, (updateCounts.get(update.type) ?? 0) + 1);
      if (actions.live && update.type === "message_upsert" && update.message.topicId === actions.topicId) {
        targetUpdateCounts.messageUpsert += 1;
        if (update.message.editedAt !== null) targetUpdateCounts.editedUpsert += 1;
      }
      if (actions.live && update.type === "message_delete" && update.topicId === actions.topicId) {
        targetUpdateCounts.messageDelete += update.messageIds.length;
      }
      if (actions.live && update.type === "topic_delete" && update.topicId === actions.topicId) {
        targetUpdateCounts.topicDelete += 1;
      }
      if (update.type === "message_upsert" && expectedMarker && update.message.text === expectedMarker) {
        markerObservedViaUpdate = true;
      }
    }
  });

  await client.start();
  if (latestAuthState !== "ready") await client.beginQrLogin();
  await qrDisplayTask;
  await terminateChild(qrDisplayProcess);
  if (qrFailure) throw qrFailure;
  if (latestAuthState !== "ready") throw new Error("Telegram user authorization did not reach ready state");

  const topics = await listVerifiedTopics();
  const discoveryTopics = [
    topics.find((topic) => topic.id === GENERAL_TOPIC_ID),
    topics.find((topic) => topic.id !== GENERAL_TOPIC_ID && !topic.closed && !topic.hidden)
  ].filter(Boolean);
  const discoveries = [];
  for (const topic of discoveryTopics) {
    const page = await client.listMessages(topic.id, undefined, 20);
    discoveries.push({
      kind: topic.id === GENERAL_TOPIC_ID ? "general" : "forum-topic",
      historyCount: page.messages.length,
      callbackCount: page.messages.reduce(
        (count, message) => count + message.buttons.flat().filter((button) => button.kind === "callback").length,
        0
      )
    });
  }

  if (!actions.live) {
    console.log(JSON.stringify({
      result: "authorization-and-readonly-discovery-complete",
      topicCount: topics.length,
      discoveries,
      callbackInvocation: "not-run; controlled callback fixture required"
    }));
    return;
  }

  const target = topics.find((topic) => topic.id === actions.topicId);
  if (!target) throw new Error("--topic-id is not present in the verified topic set");
  if (target.closed || target.hidden) throw new Error("Refusing live actions in a closed or hidden topic");
  const targetHistory = await client.listMessages(target.id, undefined, 30);
  console.log(JSON.stringify({
    liveIntent: {
      topicId: target.id,
      sendMarker: actions.sendMarker,
      markRead: actions.markRead,
      typing: actions.typing,
      callbackFixture: actions.callbackFixture,
      observeSeconds: actions.observeSeconds
    }
  }));

  let typingExecuted = false;
  if (actions.typing) {
    await client.setTyping(target.id, true);
    await client.setTyping(target.id, false);
    typingExecuted = true;
  }
  let markReadExecuted = false;
  if (actions.markRead && !targetHistory.messages[0]) {
    throw new Error("--mark-read requested but the target topic has no readable messages");
  }
  if (actions.markRead) {
    await client.markRead(target.id, targetHistory.messages[0].id);
    markReadExecuted = true;
  }

  let markerFoundInHistory = null;
  if (actions.sendMarker) {
    expectedMarker = `[ChatKJB Terminal G001 capability ${new Date().toISOString()}]`;
    await client.sendText(target.id, expectedMarker);
    markerFoundInHistory = await pollForMarker(target.id, expectedMarker);
    if (!markerFoundInHistory) throw new Error("Sent capability marker was not found in Telegram history");
  }
  const callbackFixtureResult = actions.callbackFixture
    ? await exerciseControlledCallbackFixture(config, target)
    : null;
  if (actions.observeSeconds > 0) {
    await new Promise((resolveWait) => setTimeout(resolveWait, actions.observeSeconds * 1_000));
  }

  console.log(JSON.stringify({
    result: "live-capability-partial",
    checks: {
      sendConfirmedInHistory: markerFoundInHistory,
      markerObservedViaRawUpdate: actions.sendMarker ? markerObservedViaUpdate : null,
      markReadExecuted: actions.markRead ? markReadExecuted : null,
      typingExecuted: actions.typing ? typingExecuted : null,
      callbackFixturePressed: callbackFixtureResult?.callbackPressed ?? null,
      callbackFixtureDeleted: callbackFixtureResult?.fixtureDeleted ?? null,
      observeSeconds: actions.observeSeconds,
      targetUpdateCounts,
      callbackInvocation: callbackFixtureResult
        ? "controlled noop fixture completed"
        : "not-run; controlled callback fixture required"
    },
    observedUpdateTypes: [...updateCounts.keys()].sort()
  }));
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(code));
  });
}

try {
  await main();
} finally {
  await cleanup();
}
