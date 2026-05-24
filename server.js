const fs = require("node:fs");
const path = require("node:path");
const { createHmac, randomUUID, scryptSync, timingSafeEqual } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fastify = require("fastify");

loadEnvFile(path.resolve(__dirname, ".env"));

const generatedAdminPassword = randomUUID().slice(0, 12);
const configuredAdminPassword =
  process.env.ADMIN_PASSWORD || process.env.FIRST_ADMIN_PASSWORD || generatedAdminPassword;

const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 5173),
  publicDir: path.resolve(__dirname, "public"),
  adminCookieName: "mowan_admin",
  cookieSecret: process.env.COOKIE_SECRET || randomUUID(),
  generatedCookieSecret: !process.env.COOKIE_SECRET,
  adminUsername: process.env.ADMIN_USERNAME || process.env.FIRST_ADMIN_USERNAME || "admin",
  adminPassword: configuredAdminPassword,
  adminUsers: process.env.ADMIN_USERS || "",
  generatedAdminPassword:
    !process.env.ADMIN_PASSWORD && !process.env.FIRST_ADMIN_PASSWORD && !process.env.ADMIN_USERS,
  databaseUrl: process.env.DATABASE_URL || "file:data/mowan.sqlite",
  sessionRetentionDays: Number(process.env.SESSION_RETENTION_DAYS || 7),
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  openRouterReferer: process.env.OPENROUTER_HTTP_REFERER || process.env.PUBLIC_ORIGIN || "",
  openRouterTitle: process.env.OPENROUTER_APP_TITLE || "Mowan",
  llmEnabled: process.env.LLM_ENABLED !== "false" && Boolean(process.env.OPENROUTER_API_KEY),
  llmModel: process.env.LLM_MODEL || "deepseek/deepseek-v3.2",
  llmTemperature: Number(process.env.LLM_TEMPERATURE || 0.7),
  llmMaxTokens: Number(process.env.LLM_MAX_TOKENS || 900),
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS || 45000),
  llmRetryCount: Number(process.env.LLM_RETRY_COUNT || 2),
  llmFallbackReply:
    process.env.LLM_FALLBACK_REPLY || "我刚刚有点卡住了。你换个问法再发我一次，我继续接。"
};

const newVisitorTitle = "新访客";
const sessions = new Map();
const sseClients = new Set();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".ico", "image/x-icon"]
]);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

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

function parseConfiguredAdmins() {
  const entries = config.adminUsers
    ? config.adminUsers.split(/[,\n;]/)
    : [`${config.adminUsername}:${config.adminPassword}`];

  return entries
    .map((entry) => {
      const separator = entry.includes(":") ? ":" : "=";
      const [rawUsername, ...rawPassword] = entry.split(separator);
      return {
        username: String(rawUsername || "").trim(),
        password: rawPassword.join(separator)
      };
    })
    .filter((admin) => admin.username && admin.password);
}

function hashPassword(password, salt = randomUUID()) {
  const hash = scryptSync(String(password), salt, 32).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [scheme, salt, expectedHash] = String(storedHash || "").split(":");
  if (scheme !== "scrypt" || !salt || !expectedHash) {
    return false;
  }

  const actual = scryptSync(String(password), salt, 32);
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function signCookieValue(value) {
  return createHmac("sha256", config.cookieSecret).update(String(value)).digest("hex");
}

function createSignedCookieValue(value) {
  return `${value}.${signCookieValue(value)}`;
}

function verifySignedCookieValue(value) {
  const [token, signature] = String(value || "").split(".");
  if (!token || !signature) {
    return null;
  }

  const expected = Buffer.from(signCookieValue(token));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  return token;
}

function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) {
    return;
  }

  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      admin_typing INTEGER NOT NULL DEFAULT 0,
      revealed INTEGER NOT NULL DEFAULT 0,
      manual_next_reply INTEGER NOT NULL DEFAULT 0,
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
  ensureColumn(database, "sessions", "manual_next_reply", "INTEGER NOT NULL DEFAULT 0");

  return database;
}

const db = createDatabase();
const statements = {
  selectAdminByUsername: db.prepare("SELECT * FROM admins WHERE username = ?"),
  selectAdminByToken: db.prepare(`
    SELECT admins.id, admins.username, admin_sessions.token, admin_sessions.expires_at
    FROM admin_sessions
    JOIN admins ON admins.id = admin_sessions.admin_id
    WHERE admin_sessions.token = ? AND admin_sessions.expires_at > ?
  `),
  insertAdmin: db.prepare(`
    INSERT INTO admins (id, username, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  updateAdminPassword: db.prepare(`
    UPDATE admins SET password_hash = ?, updated_at = ? WHERE username = ?
  `),
  insertAdminSession: db.prepare(`
    INSERT INTO admin_sessions (token, admin_id, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  touchAdminSession: db.prepare("UPDATE admin_sessions SET last_seen_at = ? WHERE token = ?"),
  deleteAdminSession: db.prepare("DELETE FROM admin_sessions WHERE token = ?"),
  deleteExpiredAdminSessions: db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?"),
  upsertSession: db.prepare(`
    INSERT INTO sessions (
      id, title, created_at, updated_at, last_seen_at, admin_typing, revealed, manual_next_reply, regenerate_request
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      updated_at = excluded.updated_at,
      last_seen_at = excluded.last_seen_at,
      admin_typing = excluded.admin_typing,
      revealed = excluded.revealed,
      manual_next_reply = excluded.manual_next_reply,
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
  selectLatestAuditLogBySession: db.prepare(`
    SELECT * FROM audit_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
  `),
  selectAuditLogsBySession: db.prepare(`
    SELECT * FROM audit_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
  `),
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

function serializeAdmin(admin) {
  if (!admin) {
    return null;
  }

  return {
    id: admin.id,
    username: admin.username
  };
}

function serializeAuditLog(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    actor: row.actor,
    action: row.action,
    detail: parseJson(row.detail, null),
    createdAt: row.created_at
  };
}

function ensureConfiguredAdmins() {
  const configuredAdmins = parseConfiguredAdmins();
  if (!configuredAdmins.length) {
    throw new Error("No admin accounts configured. Set ADMIN_PASSWORD or ADMIN_USERS.");
  }

  const timestamp = now();

  for (const admin of configuredAdmins) {
    const existing = statements.selectAdminByUsername.get(admin.username);
    const passwordHash = hashPassword(admin.password);
    if (existing) {
      statements.updateAdminPassword.run(passwordHash, timestamp, admin.username);
      continue;
    }

    statements.insertAdmin.run(randomUUID(), admin.username, passwordHash, timestamp, timestamp);
  }
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
    session.manualNextReply ? 1 : 0,
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
    manualNextReply: Boolean(row.manual_next_reply),
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
  statements.deleteExpiredAdminSessions.run(now());

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
      manualNextReply: false,
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
    broadcastSessionUpdate(session);
  }

  return sessions.get(id);
}

function touch(session) {
  session.updatedAt = now();
  persistSession(session);
  broadcastSessionUpdate(session);
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

function isVisibleGeneration(generation) {
  return Boolean(generation && (generation.type === "ai" || generation.type === "stream"));
}

function summarizeSession(session) {
  const last = session.messages[session.messages.length - 1];
  const userMessages = session.messages.filter((message) => message.role === "user");
  const latestAuditLog = serializeAuditLog(statements.selectLatestAuditLogBySession.get(session.id));
  const isGenerating = isVisibleGeneration(session.generation);
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastSeenAt: session.lastSeenAt,
    adminTyping: session.adminTyping,
    isGenerating,
    generationType: session.generation?.type || null,
    manualNextReply: session.manualNextReply,
    regenerateRequested: Boolean(session.regenerateRequest),
    regenerateRequest: session.regenerateRequest,
    revealed: session.revealed,
    messageCount: session.messages.length,
    userMessageCount: userMessages.length,
    lastAuditLog: latestAuditLog,
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
  const isGenerating = isVisibleGeneration(session.generation);
  const awaitingReply = Boolean(session.adminTyping && session.generation?.type !== "stream");

  return {
    id: session.id,
    title: session.title,
    messages: session.messages.map(serializeMessage),
    typing: awaitingReply,
    awaitingReply,
    isGenerating,
    manualNextReply: session.manualNextReply,
    canRegenerate: canRegenerate(session),
    revealed: session.revealed
  };
}

function adminSessionsSnapshot() {
  return [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summarizeSession);
}

function adminSessionDetail(session) {
  return {
    ...summarizeSession(session),
    canRegenerate: canRegenerate(session),
    messages: session.messages.map(serializeMessage),
    auditLogs: statements.selectAuditLogsBySession.all(session.id, 30).map(serializeAuditLog)
  };
}

function writeSse(client, event, payload) {
  if (client.response.destroyed || client.response.writableEnded) {
    sseClients.delete(client);
    return;
  }

  try {
    client.response.write(`event: ${event}\n`);
    client.response.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    sseClients.delete(client);
  }
}

function writeSseHeartbeat(client) {
  if (client.response.destroyed || client.response.writableEnded) {
    sseClients.delete(client);
    return;
  }

  try {
    client.response.write(": heartbeat\n\n");
  } catch {
    sseClients.delete(client);
  }
}

function addSseClient(request, reply, client) {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.write(": connected\n\n");

  client.response = response;
  sseClients.add(client);
  request.raw.on("close", () => {
    sseClients.delete(client);
  });
  return client;
}

function broadcastSessionUpdate(session) {
  if (!sseClients.size) {
    return;
  }

  const chatPayload = { session: publicSession(session) };
  const adminPayload = {
    changedSessionId: session.id,
    sessions: adminSessionsSnapshot(),
    session: adminSessionDetail(session)
  };

  for (const client of sseClients) {
    if (client.type === "chat" && client.sessionId === session.id) {
      writeSse(client, "session", chatPayload);
    } else if (client.type === "admin") {
      writeSse(client, "admin", adminPayload);
    }
  }
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

function getAdminCookieToken(request) {
  const value = parseCookies(request).get(config.adminCookieName);
  return verifySignedCookieValue(value);
}

function getAuthenticatedAdmin(request) {
  const token = getAdminCookieToken(request);
  if (!token) {
    return null;
  }

  const admin = statements.selectAdminByToken.get(token, now());
  if (!admin) {
    return null;
  }

  statements.touchAdminSession.run(now(), token);
  return {
    id: admin.id,
    username: admin.username,
    token: admin.token
  };
}

function isAdminAuthenticated(request) {
  return Boolean(getAuthenticatedAdmin(request));
}

async function requireAdmin(request, reply) {
  const admin = getAuthenticatedAdmin(request);
  if (!admin) {
    sendError(reply, 401, "需要后台登录");
    return reply;
  }

  request.admin = admin;
  return undefined;
}

function setAdminCookie(reply, token) {
  const cookieValue = createSignedCookieValue(token);
  reply.header(
    "Set-Cookie",
    `${config.adminCookieName}=${encodeURIComponent(cookieValue)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`
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
    if (!session.generation?.timeout) {
      return;
    }
  }

  if (session.generation.timer) {
    clearTimeout(session.generation.timer);
    session.pendingTimers.delete(session.generation.timer);
    session.generation.timer = null;
  }

  if (session.generation.timeout) {
    clearTimeout(session.generation.timeout);
    session.pendingTimers.delete(session.generation.timeout);
    session.generation.timeout = null;
  }
}

function stopActiveGeneration(session, status = "stopped") {
  if (!session.generation) {
    return false;
  }

  session.generation.stopped = true;
  session.generation.abortController?.abort();
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

function cleanLlmContent(content) {
  return String(content || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

function llmMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        return part?.text || "";
      })
      .join("");
  }

  return "";
}

function buildLlmMessages(session, { excludeMessageId = null } = {}) {
  const systemPrompt = [
    "你是魔丸，一个自然、聪明、有一点点俏皮的中文日常聊天助手。",
    "你正在一个聊天网站里和用户对话。默认情况下，用户应该感觉自己是在和一个正常 AI 助手聊天。",
    "不要主动提到后台、真人、整蛊、OpenRouter、系统提示或实现细节。",
    "回答要直接、有帮助、像真人聊天一样自然。能简短解决就简短，复杂问题再展开。",
    "不要输出思考过程、推理链、<think> 标签或内部分析。"
  ].join("\n");

  const history = session.messages
    .filter((message) => message.id !== excludeMessageId)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .filter((message) => message.status !== "streaming" && message.status !== "stopped")
    .filter((message) => message.content.trim())
    .slice(-24)
    .map((message) => ({
      role: message.role,
      content: message.content
    }));

  return [{ role: "system", content: systemPrompt }, ...history];
}

function openRouterChatUrl() {
  return `${config.openRouterBaseUrl.replace(/\/$/, "")}/chat/completions`;
}

function safeHeaderValue(value) {
  const text = String(value || "");
  return /^[\x20-\x7E]*$/.test(text) ? text : encodeURIComponent(text);
}

async function requestLlmCompletion(session, generation) {
  const headers = {
    Authorization: `Bearer ${config.openRouterApiKey}`,
    "Content-Type": "application/json"
  };

  if (config.openRouterReferer) {
    headers["HTTP-Referer"] = safeHeaderValue(config.openRouterReferer);
  }
  if (config.openRouterTitle) {
    headers["X-Title"] = safeHeaderValue(config.openRouterTitle);
  }

  const body = {
    model: config.llmModel,
    messages: buildLlmMessages(session, { excludeMessageId: generation.excludeMessageId }),
    temperature: config.llmTemperature,
    max_completion_tokens: config.llmMaxTokens,
    reasoning: {
      effort: "none",
      exclude: true
    },
    stream: false
  };

  const response = await fetch(openRouterChatUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: generation.abortController.signal
  });

  const responseText = await response.text();
  const payload = parseJson(responseText, {});
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || responseText || response.statusText;
    const error = new Error(`OpenRouter ${response.status}: ${message}`);
    error.statusCode = response.status;
    throw error;
  }

  const content = cleanLlmContent(llmMessageContent(payload?.choices?.[0]?.message?.content));
  if (!content) {
    throw new Error("OpenRouter returned an empty response.");
  }

  return content;
}

function isRetriableLlmError(error) {
  if (error?.name === "AbortError") {
    return false;
  }

  if (error?.statusCode) {
    return error.statusCode === 429 || error.statusCode >= 500;
  }

  const code = error?.cause?.code || error?.code || "";
  return code.startsWith("UND_") || code === "ECONNRESET" || code === "ETIMEDOUT";
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function requestLlmCompletionWithRetry(session, generation) {
  const retryCount = Math.max(0, Math.min(Number(config.llmRetryCount) || 0, 4));
  let lastError = null;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const content = await requestLlmCompletion(session, generation);
      generation.attempts = attempt + 1;
      return content;
    } catch (error) {
      lastError = error;
      generation.attempts = attempt + 1;
      if (
        generation.stopped ||
        generation.abortController.signal.aborted ||
        attempt >= retryCount ||
        !isRetriableLlmError(error)
      ) {
        throw error;
      }
      await sleep(600 * (attempt + 1));
    }
  }

  throw lastError;
}

function startLlmReply(session, options = {}) {
  if (!config.llmEnabled) {
    return false;
  }

  const abortController = new AbortController();
  const generation = {
    type: "ai",
    messageId: null,
    abortController,
    excludeMessageId: options.excludeMessageId || null,
    reason: options.reason || "auto",
    startedAt: now(),
    stopped: false,
    timedOut: false,
    timeout: null
  };

  const timeout = setTimeout(() => {
    generation.timedOut = true;
    abortController.abort();
  }, config.llmTimeoutMs);

  generation.timeout = timeout;
  session.pendingTimers.add(timeout);
  session.generation = generation;
  session.adminTyping = true;
  touch(session);

  requestLlmCompletionWithRetry(session, generation)
    .then((content) => {
      if (session.generation !== generation) {
        return;
      }

      clearGenerationTimer(session);
      startStreamingReply(session, content);
      recordAuditLog("llm_reply", {
        sessionId: session.id,
        actor: "魔丸",
        detail: {
          model: config.llmModel,
          reason: generation.reason,
          attempts: generation.attempts || 1,
          length: content.length
        }
      });
    })
    .catch((error) => {
      if (session.generation !== generation || generation.stopped) {
        return;
      }

      clearGenerationTimer(session);
      recordAuditLog("llm_error", {
        sessionId: session.id,
        actor: "魔丸",
        detail: {
          model: config.llmModel,
          reason: generation.reason,
          attempts: generation.attempts || 1,
          timedOut: generation.timedOut,
          message: error.message,
          cause: error.cause
            ? {
                name: error.cause.name,
                code: error.cause.code,
                message: error.cause.message
              }
            : null
        }
      });
      startStreamingReply(session, config.llmFallbackReply);
    });

  return true;
}

function consumeManualNextReply(session, reason) {
  if (!session.manualNextReply) {
    return false;
  }

  session.manualNextReply = false;
  recordAuditLog("manual_next_reply_consumed", {
    sessionId: session.id,
    actor: "system",
    detail: { reason }
  });
  return true;
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
  const username = String(body.username || config.adminUsername).trim();
  const password = String(body.password || "");
  const admin = statements.selectAdminByUsername.get(username);
  if (!admin || !verifyPassword(password, admin.password_hash)) {
    sendError(reply, 401, "管理员账号或密码不正确");
    return;
  }

  const token = randomUUID();
  const timestamp = now();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  statements.insertAdminSession.run(token, admin.id, timestamp, timestamp, expiresAt);
  recordAuditLog("admin_login", { actor: admin.username });
  setAdminCookie(reply, token);
  sendJson(reply, 200, { ok: true, admin: serializeAdmin(admin) });
}

async function handleAdminLogout(request, reply) {
  const token = getAdminCookieToken(request);
  const admin = getAuthenticatedAdmin(request);
  if (token) {
    statements.deleteAdminSession.run(token);
  }
  recordAuditLog("admin_logout", { actor: admin?.username || "unknown" });
  clearAdminCookie(reply);
  sendJson(reply, 200, { ok: true });
}

async function getCurrentAdmin(request, reply) {
  sendJson(reply, 200, { admin: serializeAdmin(request.admin) });
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

async function streamChatEvents(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  session.lastSeenAt = now();
  persistSession(session);
  const client = addSseClient(request, reply, { type: "chat", sessionId: session.id });
  writeSse(client, "session", { session: publicSession(session) });
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
  const shouldWaitForManualReply = consumeManualNextReply(session, "user_message");
  session.regenerateRequest = null;
  session.adminTyping = true;
  touch(session);
  recordAuditLog("user_message", { sessionId: session.id, actor: "visitor" });
  if (!shouldWaitForManualReply) {
    startLlmReply(session, { reason: "user_message" });
  }
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
  const shouldWaitForManualReply = consumeManualNextReply(session, "regenerate");
  session.regenerateRequest = {
    id: randomUUID(),
    createdAt: now(),
    previousMessageId: lastAssistant.id
  };
  session.adminTyping = true;
  touch(session);
  recordAuditLog("regenerate_request", { sessionId: session.id, actor: "visitor" });
  if (!shouldWaitForManualReply) {
    startLlmReply(session, { reason: "regenerate", excludeMessageId: lastAssistant.id });
  }
  sendJson(reply, 200, { ok: true, session: publicSession(session) });
}

async function getAdminSessions(request, reply) {
  sendJson(reply, 200, { sessions: adminSessionsSnapshot() });
}

async function streamAdminEvents(request, reply) {
  const client = addSseClient(request, reply, { type: "admin", adminId: request.admin.id });
  writeSse(client, "admin", {
    changedSessionId: null,
    sessions: adminSessionsSnapshot(),
    session: null
  });
}

async function getAdminSession(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  sendJson(reply, 200, { session: adminSessionDetail(session) });
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

async function setManualNextReply(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  const body = requestBody(request);
  session.manualNextReply = Boolean(body.enabled);
  recordAuditLog(session.manualNextReply ? "manual_next_reply_enabled" : "manual_next_reply_disabled", {
    sessionId: session.id,
    actor: request.admin?.username || "admin"
  });
  touch(session);
  sendJson(reply, 200, {
    ok: true,
    manualNextReply: session.manualNextReply,
    session: summarizeSession(session)
  });
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
  session.manualNextReply = false;
  queueReply(session, content, delayMs);
  recordAuditLog("admin_reply", {
    sessionId: session.id,
    actor: request.admin?.username || "admin",
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
  session.manualNextReply = false;
  const message = createMessage(
    "assistant",
    "我摊牌了，我可是魔丸。你以为刚才是在和大模型聊天？其实一直有人在后台手动接招。欢迎来到魔丸整蛊现场。"
  );
  session.messages.push(message);
  persistMessage(session, message);
  session.revealed = true;
  clearManualTyping(session);
  touch(session);
  recordAuditLog("reveal_prank", { sessionId: session.id, actor: request.admin?.username || "admin" });
  sendJson(reply, 201, { ok: true, revealed: true });
}

function registerRoutes(app) {
  app.get("/healthz", async (request, reply) => {
    sendJson(reply, 200, { ok: true });
  });

  app.post("/api/admin/login", handleAdminLogin);
  app.all("/api/admin/logout", handleAdminLogout);
  app.get("/api/admin/me", { preHandler: requireAdmin }, getCurrentAdmin);

  app.get("/api/chat/:sessionId", getChatSession);
  app.get("/api/chat/:sessionId/events", streamChatEvents);
  app.post("/api/chat/:sessionId/messages", postChatMessage);
  app.post("/api/chat/:sessionId/stop", stopChatGeneration);
  app.post("/api/chat/:sessionId/regenerate", requestRegenerate);

  app.get("/api/admin/sessions", { preHandler: requireAdmin }, getAdminSessions);
  app.get("/api/admin/events", { preHandler: requireAdmin }, streamAdminEvents);
  app.get("/api/admin/sessions/:sessionId", { preHandler: requireAdmin }, getAdminSession);
  app.post("/api/admin/sessions/:sessionId/typing", { preHandler: requireAdmin }, setAdminTyping);
  app.post("/api/admin/sessions/:sessionId/manual-next-reply", { preHandler: requireAdmin }, setManualNextReply);
  app.post("/api/admin/sessions/:sessionId/reply", { preHandler: requireAdmin }, sendAdminReply);
  app.post("/api/admin/sessions/:sessionId/reveal", { preHandler: requireAdmin }, revealPrank);
}

async function handleStaticRequest(request, reply) {
  const url = new URL(request.url, `http://${request.headers.host || `${config.host}:${config.port}`}`);

  if (url.pathname.startsWith("/api/")) {
    sendError(reply, 404, "接口不存在");
    return;
  }

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    redirect(reply, isAdminAuthenticated(request) ? "/admin.html" : "/admin-login.html");
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

  for (const client of sseClients) {
    if (!client.response.destroyed && !client.response.writableEnded) {
      client.response.end();
    }
  }
  sseClients.clear();
}

ensureConfiguredAdmins();
loadSessionsFromDatabase();
const cleanupTimer = setInterval(cleanupExpiredSessions, 60 * 60 * 1000);
cleanupTimer.unref();
const sseHeartbeatTimer = setInterval(() => {
  for (const client of sseClients) {
    writeSseHeartbeat(client);
  }
}, 25_000);
sseHeartbeatTimer.unref();

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
  clearInterval(sseHeartbeatTimer);
  db.close();
});
registerRoutes(app);

async function start() {
  try {
    await app.listen({ host: config.host, port: config.port });
    console.log(`魔丸 prank server is running at http://${config.host}:${config.port}`);
    console.log(`Visitor page: http://${config.host}:${config.port}/`);
    console.log(`Admin console: http://${config.host}:${config.port}/admin.html`);
    if (config.generatedAdminPassword) {
      console.log(`Generated admin account: ${config.adminUsername}`);
      console.log(`Generated admin password: ${config.adminPassword}`);
    }
    if (config.generatedCookieSecret) {
      console.log("Generated temporary cookie secret. Set COOKIE_SECRET for persistent admin logins.");
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
