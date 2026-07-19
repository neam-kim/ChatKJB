const ALLOWED_UPLOAD_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "application/zip",
  "application/octet-stream",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"
]);
const MAX_CACHED_HISTORIES = 12;
const MAX_MESSAGES_PER_HISTORY = 500;
const MAX_HISTORY_PAGES = 5;
const MAX_CACHED_BLOBS = 32;
const MAX_CACHED_BLOB_BYTES = 128 * 1024 * 1024;
const TOPIC_INVALIDATION_RETRIES = 3;
const GENERAL_TOPIC_ID = 1;
export const GENERAL_PANEL_FALLBACK_ROWS = Object.freeze([
  Object.freeze(["⚙️ 새 세션 기본값", "🧠 모델"]),
  Object.freeze(["🤖 제공자", "💭 추론"]),
  Object.freeze(["🛠️ 작업량", "🔑 토큰"])
]);

export function shouldApplyGeneralPanelMessage(currentMessageId, candidateMessageId) {
  return Number.isSafeInteger(candidateMessageId)
    && candidateMessageId > 0
    && candidateMessageId >= currentMessageId;
}

export function shouldSubmitComposerKey(event, composing) {
  return event.key === "Enter"
    && !event.shiftKey
    && !event.altKey
    && !event.ctrlKey
    && !event.repeat
    && !composing
    && event.isComposing !== true
    && event.keyCode !== 229;
}

export function parseEventId(value) {
  const match = typeof value === "string" ? value.match(/^([A-Za-z0-9_-]{16}):(\d+)$/) : null;
  const sequence = match ? Number(match[2]) : Number.NaN;
  return match && Number.isSafeInteger(sequence) ? { epoch: match[1], sequence } : null;
}

export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "크기 미상";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export function isAllowedUploadFile(file, uploadBytes) {
  if (!file || !Number.isFinite(uploadBytes) || uploadBytes < 1) return false;
  const mimeType = file.type || "application/octet-stream";
  return ALLOWED_UPLOAD_TYPES.has(mimeType)
    && Number.isFinite(file.size)
    && file.size >= 1
    && file.size <= uploadBytes;
}

function startApplication() {
  const timeFormatter = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" });
  const elements = {
    shell: document.querySelector("#app-shell"),
    sidebar: document.querySelector("#sidebar"),
    sidebarToggle: document.querySelector("#sidebar-toggle"),
    topicList: document.querySelector("#topic-list"),
    topicTitle: document.querySelector("#topic-title"),
    topicLoading: document.querySelector("#topic-loading"),
    connectionStatus: document.querySelector("#connection-status"),
    connectionLabel: document.querySelector("#connection-label"),
    authPanel: document.querySelector("#auth-panel"),
    authDescription: document.querySelector("#auth-description"),
    qrLogin: document.querySelector("#qr-login"),
    passwordForm: document.querySelector("#password-form"),
    passwordInput: document.querySelector("#password-input"),
    passwordCancel: document.querySelector("#password-cancel"),
    viewport: document.querySelector("#message-viewport"),
    messageList: document.querySelector("#message-list"),
    emptyState: document.querySelector("#empty-state"),
    loadOlder: document.querySelector("#load-older"),
    jumpLatest: document.querySelector("#jump-latest"),
    generalPanel: document.querySelector("#general-panel"),
    composer: document.querySelector("#composer"),
    messageInput: document.querySelector("#message-input"),
    fileInput: document.querySelector("#file-input"),
    attachButton: document.querySelector("#attach-button"),
    selectedFile: document.querySelector("#selected-file"),
    selectedFileLabel: document.querySelector("#selected-file-label"),
    selectedFileRemove: document.querySelector("#selected-file-remove"),
    alert: document.querySelector("#alert")
  };

  if (Object.values(elements).some((element) => !element)) return;

  const state = {
    csrf: "",
    epoch: "",
    lastEventId: "",
    lastSequence: -1,
    connection: "connecting",
    limits: { uploadBytes: 100 * 1024 * 1024, attachmentBytes: 20 * 1024 * 1024 },
    topics: new Map(),
    activeTopicId: null,
    histories: new Map(),
    historyAbort: null,
    olderAbort: null,
    selectionGeneration: 0,
    selectedFile: null,
    composing: false,
    busy: false,
    reconciling: false,
    reconcileAgain: false,
    reconcileInvalidations: 0,
    reconcileRetryTimer: 0,
    queuedEvents: [],
    blobUrls: new Map(),
    blobSizes: new Map(),
    blobBytes: 0,
    mediaControllers: new Map(),
    mediaQueue: [],
    mediaActive: 0,
    typingActive: false,
    typingTimer: 0,
    alertTimer: 0,
    lastReconcileError: "",
    nativeLogout: false,
    qrRequestActive: false,
    readStates: new Map(),
    generalPanelRows: GENERAL_PANEL_FALLBACK_ROWS.map((row) => [...row]),
    panelMessageId: 0,
    panelRefreshStarted: false
  };

  function errorCode(error) {
    return error && typeof error === "object" && typeof error.code === "string"
      ? error.code
      : "REQUEST_FAILED";
  }

  function showAlert(message) {
    window.clearTimeout(state.alertTimer);
    elements.alert.textContent = message;
    elements.alert.hidden = false;
    state.alertTimer = window.setTimeout(() => {
      elements.alert.hidden = true;
      elements.alert.textContent = "";
    }, 5000);
  }

  function apiError(code) {
    const error = new Error("ChatKJB request failed");
    error.code = typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : "REQUEST_FAILED";
    return error;
  }

  async function request(path, options = {}, includeCsrf = true) {
    const headers = new Headers(options.headers || {});
    if (includeCsrf && state.csrf) headers.set("X-ChatKJB-CSRF", state.csrf);
    const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
    if (!response.ok) {
      let code = "REQUEST_FAILED";
      try {
        const body = await response.json();
        if (body && body.error && typeof body.error.code === "string") code = body.error.code;
      } catch {
        // Error bodies are optional and never surfaced verbatim.
      }
      throw apiError(code);
    }
    return response;
  }

  async function requestJson(path, options = {}, includeCsrf = true) {
    return await (await request(path, options, includeCsrf)).json();
  }

  function postJson(path, body) {
    return request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  async function beginQrLogin() {
    if (state.qrRequestActive || state.connection === "waiting_qr" || state.connection === "waiting_password") return;
    state.qrRequestActive = true;
    elements.qrLogin.disabled = true;
    try {
      await request("/api/auth/qr", { method: "POST" });
      setConnection("waiting_qr");
    } catch (error) {
      showAlert(`QR 로그인을 시작하지 못했습니다 · ${errorCode(error)}`);
    } finally {
      state.qrRequestActive = false;
      elements.qrLogin.disabled = false;
    }
  }

  function setConnection(connection, code = "") {
    state.connection = connection;
    const labels = {
      ready: "온라인",
      connecting: "연결 중",
      reconnecting: "재연결 중",
      waiting_qr: "QR 승인 대기",
      waiting_password: "2단계 인증 대기",
      signed_out: "로그인 필요",
      error: code ? `오류 · ${code}` : "연결 오류"
    };
    elements.connectionStatus.dataset.state = connection;
    elements.connectionLabel.textContent = labels[connection] || "오프라인";
    const needsAuth = ["signed_out", "waiting_qr", "waiting_password", "error"].includes(connection);
    elements.authPanel.hidden = !needsAuth;
    elements.qrLogin.hidden = connection === "waiting_password";
    elements.passwordForm.hidden = connection !== "waiting_password";
    if (connection === "waiting_qr") {
      elements.authDescription.textContent = "앱에 표시된 QR을 모바일 Telegram으로 승인해 주십시오.";
    } else if (connection === "waiting_password") {
      elements.authDescription.textContent = "Telegram 2단계 인증 비밀번호를 입력해 주십시오. 값은 저장되지 않습니다.";
      window.setTimeout(() => elements.passwordInput.focus(), 0);
    } else if (connection === "error") {
      elements.authDescription.textContent = "연결에 실패했습니다. QR 로그인을 다시 시작할 수 있습니다.";
    } else {
      elements.authDescription.textContent = "비공식 개인용 클라이언트입니다. QR은 이 앱 안에서만 표시됩니다.";
    }
    const ready = connection === "ready";
    elements.messageInput.disabled = !ready || state.busy || state.activeTopicId === null;
    elements.attachButton.disabled = !ready || state.busy || state.activeTopicId === null;
    updateGeneralPanelState();
    if (ready) void refreshGeneralPanelOnce();
  }

  function panelRows(value) {
    const rows = Array.isArray(value) ? value : value?.rows;
    if (
      !Array.isArray(rows)
      || rows.length !== 3
      || rows.some((row) => !Array.isArray(row) || row.length !== 2 || row.some((text) => typeof text !== "string" || !text))
    ) return null;
    return rows.map((row) => [...row]);
  }

  function updateGeneralPanelState() {
    const active = state.activeTopicId === GENERAL_TOPIC_ID;
    elements.generalPanel.hidden = !active;
    const disabled = !active || state.connection !== "ready" || state.busy;
    for (const button of elements.generalPanel.querySelectorAll("button")) button.disabled = disabled;
  }

  function renderGeneralPanel() {
    const fragment = document.createDocumentFragment();
    for (const row of state.generalPanelRows) {
      for (const command of row) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.command = command;
        button.textContent = command;
        fragment.append(button);
      }
    }
    elements.generalPanel.replaceChildren(fragment);
    updateGeneralPanelState();
  }

  function applyGeneralPanel(candidate, fallbackMessageId = null) {
    const rows = panelRows(candidate);
    const messageId = Number.isSafeInteger(candidate?.messageId)
      ? candidate.messageId
      : fallbackMessageId;
    if (!rows || !shouldApplyGeneralPanelMessage(state.panelMessageId, messageId)) return false;
    state.panelMessageId = messageId;
    state.generalPanelRows = rows;
    renderGeneralPanel();
    return true;
  }

  function applyMessageReplyPanel(message) {
    if (!message || message.topicId !== GENERAL_TOPIC_ID || !message.replyPanel) return;
    applyGeneralPanel(message.replyPanel, message.id);
  }

  async function refreshGeneralPanelOnce() {
    if (state.panelRefreshStarted || !state.csrf || state.connection !== "ready") return;
    state.panelRefreshStarted = true;
    try {
      const response = await requestJson("/api/general-panel");
      if (response?.panel) applyGeneralPanel(response.panel);
    } catch {
      // The functional fallback remains available when bounded Telegram lookup fails.
    }
  }

  function readStateFor(topicId) {
    let read = state.readStates.get(topicId);
    if (!read) {
      read = { latestKnownMessageId: 0, latestUnreadMessageId: 0, unreadGeneration: 0, inFlightTarget: 0, highWater: 0 };
      state.readStates.set(topicId, read);
    }
    return read;
  }

  function updateTopicBadge(topicId) {
    const topic = state.topics.get(topicId);
    const button = [...elements.topicList.querySelectorAll("button")]
      .find((candidate) => candidate.dataset.topicId === String(topicId));
    if (!topic || !button) return;
    let count = button.querySelector(".topic-count");
    if (topic.unreadCount <= 0) {
      count?.remove();
      return;
    }
    if (!count) {
      count = document.createElement("span");
      count.className = "topic-count";
      button.append(count);
    }
    count.textContent = topic.unreadCount > 99 ? "99+" : String(topic.unreadCount);
    count.setAttribute("aria-label", `읽지 않은 메시지 ${topic.unreadCount}개`);
  }

  function historyFor(topicId) {
    let history = state.histories.get(topicId);
    if (!history) {
      history = { messages: new Map(), nextCursor: null, loaded: false, pages: 0, scrollTop: 0, checkpoint: "" };
      state.histories.set(topicId, history);
      while (state.histories.size > MAX_CACHED_HISTORIES) {
        const oldestTopicId = state.histories.keys().next().value;
        if (oldestTopicId === undefined) break;
        if (oldestTopicId === state.activeTopicId) {
          const activeHistory = state.histories.get(oldestTopicId);
          state.histories.delete(oldestTopicId);
          state.histories.set(oldestTopicId, activeHistory);
          continue;
        }
        const oldest = state.histories.get(oldestTopicId);
        state.histories.delete(oldestTopicId);
        for (const messageId of oldest.messages.keys()) revokeMessageMedia(messageId);
      }
    } else {
      state.histories.delete(topicId);
      state.histories.set(topicId, history);
    }
    return history;
  }

  function sortedMessages(history) {
    return [...history.messages.values()].sort((left, right) => left.sentAt - right.sentAt || left.id - right.id);
  }

  function trimHistoryMessages(history) {
    if (history.messages.size <= MAX_MESSAGES_PER_HISTORY) return [];
    const removed = sortedMessages(history).slice(0, history.messages.size - MAX_MESSAGES_PER_HISTORY);
    for (const message of removed) {
      history.messages.delete(message.id);
      revokeMessageMedia(message.id);
    }
    return removed.map((message) => message.id);
  }

  function isNearBottom() {
    return elements.viewport.scrollHeight - elements.viewport.scrollTop - elements.viewport.clientHeight < 64;
  }

  function captureAnchor() {
    const viewportTop = elements.viewport.getBoundingClientRect().top;
    for (const row of elements.messageList.children) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom >= viewportTop) return { id: row.dataset.messageId, offset: rect.top - viewportTop };
    }
    return null;
  }

  function restoreAnchor(anchor) {
    if (!anchor) return;
    const row = [...elements.messageList.children].find((candidate) => candidate.dataset.messageId === anchor.id);
    if (!row) return;
    const current = row.getBoundingClientRect().top - elements.viewport.getBoundingClientRect().top;
    elements.viewport.scrollTop += current - anchor.offset;
  }

  function revokeMessageMedia(messageId) {
    const url = state.blobUrls.get(messageId);
    if (url) URL.revokeObjectURL(url);
    state.blobUrls.delete(messageId);
    state.blobBytes -= state.blobSizes.get(messageId) || 0;
    state.blobSizes.delete(messageId);
    state.mediaControllers.get(messageId)?.abort();
    state.mediaControllers.delete(messageId);
  }

  function reserveBlob(messageId, size) {
    if (state.blobUrls.size >= MAX_CACHED_BLOBS || state.blobBytes + size > MAX_CACHED_BLOB_BYTES) {
      throw apiError("ATTACHMENT_CACHE_LIMIT");
    }
    state.blobSizes.set(messageId, size);
    state.blobBytes += size;
  }

  function clearRenderedMedia() {
    const messageIds = new Set([...state.blobUrls.keys(), ...state.mediaControllers.keys()]);
    for (const messageId of messageIds) revokeMessageMedia(messageId);
  }

  function pumpMediaQueue() {
    const limit = Math.max(1, Math.min(2, Number(state.limits.attachmentDownloads) || 2));
    while (state.mediaActive < limit && state.mediaQueue.length > 0) {
      const entry = state.mediaQueue.shift();
      entry.signal.removeEventListener("abort", entry.abort);
      if (entry.signal.aborted) {
        entry.reject(apiError("ATTACHMENT_ABORTED"));
        continue;
      }
      state.mediaActive += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        state.mediaActive -= 1;
        pumpMediaQueue();
      });
    }
  }

  function acquireMediaSlot(signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(apiError("ATTACHMENT_ABORTED"));
        return;
      }
      const entry = {
        signal,
        resolve,
        reject,
        abort: null
      };
      entry.abort = () => {
        const index = state.mediaQueue.indexOf(entry);
        if (index >= 0) state.mediaQueue.splice(index, 1);
        reject(apiError("ATTACHMENT_ABORTED"));
      };
      signal.addEventListener("abort", entry.abort, { once: true });
      state.mediaQueue.push(entry);
      pumpMediaQueue();
    });
  }

  async function withMediaSlot(signal, task) {
    const release = await acquireMediaSlot(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  function safeExternalUrl(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      const blockedIpv4 = (octets) => {
        if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
        const [a, b, c] = octets;
        return a === 0
          || a === 10
          || a === 127
          || (a === 100 && b >= 64 && b <= 127)
          || (a === 169 && b === 254)
          || (a === 172 && b >= 16 && b <= 31)
          || (a === 192 && b === 0 && c <= 2)
          || (a === 192 && b === 88 && c === 99)
          || (a === 192 && b === 168)
          || (a === 198 && (b === 18 || b === 19))
          || (a === 198 && b === 51 && c === 100)
          || (a === 203 && b === 0 && c === 113)
          || a >= 224;
      };
      const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      const ipv6 = host.replace(/^\[|\]$/g, "");
      const mapped = ipv6.match(/^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
      const mappedOctets = mapped
        ? (() => {
            const high = Number.parseInt(mapped[1], 16);
            const low = Number.parseInt(mapped[2], 16);
            return [high >> 8, high & 255, low >> 8, low & 255];
          })()
        : null;
      const privateAddress = host === "localhost"
        || host.endsWith(".localhost")
        || host.endsWith(".local")
        || (ipv4 && blockedIpv4(ipv4.slice(1).map(Number)))
        || (mappedOctets && blockedIpv4(mappedOctets))
        || host === "[::]"
        || host === "[::1]"
        || /^\[f[cd]/i.test(host)
        || /^\[fe[89a-f]/i.test(host)
        || /^\[64:ff9b(?::1)?:/i.test(host);
      return (url.protocol === "https:" || url.protocol === "http:")
        && !url.username
        && !url.password
        && !privateAddress
        ? url.href
        : null;
    } catch {
      return null;
    }
  }

  function appendTextWithEntities(container, message) {
    const text = typeof message.text === "string" ? message.text : "";
    const entities = Array.isArray(message.entities)
      ? message.entities.filter((entity) => entity
        && ["code", "pre", "url"].includes(entity.kind)
        && Number.isSafeInteger(entity.offset)
        && Number.isSafeInteger(entity.length)
        && entity.offset >= 0
        && entity.length > 0
        && entity.offset + entity.length <= text.length)
        .sort((left, right) => left.offset - right.offset || left.length - right.length)
      : [];
    let cursor = 0;
    for (const entity of entities) {
      if (entity.offset < cursor) continue;
      if (entity.offset > cursor) container.append(document.createTextNode(text.slice(cursor, entity.offset)));
      const segment = text.slice(entity.offset, entity.offset + entity.length);
      if (entity.kind === "pre") {
        const pre = document.createElement("pre");
        if (typeof entity.language === "string" && /^[A-Za-z0-9_+.-]{1,32}$/.test(entity.language)) {
          const label = document.createElement("span");
          label.className = "code-language";
          label.textContent = entity.language;
          pre.append(label);
        }
        const code = document.createElement("code");
        code.textContent = segment;
        pre.append(code);
        container.append(pre);
      } else if (entity.kind === "code") {
        const code = document.createElement("code");
        code.textContent = segment;
        container.append(code);
      } else {
        const href = safeExternalUrl(entity.url);
        if (href) {
          const link = document.createElement("a");
          link.href = href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = segment;
          container.append(link);
        } else {
          container.append(document.createTextNode(segment));
        }
      }
      cursor = entity.offset + entity.length;
    }
    if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
  }

  async function fetchAttachment(message, signal) {
    const token = message.attachment && message.attachment.token;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw apiError("ATTACHMENT_NOT_AVAILABLE");
    return await request(`/api/attachments/${encodeURIComponent(token)}`, { signal });
  }

  async function loadImage(message, attachmentElement) {
    revokeMessageMedia(message.id);
    const controller = new AbortController();
    state.mediaControllers.set(message.id, controller);
    const loading = document.createElement("span");
    loading.className = "attachment-size";
    loading.textContent = "이미지 불러오는 중…";
    attachmentElement.append(loading);
    try {
      const blob = await withMediaSlot(controller.signal, async () => {
        const response = await fetchAttachment(message, controller.signal);
        return await response.blob();
      });
      if (blob.size < 1 || blob.size > state.limits.attachmentBytes) throw apiError("ATTACHMENT_SIZE_INVALID");
      const current = historyFor(message.topicId).messages.get(message.id);
      if (!current || current.attachment?.token !== message.attachment.token || !attachmentElement.isConnected) return;
      const objectUrl = URL.createObjectURL(blob);
      let adopted = false;
      try {
        const image = document.createElement("img");
        image.src = objectUrl;
        image.alt = message.attachment.name;
        if (Number.isSafeInteger(message.attachment.width)) image.width = message.attachment.width;
        if (Number.isSafeInteger(message.attachment.height)) image.height = message.attachment.height;
        await image.decode();
        const latest = historyFor(message.topicId).messages.get(message.id);
        if (
          controller.signal.aborted
          || !latest
          || latest.attachment?.token !== message.attachment.token
          || !attachmentElement.isConnected
        ) return;
        reserveBlob(message.id, blob.size);
        state.blobUrls.set(message.id, objectUrl);
        adopted = true;
        const follow = isNearBottom();
        const anchor = follow ? null : captureAnchor();
        attachmentElement.replaceChildren(image);
        if (follow) elements.viewport.scrollTop = elements.viewport.scrollHeight;
        else restoreAnchor(anchor);
      } finally {
        if (!adopted) URL.revokeObjectURL(objectUrl);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      loading.textContent = `이미지를 불러올 수 없습니다 · ${errorCode(error)}`;
    } finally {
      if (state.mediaControllers.get(message.id) === controller) state.mediaControllers.delete(message.id);
    }
  }

  async function prepareDocument(message, attachmentElement, button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    const controller = new AbortController();
    state.mediaControllers.get(message.id)?.abort();
    state.mediaControllers.set(message.id, controller);
    try {
      const blob = await withMediaSlot(controller.signal, async () => {
        const response = await fetchAttachment(message, controller.signal);
        return await response.blob();
      });
      if (blob.size < 1 || blob.size > state.limits.attachmentBytes) throw apiError("ATTACHMENT_SIZE_INVALID");
      const current = historyFor(message.topicId).messages.get(message.id);
      if (!current || current.attachment?.token !== message.attachment.token || !attachmentElement.isConnected) return;
      revokeMessageMedia(message.id);
      const objectUrl = URL.createObjectURL(blob);
      try {
        reserveBlob(message.id, blob.size);
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
      }
      state.blobUrls.set(message.id, objectUrl);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = message.attachment.name;
      link.textContent = `${message.attachment.name} 다운로드`;
      attachmentElement.replaceChildren(link);
      link.focus();
    } catch (error) {
      if (!controller.signal.aborted) showAlert(`문서를 준비하지 못했습니다 · ${errorCode(error)}`);
      button.disabled = false;
      button.removeAttribute("aria-busy");
    } finally {
      if (state.mediaControllers.get(message.id) === controller) state.mediaControllers.delete(message.id);
    }
  }

  function renderAttachment(message, body) {
    const attachment = message.attachment;
    if (!attachment || typeof attachment.token !== "string") return;
    const element = document.createElement("div");
    element.className = "attachment";
    if (attachment.kind === "image") {
      if (state.mediaControllers.size + state.blobUrls.size >= MAX_CACHED_BLOBS) {
        const bounded = document.createElement("span");
        bounded.className = "attachment-size";
        bounded.textContent = "이 화면의 이미지 자동 로딩 한도에 도달했습니다.";
        element.append(bounded);
        body.append(element);
        return;
      }
      body.append(element);
      void loadImage(message, element);
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "attachment-button";
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "▤";
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = attachment.name;
    const size = document.createElement("span");
    size.className = "attachment-size";
    size.textContent = formatBytes(attachment.size);
    button.append(icon, name, size);
    button.addEventListener("click", () => void prepareDocument(message, element, button));
    element.append(button);
    body.append(element);
  }

  function renderButtons(message, body) {
    if (!Array.isArray(message.buttons) || message.buttons.length === 0) return;
    const keyboard = document.createElement("div");
    keyboard.className = "inline-keyboard";
    keyboard.setAttribute("aria-label", "메시지 동작");
    for (const row of message.buttons) {
      if (!Array.isArray(row)) continue;
      for (const descriptor of row) {
        if (!descriptor || typeof descriptor.text !== "string") continue;
        if (descriptor.kind === "callback" && typeof descriptor.callbackData === "string") {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "callback-button";
          button.textContent = descriptor.text;
          button.addEventListener("click", async () => {
            if (button.disabled) return;
            button.disabled = true;
            button.setAttribute("aria-busy", "true");
            try {
              await postJson(`/api/messages/${message.id}/callback`, { callbackData: descriptor.callbackData });
            } catch (error) {
              showAlert(`버튼 동작에 실패했습니다 · ${errorCode(error)}`);
            } finally {
              button.disabled = false;
              button.removeAttribute("aria-busy");
            }
          });
          keyboard.append(button);
        } else if (descriptor.kind === "url") {
          const href = safeExternalUrl(descriptor.url);
          if (!href) continue;
          const link = document.createElement("a");
          link.href = href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = descriptor.text;
          keyboard.append(link);
        }
      }
    }
    if (keyboard.childElementCount > 0) body.append(keyboard);
  }

  function buildMessageRow(message, existing = null) {
    const row = existing || document.createElement("li");
    revokeMessageMedia(message.id);
    row.className = "message-row";
    row.dataset.messageId = String(message.id);
    row.dataset.outgoing = message.outgoing === true ? "true" : "false";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const sender = document.createElement("strong");
    sender.textContent = message.outgoing ? "나" : "ChatKJB";
    const time = document.createElement("time");
    const date = new Date(message.sentAt);
    time.dateTime = Number.isFinite(date.valueOf()) ? date.toISOString() : "";
    time.textContent = Number.isFinite(date.valueOf())
      ? timeFormatter.format(date)
      : "시간 미상";
    meta.append(sender, time);
    if (message.editedAt !== null) {
      const edited = document.createElement("span");
      edited.className = "edited";
      edited.textContent = "수정됨";
      meta.append(edited);
    }
    const body = document.createElement("div");
    body.className = "message-body";
    const text = document.createElement("div");
    text.className = "message-text";
    appendTextWithEntities(text, message);
    body.append(text);
    renderAttachment(message, body);
    renderButtons(message, body);
    row.replaceChildren(meta, body);
    return row;
  }

  function renderCurrentHistory(scrollToBottom = false) {
    clearRenderedMedia();
    const history = state.activeTopicId === null ? null : historyFor(state.activeTopicId);
    const fragment = document.createDocumentFragment();
    for (const message of history ? sortedMessages(history) : []) fragment.append(buildMessageRow(message));
    elements.messageList.replaceChildren(fragment);
    const empty = !history || history.messages.size === 0;
    elements.emptyState.hidden = !empty;
    elements.loadOlder.hidden = !history?.nextCursor;
    if (scrollToBottom) elements.viewport.scrollTop = elements.viewport.scrollHeight;
    else if (history) elements.viewport.scrollTop = history.scrollTop;
  }

  function messagesEquivalent(left, right) {
    return left?.id === right?.id
      && left?.topicId === right?.topicId
      && left?.text === right?.text
      && left?.sentAt === right?.sentAt
      && left?.editedAt === right?.editedAt
      && left?.outgoing === right?.outgoing
      && JSON.stringify(left?.buttons || []) === JSON.stringify(right?.buttons || [])
      && JSON.stringify(left?.replyPanel || null) === JSON.stringify(right?.replyPanel || null)
      && JSON.stringify(left?.entities || []) === JSON.stringify(right?.entities || [])
      && JSON.stringify(left?.attachment || null) === JSON.stringify(right?.attachment || null);
  }

  function renderReconciledHistory(previousMessages) {
    const history = state.activeTopicId === null ? null : historyFor(state.activeTopicId);
    const existingRows = new Map(
      [...elements.messageList.children].map((row) => [Number(row.dataset.messageId), row])
    );
    const fragment = document.createDocumentFragment();
    for (const message of history ? sortedMessages(history) : []) {
      const existing = existingRows.get(message.id);
      const row = existing && messagesEquivalent(previousMessages.get(message.id), message)
        ? existing
        : buildMessageRow(message, existing || null);
      existingRows.delete(message.id);
      fragment.append(row);
    }
    for (const [messageId] of existingRows) revokeMessageMedia(messageId);
    elements.messageList.replaceChildren(fragment);
    const empty = !history || history.messages.size === 0;
    elements.emptyState.hidden = !empty;
    elements.loadOlder.hidden = !history?.nextCursor;
  }

  function insertRowInOrder(row, message, history) {
    const ordered = sortedMessages(history);
    const index = ordered.findIndex((candidate) => candidate.id === message.id);
    const nextMessage = ordered[index + 1];
    const nextRow = nextMessage
      ? [...elements.messageList.children].find((candidate) => candidate.dataset.messageId === String(nextMessage.id))
      : null;
    elements.messageList.insertBefore(row, nextRow || null);
  }

  function applyMessageUpsert(message) {
    if (!message || !Number.isSafeInteger(message.id) || !Number.isSafeInteger(message.topicId)) return;
    applyMessageReplyPanel(message);
    const history = historyFor(message.topicId);
    const existingMessage = history.messages.get(message.id);
    const topic = state.topics.get(message.topicId);
    const read = readStateFor(message.topicId);
    const wasKnownByTopic = message.id <= read.latestKnownMessageId;
    const isNewIncoming = !existingMessage && !wasKnownByTopic && message.outgoing !== true;
    read.latestKnownMessageId = Math.max(read.latestKnownMessageId, message.id);
    if (topic) topic.topMessageId = Math.max(topic.topMessageId, message.id);
    if (isNewIncoming) {
      read.latestUnreadMessageId = Math.max(read.latestUnreadMessageId, message.id);
      read.unreadGeneration += 1;
      // 화면에 보인다는 이유로 배지를 미리 지우지는 않는다. 읽음은 서버 확인이
      // 성공했을 때만 반영해야, 확인이 지연·실패한 메시지를 놓치지 않는다.
      if (topic) {
        topic.unreadCount += 1;
        updateTopicBadge(message.topicId);
      }
    }
    if (existingMessage?.attachment?.token !== message.attachment?.token) revokeMessageMedia(message.id);
    history.messages.set(message.id, message);
    const removedIds = trimHistoryMessages(history);
    if (state.activeTopicId !== message.topicId) return;
    const follow = isNearBottom();
    const anchor = follow ? null : captureAnchor();
    const existingRow = [...elements.messageList.children]
      .find((candidate) => candidate.dataset.messageId === String(message.id));
    const row = buildMessageRow(message, existingRow || null);
    if (!existingRow) insertRowInOrder(row, message, history);
    for (const removedId of removedIds) {
      const removedRow = [...elements.messageList.children]
        .find((candidate) => candidate.dataset.messageId === String(removedId));
      removedRow?.remove();
    }
    elements.emptyState.hidden = true;
    if (follow) {
      elements.viewport.scrollTop = elements.viewport.scrollHeight;
      if (isNewIncoming) void markCurrentRead();
    } else {
      restoreAnchor(anchor);
      elements.jumpLatest.hidden = false;
    }
  }

  function applyMessageDelete(topicId, messageIds) {
    const history = state.histories.get(topicId);
    if (!history || !Array.isArray(messageIds)) return;
    const anchor = state.activeTopicId === topicId ? captureAnchor() : null;
    for (const id of messageIds) {
      if (!Number.isSafeInteger(id)) continue;
      history.messages.delete(id);
      revokeMessageMedia(id);
      if (state.activeTopicId === topicId) {
        const row = [...elements.messageList.children]
          .find((candidate) => candidate.dataset.messageId === String(id));
        row?.remove();
      }
    }
    if (state.activeTopicId === topicId) {
      elements.emptyState.hidden = history.messages.size > 0;
      restoreAnchor(anchor);
    }
  }

  function renderTopics(focusTopicId = null) {
    const fragment = document.createDocumentFragment();
    for (const topic of state.topics.values()) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "topic-button";
      button.dataset.topicId = String(topic.id);
      if (topic.id === state.activeTopicId) button.setAttribute("aria-current", "page");
      const name = document.createElement("span");
      name.className = "topic-name";
      name.textContent = topic.id === GENERAL_TOPIC_ID ? "ChatKJB" : topic.title;
      if (topic.id === GENERAL_TOPIC_ID) {
        button.append(name);
      } else {
        const prefix = document.createElement("span");
        prefix.className = "topic-prefix";
        prefix.setAttribute("aria-hidden", "true");
        prefix.textContent = "/";
        button.append(prefix, name);
      }
      if (topic.unreadCount > 0) {
        const count = document.createElement("span");
        count.className = "topic-count";
        count.textContent = topic.unreadCount > 99 ? "99+" : String(topic.unreadCount);
        count.setAttribute("aria-label", `읽지 않은 메시지 ${topic.unreadCount}개`);
        button.append(count);
      }
      button.addEventListener("click", () => void selectTopic(topic.id));
      item.append(button);
      fragment.append(item);
    }
    elements.topicList.replaceChildren(fragment);
    if (focusTopicId !== null) {
      window.setTimeout(() => {
        const focused = [...elements.topicList.querySelectorAll("button")]
          .find((button) => button.dataset.topicId === String(focusTopicId));
        focused?.focus();
      }, 0);
    }
  }

  function updateActiveTopicState() {
    for (const button of elements.topicList.querySelectorAll("button")) {
      if (button.dataset.topicId === String(state.activeTopicId)) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  }

  async function loadAllTopics(signal) {
    elements.topicLoading.hidden = false;
    elements.topicList.setAttribute("aria-busy", "true");
    try {
      for (let attempt = 0; attempt <= TOPIC_INVALIDATION_RETRIES; attempt += 1) {
        const topics = new Map();
        let cursor = null;
        let pages = 0;
        try {
          do {
            const query = new URLSearchParams({ limit: "100" });
            if (cursor) query.set("cursor", cursor);
            const page = await requestJson(`/api/topics?${query}`, { signal });
            if (Array.isArray(page.topics)) {
              for (const topic of page.topics) {
                if (topic && Number.isSafeInteger(topic.id) && typeof topic.title === "string") topics.set(topic.id, topic);
              }
            }
            cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
            pages += 1;
          } while (cursor && pages < 100);
          if (cursor) throw apiError("TOPIC_PAGE_LIMIT");
          const previousTopics = state.topics;
          state.topics = topics;
          for (const topic of topics.values()) {
            const read = readStateFor(topic.id);
            read.latestKnownMessageId = Math.max(read.latestKnownMessageId, topic.topMessageId);
            if (topic.unreadCount > 0) {
              read.latestUnreadMessageId = Math.max(read.latestUnreadMessageId, topic.topMessageId);
              const previous = previousTopics.get(topic.id);
              if (!previous || previous.unreadCount !== topic.unreadCount || previous.topMessageId !== topic.topMessageId) {
                read.unreadGeneration += 1;
              }
            } else {
              read.latestUnreadMessageId = 0;
              read.highWater = Math.max(read.highWater, topic.topMessageId);
            }
          }
          for (const topicId of [...state.readStates.keys()]) {
            if (!topics.has(topicId)) state.readStates.delete(topicId);
          }
          return;
        } catch (error) {
          if (errorCode(error) !== "HISTORY_INVALIDATED" || attempt === TOPIC_INVALIDATION_RETRIES || signal?.aborted) throw error;
          await new Promise((resolveWait) => window.setTimeout(resolveWait, 40 * (attempt + 1)));
        }
      }
    } finally {
      elements.topicLoading.hidden = true;
      elements.topicList.removeAttribute("aria-busy");
    }
  }

  async function loadMessagePage(topicId, cursor, replace, signal, preserveMedia = false) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const page = await requestJson(`/api/topics/${topicId}/messages?${query}`, { signal });
    const history = historyFor(topicId);
    if (replace) {
      if (!preserveMedia) for (const id of history.messages.keys()) revokeMessageMedia(id);
      history.messages.clear();
      history.pages = 1;
    } else {
      history.pages = Math.min(MAX_HISTORY_PAGES, history.pages + 1);
    }
    if (Array.isArray(page.messages)) {
      for (const message of page.messages) {
        if (message && message.topicId === topicId && Number.isSafeInteger(message.id)) {
          applyMessageReplyPanel(message);
          history.messages.set(message.id, message);
        }
      }
    }
    history.nextCursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
    trimHistoryMessages(history);
    if (history.pages >= MAX_HISTORY_PAGES || history.messages.size >= MAX_MESSAGES_PER_HISTORY) {
      history.nextCursor = null;
    }
    history.checkpoint = typeof page.checkpointEventId === "string" ? page.checkpointEventId : "";
    history.loaded = true;
    return history;
  }

  async function selectTopic(topicId, force = false) {
    if (!state.topics.has(topicId)) return;
    if (state.activeTopicId !== null) historyFor(state.activeTopicId).scrollTop = elements.viewport.scrollTop;
    state.activeTopicId = topicId;
    state.selectionGeneration += 1;
    const generation = state.selectionGeneration;
    state.historyAbort?.abort();
    state.olderAbort?.abort();
    const controller = new AbortController();
    state.historyAbort = controller;
    const topic = state.topics.get(topicId);
    elements.topicTitle.textContent = topic.title;
    updateActiveTopicState();
    updateGeneralPanelState();
    if (window.innerWidth <= 720) {
      elements.shell.dataset.sidebarOpen = "false";
      elements.sidebarToggle.setAttribute("aria-expanded", "false");
    }
    const history = historyFor(topicId);
    if (history.loaded && !force) {
      renderCurrentHistory(false);
      setConnection(state.connection);
      void markCurrentRead();
      return;
    }
    elements.emptyState.hidden = false;
    elements.emptyState.querySelector("p").textContent = "기록을 불러오는 중입니다…";
    try {
      await loadMessagePage(topicId, null, true, controller.signal);
      if (generation !== state.selectionGeneration || controller.signal.aborted) return;
      renderCurrentHistory(true);
      void markCurrentRead();
    } catch (error) {
      if (!controller.signal.aborted) showAlert(`기록을 불러오지 못했습니다 · ${errorCode(error)}`);
    } finally {
      elements.emptyState.querySelector("p").textContent = "이 토픽에는 표시할 메시지가 없습니다.";
      setConnection(state.connection);
    }
  }

  async function loadOlder() {
    if (state.activeTopicId === null) return;
    const topicId = state.activeTopicId;
    const generation = state.selectionGeneration;
    const history = historyFor(topicId);
    if (!history.nextCursor || state.busy) return;
    const previousIds = new Set(history.messages.keys());
    const oldHeight = elements.viewport.scrollHeight;
    const controller = new AbortController();
    state.olderAbort?.abort();
    state.olderAbort = controller;
    state.busy = true;
    elements.loadOlder.disabled = true;
    try {
      await loadMessagePage(topicId, history.nextCursor, false, controller.signal);
      if (controller.signal.aborted || generation !== state.selectionGeneration || state.activeTopicId !== topicId) return;
      const fragment = document.createDocumentFragment();
      const renderedIds = new Set([...elements.messageList.children].map((candidate) => candidate.dataset.messageId));
      for (const message of sortedMessages(history)) {
        if (!previousIds.has(message.id) && !renderedIds.has(String(message.id))) fragment.append(buildMessageRow(message));
      }
      elements.messageList.prepend(fragment);
      elements.emptyState.hidden = history.messages.size > 0;
      elements.loadOlder.hidden = !history.nextCursor;
      elements.viewport.scrollTop += elements.viewport.scrollHeight - oldHeight;
    } catch (error) {
      if (!controller.signal.aborted) showAlert(`이전 기록을 불러오지 못했습니다 · ${errorCode(error)}`);
    } finally {
      if (state.olderAbort === controller) state.olderAbort = null;
      state.busy = false;
      elements.loadOlder.disabled = false;
      setConnection(state.connection);
    }
  }

  // 스크롤 이벤트는 초당 수십 번 발생한다. 읽음 표시를 그대로 따라 보내면 서버의
  // 자동 요청 예산을 순식간에 소진하므로, 짧은 간격으로 합쳐서 한 번만 보낸다.
  function scheduleMarkCurrentRead() {
    if (state.markReadTimer !== undefined) return;
    state.markReadTimer = window.setTimeout(() => {
      state.markReadTimer = undefined;
      void markCurrentRead();
    }, 400);
  }

  async function markCurrentRead() {
    if (state.activeTopicId === null || !isNearBottom()) return;
    const topicId = state.activeTopicId;
    const messages = sortedMessages(historyFor(topicId));
    const max = messages.at(-1)?.id;
    if (!max) return;
    const read = readStateFor(topicId);
    read.latestKnownMessageId = Math.max(read.latestKnownMessageId, max);
    const topic = state.topics.get(topicId);
    if (read.inFlightTarget >= max) return;
    if (read.highWater >= max && (!topic || topic.unreadCount <= 0)) return;
    read.inFlightTarget = max;
    let followUp = false;
    try {
      await postJson(`/api/topics/${topicId}/read`, { maxMessageId: max });
      read.highWater = Math.max(read.highWater, max);
      // 이전에는 unreadGeneration이 그대로일 때만 배지를 지웠다. 봇이 진행 상황을
      // 연속으로 보내면 확인 요청이 오가는 사이에 세대가 매번 바뀌어, 다 읽은 뒤에도
      // 배지가 사라지지 않았다. 세대 조건을 없애고, 단조 증가하는 메시지 id만으로
      // 판정한다. 확인 지점보다 새 메시지가 남아 있으면 배지는 그대로 두고 후속
      // 확인을 예약한다(낡은 확인이 새 메시지를 지우지 않도록).
      if (read.latestUnreadMessageId <= max) {
        read.latestUnreadMessageId = 0;
        const currentTopic = state.topics.get(topicId);
        if (currentTopic) {
          currentTopic.unreadCount = 0;
          updateTopicBadge(topicId);
        }
      } else if (state.activeTopicId === topicId && isNearBottom()) {
        followUp = true;
      }
    } catch {
      // Read markers are best effort and are never retried automatically.
    } finally {
      if (read.inFlightTarget === max) read.inFlightTarget = 0;
      if (followUp) void markCurrentRead();
    }
  }

  async function reconcile() {
    if (state.reconciling) {
      state.reconcileAgain = true;
      return;
    }
    state.reconciling = true;
    try {
      do {
        state.reconcileAgain = false;
        state.historyAbort?.abort();
        state.olderAbort?.abort();
        const controller = new AbortController();
        state.historyAbort = controller;
        state.selectionGeneration += 1;
        const reconciliationGeneration = state.selectionGeneration;
        const preservedTopicId = state.activeTopicId;
        const preservedFollow = preservedTopicId === null || isNearBottom();
        const preservedAnchor = preservedFollow ? null : captureAnchor();
        const focusedTopicId = Number(document.activeElement?.dataset.topicId);
        const preservedPages = preservedTopicId === null
          ? 1
          : Math.max(1, Math.min(MAX_HISTORY_PAGES, historyFor(preservedTopicId).pages || 1));
        const previousMessages = preservedTopicId === null
          ? new Map()
          : new Map(historyFor(preservedTopicId).messages);
        if (preservedTopicId !== null) historyFor(preservedTopicId).scrollTop = elements.viewport.scrollTop;
        for (const [topicId, cached] of [...state.histories]) {
          if (topicId === preservedTopicId) continue;
          state.histories.delete(topicId);
          for (const messageId of cached.messages.keys()) revokeMessageMedia(messageId);
        }
        await loadAllTopics(controller.signal);
        if (controller.signal.aborted || reconciliationGeneration !== state.selectionGeneration) {
          state.reconcileAgain = true;
          continue;
        }
        if (state.activeTopicId === null || !state.topics.has(state.activeTopicId)) {
          const first = state.topics.keys().next().value;
          if (Number.isSafeInteger(first)) state.activeTopicId = first;
        }
        updateGeneralPanelState();
        renderTopics(Number.isSafeInteger(focusedTopicId) && state.topics.has(focusedTopicId) ? focusedTopicId : null);
        if (state.activeTopicId !== null) {
          const sameTopic = state.activeTopicId === preservedTopicId;
          let history = await loadMessagePage(state.activeTopicId, null, true, controller.signal, sameTopic);
          const pagesToLoad = state.activeTopicId === preservedTopicId ? preservedPages : 1;
          for (let page = 1; page < pagesToLoad && history.nextCursor; page += 1) {
            history = await loadMessagePage(state.activeTopicId, history.nextCursor, false, controller.signal);
          }
          if (controller.signal.aborted || reconciliationGeneration !== state.selectionGeneration) {
            state.reconcileAgain = true;
            continue;
          }
          elements.topicTitle.textContent = state.topics.get(state.activeTopicId)?.title || "ChatKJB";
          if (sameTopic) renderReconciledHistory(previousMessages);
          else renderCurrentHistory(false);
          if (!sameTopic || preservedFollow) elements.viewport.scrollTop = elements.viewport.scrollHeight;
          else restoreAnchor(preservedAnchor);
          if (!sameTopic || preservedFollow) void markCurrentRead();
        }
      } while (state.reconcileAgain);
      const queued = state.queuedEvents.splice(0);
      for (const event of queued) applyEvent(event.data, false);
      state.reconcileInvalidations = 0;
      window.clearTimeout(state.reconcileRetryTimer);
      state.reconcileRetryTimer = 0;
      state.lastReconcileError = "";
    } catch (error) {
      if (error?.name === "AbortError") state.reconcileAgain = true;
      else if (errorCode(error) === "HISTORY_INVALIDATED") {
        state.reconcileAgain = false;
        if (state.reconcileInvalidations < TOPIC_INVALIDATION_RETRIES) {
          state.reconcileInvalidations += 1;
          window.clearTimeout(state.reconcileRetryTimer);
          state.reconcileRetryTimer = window.setTimeout(
            () => void reconcile(),
            40 * state.reconcileInvalidations
          );
        }
      } else {
        const message = `화면을 다시 맞추지 못했습니다 · ${errorCode(error)}`;
        if (state.lastReconcileError !== message) showAlert(message);
        state.lastReconcileError = message;
      }
    } finally {
      const retry = state.reconcileAgain;
      state.reconciling = false;
      state.reconcileAgain = false;
      if (retry) void reconcile();
    }
  }

  function applyEvent(data, allowQueue = true, id = "") {
    if (!data || typeof data !== "object" || typeof data.type !== "string") return;
    if (state.reconciling && allowQueue && data.type !== "reconcile_required") {
      state.queuedEvents.push({ id, data });
      if (state.queuedEvents.length > 512) {
        state.queuedEvents.length = 0;
        state.reconcileAgain = true;
      }
      return;
    }
    if (data.type === "auth_state" && data.auth && typeof data.auth.state === "string") {
      setConnection(data.auth.state, data.auth.errorCode || "");
      if (data.auth.state === "ready" && state.topics.size === 0) void reconcile();
    } else if (data.type === "message_upsert") {
      applyMessageUpsert(data.message);
    } else if (data.type === "message_delete") {
      applyMessageDelete(data.topicId, data.messageIds);
    } else if (data.type === "topic_delete") {
      state.topics.delete(data.topicId);
      state.histories.delete(data.topicId);
      renderTopics();
      if (state.activeTopicId === data.topicId) {
        state.activeTopicId = null;
        updateGeneralPanelState();
        void reconcile();
      }
    } else if (data.type === "reconcile_required") {
      void reconcile();
    }
  }

  function parseSseFrame(raw) {
    if (!raw || raw.startsWith(":")) return null;
    const lines = raw.split("\n");
    const id = lines.find((line) => line.startsWith("id: "))?.slice(4) || "";
    const dataText = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
    if (!dataText || dataText.length > 64 * 1024) return null;
    try {
      return { id, data: JSON.parse(dataText) };
    } catch {
      return null;
    }
  }

  async function consumeEventStream() {
    let retry = 300;
    for (;;) {
      if (!state.csrf) return;
      const controller = new AbortController();
      try {
        const headers = { "X-ChatKJB-CSRF": state.csrf };
        if (state.lastEventId) headers["Last-Event-ID"] = state.lastEventId;
        const response = await request("/api/events", { headers, signal: controller.signal });
        if (!response.body) throw apiError("SSE_BODY_MISSING");
        retry = 300;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
          if (buffer.length > 1024 * 1024) throw apiError("SSE_BUFFER_LIMIT");
          let separator;
          while ((separator = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const frame = parseSseFrame(raw);
            if (!frame) continue;
            const eventId = parseEventId(frame.id);
            if (!eventId || eventId.epoch !== state.epoch || eventId.sequence < state.lastSequence) {
              state.lastEventId = "";
              state.lastSequence = -1;
              void reconcile();
              continue;
            }
            state.lastEventId = frame.id;
            state.lastSequence = eventId.sequence;
            applyEvent(frame.data, true, frame.id);
          }
        }
      } catch {
        if (["ready", "reconnecting"].includes(state.connection)) setConnection("reconnecting");
      }
      await new Promise((resolve) => window.setTimeout(resolve, retry));
      retry = Math.min(5000, retry * 2);
    }
  }

  function utf8Base64Url(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }

  function setSelectedFile(file) {
    if (!file) {
      state.selectedFile = null;
      elements.fileInput.value = "";
      elements.selectedFile.hidden = true;
      elements.selectedFileLabel.textContent = "";
      return;
    }
    if (!isAllowedUploadFile(file, state.limits.uploadBytes)) {
      showAlert(`허용된 형식의 ${formatBytes(state.limits.uploadBytes)} 이하 파일 한 개만 전송할 수 있습니다.`);
      setSelectedFile(null);
      return;
    }
    state.selectedFile = file;
    elements.selectedFileLabel.textContent = `첨부: ${file.name} · ${formatBytes(file.size)} · 전송 전까지 메모리에만 유지`;
    elements.selectedFile.hidden = false;
  }

  async function setTyping(active) {
    if (state.activeTopicId === null || state.connection !== "ready" || state.typingActive === active) return;
    state.typingActive = active;
    try {
      await postJson(`/api/topics/${state.activeTopicId}/typing`, { active });
    } catch {
      state.typingActive = false;
    }
  }

  function scheduleTyping() {
    void setTyping(true);
    window.clearTimeout(state.typingTimer);
    state.typingTimer = window.setTimeout(() => void setTyping(false), 4000);
  }

  async function submitComposer() {
    if (state.busy || state.connection !== "ready" || state.activeTopicId === null) return;
    const text = elements.messageInput.value;
    const file = state.selectedFile;
    if (!file && !text.trim()) return;
    if (file && text.length > 1024) {
      showAlert("파일 설명은 1,024자 이하여야 합니다. 입력 내용과 파일은 그대로 유지됩니다.");
      return;
    }
    state.busy = true;
    elements.composer.setAttribute("aria-busy", "true");
    setConnection(state.connection);
    try {
      if (file) {
        const mimeType = file.type || "application/octet-stream";
        const headers = {
          "Content-Type": mimeType,
          "X-ChatKJB-File-Name": utf8Base64Url(file.name)
        };
        if (text && text.length <= 1024) headers["X-ChatKJB-Caption"] = utf8Base64Url(text);
        await request(`/api/topics/${state.activeTopicId}/files`, {
          method: "POST",
          headers,
          body: await file.arrayBuffer()
        });
        setSelectedFile(null);
      } else {
        await postJson(`/api/topics/${state.activeTopicId}/messages`, { text });
      }
      elements.messageInput.value = "";
      elements.messageInput.style.height = "auto";
      await setTyping(false);
    } catch (error) {
      showAlert(`전송하지 못했습니다. 자동 재전송하지 않습니다 · ${errorCode(error)}`);
    } finally {
      state.busy = false;
      elements.composer.removeAttribute("aria-busy");
      setConnection(state.connection);
      elements.messageInput.focus();
    }
  }

  async function submitGeneralPanelCommand(text) {
    if (
      typeof text !== "string"
      || !text
      || state.busy
      || state.connection !== "ready"
      || state.activeTopicId !== GENERAL_TOPIC_ID
    ) return;
    const generation = state.selectionGeneration;
    state.busy = true;
    elements.generalPanel.setAttribute("aria-busy", "true");
    setConnection(state.connection);
    try {
      await Promise.resolve();
      if (
        generation !== state.selectionGeneration
        || state.activeTopicId !== GENERAL_TOPIC_ID
        || state.connection !== "ready"
      ) return;
      await postJson(`/api/topics/${GENERAL_TOPIC_ID}/messages`, { text });
    } catch (error) {
      showAlert(`패널 동작을 전송하지 못했습니다. 자동 재전송하지 않습니다 · ${errorCode(error)}`);
    } finally {
      state.busy = false;
      elements.generalPanel.removeAttribute("aria-busy");
      setConnection(state.connection);
      elements.messageInput.focus();
    }
  }

  Object.defineProperty(window, "chatkjbNativeLogout", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: async () => {
      if (state.nativeLogout) return false;
      state.nativeLogout = true;
      try {
        await request("/api/logout", { method: "POST" });
        state.csrf = "";
        state.queuedEvents.length = 0;
        clearRenderedMedia();
        setConnection("signed_out");
        return true;
      } catch {
        return false;
      } finally {
        state.nativeLogout = false;
      }
    }
  });

  renderGeneralPanel();
  elements.sidebarToggle.addEventListener("click", () => {
    const open = elements.shell.dataset.sidebarOpen !== "true";
    elements.shell.dataset.sidebarOpen = String(open);
    elements.sidebarToggle.setAttribute("aria-expanded", String(open));
    elements.sidebarToggle.setAttribute("aria-label", open ? "토픽 목록 닫기" : "토픽 목록 열기");
  });
  elements.loadOlder.addEventListener("click", () => void loadOlder());
  elements.jumpLatest.addEventListener("click", () => {
    elements.viewport.scrollTop = elements.viewport.scrollHeight;
    elements.jumpLatest.hidden = true;
    void markCurrentRead();
  });
  elements.viewport.addEventListener("scroll", () => {
    if (state.activeTopicId !== null) historyFor(state.activeTopicId).scrollTop = elements.viewport.scrollTop;
    elements.jumpLatest.hidden = isNearBottom();
    if (isNearBottom()) scheduleMarkCurrentRead();
  }, { passive: true });
  elements.generalPanel.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-command]");
    if (!button || !elements.generalPanel.contains(button)) return;
    void submitGeneralPanelCommand(button.dataset.command || "");
  });
  elements.attachButton.addEventListener("click", () => elements.fileInput.click());
  elements.fileInput.addEventListener("change", () => {
    setSelectedFile(elements.fileInput.files?.[0] || null);
    elements.messageInput.focus();
  });
  elements.selectedFileRemove.addEventListener("click", () => {
    setSelectedFile(null);
    elements.messageInput.focus();
  });
  for (const eventName of ["dragenter", "dragover", "dragleave", "drop"]) {
    window.addEventListener(eventName, (event) => event.preventDefault());
  }
  elements.composer.addEventListener("drop", (event) => {
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length > 1) {
      showAlert("파일은 한 번에 하나만 첨부할 수 있습니다. 기존 선택은 유지됩니다.");
      return;
    }
    if (files[0]) {
      setSelectedFile(files[0]);
      elements.messageInput.focus();
    }
  });
  elements.messageInput.addEventListener("compositionstart", () => { state.composing = true; });
  elements.messageInput.addEventListener("compositionend", () => { state.composing = false; });
  elements.messageInput.addEventListener("keydown", (event) => {
    if (!shouldSubmitComposerKey(event, state.composing)) return;
    event.preventDefault();
    void submitComposer();
  });
  elements.messageInput.addEventListener("input", () => {
    elements.messageInput.style.height = "auto";
    elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 160)}px`;
    if (elements.messageInput.value) scheduleTyping();
  });
  elements.messageInput.addEventListener("blur", () => void setTyping(false));
  elements.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitComposer();
  });
  elements.qrLogin.addEventListener("click", () => void beginQrLogin());
  elements.passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = elements.passwordInput.value;
    elements.passwordInput.value = "";
    try {
      await postJson("/api/auth/password", { password });
    } catch (error) {
      showAlert(`2단계 인증에 실패했습니다 · ${errorCode(error)}`);
    }
  });
  elements.passwordCancel.addEventListener("click", async () => {
    elements.passwordInput.value = "";
    try {
      await request("/api/auth/cancel", { method: "POST" });
      setConnection("signed_out");
    } catch (error) {
      showAlert(`로그인을 취소하지 못했습니다 · ${errorCode(error)}`);
    }
  });
  window.addEventListener("pagehide", () => {
    state.historyAbort?.abort();
    window.clearTimeout(state.reconcileRetryTimer);
    clearRenderedMedia();
    if (state.typingActive) void setTyping(false);
    elements.passwordInput.value = "";
  });

  void (async () => {
    try {
      const session = await requestJson("/api/session", {}, false);
      if (typeof session.csrfToken !== "string" || typeof session.eventEpoch !== "string") throw apiError("SESSION_INVALID");
      state.csrf = session.csrfToken;
      state.epoch = session.eventEpoch;
      state.limits = { ...state.limits, ...(session.limits || {}) };
      setConnection(session.connection || "connecting");
      if (session.connection === "ready") await reconcile();
      void consumeEventStream();
    } catch (error) {
      setConnection("error", errorCode(error));
      showAlert("로컬 GUI 세션을 시작하지 못했습니다. 앱을 다시 열어 주십시오.");
    }
  })();
}

if (typeof document !== "undefined") startApplication();
