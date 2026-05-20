const storageKey = "astrachat-prank-session-id";
const messagesEl = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const input = document.querySelector("#messageInput");
const statusEl = document.querySelector("#connectionStatus");
const newChatButton = document.querySelector("#newChatButton");
const generationActions = document.querySelector("#generationActions");
const stopButton = document.querySelector("#stopButton");
const regenerateButton = document.querySelector("#regenerateButton");

let sessionId = getSessionId();
let lastRenderSignature = "";
let isSending = false;
let latestSession = null;

function getSessionId() {
  const existing = localStorage.getItem(storageKey);
  if (existing) {
    return existing;
  }

  const id =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  localStorage.setItem(storageKey, id);
  return id;
}

function resetChat() {
  localStorage.removeItem(storageKey);
  sessionId = getSessionId();
  latestSession = null;
  lastRenderSignature = "";
  input.value = "";
  input.style.height = "auto";
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
  meta.textContent = `${message.role === "user" ? "你" : "AstraChat"} · ${formatTime(message.createdAt)}`;

  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent =
    message.status === "streaming" && !message.content ? "正在生成回复" : message.content;

  bubble.append(meta, content);
  row.append(bubble);
  return row;
}

function createTypingBubble() {
  const row = document.createElement("article");
  row.className = "message-row assistant";

  const bubble = document.createElement("div");
  bubble.className = "bubble typing";
  bubble.setAttribute("aria-label", "AstraChat 正在思考");

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

  const signature = JSON.stringify({
    ids: session.messages.map((message) => `${message.id}:${message.content}:${message.status}`),
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
  try {
    const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}`);
    const session = await response.json();
    if (!response.ok) {
      throw new Error(session.error || "连接失败");
    }

    render(session);
  } catch (error) {
    statusEl.textContent = "连接中断";
  }
}

async function sendMessage(content) {
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
  if (!latestSession?.isGenerating) {
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
  if (!latestSession?.canRegenerate || latestSession?.isGenerating) {
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

document.querySelectorAll("[data-suggestion]").forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.suggestion;
    autosizeInput();
    input.focus();
  });
});

newChatButton.addEventListener("click", resetChat);
stopButton.addEventListener("click", stopGeneration);
regenerateButton.addEventListener("click", regenerateReply);

fetchState();
setInterval(fetchState, 420);
