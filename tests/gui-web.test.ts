import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The browser module is copied verbatim and intentionally has no Node declaration file.
import { formatBytes, GENERAL_PANEL_FALLBACK_ROWS, isAllowedUploadFile, parseEventId, shouldApplyGeneralPanelMessage, shouldSubmitComposerKey } from "../src/gui/web/app.js";

const webDirectory = resolve(import.meta.dirname, "..", "src", "gui", "web");

describe("GUI web interaction helpers", () => {
  it("submits Enter and Command-Enter while preserving Shift-Enter and IME composition", () => {
    const key = (overrides: Record<string, unknown> = {}) => ({
      key: "Enter",
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      keyCode: 13,
      ...overrides
    });

    expect(shouldSubmitComposerKey(key(), false)).toBe(true);
    expect(shouldSubmitComposerKey(key({ metaKey: true }), false)).toBe(true);
    expect(shouldSubmitComposerKey(key({ shiftKey: true }), false)).toBe(false);
    expect(shouldSubmitComposerKey(key({ altKey: true }), false)).toBe(false);
    expect(shouldSubmitComposerKey(key({ ctrlKey: true }), false)).toBe(false);
    expect(shouldSubmitComposerKey(key({ repeat: true }), false)).toBe(false);
    expect(shouldSubmitComposerKey(key({ isComposing: true }), false)).toBe(false);
    expect(shouldSubmitComposerKey(key({ keyCode: 229 }), false)).toBe(false);
    expect(shouldSubmitComposerKey(key(), true)).toBe(false);
  });

  it("accepts only bounded epoch event IDs and formats attachment sizes", () => {
    expect(parseEventId("abcdefghijklmnop:42")).toEqual({ epoch: "abcdefghijklmnop", sequence: 42 });
    for (const invalid of ["short:1", "abcdefghijklmnop:-1", "abcdefghijklmnop:1.5", "x".repeat(200)]) {
      expect(parseEventId(invalid)).toBeNull();
    }
    expect(formatBytes(100)).toBe("100 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
  });

  it("accepts the 100 MiB browser upload boundary and rejects one byte over", () => {
    const limit = 100 * 1024 * 1024;
    expect(isAllowedUploadFile({ type: "image/svg+xml", size: limit }, limit)).toBe(true);
    expect(isAllowedUploadFile({ type: "image/svg+xml", size: limit + 1 }, limit)).toBe(false);
    expect(isAllowedUploadFile({ type: "text/html", size: 1 }, limit)).toBe(false);
    expect(isAllowedUploadFile({ type: "application/pdf", size: 0 }, limit)).toBe(false);
  });

  it("keeps the functional General fallback and accepts only monotonic panel messages", () => {
    expect(GENERAL_PANEL_FALLBACK_ROWS).toEqual([
      ["⚙️ 새 세션 기본값", "🧠 모델"],
      ["🤖 제공자", "💭 추론"],
      ["🛠️ 작업량", "🔑 토큰"]
    ]);
    expect(shouldApplyGeneralPanelMessage(0, 1)).toBe(true);
    expect(shouldApplyGeneralPanelMessage(42, 42)).toBe(true);
    expect(shouldApplyGeneralPanelMessage(42, 43)).toBe(true);
    expect(shouldApplyGeneralPanelMessage(42, 41)).toBe(false);
    expect(shouldApplyGeneralPanelMessage(42, 0)).toBe(false);
    expect(shouldApplyGeneralPanelMessage(42, Number.NaN)).toBe(false);
  });
});

describe("GUI web static security and responsive contract", () => {
  it("contains no HTML-string execution, persistence, telemetry, or service-worker surface", () => {
    const script = readFileSync(resolve(webDirectory, "app.js"), "utf8");
    const html = readFileSync(resolve(webDirectory, "index.html"), "utf8");
    for (const forbidden of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "DOMParser",
      "eval(",
      "new Function",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "serviceWorker",
      "console."
    ]) expect(script).not.toContain(forbidden);
    expect(script).toContain("document.createTextNode");
    expect(script).toContain("textContent");
    expect(script).toContain("noopener noreferrer");
    expect(html).toContain('autocomplete="off"');
    expect(html).not.toContain('autocomplete="current-password"');
    expect(html).toContain("image/svg+xml");
    expect(script).toContain("formatBytes(state.limits.uploadBytes)");
  });

  it("keeps message rows full-width, normal text wrapping, and horizontal overflow on pre only", () => {
    const css = readFileSync(resolve(webDirectory, "styles.css"), "utf8");
    expect(css).toContain("grid-template-columns: var(--sidebar) minmax(0, 1fr)");
    expect(css).toMatch(/\.message-row\s*\{[\s\S]*?width:\s*100%/);
    expect(css).toMatch(/\.message-body\s*\{[\s\S]*?max-width:\s*none/);
    expect(css).toMatch(/\.message-text\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.message-text pre\s*\{[\s\S]*?overflow-x:\s*auto/);
    expect(css).toMatch(/\.message-viewport\s*\{[\s\S]*?overflow-x:\s*hidden/);
    expect(css).not.toMatch(/\.connection-status\s*\{\s*font-size:\s*0/);
    expect(readFileSync(resolve(webDirectory, "app.js"), "utf8")).toContain("acquireMediaSlot");
  });

  it("uses an Enter-only compact composer and full-width two-line message layout", () => {
    const html = readFileSync(resolve(webDirectory, "index.html"), "utf8");
    const script = readFileSync(resolve(webDirectory, "app.js"), "utf8");
    const css = readFileSync(resolve(webDirectory, "styles.css"), "utf8");
    for (const removed of ["send-button", "composer-help", "sidebar-footer", "privacy-dot"]) {
      expect(html).not.toContain(removed);
      expect(script).not.toContain(removed === "send-button" ? "sendButton" : removed);
    }
    expect(css).toContain("--composer-control-height: 2.35rem");
    expect(css).toMatch(/\.composer textarea\s*\{[\s\S]*?font-size:\s*\.84rem;[\s\S]*?line-height:\s*1\.45;/);
    expect(css).toMatch(/#attach-button\s*\{[\s\S]*?height:\s*var\(--composer-control-height\)/);
    expect(css).toMatch(/\.message-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.message-meta\s*\{[\s\S]*?display:\s*flex/);
  });

  it("aliases only the General sidebar item and places its persistent panel above the composer", () => {
    const html = readFileSync(resolve(webDirectory, "index.html"), "utf8");
    const script = readFileSync(resolve(webDirectory, "app.js"), "utf8");
    const css = readFileSync(resolve(webDirectory, "styles.css"), "utf8");
    expect(html).toContain('id="general-panel"');
    expect(html.indexOf('id="general-panel"')).toBeLessThan(html.indexOf('id="composer"'));
    expect(script).toContain('topic.id === GENERAL_TOPIC_ID ? "ChatKJB" : topic.title');
    expect(script).toContain('requestJson("/api/general-panel")');
    expect(script).toContain('postJson(`/api/topics/${GENERAL_TOPIC_ID}/messages`, { text })');
    expect(script).toContain('generation !== state.selectionGeneration');
    expect(script).not.toContain('topic.id === 1 ? "~"');
    expect(css).toMatch(/\.topic-button\[data-topic-id="1"\] \.topic-name\s*\{[\s\S]*?font-weight:\s*800/);
    expect(css).toMatch(/\.general-panel\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  });

  it("tracks topic read state by message id and never clears unread state on request failure", () => {
    const script = readFileSync(resolve(webDirectory, "app.js"), "utf8");
    expect(script).toContain("latestUnreadMessageId");
    expect(script).toContain("inFlightTarget");
    // 읽음 해제 판정은 단조 증가하는 메시지 id로만 한다. 세대(generation) 일치를
    // 조건으로 두면 스트리밍 중 확인 요청이 매번 무효화되어 배지가 남는다.
    expect(script).toContain("read.latestUnreadMessageId <= max");
    expect(script).not.toMatch(/read\.unreadGeneration === unreadGeneration/);
    // 요청이 실패하면 읽음 상태를 건드리지 않는다.
    expect(script).toMatch(/catch \{\s*\/\/ Read markers are best effort[\s\S]*?finally/);
    expect(script).toContain("const isNewIncoming = !existingMessage && !wasKnownByTopic && message.outgoing !== true");
  });

  it("uses a restrained header topic loader and flat outgoing terminal styling", () => {
    const html = readFileSync(resolve(webDirectory, "index.html"), "utf8");
    const script = readFileSync(resolve(webDirectory, "app.js"), "utf8");
    const css = readFileSync(resolve(webDirectory, "styles.css"), "utf8");
    expect(html).not.toContain("load-more-topics");
    expect(html.indexOf('id="topic-loading"')).toBeLessThan(html.indexOf('id="connection-status"'));
    expect(html).toContain('role="status"');
    expect(script).not.toContain("loadMoreTopics");
    expect(script).not.toContain("topicCursor");
    expect(script).not.toContain("loadTopics(");
    expect(script).toMatch(/async function loadAllTopics[\s\S]*?topicLoading\.hidden = false;[\s\S]*?finally[\s\S]*?topicLoading\.hidden = true;/);
    expect(css).toMatch(/\.terminal\s*\{[\s\S]*?background:\s*var\(--bg\);/);
    expect(css).not.toContain("linear-gradient(rgba(110, 231, 183, .018)");
    expect(css).toMatch(/\.message-row\s*\{[\s\S]*?padding:[\s\S]*?\}/);
    expect(css).not.toMatch(/\.message-row\s*\{[\s\S]*?border-bottom/);
    expect(css).not.toContain('.message-row[data-outgoing="true"] { background:');
    expect(css).toMatch(/prefers-reduced-motion:[\s\S]*?\.topic-loading-spinner\s*\{\s*animation:\s*none/);
  });

  it("deduplicates user-triggered native QR requests", () => {
    const script = readFileSync(resolve(webDirectory, "app.js"), "utf8");
    expect(script).toContain("state.qrRequestActive");
    expect(script).toContain('await request("/api/auth/qr", { method: "POST" })');
  });

  it("commits complete topic snapshots and handles reconciliation invalidation quietly", () => {
    const script = readFileSync(resolve(webDirectory, "app.js"), "utf8");
    expect(script).toContain("const topics = new Map();");
    expect(script).toContain("state.topics = topics;");
    expect(script).toContain('errorCode(error) !== "HISTORY_INVALIDATED"');
    expect(script).toContain("40 * state.reconcileInvalidations");
    expect(script).toContain("state.reconcileInvalidations < TOPIC_INVALIDATION_RETRIES");
    expect(script).toContain("state.lastReconcileError !== message");
    expect(script).toMatch(/do \{[\s\S]*?\} while \(state\.reconcileAgain\);\s*const queued = state\.queuedEvents\.splice\(0\)/);
  });
});
