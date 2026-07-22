import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The browser module is copied verbatim and intentionally has no Node declaration file.
import { attachmentProvenanceLabel, attachmentTypeLabel, formatBytes, GENERAL_PANEL_FALLBACK_ROWS, isAllowedUploadFile, parseEventId, shouldApplyGeneralPanelMessage, shouldSubmitComposerKey, topicSnapshotGenerationIsCurrent } from "../src/gui/web/app.js";

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
    expect(formatBytes(4_194_304_000)).toBe("3.91 GiB");
  });

  it("labels Telegram, sanitized, and generated attachment identity without exposing fallback names", () => {
    expect(attachmentProvenanceLabel({ kind: "document", filenameSource: "telegram" }))
      .toBe("Telegram 원본 파일명");
    expect(attachmentProvenanceLabel({ kind: "document", filenameSource: "sanitized" }))
      .toBe("안전하게 정리된 파일명");
    expect(attachmentProvenanceLabel({ kind: "image", filenameSource: "generated" }))
      .toBe("Telegram 사진 · 원본 파일명 없음");
    expect(attachmentProvenanceLabel({ kind: "document", filenameSource: "generated" }))
      .toBe("Telegram 문서 · 원본 파일명 없음");
    expect(attachmentTypeLabel({ kind: "image", mimeType: "image/webp" }))
      .toBe("WebP 이미지 · image/webp");
    expect(attachmentTypeLabel({ kind: "document", mimeType: "application/x-custom" }))
      .toBe("문서 · application/x-custom");
    const script = readFileSync(resolve(webDirectory, "app.js"), "utf8");
    expect(script).toMatch(/filenameSource === "generated"[\s\S]*?"문서 다운로드"/);
  });

  it("accepts any Telegram file type within the Premium browser boundary and rejects one byte over", () => {
    const limit = 4_194_304_000;
    expect(isAllowedUploadFile({ type: "image/svg+xml", size: limit }, limit)).toBe(true);
    expect(isAllowedUploadFile({ type: "image/svg+xml", size: limit + 1 }, limit)).toBe(false);
    expect(isAllowedUploadFile({ type: "text/html", size: 1 }, limit)).toBe(true);
    expect(isAllowedUploadFile({ type: "application/x-msdownload", size: 1 }, limit)).toBe(true);
    expect(isAllowedUploadFile({ type: "", size: 1 }, limit)).toBe(true);
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

  it("accepts only identical safe topic snapshot generations", () => {
    expect(topicSnapshotGenerationIsCurrent(0, 0)).toBe(true);
    expect(topicSnapshotGenerationIsCurrent(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(topicSnapshotGenerationIsCurrent(0, 1)).toBe(false);
    expect(topicSnapshotGenerationIsCurrent(1, 0)).toBe(false);
    expect(topicSnapshotGenerationIsCurrent(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(topicSnapshotGenerationIsCurrent(Number.NaN, Number.NaN)).toBe(false);
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
    for (const required of [
      "attachment-metadata",
      "attachment-action",
      "안전하게 정리된 파일명",
      "원본 파일명 없음",
      "다운로드 한도 초과 · 파일 정보만 표시"
    ]) expect(script).toContain(required);
    expect(script).toContain("document.createTextNode");
    expect(script).toContain("textContent");
    expect(script).toContain("noopener noreferrer");
    expect(html).toContain('autocomplete="off"');
    expect(html).not.toContain('autocomplete="current-password"');
    expect(html).toMatch(/<input id="file-input"[^>]*type="file"/);
    expect(html).not.toMatch(/<input id="file-input"[^>]*accept=/);
    expect(script).toContain("formatBytes(state.limits.uploadBytes)");
    expect(script).not.toContain("file.arrayBuffer(");
    expect(script).toMatch(/body:\s*file,/);
    expect(script).toContain("전송 중");
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
    expect(script).toContain("if (topicId === GENERAL_TOPIC_ID) void refreshGeneralPanel();");
    expect(script).toContain('postJson(`/api/topics/${GENERAL_TOPIC_ID}/messages`, { text })');
    expect(script).toContain('generation !== state.selectionGeneration');
    expect(script).not.toContain('topic.id === 1 ? "~"');
    expect(css).toMatch(/\.topic-button\[data-topic-id="1"\] \.topic-name\s*\{[\s\S]*?font-weight:\s*800/);
    expect(css).toMatch(/\.general-panel\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  });

  it("renders topic titles without a decorative slash prefix", () => {
    const script = readFileSync(resolve(webDirectory, "app.js"), "utf8");
    const css = readFileSync(resolve(webDirectory, "styles.css"), "utf8");
    expect(script).toContain("button.append(name)");
    expect(script).not.toContain("topic-prefix");
    expect(css).not.toContain(".topic-prefix");
    expect(css).toMatch(/\.topic-button\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  });

  it("offers sidebar topic deletion through a right-click context menu", () => {
    const script = readFileSync(resolve(webDirectory, "app.js"), "utf8");
    const css = readFileSync(resolve(webDirectory, "styles.css"), "utf8");
    expect(script).toContain('addEventListener("contextmenu"');
    expect(script).toContain("showTopicContextMenu");
    expect(script).toContain("hideTopicContextMenu");
    expect(script).toContain("토픽 삭제");
    expect(script).toContain('request(`/api/topics/${topicId}`, { method: "DELETE" })');
    expect(script).toContain("연결된 ChatKJB 세션이 있으면 함께 삭제됩니다");
    expect(script).toContain("topic.id !== GENERAL_TOPIC_ID");
    expect(script).toContain("removeTopicLocally");
    expect(css).toContain(".topic-context-menu");
    expect(css).toContain(".topic-context-item-danger");
  });

  it("retries only pending read confirmations and cancels stale read work", () => {
    const script = readFileSync(resolve(webDirectory, "app.js"), "utf8");
    expect(script).toContain("latestUnreadMessageId");
    expect(script).toContain("inFlightTarget");
    expect(script).toContain("const READ_CONFIRMATION_RETRY_DELAYS_MS = [750, 2000, 5000]");
    expect(script).toContain('errorCode(error) === "READ_CONFIRMATION_PENDING"');
    expect(script).toContain("pendingTarget");
    expect(script).toContain("requestAbort");
    expect(script).toContain("failedTarget");
    expect(script).toContain("retryTarget");
    expect(script).toContain("retireConfirmedReadState");
    expect(script).toContain("cancelReadConfirmation");
    expect(script).toContain("cancelAllReadConfirmations");
    // 읽음 해제 판정은 단조 증가하는 메시지 id로만 한다. 세대(generation) 일치를
    // 조건으로 두면 스트리밍 중 확인 요청이 매번 무효화되어 배지가 남는다.
    expect(script).toContain("read.latestUnreadMessageId <= target");
    expect(script).not.toMatch(/read\.unreadGeneration === unreadGeneration/);
    // 영구 실패는 자동 재시도하지 않고, pending 전용 응답만 제한적으로 재시도한다.
    expect(script).toMatch(/catch \(error\)[\s\S]*?READ_CONFIRMATION_PENDING[\s\S]*?scheduleReadConfirmationRetry/);
    const coalescingStart = script.indexOf("if (read.inFlightTarget > 0)");
    const coalescingEnd = script.indexOf("read.pendingTarget = Math.max(read.pendingTarget, max)", coalescingStart);
    const coalescingBlock = script.slice(coalescingStart, coalescingEnd);
    expect(coalescingBlock).toMatch(/max > Math\.max\(read\.inFlightTarget, read\.pendingTarget\)[\s\S]*?read\.pendingTarget = max/);
    expect(coalescingBlock).not.toContain("abort()");
    expect(script).toMatch(/READ_CONFIRMATION_PENDING[\s\S]*?read\.pendingTarget > target[\s\S]*?followUp = true;[\s\S]*?scheduleReadConfirmationRetry/);
    expect(script).toContain("if (read.pendingTarget <= target) read.pendingTarget = 0");
    expect(script).toMatch(/topic\.unreadCount > 0[\s\S]*?read\.highWater = Math\.max\(read\.highWater, topic\.topMessageId\);[\s\S]*?retireConfirmedReadState\(read, read\.highWater\)/);
    expect(script).toMatch(/read\.highWater >= max[\s\S]*?retireConfirmedReadState\(read, read\.highWater\);[\s\S]*?return;/);
    expect(script).toMatch(/selectTopic[\s\S]*?cancelReadConfirmation/);
    expect(script).toMatch(/addEventListener\("pagehide"[\s\S]*?cancelAllReadConfirmations/);
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
    expect(script).toContain("topicReadGeneration: 0");
    expect(script).toMatch(/for \(let attempt[\s\S]*?const topicReadGeneration = state\.topicReadGeneration;[\s\S]*?await requestJson[\s\S]*?topicSnapshotGenerationIsCurrent\(topicReadGeneration, state\.topicReadGeneration\)[\s\S]*?state\.topics = topics;/);
    expect(script).toMatch(/await postJson\(`\/api\/topics\/\$\{topicId\}\/read`[\s\S]*?state\.topicReadGeneration \+= 1;[\s\S]*?read\.highWater/);
    expect(script).toContain('errorCode(error) !== "HISTORY_INVALIDATED"');
    expect(script).toContain("40 * state.reconcileInvalidations");
    expect(script).toContain("state.reconcileInvalidations < TOPIC_INVALIDATION_RETRIES");
    expect(script).toContain("state.lastReconcileError !== message");
    expect(script).toMatch(/do \{[\s\S]*?\} while \(state\.reconcileAgain\);\s*const queued = state\.queuedEvents\.splice\(0\)/);
  });
});
