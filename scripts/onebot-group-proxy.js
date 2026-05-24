const path = require("path");
const fs = require("fs");
const { execFile, execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const { createHealthSnapshot, startHealthServer } = require("./lib/proxy-health");
const { loadProxyState, saveProxyState } = require("./lib/proxy-state");
const { createProxyCommands } = require("./lib/proxy-commands");
const { createProxyFiles } = require("./lib/proxy-files");
const { appendRecentError, readRecentErrors } = require("./lib/recent-errors");
const { createCapabilitySnapshot, readCapabilitySnapshot, writeCapabilitySnapshot } = require("./lib/capabilities");
const { addFileIndex } = require("./lib/file-index");
const { maskSensitive } = require("./lib/sensitive-redaction");

let WebSocket;
try {
  WebSocket = require("ws");
} catch {
  const wsPath = path.join(
    __dirname,
    "..",
    "tools",
    "NapCat.Shell.Windows.OneKey",
    "NapCat.44498.Shell",
    "versions",
    "9.9.26-44498",
    "resources",
    "app",
    "napcat",
    "node_modules",
    "ws"
  );
  WebSocket = require(wsPath);
}

const ADMIN_ROOT_USERS = (process.env.ONEBOT_ADMIN_ROOT_USERS || "1602858215")
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const LISTEN_PORTS = (process.env.ONEBOT_PROXY_PORTS || process.env.ONEBOT_PROXY_PORT || "3002,3003,3005,3006,3007,3008,3009,3011")
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const UPSTREAM_URL = process.env.ONEBOT_UPSTREAM_URL || "ws://127.0.0.1:3001";
const ALLOWED_GROUPS = (process.env.ONEBOT_ALLOWED_GROUPS || process.env.ONEBOT_ALLOWED_GROUP || "1107099585,171290904")
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const ALLOWED_PRIVATE_USERS = (process.env.ONEBOT_ALLOWED_PRIVATE_USERS || "2138730775,1062205964,1544590696,3367803151,1602858215")
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const ADMIN_USERS = (process.env.ONEBOT_ADMIN_USERS || ADMIN_ROOT_USERS.join(","))
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const ADMIN_POKE_ACK_USERS = (process.env.ONEBOT_ADMIN_POKE_ACK_USERS || ADMIN_ROOT_USERS.join(","))
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const AT_ONLY_GROUPS = (process.env.ONEBOT_AT_ONLY_GROUPS || "171290904")
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const LISTEN_PORT = Number(process.env.ONEBOT_LISTEN_PORT || 3002);
const AT_PORT = Number(process.env.ONEBOT_AT_PORT || 3003);
const GROUP_ROUTES = parseGroupRoutes(process.env.ONEBOT_GROUP_ROUTES);
const PRIVATE_ROUTES = parsePrivateRoutes(process.env.ONEBOT_PRIVATE_ROUTES);
const ACK_EMOJI_ID = String(process.env.ONEBOT_ACK_EMOJI_ID || "76");
const LISTEN_RELEASE_DELAY_MS = Number(process.env.ONEBOT_LISTEN_RELEASE_DELAY_MS || 1500);
const LISTEN_BUSY_TIMEOUT_MS = Number(process.env.ONEBOT_LISTEN_BUSY_TIMEOUT_MS || 180000);
const HEALTH_HOST = process.env.ONEBOT_HEALTH_HOST || "127.0.0.1";
const HEALTH_PORT = Number(process.env.ONEBOT_HEALTH_PORT || 3010);
const OUTGOING_RETRY_MAX = Math.max(0, Number(process.env.ONEBOT_OUTGOING_RETRY_MAX || 2));
const OUTGOING_RESPONSE_TIMEOUT_MS = Math.max(1000, Number(process.env.ONEBOT_OUTGOING_RESPONSE_TIMEOUT_MS || 12000));
const OUTGOING_RETRY_BASE_DELAY_MS = Math.max(200, Number(process.env.ONEBOT_OUTGOING_RETRY_BASE_DELAY_MS || 1200));
const WORKSPACE_ROOT = process.env.ONEBOT_WORKSPACE_ROOT || path.join(__dirname, "..", "groups");
const PROXY_STATE_FILE = process.env.ONEBOT_PROXY_STATE_FILE || path.join(path.dirname(WORKSPACE_ROOT), ".cc-connect", "onebot-proxy-state.json");
const RUNTIME_DIR = process.env.ONEBOT_RUNTIME_DIR || path.join(path.dirname(WORKSPACE_ROOT), ".cc-connect");
const RECENT_ERROR_FILE = process.env.ONEBOT_RECENT_ERROR_FILE || path.join(RUNTIME_DIR, "recent-errors.jsonl");
const CAPABILITY_FILE = process.env.ONEBOT_CAPABILITY_FILE || path.join(RUNTIME_DIR, "capabilities.json");
const RENDER_SCRIPT = process.env.ONEBOT_RENDER_SCRIPT || path.join(__dirname, "render-qq-card.ps1");
const RENDER_IMAGEMAGICK_SCRIPT = process.env.ONEBOT_RENDER_IMAGEMAGICK_SCRIPT || path.join(__dirname, "render-qq-card-imagemagick.js");
const DREAM_COMMAND_ENABLED = !["0", "false", "no"].includes(String(process.env.ONEBOT_DREAM_COMMAND_ENABLED || "1").toLowerCase());
const DREAM_TRIGGERS = (process.env.ONEBOT_DREAM_TRIGGERS || "/dream,做梦")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const IMAGE_COMMAND_ENABLED = !["0", "false", "no"].includes(String(process.env.ONEBOT_IMAGE_COMMAND_ENABLED || "1").toLowerCase());
const IMAGE_TRIGGERS = (process.env.ONEBOT_IMAGE_TRIGGERS || "/画图,/生图,/img,画图,生图")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const IMAGE_SCRIPT = process.env.ONEBOT_IMAGE_SCRIPT || path.join(__dirname, "generate-image.js");
const IMAGE_MAX_CONCURRENT_PER_GROUP = Math.max(1, Number(process.env.ONEBOT_IMAGE_MAX_CONCURRENT_PER_GROUP || 2));
const IMAGE_QUEUE_MAX_PER_GROUP = Math.max(0, Number(process.env.ONEBOT_IMAGE_QUEUE_MAX_PER_GROUP || 20));
const LISTEN_TRIGGER_MODE = String(process.env.ONEBOT_LISTEN_TRIGGER_MODE || "selective").toLowerCase();
const LISTEN_TRIGGER_KEYWORDS = (process.env.ONEBOT_LISTEN_TRIGGER_KEYWORDS || [
  "bot", "机器人", "助手", "codex", "qqbot", "qq bot",
  "帮我", "帮忙", "可以帮", "求助", "看看这个", "看一下这个", "分析一下", "总结一下", "给个建议",
  "报错", "错误", "失败", "修一下", "改一下", "代码", "脚本", "python", "公式", "推导",
  "实验报告", "作业题", "题目", "文件", "论文", "pdf"
].join(","))
  .split(",")
  .map((p) => p.trim().toLowerCase())
  .filter(Boolean);
const GROUP_TRIGGER_KEYWORD_FILE = process.env.ONEBOT_GROUP_TRIGGER_KEYWORD_FILE || "trigger_keywords.txt";
const PROFILE_REPLY_MARKERS = (process.env.ONEBOT_PROFILE_REPLY_MARKERS || "触发回复,需要回复,关注点,未解决,重要信息")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const SILENCED_OUTGOING_PATTERNS = [
  "因空闲超过 30 分钟，已自动切换到新会话",
  "正在结束上一个会话",
  "新会话将自动启动"
];
let upstream = null;
const clients = new Map();
let upstreamReady = false;
const pending = [];
const listenStates = new Map();
const activeTriggers = new Map();
const pendingFileDownloads = new Map();
const pendingEchoPorts = new Map();
const pendingBotReplies = new Map();
const pendingOutbound = new Map();
const botReplyRoutes = new Map();
const dreamStates = new Map();
const imageStates = new Map();
const quietUntilByGroup = new Map();
const listenModeByGroup = new Map();
let proxyCommands = null;
let proxyFiles = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args.map(maskSensitive));
}

function recordError(kind, message, extra = {}) {
  appendRecentError({
    file: RECENT_ERROR_FILE,
    maskSensitive,
    event: {
      kind,
      message: maskSensitive(message),
      ...extra
    }
  });
}

function maskID(value) {
  const s = String(value);
  if (s.length <= 5) {
    return s;
  }
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function persistProxyState() {
  saveProxyState({
    file: PROXY_STATE_FILE,
    listenModes: listenModeByGroup,
    quietUntil: quietUntilByGroup,
    log
  });
}

function getProxyCommands() {
  if (!proxyCommands) {
    proxyCommands = createProxyCommands({
      messageText,
      sendPrivateText,
      sendGroupText,
      healthSnapshot,
      imageStateKey,
      imageStates,
      effectiveListenMode,
      defaultListenMode: LISTEN_TRIGGER_MODE,
      atOnlyGroups: AT_ONLY_GROUPS,
      isGroupQuiet,
      adminUsers: ADMIN_USERS,
      adminRootUsers: ADMIN_ROOT_USERS,
      allowedGroups: ALLOWED_GROUPS,
      allowedPrivateUsers: ALLOWED_PRIVATE_USERS,
      workspaceForGroup,
      workspaceForPrivateUser,
      executionWorkspaceForPrivateUser,
      projectRoot: path.dirname(WORKSPACE_ROOT),
      ensureGroupProfile,
      ensurePrivateProfile,
      appendLine,
      memberProfilePath,
      removeLinesContaining,
      todayLocal,
      quietUntilByGroup,
      persistProxyState,
      pending,
      pendingOutbound,
      pendingFileDownloads,
      listenStates,
      botReplyRoutes,
      listenModeByGroup,
      maskSensitive,
      recentErrorFile: RECENT_ERROR_FILE,
      capabilitySnapshot: () => readCapabilitySnapshot(CAPABILITY_FILE),
      groupRoutes: GROUP_ROUTES,
      privateRoutes: PRIVATE_ROUTES,
      adminLogFiles: {
        onebot: process.env.ONEBOT_PROXY_LOG || "/var/log/onebot-group-proxy.log",
        ccconnect: process.env.CC_CONNECT_QQ_LOG || "/var/log/cc-connect-qq.log"
      },
      reloadRuntime
    });
  }
  return proxyCommands;
}

function getProxyFiles() {
  if (!proxyFiles) {
    proxyFiles = createProxyFiles({
      workspaceForGroup,
      appendLine,
      todayLocal,
      pendingFileDownloads,
      sendUpstream,
      sendGroupText,
      safeName,
      ensureDir,
      extractPdfText,
      buildFileSummary,
      recordError,
      log
    });
  }
  return proxyFiles;
}

function sendUpstream(obj) {
  const raw = JSON.stringify(obj);
  if (upstream && upstream.readyState === WebSocket.OPEN && upstreamReady) {
    upstream.send(raw);
  } else {
    pending.push(raw);
  }
}

function trackPendingOutbound(obj, sourcePort, kind) {
  if (!obj || typeof obj.echo !== "string" || !obj.echo) {
    return;
  }
  clearPendingOutbound(obj.echo);
  const entry = {
    obj,
    sourcePort,
    kind,
    attempts: 0,
    startedAt: Date.now(),
    timer: null
  };
  entry.timer = setTimeout(() => retryOutbound(obj.echo, "timeout"), OUTGOING_RESPONSE_TIMEOUT_MS);
  pendingOutbound.set(obj.echo, entry);
}

function clearPendingOutbound(echo) {
  const entry = pendingOutbound.get(echo);
  if (entry && entry.timer) {
    clearTimeout(entry.timer);
  }
  pendingOutbound.delete(echo);
}

function retryOutbound(echo, reason) {
  const entry = pendingOutbound.get(echo);
  if (!entry) {
    return false;
  }
  clearPendingOutbound(echo);
  pendingEchoPorts.delete(echo);
  pendingBotReplies.delete(echo);
  if (entry.attempts >= OUTGOING_RETRY_MAX) {
    log("outgoing retry exhausted", "kind", entry.kind, "echo", echo, "reason", reason);
    recordError("outgoing", `retry exhausted: ${reason}`, { scope: entry.kind, target: String(entry.sourcePort || "") });
    return false;
  }

  const nextEcho = `${echo}_retry${entry.attempts + 1}_${Date.now()}`;
  const next = { ...entry.obj, echo: nextEcho };
  const delay = OUTGOING_RETRY_BASE_DELAY_MS * Math.pow(2, entry.attempts);
  pendingEchoPorts.set(nextEcho, entry.sourcePort);
  if (entry.kind === "group") {
    const groupID = outgoingGroupID(next);
    if (ALLOWED_GROUPS.includes(groupID)) {
      pendingBotReplies.set(nextEcho, { groupID, port: entry.sourcePort, ts: Date.now() });
    }
  }
  trackPendingOutbound(next, entry.sourcePort, entry.kind);
  const tracked = pendingOutbound.get(nextEcho);
  if (tracked) {
    tracked.attempts = entry.attempts + 1;
  }
  setTimeout(() => {
    log("outgoing retry", "kind", entry.kind, "echo", nextEcho, "attempt", entry.attempts + 1, "reason", reason);
    sendUpstream(next);
  }, delay);
  return true;
}

function responseOK(resp) {
  return resp && (resp.status === "ok" || resp.retcode === 0);
}

function responseErrorText(resp) {
  return (resp && (resp.message || resp.wording || resp.status)) || "";
}

function flushPending() {
  while (pending.length && upstream && upstream.readyState === WebSocket.OPEN && upstreamReady) {
    upstream.send(pending.shift());
  }
}

function parseGroupRoutes(raw) {
  const routes = new Map();
  const source = raw || ALLOWED_GROUPS.map((groupID, index) => {
    const base = index === 0 ? LISTEN_PORT : LISTEN_PORT + index * 2;
    if (AT_ONLY_GROUPS.includes(Number(groupID))) {
      return `${groupID}::${base + 1}`;
    }
    return `${groupID}:${base}:${base + 1}`;
  }).join(",");

  source.split(",").map((p) => p.trim()).filter(Boolean).forEach((item) => {
    const [groupIDRaw, listenPortRaw, atPortRaw] = item.split(":").map((p) => p.trim());
    const groupID = Number(groupIDRaw);
    const listenPort = listenPortRaw ? Number(listenPortRaw) : null;
    const atPort = Number(atPortRaw);
    if (groupID && atPort && (listenPort === null || listenPort)) {
      routes.set(groupID, { listenPort, atPort });
    }
  });
  return routes;
}

function parsePrivateRoutes(raw) {
  const routes = new Map();
  const source = raw || ALLOWED_PRIVATE_USERS.map((userID, index) => {
    if (ADMIN_ROOT_USERS.includes(Number(userID))) {
      return `${userID}:3011`;
    }
    const port = 3006 + index;
    return `${userID}:${port}`;
  }).join(",");

  source.split(",").map((p) => p.trim()).filter(Boolean).forEach((item) => {
    const [userID, port] = item.split(":").map((p) => Number(p.trim()));
    if (userID && port) {
      routes.set(userID, { port });
    }
  });
  return routes;
}

function connectUpstream() {
  upstreamReady = false;
  upstream = new WebSocket(UPSTREAM_URL);

  upstream.on("open", () => {
    upstreamReady = true;
    log("upstream connected", UPSTREAM_URL);
    refreshCapabilities();
    flushPending();
  });

  upstream.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (typeof msg.echo === "string" && msg.echo.startsWith("__ack_")) {
      return;
    }
    if (typeof msg.echo === "string" && msg.echo.startsWith("__poke_")) {
      return;
    }
    if (typeof msg.echo === "string" && msg.echo.startsWith("__file_")) {
      handleFileDownloadResponse(msg);
      return;
    }
    if (typeof msg.echo === "string" && msg.echo.startsWith("__upload_")) {
      return;
    }
    if (typeof msg.echo === "string" && msg.echo.startsWith("__dream_")) {
      return;
    }
    if (typeof msg.echo === "string" && msg.echo.startsWith("__image_")) {
      handleImageSendResponse(msg);
      return;
    }
    if (typeof msg.echo === "string" && pendingBotReplies.has(msg.echo)) {
      handleBotReplyResponse(msg);
      return;
    }
    if (typeof msg.echo === "string" && pendingEchoPorts.has(msg.echo)) {
      const port = pendingEchoPorts.get(msg.echo);
      pendingEchoPorts.delete(msg.echo);
      if (!responseOK(msg) && retryOutbound(msg.echo, `response:${msg.retcode || responseErrorText(msg)}`)) {
        return;
      }
      clearPendingOutbound(msg.echo);
      dispatchToPort(port, msg);
      return;
    }

    const isAllowedGroupMessage = msg.post_type === "message" && msg.message_type === "group";
    const isPrivateMessage = msg.post_type === "message" && msg.message_type === "private";
    const isAllowedGroupNotice = msg.post_type === "notice" && ALLOWED_GROUPS.includes(Number(msg.group_id));
    const isAllowedPrivateNotice = msg.post_type === "notice" && ALLOWED_PRIVATE_USERS.includes(Number(msg.user_id));
    if (isAllowedGroupNotice && msg.notice_type === "group_upload") {
      handleGroupUpload(msg);
      return;
    }
    if (isAllowedPrivateNotice && msg.notice_type === "offline_file") {
      handlePrivateFileNotice(msg);
      return;
    }

    if (isAllowedGroupMessage) {
      if (!ALLOWED_GROUPS.includes(Number(msg.group_id))) {
        log("drop group", msg.group_id, "msg", msg.message_id);
        return;
      }
      recordGroupMessage(msg);
      adminPokeAck(msg);
      if (isProxyCommand(msg)) {
        handleProxyCommand(msg);
        return;
      }
      if (isDreamCommand(msg)) {
        handleDreamCommand(msg);
        return;
      }
      if (isImageCommand(msg)) {
        handleImageCommand(msg);
        return;
      }
    }

    if (isAllowedGroupMessage) {
      const route = routeForGroup(msg.group_id);
      const targetPort = routedReplyPort(msg) || (isAtMessage(msg) ? route.atPort : route.listenPort);
      if (targetPort === route.listenPort) {
        if (isGroupQuiet(msg.group_id)) {
          log("skip listen", "group", msg.group_id, "msg", msg.message_id, "reason", "quiet");
          return;
        }
        if (shouldDispatchListenMessage(msg)) {
          handleListenMessage(msg);
        } else {
          log("skip listen", "group", msg.group_id, "msg", msg.message_id, "reason", "selective");
        }
      } else {
        ackMessage(msg);
        dispatchToPort(targetPort, msg);
      }
      return;
    }

    if (isPrivateMessage) {
      const userID = Number(msg.user_id);
      const route = routeForPrivateUser(userID);
      if (!route || !ALLOWED_PRIVATE_USERS.includes(userID)) {
        log("drop private", userID, "msg", msg.message_id);
        return;
      }
      recordPrivateMessage(msg);
      adminPokeAck(msg);
      if (isProxyCommand(msg)) {
        ackMessage(msg);
        handleProxyCommand(msg);
        return;
      }
      if (isImageCommand(msg)) {
        handleImageCommand(msg);
        return;
      }
      enrichPrivatePdfMessage(msg);
      ackMessage(msg);
      activeTriggers.set(triggerKey(route.port, userID), Number(msg.message_id));
      dispatchToPort(route.port, msg);
      return;
    }

    dispatchToPort(isAtMessage(msg) ? AT_PORT : LISTEN_PORT, msg);
  });

  upstream.on("close", () => {
    upstreamReady = false;
    log("upstream closed; reconnecting");
    refreshCapabilities();
    setTimeout(connectUpstream, 2000);
  });

  upstream.on("error", (err) => {
    log("upstream error", err.message);
    recordError("upstream", err.message);
  });
}

function routeForGroup(groupID) {
  return GROUP_ROUTES.get(Number(groupID)) || { listenPort: LISTEN_PORT, atPort: AT_PORT };
}

function routeForPrivateUser(userID) {
  return PRIVATE_ROUTES.get(Number(userID));
}

function shouldDispatchListenMessage(msg) {
  if (AT_ONLY_GROUPS.includes(Number(msg.group_id))) {
    return false;
  }
  const mode = effectiveListenMode(msg.group_id);
  if (mode === "all" || mode === "aggressive") {
    return true;
  }
  if (mode === "mention" || mode === "at" || mode === "off" || mode === "none") {
    return false;
  }
  if (routedReplyPort(msg) || isAtMessage(msg)) {
    return true;
  }

  const text = messageText(msg).trim();
  if (!text || text === "[非文本消息]") {
    return false;
  }
  const lower = text.toLowerCase();
  if (allListenKeywords(msg).some((keyword) => lower.includes(keyword))) {
    return true;
  }
  return profileWantsReply(msg, text);
}

function effectiveListenMode(groupID) {
  if (AT_ONLY_GROUPS.includes(Number(groupID))) {
    return "mention";
  }
  return listenModeByGroup.get(Number(groupID)) || LISTEN_TRIGGER_MODE;
}

function allListenKeywords(msg) {
  return [...LISTEN_TRIGGER_KEYWORDS, ...groupListenKeywords(msg.group_id)];
}

function groupListenKeywords(groupID) {
  const file = path.join(workspaceForGroup(groupID), GROUP_TRIGGER_KEYWORD_FILE);
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim().toLowerCase())
    .filter(Boolean);
}

function profileWantsReply(msg, text) {
  const file = memberProfilePath(msg);
  if (!file || !fs.existsSync(file)) {
    return false;
  }
  const profile = fs.readFileSync(file, "utf8");
  const markedLines = profile.split(/\r?\n/).filter((line) =>
    PROFILE_REPLY_MARKERS.some((marker) => line.includes(marker))
  );
  if (markedLines.length === 0) {
    return false;
  }
  const normalized = String(text || "").toLowerCase();
  return markedLines.some((line) =>
    profileLineKeywords(line).some((keyword) => keyword.length >= 2 && normalized.includes(keyword.toLowerCase()))
  );
}

function profileLineKeywords(line) {
  return String(line || "")
    .replace(/[#*`\-:：，。；;、()[\]{}]/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part && !PROFILE_REPLY_MARKERS.includes(part));
}

function routedReplyPort(msg) {
  const replyID = replyTargetID(msg);
  if (!replyID) {
    return null;
  }
  const route = botReplyRoutes.get(botReplyKey(msg.group_id, replyID));
  if (!route) {
    return null;
  }
  log("route reply", "group", msg.group_id, "reply_to", replyID, "port", route.port);
  return route.port;
}

function replyTargetID(msg) {
  const segments = Array.isArray(msg.message) ? msg.message : [];
  for (const seg of segments) {
    if (seg && seg.type === "reply" && seg.data) {
      const id = seg.data.id || seg.data.message_id;
      if (id !== undefined && id !== null) {
        return Number(id);
      }
    }
  }
  if (msg.reply && (msg.reply.message_id || msg.reply.id)) {
    return Number(msg.reply.message_id || msg.reply.id);
  }
  return null;
}

function botReplyKey(groupID, messageID) {
  return `${Number(groupID)}:${Number(messageID)}`;
}

function dispatchToPort(port, msg) {
  const target = clients.get(port);
  if (!target || target.readyState !== WebSocket.OPEN) {
    log("drop no client", port, "msg", msg.message_id || "");
    return false;
  }
  if (msg.post_type === "message" && msg.message_type === "group") {
    activeTriggers.set(triggerKey(port, msg.group_id), Number(msg.message_id));
  }
  target.send(JSON.stringify(enrichMessageForAgent(msg)));
  return true;
}

function enrichMessageForAgent(msg) {
  if (!msg || msg.post_type !== "message") {
    return msg;
  }
  const normalized = normalizeVisualMessage(msg);
  const context = profileContextForMessage(msg);
  if (!context) {
    return normalized;
  }
  const original = messageText(normalized);
  const enrichedText = [
    "【QQ上下文，仅供回复参考，不要复述】",
    context,
    "",
    "【用户消息】"
  ].join("\n");
  const originalSegments = Array.isArray(normalized.message) && normalized.message.length > 0
    ? normalized.message
    : [{ type: "text", data: { text: original } }];
  return {
    ...normalized,
    raw_message: `${enrichedText}\n${original}`.trim(),
    message: [
      { type: "text", data: { text: `${enrichedText}\n` } },
      ...originalSegments
    ]
  };
}

function normalizeVisualMessage(msg) {
  if (!msg || msg.post_type !== "message") {
    return msg;
  }
  const segments = messageSegments(msg);
  if (segments.length === 0) {
    return msg;
  }
  let nextSegments = normalizeVisualSegments(segments);
  const quoted = quotedVisualSegments(msg);
  if (quoted.length > 0 && !hasVisualSegment(nextSegments)) {
    nextSegments = [
      ...nextSegments,
      { type: "text", data: { text: "\n【引用图片/表情】" } },
      ...quoted
    ];
  }
  return {
    ...msg,
    message: nextSegments,
    raw_message: messageTextFromSegments(nextSegments) || msg.raw_message || ""
  };
}

function normalizeVisualSegments(segments) {
  const result = [];
  for (const seg of segments || []) {
    if (!seg || !seg.type) {
      continue;
    }
    if (seg.type === "image") {
      result.push(normalizeImageSegment(seg));
      continue;
    }
    if (seg.type === "mface" || seg.type === "marketface" || seg.type === "bface") {
      const image = imageSegmentFromData(seg.data);
      if (image) {
        const summary = stickerSummary(seg);
        if (summary) {
          result.push({ type: "text", data: { text: summary } });
        }
        result.push(image);
      } else {
        result.push({ type: "text", data: { text: stickerSummary(seg) || "[表情包]" } });
      }
      continue;
    }
    if (seg.type === "face") {
      result.push({ type: "text", data: { text: faceSummary(seg) } });
      continue;
    }
    result.push(seg);
  }
  return result;
}

function normalizeImageSegment(seg) {
  const data = { ...(seg.data || {}) };
  const source = data.url || data.file || data.path;
  if (source) {
    data.file = source;
  }
  return { ...seg, data };
}

function imageSegmentFromData(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const source = data.url || data.file || data.path || data.image || data.image_url || data.preview || data.thumb;
  if (!source) {
    return null;
  }
  return { type: "image", data: { ...data, file: source } };
}

function quotedVisualSegments(msg) {
  const reply = msg && msg.reply;
  if (!reply) {
    return [];
  }
  const segments = messageSegments(reply);
  if (segments.length > 0) {
    return normalizeVisualSegments(segments).filter((seg) => seg.type !== "reply");
  }
  if (typeof reply.raw_message === "string" && /\[CQ:(image|mface|face|bface|marketface)\b/i.test(reply.raw_message)) {
    return [{ type: "text", data: { text: cqVisualSummary(reply.raw_message) } }];
  }
  return [];
}

function hasVisualSegment(segments) {
  return (segments || []).some((seg) =>
    seg && (seg.type === "image" || seg.type === "mface" || seg.type === "marketface" || seg.type === "bface")
  );
}

function stickerSummary(seg) {
  const data = (seg && seg.data) || {};
  const text = data.summary || data.text || data.name || data.id || data.emoji_id || "";
  return text ? `[表情包:${text}]` : "[表情包]";
}

function faceSummary(seg) {
  const data = (seg && seg.data) || {};
  const id = data.id || data.qq || data.face_id || "";
  return id ? `[QQ表情:${id}]` : "[QQ表情]";
}

function cqVisualSummary(raw) {
  return String(raw || "")
    .replace(/\[CQ:image[^\]]*\]/gi, "[图片]")
    .replace(/\[CQ:(mface|bface|marketface)[^\]]*\]/gi, "[表情包]")
    .replace(/\[CQ:face[^\]]*\]/gi, "[QQ表情]");
}

function profileContextForMessage(msg) {
  const files = [];
  if (msg.message_type === "group") {
    const workspace = workspaceForGroup(msg.group_id);
    files.push(path.join(workspace, "GROUP_PROFILE.md"));
    files.push(memberProfilePath(msg, workspace));
  } else if (msg.message_type === "private") {
    files.push(path.join(workspaceForPrivateUser(msg.user_id), "PROFILE.md"));
  }
  const parts = files.map((file) => profileDigest(file)).filter(Boolean);
  return parts.join("\n");
}

function profileDigest(file) {
  if (!fs.existsSync(file)) {
    return "";
  }
  const lines = fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line &&
      !line.startsWith("#") &&
      !line.startsWith("## 最近观察") &&
      !line.includes("待观察")
    );
  return lines.slice(-12).join("\n").slice(0, 1200);
}

function handleListenMessage(msg) {
  const groupID = Number(msg.group_id);
  const state = getListenState(groupID);
  if (state.busy) {
    state.queue.push(msg);
    log("buffer listen", "group", groupID, "msg", msg.message_id, "depth", state.queue.length);
    return;
  }

  startListenTurn(groupID, msg, true, "live");
}

function getListenState(groupID) {
  let state = listenStates.get(groupID);
  if (!state) {
    state = { busy: false, queue: [], timer: null, releaseTimer: null };
    listenStates.set(groupID, state);
  }
  return state;
}

function startListenTurn(groupID, msg, shouldAck, reason) {
  const state = getListenState(groupID);
  const route = routeForGroup(groupID);
  state.busy = true;
  clearListenTimers(state);
  if (shouldAck) {
    ackMessage(msg);
  }
  dispatchToPort(route.listenPort, msg);
  state.timer = setTimeout(() => releaseListenGroup(groupID, "timeout"), LISTEN_BUSY_TIMEOUT_MS);
  log("listen start", "group", groupID, "msg", msg.message_id, "reason", reason);
}

function scheduleListenRelease(groupID, reason) {
  const state = getListenState(groupID);
  if (!state.busy) {
    return;
  }
  clearTimeout(state.releaseTimer);
  state.releaseTimer = setTimeout(() => releaseListenGroup(groupID, reason), LISTEN_RELEASE_DELAY_MS);
}

function releaseListenGroup(groupID, reason) {
  const state = getListenState(groupID);
  clearListenTimers(state);

  if (state.queue.length > 0) {
    const queued = state.queue.splice(0);
    const batch = buildBufferedMessage(queued);
    log("flush listen", "group", groupID, "count", queued.length, "reason", reason);
    startListenTurn(groupID, batch, false, "buffered");
    return;
  }

  state.busy = false;
  log("listen idle", "group", groupID, "reason", reason);
}

function clearListenTimers(state) {
  clearTimeout(state.timer);
  clearTimeout(state.releaseTimer);
  state.timer = null;
  state.releaseTimer = null;
}

function buildBufferedMessage(messages) {
  if (messages.length === 1) {
    return messages[0];
  }

  const last = messages[messages.length - 1];
  const combined = [
    `上一轮处理期间收到 ${messages.length} 条新消息：`,
    ...messages.map((msg) => `[${senderName(msg)}] ${messageText(msg)}`)
  ].join("\n");

  return {
    ...last,
    message: [{ type: "text", data: { text: combined } }],
    raw_message: combined,
    message_id: last.message_id
  };
}

function senderName(msg) {
  const sender = msg.sender || {};
  return String(sender.card || sender.nickname || msg.user_id || "unknown");
}

function messageText(msg) {
  const segments = messageSegments(msg);
  if (typeof msg.raw_message === "string" && msg.raw_message.trim() && !rawMessageHasCQVisual(msg.raw_message, segments)) {
    return msg.raw_message.trim();
  }

  if (segments.length === 0 && typeof msg.message === "string") {
    return msg.message.trim();
  }

  return messageTextFromSegments(segments) || "[非文本消息]";
}

function rawMessageHasCQVisual(raw, segments) {
  return Array.isArray(segments) && segments.length > 0 && /\[CQ:(image|mface|face|bface|marketface)\b/i.test(String(raw || ""));
}

function messageSegments(msg) {
  if (!msg) {
    return [];
  }
  if (Array.isArray(msg.message)) {
    return msg.message;
  }
  const raw = typeof msg.message === "string" ? msg.message : msg.raw_message;
  if (typeof raw === "string" && /\[CQ:/i.test(raw)) {
    return parseCQMessageSegments(raw);
  }
  return [];
}

function parseCQMessageSegments(raw) {
  const text = String(raw || "");
  const result = [];
  const cqPattern = /\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/g;
  let lastIndex = 0;
  let match;
  while ((match = cqPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push({ type: "text", data: { text: decodeCQText(text.slice(lastIndex, match.index)) } });
    }
    result.push({
      type: match[1],
      data: parseCQData(match[2] || "")
    });
    lastIndex = cqPattern.lastIndex;
  }
  if (lastIndex < text.length) {
    result.push({ type: "text", data: { text: decodeCQText(text.slice(lastIndex)) } });
  }
  return result;
}

function parseCQData(rawParams) {
  const data = {};
  const params = String(rawParams || "").replace(/^,/, "");
  if (!params) {
    return data;
  }
  for (const pair of params.split(",")) {
    const index = pair.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = pair.slice(0, index);
    const value = pair.slice(index + 1);
    data[key] = decodeCQText(value);
  }
  return data;
}

function decodeCQText(text) {
  return String(text || "")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&");
}

function messageTextFromSegments(segments) {
  return segments.map((seg) => {
    if (!seg || !seg.type) return "";
    if (seg.type === "text") return String((seg.data && seg.data.text) || "");
    if (seg.type === "image") return "[图片]";
    if (seg.type === "mface" || seg.type === "marketface" || seg.type === "bface") return stickerSummary(seg);
    if (seg.type === "face") return faceSummary(seg);
    if (seg.type === "at") return `[@${(seg.data && seg.data.qq) || ""}]`;
    return `[${seg.type}]`;
  }).join("").trim();
}

function ackMessage(msg) {
  const echo = `__ack_${msg.message_id}_${Date.now()}`;
  sendUpstream({
    action: "set_msg_emoji_like",
    params: {
      message_id: Number(msg.message_id),
      emoji_id: ACK_EMOJI_ID,
      set: true
    },
    echo
  });
}

function shouldAdminPokeAck(msg) {
  return msg &&
    msg.post_type === "message" &&
    ["group", "private"].includes(msg.message_type) &&
    ADMIN_POKE_ACK_USERS.includes(Number(msg.user_id));
}

function adminPokePayload(msg) {
  if (!shouldAdminPokeAck(msg)) {
    return null;
  }
  const params = {
    user_id: String(Number(msg.user_id))
  };
  if (msg.message_type === "group") {
    params.group_id = String(Number(msg.group_id));
  }
  return {
    action: "send_poke",
    params,
    echo: `__poke_${msg.message_id}_${Date.now()}`
  };
}

function adminPokeAck(msg) {
  const payload = adminPokePayload(msg);
  if (!payload) {
    return;
  }
  sendUpstream(payload);
}

function commandBody(msg, names) {
  const text = messageText(msg).trim();
  for (const name of names) {
    if (text === name) {
      return "";
    }
    if (text.startsWith(`${name} `)) {
      return text.slice(name.length).trim();
    }
    if ((name === "记住" || name === "忘记" || name === "找文件" || name === "安静" || name === "模式") && text.startsWith(name) && text.length > name.length) {
      return text.slice(name.length).trim();
    }
  }
  return null;
}

function isProxyCommand(msg) {
  return getProxyCommands().isProxyCommand(msg);
}

function handleProxyCommand(msg) {
  return getProxyCommands().handleProxyCommand(msg);
}

function handleProxyCommandInline(msg) {
  const isPrivate = msg.message_type === "private";
  const reply = (text) => {
    if (isPrivate) {
      sendPrivateText(msg.user_id, msg.message_id, text);
    } else {
      sendGroupText(msg.group_id, msg.message_id, text);
    }
  };
  const help = commandBody(msg, ["/help", "help", "帮助"]);
  if (help !== null) {
    reply(proxyHelpText(isPrivate));
    return;
  }
  const status = commandBody(msg, ["/status", "状态"]);
  if (status !== null) {
    reply(proxyStatusText(msg));
    return;
  }
  const remember = commandBody(msg, ["/记住", "记住"]);
  if (remember !== null) {
    reply(rememberFact(msg, remember));
    return;
  }
  const forget = commandBody(msg, ["/忘记", "忘记"]);
  if (forget !== null) {
    reply(forgetFact(msg, forget));
    return;
  }
  const summary = commandBody(msg, ["/总结今天", "总结今天", "/今日总结", "今日总结"]);
  if (summary !== null) {
    reply(todaySummary(msg));
    return;
  }
  const findFile = commandBody(msg, ["/找文件", "找文件"]);
  if (findFile !== null) {
    reply(findFiles(msg, findFile));
    return;
  }
  const quiet = commandBody(msg, ["/安静", "安静"]);
  if (quiet !== null) {
    reply(setQuiet(msg, quiet));
    return;
  }
  const resume = commandBody(msg, ["/恢复", "恢复"]);
  if (resume !== null) {
    reply(resumeGroup(msg));
    return;
  }
  const queue = commandBody(msg, ["/队列", "队列"]);
  if (queue !== null) {
    reply(queueStatus(msg));
    return;
  }
  const mode = commandBody(msg, ["/模式", "模式"]);
  if (mode !== null) {
    reply(setMode(msg, mode));
    return;
  }
  const errors = commandBody(msg, ["/最近错误", "最近错误"]);
  if (errors !== null) {
    reply(recentErrors());
  }
}

function proxyHelpText(isPrivate) {
  const lines = [
    "可用命令：",
    "/help：查看功能",
    "/status：查看连接、队列、触发模式",
    "/记住 内容：写入当前用户/群画像",
    "/忘记 关键词：删除画像中匹配的记录",
    "/总结今天：汇总今天聊天",
    "/找文件 关键词：查本群/私聊文件索引",
    "/安静 30分钟：暂停群内主动回复",
    "/恢复：恢复群内主动回复",
    "/队列：查看等待发送、画图、监听队列",
    "/模式 selective|mention|all|off：切换本群触发模式",
    "/最近错误：查看代理最近错误",
    "/画图 prompt：生成图片"
  ];
  if (!isPrivate) {
    lines.push("/dream 或 做梦：整理群记忆");
  }
  return lines.join("\n");
}

function proxyStatusText(msg) {
  const snap = healthSnapshot();
  const key = msg.message_type === "private" ? imageStateKey(msg) : imageStateKey(msg);
  const img = imageStates.get(key) || { active: 0, queue: [] };
  return [
    `QQ 代理：${snap.ok ? "正常" : "异常"}`,
    `OneBot：${snap.upstream.ready ? "已连接" : "未连接"}`,
    `待发送：${snap.pending.upstream_queue}，待回执：${snap.pending.outbound}`,
    `画图：运行 ${img.active}，排队 ${img.queue.length}`,
    `触发模式：${msg.message_type === "group" ? effectiveListenMode(msg.group_id) : LISTEN_TRIGGER_MODE}`,
    `@-only：${msg.message_type === "group" && AT_ONLY_GROUPS.includes(Number(msg.group_id)) ? "是" : "否"}`,
    `静默：${msg.message_type === "group" && isGroupQuiet(msg.group_id) ? "开启" : "关闭"}`,
    `管理员白名单：${ADMIN_USERS.length ? `${ADMIN_USERS.length} 人` : "未启用"}`,
    `允许群：${ALLOWED_GROUPS.length} 个，私聊：${ALLOWED_PRIVATE_USERS.length} 个`
  ].join("\n");
}

function rememberFact(msg, body) {
  const fact = String(body || "").trim();
  if (!fact) {
    return "用法：/记住 这个群默认短答，先给结论";
  }
  const now = new Date().toISOString();
  if (msg.message_type === "group") {
    const workspace = workspaceForGroup(msg.group_id);
    ensureGroupProfile(workspace, msg.group_id);
    appendLine(path.join(workspace, "GROUP_PROFILE.md"), `- ${now} 群偏好/事实: ${fact}`);
    appendLine(memberProfilePath(msg, workspace), `- ${now} 用户补充: ${fact}`);
    return "已记住，后续会按这个偏好处理。";
  }
  const workspace = workspaceForPrivateUser(msg.user_id);
  ensurePrivateProfile(workspace, msg);
  appendLine(path.join(workspace, "PROFILE.md"), `- ${now} 用户补充: ${fact}`);
  return "已记住。";
}

function forgetFact(msg, body) {
  const keyword = String(body || "").trim();
  if (!keyword) {
    return "用法：/忘记 关键词";
  }
  const files = [];
  if (msg.message_type === "group") {
    const workspace = workspaceForGroup(msg.group_id);
    files.push(path.join(workspace, "GROUP_PROFILE.md"));
    files.push(memberProfilePath(msg, workspace));
  } else {
    files.push(path.join(workspaceForPrivateUser(msg.user_id), "PROFILE.md"));
  }
  let removed = 0;
  for (const file of files) {
    removed += removeLinesContaining(file, keyword);
  }
  return removed > 0 ? `已删除 ${removed} 条匹配记录。` : "没找到匹配记录。";
}

function todaySummary(msg) {
  const workspace = msg.message_type === "group" ? workspaceForGroup(msg.group_id) : workspaceForPrivateUser(msg.user_id);
  const file = path.join(workspace, "memory", `chat-${todayLocal()}.jsonl`);
  if (!fs.existsSync(file)) {
    return "今天还没有可总结的聊天记录。";
  }
  const rows = readJSONLines(file).slice(-300);
  if (rows.length === 0) {
    return "今天聊天记录为空。";
  }
  const byUser = new Map();
  const samples = [];
  for (const row of rows) {
    const user = String((row.sender && (row.sender.card || row.sender.nickname)) || row.user_id || "unknown");
    byUser.set(user, (byUser.get(user) || 0) + 1);
    const text = String(row.text || "").trim();
    if (text && !text.startsWith("/status") && !text.startsWith("/help")) {
      samples.push({ user, text });
    }
  }
  const active = [...byUser.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([user, count]) => `${user} ${count}`)
    .join("，");
  const keywords = topKeywords(samples.map((item) => item.text).join("\n")).slice(0, 8).join("、") || "暂无";
  const recent = samples.slice(-6).map((item) => `- ${item.user}: ${item.text.slice(0, 80)}`);
  const decisions = pickLines(samples, /(决定|结论|就这样|采用|确认|同意|final|方案)/i, 4);
  const todos = pickLines(samples, /(todo|待办|要做|需要|记得|明天|今晚|deadline|截止|帮我|修|改|查)/i, 5);
  const issues = pickLines(samples, /(报错|错误|失败|问题|卡住|不行|timeout|failed|error|bug)/i, 5);
  const files = pickLines(samples, /(文件|pdf|docx|xlsx|图片|上传|归档|代码|脚本|\.py|\.md|\.pdf)/i, 5);
  return [
    `今日记录 ${rows.length} 条。`,
    `活跃成员：${active || "暂无"}`,
    `高频主题：${keywords}`,
    "待办/请求：",
    ...(todos.length ? todos : ["- 暂无"]),
    "问题/风险：",
    ...(issues.length ? issues : ["- 暂无"]),
    "文件/产物：",
    ...(files.length ? files : ["- 暂无"]),
    "决策/结论：",
    ...(decisions.length ? decisions : ["- 暂无"]),
    "最近片段：",
    ...recent
  ].join("\n").slice(0, 1800);
}

function pickLines(samples, pattern, max) {
  const seen = new Set();
  const picked = [];
  for (const item of samples.slice().reverse()) {
    const text = String(item.text || "").replace(/\s+/g, " ").trim();
    if (!text || !pattern.test(text)) {
      continue;
    }
    const line = `- ${item.user}: ${text.slice(0, 90)}`;
    if (!seen.has(line)) {
      seen.add(line);
      picked.push(line);
    }
    if (picked.length >= max) {
      break;
    }
  }
  return picked.reverse();
}

function findFiles(msg, query) {
  const keyword = String(query || "").trim().toLowerCase();
  if (!keyword) {
    return "用法：/找文件 关键词";
  }
  const workspace = msg.message_type === "group" ? workspaceForGroup(msg.group_id) : workspaceForPrivateUser(msg.user_id);
  const candidates = [];
  collectFileIndexMatches(workspace, keyword, candidates);
  collectArchiveSummaryMatches(workspace, keyword, candidates);
  if (candidates.length === 0) {
    return "没找到匹配文件。";
  }
  return ["找到这些文件：", ...candidates.slice(0, 8).map((item) => `- ${item}`)].join("\n").slice(0, 1400);
}

function setQuiet(msg, body) {
  if (msg.message_type !== "group") {
    return "静默只对群聊生效。";
  }
  if (!canAdmin(msg)) {
    return "没有权限。";
  }
  const minutes = parseDurationMinutes(body || "30分钟");
  const until = Date.now() + minutes * 60 * 1000;
  quietUntilByGroup.set(Number(msg.group_id), until);
  persistProxyState();
  return `已安静 ${minutes} 分钟。期间只响应 @、回复和命令。`;
}

function resumeGroup(msg) {
  if (msg.message_type !== "group") {
    return "恢复只对群聊生效。";
  }
  if (!canAdmin(msg)) {
    return "没有权限。";
  }
  quietUntilByGroup.delete(Number(msg.group_id));
  persistProxyState();
  return "已恢复群内主动回复。";
}

function queueStatus(msg) {
  const imageKey = imageStateKey(msg);
  const img = imageStates.get(imageKey) || { active: 0, queue: [] };
  let listen = { busy: false, queue: [] };
  if (msg.message_type === "group") {
    listen = listenStates.get(Number(msg.group_id)) || listen;
  }
  return [
    `上游待发：${pending.length}`,
    `待回执：${pendingOutbound.size}`,
    `文件下载：${pendingFileDownloads.size}`,
    `画图：运行 ${img.active}，排队 ${img.queue.length}`,
    `监听：${listen.busy ? "处理中" : "空闲"}，缓冲 ${listen.queue.length}`,
    `回复路由缓存：${botReplyRoutes.size}`
  ].join("\n");
}

function setMode(msg, body) {
  if (msg.message_type !== "group") {
    return "模式只对群聊生效。";
  }
  if (!canAdmin(msg)) {
    return "没有权限。";
  }
  const requested = String(body || "").trim().toLowerCase();
  if (!requested) {
    return `当前模式：${effectiveListenMode(msg.group_id)}。可选：selective、mention、all、off。`;
  }
  const aliases = new Map([
    ["选择", "selective"],
    ["选择性", "selective"],
    ["selective", "selective"],
    ["mention", "mention"],
    ["at", "mention"],
    ["只at", "mention"],
    ["all", "all"],
    ["全部", "all"],
    ["off", "off"],
    ["关闭", "off"]
  ]);
  const mode = aliases.get(requested);
  if (!mode) {
    return "模式无效。可选：selective、mention、all、off。";
  }
  if (AT_ONLY_GROUPS.includes(Number(msg.group_id)) && mode !== "mention" && mode !== "off") {
    return "这个群已锁定为 @ 触发，只能设为 mention 或 off。";
  }
  ensureGroupProfile(workspaceForGroup(msg.group_id), msg.group_id);
  listenModeByGroup.set(Number(msg.group_id), mode);
  appendLine(path.join(workspaceForGroup(msg.group_id), "GROUP_PROFILE.md"), `- ${new Date().toISOString()} 触发模式: ${mode}`);
  persistProxyState();
  return `已切换本群触发模式：${mode}`;
}

function canAdmin(msg) {
  if (ADMIN_USERS.length === 0) {
    return true;
  }
  return ADMIN_USERS.includes(Number(msg.user_id));
}

function isGroupQuiet(groupID) {
  const until = quietUntilByGroup.get(Number(groupID));
  if (!until) {
    return false;
  }
  if (Date.now() > until) {
    quietUntilByGroup.delete(Number(groupID));
    persistProxyState();
    return false;
  }
  return true;
}

function parseDurationMinutes(text) {
  const s = String(text || "").trim();
  const match = s.match(/(\d+)\s*(分钟|分|小时|时|h|m)?/i);
  if (!match) {
    return 30;
  }
  const n = Math.max(1, Math.min(24 * 60, Number(match[1]) || 30));
  const unit = match[2] || "分钟";
  return /小时|时|h/i.test(unit) ? n * 60 : n;
}

function recentErrors() {
  const file = process.env.ONEBOT_PROXY_LOG || "/var/log/onebot-group-proxy.log";
  const localFallback = path.join(__dirname, "..", "onebot-group-proxy.log");
  const source = fs.existsSync(file) ? file : localFallback;
  if (!fs.existsSync(source)) {
    return "没有找到代理日志。";
  }
  const lines = fs.readFileSync(source, "utf8")
    .split(/\r?\n/)
    .filter((line) => /error|failed|timeout|失败|错误/i.test(line))
    .slice(-8)
    .map((line) => maskSensitive(line));
  if (lines.length === 0) {
    return "最近没有明显错误。";
  }
  return ["最近错误：", ...lines].join("\n").slice(0, 1400);
}

function collectFileIndexMatches(workspace, keyword, out) {
  const index = path.join(workspace, "local_files", "INDEX.md");
  if (!fs.existsSync(index)) {
    return;
  }
  for (const line of fs.readFileSync(index, "utf8").split(/\r?\n/)) {
    if (line.toLowerCase().includes(keyword)) {
      out.push(line.replace(/^\s*[-*]\s*/, "").trim());
    }
  }
}

function collectArchiveSummaryMatches(workspace, keyword, out) {
  const root = path.join(workspace, "local_files");
  if (!fs.existsSync(root)) {
    return;
  }
  const stack = [root];
  while (stack.length > 0 && out.length < 20) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name === "summary.md") {
        const text = fs.readFileSync(full, "utf8");
        if (text.toLowerCase().includes(keyword)) {
          out.push(path.relative(workspace, full).replace(/\\/g, "/"));
        }
      }
    }
  }
}

function readJSONLines(file) {
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function topKeywords(text) {
  const stop = new Set(["这个", "那个", "就是", "一下", "可以", "什么", "怎么", "一个", "我们", "你们", "他们", "今天", "然后", "因为", "所以"]);
  const counts = new Map();
  for (const token of String(text || "").toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z0-9_+-]{3,}/g) || []) {
    if (stop.has(token) || /^\d+$/.test(token)) {
      continue;
    }
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word);
}

function isDreamCommand(msg) {
  if (!DREAM_COMMAND_ENABLED || msg.post_type !== "message" || msg.message_type !== "group") {
    return false;
  }
  const text = messageText(msg).trim();
  return DREAM_TRIGGERS.some((trigger) => text === trigger);
}

function handleDreamCommand(msg) {
  const groupID = Number(msg.group_id);
  const workspace = workspaceForGroup(groupID);
  const key = String(groupID);
  ackMessage(msg);

  if (dreamStates.get(key)) {
    sendGroupText(groupID, msg.message_id, "正在做梦，上一轮还没结束。");
    return;
  }

  dreamStates.set(key, true);
  activeTriggers.set(triggerKey(0, groupID), Number(msg.message_id));
  log("dream start", "group", groupID, "msg", msg.message_id);

  const script = dreamScriptForWorkspace(workspace);
  const child = execFile(script.command, script.args, {
    cwd: workspace,
    timeout: Number(process.env.ONEBOT_DREAM_TIMEOUT_MS || 900000),
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 8,
    env: {
      ...process.env,
      QQ_DREAM_GROUP_ID: String(groupID),
      QQ_DREAM_MESSAGE_ID: String(msg.message_id || ""),
      QQ_DREAM_USER_ID: String(msg.user_id || "")
    }
  }, (err, stdout, stderr) => {
    dreamStates.delete(key);
    const output = String(stdout || "").trim();
    const errors = String(stderr || "").trim();
    if (err) {
      const detail = output || errors || err.message;
      sendGroupText(groupID, msg.message_id, renderForQQ(`做梦失败：${detail}`).slice(0, 1200));
      log("dream failed", "group", groupID, err.message);
      recordError("dream", err.message, { scope: "group", target: String(groupID), detail: detail.slice(0, 500) });
      return;
    }
    sendGroupText(groupID, msg.message_id, renderForQQ(output || "梦醒了，但没有生成摘要。").slice(0, 1200));
    log("dream complete", "group", groupID);
  });

  child.on("error", (err) => {
    dreamStates.delete(key);
    sendGroupText(groupID, msg.message_id, `做梦启动失败：${err.message}`);
    log("dream spawn failed", "group", groupID, err.message);
    recordError("dream-spawn", err.message, { scope: "group", target: String(groupID) });
  });
}

function dreamScriptForWorkspace(workspace) {
  const scripts = path.join(workspace, "scripts");
  const ps1 = path.join(scripts, "dream.ps1");
  const sh = path.join(scripts, "dream.sh");
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1]
    };
  }
  return { command: sh, args: [] };
}

function sendGroupText(groupID, replyToMessageID, text) {
  const message = [];
  if (replyToMessageID) {
    message.push({ type: "reply", data: { id: String(replyToMessageID) } });
  }
  message.push({ type: "text", data: { text: String(text || "") } });
  sendUpstream({
    action: "send_group_msg",
    params: {
      group_id: Number(groupID),
      message
    },
    echo: `__dream_${groupID}_${Date.now()}`
  });
}

function imagePromptFromMessage(msg) {
  if (!IMAGE_COMMAND_ENABLED || msg.post_type !== "message" || !["group", "private"].includes(msg.message_type)) {
    return null;
  }
  const text = messageText(msg).trim();
  for (const trigger of IMAGE_TRIGGERS) {
    if (text === trigger) {
      return "";
    }
    if (text.startsWith(`${trigger} `)) {
      return text.slice(trigger.length).trim();
    }
    if (!trigger.startsWith("/") && text.startsWith(trigger) && text.length > trigger.length) {
      return text.slice(trigger.length).trim();
    }
  }
  return null;
}

function isImageCommand(msg) {
  return imagePromptFromMessage(msg) !== null;
}

function handleImageCommand(msg) {
  const isPrivate = msg.message_type === "private";
  const targetID = Number(isPrivate ? msg.user_id : msg.group_id);
  const prompt = imagePromptFromMessage(msg);
  ackMessage(msg);

  if (!prompt) {
    sendImageText(msg, "用法：/画图 一只赛博朋克风格的橘猫，雨夜街头，电影感");
    return;
  }
  const key = imageStateKey(msg);
  const state = getImageState(key);
  if (state.queue.length >= IMAGE_QUEUE_MAX_PER_GROUP) {
    sendImageText(msg, "画图队列已满，稍后再试。");
    return;
  }

  state.queue.push({ msg, prompt });
  log("image queued", isPrivate ? "private" : "group", targetID, "msg", msg.message_id, "active", state.active, "depth", state.queue.length);
  if (state.active >= IMAGE_MAX_CONCURRENT_PER_GROUP) {
    sendImageText(msg, `已加入画图队列，前面还有 ${state.queue.length - 1} 张。`);
  }
  pumpImageQueue(key);
}

function imageStateKey(msg) {
  return msg.message_type === "private" ? `private:${Number(msg.user_id)}` : `group:${Number(msg.group_id)}`;
}

function getImageState(key) {
  let state = imageStates.get(key);
  if (!state) {
    state = { active: 0, queue: [] };
    imageStates.set(key, state);
  }
  return state;
}

function pumpImageQueue(key) {
  const state = getImageState(key);
  while (state.active < IMAGE_MAX_CONCURRENT_PER_GROUP && state.queue.length > 0) {
    const item = state.queue.shift();
    startImageJob(key, item.msg, item.prompt, state);
  }
}

function finishImageJob(key, state) {
  state.active = Math.max(0, state.active - 1);
  pumpImageQueue(key);
}

function startImageJob(key, msg, prompt, state) {
  const isPrivate = msg.message_type === "private";
  const targetID = Number(isPrivate ? msg.user_id : msg.group_id);
  const workspace = isPrivate ? workspaceForPrivateUser(targetID) : workspaceForGroup(targetID);
  state.active += 1;
  log("image start", isPrivate ? "private" : "group", targetID, "msg", msg.message_id, "active", state.active, "queued", state.queue.length);

  const child = execFile(process.execPath, [IMAGE_SCRIPT, "--workspace", workspace, "--prompt", prompt], {
    cwd: workspace,
    timeout: Number(process.env.ONEBOT_IMAGE_TIMEOUT_MS || 600000),
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 8,
    env: {
      ...process.env,
      QQ_IMAGE_GROUP_ID: isPrivate ? "" : String(targetID),
      QQ_IMAGE_MESSAGE_ID: String(msg.message_id || ""),
      QQ_IMAGE_USER_ID: String(msg.user_id || "")
    }
  }, (err, stdout, stderr) => {
    if (err) {
      const detail = String(stdout || stderr || err.message).trim();
      sendImageText(msg, renderForQQ(`画图失败：${detail}`).slice(0, 1200));
      log("image failed", isPrivate ? "private" : "group", targetID, err.message);
      recordError("image", err.message, { scope: isPrivate ? "private" : "group", target: String(targetID), detail: detail.slice(0, 500) });
      finishImageJob(key, state);
      return;
    }

    let result;
    try {
      result = JSON.parse(String(stdout || "{}"));
    } catch {
      sendImageText(msg, "画图失败：生成脚本没有返回有效结果。");
      recordError("image", "invalid generate-image result", { scope: isPrivate ? "private" : "group", target: String(targetID) });
      finishImageJob(key, state);
      return;
    }

    if (!result.imagePath || !fs.existsSync(result.imagePath)) {
      sendImageText(msg, "画图失败：图片文件没有生成。");
      recordError("image", "image file missing", { scope: isPrivate ? "private" : "group", target: String(targetID) });
      finishImageJob(key, state);
      return;
    }

    sendImageResult(msg, result.imagePath, imageResultText(result));
    log("image complete", isPrivate ? "private" : "group", targetID, path.basename(result.imagePath));
    finishImageJob(key, state);
  });

  child.on("error", (err) => {
    sendImageText(msg, `画图启动失败：${err.message}`);
    log("image spawn failed", isPrivate ? "private" : "group", targetID, err.message);
    recordError("image-spawn", err.message, { scope: isPrivate ? "private" : "group", target: String(targetID) });
    finishImageJob(key, state);
  });
}

function sendImageText(msg, text) {
  if (msg.message_type === "private") {
    sendPrivateText(msg.user_id, msg.message_id, text);
    return;
  }
  sendGroupText(msg.group_id, msg.message_id, text);
}

function imageResultText(result) {
  const rel = result.relativePath ? `已生成：${result.relativePath}` : "已生成图片";
  const model = result.model ? `（${result.model}）` : "";
  return `${rel}${model}`;
}

function sendGroupImage(groupID, replyToMessageID, imagePath, text) {
  const imageData = fs.readFileSync(path.resolve(imagePath)).toString("base64");
  const message = [
    { type: "reply", data: { id: String(replyToMessageID) } },
    { type: "text", data: { text: `${text}\n` } },
    { type: "image", data: { file: `base64://${imageData}` } }
  ];
  sendUpstream({
    action: "send_group_msg",
    params: {
      group_id: Number(groupID),
      message
    },
    echo: `__image_${groupID}_${Date.now()}`
  });
}

function sendPrivateText(userID, replyToMessageID, text) {
  const message = [];
  if (replyToMessageID) {
    message.push({ type: "reply", data: { id: String(replyToMessageID) } });
  }
  message.push({ type: "text", data: { text: String(text || "") } });
  sendUpstream({
    action: "send_private_msg",
    params: {
      user_id: Number(userID),
      message
    },
    echo: `__private_text_${userID}_${Date.now()}`
  });
}

function sendImageResult(msg, imagePath, text) {
  if (msg.message_type === "private") {
    sendPrivateImage(msg.user_id, msg.message_id, imagePath, text);
    return;
  }
  sendGroupImage(msg.group_id, msg.message_id, imagePath, text);
}

function sendPrivateImage(userID, replyToMessageID, imagePath, text) {
  const imageData = fs.readFileSync(path.resolve(imagePath)).toString("base64");
  const message = [];
  if (replyToMessageID) {
    message.push({ type: "reply", data: { id: String(replyToMessageID) } });
  }
  message.push({ type: "text", data: { text: `${text}\n` } });
  message.push({ type: "image", data: { file: `base64://${imageData}` } });
  sendUpstream({
    action: "send_private_msg",
    params: {
      user_id: Number(userID),
      message
    },
    echo: `__image_private_${userID}_${Date.now()}`
  });
}

function handleImageSendResponse(resp) {
  const ok = responseOK(resp);
  if (ok) {
    log("image send ok", "echo", resp.echo, "msg", responseMessageID(resp) || "");
    return;
  }
  log("image send failed", "echo", resp && resp.echo, "retcode", resp && resp.retcode, "message", responseErrorText(resp));
  recordError("image-send", responseErrorText(resp), { target: String(resp && resp.echo || ""), detail: String(resp && resp.retcode || "") });
}

function prepareOutgoing(obj, sourcePort) {
  if (!obj || !obj.params) {
    return obj;
  }

  let copy = { ...obj, params: { ...obj.params } };
  copy = maybeCreateAtArtifacts(copy, sourcePort);

  if (typeof copy.params.message === "string") {
    copy.params.message = renderForQQ(stripWorkspacePath(copy.params.message));
  } else if (Array.isArray(copy.params.message)) {
    copy.params.message = copy.params.message.map((seg) => {
      if (!seg || seg.type !== "text" || !seg.data || typeof seg.data.text !== "string") {
        return seg;
      }
      return { ...seg, data: { ...seg.data, text: renderForQQ(stripWorkspacePath(seg.data.text)) } };
    });
  }
  addReplyReference(copy, sourcePort);
  return copy;
}

function maybeCreateAtArtifacts(obj, sourcePort) {
  if (!isOutgoingMessageAction(obj)) {
    return obj;
  }
  const groupID = outgoingGroupID(obj);
  if (!ALLOWED_GROUPS.includes(groupID) || routeForGroup(groupID).atPort !== sourcePort) {
    return obj;
  }

  const rawText = outgoingText(obj);
  if (!rawText.trim()) {
    return obj;
  }

  let next = obj;
  const codeResult = saveCodeArtifacts(groupID, rawText);
  if (codeResult.files.length > 0) {
    for (const file of codeResult.files) {
      uploadGroupFile(groupID, file.path, file.name);
    }
    next = withOutgoingText(next, buildCodeArtifactReply(codeResult));
  }

  const imageSource = outgoingText(next);
  if (shouldRenderAsImage(imageSource)) {
    const image = renderAnswerImage(groupID, imageSource);
    if (image) {
      next = withOutgoingSegments(next, [
        { type: "text", data: { text: "答案已渲染成图片，便于查看公式和排版：" } },
        { type: "image", data: { file: pathToFileURL(image).href } }
      ]);
    }
  }
  return next;
}

function outgoingText(obj) {
  const message = obj && obj.params && obj.params.message;
  if (typeof message === "string") {
    return message;
  }
  if (Array.isArray(message)) {
    return message.map((seg) => {
      if (!seg || seg.type !== "text" || !seg.data) return "";
      return String(seg.data.text || "");
    }).join("\n");
  }
  return "";
}

function shouldSilenceOutgoing(obj) {
  if (!isOutgoingMessageAction(obj) && !isOutgoingPrivateMessageAction(obj)) {
    return false;
  }
  const text = outgoingText(obj).replace(/\s+/g, " ").trim();
  return SILENCED_OUTGOING_PATTERNS.some((pattern) => text.includes(pattern));
}

function withOutgoingText(obj, text) {
  return { ...obj, params: { ...obj.params, message: text } };
}

function withOutgoingSegments(obj, segments) {
  return { ...obj, params: { ...obj.params, message: segments } };
}

function saveCodeArtifacts(groupID, text) {
  const files = [];
  const stripped = text.replace(/```([a-zA-Z0-9_+.-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const language = String(lang || "").toLowerCase();
    if (!["py", "python", "python3"].includes(language)) {
      return match;
    }
    const fileName = `answer-${timestampSlug()}-${files.length + 1}.py`;
    const filePath = path.join(workspaceForGroup(groupID), "local_files", "generated", fileName);
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, String(code).trimStart(), "utf8");
    appendLine(path.join(workspaceForGroup(groupID), "local_files", "INDEX.md"), `- ${new Date().toISOString()} 生成 Python: generated/${fileName}`);
    files.push({ name: fileName, path: filePath });
    return `已生成 Python 文件：${fileName}`;
  });
  return { files, text: stripped };
}

function buildCodeArtifactReply(result) {
  const names = result.files.map((file) => file.name).join("、");
  const cleaned = result.text.replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned || cleaned === `已生成 Python 文件：${names}`) {
    return `已生成并上传 Python 文件：${names}`;
  }
  return `${cleaned}\n\n已生成并上传 Python 文件：${names}`;
}

function uploadGroupFile(groupID, filePath, fileName) {
  sendUpstream({
    action: "upload_group_file",
    params: {
      group_id: Number(groupID),
      file: path.resolve(filePath),
      name: fileName
    },
    echo: `__upload_${groupID}_${Date.now()}`
  });
  log("upload group file", groupID, fileName);
}

function shouldRenderAsImage(text) {
  const s = String(text || "");
  if (s.length > 900) {
    return true;
  }
  return /(\$\$?|\\\[|\\\]|\\\(|\\\)|\\frac|\\sum|\\int|\\sqrt|\\begin\{|[∑√∫≤≥≈≠∞]|[a-zA-Z]\^\{?[-+\w]+\}?|[a-zA-Z]_\{?[-+\w]+\}?)/.test(s);
}

function renderAnswerImage(groupID, text) {
  try {
    const workspace = workspaceForGroup(groupID);
    const dir = path.join(workspace, "local_files", "rendered");
    ensureDir(dir);
    const slug = timestampSlug();
    const textPath = path.join(dir, `answer-${slug}.txt`);
    const imagePath = path.join(dir, `answer-${slug}.png`);
    fs.writeFileSync(textPath, renderForQQ(stripWorkspacePath(text)), "utf8");
    renderCardImage(textPath, imagePath, `QQ Bot - ${groupID}`);
    appendLine(path.join(workspace, "local_files", "INDEX.md"), `- ${new Date().toISOString()} 渲染答案图片: rendered/${path.basename(imagePath)}`);
    return imagePath;
  } catch (err) {
    log("render image failed", err.message);
    recordError("render", err.message);
    return null;
  }
}

function renderCardImage(textPath, imagePath, title) {
  if (process.platform === "win32" && commandExists("powershell.exe")) {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", RENDER_SCRIPT,
      "-TextPath", textPath,
      "-OutPath", imagePath,
      "-Title", title
    ], { timeout: 30000, windowsHide: true });
    return;
  }
  if (commandExists(process.env.ONEBOT_IMAGEMAGICK_CONVERT || "convert")) {
    execFileSync(process.execPath, [
      RENDER_IMAGEMAGICK_SCRIPT,
      "--text", textPath,
      "--out", imagePath,
      "--title", title
    ], { timeout: 30000, windowsHide: true });
    return;
  }
  throw new Error("no answer-image renderer available: install ImageMagick convert or provide powershell.exe");
}

function commandExists(command) {
  try {
    const checker = process.platform === "win32" ? "where.exe" : "which";
    execFileSync(checker, [command], { stdio: "ignore", timeout: 3000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function stripWorkspacePath(text) {
  return text
    .replace(/[ \t]*[·•]\s*…\/groups\/sandbox-\d+[,，]?/g, "")
    .replace(/[ \t]*[·•]\s*E:\\CHATBOT-QQ\\groups\\sandbox-\d+[,，]?/gi, "");
}

function renderForQQ(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, "\n$1\n")
    .replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, "$1")
    .replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_, code) => {
      const body = String(code).trimEnd();
      return body ? `\n代码：\n${body}\n` : "";
    })
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => `[图片${alt ? `: ${alt}` : ""}] ${url}`)
    .replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, (_, title) => `【${title.trim()}】`)
    .replace(/^\s{0,3}>\s?/gm, "引用：")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*(\d+)\.\s+/gm, "$1. ")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function outgoingGroupID(obj) {
  if (!obj || !obj.params) {
    return null;
  }
  const groupID = obj.params.group_id || obj.params.groupId;
  return groupID === undefined || groupID === null ? null : Number(groupID);
}

function isOutgoingMessageAction(obj) {
  if (!obj || typeof obj.action !== "string") {
    return false;
  }
  return obj.action === "send_group_msg" || obj.action === "send_msg" || obj.action.endsWith(".send_group_msg");
}

function isOutgoingPrivateMessageAction(obj) {
  if (!obj || typeof obj.action !== "string") {
    return false;
  }
  return obj.action === "send_private_msg" || obj.action.endsWith(".send_private_msg");
}

function addReplyReference(obj, sourcePort) {
  if (isOutgoingPrivateMessageAction(obj)) {
    addPrivateReplyReference(obj, sourcePort);
    return;
  }
  if (!isOutgoingMessageAction(obj)) {
    return;
  }
  const groupID = outgoingGroupID(obj);
  if (!ALLOWED_GROUPS.includes(groupID)) {
    return;
  }
  const triggerID = activeTriggers.get(triggerKey(sourcePort, groupID));
  if (!triggerID) {
    return;
  }

  const replySeg = { type: "reply", data: { id: String(triggerID) } };
  if (typeof obj.params.message === "string") {
    obj.params.message = [replySeg, { type: "text", data: { text: obj.params.message } }];
  } else if (Array.isArray(obj.params.message)) {
    const hasReply = obj.params.message.some((seg) => seg && seg.type === "reply");
    if (!hasReply) {
      obj.params.message = [replySeg, ...obj.params.message];
    }
  }
}

function addPrivateReplyReference(obj, sourcePort) {
  const userID = outgoingUserID(obj);
  if (!ALLOWED_PRIVATE_USERS.includes(userID)) {
    return;
  }
  const triggerID = activeTriggers.get(triggerKey(sourcePort, userID));
  if (!triggerID) {
    return;
  }

  const replySeg = { type: "reply", data: { id: String(triggerID) } };
  if (typeof obj.params.message === "string") {
    obj.params.message = [replySeg, { type: "text", data: { text: obj.params.message } }];
  } else if (Array.isArray(obj.params.message)) {
    const hasReply = obj.params.message.some((seg) => seg && seg.type === "reply");
    if (!hasReply) {
      obj.params.message = [replySeg, ...obj.params.message];
    }
  }
}

function trackOutgoingAPI(obj, sourcePort) {
  if (!obj || typeof obj !== "object") {
    return obj;
  }

  if (typeof obj.echo === "string" && obj.echo) {
    pendingEchoPorts.set(obj.echo, sourcePort);
  }

  if (!isOutgoingMessageAction(obj) && !isOutgoingPrivateMessageAction(obj)) {
    return obj;
  }

  const groupID = outgoingGroupID(obj);
  if (isOutgoingPrivateMessageAction(obj)) {
    const echo = typeof obj.echo === "string" && obj.echo ? obj.echo : `__privreply_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tracked = obj.echo === echo ? obj : { ...obj, echo };
    pendingEchoPorts.set(echo, sourcePort);
    trackPendingOutbound(tracked, sourcePort, "private");
    return tracked;
  }
  if (!ALLOWED_GROUPS.includes(groupID)) {
    return obj;
  }

  const echo = typeof obj.echo === "string" && obj.echo ? obj.echo : `__botreply_${groupID}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tracked = obj.echo === echo ? obj : { ...obj, echo };
  pendingBotReplies.set(echo, { groupID, port: sourcePort, ts: Date.now() });
  pendingEchoPorts.set(echo, sourcePort);
  trackPendingOutbound(tracked, sourcePort, "group");
  return tracked;
}

function outgoingUserID(obj) {
  if (!obj || !obj.params) {
    return null;
  }
  const userID = obj.params.user_id || obj.params.userId;
  return userID === undefined || userID === null ? null : Number(userID);
}

function handleBotReplyResponse(resp) {
  const info = pendingBotReplies.get(resp.echo);
  pendingBotReplies.delete(resp.echo);
  const port = pendingEchoPorts.get(resp.echo);
  pendingEchoPorts.delete(resp.echo);

  if (!responseOK(resp)) {
    log("bot reply failed", "echo", resp.echo, "retcode", resp.retcode || "", "message", responseErrorText(resp));
    recordError("bot-reply", responseErrorText(resp), { target: String(resp.echo || ""), detail: String(resp.retcode || "") });
    if (retryOutbound(resp.echo, `response:${resp.retcode || responseErrorText(resp)}`)) {
      return;
    }
  }
  clearPendingOutbound(resp.echo);

  const messageID = responseMessageID(resp);
  if (info && messageID) {
    rememberBotReply(info.groupID, messageID, info.port);
  }
  if (port) {
    dispatchToPort(port, resp);
  }
}

function responseMessageID(resp) {
  const data = resp && resp.data ? resp.data : {};
  const id = data.message_id || data.messageId || resp.message_id;
  return id === undefined || id === null ? null : Number(id);
}

function rememberBotReply(groupID, messageID, port) {
  botReplyRoutes.set(botReplyKey(groupID, messageID), { port, ts: Date.now() });
  if (botReplyRoutes.size > 1000) {
    const entries = [...botReplyRoutes.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [key] of entries.slice(0, botReplyRoutes.size - 800)) {
      botReplyRoutes.delete(key);
    }
  }
  log("remember bot reply", "group", groupID, "msg", messageID, "port", port);
}

function triggerKey(port, groupID) {
  return `${port}:${Number(groupID)}`;
}

function workspaceForGroup(groupID) {
  return path.resolve(WORKSPACE_ROOT, `sandbox-${Number(groupID)}`);
}

function workspaceForPrivateUser(userID) {
  return path.resolve(path.dirname(WORKSPACE_ROOT), "users", String(Number(userID)));
}

function executionWorkspaceForPrivateUser(userID) {
  if (ADMIN_ROOT_USERS.includes(Number(userID))) {
    return path.resolve(path.dirname(WORKSPACE_ROOT));
  }
  return workspaceForPrivateUser(userID);
}

function explainRouteScope(input = {}) {
  const messageType = String(input.message_type || input.messageType || "").trim().toLowerCase();
  const operation = normalizeRouteOperation(input.operation);
  const projectRoot = path.resolve(path.dirname(WORKSPACE_ROOT));
  const workspaceRoot = path.resolve(WORKSPACE_ROOT);

  if (messageType === "group") {
    const groupID = normalizeNumericID(input.group_id || input.groupID, "group_id");
    const workspace = workspaceForGroup(groupID);
    return {
      scope: "group",
      operation,
      group_id: String(groupID),
      user_id: input.user_id === undefined || input.user_id === null ? null : String(input.user_id),
      is_admin_root_user: false,
      project_root: projectRoot,
      workspace_root: workspaceRoot,
      memory_workspace: workspace,
      execution_workspace: workspace,
      active_workspace: workspace,
      memory_workspace_relative: relativeToProjectRoot(projectRoot, workspace),
      execution_workspace_relative: relativeToProjectRoot(projectRoot, workspace),
      active_workspace_relative: relativeToProjectRoot(projectRoot, workspace),
      reason: "group messages use the group sandbox for memory and execution"
    };
  }

  if (messageType === "private") {
    const userID = normalizeNumericID(input.user_id || input.userID, "user_id");
    const memoryWorkspace = workspaceForPrivateUser(userID);
    const executionWorkspace = executionWorkspaceForPrivateUser(userID);
    const activeWorkspace = operation === "execute" ? executionWorkspace : memoryWorkspace;
    const isAdminRootUser = ADMIN_ROOT_USERS.includes(Number(userID));
    return {
      scope: "private",
      operation,
      user_id: String(userID),
      group_id: null,
      is_admin_root_user: isAdminRootUser,
      project_root: projectRoot,
      workspace_root: workspaceRoot,
      memory_workspace: memoryWorkspace,
      execution_workspace: executionWorkspace,
      active_workspace: activeWorkspace,
      memory_workspace_relative: relativeToProjectRoot(projectRoot, memoryWorkspace),
      execution_workspace_relative: relativeToProjectRoot(projectRoot, executionWorkspace),
      active_workspace_relative: relativeToProjectRoot(projectRoot, activeWorkspace),
      reason: isAdminRootUser
        ? "admin private execution uses project root; memory stays under users"
        : "normal private memory and execution stay under the user workspace"
    };
  }

  throw new Error("message_type must be group or private");
}

function normalizeRouteOperation(operation) {
  const normalized = String(operation || "chat").trim().toLowerCase();
  if (["chat", "execute", "memory"].includes(normalized)) {
    return normalized;
  }
  throw new Error("operation must be chat, execute, or memory");
}

function normalizeNumericID(value, label) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error(`${label} must be a positive numeric id`);
  }
  return numberValue;
}

function relativeToProjectRoot(projectRoot, target) {
  const relative = path.relative(projectRoot, path.resolve(target));
  return relative ? relative.replace(/\\/g, "/") : ".";
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${line}\n`, "utf8");
}

function removeLinesContaining(file, keyword) {
  if (!fs.existsSync(file)) {
    return 0;
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const next = lines.filter((line) => !line.includes(keyword));
  const removed = lines.length - next.length;
  if (removed > 0) {
    fs.writeFileSync(file, next.join("\n").replace(/\n*$/, "\n"), "utf8");
  }
  return removed;
}

function ensureGroupProfile(workspace, groupID) {
  const file = path.join(workspace, "GROUP_PROFILE.md");
  if (fs.existsSync(file)) {
    return;
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, [
    `# QQ 群 ${groupID}`,
    "",
    "## 群定位",
    "- 用途: 待观察",
    "- 默认语气: 短答、先给结论",
    "- 主动回复: 只在求助、@、回复 bot 或匹配触发词时介入",
    "",
    "## 稳定偏好",
    "",
    "## 临时上下文",
    "",
    "## 观察记录",
    ""
  ].join("\n"), "utf8");
}

function ensurePrivateProfile(workspace, msg) {
  const sender = msg.sender || {};
  const userID = String(msg.user_id || "unknown");
  const display = String(sender.nickname || sender.card || userID);
  const file = path.join(workspace, "PROFILE.md");
  if (fs.existsSync(file)) {
    return;
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, [
    `# ${display}`,
    "",
    `- QQ: ${userID}`,
    `- 首次记录: ${new Date().toISOString()}`,
    "",
    "## 稳定信息",
    "- 称呼/身份: 待观察",
    "- 常问领域: 待观察",
    "",
    "## 回复偏好",
    "- 默认: 短答、先给结论",
    "",
    "## 当前任务",
    "",
    "## 最近观察",
    ""
  ].join("\n"), "utf8");
}

function todayLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function safeName(value) {
  return String(value || "unknown").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 80);
}

function recordGroupMessage(msg) {
  const workspace = workspaceForGroup(msg.group_id);
  ensureGroupProfile(workspace, msg.group_id);
  const record = {
    time: new Date().toISOString(),
    group_id: String(msg.group_id),
    message_id: String(msg.message_id),
    user_id: String(msg.user_id || ""),
    sender: msg.sender || {},
    text: messageText(msg),
    has_image: Array.isArray(msg.message) && hasVisualSegment(msg.message),
    raw_message: msg.raw_message || ""
  };
  appendLine(path.join(workspace, "memory", `chat-${todayLocal()}.jsonl`), JSON.stringify(record));
  touchMemberProfile(workspace, msg);
}

function recordPrivateMessage(msg) {
  const workspace = workspaceForPrivateUser(msg.user_id);
  const record = {
    time: new Date().toISOString(),
    message_id: String(msg.message_id),
    user_id: String(msg.user_id || ""),
    sender: msg.sender || {},
    text: messageText(msg),
    has_image: Array.isArray(msg.message) && hasVisualSegment(msg.message),
    raw_message: msg.raw_message || ""
  };
  appendLine(path.join(workspace, "memory", `chat-${todayLocal()}.jsonl`), JSON.stringify(record));
  touchPrivateProfile(workspace, msg);
}

function touchPrivateProfile(workspace, msg) {
  ensurePrivateProfile(workspace, msg);
  const file = path.join(workspace, "PROFILE.md");
  const text = messageText(msg).slice(0, 220);
  appendLine(file, `- ${new Date().toISOString()} ${text}`);
}

function handlePrivateFileNotice(msg) {
  const userID = Number(msg.user_id);
  const route = routeForPrivateUser(userID);
  if (!route) {
    log("drop private file", userID);
    return;
  }
  const saved = savePrivatePdfFileData(msg, msg.file || {});
  if (saved.length === 0 && requestPrivateFileDownload(msg, msg.file || {})) {
    return;
  }
  const text = saved.length > 0
    ? ["收到 PDF 文件，已保存到私聊沙箱：", ...saved.map((file) => `- ${file}`)].join("\n")
    : `收到文件通知：${JSON.stringify(msg.file || {})}`;
  const synthetic = {
    post_type: "message",
    message_type: "private",
    user_id: userID,
    message_id: msg.message_id || Date.now(),
    sender: msg.sender || {},
    message: [{ type: "text", data: { text } }],
    raw_message: text
  };
  recordPrivateMessage(synthetic);
  activeTriggers.set(triggerKey(route.port, userID), Number(synthetic.message_id));
  dispatchToPort(route.port, synthetic);
}

function enrichPrivatePdfMessage(msg) {
  const pdfs = savePrivatePdfs(msg);
  if (pdfs.length === 0) {
    return;
  }
  const note = [
    "收到 PDF 文件，已保存到私聊沙箱：",
    ...pdfs.map((file) => `- ${file}`)
  ].join("\n");
  const original = messageText(msg);
  msg.message = [{ type: "text", data: { text: `${original}\n\n${note}`.trim() } }];
  msg.raw_message = `${original}\n\n${note}`.trim();
}

function savePrivatePdfs(msg) {
  const segments = Array.isArray(msg.message) ? msg.message : [];
  const saved = [];
  for (const seg of segments) {
    if (!seg || seg.type !== "file" || !seg.data) {
      continue;
    }
    const result = savePrivatePdfFileData(msg, seg.data);
    if (result.length === 0) {
      requestPrivateFileDownload(msg, seg.data);
    }
    saved.push(...result);
  }
  return saved;
}

function requestPrivateFileDownload(msg, data) {
  const fileID = data && (data.id || data.file_id);
  if (!fileID) {
    return false;
  }
  const echo = `__file_private_${msg.user_id}_${Date.now()}`;
  pendingFileDownloads.set(echo, {
    userID: Number(msg.user_id),
    fileName: data.name || data.file_name || data.file || fileID,
    messageID: msg.message_id || "",
    fileInfo: data
  });
  sendUpstream({
    action: "get_file",
    params: { file_id: String(fileID) },
    echo
  });
  log("private file download requested", msg.user_id, fileID);
  return true;
}

function savePrivatePdfFileData(msg, data) {
  const workspace = workspaceForPrivateUser(msg.user_id);
  const name = safeName(data.name || data.file_name || data.file || data.file_id || `upload-${Date.now()}.pdf`);
  if (!name.toLowerCase().endsWith(".pdf")) {
    return [];
  }
  const target = path.join(workspace, "local_files", "pdfs", name);
  ensureDir(path.dirname(target));
  const source = data.path || data.file || data.url;
  try {
    if (source && typeof source === "string" && fs.existsSync(source)) {
      fs.copyFileSync(source, target);
    } else if (source && /^file:\/\//i.test(source)) {
      fs.copyFileSync(new URL(source), target);
    } else if (source && /^https?:\/\//i.test(source)) {
      execFileSync("curl", ["-fsSL", "-o", target, source], { timeout: 120000 });
    } else {
      appendLine(path.join(workspace, "memory", `file-events-${todayLocal()}.jsonl`), JSON.stringify({
        time: new Date().toISOString(),
        type: "private_pdf_pending",
        user_id: String(msg.user_id || ""),
        message_id: String(msg.message_id || ""),
        file: data
      }));
      return [`local_files/pdfs/${name}（待从 NapCat 文件缓存获取）`];
    }
    const rel = path.relative(workspace, target).replace(/\\/g, "/");
    appendLine(path.join(workspace, "local_files", "INDEX.md"), `- ${new Date().toISOString()} PDF: ${rel}`);
    parsePrivatePdf(workspace, target, rel, msg, data).catch((err) => {
      log("private pdf parse failed", msg.user_id, rel, err.message);
      recordError("private-pdf-parse", err.message, { scope: "private", target: String(msg.user_id || ""), detail: rel });
    });
    return [rel];
  } catch (err) {
    log("private pdf save failed", msg.user_id, name, err.message);
    recordError("private-pdf-save", err.message, { scope: "private", target: String(msg.user_id || ""), detail: name });
    return [];
  }
}

async function parsePrivatePdf(workspace, target, rel, msg, data) {
  const sidecarDir = `${target}.archive`;
  ensureDir(sidecarDir);
  const meta = {
    time: new Date().toISOString(),
    user_id: String(msg.user_id || ""),
    message_id: String(msg.message_id || ""),
    file: rel,
    source: data || {},
    parser: "pdf-parse"
  };
  const extracted = (await extractPdfText(target)).replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  fs.writeFileSync(path.join(sidecarDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  const extractedPath = path.join(sidecarDir, "extracted.txt");
  const summaryPath = path.join(sidecarDir, "summary.md");
  fs.writeFileSync(extractedPath, extracted, "utf8");
  fs.writeFileSync(summaryPath, buildFileSummary({ path: target, relativePath: rel, name: path.basename(target) }, extracted, meta), "utf8");
  addFileIndex({
    workspace,
    scope: "private",
    scopeID: String(msg.user_id || ""),
    userID: String(msg.user_id || ""),
    messageID: String(msg.message_id || ""),
    name: path.basename(target),
    originalName: data.name || data.file_name || path.basename(target),
    relativePath: rel,
    size: fs.statSync(target).size,
    parser: "pdf-parse",
    summaryPath: path.relative(workspace, summaryPath).replace(/\\/g, "/"),
    extractedPath: path.relative(workspace, extractedPath).replace(/\\/g, "/")
  });
  appendLine(path.join(workspace, "memory", `file-archive-${todayLocal()}.jsonl`), JSON.stringify({
    time: new Date().toISOString(),
    user_id: String(msg.user_id || ""),
    file: rel,
    extracted_chars: extracted.length,
    summary: path.relative(workspace, summaryPath).replace(/\\/g, "/")
  }));
}

function touchMemberProfile(workspace, msg) {
  const userID = String(msg.user_id || "unknown");
  const sender = msg.sender || {};
  const display = String(sender.card || sender.nickname || userID);
  const file = memberProfilePath(msg, workspace);
  if (!fs.existsSync(file)) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, [
      `# ${display}`,
      "",
      `- QQ: ${userID}`,
      `- 首次记录: ${new Date().toISOString()}`,
      "",
      "## 稳定信息",
      "- 称呼/身份: 待观察",
      "- 常问领域: 待观察",
      "",
      "## 回复偏好",
      "- 默认: 短答、先给结论",
      "",
      "## 重要信息",
      "",
      "## 最近观察",
      ""
    ].join("\n"), "utf8");
  }
  appendLine(file, `- ${new Date().toISOString()} ${messageText(msg).slice(0, 160)}`);
}

function memberProfilePath(msg, workspace) {
  const root = workspace || workspaceForGroup(msg.group_id);
  const userID = String(msg.user_id || "unknown");
  return path.join(root, "members", `${safeName(userID)}.md`);
}

function handleGroupUpload(msg) {
  return getProxyFiles().handleGroupUpload(msg);
}

function handleFileDownloadResponse(resp) {
  const pendingInfo = pendingFileDownloads.get(resp.echo);
  pendingFileDownloads.delete(resp.echo);
  if (!pendingInfo) {
    return;
  }
  const data = resp.data || {};
  const source = data.file || data.path || data.url;
  if (pendingInfo.userID) {
    const workspace = workspaceForPrivateUser(pendingInfo.userID);
    const saved = savePrivatePdfFileData({
      user_id: pendingInfo.userID,
      message_id: pendingInfo.messageID || ""
    }, { ...pendingInfo.fileInfo, ...data, source });
    const route = routeForPrivateUser(pendingInfo.userID);
    if (route && saved.length > 0) {
      const text = ["收到 PDF 文件，已保存并开始解析：", ...saved.map((file) => `- ${file}`)].join("\n");
      const synthetic = {
        post_type: "message",
        message_type: "private",
        user_id: pendingInfo.userID,
        message_id: pendingInfo.messageID || Date.now(),
        sender: {},
        message: [{ type: "text", data: { text } }],
        raw_message: text
      };
      recordPrivateMessage(synthetic);
      activeTriggers.set(triggerKey(route.port, pendingInfo.userID), Number(synthetic.message_id));
      dispatchToPort(route.port, synthetic);
    } else {
      appendLine(path.join(workspace, "local_files", "INDEX.md"), `- ${new Date().toISOString()} 私聊文件待手动获取: ${pendingInfo.fileName}; get_file=${JSON.stringify(data)}`);
    }
    return;
  }
  getProxyFiles().handleGroupFileDownloadResponse(pendingInfo, resp);
}

async function extractPdfText(filePath) {
  let pdfParse;
  try {
    pdfParse = require("pdf-parse");
  } catch {
    throw new Error("缺少 pdf-parse 依赖，无法解析 PDF");
  }
  const data = await pdfParse(fs.readFileSync(filePath));
  return String(data.text || "");
}

function buildFileSummary(saved, text, meta) {
  const preview = text.slice(0, 3000);
  return [
    `# ${saved.name}`,
    "",
    `- 文件: ${saved.relativePath}`,
    `- 解析器: ${meta.parser}`,
    `- 字符数: ${text.length}`,
    `- 归档时间: ${meta.time}`,
    "",
    "## 文本预览",
    "",
    preview || "无可提取文本。"
  ].join("\n");
}

function isAtMessage(msg) {
  if (msg.post_type !== "message") {
    return false;
  }
  const segments = Array.isArray(msg.message) ? msg.message : [];
  return segments.some((seg) => {
    if (!seg || seg.type !== "at" || !seg.data) return false;
    const qq = String(seg.data.qq || "");
    return qq === "all" || qq === String(msg.self_id || "");
  });
}

function healthSnapshot() {
  return createHealthSnapshot({
    listenStates,
    listenPorts: LISTEN_PORTS,
    clients,
    upstreamReady: () => upstreamReady,
    upstreamState: () => upstream ? upstream.readyState : null,
    upstreamUrl: UPSTREAM_URL,
    allowedGroups: ALLOWED_GROUPS,
    allowedPrivateUsers: ALLOWED_PRIVATE_USERS,
    pending,
    pendingEchoPorts,
    pendingOutbound,
    pendingFileDownloads,
    botReplyRoutes,
    fileStats: getProxyFiles().stats,
    capabilities: readCapabilitySnapshot(CAPABILITY_FILE),
    recentErrors: readRecentErrors({ file: RECENT_ERROR_FILE, limit: 5, maskSensitive }),
    defaultListenMode: LISTEN_TRIGGER_MODE,
    listenModeByGroup,
    quietUntilByGroup,
    imageStates,
    privateRoutes: PRIVATE_ROUTES,
    atOnlyGroups: AT_ONLY_GROUPS,
    routeForGroup,
    maskID
  });
}

function refreshCapabilities() {
  writeCapabilitySnapshot({
    file: CAPABILITY_FILE,
    snapshot: createCapabilitySnapshot({
      upstreamReady: () => upstreamReady,
      clients,
      workspaceRoot: WORKSPACE_ROOT,
      workspaceForGroup,
      allowedGroups: ALLOWED_GROUPS,
      defaultListenMode: LISTEN_TRIGGER_MODE,
      dreamEnabled: DREAM_COMMAND_ENABLED,
      imageEnabled: IMAGE_COMMAND_ENABLED,
      imageScript: IMAGE_SCRIPT,
      renderScript: RENDER_SCRIPT,
      renderImageMagickScript: RENDER_IMAGEMAGICK_SCRIPT
    }),
    log
  });
}

function reloadRuntime() {
  listenModeByGroup.clear();
  quietUntilByGroup.clear();
  loadProxyState({
    file: PROXY_STATE_FILE,
    listenModes: listenModeByGroup,
    quietUntil: quietUntilByGroup,
    atOnlyGroups: AT_ONLY_GROUPS,
    log
  });
  refreshCapabilities();
  return "已重载 proxy state 和能力快照。";
}

function startProxyServers() {
  for (const port of LISTEN_PORTS) {
    const server = new WebSocket.Server({ host: "127.0.0.1", port });
    server.on("connection", (ws) => {
      clients.set(port, ws);
      log("client connected", port);
      refreshCapabilities();

      ws.on("message", (data) => {
        try {
          let obj = JSON.parse(data.toString());
          if (shouldSilenceOutgoing(obj)) {
            log("silence outgoing status", "port", port, "action", obj && obj.action);
            return;
          }
          const groupID = outgoingGroupID(obj);
          obj = prepareOutgoing(obj, port);
          obj = trackOutgoingAPI(obj, port);
          sendUpstream(obj);
          const route = routeForGroup(groupID);
          if (port === route.listenPort && isOutgoingMessageAction(obj) && ALLOWED_GROUPS.includes(groupID)) {
            scheduleListenRelease(groupID, obj.action);
          }
        } catch (err) {
          log("client parse error", err.message);
        }
      });
      ws.on("close", () => {
        clients.delete(port);
        log("client closed", port);
        refreshCapabilities();
      });
      ws.on("error", (err) => log("client error", port, err.message));
    });

    server.on("listening", () => {
      log("proxy listening", port, "allowed_groups", ALLOWED_GROUPS.join(","), "allowed_private", ALLOWED_PRIVATE_USERS.join(","), "listen_port", LISTEN_PORT, "at_port", AT_PORT);
    });
  }
}

if (require.main === module) {
  reloadRuntime();
  refreshCapabilities();
  startProxyServers();
  startHealthServer({
    host: HEALTH_HOST,
    port: HEALTH_PORT,
    snapshot: healthSnapshot,
    log
  });
  connectUpstream();
  setInterval(refreshCapabilities, Number(process.env.ONEBOT_CAPABILITY_REFRESH_MS || 60000)).unref();
}

module.exports = {
  shouldRenderAsImage,
  renderForQQ,
  enrichMessageForAgent,
  messageText,
  normalizeVisualMessage,
  normalizeVisualSegments,
  workspaceForGroup,
  workspaceForPrivateUser,
  executionWorkspaceForPrivateUser,
  explainRouteScope,
  shouldAdminPokeAck,
  adminPokePayload,
  WORKSPACE_ROOT,
  ADMIN_ROOT_USERS,
  ADMIN_POKE_ACK_USERS
};
