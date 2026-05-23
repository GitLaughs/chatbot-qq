const path = require("path");
const fs = require("fs");
const { execFile, execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

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

const LISTEN_PORTS = (process.env.ONEBOT_PROXY_PORTS || process.env.ONEBOT_PROXY_PORT || "3002,3003,3004,3005,3006")
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const UPSTREAM_URL = process.env.ONEBOT_UPSTREAM_URL || "ws://127.0.0.1:3001";
const ALLOWED_GROUPS = (process.env.ONEBOT_ALLOWED_GROUPS || process.env.ONEBOT_ALLOWED_GROUP || "")
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const ALLOWED_PRIVATE_USERS = (process.env.ONEBOT_ALLOWED_PRIVATE_USERS || "")
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
const WORKSPACE_ROOT = process.env.ONEBOT_WORKSPACE_ROOT || path.join(__dirname, "..", "groups");
const RENDER_SCRIPT = process.env.ONEBOT_RENDER_SCRIPT || path.join(__dirname, "render-qq-card.ps1");
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

let upstream = null;
const clients = new Map();
let upstreamReady = false;
const pending = [];
const listenStates = new Map();
const activeTriggers = new Map();
const pendingFileDownloads = new Map();
const pendingEchoPorts = new Map();
const pendingBotReplies = new Map();
const botReplyRoutes = new Map();
const dreamStates = new Map();
const imageStates = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sendUpstream(obj) {
  const raw = JSON.stringify(obj);
  if (upstream && upstream.readyState === WebSocket.OPEN && upstreamReady) {
    upstream.send(raw);
  } else {
    pending.push(raw);
  }
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
    return `${groupID}:${base}:${base + 1}`;
  }).join(",");

  source.split(",").map((p) => p.trim()).filter(Boolean).forEach((item) => {
    const [groupID, listenPort, atPort] = item.split(":").map((p) => Number(p.trim()));
    if (groupID && listenPort && atPort) {
      routes.set(groupID, { listenPort, atPort });
    }
  });
  return routes;
}

function parsePrivateRoutes(raw) {
  const routes = new Map();
  const source = raw || ALLOWED_PRIVATE_USERS.map((userID, index) => {
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
    setTimeout(connectUpstream, 2000);
  });

  upstream.on("error", (err) => {
    log("upstream error", err.message);
  });
}

function routeForGroup(groupID) {
  return GROUP_ROUTES.get(Number(groupID)) || { listenPort: LISTEN_PORT, atPort: AT_PORT };
}

function routeForPrivateUser(userID) {
  return PRIVATE_ROUTES.get(Number(userID));
}

function shouldDispatchListenMessage(msg) {
  if (LISTEN_TRIGGER_MODE === "all" || LISTEN_TRIGGER_MODE === "aggressive") {
    return true;
  }
  if (LISTEN_TRIGGER_MODE === "off" || LISTEN_TRIGGER_MODE === "none") {
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
  target.send(JSON.stringify(msg));
  return true;
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
  if (typeof msg.raw_message === "string" && msg.raw_message.trim()) {
    return msg.raw_message.trim();
  }

  const segments = Array.isArray(msg.message) ? msg.message : [];
  if (segments.length === 0 && typeof msg.message === "string") {
    return msg.message.trim();
  }

  return segments.map((seg) => {
    if (!seg || !seg.type) return "";
    if (seg.type === "text") return String((seg.data && seg.data.text) || "");
    if (seg.type === "image") return "[图片]";
    if (seg.type === "at") return `[@${(seg.data && seg.data.qq) || ""}]`;
    return `[${seg.type}]`;
  }).join("").trim() || "[非文本消息]";
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
      return;
    }
    sendGroupText(groupID, msg.message_id, renderForQQ(output || "梦醒了，但没有生成摘要。").slice(0, 1200));
    log("dream complete", "group", groupID);
  });

  child.on("error", (err) => {
    dreamStates.delete(key);
    sendGroupText(groupID, msg.message_id, `做梦启动失败：${err.message}`);
    log("dream spawn failed", "group", groupID, err.message);
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
  if (!IMAGE_COMMAND_ENABLED || msg.post_type !== "message" || msg.message_type !== "group") {
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
  const groupID = Number(msg.group_id);
  const workspace = workspaceForGroup(groupID);
  const prompt = imagePromptFromMessage(msg);
  const key = String(groupID);
  ackMessage(msg);

  if (!prompt) {
    sendGroupText(groupID, msg.message_id, "用法：/画图 一只赛博朋克风格的橘猫，雨夜街头，电影感");
    return;
  }
  if (imageStates.get(key)) {
    sendGroupText(groupID, msg.message_id, "正在画图，上一张还没生成完。");
    return;
  }

  imageStates.set(key, true);
  log("image start", "group", groupID, "msg", msg.message_id);

  const child = execFile(process.execPath, [IMAGE_SCRIPT, "--workspace", workspace, "--prompt", prompt], {
    cwd: workspace,
    timeout: Number(process.env.ONEBOT_IMAGE_TIMEOUT_MS || 600000),
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 8,
    env: {
      ...process.env,
      QQ_IMAGE_GROUP_ID: String(groupID),
      QQ_IMAGE_MESSAGE_ID: String(msg.message_id || ""),
      QQ_IMAGE_USER_ID: String(msg.user_id || "")
    }
  }, (err, stdout, stderr) => {
    imageStates.delete(key);
    if (err) {
      const detail = String(stdout || stderr || err.message).trim();
      sendGroupText(groupID, msg.message_id, renderForQQ(`画图失败：${detail}`).slice(0, 1200));
      log("image failed", "group", groupID, err.message);
      return;
    }

    let result;
    try {
      result = JSON.parse(String(stdout || "{}"));
    } catch {
      sendGroupText(groupID, msg.message_id, "画图失败：生成脚本没有返回有效结果。");
      return;
    }

    if (!result.imagePath || !fs.existsSync(result.imagePath)) {
      sendGroupText(groupID, msg.message_id, "画图失败：图片文件没有生成。");
      return;
    }

    sendGroupImage(groupID, msg.message_id, result.imagePath, imageResultText(result));
    log("image complete", "group", groupID, path.basename(result.imagePath));
  });

  child.on("error", (err) => {
    imageStates.delete(key);
    sendGroupText(groupID, msg.message_id, `画图启动失败：${err.message}`);
    log("image spawn failed", "group", groupID, err.message);
  });
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

function handleImageSendResponse(resp) {
  const ok = resp && (resp.status === "ok" || resp.retcode === 0);
  if (ok) {
    log("image send ok", "echo", resp.echo, "msg", responseMessageID(resp) || "");
    return;
  }
  log("image send failed", "echo", resp && resp.echo, "retcode", resp && resp.retcode, "message", (resp && (resp.message || resp.wording)) || "");
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
  return /(\$\$?|\\frac|\\sum|\\int|\\sqrt|\\begin\{|[∑√∫≤≥≈≠∞]|[a-zA-Z]\^\{?[-+\w]+\}?|[a-zA-Z]_\{?[-+\w]+\}?)/.test(s);
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
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", RENDER_SCRIPT,
      "-TextPath", textPath,
      "-OutPath", imagePath,
      "-Title", `QQ Bot - ${groupID}`
    ], { timeout: 30000, windowsHide: true });
    appendLine(path.join(workspace, "local_files", "INDEX.md"), `- ${new Date().toISOString()} 渲染答案图片: rendered/${path.basename(imagePath)}`);
    return imagePath;
  } catch (err) {
    log("render image failed", err.message);
    return null;
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
    return tracked;
  }
  if (!ALLOWED_GROUPS.includes(groupID)) {
    return obj;
  }

  const echo = typeof obj.echo === "string" && obj.echo ? obj.echo : `__botreply_${groupID}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tracked = obj.echo === echo ? obj : { ...obj, echo };
  pendingBotReplies.set(echo, { groupID, port: sourcePort, ts: Date.now() });
  pendingEchoPorts.set(echo, sourcePort);
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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${line}\n`, "utf8");
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
  const record = {
    time: new Date().toISOString(),
    group_id: String(msg.group_id),
    message_id: String(msg.message_id),
    user_id: String(msg.user_id || ""),
    sender: msg.sender || {},
    text: messageText(msg),
    has_image: Array.isArray(msg.message) && msg.message.some((seg) => seg && seg.type === "image"),
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
    has_image: Array.isArray(msg.message) && msg.message.some((seg) => seg && seg.type === "image"),
    raw_message: msg.raw_message || ""
  };
  appendLine(path.join(workspace, "memory", `chat-${todayLocal()}.jsonl`), JSON.stringify(record));
  touchPrivateProfile(workspace, msg);
}

function touchPrivateProfile(workspace, msg) {
  const sender = msg.sender || {};
  const userID = String(msg.user_id || "unknown");
  const display = String(sender.nickname || sender.card || userID);
  const file = path.join(workspace, "PROFILE.md");
  if (!fs.existsSync(file)) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, [
      `# ${display}`,
      "",
      `- QQ: ${userID}`,
      `- 首次记录: ${new Date().toISOString()}`,
      "- 回复偏好: 待观察",
      "- 长期目标/任务: 待观察",
      "- 重要背景:",
      "- 未完成事项:",
      "",
      "## 最近观察",
      ""
    ].join("\n"), "utf8");
  }
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
    });
    return [rel];
  } catch (err) {
    log("private pdf save failed", msg.user_id, name, err.message);
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
  fs.writeFileSync(path.join(sidecarDir, "extracted.txt"), extracted, "utf8");
  fs.writeFileSync(path.join(sidecarDir, "summary.md"), buildFileSummary({ path: target, relativePath: rel, name: path.basename(target) }, extracted, meta), "utf8");
  appendLine(path.join(workspace, "memory", `file-archive-${todayLocal()}.jsonl`), JSON.stringify({
    time: new Date().toISOString(),
    user_id: String(msg.user_id || ""),
    file: rel,
    extracted_chars: extracted.length,
    summary: path.relative(workspace, path.join(sidecarDir, "summary.md")).replace(/\\/g, "/")
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
      "- 性格/偏好: 待观察",
      "- 重要信息:",
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
  const workspace = workspaceForGroup(msg.group_id);
  const fileInfo = msg.file || {};
  const event = {
    time: new Date().toISOString(),
    type: "group_upload",
    group_id: String(msg.group_id),
    user_id: String(msg.user_id || ""),
    file: fileInfo
  };
  appendLine(path.join(workspace, "memory", `file-events-${todayLocal()}.jsonl`), JSON.stringify(event));
  appendLine(path.join(workspace, "local_files", "INDEX.md"), `- ${new Date().toISOString()} 上传: ${fileInfo.name || fileInfo.id || "unknown"} (${fileInfo.size || "unknown"} bytes)`);

  const fileID = fileInfo.id || fileInfo.file_id;
  if (!fileID) {
    log("group upload no file id", msg.group_id);
    return;
  }
  const echo = `__file_${msg.group_id}_${Date.now()}`;
  pendingFileDownloads.set(echo, { groupID: Number(msg.group_id), fileName: fileInfo.name || fileID, messageID: msg.message_id || "", fileInfo });
  sendUpstream({
    action: "get_file",
    params: { file_id: String(fileID) },
    echo
  });
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
  const workspace = workspaceForGroup(pendingInfo.groupID);
  const saved = saveGroupFileData(workspace, pendingInfo, { ...pendingInfo.fileInfo, ...data, source });
  if (saved) {
    appendLine(path.join(workspace, "local_files", "INDEX.md"), `- ${new Date().toISOString()} 已归档: ${saved.relativePath}`);
    log("file archived", pendingInfo.groupID, saved.relativePath);
    archiveSavedFile(workspace, saved, pendingInfo).then((result) => {
      if (result && result.notice) {
        sendGroupText(pendingInfo.groupID, pendingInfo.messageID || 0, result.notice);
      }
    }).catch((err) => {
      log("file archive parse failed", pendingInfo.groupID, saved.relativePath, err.message);
      sendGroupText(pendingInfo.groupID, pendingInfo.messageID || 0, `文件已归档，但解析失败：${saved.relativePath}\n${err.message}`);
    });
    return;
  }
  appendLine(path.join(workspace, "local_files", "INDEX.md"), `- ${new Date().toISOString()} 文件待手动获取: ${pendingInfo.fileName}; get_file=${JSON.stringify(data)}`);
  log("file metadata saved", pendingInfo.groupID, pendingInfo.fileName);
}

function saveGroupFileData(workspace, pendingInfo, data) {
  const rawName = data.name || data.file_name || pendingInfo.fileName || data.file || data.file_id || `upload-${Date.now()}`;
  const name = safeName(rawName);
  const dir = path.join(workspace, "local_files", "archive", todayLocal());
  ensureDir(dir);
  const target = uniquePath(path.join(dir, name));
  const source = data.source || data.path || data.file || data.url;
  try {
    if (source && typeof source === "string" && fs.existsSync(source)) {
      fs.copyFileSync(source, target);
    } else if (source && /^file:\/\//i.test(source)) {
      fs.copyFileSync(new URL(source), target);
    } else if (source && /^https?:\/\//i.test(source)) {
      execFileSync("curl", ["-fsSL", "-o", target, source], { timeout: 180000 });
    } else {
      return null;
    }
    const relativePath = path.relative(workspace, target).replace(/\\/g, "/");
    appendLine(path.join(workspace, "memory", `file-events-${todayLocal()}.jsonl`), JSON.stringify({
      time: new Date().toISOString(),
      type: "group_file_archived",
      group_id: String(pendingInfo.groupID),
      file: { ...data, local_path: relativePath }
    }));
    return { path: target, relativePath, name: path.basename(target) };
  } catch (err) {
    log("group file save failed", pendingInfo.groupID, name, err.message);
    return null;
  }
}

function uniquePath(target) {
  if (!fs.existsSync(target)) {
    return target;
  }
  const parsed = path.parse(target);
  for (let i = 2; i < 1000; i += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
}

async function archiveSavedFile(workspace, saved, pendingInfo) {
  const ext = path.extname(saved.path).toLowerCase();
  const sidecarDir = `${saved.path}.archive`;
  ensureDir(sidecarDir);
  const meta = {
    time: new Date().toISOString(),
    group_id: String(pendingInfo.groupID),
    original_name: pendingInfo.fileName,
    file: saved.relativePath,
    size: fs.statSync(saved.path).size,
    parser: "none"
  };

  let extracted = "";
  if (ext === ".pdf") {
    extracted = await extractPdfText(saved.path);
    meta.parser = "pdf-parse";
  } else if ([".txt", ".md", ".csv", ".json", ".log"].includes(ext)) {
    extracted = fs.readFileSync(saved.path, "utf8");
    meta.parser = "text";
  }

  fs.writeFileSync(path.join(sidecarDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  if (extracted) {
    const clean = extracted.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
    fs.writeFileSync(path.join(sidecarDir, "extracted.txt"), clean, "utf8");
    fs.writeFileSync(path.join(sidecarDir, "summary.md"), buildFileSummary(saved, clean, meta), "utf8");
    appendLine(path.join(workspace, "memory", `file-archive-${todayLocal()}.jsonl`), JSON.stringify({
      time: new Date().toISOString(),
      group_id: String(pendingInfo.groupID),
      file: saved.relativePath,
      extracted_chars: clean.length,
      summary: path.relative(workspace, path.join(sidecarDir, "summary.md")).replace(/\\/g, "/")
    }));
    return { notice: `文件已自动下载并解析归档：${saved.relativePath}\n提取文本：${path.relative(workspace, path.join(sidecarDir, "extracted.txt")).replace(/\\/g, "/")}` };
  }
  return { notice: `文件已自动下载归档：${saved.relativePath}` };
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

for (const port of LISTEN_PORTS) {
  const server = new WebSocket.Server({ host: "127.0.0.1", port });
  server.on("connection", (ws) => {
    clients.set(port, ws);
    log("client connected", port);

    ws.on("message", (data) => {
      try {
        let obj = JSON.parse(data.toString());
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
    });
    ws.on("error", (err) => log("client error", port, err.message));
  });

  server.on("listening", () => {
    log("proxy listening", port, "allowed_groups", ALLOWED_GROUPS.join(","), "allowed_private", ALLOWED_PRIVATE_USERS.join(","), "listen_port", LISTEN_PORT, "at_port", AT_PORT);
  });
}

connectUpstream();
