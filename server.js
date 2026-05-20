const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 5173);
const publicDir = path.resolve(__dirname, "public");

const sessions = new Map();

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

function createMessage(role, content) {
  return {
    id: randomUUID(),
    role,
    content: String(content).trim(),
    createdAt: now()
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
      title: "新访客",
      createdAt,
      updatedAt: createdAt,
      lastSeenAt: createdAt,
      adminTyping: false,
      revealed: false,
      pendingTimers: new Set(),
      messages: [
        createMessage(
          "assistant",
          "你好，我是 AstraChat。把你的问题交给我，我会尽量给出清晰、直接的回答。"
        )
      ]
    });
  }

  return sessions.get(id);
}

function touch(session) {
  session.updatedAt = now();
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
    revealed: session.revealed,
    messageCount: session.messages.length,
    userMessageCount: userMessages.length,
    lastMessage: last
      ? {
          role: last.role,
          content: last.content,
          createdAt: last.createdAt
        }
      : null
  };
}

function publicSession(session) {
  return {
    id: session.id,
    title: session.title,
    messages: session.messages,
    typing: session.adminTyping,
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
  const match = pathname.match(/^\/api\/chat\/([^/]+)(?:\/messages)?$/);
  if (!match) {
    return null;
  }

  return {
    sessionId: match[1],
    isMessagesPath: pathname.endsWith("/messages")
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

  if (req.method === "GET" && !chatPath.isMessagesPath) {
    sendJson(res, 200, publicSession(session));
    return;
  }

  if (req.method === "POST" && chatPath.isMessagesPath) {
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

    session.messages.push(createMessage("user", content));
    if (session.title === "新访客") {
      session.title = content.length > 28 ? `${content.slice(0, 28)}...` : content;
    }
    session.adminTyping = false;
    touch(session);
    sendJson(res, 201, publicSession(session));
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
        messages: session.messages
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
    if (delayMs > 0) {
      session.adminTyping = true;
      touch(session);
      const timer = setTimeout(() => {
        session.pendingTimers.delete(timer);
        session.messages.push(createMessage("assistant", content));
        session.adminTyping = false;
        touch(session);
      }, delayMs);
      session.pendingTimers.add(timer);
      sendJson(res, 202, { ok: true, queued: true, delayMs });
      return;
    }

    session.messages.push(createMessage("assistant", content));
    session.adminTyping = false;
    touch(session);
    sendJson(res, 201, { ok: true, session: summarizeSession(session) });
    return;
  }

  if (adminPath.action === "reveal") {
    session.messages.push(
      createMessage(
        "assistant",
        "摊牌了：这个聊天窗口背后不是大模型，是有人在后台手动回复你。你刚刚参与了一个 LLM 网站整蛊实验。"
      )
    );
    session.revealed = true;
    session.adminTyping = false;
    touch(session);
    sendJson(res, 201, { ok: true, revealed: true });
    return;
  }

  sendError(res, 404, "接口不存在");
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);

  try {
    if (url.pathname.startsWith("/api/chat/")) {
      await handleChatApi(req, res, url.pathname);
      return;
    }

    if (url.pathname.startsWith("/api/admin/")) {
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
  console.log(`AstraChat prank server is running at http://${host}:${port}`);
  console.log(`Visitor page: http://${host}:${port}/`);
  console.log(`Admin console: http://${host}:${port}/admin.html`);
});

process.on("SIGINT", () => {
  for (const session of sessions.values()) {
    for (const timer of session.pendingTimers) {
      clearTimeout(timer);
    }
  }
  server.close(() => process.exit(0));
});
