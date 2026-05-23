const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, timingSafeEqual } = require("node:crypto");

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 5173);
const publicDir = path.resolve(__dirname, "public");
const newVisitorTitle = "新访客";
const adminCookieName = "mowan_admin";
const generatedAdminPassword = randomUUID().slice(0, 12);
const adminPassword = process.env.ADMIN_PASSWORD || generatedAdminPassword;

const sessions = new Map();
const adminTokens = new Set();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".ico", "image/x-icon"]
]);

function now() {
  return new Date().toISOString();
}

function createMessage(role, content, extra = {}) {
  return {
    id: randomUUID(),
    role,
    content: String(content),
    createdAt: now(),
    updatedAt: now(),
    status: "complete",
    ...extra
  };
}

function serializeMessage(message) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt || message.createdAt,
    status: message.status || "complete"
  };
}

function isValidSessionId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(id);
}

function getSession(id) {
  if (!isValidSessionId(id)) {
    return null;
  }

  if (!sessions.has(id)) {
    const createdAt = now();
    sessions.set(id, {
      id,
      title: newVisitorTitle,
      createdAt,
      updatedAt: createdAt,
      lastSeenAt: createdAt,
      adminTyping: false,
      revealed: false,
      regenerateRequest: null,
      generation: null,
      pendingTimers: new Set(),
      messages: [
        createMessage(
          "assistant",
          "你好，我是魔丸。把你的问题交给我，我会尽量给出清晰、直接的回答。"
        )
      ]
    });
  }

  return sessions.get(id);
}

function touch(session) {
  session.updatedAt = now();
}

function lastAssistantMessage(session) {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.role === "assistant") {
      return message;
    }
  }
  return null;
}

function canRegenerate(session) {
  const lastAssistant = lastAssistantMessage(session);
  return Boolean(lastAssistant && !session.generation && !session.adminTyping);
}

function summarizeSession(session) {
  const last = session.messages[session.messages.length - 1];
  const userMessages = session.messages.filter((message) => message.role === "user");
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastSeenAt: session.lastSeenAt,
    adminTyping: session.adminTyping,
    isGenerating: session.generation?.type === "stream",
    regenerateRequested: Boolean(session.regenerateRequest),
    regenerateRequest: session.regenerateRequest,
    revealed: session.revealed,
    messageCount: session.messages.length,
    userMessageCount: userMessages.length,
    lastMessage: last
      ? {
          role: last.role,
          content: last.content,
          createdAt: last.createdAt,
          status: last.status || "complete"
        }
      : null
  };
}

function publicSession(session) {
  const isGenerating = session.generation?.type === "stream";
  const awaitingReply = Boolean(session.adminTyping && !isGenerating);

  return {
    id: session.id,
    title: session.title,
    messages: session.messages.map(serializeMessage),
    typing: awaitingReply,
    awaitingReply,
    isGenerating,
    canRegenerate: canRegenerate(session),
    revealed: session.revealed
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store"
  });
  res.end();
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = new Map();
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) {
      continue;
    }
    cookies.set(rawName, decodeURIComponent(rawValue.join("=")));
  }
  return cookies;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isAdminAuthenticated(req) {
  const token = parseCookies(req).get(adminCookieName);
  return Boolean(token && adminTokens.has(token));
}

function setAdminCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${adminCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`
  );
}

function clearAdminCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${adminCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error("请求内容太大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON 格式无效"));
      }
    });
    req.on("error", reject);
  });
}

function sendStatic(urlPath, res) {
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(safePath);
  } catch {
    sendError(res, 400, "路径无效");
    return;
  }

  const filePath = path.resolve(publicDir, `.${decodedPath}`);
  if (!filePath.startsWith(publicDir)) {
    sendError(res, 403, "禁止访问");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendError(res, error.code === "ENOENT" ? 404 : 500, "文件不存在");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes.get(ext) || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function parseChatPath(pathname) {
  const match = pathname.match(/^\/api\/chat\/([^/]+)(?:\/(messages|stop|regenerate))?$/);
  if (!match) {
    return null;
  }

  return {
    sessionId: match[1],
    action: match[2] || null
  };
}

function parseAdminPath(pathname) {
  const match = pathname.match(/^\/api\/admin\/sessions(?:\/([^/]+)(?:\/(reply|typing|reveal))?)?$/);
  if (!match) {
    return null;
  }

  return {
    sessionId: match[1] || null,
    action: match[2] || null
  };
}

async function handleAdminLogin(req, res) {
  if (req.method !== "POST") {
    sendError(res, 405, "方法不允许");
    return;
  }

  const body = await readJson(req);
  const password = String(body.password || "");
  if (!safeEqual(password, adminPassword)) {
    sendError(res, 401, "后台密码不正确");
    return;
  }

  const token = randomUUID();
  adminTokens.add(token);
  setAdminCookie(res, token);
  sendJson(res, 200, { ok: true });
}

function handleAdminLogout(req, res) {
  const token = parseCookies(req).get(adminCookieName);
  if (token) {
    adminTokens.delete(token);
  }
  clearAdminCookie(res);
  sendJson(res, 200, { ok: true });
}

function clearGenerationTimer(session) {
  if (!session.generation?.timer) {
    return;
  }

  clearTimeout(session.generation.timer);
  session.pendingTimers.delete(session.generation.timer);
  session.generation.timer = null;
}

function stopActiveGeneration(session, status = "stopped") {
  if (!session.generation) {
    return false;
  }

  clearGenerationTimer(session);

  if (session.generation.messageId) {
    const message = session.messages.find((item) => item.id === session.generation.messageId);
    if (message && message.status === "streaming") {
      message.status = status;
      message.updatedAt = now();
    }
  }

  session.generation = null;
  session.adminTyping = false;
  touch(session);
  return true;
}

function nextChunkSize(target, index) {
  const remaining = target.length - index;
  if (remaining <= 0) {
    return 0;
  }

  if (target[index] === "\n") {
    return 1;
  }

  const base = target.length > 800 ? 4 : 1;
  const spread = target.length > 800 ? 5 : 3;
  return Math.min(remaining, base + Math.floor(Math.random() * spread));
}

function nextStreamDelay(target, index) {
  const current = target[index] || "";
  if (current === "\n") {
    return 180 + Math.floor(Math.random() * 160);
  }
  if (/[，。！？,.!?]/.test(current)) {
    return 120 + Math.floor(Math.random() * 120);
  }
  return 32 + Math.floor(Math.random() * 54);
}

function queueStreamStep(session) {
  const generation = session.generation;
  if (!generation) {
    return;
  }

  const timer = setTimeout(() => {
    session.pendingTimers.delete(timer);

    if (session.generation !== generation) {
      return;
    }

    const message = session.messages.find((item) => item.id === generation.messageId);
    if (!message || message.status !== "streaming") {
      session.generation = null;
      session.adminTyping = false;
      touch(session);
      return;
    }

    const chunkSize = nextChunkSize(generation.target, generation.index);
    message.content += generation.target.slice(generation.index, generation.index + chunkSize);
    generation.index += chunkSize;
    message.updatedAt = now();

    if (generation.index >= generation.target.length) {
      message.status = "complete";
      session.generation = null;
      session.adminTyping = false;
      touch(session);
      return;
    }

    touch(session);
    queueStreamStep(session);
  }, nextStreamDelay(generation.target, generation.index));

  generation.timer = timer;
  session.pendingTimers.add(timer);
}

function startStreamingReply(session, content) {
  const message = createMessage("assistant", "", { status: "streaming" });
  session.messages.push(message);
  session.adminTyping = false;
  session.regenerateRequest = null;
  session.generation = {
    type: "stream",
    messageId: message.id,
    target: content,
    index: 0,
    timer: null
  };
  touch(session);
  queueStreamStep(session);
}

function queueReply(session, content, delayMs) {
  stopActiveGeneration(session, "stopped");
  session.adminTyping = true;
  touch(session);

  if (delayMs <= 0) {
    startStreamingReply(session, content);
    return;
  }

  const timer = setTimeout(() => {
    session.pendingTimers.delete(timer);
    if (!session.generation || session.generation.timer !== timer) {
      return;
    }
    session.generation = null;
    startStreamingReply(session, content);
  }, delayMs);

  session.generation = {
    type: "delay",
    messageId: null,
    target: content,
    index: 0,
    timer
  };
  session.pendingTimers.add(timer);
}

function clearManualTyping(session) {
  if (!session.generation) {
    session.adminTyping = false;
  }
}

async function handleChatApi(req, res, pathname) {
  const chatPath = parseChatPath(pathname);
  if (!chatPath) {
    sendError(res, 404, "接口不存在");
    return;
  }

  const session = getSession(chatPath.sessionId);
  if (!session) {
    sendError(res, 400, "会话 ID 无效");
    return;
  }

  session.lastSeenAt = now();

  if (req.method === "GET" && !chatPath.action) {
    sendJson(res, 200, publicSession(session));
    return;
  }

  if (req.method === "POST" && chatPath.action === "messages") {
    const body = await readJson(req);
    const content = String(body.content || "").trim();
    if (!content) {
      sendError(res, 400, "消息不能为空");
      return;
    }

    if (content.length > 2000) {
      sendError(res, 400, "消息太长了");
      return;
    }

    stopActiveGeneration(session, "stopped");
    session.messages.push(createMessage("user", content));
    if (session.title === newVisitorTitle) {
      session.title = content.length > 28 ? `${content.slice(0, 28)}...` : content;
    }
    session.regenerateRequest = null;
    session.adminTyping = true;
    touch(session);
    sendJson(res, 201, publicSession(session));
    return;
  }

  if (req.method === "POST" && chatPath.action === "stop") {
    const stopped = stopActiveGeneration(session, "stopped");
    sendJson(res, 200, { ok: true, stopped, session: publicSession(session) });
    return;
  }

  if (req.method === "POST" && chatPath.action === "regenerate") {
    const lastAssistant = lastAssistantMessage(session);
    if (!lastAssistant) {
      sendError(res, 400, "还没有可重新生成的回复");
      return;
    }

    stopActiveGeneration(session, "stopped");
    session.regenerateRequest = {
      id: randomUUID(),
      createdAt: now(),
      previousMessageId: lastAssistant.id
    };
    session.adminTyping = true;
    touch(session);
    sendJson(res, 200, { ok: true, session: publicSession(session) });
    return;
  }

  sendError(res, 405, "方法不允许");
}

async function handleAdminApi(req, res, pathname) {
  const adminPath = parseAdminPath(pathname);
  if (!adminPath) {
    sendError(res, 404, "接口不存在");
    return;
  }

  if (req.method === "GET" && !adminPath.sessionId) {
    const sortedSessions = [...sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summarizeSession);
    sendJson(res, 200, { sessions: sortedSessions });
    return;
  }

  if (!adminPath.sessionId) {
    sendError(res, 405, "方法不允许");
    return;
  }

  const session = getSession(adminPath.sessionId);
  if (!session) {
    sendError(res, 400, "会话 ID 无效");
    return;
  }

  if (req.method === "GET" && !adminPath.action) {
    sendJson(res, 200, {
      session: {
        ...summarizeSession(session),
        canRegenerate: canRegenerate(session),
        messages: session.messages.map(serializeMessage)
      }
    });
    return;
  }

  if (req.method !== "POST") {
    sendError(res, 405, "方法不允许");
    return;
  }

  const body = await readJson(req);

  if (adminPath.action === "typing") {
    if (session.generation) {
      sendJson(res, 200, { ok: true, typing: false });
      return;
    }

    session.adminTyping = Boolean(body.typing);
    touch(session);
    sendJson(res, 200, { ok: true, typing: session.adminTyping });
    return;
  }

  if (adminPath.action === "reply") {
    const content = String(body.content || "").trim();
    if (!content) {
      sendError(res, 400, "回复不能为空");
      return;
    }

    if (content.length > 4000) {
      sendError(res, 400, "回复太长了");
      return;
    }

    const delayMs = Math.max(0, Math.min(Number(body.delayMs || 0), 8000));
    queueReply(session, content, delayMs);
    sendJson(res, delayMs > 0 ? 202 : 201, {
      ok: true,
      queued: delayMs > 0,
      streaming: delayMs <= 0,
      delayMs,
      session: summarizeSession(session)
    });
    return;
  }

  if (adminPath.action === "reveal") {
    stopActiveGeneration(session, "stopped");
    session.messages.push(
      createMessage(
        "assistant",
        "摊牌了：这个聊天窗口背后不是大模型，是有人在后台手动回复你。你刚刚参与了一个 LLM 网站整蛊实验。"
      )
    );
    session.revealed = true;
    clearManualTyping(session);
    touch(session);
    sendJson(res, 201, { ok: true, revealed: true });
    return;
  }

  sendError(res, 404, "接口不存在");
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);

  try {
    if (url.pathname === "/admin.html" && !isAdminAuthenticated(req)) {
      redirect(res, "/admin-login.html");
      return;
    }

    if (url.pathname === "/admin-login.html" && isAdminAuthenticated(req)) {
      redirect(res, "/admin.html");
      return;
    }

    if (url.pathname.startsWith("/api/chat/")) {
      await handleChatApi(req, res, url.pathname);
      return;
    }

    if (url.pathname === "/api/admin/login") {
      await handleAdminLogin(req, res);
      return;
    }

    if (url.pathname === "/api/admin/logout") {
      handleAdminLogout(req, res);
      return;
    }

    if (url.pathname.startsWith("/api/admin/")) {
      if (!isAdminAuthenticated(req)) {
        sendError(res, 401, "需要后台登录");
        return;
      }
      await handleAdminApi(req, res, url.pathname);
      return;
    }

    sendStatic(url.pathname, res);
  } catch (error) {
    sendError(res, 500, error.message || "服务器错误");
  }
}

const server = http.createServer(handleRequest);

server.listen(port, host, () => {
  console.log(`魔丸 prank server is running at http://${host}:${port}`);
  console.log(`Visitor page: http://${host}:${port}/`);
  console.log(`Admin console: http://${host}:${port}/admin.html`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`Generated admin password: ${adminPassword}`);
  }
});

process.on("SIGINT", () => {
  for (const session of sessions.values()) {
    for (const timer of session.pendingTimers) {
      clearTimeout(timer);
    }
  }
  server.close(() => process.exit(0));
});
