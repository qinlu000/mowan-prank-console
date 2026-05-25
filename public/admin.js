const sessionListEl = document.querySelector("#sessionList");
const sessionCountEl = document.querySelector("#sessionCount");
const adminMessagesEl = document.querySelector("#adminMessages");
const activeTitleEl = document.querySelector("#activeTitle");
const activeMetaEl = document.querySelector("#activeMeta");
const operatorNameEl = document.querySelector("#operatorName");
const refreshButton = document.querySelector("#refreshButton");
const revealButton = document.querySelector("#revealButton");
const llmModeButton = document.querySelector("#llmModeButton");
const manualModeButton = document.querySelector("#manualModeButton");
const takeoverButton = document.querySelector("#takeoverButton");
const referencePanel = document.querySelector("#referencePanel");
const referenceMetaEl = document.querySelector("#referenceMeta");
const referenceContentEl = document.querySelector("#referenceContent");
const useReferenceButton = document.querySelector("#useReferenceButton");
const refreshReferenceButton = document.querySelector("#refreshReferenceButton");
const replyForm = document.querySelector("#replyForm");
const replyInput = document.querySelector("#replyInput");
const replyButton = document.querySelector("#replyButton");
const delayToggle = document.querySelector("#delayToggle");
const delaySelect = document.querySelector("#delaySelect");
const quickReplyButtons = [...document.querySelectorAll("[data-reply]")];

let sessions = [];
let activeSessionId = null;
let activeSignature = "";
let typingTimer = null;
let currentAdmin = null;
let adminEvents = null;
let isRefreshing = false;
let activeAdminDraft = null;

function redirectToLogin() {
  window.location.href = "/admin-login.html";
}

async function readPayload(response) {
  const payload = await response.json();
  if (response.status === 401) {
    redirectToLogin();
    throw new Error("需要后台登录");
  }
  return payload;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function relativeTime(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds} 秒前`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} 分钟前`;
  }
  return `${Math.floor(seconds / 3600)} 小时前`;
}

function previewText(session) {
  if (session.regenerateRequested) {
    return "访客请求重新生成上一条回复";
  }

  if (session.canTakeOver) {
    return "LLM 模式：可接管当前问题";
  }

  if (session.isGenerating) {
    return "正在流式输出回复";
  }

  if (session.adminTyping) {
    return "访客正在等待回复";
  }

  if (session.replyMode === "manual") {
    return "人工模式：下一条消息等待后台回复";
  }

  if (!session.lastMessage) {
    return "暂无消息";
  }

  const prefix = session.lastMessage.role === "user" ? "访客：" : "魔丸：";
  return `${prefix}${session.lastMessage.content}`;
}

function renderSessionList() {
  sessionCountEl.textContent = `${sessions.length} 个访客`;

  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "还没有会话。打开访客页并发送第一条消息后，这里会自动出现。";
    sessionListEl.replaceChildren(empty);
    return;
  }

  const items = sessions.map((session) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-item${session.id === activeSessionId ? " active" : ""}`;
    button.dataset.waiting = session.adminTyping || session.regenerateRequested ? "true" : "false";
    button.addEventListener("click", () => selectSession(session.id));

    const title = document.createElement("div");
    title.className = "session-item-title";
    title.textContent = session.title || "新访客";

    const preview = document.createElement("div");
    preview.className = "session-item-preview";
    preview.textContent = previewText(session);

    const meta = document.createElement("div");
    meta.className = "session-item-meta";

    const count = document.createElement("span");
    count.textContent = `${session.userMessageCount} 条访客消息`;

    const time = document.createElement("span");
    time.textContent = relativeTime(session.updatedAt);

    meta.append(count, time);
    button.append(title, preview, meta);
    return button;
  });

  sessionListEl.replaceChildren(...items);
}

function createMessageRow(message, session) {
  const row = document.createElement("article");
  row.className = `message-row ${message.role}`;
  row.dataset.status = message.status || "complete";

  const bubble = document.createElement("div");
  bubble.className = `bubble ${message.status || "complete"}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = `${message.role === "user" ? session.visitorLabel || "访客" : "魔丸"} · ${formatTime(message.createdAt)}`;

  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent = message.content;

  bubble.append(meta, content);
  if (message.role === "assistant" && message.audioUrl) {
    const audio = document.createElement("audio");
    audio.className = "message-audio";
    audio.controls = true;
    audio.preload = "none";
    audio.src = message.audioUrl;
    bubble.append(audio);
  } else if (message.role === "assistant" && message.audioStatus === "generating") {
    const audioStatus = document.createElement("div");
    audioStatus.className = "message-audio-status";
    audioStatus.textContent = "正在生成语音";
    bubble.append(audioStatus);
  } else if (message.role === "assistant" && message.audioStatus === "error") {
    const audioStatus = document.createElement("div");
    audioStatus.className = "message-audio-status";
    audioStatus.textContent = "语音生成失败";
    bubble.append(audioStatus);
  }
  row.append(bubble);
  return row;
}

function createTypingRow() {
  const row = document.createElement("article");
  row.className = "message-row assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble typing";

  const label = document.createElement("span");
  label.className = "typing-label";
  label.textContent = "访客端正在显示思考中";

  const dots = document.createElement("span");
  dots.className = "typing-dots";
  dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));

  bubble.append(label, dots);
  row.append(bubble);
  return row;
}

function createSystemNotice(text) {
  const row = document.createElement("article");
  row.className = "message-row system";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  row.append(bubble);
  return row;
}

const referenceViews = {
  idle: ["等待生成参考", "点刷新，魔丸先给你一版底稿。"],
  generating: ["魔丸正在憋参考稿", "正在生成，等它把这团火捏成一句能发的话。"],
  error: ["参考稿没出来", "可以刷新再试，或者直接手写。"],
  unavailable: ["参考稿没出来", "可以刷新再试，或者直接手写。"]
};

function renderReferencePanel(session) {
  const draft = session.adminDraft || null;
  activeAdminDraft = draft;

  const shouldShow = Boolean(session.canReply && !session.canTakeOver && (session.replyMode === "manual" || draft));
  referencePanel.hidden = !shouldShow;
  if (!shouldShow) {
    referenceMetaEl.textContent = "等待访客提问";
    referenceContentEl.textContent = "切到人工后，魔丸会先憋一版草稿给你改。";
    useReferenceButton.disabled = true;
    refreshReferenceButton.disabled = true;
    return;
  }

  const status = draft?.status || "idle";
  const canRefresh = session.replyMode === "manual" && session.canReply && status !== "generating";
  refreshReferenceButton.disabled = !canRefresh;
  useReferenceButton.disabled = !(status === "complete" && draft?.content);

  const [meta, content] = referenceViews[status] || referenceViews.idle;
  referenceMetaEl.textContent = status === "complete" ? `已生成 · ${formatTime(draft.updatedAt)}` : meta;
  referenceContentEl.textContent = status === "complete" ? draft.content : draft?.error || content;
}

function setComposerEnabled(enabled, canReply = false, canTakeOver = false) {
  const canUseComposer = Boolean(enabled && canReply && !canTakeOver);
  replyInput.disabled = !canUseComposer;
  replyButton.disabled = !canUseComposer;
  quickReplyButtons.forEach((button) => {
    button.disabled = !canUseComposer;
  });
  revealButton.disabled = !enabled;
  llmModeButton.disabled = !enabled;
  manualModeButton.disabled = !enabled;
  takeoverButton.disabled = !enabled || !canTakeOver;
}

function renderActiveSession(session) {
  activeTitleEl.textContent = session.title || "新访客";
  const replyMode = session.replyMode || "llm";
  llmModeButton.dataset.active = replyMode === "llm" ? "true" : "false";
  manualModeButton.dataset.active = replyMode === "manual" ? "true" : "false";
  llmModeButton.title = "只影响下一条新访客消息";
  manualModeButton.title = "只影响下一条新访客消息；当前问题请点接管当前";
  takeoverButton.title = "停止当前自动回复，改由人工处理这一条";

  if (session.regenerateRequest) {
    activeMetaEl.textContent = `访客请求重新生成 · ${formatTime(session.regenerateRequest.createdAt)}`;
  } else if (session.canTakeOver) {
    activeMetaEl.textContent = "LLM 正在处理当前问题 · 可点接管当前";
  } else if (replyMode === "manual" && session.canReply) {
    activeMetaEl.textContent = "人工模式 · 当前问题等待你回复";
  } else if (session.isGenerating) {
    activeMetaEl.textContent = "回复正在流式输出到访客端";
  } else if (session.adminTyping) {
    activeMetaEl.textContent = "访客端正在显示思考中";
  } else if (replyMode === "manual") {
    activeMetaEl.textContent = "人工模式 · 下一条访客消息将等待后台回复";
  } else {
    activeMetaEl.textContent = `LLM 模式 · ${session.messageCount} 条消息 · 最近更新 ${formatTime(session.updatedAt)}`;
  }

  setComposerEnabled(true, session.canReply, session.canTakeOver);
  renderReferencePanel(session);

  const signature = JSON.stringify({
    ids: session.messages.map(
      (message) => `${message.id}:${message.content}:${message.status}:${message.audioStatus || ""}:${message.audioUrl || ""}`
    ),
    typing: session.adminTyping,
    generating: session.isGenerating,
    replyMode,
    canReply: session.canReply,
    canTakeOver: session.canTakeOver,
    draft: session.adminDraft,
    revealed: session.revealed,
    regenerate: session.regenerateRequest?.id || ""
  });
  if (signature === activeSignature) {
    return;
  }

  const shouldStickToBottom =
    adminMessagesEl.scrollHeight - adminMessagesEl.scrollTop - adminMessagesEl.clientHeight < 180;

  const rows = session.messages.map((message) => createMessageRow(message, session));
  if (session.regenerateRequest) {
    rows.push(createSystemNotice("访客点击了重新生成。你可以基于同一个问题再发一版更像 AI 的回复。"));
  } else if (session.canTakeOver) {
    rows.push(createSystemNotice("这一条正在由 LLM 处理。需要人工介入时，点右上角“接管当前”。"));
  } else if (replyMode === "manual" && session.canReply) {
    rows.push(createSystemNotice("当前问题已由人工处理。可以采用 LLM 参考，也可以直接改写后发送。"));
  } else if (replyMode === "manual" && !session.adminTyping) {
    rows.push(createSystemNotice("当前是人工模式。从下一条访客消息开始，魔丸会等待你手动发出回复。"));
  } else if (session.adminTyping && !session.isGenerating) {
    rows.push(createTypingRow());
  }

  adminMessagesEl.replaceChildren(...rows);

  if (shouldStickToBottom) {
    adminMessagesEl.scrollTop = adminMessagesEl.scrollHeight;
  }

  activeSignature = signature;
}

function renderNoActiveSession() {
  activeTitleEl.textContent = "等待访客";
  activeMetaEl.textContent = "打开访客页后，这里会出现新的会话。";
  llmModeButton.dataset.active = "false";
  manualModeButton.dataset.active = "false";
  setComposerEnabled(false, false, false);
  renderReferencePanel({ canReply: false, replyMode: "manual", adminDraft: null });
  activeSignature = "";

  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = "选择一个会话后，就可以在这里手动扮演魔丸回复。";
  adminMessagesEl.replaceChildren(empty);
}

async function fetchCurrentAdmin() {
  const response = await fetch("/api/admin/me");
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(payload.error || "无法读取管理员信息");
  }

  currentAdmin = payload.admin;
  operatorNameEl.textContent = currentAdmin?.username || "未知";
}

async function fetchSessions() {
  const response = await fetch("/api/admin/sessions");
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(payload.error || "无法读取会话");
  }

  sessions = payload.sessions;
  if (!activeSessionId && sessions.length) {
    activeSessionId = sessions[0].id;
  }
  renderSessionList();
}

async function fetchActiveSession() {
  if (!activeSessionId) {
    renderNoActiveSession();
    return;
  }

  const response = await fetch(`/api/admin/sessions/${encodeURIComponent(activeSessionId)}`);
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(payload.error || "无法读取当前会话");
  }

  renderActiveSession(payload.session);
}

async function refreshAll() {
  if (isRefreshing) {
    return;
  }

  isRefreshing = true;
  try {
    if (!currentAdmin) {
      await fetchCurrentAdmin();
    }
    await fetchSessions();
    await fetchActiveSession();
  } catch (error) {
    activeMetaEl.textContent = error.message;
  } finally {
    isRefreshing = false;
  }
}

function applyAdminEvent(payload) {
  if (Array.isArray(payload.sessions)) {
    sessions = payload.sessions;
    if (payload.deletedSessionId && activeSessionId === payload.deletedSessionId) {
      activeSessionId = sessions[0]?.id || "";
    }
    if (!activeSessionId && sessions.length) {
      activeSessionId = sessions[0].id;
    }
    renderSessionList();
  }

  if (payload.session && payload.session.id === activeSessionId) {
    renderActiveSession(payload.session);
    return;
  }

  if (payload.changedSessionId && payload.changedSessionId === activeSessionId) {
    fetchActiveSession();
  } else if (activeSessionId && !payload.session) {
    fetchActiveSession();
  } else if (!activeSessionId) {
    renderNoActiveSession();
  }
}

function connectAdminEvents() {
  if (!window.EventSource) {
    return;
  }

  if (adminEvents) {
    adminEvents.close();
  }

  adminEvents = new EventSource("/api/admin/events");
  adminEvents.addEventListener("admin", (event) => {
    applyAdminEvent(JSON.parse(event.data));
  });
  adminEvents.addEventListener("error", () => {
    if (!isRefreshing) {
      activeMetaEl.textContent = "事件流正在重连，已切到低频刷新兜底。";
    }
  });
}

function fallbackRefresh() {
  if (!window.EventSource || !adminEvents || adminEvents.readyState !== EventSource.OPEN) {
    refreshAll();
  }
}

function selectSession(sessionId) {
  activeSessionId = sessionId;
  activeSignature = "";
  renderSessionList();
  fetchActiveSession();
}

async function setTyping(typing) {
  if (!activeSessionId) {
    return;
  }

  const response = await fetch(`/api/admin/sessions/${encodeURIComponent(activeSessionId)}/typing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ typing })
  });
  await readPayload(response);
}

function announceTyping() {
  if (!activeSessionId) {
    return;
  }

  setTyping(true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => setTyping(false), 1800);
}

async function sendReply(content) {
  const delayMs = delayToggle.checked ? Number(delaySelect.value) : 0;
  const response = await fetch(`/api/admin/sessions/${encodeURIComponent(activeSessionId)}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, delayMs })
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(payload.error || "回复失败");
  }
}

async function setReplyMode(mode) {
  if (!activeSessionId) {
    return;
  }

  const response = await fetch(`/api/admin/sessions/${encodeURIComponent(activeSessionId)}/reply-mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode })
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(payload.error || "切换回复模式失败");
  }
}

async function takeOverCurrent() {
  if (!activeSessionId) {
    return;
  }

  const response = await fetch(`/api/admin/sessions/${encodeURIComponent(activeSessionId)}/takeover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(payload.error || "接管失败");
  }
}

async function requestReference() {
  if (!activeSessionId) {
    return;
  }

  const response = await fetch(`/api/admin/sessions/${encodeURIComponent(activeSessionId)}/reference`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(payload.error || "参考稿生成失败");
  }
}

replyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = replyInput.value.trim();
  if (!content || !activeSessionId) {
    return;
  }

  replyButton.disabled = true;
  try {
    await sendReply(content);
    replyInput.value = "";
    await refreshAll();
    replyInput.focus();
  } catch (error) {
    activeMetaEl.textContent = error.message;
  } finally {
    replyButton.disabled = replyInput.disabled;
  }
});

replyInput.addEventListener("input", announceTyping);
replyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    replyForm.requestSubmit();
  }
});

quickReplyButtons.forEach((button) => {
  button.addEventListener("click", () => {
    replyInput.value = `${button.dataset.reply}${replyInput.value ? `\n${replyInput.value}` : ""}`;
    replyInput.focus();
    announceTyping();
  });
});

async function changeReplyMode(mode) {
  if (!activeSessionId) {
    return;
  }

  if (
    (mode === "llm" && llmModeButton.dataset.active === "true") ||
    (mode === "manual" && manualModeButton.dataset.active === "true")
  ) {
    return;
  }

  llmModeButton.disabled = true;
  manualModeButton.disabled = true;
  try {
    await setReplyMode(mode);
    await refreshAll();
  } catch (error) {
    activeMetaEl.textContent = error.message;
  } finally {
    llmModeButton.disabled = false;
    manualModeButton.disabled = false;
  }
}

llmModeButton.addEventListener("click", () => changeReplyMode("llm"));
manualModeButton.addEventListener("click", () => changeReplyMode("manual"));

takeoverButton.addEventListener("click", async () => {
  takeoverButton.disabled = true;
  try {
    await takeOverCurrent();
    await refreshAll();
  } catch (error) {
    activeMetaEl.textContent = error.message;
  }
});

useReferenceButton.addEventListener("click", () => {
  if (!activeAdminDraft?.content || replyInput.disabled) {
    return;
  }

  replyInput.value = activeAdminDraft.content;
  replyInput.focus();
  announceTyping();
});

refreshReferenceButton.addEventListener("click", async () => {
  refreshReferenceButton.disabled = true;
  try {
    await requestReference();
    await refreshAll();
  } catch (error) {
    activeMetaEl.textContent = error.message;
  } finally {
    refreshReferenceButton.disabled = false;
  }
});

revealButton.addEventListener("click", async () => {
  if (!activeSessionId) {
    return;
  }

  revealButton.disabled = true;
  try {
    const response = await fetch(`/api/admin/sessions/${encodeURIComponent(activeSessionId)}/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    await readPayload(response);
    await refreshAll();
  } finally {
    revealButton.disabled = false;
  }
});

refreshButton.addEventListener("click", refreshAll);

renderNoActiveSession();
refreshAll();
connectAdminEvents();
setInterval(fallbackRefresh, 5000);
