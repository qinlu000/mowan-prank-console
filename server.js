const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, timingSafeEqual } = require("node:crypto");
const fastify = require("fastify");

const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 5173),
  publicDir: path.resolve(__dirname, "public"),
  adminCookieName: "mowan_admin",
  adminPassword: process.env.ADMIN_PASSWORD || randomUUID().slice(0, 12)
};

const newVisitorTitle = "新访客";
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

function requestBody(request) {
  return request.body && typeof request.body === "object" ? request.body : {};
}

function sendJson(reply, status, payload) {
  reply.code(status).type("application/json; charset=utf-8").send(payload);
}

function sendError(reply, status, message) {
  sendJson(reply, status, { error: message });
}

function redirect(reply, location) {
  reply.code(302).header("Location", location).header("Cache-Control", "no-store").send();
}

function parseCookies(request) {
  const header = request.headers.cookie || "";
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

function isAdminAuthenticated(request) {
  const token = parseCookies(request).get(config.adminCookieName);
  return Boolean(token && adminTokens.has(token));
}

async function requireAdmin(request, reply) {
  if (!isAdminAuthenticated(request)) {
    sendError(reply, 401, "需要后台登录");
    return reply;
  }
  return undefined;
}

function setAdminCookie(reply, token) {
  reply.header(
    "Set-Cookie",
    `${config.adminCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`
  );
}

function clearAdminCookie(reply) {
  reply.header(
    "Set-Cookie",
    `${config.adminCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
}

async function sendStatic(urlPath, reply) {
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(safePath);
  } catch {
    sendError(reply, 400, "路径无效");
    return;
  }

  const filePath = path.resolve(config.publicDir, `.${decodedPath}`);
  const insidePublicDir =
    filePath === config.publicDir || filePath.startsWith(`${config.publicDir}${path.sep}`);
  if (!insidePublicDir) {
    sendError(reply, 403, "禁止访问");
    return;
  }

  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    reply
      .code(200)
      .type(mimeTypes.get(ext) || "application/octet-stream")
      .header("Cache-Control", "no-store")
      .send(data);
  } catch (error) {
    sendError(reply, error.code === "ENOENT" ? 404 : 500, "文件不存在");
  }
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

function sessionFromRequest(request, reply) {
  const session = getSession(request.params.sessionId);
  if (!session) {
    sendError(reply, 400, "会话 ID 无效");
    return null;
  }
  return session;
}

async function handleAdminLogin(request, reply) {
  const body = requestBody(request);
  const password = String(body.password || "");
  if (!safeEqual(password, config.adminPassword)) {
    sendError(reply, 401, "后台密码不正确");
    return;
  }

  const token = randomUUID();
  adminTokens.add(token);
  setAdminCookie(reply, token);
  sendJson(reply, 200, { ok: true });
}

async function handleAdminLogout(request, reply) {
  const token = parseCookies(request).get(config.adminCookieName);
  if (token) {
    adminTokens.delete(token);
  }
  clearAdminCookie(reply);
  sendJson(reply, 200, { ok: true });
}

async function getChatSession(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  session.lastSeenAt = now();
  sendJson(reply, 200, publicSession(session));
}

async function postChatMessage(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  session.lastSeenAt = now();
  const body = requestBody(request);
  const content = String(body.content || "").trim();
  if (!content) {
    sendError(reply, 400, "消息不能为空");
    return;
  }

  if (content.length > 2000) {
    sendError(reply, 400, "消息太长了");
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
  sendJson(reply, 201, publicSession(session));
}

async function stopChatGeneration(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  session.lastSeenAt = now();
  const stopped = stopActiveGeneration(session, "stopped");
  sendJson(reply, 200, { ok: true, stopped, session: publicSession(session) });
}

async function requestRegenerate(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  session.lastSeenAt = now();
  const lastAssistant = lastAssistantMessage(session);
  if (!lastAssistant) {
    sendError(reply, 400, "还没有可重新生成的回复");
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
  sendJson(reply, 200, { ok: true, session: publicSession(session) });
}

async function getAdminSessions(request, reply) {
  const sortedSessions = [...sessions.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(summarizeSession);
  sendJson(reply, 200, { sessions: sortedSessions });
}

async function getAdminSession(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  sendJson(reply, 200, {
    session: {
      ...summarizeSession(session),
      canRegenerate: canRegenerate(session),
      messages: session.messages.map(serializeMessage)
    }
  });
}

async function setAdminTyping(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  if (session.generation) {
    sendJson(reply, 200, { ok: true, typing: false });
    return;
  }

  const body = requestBody(request);
  session.adminTyping = Boolean(body.typing);
  touch(session);
  sendJson(reply, 200, { ok: true, typing: session.adminTyping });
}

async function sendAdminReply(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  const body = requestBody(request);
  const content = String(body.content || "").trim();
  if (!content) {
    sendError(reply, 400, "回复不能为空");
    return;
  }

  if (content.length > 4000) {
    sendError(reply, 400, "回复太长了");
    return;
  }

  const delayMs = Math.max(0, Math.min(Number(body.delayMs || 0), 8000));
  queueReply(session, content, delayMs);
  sendJson(reply, delayMs > 0 ? 202 : 201, {
    ok: true,
    queued: delayMs > 0,
    streaming: delayMs <= 0,
    delayMs,
    session: summarizeSession(session)
  });
}

async function revealPrank(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

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
  sendJson(reply, 201, { ok: true, revealed: true });
}

function registerRoutes(app) {
  app.get("/healthz", async (request, reply) => {
    sendJson(reply, 200, { ok: true });
  });

  app.post("/api/admin/login", handleAdminLogin);
  app.all("/api/admin/logout", handleAdminLogout);

  app.get("/api/chat/:sessionId", getChatSession);
  app.post("/api/chat/:sessionId/messages", postChatMessage);
  app.post("/api/chat/:sessionId/stop", stopChatGeneration);
  app.post("/api/chat/:sessionId/regenerate", requestRegenerate);

  app.get("/api/admin/sessions", { preHandler: requireAdmin }, getAdminSessions);
  app.get("/api/admin/sessions/:sessionId", { preHandler: requireAdmin }, getAdminSession);
  app.post("/api/admin/sessions/:sessionId/typing", { preHandler: requireAdmin }, setAdminTyping);
  app.post("/api/admin/sessions/:sessionId/reply", { preHandler: requireAdmin }, sendAdminReply);
  app.post("/api/admin/sessions/:sessionId/reveal", { preHandler: requireAdmin }, revealPrank);
}

async function handleStaticRequest(request, reply) {
  const url = new URL(request.url, `http://${request.headers.host || `${config.host}:${config.port}`}`);

  if (url.pathname.startsWith("/api/")) {
    sendError(reply, 404, "接口不存在");
    return;
  }

  if (url.pathname === "/admin.html" && !isAdminAuthenticated(request)) {
    redirect(reply, "/admin-login.html");
    return;
  }

  if (url.pathname === "/admin-login.html" && isAdminAuthenticated(request)) {
    redirect(reply, "/admin.html");
    return;
  }

  await sendStatic(url.pathname, reply);
}

function clearAllTimers() {
  for (const session of sessions.values()) {
    for (const timer of session.pendingTimers) {
      clearTimeout(timer);
    }
    session.pendingTimers.clear();
  }
}

const app = fastify({
  bodyLimit: 100_000,
  logger: false
});

app.setErrorHandler((error, request, reply) => {
  const status = error.statusCode || 500;
  const message = status === 413 ? "请求内容太大" : error.message || "服务器错误";
  sendError(reply, status >= 400 ? status : 500, message);
});

app.setNotFoundHandler(handleStaticRequest);
app.addHook("onClose", clearAllTimers);
registerRoutes(app);

async function start() {
  try {
    await app.listen({ host: config.host, port: config.port });
    console.log(`魔丸 prank server is running at http://${config.host}:${config.port}`);
    console.log(`Visitor page: http://${config.host}:${config.port}/`);
    console.log(`Admin console: http://${config.host}:${config.port}/admin.html`);
    if (!process.env.ADMIN_PASSWORD) {
      console.log(`Generated admin password: ${config.adminPassword}`);
    }
  } catch (error) {
    app.log.error(error);
    console.error(error);
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  await app.close();
  process.exit(0);
});

start();
