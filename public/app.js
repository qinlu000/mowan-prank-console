const legacyStorageKeys = ["astra" + "chat-prank-session-id"];
const sessionStorageKey = "mowan-prank-session-id";
const visitorStorageKey = "mowan-prank-visitor-id";
const messagesEl = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const input = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const statusEl = document.querySelector("#connectionStatus");
const newChatButton = document.querySelector("#newChatButton");
const newChatLabel = document.querySelector("#newChatLabel");
const conversationNav = document.querySelector("#conversationNav");
const generationActions = document.querySelector("#generationActions");
const stopButton = document.querySelector("#stopButton");
const regenerateButton = document.querySelector("#regenerateButton");
const visitorGate = document.querySelector("#visitorGate");
const visitorForm = document.querySelector("#visitorForm");
const visitorIdInput = document.querySelector("#visitorIdInput");
const visitorError = document.querySelector("#visitorError");
const visitorProfileName = document.querySelector("#visitorProfileName");
const visitorAvatar = document.querySelector("#visitorAvatar");
const suggestionButtons = [...document.querySelectorAll("[data-suggestion]")];

let sessionId = localStorage.getItem(sessionStorageKey) || "";
let visitorId = localStorage.getItem(visitorStorageKey) || "";
let visitorSessions = [];
let maxConversations = 3;
let lastRenderSignature = "";
let isSending = false;
let isIdentifying = false;
let latestSession = null;
let eventSource = null;
const playedAudioUrls = new Set();
const deletingConversationIds = new Set();

for (const key of legacyStorageKeys) {
  localStorage.removeItem(key);
}

function setChatReady(ready) {
  input.disabled = !ready;
  sendButton.disabled = !ready;
  newChatButton.disabled = !ready || visitorSessions.length >= maxConversations;
  stopButton.disabled = !ready;
  regenerateButton.disabled = !ready;
  for (const button of suggestionButtons) {
    button.disabled = !ready;
  }
}

function conversationPreview(session) {
  if (!session?.lastMessage) {
    return "新的对话";
  }

  const prefix = session.lastMessage.role === "user" ? "你：" : "魔丸：";
  return `${prefix}${session.lastMessage.content}`;
}

function relativeTime(value) {
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) {
    return "刚刚";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  return `${Math.floor(hours / 24)} 天前`;
}

function renderConversationNav() {
  const canCreate = Boolean(visitorId) && visitorSessions.length < maxConversations;
  newChatButton.disabled = !canCreate;
  newChatLabel.textContent = canCreate
    ? `新对话 (${visitorSessions.length}/${maxConversations})`
    : `已达 ${maxConversations} 个对话`;

  if (!visitorId) {
    conversationNav.replaceChildren();
    return;
  }

  const items = visitorSessions.map((session) => {
    const item = document.createElement("div");
    item.className = `conversation-item${session.id === sessionId ? " active" : ""}`;

    const button = document.createElement("button");
    button.className = "conversation-select";
    button.type = "button";
    button.addEventListener("click", () => selectConversation(session.id));

    const dot = document.createElement("span");
    dot.className = "conversation-dot";
    dot.setAttribute("aria-hidden", "true");

    const content = document.createElement("span");
    content.className = "conversation-copy";

    const title = document.createElement("span");
    title.className = "conversation-title";
    title.textContent = `对话 ${session.conversationIndex || 1}`;

    const preview = document.createElement("span");
    preview.className = "conversation-preview";
    preview.textContent = `${conversationPreview(session)} · ${relativeTime(session.updatedAt)}`;

    content.append(title, preview);
    const deleteButton = document.createElement("button");
    deleteButton.className = "conversation-delete";
    deleteButton.type = "button";
    deleteButton.textContent = "×";
    deleteButton.title = `删除对话 ${session.conversationIndex || 1}`;
    deleteButton.setAttribute("aria-label", `删除对话 ${session.conversationIndex || 1}`);
    deleteButton.disabled = deletingConversationIds.has(session.id);
    deleteButton.addEventListener("click", () => deleteConversation(session.id));

    button.append(dot, content);
    item.append(button, deleteButton);
    return item;
  });

  conversationNav.replaceChildren(...items);
}

function updateVisitorBadge(label) {
  const name = label || "访客";
  visitorProfileName.textContent = name;
  visitorAvatar.textContent = name.slice(0, 1).toUpperCase() || "访";
}

function showVisitorGate(errorMessage = "") {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  setChatReady(false);
  visitorGate.hidden = false;
  visitorIdInput.value = visitorId;
  visitorError.hidden = !errorMessage;
  visitorError.textContent = errorMessage;
  statusEl.textContent = "等待代号";
  messagesEl.replaceChildren();
  latestSession = null;
  lastRenderSignature = "";
  visitorSessions = [];
  renderConversationNav();
  setTimeout(() => visitorIdInput.focus(), 0);
}

function hideVisitorGate() {
  visitorGate.hidden = true;
  visitorError.hidden = true;
}

function applyVisitorPayload(payload) {
  visitorId = payload.visitor?.label || visitorId;
  sessionId = payload.session.id;
  visitorSessions = payload.sessions || [];
  maxConversations = payload.maxConversations || maxConversations;
  localStorage.setItem(visitorStorageKey, visitorId);
  localStorage.setItem(sessionStorageKey, sessionId);
  updateVisitorBadge(visitorId);
  renderConversationNav();
}

async function identifyVisitor(nextVisitorId) {
  const normalizedVisitorId = nextVisitorId.trim();
  if (!normalizedVisitorId) {
    showVisitorGate("请输入访客代号");
    return;
  }

  isIdentifying = true;
  statusEl.textContent = "正在进入";
  setChatReady(false);
  try {
    const response = await fetch("/api/visitor/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId: normalizedVisitorId, sessionId })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "进入失败");
    }

    applyVisitorPayload(payload);
    hideVisitorGate();
    setChatReady(true);
    input.value = "";
    input.style.height = "auto";
    render(payload.session);
    connectEventStream();
    input.focus();
  } catch (error) {
    showVisitorGate(error.message);
  } finally {
    isIdentifying = false;
  }
}

async function createConversation() {
  if (!visitorId || visitorSessions.length >= maxConversations) {
    return;
  }

  newChatButton.disabled = true;
  statusEl.textContent = "正在创建";
  try {
    const response = await fetch("/api/visitor/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "创建对话失败");
    }

    applyVisitorPayload(payload);
    lastRenderSignature = "";
    input.value = "";
    input.style.height = "auto";
    render(payload.session);
    connectEventStream();
    input.focus();
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    setChatReady(Boolean(sessionId));
  }
}

async function deleteConversation(targetSessionId) {
  if (!visitorId || !targetSessionId || deletingConversationIds.has(targetSessionId)) {
    return;
  }

  const target = visitorSessions.find((session) => session.id === targetSessionId);
  const label = `对话 ${target?.conversationIndex || ""}`.trim();
  if (!window.confirm(`删除${label}？这会清空里面的聊天记录。`)) {
    return;
  }

  deletingConversationIds.add(targetSessionId);
  renderConversationNav();
  statusEl.textContent = "正在删除";

  try {
    const response = await fetch(`/api/visitor/conversations/${encodeURIComponent(targetSessionId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId, activeSessionId: sessionId })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "删除对话失败");
    }

    deletingConversationIds.delete(targetSessionId);
    applyVisitorPayload(payload);
    lastRenderSignature = "";
    input.value = "";
    input.style.height = "auto";
    render(payload.session);
    connectEventStream();
    input.focus();
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    deletingConversationIds.delete(targetSessionId);
    setChatReady(Boolean(sessionId));
    renderConversationNav();
  }
}

function selectConversation(nextSessionId) {
  if (!nextSessionId || nextSessionId === sessionId) {
    return;
  }

  sessionId = nextSessionId;
  localStorage.setItem(sessionStorageKey, sessionId);
  lastRenderSignature = "";
  renderConversationNav();
  connectEventStream();
  fetchState();
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function createBubble(message) {
  const row = document.createElement("article");
  row.className = `message-row ${message.role}`;
  row.dataset.status = message.status || "complete";

  const bubble = document.createElement("div");
  bubble.className = `bubble ${message.status || "complete"}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = `${message.role === "user" ? "你" : "魔丸"} · ${formatTime(message.createdAt)}`;

  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent =
    message.status === "streaming" && !message.content ? "正在生成回复" : message.content;

  bubble.append(meta, content);
  if (message.role === "assistant" && message.audioUrl) {
    const audio = document.createElement("audio");
    audio.className = "message-audio";
    audio.controls = true;
    audio.preload = "none";
    audio.src = message.audioUrl;
    if (message.audioAllowed && !playedAudioUrls.has(message.audioUrl)) {
      playedAudioUrls.add(message.audioUrl);
      setTimeout(() => {
        audio.play().catch(() => {});
      }, 250);
    }
    bubble.append(audio);
  } else if (message.role === "assistant" && message.audioStatus === "generating") {
    const audioStatus = document.createElement("div");
    audioStatus.className = "message-audio-status";
    audioStatus.textContent = "正在生成语音";
    bubble.append(audioStatus);
  }
  row.append(bubble);
  return row;
}

function createTypingBubble() {
  const row = document.createElement("article");
  row.className = "message-row assistant";

  const bubble = document.createElement("div");
  bubble.className = "bubble typing";
  bubble.setAttribute("aria-label", "魔丸 正在思考");

  const label = document.createElement("span");
  label.className = "typing-label";
  label.textContent = "正在思考";

  const dots = document.createElement("span");
  dots.className = "typing-dots";
  dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));

  bubble.append(label, dots);
  row.append(bubble);
  return row;
}

function renderControls(session) {
  const hasSession = Boolean(session);
  stopButton.hidden = !hasSession || !session.isGenerating;
  regenerateButton.hidden = !hasSession || !session.canRegenerate || session.isGenerating;
  generationActions.hidden = stopButton.hidden && regenerateButton.hidden;

  statusEl.textContent = "在线";
}

function render(session) {
  latestSession = session;
  renderControls(session);
  const lastMessage = session.messages[session.messages.length - 1] || null;
  const summary = {
    id: session.id,
    title: session.title,
    visitorLabel: session.visitorLabel,
    conversationIndex: session.conversationIndex,
    updatedAt: lastMessage?.updatedAt || lastMessage?.createdAt || new Date().toISOString(),
    messageCount: session.messages.length,
    lastMessage
  };
  const existingIndex = visitorSessions.findIndex((item) => item.id === session.id);
  if (existingIndex >= 0) {
    visitorSessions[existingIndex] = { ...visitorSessions[existingIndex], ...summary };
  }
  renderConversationNav();

  const signature = JSON.stringify({
    id: session.id,
    ids: session.messages.map(
      (message) => `${message.id}:${message.content}:${message.status}:${message.audioStatus || ""}:${message.audioUrl || ""}`
    ),
    typing: session.typing,
    isGenerating: session.isGenerating,
    canRegenerate: session.canRegenerate
  });
  if (signature === lastRenderSignature) {
    return;
  }

  const shouldStickToBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 160;

  messagesEl.replaceChildren(...session.messages.map(createBubble));
  if (session.typing) {
    messagesEl.append(createTypingBubble());
  }

  if (shouldStickToBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  lastRenderSignature = signature;
}

async function fetchState() {
  if (!sessionId) {
    showVisitorGate();
    return;
  }

  try {
    const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}`);
    const session = await response.json();
    if (!response.ok) {
      if (response.status === 404 && visitorId) {
        localStorage.removeItem(sessionStorageKey);
        sessionId = "";
        identifyVisitor(visitorId);
        return;
      }
      throw new Error(session.error || "连接失败");
    }

    render(session);
  } catch (error) {
    statusEl.textContent = "连接中断";
  }
}

function connectEventStream() {
  if (!sessionId) {
    return;
  }

  if (!window.EventSource) {
    return;
  }

  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(`/api/chat/${encodeURIComponent(sessionId)}/events`);
  eventSource.addEventListener("open", () => {
    statusEl.textContent = "在线";
  });
  eventSource.addEventListener("session", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.session) {
      statusEl.textContent = "在线";
      render(payload.session);
    }
  });
  eventSource.addEventListener("deleted", () => {
    if (visitorId) {
      localStorage.removeItem(sessionStorageKey);
      sessionId = "";
      identifyVisitor(visitorId);
    } else {
      showVisitorGate();
    }
  });
  eventSource.addEventListener("error", () => {
    statusEl.textContent = "正在重连";
  });
}

function fallbackRefresh() {
  if (!sessionId || !visitorGate.hidden || isIdentifying) {
    return;
  }

  if (!window.EventSource || !eventSource || eventSource.readyState !== EventSource.OPEN) {
    fetchState();
  }
}

async function sendMessage(content) {
  if (!sessionId) {
    showVisitorGate();
    return;
  }

  if (isSending) {
    return;
  }

  isSending = true;
  try {
    const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    const session = await response.json();
    if (!response.ok) {
      throw new Error(session.error || "发送失败");
    }

    render(session);
    input.value = "";
    input.style.height = "auto";
    input.focus();
  } finally {
    isSending = false;
  }
}

async function stopGeneration() {
  if (!sessionId || !latestSession?.isGenerating) {
    return;
  }

  const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const payload = await response.json();
  if (response.ok && payload.session) {
    render(payload.session);
  }
}

async function regenerateReply() {
  if (!sessionId || !latestSession?.canRegenerate || latestSession?.isGenerating) {
    return;
  }

  regenerateButton.disabled = true;
  try {
    const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "重新生成失败");
    }

    render(payload.session);
  } finally {
    regenerateButton.disabled = false;
  }
}

function autosizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const content = input.value.trim();
  if (content) {
    sendMessage(content);
  }
});

input.addEventListener("input", autosizeInput);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

suggestionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.suggestion;
    autosizeInput();
    input.focus();
  });
});

visitorForm.addEventListener("submit", (event) => {
  event.preventDefault();
  visitorError.hidden = true;
  identifyVisitor(visitorIdInput.value);
});

newChatButton.addEventListener("click", createConversation);
stopButton.addEventListener("click", stopGeneration);
regenerateButton.addEventListener("click", regenerateReply);

updateVisitorBadge(visitorId);
setChatReady(false);
if (visitorId) {
  identifyVisitor(visitorId);
} else {
  showVisitorGate();
}
setInterval(fallbackRefresh, 5000);
