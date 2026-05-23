const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, timingSafeEqual } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fastify = require("fastify");

const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 5173),
  publicDir: path.resolve(__dirname, "public"),
  adminCookieName: "mowan_admin",
  adminPassword: process.env.ADMIN_PASSWORD || randomUUID().slice(0, 12),
  databaseUrl: process.env.DATABASE_URL || "file:data/mowan.sqlite",
  sessionRetentionDays: Number(process.env.SESSION_RETENTION_DAYS || 7)
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

function resolveDatabasePath(databaseUrl) {
  if (databaseUrl === ":memory:") {
    return databaseUrl;
  }

  const value = databaseUrl.startsWith("file:") ? databaseUrl.slice(5) : databaseUrl;
  return path.isAbsolute(value) ? value : path.resolve(__dirname, value);
}

function parseJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function createDatabase() {
  const databasePath = resolveDatabasePath(config.databaseUrl);
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      admin_typing INTEGER NOT NULL DEFAULT 0,
      revealed INTEGER NOT NULL DEFAULT 0,
      regenerate_request TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      position INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_position
      ON messages(session_id, position);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_session_created
      ON audit_logs(session_id, created_at);
  `);

  database
    .prepare("UPDATE messages SET status = 'stopped', updated_at = ? WHERE status = 'streaming'")
    .run(now());

  return database;
}

const db = createDatabase();
const statements = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (
      id, title, created_at, updated_at, last_seen_at, admin_typing, revealed, regenerate_request
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      updated_at = excluded.updated_at,
      last_seen_at = excluded.last_seen_at,
      admin_typing = excluded.admin_typing,
      revealed = excluded.revealed,
      regenerate_request = excluded.regenerate_request
  `),
  upsertMessage: db.prepare(`
    INSERT INTO messages (
      id, session_id, role, content, created_at, updated_at, status, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      updated_at = excluded.updated_at,
      status = excluded.status,
      position = excluded.position
  `),
  selectSessions: db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC"),
  selectMessages: db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY position ASC"),
  deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE updated_at < ?"),
  insertAuditLog: db.prepare(`
    INSERT INTO audit_logs (id, session_id, actor, action, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
};

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

function persistSession(session) {
  statements.upsertSession.run(
    session.id,
    session.title,
    session.createdAt,
    session.updatedAt,
    session.lastSeenAt,
    session.adminTyping ? 1 : 0,
    session.revealed ? 1 : 0,
    session.regenerateRequest ? JSON.stringify(session.regenerateRequest) : null
  );
}

function persistMessage(session, message) {
  const position = session.messages.findIndex((item) => item.id === message.id);
  statements.upsertMessage.run(
    message.id,
    session.id,
    message.role,
    message.content,
    message.createdAt,
    message.updatedAt || message.createdAt,
    message.status || "complete",
    position < 0 ? session.messages.length : position
  );
}

function persistAllMessages(session) {
  for (const message of session.messages) {
    persistMessage(session, message);
  }
}

function recordAuditLog(action, { sessionId = null, actor = "system", detail = null } = {}) {
  statements.insertAuditLog.run(
    randomUUID(),
    sessionId,
    actor,
    action,
    detail ? JSON.stringify(detail) : null,
    now()
  );
}

function hydrateSession(row) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    adminTyping: Boolean(row.admin_typing),
    revealed: Boolean(row.revealed),
    regenerateRequest: parseJson(row.regenerate_request, null),
    generation: null,
    pendingTimers: new Set(),
    messages: statements.selectMessages.all(row.id).map((messageRow) => ({
      id: messageRow.id,
      role: messageRow.role,
      content: messageRow.content,
      createdAt: messageRow.created_at,
      updatedAt: messageRow.updated_at,
      status: messageRow.status
    }))
  };
}

function cleanupExpiredSessions() {
  const retentionDays = Number.isFinite(config.sessionRetentionDays)
    ? Math.max(0, config.sessionRetentionDays)
    : 7;
  if (retentionDays <= 0) {
    return;
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = statements.deleteExpiredSessions.run(cutoff);
  if (result.changes > 0) {
    recordAuditLog("cleanup_expired_sessions", { detail: { cutoff, count: result.changes } });
  }
}

function loadSessionsFromDatabase() {
  cleanupExpiredSessions();
  for (const row of statements.selectSessions.all()) {
    const session = hydrateSession(row);
    sessions.set(session.id, session);
  }
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
    const session = sessions.get(id);
    persistSession(session);
    persistAllMessages(session);
    recordAuditLog("session_created", { sessionId: id });
  }

  return sessions.get(id);
}

function touch(session) {
  session.updatedAt = now();
  persistSession(session);
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
      persistMessage(session, message);
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
      persistMessage(session, message);
      touch(session);
      return;
    }

    persistMessage(session, message);
    touch(session);
    queueStreamStep(session);
  }, nextStreamDelay(generation.target, generation.index));

  generation.timer = timer;
  session.pendingTimers.add(timer);
}

function startStreamingReply(session, content) {
  const message = createMessage("assistant", "", { status: "streaming" });
  session.messages.push(message);
  persistMessage(session, message);
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
  recordAuditLog("admin_login", { actor: "admin" });
  setAdminCookie(reply, token);
  sendJson(reply, 200, { ok: true });
}

async function handleAdminLogout(request, reply) {
  const token = parseCookies(request).get(config.adminCookieName);
  if (token) {
    adminTokens.delete(token);
  }
  recordAuditLog("admin_logout", { actor: "admin" });
  clearAdminCookie(reply);
  sendJson(reply, 200, { ok: true });
}

async function getChatSession(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  session.lastSeenAt = now();
  persistSession(session);
  sendJson(reply, 200, publicSession(session));
}

async function postChatMessage(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  session.lastSeenAt = now();
  persistSession(session);
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
  const message = createMessage("user", content);
  session.messages.push(message);
  persistMessage(session, message);
  if (session.title === newVisitorTitle) {
    session.title = content.length > 28 ? `${content.slice(0, 28)}...` : content;
  }
  session.regenerateRequest = null;
  session.adminTyping = true;
  touch(session);
  recordAuditLog("user_message", { sessionId: session.id, actor: "visitor" });
  sendJson(reply, 201, publicSession(session));
}

async function stopChatGeneration(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  session.lastSeenAt = now();
  const stopped = stopActiveGeneration(session, "stopped");
  persistSession(session);
  if (stopped) {
    recordAuditLog("stop_generation", { sessionId: session.id, actor: "visitor" });
  }
  sendJson(reply, 200, { ok: true, stopped, session: publicSession(session) });
}

async function requestRegenerate(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  session.lastSeenAt = now();
  persistSession(session);
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
  recordAuditLog("regenerate_request", { sessionId: session.id, actor: "visitor" });
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
  recordAuditLog("admin_reply", {
    sessionId: session.id,
    actor: "admin",
    detail: { delayMs, length: content.length }
  });
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
  const message = createMessage(
    "assistant",
    "摊牌了：这个聊天窗口背后不是大模型，是有人在后台手动回复你。你刚刚参与了一个 LLM 网站整蛊实验。"
  );
  session.messages.push(message);
  persistMessage(session, message);
  session.revealed = true;
  clearManualTyping(session);
  touch(session);
  recordAuditLog("reveal_prank", { sessionId: session.id, actor: "admin" });
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

loadSessionsFromDatabase();
const cleanupTimer = setInterval(cleanupExpiredSessions, 60 * 60 * 1000);
cleanupTimer.unref();

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
app.addHook("onClose", async () => {
  clearAllTimers();
  clearInterval(cleanupTimer);
  db.close();
});
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
