const storageKey = "astrachat-prank-session-id";
const messagesEl = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const input = document.querySelector("#messageInput");
const statusEl = document.querySelector("#connectionStatus");
const newChatButton = document.querySelector("#newChatButton");

let sessionId = getSessionId();
let lastRenderSignature = "";
let isSending = false;

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

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = `${message.role === "user" ? "你" : "AstraChat"} · ${formatTime(message.createdAt)}`;

  const content = document.createElement("div");
  content.textContent = message.content;

  bubble.append(meta, content);
  row.append(bubble);
  return row;
}

function createTypingBubble() {
  const row = document.createElement("article");
  row.className = "message-row assistant";

  const bubble = document.createElement("div");
  bubble.className = "bubble typing";
  bubble.setAttribute("aria-label", "AstraChat 正在输入");

  bubble.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
  row.append(bubble);
  return row;
}

function render(session) {
  const signature = JSON.stringify({
    ids: session.messages.map((message) => `${message.id}:${message.content}`),
    typing: session.typing
  });
  if (signature === lastRenderSignature) {
    return;
  }

  const shouldStickToBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;

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

    statusEl.textContent = session.typing ? "正在生成回复" : "在线";
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

fetchState();
setInterval(fetchState, 900);
