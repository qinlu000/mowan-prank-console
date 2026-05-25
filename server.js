const fs = require("node:fs");
const path = require("node:path");
const { createHash, createHmac, randomUUID, scryptSync, timingSafeEqual } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fastify = require("fastify");
const WebSocket = require("ws");

loadEnvFile(path.resolve(__dirname, ".env"));

const generatedAdminPassword = randomUUID().slice(0, 12);
const configuredAdminPassword =
  process.env.ADMIN_PASSWORD || process.env.FIRST_ADMIN_PASSWORD || generatedAdminPassword;
const dashScopeApiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_TTS_API_KEY || "";
const qwenTtsMode = normalizeTtsMode(process.env.QWEN_TTS_MODE || "non_realtime");
const qwenTtsVoice = process.env.QWEN_TTS_VOICE || "";
const qwenTtsRealtimeVoice = process.env.QWEN_TTS_REALTIME_VOICE || "";

const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 5173),
  publicDir: path.resolve(__dirname, "public"),
  adminCookieName: "mowan_admin",
  visitorCookieName: "mowan_visitor_device",
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
    process.env.LLM_FALLBACK_REPLY || "我刚刚有点卡住了。你换个问法再发我一次，我继续接。",
  dashScopeApiKey,
  qwenTtsRegion: process.env.QWEN_TTS_REGION || "beijing",
  qwenTtsMode,
  qwenTtsModel: process.env.QWEN_TTS_MODEL || process.env.QWEN_TTS_CLONE_MODEL || "qwen3-tts-vc-2026-01-22",
  qwenTtsVoice,
  qwenTtsRealtimeModel:
    process.env.QWEN_TTS_REALTIME_MODEL || "qwen3-tts-vc-realtime-2026-01-15",
  qwenTtsRealtimeVoice,
  qwenTtsRealtimeControls: process.env.QWEN_TTS_REALTIME_CONTROLS === "true",
  qwenTtsSpeechRate: readNumber(process.env.QWEN_TTS_SPEECH_RATE, 1),
  qwenTtsPitchRate: readNumber(process.env.QWEN_TTS_PITCH_RATE, 1),
  qwenTtsVolume: readNumber(process.env.QWEN_TTS_VOLUME, 50),
  qwenTtsSampleRate: readNumber(process.env.QWEN_TTS_SAMPLE_RATE, 24000),
  qwenTtsTimeoutMs: readNumber(process.env.QWEN_TTS_TIMEOUT_MS, 45000),
  qwenTtsEnabled:
    process.env.QWEN_TTS_ENABLED !== "false" &&
    Boolean(dashScopeApiKey) &&
    Boolean(qwenTtsMode === "realtime" ? qwenTtsRealtimeVoice : qwenTtsVoice),
  audioDir: path.resolve(__dirname, process.env.AUDIO_DIR || "data/audio")
};

const newVisitorTitle = "新访客";
const maxVisitorConversations = 3;
const sessions = new Map();
const sseClients = new Set();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".m4a", "audio/mp4"],
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

function normalizeTtsMode(value) {
  return String(value).toLowerCase().replace(/-/g, "_") === "realtime"
    ? "realtime"
    : "non_realtime";
}

function readNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  fs.mkdirSync(config.audioDir, { recursive: true });

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
      visitor_key TEXT,
      visitor_label TEXT,
      conversation_index INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      admin_typing INTEGER NOT NULL DEFAULT 0,
      revealed INTEGER NOT NULL DEFAULT 0,
      manual_next_reply INTEGER NOT NULL DEFAULT 0,
      regenerate_request TEXT
    );

    CREATE TABLE IF NOT EXISTS visitor_devices (
      token TEXT PRIMARY KEY,
      visitor_key TEXT NOT NULL,
      visitor_label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_visitor_devices_visitor_key
      ON visitor_devices(visitor_key);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      audio_file TEXT,
      audio_status TEXT,
      audio_error TEXT,
      audio_created_at TEXT,
      audio_allowed INTEGER NOT NULL DEFAULT 0,
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
  ensureColumn(database, "sessions", "visitor_key", "TEXT");
  ensureColumn(database, "sessions", "visitor_label", "TEXT");
  ensureColumn(database, "sessions", "conversation_index", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(database, "sessions", "manual_next_reply", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "messages", "audio_file", "TEXT");
  ensureColumn(database, "messages", "audio_status", "TEXT");
  ensureColumn(database, "messages", "audio_error", "TEXT");
  ensureColumn(database, "messages", "audio_created_at", "TEXT");
  ensureColumn(database, "messages", "audio_allowed", "INTEGER NOT NULL DEFAULT 0");
  database.prepare("UPDATE sessions SET conversation_index = 1 WHERE conversation_index IS NULL").run();
  database.prepare("DELETE FROM sessions WHERE visitor_label IS NULL OR visitor_label = ''").run();
  database
    .prepare("DELETE FROM audit_logs WHERE session_id IS NOT NULL AND session_id NOT IN (SELECT id FROM sessions)")
    .run();
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_visitor_conversation
      ON sessions(visitor_key, conversation_index)
      WHERE visitor_key IS NOT NULL;
  `);

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
      id, title, visitor_key, visitor_label, conversation_index, created_at, updated_at, last_seen_at, admin_typing, revealed, manual_next_reply, regenerate_request
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      visitor_key = excluded.visitor_key,
      visitor_label = excluded.visitor_label,
      conversation_index = excluded.conversation_index,
      updated_at = excluded.updated_at,
      last_seen_at = excluded.last_seen_at,
      admin_typing = excluded.admin_typing,
      revealed = excluded.revealed,
      manual_next_reply = excluded.manual_next_reply,
      regenerate_request = excluded.regenerate_request
  `),
  upsertMessage: db.prepare(`
    INSERT INTO messages (
      id, session_id, role, content, created_at, updated_at, status, audio_file, audio_status, audio_error, audio_created_at, audio_allowed, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      updated_at = excluded.updated_at,
      status = excluded.status,
      audio_file = excluded.audio_file,
      audio_status = excluded.audio_status,
      audio_error = excluded.audio_error,
      audio_created_at = excluded.audio_created_at,
      audio_allowed = excluded.audio_allowed,
      position = excluded.position
  `),
  selectSessions: db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC"),
  selectMessages: db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY position ASC"),
  deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE updated_at < ?"),
  selectVisitorDevice: db.prepare("SELECT * FROM visitor_devices WHERE token = ?"),
  upsertVisitorDevice: db.prepare(`
    INSERT INTO visitor_devices (token, visitor_key, visitor_label, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      visitor_key = excluded.visitor_key,
      visitor_label = excluded.visitor_label,
      last_seen_at = excluded.last_seen_at
  `),
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
    status: message.status || "complete",
    audioStatus: message.audioStatus || null,
    audioUrl: message.audioFile ? `/api/audio/${encodeURIComponent(path.basename(message.audioFile))}` : null,
    audioError: message.audioError || null,
    audioCreatedAt: message.audioCreatedAt || null,
    audioAllowed: Boolean(message.audioAllowed)
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
    session.visitorKey || null,
    session.visitorLabel || null,
    session.conversationIndex || 1,
    session.createdAt,
    session.updatedAt,
    session.lastSeenAt,
    session.adminTyping ? 1 : 0,
    session.revealed ? 1 : 0,
    session.replyMode === "manual" ? 1 : 0,
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
    message.audioFile || null,
    message.audioStatus || null,
    message.audioError || null,
    message.audioCreatedAt || null,
    message.audioAllowed ? 1 : 0,
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
    visitorKey: row.visitor_key || null,
    visitorLabel: row.visitor_label || null,
    conversationIndex: row.conversation_index || 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    adminTyping: Boolean(row.admin_typing),
    revealed: Boolean(row.revealed),
    replyMode: row.manual_next_reply ? "manual" : "llm",
    regenerateRequest: parseJson(row.regenerate_request, null),
    generation: null,
    referenceGeneration: null,
    adminDraft: null,
    pendingTimers: new Set(),
    messages: statements.selectMessages.all(row.id).map((messageRow) => ({
      id: messageRow.id,
      role: messageRow.role,
      content: messageRow.content,
      createdAt: messageRow.created_at,
      updatedAt: messageRow.updated_at,
      status: messageRow.status,
      audioFile: messageRow.audio_file,
      audioStatus: messageRow.audio_status,
      audioError: messageRow.audio_error,
      audioCreatedAt: messageRow.audio_created_at,
      audioAllowed: Boolean(messageRow.audio_allowed)
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

function normalizeVisitorLabel(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function visitorKeyFromLabel(label) {
  return createHash("sha256")
    .update(`mowan-visitor-v1:${label.toLocaleLowerCase("zh-CN")}`)
    .digest("hex")
    .slice(0, 24);
}

function visitorConversationTitle(visitorLabel, conversationIndex) {
  return `${visitorLabel} · 对话 ${conversationIndex}`;
}

function sessionIdForVisitorKey(visitorKey, conversationIndex = 1) {
  return conversationIndex === 1 ? `visitor-${visitorKey}` : `visitor-${visitorKey}-${conversationIndex}`;
}

function getSession(id, options = {}) {
  if (!isValidSessionId(id)) {
    return null;
  }

  if (!sessions.has(id)) {
    const createdAt = now();
    sessions.set(id, {
      id,
      title: options.title || newVisitorTitle,
      createdAt,
      updatedAt: createdAt,
      lastSeenAt: createdAt,
      adminTyping: false,
      revealed: false,
      visitorKey: options.visitorKey || null,
      visitorLabel: options.visitorLabel || null,
      conversationIndex: options.conversationIndex || 1,
      replyMode: "llm",
      regenerateRequest: null,
      generation: null,
      referenceGeneration: null,
      adminDraft: null,
      pendingTimers: new Set(),
      messages: [
        createMessage(
          "assistant",
          "来了，我是魔丸。问题丢过来，我把这团乱火给你拆开。"
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

function getVisitorSessions(visitorKey) {
  return [...sessions.values()]
    .filter((session) => session.visitorKey === visitorKey)
    .sort((first, second) => {
      const byIndex = (first.conversationIndex || 1) - (second.conversationIndex || 1);
      return byIndex || first.createdAt.localeCompare(second.createdAt);
    });
}

function getVisitorConversation(visitorLabel, conversationIndex = 1) {
  const visitorKey = visitorKeyFromLabel(visitorLabel);
  const sessionId = sessionIdForVisitorKey(visitorKey, conversationIndex);
  const title = visitorConversationTitle(visitorLabel, conversationIndex);
  const session = getSession(sessionId, {
    title,
    visitorKey,
    visitorLabel,
    conversationIndex
  });
  if (!session) {
    return null;
  }

  const timestamp = now();
  let changed = false;
  if (session.visitorKey !== visitorKey) {
    session.visitorKey = visitorKey;
    changed = true;
  }
  if (session.visitorLabel !== visitorLabel) {
    session.visitorLabel = visitorLabel;
    changed = true;
  }
  if (session.conversationIndex !== conversationIndex) {
    session.conversationIndex = conversationIndex;
    changed = true;
  }
  if (session.title !== title) {
    session.title = title;
    changed = true;
  }

  session.lastSeenAt = timestamp;
  if (changed) {
    session.updatedAt = timestamp;
    persistSession(session);
    broadcastSessionUpdate(session);
  } else {
    persistSession(session);
  }
  return session;
}

function ensureFirstVisitorConversation(visitorLabel) {
  const visitorKey = visitorKeyFromLabel(visitorLabel);
  const existing = getVisitorSessions(visitorKey);
  return existing[0]
    ? getVisitorConversation(visitorLabel, existing[0].conversationIndex || 1)
    : getVisitorConversation(visitorLabel, 1);
}

function createVisitorConversation(visitorLabel) {
  const visitorKey = visitorKeyFromLabel(visitorLabel);
  const existing = getVisitorSessions(visitorKey);
  if (existing.length >= maxVisitorConversations) {
    return null;
  }

  const usedIndexes = new Set(existing.map((session) => session.conversationIndex || 1));
  let conversationIndex = 1;
  while (usedIndexes.has(conversationIndex) && conversationIndex <= maxVisitorConversations) {
    conversationIndex += 1;
  }
  if (conversationIndex > maxVisitorConversations) {
    return null;
  }

  return getVisitorConversation(visitorLabel, conversationIndex);
}

function touch(session) {
  session.updatedAt = now();
  persistSession(session);
  broadcastSessionUpdate(session);
}

function currentTurn(session) {
  const index = session.messages.findLastIndex((message) => message.role === "user");
  if (index < 0) {
    return null;
  }

  const reply = session.messages.slice(index + 1).find((message) => message.role === "assistant") || null;
  const completeReply = reply?.status === "complete" ? reply : null;
  const canReplace = Boolean(completeReply && session.regenerateRequest?.previousMessageId === completeReply.id);
  return {
    message: session.messages[index],
    index,
    reply,
    completeReply,
    canReply: !completeReply || canReplace,
    targetMessageId: session.regenerateRequest?.previousMessageId || reply?.id || null
  };
}

function currentReplyMessage(session) {
  return currentTurn(session)?.reply || null;
}

function currentCompleteReply(session) {
  return currentTurn(session)?.completeReply || null;
}

function canCompleteCurrentTurn(session) {
  return Boolean(currentTurn(session)?.canReply);
}

function currentReplyTargetId(session) {
  return currentTurn(session)?.targetMessageId || null;
}

function ensureReplyMessage(session, preferredMessageId = null) {
  const turn = currentTurn(session);
  if (!turn) {
    return null;
  }

  const existing = preferredMessageId
    ? turn.reply?.id === preferredMessageId
      ? turn.reply
      : null
    : turn.reply;
  if (existing) {
    existing.content = "";
    existing.status = "streaming";
    existing.updatedAt = now();
    persistMessage(session, existing);
    return existing;
  }

  const message = createMessage("assistant", "", { status: "streaming" });
  session.messages.splice(turn.index + 1, 0, message);
  persistAllMessages(session);
  return message;
}

function canRegenerate(session) {
  const reply = currentCompleteReply(session);
  return Boolean(reply && !session.regenerateRequest && !session.generation && !session.adminTyping);
}

function isVisibleGeneration(generation) {
  return Boolean(generation && (generation.type === "ai" || generation.type === "stream"));
}

function summarizeSession(session) {
  const last = session.messages[session.messages.length - 1];
  const userMessages = session.messages.filter((message) => message.role === "user");
  const isGenerating = isVisibleGeneration(session.generation);
  const canReply = canCompleteCurrentTurn(session);
  const replyMode = session.replyMode || "llm";
  return {
    id: session.id,
    title: session.title,
    visitorLabel: session.visitorLabel,
    conversationIndex: session.conversationIndex || 1,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastSeenAt: session.lastSeenAt,
    adminTyping: session.adminTyping,
    isGenerating,
    replyMode,
    canReply,
    canTakeOver: Boolean(canReply && isGenerating),
    adminDraft: session.adminDraft,
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
  const isGenerating = isVisibleGeneration(session.generation);
  const awaitingReply = Boolean(session.adminTyping && session.generation?.type !== "stream");

  return {
    id: session.id,
    title: session.title,
    visitorLabel: session.visitorLabel,
    conversationIndex: session.conversationIndex || 1,
    messages: session.messages.map(serializeMessage),
    typing: awaitingReply,
    awaitingReply,
    isGenerating,
    replyMode: session.replyMode || "llm",
    canRegenerate: canRegenerate(session),
    revealed: session.revealed
  };
}

function publicConversationSummary(session) {
  const last = session.messages[session.messages.length - 1];
  return {
    id: session.id,
    title: session.title,
    visitorLabel: session.visitorLabel,
    conversationIndex: session.conversationIndex || 1,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
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

function publicVisitorState(visitorLabel, activeSession) {
  const visitorKey = visitorKeyFromLabel(visitorLabel);
  return {
    visitor: {
      id: visitorLabel,
      label: visitorLabel
    },
    maxConversations: maxVisitorConversations,
    sessions: getVisitorSessions(visitorKey).map(publicConversationSummary),
    session: publicSession(activeSession)
  };
}

function adminSessionsSnapshot() {
  return [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summarizeSession);
}

function adminSessionDetail(session) {
  return {
    ...summarizeSession(session),
    canRegenerate: canRegenerate(session),
    messages: session.messages.map(serializeMessage)
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

function getVisitorDeviceToken(request) {
  const value = parseCookies(request).get(config.visitorCookieName);
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

function setVisitorDeviceCookie(reply, token) {
  const cookieValue = createSignedCookieValue(token);
  reply.header(
    "Set-Cookie",
    `${config.visitorCookieName}=${encodeURIComponent(cookieValue)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=15552000`
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

async function sendAudioFile(request, reply) {
  const fileName = String(request.params.fileName || "");
  if (!/^[a-zA-Z0-9_-]+\.(mp3|wav|m4a)$/i.test(fileName)) {
    sendError(reply, 404, "文件不存在");
    return;
  }

  const filePath = path.resolve(config.audioDir, fileName);
  if (!filePath.startsWith(`${config.audioDir}${path.sep}`)) {
    sendError(reply, 404, "文件不存在");
    return;
  }

  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    reply
      .code(200)
      .type(mimeTypes.get(ext) || "application/octet-stream")
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(data);
  } catch (error) {
    sendError(reply, error.code === "ENOENT" ? 404 : 500, "文件不存在");
  }
}

function qwenTtsGenerationUrl() {
  const host =
    String(config.qwenTtsRegion).toLowerCase() === "singapore"
      ? "https://dashscope-intl.aliyuncs.com"
      : "https://dashscope.aliyuncs.com";
  return `${host}/api/v1/services/aigc/multimodal-generation/generation`;
}

function qwenTtsRealtimeUrl() {
  const host =
    String(config.qwenTtsRegion).toLowerCase() === "singapore"
      ? "wss://dashscope-intl.aliyuncs.com"
      : "wss://dashscope.aliyuncs.com";
  return `${host}/api-ws/v1/realtime?model=${encodeURIComponent(config.qwenTtsRealtimeModel)}`;
}

function qwenTtsActiveModel() {
  return config.qwenTtsMode === "realtime" ? config.qwenTtsRealtimeModel : config.qwenTtsModel;
}

function audioExtensionFromResponse(response, audioUrl) {
  const type = String(response.headers.get("content-type") || "").toLowerCase();
  if (type.includes("mpeg") || type.includes("mp3")) {
    return ".mp3";
  }
  if (type.includes("mp4") || type.includes("m4a")) {
    return ".m4a";
  }
  const ext = path.extname(new URL(audioUrl).pathname).toLowerCase();
  return mimeTypes.has(ext) ? ext : ".wav";
}

async function requestQwenBatchTts(text) {
  const response = await fetch(qwenTtsGenerationUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.dashScopeApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.qwenTtsModel,
      input: {
        text,
        voice: config.qwenTtsVoice
      }
    })
  });

  const responseText = await response.text();
  const payload = parseJson(responseText, {});
  if (!response.ok) {
    const message = payload?.message || payload?.error?.message || responseText || response.statusText;
    const error = new Error(`DashScope ${response.status}: ${message}`);
    error.statusCode = response.status;
    throw error;
  }

  const audioUrl = payload?.output?.audio?.url || payload?.output?.url || payload?.url;
  if (!audioUrl) {
    throw new Error("DashScope TTS did not return an audio URL.");
  }
  return { type: "remote", url: audioUrl };
}

function qwenRealtimeSessionConfig() {
  const session = {
    voice: config.qwenTtsRealtimeVoice,
    mode: "commit",
    language_type: "Chinese",
    response_format: "pcm",
    sample_rate: config.qwenTtsSampleRate
  };

  if (config.qwenTtsRealtimeControls) {
    session.speech_rate = config.qwenTtsSpeechRate;
    session.pitch_rate = config.qwenTtsPitchRate;
    session.volume = config.qwenTtsVolume;
  }

  return session;
}

function pcm16MonoToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function requestQwenRealtimeTts(text) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let finishSent = false;
    let sawAudioDone = false;
    let timeout = null;
    const ws = new WebSocket(qwenTtsRealtimeUrl(), {
      headers: {
        Authorization: `Bearer ${config.dashScopeApiKey}`
      }
    });

    const settle = (error, audio = null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      try {
        ws.close();
      } catch {
        // Best effort cleanup after a failed realtime request.
      }
      if (error) {
        reject(error);
      } else {
        resolve(audio);
      }
    };

    const sendEvent = (event) => {
      ws.send(JSON.stringify({ event_id: randomUUID(), ...event }));
    };

    const sendFinish = () => {
      if (finishSent || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      finishSent = true;
      sendEvent({ type: "session.finish" });
    };

    timeout = setTimeout(() => {
      settle(new Error("DashScope realtime TTS timed out."));
    }, config.qwenTtsTimeoutMs);

    ws.on("open", () => {
      sendEvent({
        type: "session.update",
        session: qwenRealtimeSessionConfig()
      });
    });

    ws.on("message", (data) => {
      const textData = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      const event = parseJson(textData, null);
      if (!event) {
        return;
      }

      if (event.type === "error") {
        const message = event.error?.message || event.message || "DashScope realtime TTS error.";
        settle(new Error(message));
        return;
      }

      if (event.type === "session.updated") {
        sendEvent({ type: "input_text_buffer.append", text });
        sendEvent({ type: "input_text_buffer.commit" });
        return;
      }

      if (event.type === "response.audio.delta" && event.delta) {
        chunks.push(Buffer.from(event.delta, "base64"));
        return;
      }

      if (event.type === "response.audio.done") {
        sawAudioDone = true;
        sendFinish();
        return;
      }

      if (event.type === "response.done") {
        const status = event.response?.status;
        if (status && status !== "completed") {
          const message =
            event.response?.status_details?.error?.message ||
            event.response?.status_details?.message ||
            `DashScope realtime TTS finished with status ${status}.`;
          settle(new Error(message));
          return;
        }
        sendFinish();
        return;
      }

      if (event.type === "session.finished") {
        if (!chunks.length) {
          settle(new Error("DashScope realtime TTS did not return audio data."));
          return;
        }
        settle(null, {
          type: "buffer",
          ext: ".wav",
          bytes: pcm16MonoToWav(Buffer.concat(chunks), config.qwenTtsSampleRate)
        });
      }
    });

    ws.on("close", () => {
      if (settled) {
        return;
      }
      if (sawAudioDone && chunks.length) {
        settle(null, {
          type: "buffer",
          ext: ".wav",
          bytes: pcm16MonoToWav(Buffer.concat(chunks), config.qwenTtsSampleRate)
        });
        return;
      }
      settle(new Error("DashScope realtime TTS connection closed before audio completed."));
    });

    ws.on("error", (error) => {
      settle(error);
    });
  });
}

async function requestQwenTts(text) {
  return config.qwenTtsMode === "realtime" ? requestQwenRealtimeTts(text) : requestQwenBatchTts(text);
}

async function saveRemoteAudio(audioUrl, messageId) {
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Audio download ${response.status}: ${response.statusText}`);
  }

  const ext = audioExtensionFromResponse(response, audioUrl);
  const bytes = Buffer.from(await response.arrayBuffer());
  return saveAudioBytes(bytes, messageId, ext);
}

async function saveAudioBytes(bytes, messageId, ext) {
  const fileName = `${messageId}${ext}`;
  const filePath = path.join(config.audioDir, fileName);
  await fs.promises.mkdir(config.audioDir, { recursive: true });
  await fs.promises.writeFile(filePath, bytes);
  return fileName;
}

async function saveQwenAudio(audio, messageId) {
  if (audio.type === "remote") {
    return saveRemoteAudio(audio.url, messageId);
  }
  return saveAudioBytes(audio.bytes, messageId, audio.ext || ".wav");
}

function shouldGenerateAudio(message) {
  return Boolean(
    config.qwenTtsEnabled &&
      message.role === "assistant" &&
      message.status === "complete" &&
      message.audioAllowed &&
      message.content.trim() &&
      !message.audioFile &&
      message.audioStatus !== "generating"
  );
}

function maybeGenerateMessageAudio(session, message) {
  if (!shouldGenerateAudio(message)) {
    return false;
  }

  message.audioStatus = "generating";
  message.audioError = null;
  message.audioCreatedAt = null;
  message.updatedAt = now();
  persistMessage(session, message);
  touch(session);

  requestQwenTts(message.content)
    .then((audio) => saveQwenAudio(audio, message.id))
    .then((fileName) => {
      const current = session.messages.find((item) => item.id === message.id);
      if (!current) {
        return;
      }
      current.audioFile = fileName;
      current.audioStatus = "complete";
      current.audioError = null;
      current.audioCreatedAt = now();
      current.updatedAt = now();
      persistMessage(session, current);
      recordAuditLog("tts_audio_created", {
        sessionId: session.id,
        actor: "魔丸",
        detail: { model: qwenTtsActiveModel(), mode: config.qwenTtsMode, messageId: current.id }
      });
      touch(session);
    })
    .catch((error) => {
      const current = session.messages.find((item) => item.id === message.id);
      if (!current) {
        return;
      }
      current.audioStatus = "error";
      current.audioError = error.message;
      current.updatedAt = now();
      persistMessage(session, current);
      recordAuditLog("tts_audio_error", {
        sessionId: session.id,
        actor: "魔丸",
        detail: {
          model: qwenTtsActiveModel(),
          mode: config.qwenTtsMode,
          messageId: current.id,
          message: error.message
        }
      });
      touch(session);
    });

  return true;
}

function clearJobTimers(session, job) {
  for (const key of ["timer", "timeout"]) {
    if (job?.[key]) {
      clearTimeout(job[key]);
      session.pendingTimers.delete(job[key]);
      job[key] = null;
    }
  }
}

function stopReferenceGeneration(session) {
  if (!session.referenceGeneration) {
    return false;
  }

  session.referenceGeneration.stopped = true;
  session.referenceGeneration.abortController?.abort();
  clearJobTimers(session, session.referenceGeneration);
  session.referenceGeneration = null;
  return true;
}

function stopActiveGeneration(session, status = "stopped") {
  if (!session.generation) {
    return false;
  }

  session.generation.stopped = true;
  session.generation.abortController?.abort();
  clearJobTimers(session, session.generation);

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
      maybeGenerateMessageAudio(session, message);
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

function startStreamingReply(session, content, options = {}) {
  const message = ensureReplyMessage(session, options.messageId || null);
  if (!message) {
    session.adminTyping = false;
    touch(session);
    return false;
  }

  message.audioAllowed = Boolean(options.generateAudio);
  message.audioFile = null;
  message.audioStatus = null;
  message.audioError = null;
  message.audioCreatedAt = null;
  persistMessage(session, message);
  session.adminTyping = false;
  session.regenerateRequest = null;
  session.generation = {
    type: "stream",
    messageId: message.id,
    target: content,
    index: 0,
    timer: null,
    generateAudio: Boolean(options.generateAudio)
  };
  touch(session);
  queueStreamStep(session);
  return true;
}

function queueReply(session, content, delayMs, options = {}) {
  const finalReply = currentCompleteReply(session);
  const messageId = options.messageId || currentReplyTargetId(session);
  if (!canCompleteCurrentTurn(session)) {
    return false;
  }
  if (finalReply && finalReply.id !== messageId) {
    return false;
  }

  stopActiveGeneration(session, "stopped");
  clearAdminDraft(session);
  session.adminTyping = true;
  touch(session);

  if (delayMs <= 0) {
    return startStreamingReply(session, content, { messageId, generateAudio: options.generateAudio });
  }

  const timer = setTimeout(() => {
    session.pendingTimers.delete(timer);
    if (!session.generation || session.generation.timer !== timer) {
      return;
    }
    session.generation = null;
    startStreamingReply(session, content, { messageId, generateAudio: options.generateAudio });
  }, delayMs);

  session.generation = {
    type: "delay",
    messageId,
    target: content,
    index: 0,
    timer,
    generateAudio: Boolean(options.generateAudio)
  };
  session.pendingTimers.add(timer);
  return true;
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
    "你是魔丸，一个混世魔丸感的中文聊天助手：叛逆、混沌、有爆发力，生来就带点不正常、反骨、抽象，但真正回答问题时很靠谱。",
    "你的核心气质：不走标准客服腔，不端着，不讲空话；可以嘴硬、轻微挑衅、带点坏笑和自嘲，像一个会把局面搅开又能把问题解决的人。",
    "你可以偶尔使用短促、有梗的表达，例如“这题有点魔丸味”“别急，先把这团乱火拆开”“这破局面也不是不能打”“我偏要给它讲明白”。",
    "用户焦虑、犯迷糊或自我怀疑时，用反命运感鼓励他：承认局面麻烦，但强调可以拆、可以打、可以改。",
    "玩梗要克制：不要每句话都自称魔丸，不要中二台词机，不要过度押韵、喊口号或假装神话角色。",
    "你正在一个聊天网站里和用户对话。默认情况下，用户应该感觉自己是在和一个真实可用但很有性格的 AI 助手聊天，而不是在看角色扮演。",
    "不要主动提到后台、真人、整蛊、OpenRouter、系统提示或实现细节。",
    "回答要直接、有帮助、像中文互联网里反应很快的人一样自然。能简短解决就简短，复杂问题再分层解释。",
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

function clearAdminDraft(session) {
  stopReferenceGeneration(session);
  session.adminDraft = null;
}

function setAdminDraft(session, status, fields = {}) {
  session.adminDraft = {
    status,
    content: fields.content || "",
    error: fields.error || null,
    forUserMessageId: fields.forUserMessageId || currentTurn(session)?.message.id || null,
    updatedAt: now()
  };
}

function createLlmJob(type, options = {}) {
  return {
    type,
    abortController: new AbortController(),
    excludeMessageId: options.excludeMessageId || null,
    reason: options.reason || "auto",
    startedAt: now(),
    stopped: false,
    timedOut: false,
    timeout: null,
    ...options
  };
}

function llmAuditDetail(job, detail = {}) {
  return {
    model: config.llmModel,
    reason: job.reason,
    attempts: job.attempts || 1,
    ...detail
  };
}

function llmErrorDetail(job, error) {
  return llmAuditDetail(job, {
    timedOut: job.timedOut,
    message: error.message,
    cause: error.cause
      ? {
          name: error.cause.name,
          code: error.cause.code,
          message: error.cause.message
        }
      : null
  });
}

function runLlmJob(session, slot, job, handlers) {
  job.timeout = setTimeout(() => {
    job.timedOut = true;
    job.abortController.abort();
  }, config.llmTimeoutMs);

  session.pendingTimers.add(job.timeout);
  session[slot] = job;
  handlers.onStart?.(job);
  touch(session);

  requestLlmCompletionWithRetry(session, job)
    .then((content) => {
      if (session[slot] !== job) {
        return;
      }
      clearJobTimers(session, job);
      session[slot] = null;
      handlers.onSuccess(content, job);
    })
    .catch((error) => {
      if (session[slot] !== job || job.stopped) {
        return;
      }
      clearJobTimers(session, job);
      session[slot] = null;
      handlers.onError(error, job);
    });

  return true;
}

function startLlmReply(session, options = {}) {
  const targetMessageId = options.targetMessageId || currentReplyTargetId(session);
  const finalReply = currentCompleteReply(session);
  if (!config.llmEnabled || !canCompleteCurrentTurn(session) || (finalReply && finalReply.id !== targetMessageId)) {
    return false;
  }

  clearAdminDraft(session);
  return runLlmJob(
    session,
    "generation",
    createLlmJob("ai", {
      messageId: null,
      targetMessageId,
      excludeMessageId: options.excludeMessageId,
      reason: options.reason || "auto"
    }),
    {
      onStart: () => {
        session.adminTyping = true;
      },
      onSuccess: (content, generation) => {
        if (startStreamingReply(session, content, { messageId: generation.targetMessageId })) {
          recordAuditLog("llm_reply", {
            sessionId: session.id,
            actor: "魔丸",
            detail: llmAuditDetail(generation, { length: content.length })
          });
        }
      },
      onError: (error, generation) => {
        recordAuditLog("llm_error", {
          sessionId: session.id,
          actor: "魔丸",
          detail: llmErrorDetail(generation, error)
        });
        startStreamingReply(session, config.llmFallbackReply, { messageId: generation.targetMessageId });
      }
    }
  );
}

function startLlmReference(session, options = {}) {
  const turn = currentTurn(session);
  if (!turn?.canReply) {
    return false;
  }

  const existingDraft = session.adminDraft;
  if (
    !options.force &&
    existingDraft?.forUserMessageId === turn.message.id &&
    ["generating", "complete"].includes(existingDraft.status)
  ) {
    return true;
  }

  stopReferenceGeneration(session);

  if (!config.llmEnabled) {
    setAdminDraft(session, "unavailable", {
      error: "LLM 暂未配置，先手动写一条。",
      forUserMessageId: turn.message.id
    });
    touch(session);
    return false;
  }

  return runLlmJob(
    session,
    "referenceGeneration",
    createLlmJob("reference", {
      excludeMessageId: turn.reply?.id,
      reason: options.reason || "manual_reference",
      forUserMessageId: turn.message.id
    }),
    {
      onStart: (reference) => setAdminDraft(session, "generating", { forUserMessageId: reference.forUserMessageId }),
      onSuccess: (content, reference) => {
        setAdminDraft(session, "complete", { content, forUserMessageId: reference.forUserMessageId });
        recordAuditLog("llm_reference", {
          sessionId: session.id,
          actor: "魔丸",
          detail: llmAuditDetail(reference, { length: content.length })
        });
        touch(session);
      },
      onError: (error, reference) => {
        setAdminDraft(session, "error", {
          error: reference.timedOut ? "LLM 参考生成超时了，刷新再试。" : "LLM 参考生成失败，可以刷新再试。",
          forUserMessageId: reference.forUserMessageId
        });
        recordAuditLog("llm_reference_error", {
          sessionId: session.id,
          actor: "魔丸",
          detail: llmErrorDetail(reference, error)
        });
        touch(session);
      }
    }
  );
}

function sessionFromRequest(request, reply) {
  if (!isValidSessionId(request.params.sessionId)) {
    sendError(reply, 400, "会话 ID 无效");
    return null;
  }

  const session = sessions.get(request.params.sessionId);
  if (!session) {
    sendError(reply, 404, "请先输入访客代号");
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

function bindVisitorDevice(request, reply, visitorLabel) {
  const visitorKey = visitorKeyFromLabel(visitorLabel);
  const timestamp = now();
  let token = getVisitorDeviceToken(request);
  let existingDevice = token ? statements.selectVisitorDevice.get(token) : null;

  if (existingDevice && existingDevice.visitor_key !== visitorKey) {
    return {
      ok: false,
      status: 409,
      error: `此浏览器已绑定代号「${existingDevice.visitor_label}」，不能切换。`,
      visitorLabel: existingDevice.visitor_label
    };
  }

  if (!token || !existingDevice) {
    token = randomUUID();
  }

  statements.upsertVisitorDevice.run(token, visitorKey, visitorLabel, timestamp, timestamp);
  setVisitorDeviceCookie(reply, token);
  return { ok: true, visitorKey, token };
}

async function identifyVisitor(request, reply) {
  const body = requestBody(request);
  const visitorLabel = normalizeVisitorLabel(body.visitorId || body.id);
  if (!visitorLabel) {
    sendError(reply, 400, "请输入访客代号");
    return;
  }

  if (visitorLabel.length > 40) {
    sendError(reply, 400, "访客代号最多 40 个字符");
    return;
  }

  const device = bindVisitorDevice(request, reply, visitorLabel);
  if (!device.ok) {
    sendJson(reply, device.status, {
      error: device.error,
      visitor: { label: device.visitorLabel }
    });
    return;
  }

  const firstSession = ensureFirstVisitorConversation(visitorLabel);
  if (!firstSession) {
    sendError(reply, 400, "访客代号无效");
    return;
  }

  const requestedSessionId = String(body.sessionId || "").trim();
  const requestedSession = requestedSessionId ? sessions.get(requestedSessionId) : null;
  const visitorSessions = getVisitorSessions(device.visitorKey);
  const activeSession =
    requestedSession && requestedSession.visitorKey === device.visitorKey
      ? requestedSession
      : visitorSessions[visitorSessions.length - 1] || firstSession;

  sendJson(reply, 200, publicVisitorState(visitorLabel, activeSession));
}

async function createVisitorConversationRoute(request, reply) {
  const body = requestBody(request);
  const visitorLabel = normalizeVisitorLabel(body.visitorId || body.id);
  if (!visitorLabel) {
    sendError(reply, 400, "请输入访客代号");
    return;
  }

  if (visitorLabel.length > 40) {
    sendError(reply, 400, "访客代号最多 40 个字符");
    return;
  }

  const device = bindVisitorDevice(request, reply, visitorLabel);
  if (!device.ok) {
    sendJson(reply, device.status, {
      error: device.error,
      visitor: { label: device.visitorLabel }
    });
    return;
  }

  const session = createVisitorConversation(visitorLabel);
  if (!session) {
    sendError(reply, 409, `一个代号最多只能创建 ${maxVisitorConversations} 个对话`);
    return;
  }

  sendJson(reply, 201, publicVisitorState(visitorLabel, session));
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
  clearAdminDraft(session);
  const message = createMessage("user", content);
  session.messages.push(message);
  persistMessage(session, message);
  if (!session.visitorLabel && session.title === newVisitorTitle) {
    session.title = content.length > 28 ? `${content.slice(0, 28)}...` : content;
  }
  session.regenerateRequest = null;
  session.adminTyping = true;
  touch(session);
  recordAuditLog("user_message", { sessionId: session.id, actor: "visitor" });
  if (session.replyMode !== "manual") {
    const started = startLlmReply(session, { reason: "user_message" });
    if (!started) {
      queueReply(session, config.llmFallbackReply, 0);
    }
  } else {
    startLlmReference(session, { reason: "user_message_reference" });
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
  const currentReply = currentCompleteReply(session);
  if (!currentReply) {
    sendError(reply, 400, "还没有可重新生成的回复");
    return;
  }

  stopActiveGeneration(session, "stopped");
  clearAdminDraft(session);
  session.regenerateRequest = {
    id: randomUUID(),
    createdAt: now(),
    previousMessageId: currentReply.id
  };
  session.adminTyping = true;
  touch(session);
  recordAuditLog("regenerate_request", { sessionId: session.id, actor: "visitor" });
  if (session.replyMode !== "manual") {
    const started = startLlmReply(session, {
      reason: "regenerate",
      excludeMessageId: currentReply.id,
      targetMessageId: currentReply.id
    });
    if (!started) {
      queueReply(session, config.llmFallbackReply, 0, { messageId: currentReply.id });
    }
  } else {
    startLlmReference(session, { reason: "regenerate_reference", force: true });
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

async function setReplyMode(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  const body = requestBody(request);
  const mode = String(body.mode || "").trim();
  if (!["llm", "manual"].includes(mode)) {
    sendError(reply, 400, "回复模式无效");
    return;
  }

  session.replyMode = mode;
  recordAuditLog("reply_mode_changed", {
    sessionId: session.id,
    actor: request.admin?.username || "admin",
    detail: { mode }
  });
  touch(session);
  sendJson(reply, 200, {
    ok: true,
    replyMode: session.replyMode,
    session: summarizeSession(session)
  });
}

async function requestAdminReference(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  if (session.replyMode !== "manual") {
    sendError(reply, 409, "先接管当前问题，或者把会话切到人工模式。");
    return;
  }

  if (!canCompleteCurrentTurn(session)) {
    sendError(reply, 409, "当前没有可接管的问题，或者这个问题已经回复过了。");
    return;
  }

  const started = startLlmReference(session, { reason: "admin_reference", force: true });
  if (!started && session.adminDraft?.status !== "unavailable") {
    sendError(reply, 503, "LLM 参考暂时生成不了。");
    return;
  }

  sendJson(reply, started ? 202 : 200, {
    ok: true,
    generating: started,
    session: adminSessionDetail(session)
  });
}

async function takeOverCurrentTurn(request, reply) {
  const session = sessionFromRequest(request, reply);
  if (!session) {
    return;
  }

  if (!canCompleteCurrentTurn(session)) {
    sendError(reply, 409, "当前没有可接管的问题，或者这个问题已经回复过了。");
    return;
  }

  session.replyMode = "manual";
  stopActiveGeneration(session, "stopped");
  session.adminTyping = true;
  const referenceStarted = startLlmReference(session, { reason: "admin_takeover_reference", force: true });
  recordAuditLog("admin_takeover", {
    sessionId: session.id,
    actor: request.admin?.username || "admin",
    detail: { referenceStarted }
  });
  if (!referenceStarted) {
    touch(session);
  }

  sendJson(reply, 200, {
    ok: true,
    referenceStarted,
    session: adminSessionDetail(session)
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
  const queued = queueReply(session, content, delayMs, {
    messageId: currentReplyTargetId(session),
    generateAudio: true
  });
  if (!queued) {
    sendError(reply, 409, "这个问题已经有回复了，不能再补第二条。");
    return;
  }
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
  clearAdminDraft(session);
  const message = createMessage("assistant", "你个呆瓜，我可不是AI！", { audioAllowed: true });
  session.messages.push(message);
  persistMessage(session, message);
  maybeGenerateMessageAudio(session, message);
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

  app.post("/api/visitor/identify", identifyVisitor);
  app.post("/api/visitor/conversations", createVisitorConversationRoute);
  app.get("/api/chat/:sessionId", getChatSession);
  app.get("/api/chat/:sessionId/events", streamChatEvents);
  app.post("/api/chat/:sessionId/messages", postChatMessage);
  app.post("/api/chat/:sessionId/stop", stopChatGeneration);
  app.post("/api/chat/:sessionId/regenerate", requestRegenerate);
  app.get("/api/audio/:fileName", sendAudioFile);

  app.get("/api/admin/sessions", { preHandler: requireAdmin }, getAdminSessions);
  app.get("/api/admin/events", { preHandler: requireAdmin }, streamAdminEvents);
  app.get("/api/admin/sessions/:sessionId", { preHandler: requireAdmin }, getAdminSession);
  app.post("/api/admin/sessions/:sessionId/typing", { preHandler: requireAdmin }, setAdminTyping);
  app.post("/api/admin/sessions/:sessionId/reply-mode", { preHandler: requireAdmin }, setReplyMode);
  app.post("/api/admin/sessions/:sessionId/takeover", { preHandler: requireAdmin }, takeOverCurrentTurn);
  app.post("/api/admin/sessions/:sessionId/reference", { preHandler: requireAdmin }, requestAdminReference);
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
