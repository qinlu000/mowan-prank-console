const legacyStorageKeys = ["astra" + "chat-prank-session-id"];
const sessionStorageKey = "mowan-prank-session-id";
const visitorStorageKey = "mowan-prank-visitor-id";
const messagesEl = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const input = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const statusEl = document.querySelector("#connectionStatus");
const newChatButton = document.querySelector("#newChatButton");
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
let lastRenderSignature = "";
let isSending = false;
let isIdentifying = false;
let latestSession = null;
let eventSource = null;

for (const key of legacyStorageKeys) {
  localStorage.removeItem(key);
}

function setChatReady(ready) {
  input.disabled = !ready;
  sendButton.disabled = !ready;
  stopButton.disabled = !ready;
  regenerateButton.disabled = !ready;
  for (const button of suggestionButtons) {
    button.disabled = !ready;
  }
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
  setTimeout(() => visitorIdInput.focus(), 0);
}

function hideVisitorGate() {
  visitorGate.hidden = true;
  visitorError.hidden = true;
}

function switchVisitor() {
  isIdentifying = false;
  localStorage.removeItem(visitorStorageKey);
  localStorage.removeItem(sessionStorageKey);
  visitorId = "";
  sessionId = "";
  latestSession = null;
  lastRenderSignature = "";
  input.value = "";
  input.style.height = "auto";
  updateVisitorBadge("");
  showVisitorGate();
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
      body: JSON.stringify({ visitorId: normalizedVisitorId })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "进入失败");
    }

    visitorId = payload.visitor?.label || normalizedVisitorId;
    sessionId = payload.session.id;
    localStorage.setItem(visitorStorageKey, visitorId);
    localStorage.setItem(sessionStorageKey, sessionId);
    updateVisitorBadge(visitorId);
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
  if (!sessionId) {
    showVisitorGate();
    return;
  }

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

newChatButton.addEventListener("click", switchVisitor);
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
