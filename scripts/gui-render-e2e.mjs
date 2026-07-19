#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startGuiServer } from "../dist/gui/server.js";
import { HistoryInvalidatedError } from "../dist/gui/telegram-user-client.js";

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
  calls = { panel: 0, text: 0, texts: [], file: 0, callback: 0, read: 0, topics: 0, history: 0, downloadActive: 0, downloadMax: 0 };
  delayPanel = true;
  panelPending = false;
  releasePanel = null;
  delayNextHistory = false;
  historyPending = false;
  releaseHistory = null;
  delayNextTopicPage = false;
  topicPagePending = false;
  releaseTopicPage = null;
  invalidateNextTopicPage = false;
  topicInvalidations = 0;
  failTopics = false;
  delayNextRead = false;
  readPending = false;
  releaseRead = null;
  failReads = false;

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
        mimeType: "image/png",
        size: tinyPng.byteLength,
        width: 320,
        height: 180,
        token: imageTokens[0]
      }
    }));
    this.messages.push(fixtureMessage(295, "두 번째 이미지 첨부", {
      attachment: { kind: "image", name: "terminal-two.png", mimeType: "image/png", size: tinyPng.byteLength, width: 160, height: 90, token: imageTokens[1] }
    }));
    this.messages.push(fixtureMessage(296, "세 번째 이미지 첨부", {
      attachment: { kind: "image", name: "terminal-three.png", mimeType: "image/png", size: tinyPng.byteLength, width: 160, height: 90, token: imageTokens[2] }
    }));
    this.messages.push(fixtureMessage(294, "문서와 callback", {
      attachment: {
        kind: "document",
        name: "ChatKJB terminal fixture.txt",
        mimeType: "text/plain",
        size: 16,
        token: documentToken
      },
      buttons: [[{ kind: "callback", text: "검증 동작", callbackData: Buffer.from("fixture").toString("base64url") }]]
    }));
    this.topics.find((candidate) => candidate.id === 42).topMessageId = 296;
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
    return {
      topics: this.topics.slice(start, end),
      nextCursor: end < this.topics.length ? { offsetDate: 0, offsetId: 0, offsetTopic: end } : null
    };
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
  async sendFile() { this.calls.file += 1; }
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
    if (this.delayNextRead) {
      this.delayNextRead = false;
      this.readPending = true;
      await new Promise((resolveWait) => { this.releaseRead = resolveWait; });
      this.readPending = false;
      this.releaseRead = null;
    }
    if (this.failReads) {
      throw new Error("fixture read failure");
    }
    const target = this.topics.find((candidate) => candidate.id === topicId);
    if (target && target.topMessageId <= maxMessageId) target.unreadCount = 0;
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
    if (
      client.calls.texts[0]?.topicId !== 1
      || client.calls.texts[0]?.text !== "⚙️ 새 세션 기본값"
      || !await evaluate("document.querySelector('#message-input').value === 'composer preserved' && document.activeElement?.id === 'message-input'")
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
    process.stdout.write("G001 renderer: inactive, duplicate, edit, outgoing, and cached read passed\n");

    client.delayNextRead = true;
    const staleFirst = fixtureMessage(500, "읽음 요청과 경쟁하는 첫 메시지");
    client.messages.push(staleFirst);
    const staleTopic = client.topics.find((candidate) => candidate.id === 42);
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
    client.failReads = true;
    const readsBeforeFailure = client.calls.read;
    await evaluate(`(() => {
      const viewport = document.querySelector('#message-viewport');
      viewport.scrollTop = viewport.scrollHeight;
      return true;
    })()`);
    await waitFor(() => client.readPending && client.calls.read > readsBeforeFailure, "failed read marker");
    client.releaseRead?.();
    await waitFor(() => !client.readPending, "failed read completion");
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    if (!await evaluate("document.querySelector('[data-topic-id=\"42\"] .topic-count')?.textContent === '2'")) {
      throw new Error("A failed read marker cleared unread messages");
    }
    client.failReads = false;
    const readsBeforeRetry = client.calls.read;
    await evaluate(`(() => {
      const viewport = document.querySelector('#message-viewport');
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight - 100);
      viewport.scrollTop = viewport.scrollHeight;
      return true;
    })()`);
    await waitFor(() => client.calls.read > readsBeforeRetry, "read retry");
    await waitFor(async () => await evaluate(
      "document.querySelector('[data-topic-id=\"42\"] .topic-count') === null"
    ), "read retry unread clear");
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
    process.stdout.write("G001 renderer: stale, failed, and reconcile-raced read markers passed\n");

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
    await pressKey("Enter");
    await waitFor(() => client.calls.file === 1, "file send");
    process.stdout.write("G003 renderer: keyboard actions passed\n");

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
