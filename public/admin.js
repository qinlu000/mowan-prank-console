const sessionListEl = document.querySelector("#sessionList");
const sessionCountEl = document.querySelector("#sessionCount");
const adminMessagesEl = document.querySelector("#adminMessages");
const activeTitleEl = document.querySelector("#activeTitle");
const activeMetaEl = document.querySelector("#activeMeta");
const refreshButton = document.querySelector("#refreshButton");
const revealButton = document.querySelector("#revealButton");
const replyForm = document.querySelector("#replyForm");
const replyInput = document.querySelector("#replyInput");
const replyButton = document.querySelector("#replyButton");
const delayToggle = document.querySelector("#delayToggle");
const delaySelect = document.querySelector("#delaySelect");

let sessions = [];
let activeSessionId = null;
let activeSignature = "";
let typingTimer = null;

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
  if (!session.lastMessage) {
    return "暂无消息";
  }

  const prefix = session.lastMessage.role === "user" ? "访客：" : "AstraChat：";
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

function createMessageRow(message) {
  const row = document.createElement("article");
  row.className = `message-row ${message.role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = `${message.role === "user" ? "访客" : "AstraChat"} · ${formatTime(message.createdAt)}`;

  const content = document.createElement("div");
  content.textContent = message.content;

  bubble.append(meta, content);
  row.append(bubble);
  return row;
}

function createTypingRow() {
  const row = document.createElement("article");
  row.className = "message-row assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble typing";
  bubble.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
  row.append(bubble);
  return row;
}

function setComposerEnabled(enabled) {
  replyInput.disabled = !enabled;
  replyButton.disabled = !enabled;
  revealButton.disabled = !enabled;
}

function renderActiveSession(session) {
  activeTitleEl.textContent = session.title || "新访客";
  activeMetaEl.textContent = `${session.messageCount} 条消息 · 最近更新 ${formatTime(session.updatedAt)}`;
  setComposerEnabled(true);

  const signature = JSON.stringify({
    ids: session.messages.map((message) => `${message.id}:${message.content}`),
    typing: session.adminTyping,
    revealed: session.revealed
  });
  if (signature === activeSignature) {
    return;
  }

  const shouldStickToBottom =
    adminMessagesEl.scrollHeight - adminMessagesEl.scrollTop - adminMessagesEl.clientHeight < 180;

  const rows = session.messages.map(createMessageRow);
  if (session.adminTyping) {
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
  setComposerEnabled(false);
  activeSignature = "";

  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = "选择一个会话后，就可以在这里手动扮演 AstraChat 回复。";
  adminMessagesEl.replaceChildren(empty);
}

async function fetchSessions() {
  const response = await fetch("/api/admin/sessions");
  const payload = await response.json();
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
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "无法读取当前会话");
  }

  renderActiveSession(payload.session);
}

async function refreshAll() {
  try {
    await fetchSessions();
    await fetchActiveSession();
  } catch (error) {
    activeMetaEl.textContent = error.message;
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

  await fetch(`/api/admin/sessions/${encodeURIComponent(activeSessionId)}/typing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ typing })
  });
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
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "回复失败");
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
    replyButton.disabled = false;
  }
});

replyInput.addEventListener("input", announceTyping);
replyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    replyForm.requestSubmit();
  }
});

document.querySelectorAll("[data-reply]").forEach((button) => {
  button.addEventListener("click", () => {
    replyInput.value = `${button.dataset.reply}${replyInput.value ? `\n${replyInput.value}` : ""}`;
    replyInput.focus();
    announceTyping();
  });
});

revealButton.addEventListener("click", async () => {
  if (!activeSessionId) {
    return;
  }

  revealButton.disabled = true;
  try {
    await fetch(`/api/admin/sessions/${encodeURIComponent(activeSessionId)}/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    await refreshAll();
  } finally {
    revealButton.disabled = false;
  }
});

refreshButton.addEventListener("click", refreshAll);

renderNoActiveSession();
refreshAll();
setInterval(refreshAll, 1000);
