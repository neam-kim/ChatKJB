#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startGuiServer } from "../dist/gui/server.js";
import { HistoryInvalidatedError, ReadConfirmationPendingError } from "../dist/gui/telegram-user-client.js";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(
  projectDir,
  ".chatkjb",
  "workflows",
  "ralplan-20260719-1502-general-panel-portable-macos",
  "ultragoal",
  "evidence"
);
const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const imageTokens = ["I", "J", "K"].map((value) => value.repeat(43));
const documentToken = "D".repeat(43);
const attachmentPreviewLimit = 20 * 1024 * 1024;
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function topic(id, title, unreadCount = 0) {
  return { id, title, topMessageId: id === 1 ? 1 : id, unreadCount, pinned: false, closed: false, hidden: false };
}

function fixtureMessage(id, text, input = {}) {
  return {
    id,
    topicId: 42,
    text,
    sentAt: 1_700_000_000_000 + id * 1_000,
    editedAt: null,
    outgoing: id % 3 === 0,
    buttons: [],
    ...input
  };
}

class FixtureClient {
  topics = [
    topic(1, "General"),
    topic(42, "반응형 터미널", 3),
    topic(77, "긴 이름의 작업 토픽 — overflow 검증"),
    ...Array.from({ length: 160 }, (_, index) => topic(1_000 + index, `보관 토픽 ${index + 1}`))
  ];
  messages = [];
  calls = { panel: 0, text: 0, texts: [], file: 0, fileInputs: [], callback: 0, read: 0, readTargets: [], readInputs: [], readActive: 0, readMax: 0, topics: 0, history: 0, downloadActive: 0, downloadMax: 0 };
  delayPanel = true;
  panelPending = false;
  releasePanel = null;
  delayNextHistory = false;
  historyPending = false;
  releaseHistory = null;
  delayNextTopicPage = false;
  topicPagePending = false;
  releaseTopicPage = null;
  delayNextTopicSnapshot = false;
  topicSnapshotCaptured = false;
  releaseTopicSnapshot = null;
  invalidateNextTopicPage = false;
  topicInvalidations = 0;
  failTopics = false;
  delayNextRead = false;
  readPending = false;
  readConfirmationPending = false;
  readAccepted = false;
  releaseRead = null;
  failReads = false;
  pendingReadFailures = 0;
  delayNextFile = false;
  filePending = false;
  releaseFile = null;

  constructor() {
    this.generalPanel = {
      messageId: 450,
      rows: [
        ["⚙️ 새 세션 기본값", "🧠 모델: GPT-5.6-Sol"],
        ["🤖 제공자: Codex", "💭 추론: 매우 높음 (xHigh)"],
        ["➖", "🔑 토큰: #3"]
      ]
    };
    this.generalMessages = [fixtureMessage(400, "General 읽음 상태 검증", { topicId: 1, outgoing: false })];
    this.topics[0].topMessageId = 400;
    this.topics[0].unreadCount = 1;
    for (let id = 10; id < 260; id += 1) {
      this.messages.push(fixtureMessage(id, `${id.toString().padStart(3, "0")} · 과거 기록 스크롤 기준선 · 한국어와 English output이 창 너비에 맞게 이어집니다.`));
    }
    const longCode = `const terminalWidth = window.innerWidth;\n${"0123456789abcdef".repeat(34)}\nreturn terminalWidth;`;
    const codeText = `코드 출력\n${longCode}\n코드 뒤 일반 본문은 다시 줄바꿈됩니다.`;
    this.messages.push(fixtureMessage(291, codeText, {
      entities: [{ kind: "pre", offset: 6, length: longCode.length, language: "javascript" }]
    }));
    const url = `https://example.com/${"very-long-segment-".repeat(14)}`;
    this.messages.push(fixtureMessage(292, `긴 URL도 본문 폭 안에서 줄바꿈됩니다: ${url}`, {
      entities: [{ kind: "url", offset: 24, length: url.length, url }]
    }));
    this.messages.push(fixtureMessage(293, "이미지 첨부", {
      attachment: {
        kind: "image",
        name: "terminal-pixel.png",
        filenameSource: "telegram",
        mimeType: "image/png",
        size: tinyPng.byteLength,
        width: 320,
        height: 180,
        token: imageTokens[0]
      }
    }));
    this.messages.push(fixtureMessage(295, "두 번째 이미지 첨부", {
      attachment: { kind: "image", name: "terminal-two.png", filenameSource: "telegram", mimeType: "image/png", size: tinyPng.byteLength, width: 160, height: 90, token: imageTokens[1] }
    }));
    this.messages.push(fixtureMessage(296, "세 번째 이미지 첨부", {
      attachment: { kind: "image", name: "terminal-three.png", filenameSource: "telegram", mimeType: "image/png", size: tinyPng.byteLength, width: 160, height: 90, token: imageTokens[2] }
    }));
    this.messages.push(fixtureMessage(294, "문서와 callback", {
      attachment: {
        kind: "document",
        name: "ChatKJB terminal fixture.txt",
        filenameSource: "telegram",
        mimeType: "text/plain",
        size: 16,
        token: documentToken
      },
      buttons: [[{ kind: "callback", text: "검증 동작", callbackData: Buffer.from("fixture").toString("base64url") }]]
    }));
    this.messages.push(fixtureMessage(297, "정리된 이름의 큰 문서", {
      outgoing: false,
      attachment: {
        kind: "document",
        name: "secret-report.pdf",
        filenameSource: "sanitized",
        mimeType: "application/pdf",
        size: attachmentPreviewLimit + 1
      }
    }));
    this.messages.push(fixtureMessage(298, "원본 이름 없는 큰 사진", {
      outgoing: false,
      attachment: {
        kind: "image",
        name: "photo-298.jpg",
        filenameSource: "generated",
        mimeType: "image/jpeg",
        size: attachmentPreviewLimit + 1
      }
    }));
    this.messages.push(fixtureMessage(299, "SVG 문서", {
      outgoing: false,
      attachment: {
        kind: "document",
        name: "graphic.svg",
        filenameSource: "telegram",
        mimeType: "image/svg+xml",
        size: 128
      }
    }));
    this.topics.find((candidate) => candidate.id === 42).topMessageId = 299;
  }

  async beginQrLogin() {}
  submitPassword() {}
  cancelLogin() {}
  async findGeneralReplyPanel() {
    this.calls.panel += 1;
    if (this.delayPanel) {
      this.delayPanel = false;
      this.panelPending = true;
      await new Promise((resolvePanel) => { this.releasePanel = resolvePanel; });
      this.panelPending = false;
      this.releasePanel = null;
    }
    return this.generalPanel;
  }
  async listTopics(cursor) {
    this.calls.topics += 1;
    if (this.failTopics) throw new Error("permanent topic fixture failure");
    const start = cursor?.offsetTopic || 0;
    if (start > 0 && this.invalidateNextTopicPage) {
      this.invalidateNextTopicPage = false;
      this.topicInvalidations += 1;
      throw new HistoryInvalidatedError();
    }
    if (start > 0 && this.delayNextTopicPage) {
      this.delayNextTopicPage = false;
      this.topicPagePending = true;
      await new Promise((resolveWait) => { this.releaseTopicPage = resolveWait; });
      this.topicPagePending = false;
      this.releaseTopicPage = null;
    }
    const end = Math.min(this.topics.length, start + 100);
    const response = {
      topics: this.topics.slice(start, end).map((candidate) => ({ ...candidate })),
      nextCursor: end < this.topics.length ? { offsetDate: 0, offsetId: 0, offsetTopic: end } : null
    };
    if (start === 0 && this.delayNextTopicSnapshot) {
      this.delayNextTopicSnapshot = false;
      this.topicSnapshotCaptured = true;
      await new Promise((resolveWait) => { this.releaseTopicSnapshot = resolveWait; });
      this.topicSnapshotCaptured = false;
      this.releaseTopicSnapshot = null;
    }
    return response;
  }
  async listMessages(topicId, cursor) {
    this.calls.history += 1;
    if (this.delayNextHistory) {
      this.delayNextHistory = false;
      this.historyPending = true;
      await new Promise((resolveWait) => { this.releaseHistory = resolveWait; });
      this.historyPending = false;
      this.releaseHistory = null;
    }
    if (topicId === 1) return { messages: this.generalMessages, nextCursor: null };
    if (topicId !== 42) return { messages: [], nextCursor: null };
    const ordered = [...new Map(this.messages.map((message) => [message.id, message])).values()]
      .sort((left, right) => right.id - left.id);
    const start = cursor?.offsetId || 0;
    const end = Math.min(ordered.length, start + 100);
    return {
      messages: ordered.slice(start, end),
      nextCursor: end < ordered.length ? { offsetId: end, offsetDate: 0 } : null
    };
  }
  async sendText(topicId, text) {
    this.calls.text += 1;
    this.calls.texts.push({ topicId, text });
  }
  uploadLimitBytes() { return 4_194_304_000; }
  async sendFile(topicId, input) {
    this.calls.file += 1;
    this.calls.fileInputs.push({
      topicId,
      name: input.name,
      mimeType: input.mimeType,
      caption: input.caption,
      size: input.size,
      bytes: readFileSync(input.path, "utf8")
    });
    input.onProgress?.(0.5);
    if (this.delayNextFile) {
      this.delayNextFile = false;
      this.filePending = true;
      await new Promise((resolveWait) => { this.releaseFile = resolveWait; });
      this.filePending = false;
      this.releaseFile = null;
    }
    await input.onFileReleased?.();
  }
  async downloadAttachment(token) {
    if (imageTokens.includes(token)) {
      this.calls.downloadActive += 1;
      this.calls.downloadMax = Math.max(this.calls.downloadMax, this.calls.downloadActive);
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
      this.calls.downloadActive -= 1;
      return { kind: "image", name: "terminal-pixel.png", mimeType: "image/png", bytes: tinyPng };
    }
    if (token === documentToken) {
      return {
        kind: "document",
        name: "ChatKJB terminal fixture.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("fixture document")
      };
    }
    throw new Error("not available");
  }
  async pressCallback() { this.calls.callback += 1; }
  async markRead(topicId, maxMessageId) {
    this.calls.read += 1;
    this.calls.readTargets.push(maxMessageId);
    this.calls.readInputs.push({ topicId, maxMessageId });
    this.calls.readActive += 1;
    this.calls.readMax = Math.max(this.calls.readMax, this.calls.readActive);
    try {
      if (this.delayNextRead) {
        this.delayNextRead = false;
        this.readPending = true;
        this.readConfirmationPending = true;
        await new Promise((resolveWait) => { this.releaseRead = resolveWait; });
        this.readPending = false;
        this.readConfirmationPending = false;
        this.releaseRead = null;
      }
      const target = this.topics.find((candidate) => candidate.id === topicId);
      if (target && target.topMessageId <= maxMessageId) target.unreadCount = 0;
      this.readAccepted = true;
      if (this.pendingReadFailures > 0) {
        this.pendingReadFailures -= 1;
        throw new ReadConfirmationPendingError();
      }
      if (this.failReads) {
        throw new Error("fixture read failure");
      }
    } finally {
      this.calls.readActive -= 1;
    }
  }
  async setTyping() {}
  async logOut() {}
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", rejectOpen, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
        return;
      }
      const callbacks = this.listeners.get(message.method) || [];
      this.listeners.delete(message.method);
      for (const callback of callbacks) callback(message.params || {});
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  once(method, timeoutMs = 10_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => rejectEvent(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      const callbacks = this.listeners.get(method) || [];
      callbacks.push((params) => {
        clearTimeout(timer);
        resolveEvent(params);
      });
      this.listeners.set(method, callbacks);
    });
  }

  close() {
    this.socket.close();
  }
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  mkdirSync(evidenceDir, { recursive: true });
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "chatkjb-gui-render-"));
  const client = new FixtureClient();
  client.delayNextTopicPage = true;
  const server = await startGuiServer({ client });
  server.publishAuthState({ state: "ready" });
  const chrome = spawn(chromeExecutable, [
    "--headless=new",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${temporaryDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--hide-scrollbars=false",
    "about:blank"
  ], { stdio: "ignore" });
  let cdp;
  try {
    const portFile = join(temporaryDirectory, "DevToolsActivePort");
    const port = await waitFor(() => {
      try {
        return Number(readFileSync(portFile, "utf8").split("\n", 1)[0]);
      } catch {
        return 0;
      }
    }, "Chrome DevTools port");
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    cdp = new CdpConnection(version.webSocketDebuggerUrl);
    await cdp.open();
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);

    const evaluate = async (expression, awaitPromise = true) => {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise,
        returnByValue: true
      }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
      return result.result?.value;
    };
    const pressKey = async (key, code = key) => {
      const virtualKeyCode = key === "Enter" ? 13 : 0;
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code,
        ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode
      }, sessionId);
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode
      }, sessionId);
    };

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    }, sessionId);
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: server.takeBootstrapUrl() }, sessionId);
    await loaded;
    await waitFor(() => client.topicPagePending, "initial delayed topic page");
    await waitFor(() => client.panelPending, "initial delayed General panel");
    const spinnerMeasurements = [];
    for (const width of [800, 1280, 1600]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      }, sessionId);
      const spinnerMetrics = await evaluate(`(() => {
        const loader = document.querySelector('#topic-loading');
        const spinner = document.querySelector('.topic-loading-spinner');
        const connection = document.querySelector('#connection-status');
        const loaderRect = loader?.getBoundingClientRect();
        const spinnerRect = spinner?.getBoundingClientRect();
        const connectionRect = connection?.getBoundingClientRect();
        return {
          width: innerWidth,
          hidden: loader?.hidden,
          topicBusy: document.querySelector('#topic-list')?.getAttribute('aria-busy'),
          loaderRight: loaderRect?.right || 0,
          connectionLeft: connectionRect?.left || 0,
          spinnerWidth: spinnerRect?.width || 0,
          spinnerHeight: spinnerRect?.height || 0,
          animationName: spinner ? getComputedStyle(spinner).animationName : 'none'
        };
      })()`);
      if (spinnerMetrics.hidden || spinnerMetrics.topicBusy !== "true") {
        throw new Error(`Topic loader was not exposed while loading at ${width}px`);
      }
      if (spinnerMetrics.loaderRight > spinnerMetrics.connectionLeft || spinnerMetrics.spinnerWidth > 16
        || Math.abs(spinnerMetrics.spinnerWidth - spinnerMetrics.spinnerHeight) > 0.5) {
        throw new Error(`Topic loader position or square size failed at ${width}px: ${JSON.stringify(spinnerMetrics)}`);
      }
      if (spinnerMetrics.animationName === "none") throw new Error(`Topic loader did not rotate at ${width}px`);
      const loadingScreenshot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        fromSurface: true
      }, sessionId);
      writeFileSync(join(evidenceDir, `g003-loading-${width}.png`), Buffer.from(loadingScreenshot.data, "base64"));
      spinnerMeasurements.push(spinnerMetrics);
    }
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }]
    }, sessionId);
    if (await evaluate("getComputedStyle(document.querySelector('.topic-loading-spinner')).animationName !== 'none'")) {
      throw new Error("Topic loader animation ignored prefers-reduced-motion");
    }
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
    }, sessionId);
    client.releaseTopicPage?.();
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"42\"]') !== null"
    ), "fixture topic");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"1100\"]') !== null"
    ), "second-page fixture topic");
    if (!await evaluate("document.querySelector('#topic-loading').hidden && !document.querySelector('#topic-list').hasAttribute('aria-busy')")) {
      throw new Error("Topic loader remained exposed after all topic pages loaded");
    }
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"1\"] .topic-count') === null"
    ), "General unread clear");
    await waitFor(async () => await evaluate(
      `(() => {
        const panel = document.querySelector('#general-panel');
        return panel && !panel.hidden
          && [...panel.querySelectorAll('button')].map((button) => button.textContent).join('|')
            === '⚙️ 새 세션 기본값|🧠 모델|🤖 제공자|💭 추론|🛠️ 작업량|🔑 토큰';
      })()`
    ), "immediate functional General panel fallback");
    client.releasePanel?.();
    await waitFor(async () => await evaluate(
      "[...document.querySelectorAll('#general-panel button')].some((button) => button.textContent === '🧠 모델: GPT-5.6-Sol')"
    ), "dynamic General panel lookup");
    if (client.calls.panel !== 1) throw new Error(`General panel lookup count was ${client.calls.panel}, expected 1`);

    const generalPanelMeasurements = [];
    for (const width of [800, 1280, 1600]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      }, sessionId);
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
      const metrics = await evaluate(`(() => {
        const topicButton = document.querySelector('[data-topic-id="1"]');
        const name = topicButton?.querySelector('.topic-name');
        const panel = document.querySelector('#general-panel');
        const buttons = [...(panel?.querySelectorAll('button') || [])];
        const input = document.querySelector('#message-input');
        const panelRect = panel?.getBoundingClientRect();
        const inputRect = input?.getBoundingClientRect();
        const rowTops = [...new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)))];
        return {
          width: innerWidth,
          pageScrollWidth: document.documentElement.scrollWidth,
          topicName: name?.textContent || '',
          topicFontWeight: Number.parseInt(getComputedStyle(name).fontWeight, 10) || 0,
          hasPrefix: Boolean(topicButton?.querySelector('.topic-prefix')),
          headerTitle: document.querySelector('#topic-title')?.textContent || '',
          panelHidden: panel?.hidden,
          panelButtonCount: buttons.length,
          panelRows: rowTops.length,
          panelWidth: panelRect?.width || 0,
          panelScrollWidth: panel?.scrollWidth || 0,
          panelBottom: panelRect?.bottom || 0,
          inputTop: inputRect?.top || 0,
          inputHeight: inputRect?.height || 0,
          attachHeight: document.querySelector('#attach-button')?.getBoundingClientRect().height || 0
        };
      })()`);
      if (
        metrics.pageScrollWidth > width
        || metrics.topicName !== "ChatKJB"
        || metrics.topicFontWeight < 700
        || metrics.hasPrefix
        || metrics.headerTitle !== "General"
        || metrics.panelHidden
        || metrics.panelButtonCount !== 6
        || metrics.panelRows !== 3
        || metrics.panelScrollWidth > metrics.panelWidth + 1
        || metrics.panelBottom > metrics.inputTop
        || Math.abs(metrics.inputHeight - metrics.attachHeight) > 1
      ) throw new Error(`General alias or panel layout failed at ${width}px: ${JSON.stringify(metrics)}`);
      const screenshot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        fromSurface: true
      }, sessionId);
      writeFileSync(join(evidenceDir, `g001-general-panel-${width}.png`), Buffer.from(screenshot.data, "base64"));
      generalPanelMeasurements.push(metrics);
    }

    const newerRows = [
      ["⚙️ 새 세션 기본값", "🧠 모델: Dynamic"],
      ["🤖 제공자: Codex", "💭 추론: 높음 (High)"],
      ["➖", "🔑 토큰: #2"]
    ];
    server.publishUpdate({
      type: "message_upsert",
      message: fixtureMessage(500, "General panel live update", {
        topicId: 1,
        outgoing: true,
        replyPanel: { messageId: 500, rows: newerRows }
      })
    });
    await waitFor(async () => await evaluate(
      "[...document.querySelectorAll('#general-panel button')].some((button) => button.textContent === '🧠 모델: Dynamic')"
    ), "newer live General panel");
    server.publishUpdate({
      type: "message_upsert",
      message: fixtureMessage(499, "stale General panel", {
        topicId: 1,
        outgoing: true,
        replyPanel: {
          messageId: 499,
          rows: [
            ["⚙️ 새 세션 기본값", "🧠 모델: STALE"],
            ["🤖 제공자: Claude", "💭 thinking: off"],
            ["🛠️ 작업량: 낮음 (Low)", "➖"]
          ]
        }
      })
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    if (await evaluate("document.querySelector('#general-panel').textContent.includes('STALE')")) {
      throw new Error("An older live General panel replaced the latest panel");
    }
    server.publishUpdate({
      type: "message_upsert",
      message: fixtureMessage(500, "General panel same-id edit", {
        topicId: 1,
        outgoing: true,
        replyPanel: {
          messageId: 500,
          rows: newerRows.map((row) => row.map((text) => text.replace("Dynamic", "Edited")))
        }
      })
    });
    await waitFor(async () => await evaluate(
      "[...document.querySelectorAll('#general-panel button')].some((button) => button.textContent === '🧠 모델: Edited')"
    ), "same-id General panel edit");

    await evaluate(`(() => {
      const input = document.querySelector('#message-input');
      input.value = 'composer preserved';
      document.querySelector('#general-panel button')?.click();
      return true;
    })()`);
    await waitFor(() => client.calls.text === 1, "General panel text send");
    await waitFor(async () => await evaluate(
      "document.querySelector('#message-input').value === 'composer preserved' && document.activeElement?.id === 'message-input'"
    ), "General panel composer preservation");
    if (
      client.calls.texts[0]?.topicId !== 1
      || client.calls.texts[0]?.text !== "⚙️ 새 세션 기본값"
    ) throw new Error(`General panel command did not preserve its text/topic/composer: ${JSON.stringify(client.calls.texts)}`);
    process.stdout.write("G003 renderer: topics loaded\n");
    await evaluate("document.querySelector('[data-topic-id=\"42\"]')?.focus(); true");
    await pressKey("Enter");
    await waitFor(async () => await evaluate("document.activeElement?.dataset.topicId === '42'"), "keyboard topic focus restoration");
    if (!await evaluate("document.querySelector('#general-panel').hidden")) {
      throw new Error("General panel remained visible in an ordinary topic");
    }
    try {
      await waitFor(async () => await evaluate(
        "document.querySelectorAll('.message-row').length >= 70"
      ), "fixture messages");
      await waitFor(async () => await evaluate(
        "document.querySelectorAll('.attachment img').length === 3 && [...document.querySelectorAll('.attachment img')].every((image) => image.complete)"
      ), "fixture images");
      if (client.calls.downloadMax > 2 || client.calls.downloadMax < 2) {
        throw new Error(`Image download concurrency was ${client.calls.downloadMax}, expected exactly 2`);
      }
      const attachmentContract = await evaluate(`(() => {
        const row = (id) => document.querySelector('[data-message-id="' + id + '"]');
        const text = (node, selector) => node?.querySelector(selector)?.textContent || '';
        const image = row(293);
        const documentRow = row(294);
        const sanitized = row(297);
        const generated = row(298);
        const svg = row(299);
        const documentMetadata = documentRow?.querySelector('.attachment-metadata');
        if (documentMetadata) documentMetadata.dataset.fixtureIdentity = 'stable';
        return {
          imageCaption: text(image, '.message-text'),
          imageName: text(image, '.attachment-name'),
          imageDetails: text(image, '.attachment-details'),
          imageStatus: text(image, '.attachment-status'),
          imageCount: image?.querySelectorAll('.attachment img').length || 0,
          documentCaption: text(documentRow, '.message-text'),
          documentName: text(documentRow, '.attachment-name'),
          documentDetails: text(documentRow, '.attachment-details'),
          documentStatus: text(documentRow, '.attachment-status'),
          sanitizedName: text(sanitized, '.attachment-name'),
          sanitizedDetails: text(sanitized, '.attachment-details'),
          sanitizedStatus: text(sanitized, '.attachment-status'),
          sanitizedActions: sanitized?.querySelector('.attachment-action')?.childElementCount || 0,
          generatedName: text(generated, '.attachment-name'),
          generatedDetails: text(generated, '.attachment-details'),
          generatedStatus: text(generated, '.attachment-status'),
          generatedVisibleText: generated?.textContent || '',
          generatedImages: generated?.querySelectorAll('.attachment img').length || 0,
          svgImages: svg?.querySelectorAll('.attachment img').length || 0,
          svgStatus: text(svg, '.attachment-status')
        };
      })()`);
      if (
        attachmentContract.imageCaption !== "이미지 첨부"
        || attachmentContract.imageName !== "terminal-pixel.png"
        || !attachmentContract.imageDetails.includes("Telegram 원본 파일명 · PNG 이미지 · image/png")
        || attachmentContract.imageStatus !== "미리보기 준비됨"
        || attachmentContract.imageCount !== 1
        || attachmentContract.documentCaption !== "문서와 callback"
        || attachmentContract.documentName !== "ChatKJB terminal fixture.txt"
        || !attachmentContract.documentDetails.includes("Telegram 원본 파일명 · 텍스트 문서 · text/plain · 16 B")
        || attachmentContract.documentStatus !== "다운로드 준비 가능"
        || attachmentContract.sanitizedName !== "secret-report.pdf"
        || !attachmentContract.sanitizedDetails.includes("안전하게 정리된 파일명 · PDF 문서 · application/pdf · 20.0 MiB")
        || attachmentContract.sanitizedStatus !== "20.0 MiB 다운로드 한도 초과 · 파일 정보만 표시"
        || attachmentContract.sanitizedActions !== 0
        || attachmentContract.generatedName !== "사진"
        || !attachmentContract.generatedDetails.includes("Telegram 사진 · 원본 파일명 없음 · JPEG 이미지 · image/jpeg · 20.0 MiB")
        || attachmentContract.generatedStatus !== "20.0 MiB 다운로드 한도 초과 · 파일 정보만 표시"
        || attachmentContract.generatedVisibleText.includes("photo-298.jpg")
        || attachmentContract.generatedImages !== 0
        || attachmentContract.svgImages !== 0
        || attachmentContract.svgStatus !== "이 첨부를 현재 다운로드할 수 없습니다."
      ) throw new Error(`Attachment identity contract failed: ${JSON.stringify(attachmentContract)}`);
      await evaluate("document.querySelector('[data-message-id=\"294\"] .attachment-button').click(); true");
      await waitFor(async () => await evaluate(
        `(() => {
          const row = document.querySelector('[data-message-id="294"]');
          return row?.querySelector('.attachment-metadata')?.dataset.fixtureIdentity === 'stable'
            && row?.querySelector('.attachment-status')?.textContent === '다운로드 준비됨'
            && row?.querySelector('.attachment-action a')?.textContent === 'ChatKJB terminal fixture.txt 다운로드'
            && row?.querySelector('.message-text')?.textContent === '문서와 callback';
        })()`
      ), "stable document metadata after download preparation");

      const immediateFile = fixtureMessage(300, "즉시 표시되는 발신 파일", {
        outgoing: true,
        attachment: {
          kind: "document",
          name: "sent-result.txt",
          filenameSource: "telegram",
          mimeType: "text/plain",
          size: 7
        }
      });
      client.messages.push(immediateFile);
      const activeTopic = client.topics.find((candidate) => candidate.id === 42);
      activeTopic.topMessageId = immediateFile.id;
      server.publishUpdate({ type: "message_upsert", message: immediateFile });
      server.publishUpdate({ type: "message_upsert", message: immediateFile });
      await waitFor(async () => await evaluate(
        `document.querySelectorAll('[data-message-id="300"]').length === 1
          && document.querySelector('[data-message-id="300"] .message-text')?.textContent === '즉시 표시되는 발신 파일'
          && document.querySelector('[data-message-id="300"] .attachment-name')?.textContent === 'sent-result.txt'`
      ), "deduplicated immediate outgoing file");
      const historyBeforeFileReconcile = client.calls.history;
      server.publishUpdate({ type: "reconcile_required" });
      await waitFor(() => client.calls.history > historyBeforeFileReconcile, "outgoing file history convergence");
      if (!await evaluate("document.querySelectorAll('[data-message-id=\"300\"]').length === 1")) {
        throw new Error("Immediate outgoing file duplicated after history convergence");
      }
      process.stdout.write("G002 renderer: stable attachment identity, safe fallback labels, and outgoing dedupe passed\n");
      await waitFor(async () => await evaluate(
        "document.querySelector('[data-topic-id=\"42\"] .topic-count') === null"
      ), "selected topic unread clear");
      if (client.calls.read < 1) throw new Error("Selected topic did not issue a read marker");
      process.stdout.write("G003 renderer: messages and media loaded\n");
    } catch (error) {
      const diagnostic = await evaluate(`({
        path: location.pathname,
        title: document.title,
        readyState: document.readyState,
        messageRows: document.querySelectorAll('.message-row').length,
        attachmentNodes: document.querySelectorAll('.attachment').length,
        imageNodes: document.querySelectorAll('.attachment img').length,
        connection: document.querySelector('#connection-label')?.textContent || '',
        alert: document.querySelector('#alert')?.textContent || ''
      })`);
      throw new Error(`${error.message}; safe browser diagnostic=${JSON.stringify(diagnostic)}`);
    }

    const readsBeforeInactiveGeneral = client.calls.read;
    const generalTopic = client.topics.find((candidate) => candidate.id === 1);
    const generalIds = [47065, 47066, 47067, 47068, 47069, 47070, 47071, 47074];
    for (const id of generalIds) {
      const incoming = fixtureMessage(id, `비활성 General unread ${id}`, { topicId: 1, outgoing: false });
      client.generalMessages.push(incoming);
      generalTopic.topMessageId = id;
      generalTopic.unreadCount += 1;
      server.publishUpdate({ type: "message_upsert", message: incoming });
    }
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"1\"] .topic-count')?.textContent === '8'"
    ), "inactive General unread accumulation");
    await new Promise((resolveWait) => setTimeout(resolveWait, 450));
    if (client.calls.read !== readsBeforeInactiveGeneral) {
      throw new Error("Inactive General issued a read marker while another topic was active");
    }

    client.pendingReadFailures = 1;
    await evaluate("document.querySelector('[data-topic-id=\"1\"]')?.click(); true");
    await waitFor(
      () => client.calls.readInputs.some((input) => input.topicId === 1 && input.maxMessageId === 47074),
      "General exact read target"
    );
    if (!await evaluate("document.querySelector('[data-topic-id=\"1\"] .topic-count')?.textContent === '8'")) {
      throw new Error("General pending confirmation cleared the unread badge early");
    }
    await waitFor(
      () => client.calls.readInputs.filter((input) => input.topicId === 1 && input.maxMessageId === 47074).length === 2,
      "General pending-only retry"
    );
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"1\"] .topic-count') === null"
    ), "active General authoritative unread clear");

    const generalReadsAfterSuccess = client.calls.readInputs.filter((input) => input.topicId === 1).length;
    generalTopic.topMessageId = 47074;
    generalTopic.unreadCount = 8;
    client.delayNextHistory = true;
    server.publishUpdate({ type: "reconcile_required" });
    await waitFor(() => client.historyPending, "General stale positive snapshot barrier");
    if (
      await evaluate("document.querySelector('[data-topic-id=\"1\"] .topic-count') !== null")
      || client.calls.readInputs.filter((input) => input.topicId === 1).length !== generalReadsAfterSuccess
    ) throw new Error("A stale positive General snapshot resurrected the badge or issued another read");
    client.releaseHistory?.();
    await waitFor(() => !client.historyPending, "General stale snapshot reconciliation completion");

    const duplicateGeneral = client.generalMessages.find((message) => message.id === 47074);
    server.publishUpdate({ type: "message_upsert", message: duplicateGeneral });
    server.publishUpdate({
      type: "message_upsert",
      message: { ...duplicateGeneral, text: "편집된 General 메시지", editedAt: Date.now() }
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    if (await evaluate("document.querySelector('[data-topic-id=\"1\"] .topic-count') !== null")) {
      throw new Error("A duplicate or edited General message resurrected the unread badge");
    }

    const newerGeneral = fixtureMessage(47075, "확인 뒤의 새 General 메시지", { topicId: 1, outgoing: false });
    client.generalMessages.push(newerGeneral);
    generalTopic.topMessageId = newerGeneral.id;
    generalTopic.unreadCount = 1;
    client.delayNextRead = true;
    server.publishUpdate({ type: "message_upsert", message: newerGeneral });
    await waitFor(() => client.readPending, "newer General read confirmation pending");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"1\"] .topic-count')?.textContent === '1'"
    ), "newer General unread badge");
    client.releaseRead?.();
    await waitFor(() => !client.readPending, "newer General read completion");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"1\"] .topic-count') === null"
    ), "newer General unread clear");

    await evaluate("document.querySelector('[data-topic-id=\"42\"]')?.click(); true");
    await waitFor(async () => await evaluate(
      "document.querySelector('#topic-title')?.textContent === '반응형 터미널'"
    ), "ordinary topic before inverse General snapshot race");
    const generalReadsBeforeInverseRace = client.calls.readInputs.filter((input) => input.topicId === 1).length;
    const inverseRaceGeneral = fixtureMessage(47076, "낡은 snapshot보다 먼저 도착한 General 메시지", {
      topicId: 1,
      outgoing: false
    });
    client.generalMessages.push(inverseRaceGeneral);
    generalTopic.topMessageId = inverseRaceGeneral.id;
    generalTopic.unreadCount = 1;
    server.publishUpdate({ type: "message_upsert", message: inverseRaceGeneral });
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"1\"] .topic-count')?.textContent === '1'"
    ), "inverse-race newer General unread badge");

    generalTopic.topMessageId = 47075;
    generalTopic.unreadCount = 8;
    client.delayNextHistory = true;
    server.publishUpdate({ type: "reconcile_required" });
    await waitFor(() => client.historyPending, "inverse General stale snapshot barrier");
    if (
      !await evaluate("document.querySelector('[data-topic-id=\"1\"] .topic-count')?.textContent === '1'")
      || client.calls.readInputs.filter((input) => input.topicId === 1).length !== generalReadsBeforeInverseRace
    ) throw new Error("A stale General snapshot erased a newer local unread or issued an inactive read");
    client.releaseHistory?.();
    await waitFor(() => !client.historyPending, "inverse General snapshot reconciliation completion");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"1\"] .topic-count')?.textContent === '1'"
    ), "inverse General unread after reconciliation commit");
    if (client.calls.readInputs.filter((input) => input.topicId === 1).length !== generalReadsBeforeInverseRace) {
      throw new Error("Inverse General reconciliation issued an inactive read after commit");
    }

    const partialRaceGeneral = fixtureMessage(47077, "부분 snapshot보다 먼저 도착한 General 메시지", {
      topicId: 1,
      outgoing: false
    });
    client.generalMessages.push(partialRaceGeneral);
    generalTopic.topMessageId = partialRaceGeneral.id;
    generalTopic.unreadCount = 2;
    server.publishUpdate({ type: "message_upsert", message: partialRaceGeneral });
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"1\"] .topic-count')?.textContent === '2'"
    ), "partial-race newer General unread badge");

    generalTopic.topMessageId = 47076;
    generalTopic.unreadCount = 1;
    client.delayNextHistory = true;
    server.publishUpdate({ type: "reconcile_required" });
    await waitFor(() => client.historyPending, "partial General snapshot barrier");
    if (
      !await evaluate("document.querySelector('[data-topic-id=\"1\"] .topic-count')?.textContent === '2'")
      || client.calls.readInputs.filter((input) => input.topicId === 1).length !== generalReadsBeforeInverseRace
    ) throw new Error("A partial General snapshot undercounted newer local unreads or issued an inactive read");
    client.releaseHistory?.();
    await waitFor(() => !client.historyPending, "partial General snapshot reconciliation completion");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"1\"] .topic-count')?.textContent === '2'"
    ), "partial General unread after reconciliation commit");
    if (client.calls.readInputs.filter((input) => input.topicId === 1).length !== generalReadsBeforeInverseRace) {
      throw new Error("Partial General reconciliation issued an inactive read after commit");
    }

    generalTopic.topMessageId = 47075;
    generalTopic.unreadCount = 0;
    client.delayNextHistory = true;
    server.publishUpdate({ type: "reconcile_required" });
    await waitFor(() => client.historyPending, "zero General snapshot barrier");
    if (
      !await evaluate("document.querySelector('[data-topic-id=\"1\"] .topic-count')?.textContent === '2'")
      || client.calls.readInputs.filter((input) => input.topicId === 1).length !== generalReadsBeforeInverseRace
    ) throw new Error("A stale zero General snapshot erased newer local unreads or issued an inactive read");
    client.releaseHistory?.();
    await waitFor(() => !client.historyPending, "zero General snapshot reconciliation completion");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"1\"] .topic-count')?.textContent === '2'"
    ), "zero General unread after reconciliation commit");
    if (client.calls.readInputs.filter((input) => input.topicId === 1).length !== generalReadsBeforeInverseRace) {
      throw new Error("Zero General reconciliation issued an inactive read after commit");
    }
    await evaluate("document.querySelector('[data-topic-id=\"1\"]')?.click(); true");
    await waitFor(
      () => client.calls.readInputs.some((input) => input.topicId === 1 && input.maxMessageId === 47077),
      "inverse-race General exact read target"
    );
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"1\"] .topic-count') === null"
    ), "inverse-race General unread clear");
    process.stdout.write("G002 renderer: inactive General preserved, active exact retry cleared, stale snapshot stayed retired, and newer incoming re-read passed\n");

    await evaluate("document.querySelector('[data-topic-id=\"1\"]')?.click(); true");
    await waitFor(async () => await evaluate(
      "document.querySelector('#topic-title')?.textContent === 'General' && !document.querySelector('#general-panel').hidden"
    ), "General panel after topic return");
    await evaluate(`(() => {
      document.querySelector('#general-panel button')?.click();
      document.querySelector('[data-topic-id="42"]')?.click();
      return true;
    })()`);
    await waitFor(async () => await evaluate("document.querySelector('#topic-title')?.textContent === '반응형 터미널'"), "General panel selection race");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    if (client.calls.text !== 1 || !await evaluate("document.querySelector('#general-panel').hidden")) {
      throw new Error("General panel sent after topic selection changed or remained visible");
    }
    await waitFor(async () => await evaluate(
      "document.querySelectorAll('.attachment img').length === 3 && [...document.querySelectorAll('.attachment img')].every((image) => image.complete)"
    ), "fixture images after General panel selection race");
    process.stdout.write("G001 renderer: General alias, panel fallback/dynamic/cache/visibility/click passed\n");

    const measurements = [];
    for (const width of [800, 1280, 1600]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      }, sessionId);
      await new Promise((resolveWait) => setTimeout(resolveWait, 120));
      const metrics = await evaluate(`(() => {
        const normal = [...document.querySelectorAll('.message-text')];
        const pre = document.querySelector('.message-text pre');
        const body = document.querySelector('.message-body');
        const outgoing = document.querySelector('.message-row[data-outgoing="true"]');
        const incoming = document.querySelector('.message-row[data-outgoing="false"]');
        const outgoingSender = outgoing?.querySelector('.message-meta strong');
        const outgoingText = outgoing?.querySelector('.message-text');
        const composer = document.querySelector('.composer-shell')?.getBoundingClientRect();
        const viewport = document.querySelector('#message-viewport')?.getBoundingClientRect();
        const messageInput = document.querySelector('#message-input');
        const attachButton = document.querySelector('#attach-button');
        const meta = document.querySelector('.message-meta');
        const row = document.querySelector('.message-row');
        return {
          width: innerWidth,
          pageScrollWidth: document.documentElement.scrollWidth,
          normalOverflow: normal.filter((node) => node.scrollWidth > node.clientWidth + 1).length,
          preClientWidth: pre?.clientWidth || 0,
          preScrollWidth: pre?.scrollWidth || 0,
          bodyWidth: body?.getBoundingClientRect().width || 0,
          rowWidth: document.querySelector('.message-row')?.getBoundingClientRect().width || 0,
          terminalWidth: document.querySelector('#terminal')?.getBoundingClientRect().width || 0,
          terminalHeight: document.querySelector('#terminal')?.getBoundingClientRect().height || 0,
          documentScrollHeight: document.documentElement.scrollHeight,
          composerTop: composer?.top || 0,
          composerBottom: composer?.bottom || 0,
          messageViewportHeight: viewport?.height || 0,
          connectionText: document.querySelector('#connection-label')?.textContent || '',
          connectionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('#connection-status')).fontSize) || 0,
          connectionVisible: document.querySelector('#connection-label')?.getBoundingClientRect().width > 0,
          accentColor: getComputedStyle(document.querySelector('.prompt')).color,
          outgoingSenderColor: outgoingSender ? getComputedStyle(outgoingSender).color : '',
          outgoingTextColor: outgoingText ? getComputedStyle(outgoingText).color : '',
          outgoingBackground: outgoing ? getComputedStyle(outgoing).backgroundColor : '',
          incomingBackground: incoming ? getComputedStyle(incoming).backgroundColor : '',
          terminalBackgroundImage: getComputedStyle(document.querySelector('#terminal')).backgroundImage,
          rowBorderBottomWidth: outgoing ? getComputedStyle(outgoing).borderBottomWidth : '',
          messageFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.message-text')).fontSize) || 0,
          inputFontSize: Number.parseFloat(getComputedStyle(messageInput).fontSize) || 0,
          inputHeight: messageInput?.getBoundingClientRect().height || 0,
          attachHeight: attachButton?.getBoundingClientRect().height || 0,
          metaBottom: meta?.getBoundingClientRect().bottom || 0,
          bodyTop: body?.getBoundingClientRect().top || 0,
          bodyRight: body?.getBoundingClientRect().right || 0,
          rowRight: row?.getBoundingClientRect().right || 0,
          hasRemovedUi: !document.querySelector('#send-button, .composer-help, .sidebar-footer')
        };
      })()`);
      if (metrics.pageScrollWidth > width || metrics.normalOverflow !== 0) {
        throw new Error(`Responsive overflow at ${width}px`);
      }
      if (metrics.preScrollWidth <= metrics.preClientWidth) {
        throw new Error(`Code block did not retain horizontal overflow at ${width}px`);
      }
      if (metrics.composerTop < 0 || metrics.composerBottom > 900 || metrics.messageViewportHeight < 200) {
        throw new Error(`Composer left the visible viewport at ${width}px: ${JSON.stringify(metrics)}`);
      }
      if (!metrics.connectionVisible || metrics.connectionFontSize <= 0 || !metrics.connectionText) {
        throw new Error(`Connection status text was not visible at ${width}px`);
      }
      if (metrics.outgoingSenderColor !== metrics.accentColor || metrics.outgoingTextColor !== metrics.accentColor) {
        throw new Error(`Outgoing terminal color did not match the accent at ${width}px: ${JSON.stringify(metrics)}`);
      }
      if (metrics.outgoingBackground !== metrics.incomingBackground) {
        throw new Error(`Outgoing and incoming row backgrounds differed at ${width}px`);
      }
      if (
        !metrics.hasRemovedUi
        || Math.abs(metrics.inputFontSize - metrics.messageFontSize) > .1
        || Math.abs(metrics.inputHeight - metrics.attachHeight) > 1
        || metrics.bodyTop < metrics.metaBottom - 1
        || Math.abs(metrics.bodyRight - metrics.rowRight) > 34
      ) throw new Error(`Compact composer or full-width message layout failed at ${width}px: ${JSON.stringify(metrics)}`);
      if (metrics.terminalBackgroundImage !== "none" || metrics.rowBorderBottomWidth !== "0px") {
        throw new Error(`Terminal scanline or message separator remained at ${width}px`);
      }
      const screenshot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        fromSurface: true
      }, sessionId);
      writeFileSync(join(evidenceDir, `g003-${width}.png`), Buffer.from(screenshot.data, "base64"));
      measurements.push(metrics);
    }
    if (!(measurements[2].bodyWidth > measurements[1].bodyWidth && measurements[1].bodyWidth > measurements[0].bodyWidth)) {
      throw new Error("Message body did not grow with the available terminal width");
    }
    process.stdout.write("G003 renderer: responsive measurements passed\n");

    await evaluate("document.querySelector('[data-topic-id=\"77\"]')?.click(); true");
    await waitFor(async () => await evaluate(
      "document.querySelector('#topic-title')?.textContent === '긴 이름의 작업 토픽 — overflow 검증'"
      + " && document.querySelector('#empty-state p')?.textContent === '이 토픽에는 표시할 메시지가 없습니다.'"
    ), "inactive fixture topic cache warmup");
    await evaluate("document.querySelector('[data-topic-id=\"42\"]')?.click(); true");
    await waitFor(async () => await evaluate("document.querySelector('#topic-title')?.textContent === '반응형 터미널'"), "return after cache warmup");
    const readsBeforeInactive = client.calls.read;
    const inactiveTopic = client.topics.find((candidate) => candidate.id === 77);
    const inactiveIncoming = fixtureMessage(700, "비활성 토픽의 새 수신 메시지", { topicId: 77, outgoing: false });
    inactiveTopic.topMessageId = inactiveIncoming.id;
    inactiveTopic.unreadCount = 1;
    server.publishUpdate({ type: "message_upsert", message: inactiveIncoming });
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"77\"] .topic-count')?.textContent === '1'"
    ), "inactive unread increment");
    server.publishUpdate({ type: "message_upsert", message: inactiveIncoming });
    server.publishUpdate({
      type: "message_upsert",
      message: { ...inactiveIncoming, text: "비활성 토픽의 편집된 메시지", editedAt: Date.now() }
    });
    const inactiveOutgoing = fixtureMessage(701, "비활성 토픽의 발신 메시지", { topicId: 77, outgoing: true });
    inactiveTopic.topMessageId = inactiveOutgoing.id;
    server.publishUpdate({ type: "message_upsert", message: inactiveOutgoing });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    if (client.calls.read !== readsBeforeInactive || !await evaluate(
      "document.querySelector('[data-topic-id=\"77\"] .topic-count')?.textContent === '1'"
    )) throw new Error("Inactive duplicate, edit, or outgoing message changed unread state");
    await evaluate("document.querySelector('[data-topic-id=\"77\"]')?.click(); true");
    await waitFor(() => client.calls.read > readsBeforeInactive, "cached topic read marker");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"77\"] .topic-count') === null"
    ), "cached topic unread clear");
    await evaluate("document.querySelector('[data-topic-id=\"42\"]')?.click(); true");
    await waitFor(async () => await evaluate("document.querySelector('#topic-title')?.textContent === '반응형 터미널'"), "return after cached topic read");
    await evaluate(`(() => {
      const viewport = document.querySelector('#message-viewport');
      viewport.scrollTop = viewport.scrollHeight;
      return true;
    })()`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    process.stdout.write("G001 renderer: inactive, duplicate, edit, outgoing, and cached read passed\n");

    const staleTopic = client.topics.find((candidate) => candidate.id === 42);
    const readsBeforeBurst = client.calls.read;
    const burstTargetsBefore = client.calls.readTargets.length;
    client.delayNextRead = true;
    for (let id = 470; id <= 478; id += 1) {
      const incoming = fixtureMessage(id, `하단 읽음 단일-flight burst ${id}`, { outgoing: false });
      client.messages.push(incoming);
      staleTopic.topMessageId = incoming.id;
      staleTopic.unreadCount = id - 469;
      server.publishUpdate({ type: "message_upsert", message: incoming });
      if (id === 470) await waitFor(() => client.readPending, "burst first delayed read marker");
    }
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"42\"] .topic-count')?.textContent === '9'"
    ), "burst unread accumulation");
    await new Promise((resolveWait) => setTimeout(resolveWait, 450));
    if (client.calls.read !== readsBeforeBurst + 1 || client.calls.readMax !== 1) {
      throw new Error(`Burst created concurrent reads before release: ${JSON.stringify(client.calls)}`);
    }
    const releaseBurstFirst = client.releaseRead;
    client.delayNextRead = true;
    releaseBurstFirst?.();
    await waitFor(
      () => client.calls.read === readsBeforeBurst + 2 && client.readPending,
      "burst latest-target follow-up"
    );
    if (
      client.calls.readMax !== 1
      || !await evaluate("document.querySelector('[data-topic-id=\"42\"] .topic-count')?.textContent === '9'")
    ) throw new Error("Old burst read success cleared unread state or overlapped its follow-up");
    client.releaseRead?.();
    await waitFor(() => !client.readPending, "burst latest-target completion");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"42\"] .topic-count') === null"
    ), "burst final unread clear");
    await new Promise((resolveWait) => setTimeout(resolveWait, 450));
    const burstTargets = client.calls.readTargets.slice(burstTargetsBefore);
    if (
      client.calls.read !== readsBeforeBurst + 2
      || client.calls.readMax !== 1
      || JSON.stringify(burstTargets) !== JSON.stringify([470, 478])
    ) throw new Error(`Burst did not converge through exactly first/latest targets: ${JSON.stringify({ burstTargets, calls: client.calls })}`);
    process.stdout.write("G001 renderer: 9-message burst stayed single-flight and converged first/latest exactly once\n");

    const authoritativeTarget = fixtureMessage(480, "authoritative snapshot이 pending retry를 종료하는 메시지", { outgoing: false });
    client.messages.push(authoritativeTarget);
    staleTopic.topMessageId = authoritativeTarget.id;
    staleTopic.unreadCount = 1;
    client.pendingReadFailures = 1;
    const readsBeforeAuthoritative = client.calls.read;
    server.publishUpdate({ type: "message_upsert", message: authoritativeTarget });
    await waitFor(() => client.calls.read === readsBeforeAuthoritative + 1, "authoritative target pending read");
    const topicsBeforeAuthoritative = client.calls.topics;
    server.publishUpdate({ type: "reconcile_required" });
    await waitFor(() => client.calls.topics > topicsBeforeAuthoritative, "authoritative unread-zero snapshot");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"42\"] .topic-count') === null"
    ), "authoritative snapshot unread clear");
    await new Promise((resolveWait) => setTimeout(resolveWait, 900));
    if (client.calls.read !== readsBeforeAuthoritative + 1) {
      throw new Error("Authoritative unread-zero snapshot did not retire the scheduled target-A retry");
    }

    const independentTarget = fixtureMessage(481, "새 target이 독립된 세 번의 retry budget을 쓰는 메시지", { outgoing: false });
    client.messages.push(independentTarget);
    staleTopic.topMessageId = independentTarget.id;
    staleTopic.unreadCount = 1;
    client.pendingReadFailures = 3;
    const readsBeforeIndependent = client.calls.read;
    const independentTargetsBefore = client.calls.readTargets.length;
    server.publishUpdate({ type: "message_upsert", message: independentTarget });
    await waitFor(
      () => client.calls.read === readsBeforeIndependent + 4,
      "independent target full retry budget",
      12_000
    );
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"42\"] .topic-count') === null"
    ), "independent target final unread clear");
    const independentTargets = client.calls.readTargets.slice(independentTargetsBefore);
    if (JSON.stringify(independentTargets) !== JSON.stringify([481, 481, 481, 481])) {
      throw new Error(`Independent target did not receive initial plus all three retries: ${JSON.stringify(independentTargets)}`);
    }
    process.stdout.write("G001 renderer: authoritative target-A retirement preserved target-B full retry budget\n");

    client.delayNextRead = true;
    const staleFirst = fixtureMessage(500, "읽음 요청과 경쟁하는 첫 메시지");
    client.messages.push(staleFirst);
    staleTopic.topMessageId = staleFirst.id;
    staleTopic.unreadCount = 1;
    server.publishUpdate({ type: "message_upsert", message: staleFirst });
    await waitFor(() => client.readPending, "delayed read marker");
    await evaluate(`(() => {
      const viewport = document.querySelector('#message-viewport');
      viewport.scrollTop = Math.floor(viewport.scrollHeight * .45);
      return true;
    })()`);
    const staleSecond = fixtureMessage(502, "낡은 읽음 성공 뒤에도 남아야 하는 메시지");
    client.messages.push(staleSecond);
    staleTopic.topMessageId = staleSecond.id;
    staleTopic.unreadCount = 2;
    server.publishUpdate({ type: "message_upsert", message: staleSecond });
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-message-id=\"502\"]') !== null"
    ), "stale read second message");
    const staleBadge = await evaluate("document.querySelector('[data-topic-id=\"42\"] .topic-count')?.textContent || ''");
    if (staleBadge !== "2") throw new Error(`Stale read unread generation was ${staleBadge || "missing"}, expected 2`);
    client.releaseRead?.();
    await waitFor(() => !client.readPending, "stale read completion");
    if (!await evaluate("document.querySelector('[data-topic-id=\"42\"] .topic-count')?.textContent === '2'")) {
      throw new Error("A stale read completion cleared newer unread messages");
    }
    client.delayNextRead = true;
    client.pendingReadFailures = 1;
    const readsBeforeFailure = client.calls.read;
    await evaluate(`(() => {
      const viewport = document.querySelector('#message-viewport');
      viewport.scrollTop = viewport.scrollHeight;
      return true;
    })()`);
    await waitFor(() => client.readPending && client.calls.read > readsBeforeFailure, "failed read marker");
    client.releaseRead?.();
    await waitFor(() => !client.readPending, "pending read completion");
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    if (!await evaluate("document.querySelector('[data-topic-id=\"42\"] .topic-count')?.textContent === '2'")) {
      throw new Error("A pending read marker cleared unread messages before confirmation");
    }
    await waitFor(() => client.calls.read > readsBeforeFailure + 1, "automatic read retry without scroll");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"42\"] .topic-count') === null"
    ), "automatic read retry unread clear");

    client.failReads = true;
    const permanentIncoming = fixtureMessage(503, "영구 읽음 오류는 자동 재시도하지 않는 메시지");
    client.messages.push(permanentIncoming);
    staleTopic.topMessageId = permanentIncoming.id;
    staleTopic.unreadCount = 1;
    const readsBeforePermanent = client.calls.read;
    server.publishUpdate({ type: "message_upsert", message: permanentIncoming });
    await waitFor(() => client.calls.read > readsBeforePermanent, "permanent failed read marker");
    const readsAfterPermanent = client.calls.read;
    await new Promise((resolveWait) => setTimeout(resolveWait, 900));
    const permanentBadge = await evaluate("document.querySelector('[data-topic-id=\"42\"] .topic-count')?.textContent || ''");
    if (client.calls.read !== readsAfterPermanent || permanentBadge !== "1") {
      throw new Error(`A permanent read failure retried automatically or cleared unread state: ${JSON.stringify({ readsAfterPermanent, readsNow: client.calls.read, permanentBadge })}`);
    }
    client.failReads = false;
    client.delayNextRead = true;
    const reconcileReadMessage = fixtureMessage(504, "토픽 재조정과 경쟁하는 읽음 메시지", { outgoing: false });
    client.messages.push(reconcileReadMessage);
    staleTopic.topMessageId = reconcileReadMessage.id;
    staleTopic.unreadCount = 1;
    server.publishUpdate({ type: "message_upsert", message: reconcileReadMessage });
    await waitFor(() => client.readPending, "reconcile delayed read marker");
    const reconcileTopicsBeforeRead = client.calls.topics;
    server.publishUpdate({ type: "reconcile_required" });
    await waitFor(() => client.calls.topics > reconcileTopicsBeforeRead, "read marker topic reconciliation");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"42\"] .topic-count')?.textContent === '1'"
    ), "reconciled unread snapshot");
    client.releaseRead?.();
    await waitFor(() => !client.readPending, "reconciled read completion");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"42\"] .topic-count') === null"
    ), "reconciled read clear");
    process.stdout.write("G001 renderer: stale, pending-auto-retry, permanent-failure, and reconcile-raced read markers passed\n");

    await evaluate(`(() => {
      const viewport = document.querySelector('#message-viewport');
      viewport.scrollTop = Math.floor(viewport.scrollHeight * .45);
      return true;
    })()`);
    const snapshotFirst = fixtureMessage(506, "낡은 토픽 스냅샷보다 먼저 읽을 메시지 1", { outgoing: false });
    const snapshotSecond = fixtureMessage(507, "낡은 토픽 스냅샷보다 먼저 읽을 메시지 2", { outgoing: false });
    client.messages.push(snapshotFirst, snapshotSecond);
    staleTopic.topMessageId = snapshotSecond.id;
    staleTopic.unreadCount = 2;
    server.publishUpdate({ type: "message_upsert", message: snapshotFirst });
    server.publishUpdate({ type: "message_upsert", message: snapshotSecond });
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"42\"] .topic-count')?.textContent === '2'"
    ), "pre-snapshot unread badge");

    client.readAccepted = false;
    client.delayNextTopicSnapshot = true;
    const topicsBeforeSnapshotRace = client.calls.topics;
    const historyBeforeSnapshotRace = client.calls.history;
    server.publishUpdate({ type: "reconcile_required" });
    await waitFor(() => client.topicSnapshotCaptured, "captured stale topic snapshot");
    await evaluate(`(() => {
      const viewport = document.querySelector('#message-viewport');
      viewport.scrollTop = viewport.scrollHeight;
      return true;
    })()`);
    await waitFor(() => client.readAccepted && staleTopic.unreadCount === 0, "read accepted during topic snapshot barrier");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"42\"] .topic-count') === null"
    ), "authoritative read badge clear");

    client.delayNextRead = true;
    client.releaseTopicSnapshot?.();
    await waitFor(() => client.calls.topics >= topicsBeforeSnapshotRace + 4, "stale topic snapshot retry");
    await waitFor(() => client.calls.history > historyBeforeSnapshotRace, "fresh topic snapshot reconciliation");
    if (!await evaluate("document.querySelector('[data-topic-id=\"42\"] .topic-count') === null")) {
      throw new Error("A stale topic snapshot resurrected an already-read badge");
    }

    client.readAccepted = false;
    await evaluate(`(() => {
      const viewport = document.querySelector('#message-viewport');
      viewport.scrollTop = viewport.scrollHeight;
      return true;
    })()`);
    const postSnapshotIncoming = fixtureMessage(508, "낡은 스냅샷 폐기 뒤의 새 메시지", { outgoing: false });
    client.messages.push(postSnapshotIncoming);
    staleTopic.topMessageId = postSnapshotIncoming.id;
    staleTopic.unreadCount = 1;
    server.publishUpdate({ type: "message_upsert", message: postSnapshotIncoming });
    await waitFor(() => client.readConfirmationPending, "post-snapshot read confirmation pending");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"42\"] .topic-count')?.textContent === '1'"
    ), "post-snapshot unread retained pending confirmation");
    client.releaseRead?.();
    await waitFor(() => client.readAccepted && !client.readConfirmationPending, "post-snapshot read accepted");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"42\"] .topic-count') === null"
    ), "post-snapshot unread clear");
    process.stdout.write("G002 renderer: stale topic snapshot retry and read confirmation passed\n");

    client.delayNextHistory = true;
    process.stdout.write("G003 renderer: older race armed\n");
    await evaluate("document.querySelector('#load-older').focus(); true");
    process.stdout.write("G003 renderer: older button focused\n");
    await pressKey("Enter");
    await waitFor(() => client.historyPending, "delayed older history");
    process.stdout.write("G003 renderer: older request pending\n");
    await evaluate("document.querySelector('[data-topic-id=\"1100\"]')?.focus(); true");
    process.stdout.write("G003 renderer: race topic focused\n");
    await pressKey("Enter");
    process.stdout.write("G003 renderer: race topic Enter completed\n");
    await waitFor(async () => await evaluate("document.querySelector('#topic-title')?.textContent === '보관 토픽 101'"), "topic switch during older history");
    process.stdout.write("G003 renderer: race topic selected\n");
    client.releaseHistory?.();
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    if (!await evaluate("document.querySelector('#topic-title')?.textContent === '보관 토픽 101' && document.querySelectorAll('.message-row').length === 0")) {
      throw new Error("Delayed older history corrupted the newly selected topic");
    }
    process.stdout.write("G003 renderer: delayed response stayed isolated\n");
    await evaluate("document.querySelector('[data-topic-id=\"42\"]')?.focus(); true");
    await pressKey("Enter");
    process.stdout.write("G003 renderer: return topic Enter completed\n");
    await waitFor(async () => await evaluate("document.querySelector('[data-message-id=\"292\"]') !== null"), "return after older-history race");
    process.stdout.write("G003 renderer: returned after race\n");
    for (const minimumRows of [190, 250]) {
      await evaluate("document.querySelector('#load-older').focus(); true");
      await pressKey("Enter");
      process.stdout.write(`G003 renderer: requested history page ${minimumRows}\n`);
      await waitFor(async () => await evaluate(`document.querySelectorAll('.message-row').length >= ${minimumRows}`), `history page ${minimumRows}`);
      process.stdout.write(`G003 renderer: loaded history page ${minimumRows}\n`);
    }
    process.stdout.write("G003 renderer: older-history race and bounded deep history passed\n");

    await evaluate("window.__chatkjbNode = document.querySelector('[data-message-id=\"291\"]'); true");
    const editedText = "코드 출력이 같은 행에서 수정되었습니다.";
    server.publishUpdate({ type: "message_upsert", message: fixtureMessage(291, editedText, { editedAt: Date.now() }) });
    await waitFor(async () => await evaluate(
      `document.querySelector('[data-message-id="291"]')?.textContent.includes(${JSON.stringify(editedText)})`
    ), "edited message");
    const sameNode = await evaluate("window.__chatkjbNode === document.querySelector('[data-message-id=\"291\"]')");
    if (!sameNode) throw new Error("Edited message replaced its keyed DOM row");

    const anchorBefore = await evaluate(`(() => {
      const viewport = document.querySelector('#message-viewport');
      viewport.scrollTop = Math.floor(viewport.scrollHeight * .45);
      const top = viewport.getBoundingClientRect().top;
      const row = [...document.querySelectorAll('.message-row')].find((node) => node.getBoundingClientRect().bottom >= top);
      return { id: row?.dataset.messageId, offset: row?.getBoundingClientRect().top - top };
    })()`);
    const readsBeforeFarMessage = client.calls.read;
    const farMessage = fixtureMessage(520, "새 메시지는 과거 읽기 위치를 빼앗지 않습니다.");
    client.messages.push(farMessage);
    const activeTopic = client.topics.find((candidate) => candidate.id === 42);
    activeTopic.topMessageId = farMessage.id;
    activeTopic.unreadCount = 1;
    server.publishUpdate({ type: "message_upsert", message: farMessage });
    await waitFor(async () => await evaluate("document.querySelector('[data-message-id=\"520\"]') !== null"), "new message");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"42\"] .topic-count')?.textContent === '1'"
    ), "far-bottom unread increment");
    if (client.calls.read !== readsBeforeFarMessage) throw new Error("Far-bottom incoming message was marked read");
    const anchorAfter = await evaluate(`(() => {
      const viewport = document.querySelector('#message-viewport');
      const top = viewport.getBoundingClientRect().top;
      const row = [...document.querySelectorAll('.message-row')].find((node) => node.getBoundingClientRect().bottom >= top);
      return { id: row?.dataset.messageId, offset: row?.getBoundingClientRect().top - top };
    })()`);
    if (anchorBefore.id !== anchorAfter.id || Math.abs(anchorBefore.offset - anchorAfter.offset) > 2) {
      throw new Error("Incoming message changed the historical scroll anchor");
    }

    const historyBeforeReconcile = client.calls.history;
    server.publishUpdate({ type: "reconcile_required" });
    await waitFor(() => client.calls.history > historyBeforeReconcile, "history reconciliation");
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
    const anchorAfterReconcile = await evaluate(`(() => {
      const viewport = document.querySelector('#message-viewport');
      const top = viewport.getBoundingClientRect().top;
      const row = [...document.querySelectorAll('.message-row')].find((node) => node.getBoundingClientRect().bottom >= top);
      return { id: row?.dataset.messageId, offset: row?.getBoundingClientRect().top - top };
    })()`);
    if (anchorBefore.id !== anchorAfterReconcile.id || Math.abs(anchorBefore.offset - anchorAfterReconcile.offset) > 2) {
      throw new Error("Reconciliation changed the historical scroll anchor");
    }
    process.stdout.write("G003 renderer: reconciliation anchor passed\n");

    await evaluate("document.querySelector('[data-topic-id=\"1100\"]')?.focus(); true");
    await pressKey("Enter");
    await waitFor(async () => await evaluate("document.querySelector('#topic-title')?.textContent === '보관 토픽 101'"), "second-page topic activation");
    const topicsBeforeReconcile = client.calls.topics;
    server.publishUpdate({ type: "reconcile_required" });
    await waitFor(() => client.calls.topics > topicsBeforeReconcile + 1, "full topic pagination reconciliation");
    await waitFor(async () => await evaluate("document.querySelector('#topic-title')?.textContent === '보관 토픽 101'"), "second-page topic preservation");
    await waitFor(
      async () => await evaluate("document.activeElement?.dataset.topicId === '1100'"),
      "reconciliation topic focus restoration"
    );
    const topicsBeforeAtomicRefresh = await evaluate("[...document.querySelectorAll('[data-topic-id]')].map((node) => node.dataset.topicId).join(',')");
    client.topics.push(topic(1300, "원자적 새 토픽"));
    client.delayNextTopicPage = true;
    server.publishUpdate({ type: "reconcile_required" });
    await waitFor(() => client.topicPagePending, "delayed second topic page");
    const topicsDuringAtomicRefresh = await evaluate("[...document.querySelectorAll('[data-topic-id]')].map((node) => node.dataset.topicId).join(',')");
    if (topicsDuringAtomicRefresh !== topicsBeforeAtomicRefresh) {
      throw new Error("An intermediate topic page replaced the committed topic DOM");
    }
    client.releaseTopicPage?.();
    await waitFor(async () => await evaluate("document.querySelector('[data-topic-id=\"1300\"]') !== null"), "atomic topic commit");

    const topicsBeforeInvalidation = client.calls.topics;
    client.topics.push(topic(1301, "무효화 재시도 최신 토픽"));
    client.invalidateNextTopicPage = true;
    server.publishUpdate({ type: "reconcile_required" });
    await waitFor(() => client.topicInvalidations === 1, "topic history invalidation");
    server.publishUpdate({ type: "message_upsert", message: fixtureMessage(610, "queued stale", { topicId: 1100 }) });
    server.publishUpdate({ type: "message_upsert", message: fixtureMessage(610, "queued latest", { topicId: 1100 }) });
    await waitFor(() => client.calls.topics >= topicsBeforeInvalidation + 4, "bounded invalidation retry");
    await waitFor(async () => await evaluate("document.querySelector('[data-topic-id=\"1301\"]') !== null"), "retried latest topic commit");
    await waitFor(async () => await evaluate("document.querySelector('[data-message-id=\"610\"]')?.textContent.includes('queued latest')"), "latest queued SSE after retry");
    if (await evaluate("document.querySelector('#alert')?.textContent.includes('HISTORY_INVALIDATED')")) {
      throw new Error("HISTORY_INVALIDATED was surfaced to the user");
    }

    await evaluate(`(() => {
      const alert = document.querySelector('#alert');
      window.__g002AlertShows = 0;
      window.__g002AlertObserver = new MutationObserver(() => {
        if (!alert.hidden) window.__g002AlertShows += 1;
      });
      window.__g002AlertObserver.observe(alert, { attributes: true, childList: true, subtree: true });
      return true;
    })()`);
    client.failTopics = true;
    const firstFailureCall = client.calls.topics;
    server.publishUpdate({ type: "reconcile_required" });
    await waitFor(() => client.calls.topics > firstFailureCall, "first permanent topic failure");
    await waitFor(async () => await evaluate("document.querySelector('#alert')?.textContent.includes('TELEGRAM_OPERATION_FAILED')"), "first reconcile failure alert");
    const secondFailureCall = client.calls.topics;
    server.publishUpdate({ type: "reconcile_required" });
    await waitFor(() => client.calls.topics > secondFailureCall, "repeated permanent topic failure");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    if (await evaluate("window.__g002AlertShows !== 1")) {
      throw new Error("An identical permanent reconcile error re-lit the alert");
    }
    client.failTopics = false;
    await evaluate("window.__g002AlertObserver.disconnect(); true");
    const recoveryTopics = client.calls.topics;
    server.publishUpdate({ type: "reconcile_required" });
    await waitFor(() => client.calls.topics > recoveryTopics + 1, "reconcile recovery after deduplicated error");
    process.stdout.write("G002 renderer: atomic topics, invalidation retry, queued SSE, and alert dedupe passed\n");

    await evaluate("document.querySelector('[data-topic-id=\"42\"]')?.focus(); true");
    await pressKey("Enter");
    await waitFor(async () => await evaluate("document.querySelector('[data-message-id=\"292\"]') !== null"), "return to fixture topic");
    process.stdout.write("G003 renderer: paginated topic preservation passed\n");

    server.publishUpdate({ type: "message_delete", topicId: 42, messageIds: [291] });
    await waitFor(async () => await evaluate("document.querySelector('[data-message-id=\"291\"]') === null"), "deleted message");
    process.stdout.write("G003 renderer: edit and delete passed\n");

    await evaluate(`(() => {
      const input = document.querySelector('#message-input');
      input.value = 'renderer send';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return true;
    })()`);
    await pressKey("Enter");
    await waitFor(() => client.calls.text === 2, "text send");
    if (client.calls.texts[1]?.topicId !== 42 || client.calls.texts[1]?.text !== "renderer send") {
      throw new Error(`Composer text send changed topic or contents: ${JSON.stringify(client.calls.texts)}`);
    }
    process.stdout.write("G003 renderer: text send passed\n");
    await evaluate("document.querySelector('.callback-button').focus(); true");
    await pressKey("Enter");
    await waitFor(() => client.calls.callback === 1, "callback");
    await waitFor(async () => await evaluate(
      "!document.querySelector('.callback-button').disabled && !document.querySelector('.callback-button').hasAttribute('aria-busy')"
    ), "callback completion state");
    process.stdout.write("G003 renderer: callback passed\n");
    await evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['fixture'], 'first.txt', { type: 'text/plain' }));
      const input = document.querySelector('#file-input');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!await evaluate("document.activeElement?.id === 'message-input'")) {
      throw new Error("File selection did not restore composer input focus");
    }
    await evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['second'], 'second.txt', { type: 'text/plain' }));
      transfer.items.add(new File(['third'], 'third.txt', { type: 'text/plain' }));
      document.querySelector('#composer').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      return true;
    })()`);
    if (!await evaluate("document.querySelector('#selected-file-label').textContent.includes('first.txt')")) {
      throw new Error("Multiple-file drop silently replaced the selected file");
    }
    await evaluate("document.querySelector('#selected-file-remove').focus(); true");
    await pressKey("Enter");
    if (!await evaluate("document.querySelector('#selected-file').hidden && document.activeElement?.id === 'message-input'")) {
      throw new Error("Keyboard attachment removal did not clear the selection and restore focus");
    }
    await evaluate(`(() => {
      window.__fileArrayBufferCalls = 0;
      File.prototype.arrayBuffer = () => {
        window.__fileArrayBufferCalls += 1;
        throw new Error('File.arrayBuffer must not be used for upload');
      };
      const transfer = new DataTransfer();
      transfer.items.add(new File(['fixture'], 'fixture.txt', { type: 'text/plain' }));
      const input = document.querySelector('#file-input');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const message = document.querySelector('#message-input');
      message.value = 'x'.repeat(1025);
      message.dispatchEvent(new Event('input', { bubbles: true }));
      message.focus();
      return true;
    })()`);
    await pressKey("Enter");
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
    if (client.calls.file !== 0 || !await evaluate("document.querySelector('#message-input').value.length === 1025 && !document.querySelector('#selected-file').hidden")) {
      throw new Error("Oversized file caption was sent or discarded");
    }
    await evaluate(`(() => {
      const message = document.querySelector('#message-input');
      message.value = 'fixture caption';
      message.dispatchEvent(new Event('input', { bubbles: true }));
      message.focus();
      return true;
    })()`);
    client.delayNextFile = true;
    await pressKey("Enter");
    await waitFor(() => client.filePending, "streaming file send pending");
    if (!await evaluate(
      "window.__fileArrayBufferCalls === 0 && document.querySelector('#selected-file-label').textContent.includes('전송 중')"
    )) throw new Error("Browser upload buffered the File or hid its in-progress identity");
    client.releaseFile?.();
    await waitFor(async () => await evaluate("document.querySelector('#selected-file').hidden"), "streaming file send completion");
    const sentFile = client.calls.fileInputs[0];
    if (
      client.calls.file !== 1
      || sentFile?.topicId !== 42
      || sentFile?.name !== "fixture.txt"
      || sentFile?.mimeType !== "text/plain"
      || sentFile?.caption !== "fixture caption"
      || sentFile?.size !== 7
      || sentFile?.bytes !== "fixture"
    ) throw new Error(`Browser File streaming contract failed: ${JSON.stringify(client.calls.fileInputs)}`);
    process.stdout.write("G003 renderer: keyboard actions and direct File body passed\n");

    const finalMetrics = await evaluate(`({
      messageRows: document.querySelectorAll('.message-row').length,
      callbacks: document.querySelectorAll('.callback-button').length,
      images: document.querySelectorAll('.attachment img').length,
      pageScrollWidth: document.documentElement.scrollWidth,
      innerWidth
    })`);
    writeFileSync(join(evidenceDir, "g003-render-metrics.json"), `${JSON.stringify({
      browser: version.Browser,
      spinnerMeasurements,
      generalPanelMeasurements,
      measurements,
      sameNode,
      anchorBefore,
      anchorAfter,
      anchorAfterReconcile,
      calls: client.calls,
      finalMetrics
    }, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write("G001/G003 renderer gate passed: General panel, 800/1280/1600, code overflow, edit identity, scroll anchor, send/file/callback\n");
  } finally {
    process.stdout.write("G003 renderer: cleanup\n");
    client.releaseHistory?.();
    client.releaseTopicPage?.();
    client.releaseRead?.();
    client.releasePanel?.();
    client.releaseFile?.();
    cdp?.close();
    await server.close();
    chrome.kill("SIGTERM");
    await new Promise((resolveExit) => {
      const timer = setTimeout(resolveExit, 2_000);
      chrome.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
