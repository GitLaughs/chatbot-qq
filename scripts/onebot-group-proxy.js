const path = require("path");
const fs = require("fs");
const { execFile, execFileSync } = require("child_process");
const { createHealthSnapshot, startHealthServer } = require("./lib/proxy-health");
const { loadProxyState, saveProxyState } = require("./lib/proxy-state");
const { createProxyCommands } = require("./lib/proxy-commands");
const { createProxyFiles } = require("./lib/proxy-files");
const { createPluginManager } = require("./lib/plugin-manager");
const { appendRecentError, readRecentErrors } = require("./lib/recent-errors");
const { archiveAcademicTaskResult, formatAcademicArchiveMatches, looksLikeAcademicSearch, searchAcademicArchive } = require("./lib/academic-archive");
const { createCapabilitySnapshot, readCapabilitySnapshot, writeCapabilitySnapshot } = require("./lib/capabilities");
const { addFileIndex, recentFiles } = require("./lib/file-index");
const { resolveReadableFilePath } = require("./lib/napcat-paths");
const { buildTaskAgentContext, preparedFileTaskParse } = require("./lib/task-agent-context");
const { createTaskRequest, findAwaitingInputTask, findTaskRequestByID, findTaskRequestsByMessage, readTaskReceipt, updateTaskRequest, writeTaskReceipt } = require("./lib/task-request-store");
const { dueCourseNotifications } = require("./lib/course-scheduler");
const { dueReminders } = require("./lib/reminder-scheduler");
const { dueRotas, formatRotaCreated, parseRotaRequest } = require("./lib/rota-scheduler");
const { continuePendingRotaTask, startPendingRotaTask } = require("./lib/rota-followup");
const { executeNaturalTask } = require("./lib/task-agent-pipeline");
const { createRotaFromText, formatRotaFallbackFailure } = require("./lib/rota-task-fallback");
const { classifyTask, looksLikeWeeklyRota } = require("./lib/task-intent-router");
const { runScriptTaskChecks } = require("./lib/script-task-checker");
const { evaluatePromptInjectionRisk } = require("./lib/prompt-injection-guard");
const { parseTaskWithModel } = require("./task-agent");
const { maskSensitive, redactSecrets } = require("./lib/sensitive-redaction");
const { trackActivity, detectGap, buildContinuityContext, buildReplyChainContext, buildMemoryContextForMessage, replyChainMessageIDs, activitySnapshot } = require("./lib/conversation-context");
const { deterministicTidy } = require("./lib/memory-tidy");
const { updatePrivateMood, updateGroupEnergy, formatMoodContext, formatGroupEnergyContext, readMoodState, readGroupEnergyState } = require("./lib/mood-tracker");
const { detectFeedbackSignal, recordFeedbackSignal, feedbackStats, readSignals, formatFeedbackContext } = require("./lib/feedback-detector");
const { evaluateGroupEngagement, evaluatePrivateCheckin, buildProactiveContext, formatPrivateCheckinMessage, setProactivityLevel, proactivitySnapshot, formatProactivityStatus } = require("./lib/proactive-engager");
const { appendJSONL, readJSONLShards } = require("./lib/jsonl-shards");

let messagesSinceLastTidy = 0;
let lastTidyTime = Date.now();

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

const ADMIN_ROOT_USERS = (process.env.ONEBOT_ADMIN_ROOT_USERS || "100000001")
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const LISTEN_PORTS = (process.env.ONEBOT_PROXY_PORTS || process.env.ONEBOT_PROXY_PORT || "3002,3003,3005,3006,3007,3008,3009,3011")
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const UPSTREAM_URL = process.env.ONEBOT_UPSTREAM_URL || "ws://127.0.0.1:3001";
const ALLOWED_GROUPS = (process.env.ONEBOT_ALLOWED_GROUPS || process.env.ONEBOT_ALLOWED_GROUP || "123456789,234567890")
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const ALLOWED_PRIVATE_USERS = (process.env.ONEBOT_ALLOWED_PRIVATE_USERS || "100000002,100000003,100000004,100000005,100000001")
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
const AT_ONLY_GROUPS = (process.env.ONEBOT_AT_ONLY_GROUPS || "234567890")
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const SILENT_FILE_GROUPS = (process.env.ONEBOT_SILENT_FILE_GROUPS || ALLOWED_GROUPS.join(","))
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const MINIMAL_LISTEN_GROUPS = (process.env.ONEBOT_MINIMAL_LISTEN_GROUPS || "")
  .split(",")
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const LISTEN_PORT = Number(process.env.ONEBOT_LISTEN_PORT || 3002);
const AT_PORT = Number(process.env.ONEBOT_AT_PORT || 3003);
const VIVADO_TASK_PORT = Number(process.env.ONEBOT_VIVADO_TASK_PORT || process.env.ONEBOT_HEAVY_TASK_PORT || 0);
const GROUP_ROUTES = parseGroupRoutes(process.env.ONEBOT_GROUP_ROUTES);
const PRIVATE_ROUTES = parsePrivateRoutes(process.env.ONEBOT_PRIVATE_ROUTES);
const ACK_EMOJI_ID = String(process.env.ONEBOT_ACK_EMOJI_ID || "76");
const LISTEN_RELEASE_DELAY_MS = Number(process.env.ONEBOT_LISTEN_RELEASE_DELAY_MS || 1500);
const LISTEN_BUSY_TIMEOUT_MS = Number(process.env.ONEBOT_LISTEN_BUSY_TIMEOUT_MS || 180000);
const HEALTH_HOST = process.env.ONEBOT_HEALTH_HOST || "127.0.0.1";
const HEALTH_PORT = Number(process.env.ONEBOT_HEALTH_PORT || 13110);
const OUTGOING_RETRY_MAX = Math.max(0, Number(process.env.ONEBOT_OUTGOING_RETRY_MAX || 2));
const OUTGOING_RESPONSE_TIMEOUT_MS = Math.max(1000, Number(process.env.ONEBOT_OUTGOING_RESPONSE_TIMEOUT_MS || 12000));
const OUTGOING_RETRY_BASE_DELAY_MS = Math.max(200, Number(process.env.ONEBOT_OUTGOING_RETRY_BASE_DELAY_MS || 1200));
const WORKSPACE_ROOT = process.env.ONEBOT_WORKSPACE_ROOT || path.join(__dirname, "..", "groups");
const PROXY_STATE_FILE = process.env.ONEBOT_PROXY_STATE_FILE || path.join(path.dirname(WORKSPACE_ROOT), ".cc-connect", "onebot-proxy-state.json");
const RUNTIME_DIR = process.env.ONEBOT_RUNTIME_DIR || path.join(path.dirname(WORKSPACE_ROOT), ".cc-connect");
const RECENT_ERROR_FILE = process.env.ONEBOT_RECENT_ERROR_FILE || path.join(RUNTIME_DIR, "recent-errors.jsonl");
const CAPABILITY_FILE = process.env.ONEBOT_CAPABILITY_FILE || path.join(RUNTIME_DIR, "capabilities.json");
const RENDER_TEXT_LIMIT = Math.max(20, Number(process.env.ONEBOT_RENDER_TEXT_LIMIT || 100));
const RENDER_SCRIPT = process.env.ONEBOT_RENDER_SCRIPT || path.join(__dirname, "render-qq-card.ps1");
const RENDER_IMAGEMAGICK_SCRIPT = process.env.ONEBOT_RENDER_IMAGEMAGICK_SCRIPT || path.join(__dirname, "render-qq-card-imagemagick.js");
const OUTGOING_FILE_UPLOAD_ENABLED = !["0", "false", "no"].includes(String(process.env.ONEBOT_OUTGOING_FILE_UPLOAD_ENABLED || "1").toLowerCase());
const OUTGOING_FILE_UPLOAD_MAX_BYTES = Math.max(1024, Number(process.env.ONEBOT_OUTGOING_FILE_UPLOAD_MAX_BYTES || 50 * 1024 * 1024));
const OUTGOING_FILE_UPLOAD_MAX_FILES = Math.max(1, Math.min(20, Number(process.env.ONEBOT_OUTGOING_FILE_UPLOAD_MAX_FILES || 5)));
const OUTGOING_FILE_OUTBOX_SCAN_INTERVAL_MS = Math.max(5000, Number(process.env.ONEBOT_OUTGOING_FILE_OUTBOX_SCAN_INTERVAL_MS || 15000));
const PENDING_FILE_RETRY_DELAY_MS = Math.max(0, Number(process.env.ONEBOT_PENDING_FILE_RETRY_DELAY_MS || 4000));
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
const IMAGE_KEY_POOL_MAX = Math.max(1, Number(process.env.ONEBOT_IMAGE_KEY_POOL_MAX || 4));
const TASK_AGENT_TIMEZONE = process.env.QQ_TASK_TIMEZONE || "Asia/Shanghai";
const imageCredentials = parseImageCredentials(process.env, IMAGE_KEY_POOL_MAX);
let nextImageCredentialIndex = 0;
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
const MINIMAL_LISTEN_KEYWORDS = (process.env.ONEBOT_MINIMAL_LISTEN_KEYWORDS || "bot,机器人,助手,codex,qqbot,qq bot,写不完作业")
  .split(",")
  .map((p) => p.trim().toLowerCase())
  .filter(Boolean);
const GROUP_TRIGGER_KEYWORD_FILE = process.env.ONEBOT_GROUP_TRIGGER_KEYWORD_FILE || "trigger_keywords.txt";
const PROFILE_REPLY_MARKERS = (process.env.ONEBOT_PROFILE_REPLY_MARKERS || "触发回复,需要回复,关注点,未解决,重要信息")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const CONTINUITY_ENABLED = !["0", "false", "no"].includes(String(process.env.ONEBOT_CONTINUITY_ENABLED || "1").toLowerCase());
const CONTINUITY_GAP_MINUTES = Math.max(1, Number(process.env.ONEBOT_CONTINUITY_GAP_MINUTES || 30));
const CONTINUITY_MESSAGE_LIMIT = Math.max(1, Math.min(30, Number(process.env.ONEBOT_CONTINUITY_MESSAGE_LIMIT || 10)));
const MOOD_ENABLED = !["0", "false", "no"].includes(String(process.env.ONEBOT_MOOD_ENABLED || "1").toLowerCase());
const MOOD_HISTORY_LIMIT = Math.max(1, Math.min(50, Number(process.env.ONEBOT_MOOD_HISTORY_LIMIT || 10)));
const ENERGY_WINDOW_MS = Math.max(30000, Number(process.env.ONEBOT_ENERGY_WINDOW_MS || 300000));
const FEEDBACK_ENABLED = !["0", "false", "no"].includes(String(process.env.ONEBOT_FEEDBACK_ENABLED || "1").toLowerCase());
const FEEDBACK_WINDOW_SECONDS = Math.max(30, Number(process.env.ONEBOT_FEEDBACK_WINDOW_SECONDS || 300));
const PROACTIVE_ENABLED = !["0", "false", "no"].includes(String(process.env.ONEBOT_PROACTIVE_ENABLED || "1").toLowerCase());
const PROACTIVE_LEVEL = String(process.env.ONEBOT_PROACTIVE_LEVEL || "normal").toLowerCase();
const PROACTIVE_COOLDOWN_MS = Math.max(60000, Number(process.env.ONEBOT_PROACTIVE_COOLDOWN_MS || 900000));
const PROACTIVE_CHECKIN_HOURS = Math.max(1, Number(process.env.ONEBOT_PROACTIVE_CHECKIN_HOURS || 4));
const PROACTIVE_CHECKIN_INTERVAL_MS = Math.max(300000, Number(process.env.ONEBOT_PROACTIVE_CHECKIN_INTERVAL_MS || 1800000));
const ROTA_CHECK_INTERVAL_MS = Math.max(10000, Number(process.env.ONEBOT_ROTA_CHECK_INTERVAL_MS || 60000));
const REMINDER_CHECK_INTERVAL_MS = Math.max(10000, Number(process.env.ONEBOT_REMINDER_CHECK_INTERVAL_MS || 60000));
const COURSE_CHECK_INTERVAL_MS = Math.max(10000, Number(process.env.ONEBOT_COURSE_CHECK_INTERVAL_MS || REMINDER_CHECK_INTERVAL_MS));
const ENRICH_CONTEXT_MAX_CHARS = Math.max(500, Number(process.env.ONEBOT_ENRICH_CONTEXT_MAX_CHARS || 3500));
const ENRICH_CONTEXT_PART_MAX_CHARS = Math.max(200, Number(process.env.ONEBOT_ENRICH_CONTEXT_PART_MAX_CHARS || 900));
const RECENT_GROUP_FILE_CONTEXT_MINUTES = Math.max(1, Number(process.env.ONEBOT_RECENT_GROUP_FILE_CONTEXT_MINUTES || 10));
const SILENCED_OUTGOING_PATTERNS = [
  "因空闲超过 30 分钟，已自动切换到新会话",
  "正在结束上一个会话",
  "新会话将自动启动"
];
const SILENT_REPLY_SENTINELS = [
  "不需要回复awa"
];
const pluginManager = createPluginManager({
  pluginDirs: [
    path.join(path.dirname(WORKSPACE_ROOT), "plugins")
  ],
  configFiles: [
    process.env.ONEBOT_PLUGIN_CONFIG,
    path.join(path.dirname(WORKSPACE_ROOT), "configs", "plugins.json"),
    process.env.ONEBOT_PLUGIN_LOCAL_CONFIG,
    path.join(RUNTIME_DIR, "plugins.local.json")
  ],
  localConfigFile: process.env.ONEBOT_PLUGIN_LOCAL_CONFIG || path.join(RUNTIME_DIR, "plugins.local.json"),
  plugins: [
    {
      id: "dream",
      title: "dream",
      enabled: DREAM_COMMAND_ENABLED,
      settings: { triggers: DREAM_TRIGGERS }
    },
    {
      id: "image",
      title: "画图",
      enabled: IMAGE_COMMAND_ENABLED,
      settings: {
        triggers: IMAGE_TRIGGERS,
        max_concurrent_per_group: IMAGE_MAX_CONCURRENT_PER_GROUP,
        queue_max_per_group: IMAGE_QUEUE_MAX_PER_GROUP
      }
    }
  ],
  log
});
let upstream = null;
const clients = new Map();
let upstreamReady = false;
const pending = [];
const listenStates = new Map();
const activeTriggers = new Map();
const pendingFileDownloads = new Map();
const pendingPrivatePdfRetryKeys = new Set();
const pendingEchoPorts = new Map();
const pendingBotReplies = new Map();
const pendingOutbound = new Map();
const pendingFileUploads = new Map();
const botReplyRoutes = new Map();
const activeTriggerMessages = new Map();
const dreamStates = new Map();
const imageStates = new Map();
const quietUntilByGroup = new Map();
const listenModeByGroup = new Map();
const proactiveLevelByGroup = new Map();
const recentBotReplies = [];
const recentOutgoingFileUploads = new Map();
const proactiveEvaluationsByGroup = new Map();
const privateCheckinAtByUser = new Map();
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

function envList(value) {
  return String(value || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function parseImageCredentials(env, maxItems = 4) {
  const keys = envList(env.OPENAI_IMAGE_API_KEYS || env.QQ_OPENTOKEN_POOL_KEYS || env.OPENAI_IMAGE_API_KEY || env.OPENAI_API_KEY);
  const bases = envList(env.OPENAI_IMAGE_BASE_URLS || env.QQ_OPENTOKEN_BASE_URLS || env.OPENAI_BASE_URL || env.OPENAI_API_BASE);
  const seen = new Set();
  const slots = [];
  for (const key of keys) {
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const index = slots.length;
    slots.push({
      id: `image-key-${index + 1}`,
      apiKey: key,
      baseUrl: (bases[index] || bases[0] || "").replace(/\/+$/, ""),
      active: false
    });
    if (slots.length >= maxItems) {
      break;
    }
  }
  return slots;
}

function acquireImageCredential() {
  if (!imageCredentials.length) {
    return null;
  }
  for (let offset = 0; offset < imageCredentials.length; offset += 1) {
    const index = (nextImageCredentialIndex + offset) % imageCredentials.length;
    const slot = imageCredentials[index];
    if (!slot.active) {
      slot.active = true;
      nextImageCredentialIndex = (index + 1) % imageCredentials.length;
      return slot;
    }
  }
  return null;
}

function releaseImageCredential(slot) {
  if (slot) {
    slot.active = false;
  }
}

function pumpAllImageQueues() {
  for (const key of imageStates.keys()) {
    pumpImageQueue(key);
  }
}

function maskID(value) {
  const s = String(value);
  if (s.length <= 5) {
    return s;
  }
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function pluginContextForMessage(msg) {
  if (!msg) {
    return {};
  }
  if (msg.message_type === "group") {
    return { groupID: Number(msg.group_id), userID: Number(msg.user_id || 0) };
  }
  if (msg.message_type === "private") {
    return { userID: Number(msg.user_id || 0) };
  }
  return {};
}

function pluginTriggers(id, fallback) {
  const value = pluginManager.settings(id).triggers;
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  const normalized = list.map((item) => String(item).trim()).filter(Boolean);
  return normalized.length ? normalized : fallback;
}

function pluginNumberSetting(id, name, fallback, min, max) {
  const raw = pluginManager.settings(id)[name];
  const parsed = Number(raw);
  let value = Number.isFinite(parsed) ? parsed : fallback;
  if (Number.isFinite(min)) {
    value = Math.max(min, value);
  }
  if (Number.isFinite(max)) {
    value = Math.min(max, value);
  }
  return value;
}

function pluginContextForRuntime(extra = {}) {
  const msg = extra.msg || null;
  const base = {
    ...pluginContextForMessage(msg),
    msg,
    text: msg ? messageText(msg) : "",
    now: extra.now || new Date(),
    event: extra.event || "",
    workspace: msg ? workspaceForPluginMessage(msg) : "",
    projectRoot: path.dirname(WORKSPACE_ROOT),
    api: pluginApi(),
    log,
    recordError,
    maskSensitive,
  };
  return { ...base, ...extra };
}

function workspaceForPluginMessage(msg) {
  if (!msg) {
    return "";
  }
  if (msg.message_type === "group") {
    return workspaceForGroup(msg.group_id);
  }
  if (msg.message_type === "private") {
    return workspaceForPrivateUser(msg.user_id);
  }
  return "";
}

function pluginApi() {
  return {
    sendMessage: (msg, text) => {
      if (!msg) {
        return false;
      }
      if (msg.message_type === "group") {
        sendGroupText(msg.group_id, msg.message_id || 0, text);
        return true;
      }
      if (msg.message_type === "private") {
        sendPrivateText(msg.user_id, msg.message_id || 0, text);
        return true;
      }
      return false;
    },
    runCommand: (name, ...args) => {
      log("plugin api runCommand", name);
      if (name === "image.handle") {
        return handleImageCommand(args[0], args[1]);
      }
      if (name === "dream.handle") {
        return handleDreamCommand(args[0]);
      }
      throw new Error(`unknown plugin command: ${name}`);
    },
    schedule: (name, ...args) => {
      if (name === "reminder.runDue") {
        return runDueReminders(args[0]);
      }
      throw new Error(`unknown plugin schedule: ${name}`);
    },
    health: (name, ctx) => {
      if (name === "image") {
        return imagePluginHealth(ctx);
      }
      if (name === "dream") {
        return dreamPluginHealth(ctx);
      }
      if (name === "reminder") {
        return { ok: true, detail: "scheduled reminder hook registered" };
      }
      return { ok: false, detail: `unknown plugin health: ${name}` };
    },
  };
}

async function tryHandlePluginMessage(msg) {
  const handled = await pluginManager.firstHandledAsync("onMessage", pluginContextForRuntime({ msg }));
  if (!handled) {
    return false;
  }
  if (handled.result && handled.result.error) {
    recordError("plugin", handled.result.error, { scope: msg.message_type || "", target: String(msg.group_id || msg.user_id || ""), detail: handled.plugin });
    return false;
  }
  return true;
}

async function runPluginSchedule(event, now = new Date()) {
  return pluginManager.invokeAsync("onSchedule", pluginContextForRuntime({ event, now }));
}

function persistProxyState() {
  saveProxyState({
    file: PROXY_STATE_FILE,
    listenModes: listenModeByGroup,
    quietUntil: quietUntilByGroup,
    proactiveLevels: proactiveLevelByGroup,
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
      activeTriggerMessages,
      listenModeByGroup,
      proactiveLevelByGroup,
      continuityStatus,
      moodStatus,
      feedbackStatus,
      proactiveStatus,
      setProactivityLevelForGroup,
      resetConversation,
      maskSensitive,
      recentErrorFile: RECENT_ERROR_FILE,
      capabilitySnapshot: () => readCapabilitySnapshot(CAPABILITY_FILE),
      pluginSnapshot: () => pluginManager.snapshot(),
      checkPluginHealth: (id) => {
        pluginManager.checkHealth(id || "", pluginContextForRuntime({ event: "admin_health" }));
        refreshCapabilities();
        return pluginManager.snapshot();
      },
      reloadPlugins: () => {
        pluginManager.reload();
        refreshCapabilities();
        return pluginManager.snapshot();
      },
      enablePlugin: (id) => {
        const item = pluginManager.setEnabled(id, true);
        refreshCapabilities();
        return item;
      },
      disablePlugin: (id) => {
        const item = pluginManager.setEnabled(id, false);
        refreshCapabilities();
        return item;
      },
      setPluginScopedEnabled: (id, kind, scopeID, value) => {
        const item = pluginManager.setScopedEnabled(id, kind, scopeID, value);
        refreshCapabilities();
        return item;
      },
      setPluginSetting: (id, key, value) => {
        const item = pluginManager.setSetting(id, key, value);
        refreshCapabilities();
        return item;
      },
      testPlugin: (id) => {
        const output = execFileSync(process.execPath, [path.join(__dirname, "test-plugins.js"), "--id", String(id || "")], {
          cwd: path.dirname(WORKSPACE_ROOT),
          encoding: "utf8",
          timeout: 120000,
          windowsHide: true,
        });
        return output.trim();
      },
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
      shouldSilenceGroupFileNotice,
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
    const retryTimer = setTimeout(retryPendingPrivatePdfDownloads, PENDING_FILE_RETRY_DELAY_MS);
    if (retryTimer.unref) retryTimer.unref();
    drainFileOutboxes();
    flushPending();
  });

  upstream.on("message", async (data) => {
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
    if (typeof msg.echo === "string" && msg.echo.startsWith("__upload_file_")) {
      handleOutgoingFileUploadResponse(msg);
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
    if (isAllowedGroupNotice && msg.notice_type === "group_increase") {
      handleGroupIncrease(msg);
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
      if (shouldSilenceAtOnlyGroupMessage(msg)) {
        log("skip at-only group", msg.group_id, "msg", msg.message_id, "reason", "no-at");
        return;
      }
      if (tryHandleTaskContinueCommand(msg)) {
        return;
      }
      if (isProxyCommand(msg)) {
        handleProxyCommand(msg);
        return;
      }
      if (tryHandleAcademicSearch(msg)) {
        return;
      }
      if (tryHandlePromptInjectionGuard(msg)) {
        return;
      }
      if (tryHandleRotaFollowup(msg)) {
        return;
      }
      if (tryDispatchHeavyTask(msg)) {
        return;
      }
      if (tryHandleNaturalTask(msg)) {
        return;
      }
      if (isRotaIntent(msg)) {
        handleRotaIntent(msg);
        return;
      }
      if (await tryHandlePluginMessage(msg)) {
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
        } else if (maybeHandleProactiveGroupMessage(msg)) {
          return;
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
      if (tryHandleTaskContinueCommand(msg)) {
        return;
      }
      if (isProxyCommand(msg)) {
        ackMessage(msg);
        handleProxyCommand(msg);
        return;
      }
      if (tryHandleAcademicSearch(msg)) {
        ackMessage(msg);
        return;
      }
      if (tryHandlePromptInjectionGuard(msg)) {
        return;
      }
      if (await tryHandlePluginMessage(msg)) {
        return;
      }
      if (tryDispatchHeavyTask(msg)) {
        return;
      }
      if (tryHandleNaturalTask(msg)) {
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

function shouldSilenceGroupFileNotice(groupID) {
  return SILENT_FILE_GROUPS.includes(Number(groupID));
}

function shouldSilenceAtOnlyGroupMessage(msg) {
  return msg &&
    msg.post_type === "message" &&
    msg.message_type === "group" &&
    AT_ONLY_GROUPS.includes(Number(msg.group_id)) &&
    !isAtMessage(msg);
}

function maybeHandleProactiveGroupMessage(msg) {
  if (msg.message_type !== "group") {
    return false;
  }
  if (!PROACTIVE_ENABLED) {
    recordProactiveEvaluation(msg.group_id, { outcome: "skip", reason: "disabled", confidence: 0, messageID: msg.message_id });
    return false;
  }
  if (isGroupQuiet(msg.group_id)) {
    recordProactiveEvaluation(msg.group_id, { outcome: "skip", reason: "quiet", confidence: 0, messageID: msg.message_id });
    return false;
  }
  const workspace = workspaceForGroup(msg.group_id);
  const result = evaluateGroupEngagement({
    workspace,
    groupID: msg.group_id,
    msg,
    level: proactiveLevelByGroup.get(Number(msg.group_id)) || PROACTIVE_LEVEL,
    cooldownMs: PROACTIVE_COOLDOWN_MS
  });
  recordProactiveEvaluation(msg.group_id, {
    outcome: result.shouldEngage ? "engage" : "skip",
    reason: result.reason,
    confidence: result.confidence,
    topic: result.topic,
    messageID: msg.message_id
  });
  if (!result.shouldEngage) {
    return false;
  }
  const route = routeForGroup(msg.group_id);
  const enriched = {
    ...msg,
    __proactive_context: buildProactiveContext(result)
  };
  log("proactive listen", "group", msg.group_id, "msg", msg.message_id, "reason", result.reason, "confidence", result.confidence);
  handleListenMessage(enriched);
  return true;
}

function recordProactiveEvaluation(groupID, item) {
  const key = String(groupID || "");
  const list = proactiveEvaluationsByGroup.get(key) || [];
  list.push({
    time: new Date().toISOString(),
    outcome: item.outcome || "skip",
    reason: item.reason || "unknown",
    confidence: Number(item.confidence || 0),
    topic: String(item.topic || "").slice(0, 80),
    messageID: String(item.messageID || "")
  });
  proactiveEvaluationsByGroup.set(key, list.slice(-5));
}

function shouldDispatchListenMessage(msg) {
  if (routedReplyPort(msg) || isAtMessage(msg)) {
    return true;
  }
  const text = messageText(msg).trim();
  if (!text || text === "[非文本消息]") {
    return false;
  }
  if (naturalTaskRouteForMessage(msg).kind === "task") {
    return true;
  }
  if (AT_ONLY_GROUPS.includes(Number(msg.group_id))) {
    return false;
  }
  const lower = text.toLowerCase();
  if (MINIMAL_LISTEN_GROUPS.includes(Number(msg.group_id))) {
    return MINIMAL_LISTEN_KEYWORDS.some((keyword) => lower.includes(keyword));
  }
  const mode = effectiveListenMode(msg.group_id);
  if (mode === "all" || mode === "aggressive") {
    return true;
  }
  if (mode === "mention" || mode === "at" || mode === "off" || mode === "none") {
    return false;
  }
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
  rememberActiveTriggerMessage(port, msg);
  target.send(JSON.stringify(enrichMessageForAgent(msg)));
  return true;
}

function dispatchControlCommandToPort(port, msg, commandText) {
  const target = clients.get(port);
  if (!target || target.readyState !== WebSocket.OPEN) {
    log("drop no client", port, "control", commandText || "", "msg", msg.message_id || "");
    return false;
  }
  if (msg.post_type === "message" && msg.message_type === "group") {
    activeTriggers.set(triggerKey(port, msg.group_id), Number(msg.message_id));
  }
  rememberActiveTriggerMessage(port, msg);
  target.send(JSON.stringify(controlCommandPayload(msg, commandText)));
  return true;
}

function controlCommandPayload(msg, commandText) {
  const text = String(commandText || "").trim();
  return {
    ...msg,
    raw_message: text,
    message: [{ type: "text", data: { text } }]
  };
}

function dispatchToPortWhenReady(port, msg, attempts = 6) {
  const target = clients.get(port);
  if (target && target.readyState === WebSocket.OPEN) {
    return dispatchToPort(port, msg);
  }
  if (attempts <= 0) {
    return dispatchToPort(port, msg);
  }
  const timer = setTimeout(() => dispatchToPortWhenReady(port, msg, attempts - 1), 1000);
  if (timer.unref) timer.unref();
  return false;
}

function rememberActiveTriggerMessage(port, msg) {
  if (!msg || msg.post_type !== "message") {
    return;
  }
  const id = msg.message_type === "private" ? msg.user_id : msg.group_id;
  if (id === undefined || id === null) {
    return;
  }
  activeTriggerMessages.set(triggerKey(port, id), {
    message_id: String(msg.message_id || ""),
    time: new Date().toISOString(),
    message_type: msg.message_type,
    group_id: msg.group_id,
    user_id: msg.user_id,
    text: messageText(msg),
    raw_message: msg.raw_message || messageText(msg)
  });
  if (activeTriggerMessages.size > 500) {
    const entries = [...activeTriggerMessages.entries()].slice(0, activeTriggerMessages.size - 400);
    for (const [key] of entries) {
      activeTriggerMessages.delete(key);
    }
  }
}

function enrichMessageForAgent(msg) {
  if (!msg || msg.post_type !== "message") {
    return msg;
  }
  const normalized = normalizeVisualMessage(msg);
  const contextParts = [];
  const profileContexts = safeContext(() => profileContextsForMessage(msg), "profile");
  for (const part of profileContexts || []) {
    contextParts.push(part);
  }
  const replyChainIDs = safeContext(() => replyChainMessageIDsForMessage(msg), "reply-chain-ids") || [];
  const replyChainContext = safeContext(() => buildReplyChainContextForMessage(msg), "reply-chain");
  if (replyChainContext) {
    contextParts.push({ text: replyChainContext, priority: 100, kind: "reply-chain" });
  }
  const continuityContext = safeContext(() => buildContinuityContextForMessage(msg, { excludeMessageIDs: replyChainIDs }), "continuity");
  if (continuityContext) {
    contextParts.push({ text: continuityContext, priority: 20, kind: "continuity" });
  }
  const moodContext = safeContext(() => buildMoodContextForMessage(msg), "mood");
  if (moodContext) {
    contextParts.push({ text: moodContext, priority: 80, kind: "mood" });
  }
  const feedbackContext = safeContext(() => buildFeedbackContextForMessage(msg), "feedback");
  if (feedbackContext) {
    contextParts.push({ text: feedbackContext, priority: 70, kind: "feedback" });
  }
  const personaContext = safeContext(() => botPersonaContextForMessage(msg), "persona");
  if (personaContext) {
    contextParts.push({ text: personaContext, priority: 95, kind: "persona" });
  }
  const memoryContext = safeContext(() => buildMemoryContextForMessageWrapper(msg), "memory");
  if (memoryContext) {
    contextParts.push({ text: memoryContext, priority: 85, kind: "memory" });
  }
  const recentFileContext = safeContext(() => recentGroupFilesContextForMessage(msg), "recent-group-files");
  if (recentFileContext) {
    contextParts.push({ text: recentFileContext, priority: 118, kind: "recent-group-files" });
  }
  const taskContext = safeContext(() => taskAgentContextForMessage(msg), "task-agent");
  if (taskContext) {
    contextParts.push({ text: taskContext, priority: 120, kind: "task-agent" });
  }
  if (msg.__proactive_context) {
    contextParts.push({ text: String(msg.__proactive_context), priority: 110, kind: "proactive" });
  }
  const context = composeEnrichedContext(contextParts);
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

function taskAgentContextForMessage(msg) {
  if (!msg || msg.post_type !== "message") {
    return "";
  }
  const text = messageText(msg);
  const route = naturalTaskRouteForMessage(msg);
  if (route.kind !== "task") {
    return "";
  }
  let parsed = parseTaskWithModel(text, route.task_type, {
    userID: msg.user_id,
    groupID: msg.group_id,
    sourceImages: imageSourcesForMessage(msg),
    timezone: TASK_AGENT_TIMEZONE,
    today: todayLocal(),
  });
  const isPrivate = msg.message_type === "private";
  const workspace = workspaceForMessage(msg);
  parsed = preparedFileTaskParse({ parsed, workspace, text });
  const taskRequest = createTaskRequest({
    workspace,
    scope: isPrivate ? "private" : "group",
    scopeID: isPrivate ? msg.user_id : msg.group_id,
    userID: msg.user_id,
    messageID: msg.message_id,
    taskType: route.task_type,
    confidence: route.confidence,
    text,
    spec: parsed.ok ? parsed.spec : null,
    status: parsed.ok && Array.isArray(parsed.missing) && parsed.missing.length > 0 ? "awaiting_input" : "delegated",
  });
  return buildTaskAgentContext({
    text,
    route,
    parsed,
    workspace,
    scope: isPrivate ? "private" : "group",
    scopeID: isPrivate ? msg.user_id : msg.group_id,
    taskRequest,
  });
}

function workspaceForMessage(msg) {
  if (msg && msg.__task_workspace) {
    return path.resolve(String(msg.__task_workspace));
  }
  return msg && msg.message_type === "private" ? workspaceForPrivateUser(msg.user_id) : workspaceForGroup(msg.group_id);
}

function recentGroupFilesContextForMessage(msg, options = {}) {
  if (!msg || msg.post_type !== "message" || msg.message_type !== "group") {
    return "";
  }
  if (!isAtMessage(msg) && !routedReplyPort(msg)) {
    return "";
  }
  const minutes = Math.max(1, Number(options.minutes || RECENT_GROUP_FILE_CONTEXT_MINUTES));
  const now = Number(options.now || Date.now());
  const cutoff = now - minutes * 60 * 1000;
  const workspace = workspaceForGroup(msg.group_id);
  let files = [];
  try {
    files = recentFiles({ workspace, limit: Number(options.limit || 12) })
      .filter((item) => {
        const time = Date.parse(item.time || "");
        return Number.isFinite(time) && time >= cutoff;
      });
  } catch {
    return "";
  }
  if (files.length === 0) {
    return "";
  }
  const lines = [
    `【最近${minutes}分钟群文件】`,
    "用户刚 @ 你时，如果问题可能和群里刚上传的文件有关，先主动查看这些 local_files 路径；不需要用户明确说“看文件”。",
    "优先读取 summary_path/extracted_path；没有提取文本时直接读取原文件或用合适工具解析。"
  ];
  for (const item of files.slice(0, 6)) {
    const bits = [
      item.name || path.basename(item.relative_path || ""),
      item.size ? formatBytesForContext(item.size) : "",
      item.parser && item.parser !== "none" ? `parser=${item.parser}` : "",
      item.relative_path || "",
      item.summary_path ? `summary=${item.summary_path}` : "",
      item.extracted_path ? `extracted=${item.extracted_path}` : ""
    ].filter(Boolean);
    lines.push(`- ${bits.join(" | ")}`);
  }
  return lines.join("\n");
}

function formatBytesForContext(value) {
  const n = Number(value) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function composeEnrichedContext(parts, options = {}) {
  const maxTotal = Math.max(100, Number(options.maxTotal || ENRICH_CONTEXT_MAX_CHARS));
  const maxPart = Math.max(80, Number(options.maxPart || ENRICH_CONTEXT_PART_MAX_CHARS));
  const seen = new Set();
  const out = [];
  let used = 0;
  const ranked = collapseContextParts((parts || [])
    .map((part, index) => typeof part === "object" && part !== null
      ? { text: part.text, priority: Number(part.priority || 0), kind: String(part.kind || ""), index }
      : { text: part, priority: 0, kind: "", index }))
    .sort((a, b) => b.priority - a.priority || contextKindOrder(a.kind) - contextKindOrder(b.kind) || a.index - b.index);
  for (const part of ranked) {
    let text = redactSecrets(String(part.text || "")).replace(/\r\n/g, "\n").trim();
    if (!text) continue;
    if (text.length > maxPart) {
      text = truncateContextPart(text, maxPart);
    }
    const key = text.replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    const separator = out.length > 0 ? 1 : 0;
    const remaining = maxTotal - used - separator;
    if (remaining <= 0) break;
    if (text.length > remaining) {
      if (remaining > 20) {
        out.push(truncateContextPart(text, remaining));
      }
      break;
    }
    out.push(text);
    used += text.length + separator;
  }
  return out.join("\n");
}

function collapseContextParts(parts) {
  const bestByKind = new Map();
  const out = [];
  for (const part of parts || []) {
    const kind = String(part && part.kind || "");
    if (!kind) {
      out.push(part);
      continue;
    }
    const existingIndex = bestByKind.get(kind);
    if (existingIndex === undefined) {
      bestByKind.set(kind, out.length);
      out.push(part);
      continue;
    }
    const existing = out[existingIndex] || {};
    if (Number(part.priority || 0) > Number(existing.priority || 0) || Number(part.index || 0) > Number(existing.index || 0)) {
      out[existingIndex] = part;
    }
  }
  return out;
}

function truncateContextPart(text, limit) {
  const max = Math.max(20, Number(limit) || 80);
  const body = String(text || "");
  if (body.length <= max) return body;
  const lines = body.split("\n");
  if (lines.length > 1 && /^【[^】]+】/.test(lines[0])) {
    const title = lines[0];
    const remaining = max - title.length - 9;
    if (remaining > 20) {
      return `${title}\n${lines.slice(1).join("\n").slice(0, remaining).trimEnd()}...(截断)`;
    }
  }
  return `${body.slice(0, max - 8).trimEnd()}...(截断)`;
}

function contextKindOrder(kind) {
  const order = {
    proactive: 0,
    "reply-chain": 1,
    mood: 2,
    persona: 3,
    "recent-group-files": 4,
    feedback: 5,
    "【当前成员画像】": 6,
    "【个人画像】": 6,
    "【群资料】": 7,
    continuity: 8
  };
  return order[String(kind || "")] ?? 50;
}

function safeContext(fn, label) {
  try {
    return fn() || "";
  } catch (err) {
    log("enrich context error", label, err.message);
    recordError("context", err.message, { detail: label });
    return "";
  }
}

function profileContextsForMessage(msg) {
  if (!msg) return [];
  if (msg.message_type === "group") {
    const workspace = workspaceForGroup(msg.group_id);
    return [
      profileContextPart("【当前成员画像】", memberProfilePath(msg, workspace), 35, 900),
      profileContextPart("【群资料】", path.join(workspace, "GROUP_PROFILE.md"), 10, 700)
    ].filter(Boolean);
  }
  if (msg.message_type === "private") {
    return [
      profileContextPart("【个人画像】", path.join(workspaceForPrivateUser(msg.user_id), "PROFILE.md"), 35, 900)
    ].filter(Boolean);
  }
  return [];
}

function botPersonaContextForMessage(msg) {
  if (!msg || !["group", "private"].includes(msg.message_type)) {
    return "";
  }
  const workspace = msg.message_type === "private" ? workspaceForPrivateUser(msg.user_id) : workspaceForGroup(msg.group_id);
  const lines = [
    "【长期相处风格】",
    "- 允许根据本群/私聊画像、聊天语境、反馈和近期气氛形成自己的稳定说话风格；可以自然变化，不必每次像客服或说明书。",
    "- 先读话中话：识别调侃、反话、暗示、熟人语境和未说出口的需求；不确定时用短句确认，不要长篇解释自己不确定。",
    "- 默认像正常聊天对象：短、顺口、有上下文承接；少用“作为AI/我无法体会/需要注意的是/以下是”等 AI 腔。",
    "- 不要把每次回复都写成服务台收尾；少说“要不要我帮你…/如果你需要我可以…/我可以继续…”。下一步明确就直接做，不能做就说明阻塞，确实需要选择时只问一个具体问题。",
    "- 群聊里尤其低打扰：回答完就停，不主动追问、不硬续话、不为了显得热情而补一句任务邀约。",
    "- 可以接梗、轻微吐槽、顺着用户语气说话；但不要冒充某个真人、不要声称线下经历、不要替用户本人说话。",
    "- 技术或复杂任务仍要靠谱：该跑命令就跑命令，该给路径就给路径，该说明失败就说明失败。"
  ];
  const localStyle = compactStyleFile(path.join(workspace, "memory", "bot-style.md"));
  if (localStyle) {
    lines.push("本聊天已沉淀风格：");
    lines.push(localStyle);
  }
  return lines.join("\n");
}

function compactStyleFile(file) {
  try {
    if (!fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^#/.test(line))
      .slice(-8)
      .join("\n")
      .slice(0, 600);
  } catch {
    return "";
  }
}

function buildContinuityContextForMessage(msg, options = {}) {
  if (!CONTINUITY_ENABLED) {
    return "";
  }
  const scope = msg.message_type === "private" ? "private" : "group";
  const scopeID = msg.message_type === "private" ? msg.user_id : msg.group_id;
  const gap = detectGap({ scope, scopeID, thresholdMinutes: CONTINUITY_GAP_MINUTES, consume: true });
  if (!gap.hasGap) {
    return "";
  }
  const workspace = msg.message_type === "private" ? workspaceForPrivateUser(msg.user_id) : workspaceForGroup(msg.group_id);
  return buildContinuityContext({
    workspace,
    gapMinutes: gap.gapMinutes,
    messageLimit: CONTINUITY_MESSAGE_LIMIT,
    excludeMessageID: msg.message_id,
    excludeMessageIDs: options.excludeMessageIDs || []
  });
}

function buildReplyChainContextForMessage(msg) {
  const workspace = msg.message_type === "private" ? workspaceForPrivateUser(msg.user_id) : workspaceForGroup(msg.group_id);
  return buildReplyChainContext({ workspace, msg });
}

function buildMemoryContextForMessageWrapper(msg) {
  if (msg.message_type !== "group" && msg.message_type !== "private") return "";
  const workspace = msg.message_type === "private" ? workspaceForPrivateUser(msg.user_id) : workspaceForGroup(msg.group_id);
  const messageTextValue = (msg.raw_message || messageText(msg)).replace(/\[CQ:[^\]]*\]/g, "").trim();
  const subject = msg.message_type === "private" ? String(msg.user_id || "") : "";
  const scope = msg.message_type === "private" ? "private" : "group";
  const scopeID = msg.message_type === "private" ? msg.user_id : msg.group_id;
  return buildMemoryContextForMessage({ workspace, messageText: messageTextValue, subject, scope, scopeID });
}

function replyChainMessageIDsForMessage(msg) {
  const workspace = msg.message_type === "private" ? workspaceForPrivateUser(msg.user_id) : workspaceForGroup(msg.group_id);
  return replyChainMessageIDs({ workspace, msg });
}

function buildMoodContextForMessage(msg) {
  if (!MOOD_ENABLED) {
    return "";
  }
  const workspace = msg.message_type === "private" ? workspaceForPrivateUser(msg.user_id) : workspaceForGroup(msg.group_id);
  if (msg.message_type === "private") {
    return formatMoodContext(readMoodState(workspace));
  }
  return groupEnergyContextForMessage({ workspace, msg });
}

function groupEnergyContextForMessage({ workspace, msg }) {
  const energy = readGroupEnergyState(workspace);
  if (shouldSkipGroupEnergyContext(msg)) {
    return formatFocusedGroupEnergyContext(energy, msg);
  }
  return formatGroupEnergyContext(energy);
}

function shouldSkipGroupEnergyContext(msg) {
  if (!msg || msg.message_type !== "group") {
    return false;
  }
  return isExplicitQaRequest(msg);
}

function isExplicitQaRequest(msg) {
  if (!msg || msg.message_type !== "group") {
    return false;
  }
  if (isAtMessage(msg) || isReplyToKnownBotMessage(msg)) {
    return true;
  }
  const text = messageText(msg);
  return /[?？]|为什么|怎么|如何|是什么|能否|能不能|可以|帮我|帮忙|解释|讲讲|分析|看一下|看看|详细|展开|具体|一步步|分步骤|原理|推导|完整|深入/i.test(String(text || ""));
}

function isReplyToKnownBotMessage(msg) {
  const replyID = replyTargetID(msg);
  if (!replyID) {
    return false;
  }
  return Boolean(botReplyRoutes.get(botReplyKey(msg.group_id, replyID)));
}

function formatFocusedGroupEnergyContext(energy, msg) {
  if (!energy || energy.level !== "high") {
    return "";
  }
  const detailed = /详细|展开|具体|一步步|分步骤|讲讲|解释|为什么|原理|推导|完整|深入/i.test(messageText(msg));
  const advice = detailed
    ? "先给结论，再分段解释；控制无关扩展。"
    : "优先回答当前明确请求，避免额外插话。";
  const minutes = Math.max(1, Math.round(Number(energy.window_ms || 300000) / 60000));
  return `【群聊能量：high】近 ${minutes} 分钟 ${energy.message_count || 0} 条消息、${energy.participant_count || 0} 人参与。${advice}`;
}

function buildFeedbackContextForMessage(msg) {
  if (!FEEDBACK_ENABLED) {
    return "";
  }
  const workspace = msg.message_type === "private" ? workspaceForPrivateUser(msg.user_id) : workspaceForGroup(msg.group_id);
  return formatFeedbackContext(feedbackContextSignalsForMessage({ workspace, msg, limit: 5 }));
}

function feedbackContextSignalsForMessage({ workspace, msg, limit = 5 }) {
  const max = Math.max(1, Number(limit) || 5);
  const signals = readSignals({ workspace, includeAll: true });
  if (!msg || msg.message_type === "private") {
    return signals
      .filter((item) => !msg || item.scope !== "private" || String(item.scope_id || "") === String(msg.user_id || ""))
      .slice(-max);
  }
  const userID = String(msg.user_id || "");
  const groupID = String(msg.group_id || "");
  const scoped = signals.filter((item) =>
    item.scope === "group" &&
    String(item.scope_id || "") === groupID &&
    String(item.feedback_user_id || "") === userID &&
    item.direct === true
  );
  return scoped.slice(-max);
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
  return profileContextsForMessage(msg).map((part) => part.text).join("\n");
}

function profileContextPart(label, file, priority, limit) {
  const digest = profileDigest(file, limit);
  return digest ? { text: `${label}\n${redactSecrets(digest)}`, priority, kind: label } : null;
}

function profileDigest(file, limit = 1200) {
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
  return lines.slice(-12).join("\n").slice(0, Math.max(200, Number(limit) || 1200));
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

function imageSourcesForMessage(msg) {
  return messageSegments(msg)
    .filter((seg) => seg && seg.type === "image")
    .map((seg) => {
      const data = seg.data || {};
      return data.url || data.file || data.path || data.image || data.image_url || "";
    })
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 8);
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
    msg.message_type === "private" &&
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

function promptInjectionGuardForMessage(msg) {
  if (!msg || msg.post_type !== "message" || !["group", "private"].includes(msg.message_type)) {
    return { action: "allow", reason: "" };
  }
  return evaluatePromptInjectionRisk(messageText(msg), {
    messageType: msg.message_type,
    groupID: msg.group_id,
    userID: msg.user_id,
    isAdmin: ADMIN_USERS.includes(Number(msg.user_id)) || ADMIN_ROOT_USERS.includes(Number(msg.user_id)),
  });
}

function tryHandlePromptInjectionGuard(msg) {
  const decision = promptInjectionGuardForMessage(msg);
  if (!decision || decision.action !== "block") {
    return false;
  }
  log("prompt guard blocked", "reason", decision.reason, "type", msg.message_type, "group", msg.group_id || "", "user", msg.user_id || "", "msg", msg.message_id || "");
  sendTaskReply(msg, decision.reply || "这个请求存在提示词注入或高风险操作迹象，我不会执行。");
  return true;
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

function tryHandleAcademicSearch(msg) {
  const text = messageText(msg).trim();
  if (!looksLikeAcademicSearch(text)) {
    return false;
  }
  const workspace = msg.message_type === "group"
    ? workspaceForGroup(msg.group_id)
    : workspaceForPrivateUser(msg.user_id);
  const matches = searchAcademicArchive({ workspace, query: text, limit: 5 });
  if (matches.length === 0) {
    return false;
  }
  const replyText = formatAcademicArchiveMatches(matches, text);
  if (msg.message_type === "private") {
    sendPrivateText(msg.user_id, msg.message_id, replyText);
  } else {
    sendGroupText(msg.group_id, msg.message_id, replyText);
  }
  return true;
}

function resetConversation(msg) {
  const port = resetConversationPort(msg);
  if (!port) {
    return "无法新建对话：当前聊天没有可用的 cc-connect 路由。";
  }
  if (!dispatchControlCommandToPort(port, msg, "/new")) {
    return `无法新建对话：cc-connect 端口 ${port} 未连接。`;
  }
  return "";
}

function resetConversationPort(msg) {
  if (msg.message_type === "private") {
    const route = routeForPrivateUser(Number(msg.user_id));
    return route && route.port;
  }
  if (msg.message_type === "group") {
    const route = routeForGroup(msg.group_id);
    return routedReplyPort(msg) || (isAtMessage(msg) ? route.atPort : route.listenPort) || route.atPort;
  }
  return null;
}

function isRotaIntent(msg) {
  if (msg.post_type !== "message" || msg.message_type !== "group") {
    return false;
  }
  if (!isAtMessage(msg)) {
    return false;
  }
  const text = messageText(msg);
  return Boolean(parseRotaRequest(text, {
    groupID: msg.group_id,
    userID: msg.user_id,
  })) || looksLikeWeeklyRota(text);
}

function handleRotaIntent(msg) {
  const workspace = workspaceForGroup(msg.group_id);
  const result = createRotaFromText(workspace, messageText(msg), {
    groupID: msg.group_id,
    userID: msg.user_id,
  });
  if (!result.ok) {
    if (result.reason === "missing_fields") {
      const pending = startPendingRotaTask(workspace, result, {
        groupID: msg.group_id,
        userID: msg.user_id,
        sourceText: messageText(msg),
      });
      sendGroupText(msg.group_id, msg.message_id, pending.reply);
      return;
    }
    sendGroupText(msg.group_id, msg.message_id, formatRotaFallbackFailure(result, "我看到了提醒请求，但缺少星期、时间、成员或任务。"));
    return;
  }
  sendGroupText(msg.group_id, msg.message_id, result.item ? formatRotaCreated(result.item) : "创建失败：成员、任务、星期或时间不完整。");
}

function tryHandleRotaFollowup(msg) {
  if (msg.post_type !== "message" || msg.message_type !== "group") {
    return false;
  }
  const workspace = workspaceForGroup(msg.group_id);
  const result = continuePendingRotaTask(workspace, messageText(msg), {
    groupID: msg.group_id,
    userID: msg.user_id,
  });
  if (!result.handled) {
    return false;
  }
  sendGroupText(msg.group_id, msg.message_id, result.reply);
  return true;
}

function tryHandleNaturalTask(msg) {
  if (!msg || msg.post_type !== "message") {
    return false;
  }
  const isPrivate = msg.message_type === "private";
  const isGroup = msg.message_type === "group";
  if (!isPrivate && !isGroup) {
    return false;
  }
  const text = messageText(msg);
  const workspace = isPrivate ? workspaceForPrivateUser(msg.user_id) : workspaceForGroup(msg.group_id);
  const continuation = awaitingNaturalTaskContinuation(msg, { workspace, text, isPrivate });
  const taskText = continuation && continuation.combinedText ? continuation.combinedText : text;
  const taskMsg = continuation && continuation.pending
    ? { ...msg, message_id: continuation.pending.message_id || msg.message_id, raw_message: taskText }
    : msg;
  if (continuation && continuation.pending) {
    msg.raw_message = taskText;
    msg.message = [{ type: "text", data: { text: taskText } }];
  }
  const taskRoute = naturalTaskRouteForMessage(msg);
  if (isGroup && !isAtMessage(msg) && taskRoute.kind !== "task") {
    return false;
  }
  const result = executeNaturalTask({
    text: taskText,
    msg: taskMsg,
    workspace,
    context: {
      scope: isPrivate ? "private" : "group",
      scopeID: isPrivate ? msg.user_id : msg.group_id,
      groupID: msg.group_id,
      userID: msg.user_id,
      sourceImages: imageSourcesForMessage(msg),
    },
    options: taskAgentOptions(),
  });
  if (!result.handled) return false;
  sendTaskReply(msg, result.reply);
  return true;
}

function tryHandleTaskContinueCommand(msg) {
  if (!msg || msg.post_type !== "message" || !["group", "private"].includes(msg.message_type)) {
    return false;
  }
  const isPrivate = msg.message_type === "private";
  const workspace = isPrivate ? workspaceForPrivateUser(msg.user_id) : workspaceForGroup(msg.group_id);
  const request = taskContinueRequestForMessage(msg, { workspace });
  if (!request.handled) {
    return false;
  }
  if (!request.ok) {
    sendTaskReply(msg, request.reply);
    return true;
  }
  const taskMsg = {
    ...msg,
    message_id: request.task.message_id || msg.message_id,
    raw_message: request.combinedText,
    message: [{ type: "text", data: { text: request.combinedText } }],
    __task_workspace: workspace,
  };
  const result = executeNaturalTask({
    text: request.combinedText,
    msg: taskMsg,
    workspace,
    context: {
      scope: request.task.scope || (isPrivate ? "private" : "group"),
      scopeID: request.task.scope_id || (isPrivate ? msg.user_id : msg.group_id),
      groupID: request.task.scope === "group" ? request.task.scope_id : msg.group_id,
      userID: request.task.user_id || msg.user_id,
      sourceImages: imageSourcesForMessage(msg),
    },
    options: taskAgentOptions(),
  });
  if (result.delegate_to_agent) {
    const targetPort = isPrivate ? (routeForPrivateUser(Number(msg.user_id)) || {}).port : routeForGroup(msg.group_id).atPort;
    ackMessage(msg);
    if (!dispatchToPort(targetPort, taskMsg)) {
      sendTaskReply(msg, "已补充任务，但当前 agent 连接不可用，稍后再试。");
    }
    return true;
  }
  if (!result.handled) {
    sendTaskReply(msg, "已收到补充，但还不能继续这个任务。请用 /任务 task_id 查看状态。");
    return true;
  }
  sendTaskReply(msg, result.reply);
  return true;
}

function taskContinueRequestForMessage(msg, { workspace } = {}) {
  const parsed = parseTaskContinueCommand(messageText(msg));
  if (!parsed) {
    return { handled: false };
  }
  if (!parsed.supplement) {
    return { handled: true, ok: false, reply: "用法：/任务 继续 task_id 补充内容" };
  }
  const task = findTaskRequestByID({ workspace, id: parsed.id });
  if (!task) {
    return { handled: true, ok: false, reply: "没有找到这个任务。" };
  }
  if (!canTaskOwnerOrAdmin(msg, task)) {
    return { handled: true, ok: false, reply: "没有权限。" };
  }
  if (String(task.status || "") !== "awaiting_input") {
    return { handled: true, ok: false, reply: `这个任务当前状态是 ${task.status || "-"}，不能继续补充。` };
  }
  const combinedText = [task.text, `补充：${parsed.supplement}`].filter(Boolean).join("\n");
  return {
    handled: true,
    ok: true,
    task,
    combinedText,
  };
}

function parseTaskContinueCommand(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^(?:\/任务|任务)\s+(?:继续|continue)\s+(\S+)(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return null;
  }
  return {
    id: match[1],
    supplement: String(match[2] || "").trim(),
  };
}

function canTaskOwnerOrAdmin(msg, task) {
  const userID = Number(msg && msg.user_id);
  return String(task && task.user_id || "") === String(msg && msg.user_id || "")
    || ADMIN_USERS.includes(userID)
    || ADMIN_ROOT_USERS.includes(userID);
}

function awaitingNaturalTaskContinuation(msg, { workspace, text, isPrivate }) {
  if (!text || !workspace) {
    return null;
  }
  const pending = findAwaitingInputTask({
    workspace,
    scope: isPrivate ? "private" : "group",
    scopeID: isPrivate ? msg.user_id : msg.group_id,
    userID: msg.user_id,
  });
  if (!pending) {
    return null;
  }
  const combinedText = [pending.text, `补充：${text}`].filter(Boolean).join("\n");
  return {
    pending,
    combinedText,
  };
}

function naturalTaskRouteForMessage(msg) {
  if (!msg || msg.post_type !== "message" || !["group", "private"].includes(msg.message_type)) {
    return { kind: "chat", confidence: 0 };
  }
  const route = classifyTask(messageText(msg), { commandIntent: false });
  if (route.kind !== "task") {
    return route;
  }
  const min = msg.message_type === "group" && !isAtMessage(msg) ? 0.68 : 0.6;
  return route.confidence >= min ? route : { ...route, kind: "chat" };
}

function heavyTaskPortForMessage(msg, options = {}) {
  const port = Number(Object.prototype.hasOwnProperty.call(options, "vivadoTaskPort") ? options.vivadoTaskPort : VIVADO_TASK_PORT);
  if (!port) {
    return null;
  }
  const route = naturalTaskRouteForMessage(msg);
  if (route.kind === "task" && route.task_type === "vivado_simulation") {
    return port;
  }
  return null;
}

function tryDispatchHeavyTask(msg) {
  const port = heavyTaskPortForMessage(msg);
  if (!port) {
    return false;
  }
  ackMessage(msg);
  if (!dispatchToPort(port, msg)) {
    sendTaskReply(msg, `仿真任务需要重任务 agent，但端口 ${port} 当前未连接。`);
  } else {
    log("route heavy task", "type", naturalTaskRouteForMessage(msg).task_type, "port", port, "msg", msg.message_id || "");
  }
  return true;
}

function sendTaskReply(msg, text) {
  if (msg.message_type === "private") {
    sendPrivateText(msg.user_id, msg.message_id, text);
  } else {
    sendGroupText(msg.group_id, msg.message_id, text);
  }
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
  return readJSONLShards(file);
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
  if (msg.post_type !== "message" || msg.message_type !== "group" || !pluginManager.enabled("dream", pluginContextForMessage(msg))) {
    return false;
  }
  const text = messageText(msg).trim();
  return pluginTriggers("dream", DREAM_TRIGGERS).some((trigger) => text === trigger);
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

function dreamPluginHealth(ctx = {}) {
  const groupID = ctx.groupID || (ALLOWED_GROUPS[0] || 0);
  if (!groupID) {
    return { ok: false, detail: "no group configured" };
  }
  const script = dreamScriptForWorkspace(workspaceForGroup(groupID));
  const scriptPath = script.command === "powershell.exe" ? script.args[script.args.length - 1] : script.command;
  return { ok: fs.existsSync(scriptPath), detail: scriptPath };
}

function sendGroupText(groupID, replyToMessageID, text) {
  sendGroupMessage(groupID, replyToMessageID, [{ type: "text", data: { text: String(text || "") } }]);
}

function sendGroupMessage(groupID, replyToMessageID, segments) {
  const message = [];
  if (replyToMessageID) {
    message.push({ type: "reply", data: { id: String(replyToMessageID) } });
  }
  if (Array.isArray(segments)) {
    message.push(...segments);
  } else {
    message.push({ type: "text", data: { text: String(segments || "") } });
  }
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
  if (msg.post_type !== "message" || !["group", "private"].includes(msg.message_type) || !pluginManager.enabled("image", pluginContextForMessage(msg))) {
    return null;
  }
  const text = messageText(msg).trim();
  for (const trigger of pluginTriggers("image", IMAGE_TRIGGERS)) {
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

function handleImageCommand(msg, promptOverride = undefined) {
  const isPrivate = msg.message_type === "private";
  const targetID = Number(isPrivate ? msg.user_id : msg.group_id);
  const prompt = promptOverride === undefined ? imagePromptFromMessage(msg) : String(promptOverride || "");
  ackMessage(msg);

  if (!prompt) {
    sendImageText(msg, "用法：/画图 一只赛博朋克风格的橘猫，雨夜街头，电影感");
    return;
  }
  const key = imageStateKey(msg);
  const state = getImageState(key);
  const queueMax = pluginNumberSetting("image", "queue_max_per_group", IMAGE_QUEUE_MAX_PER_GROUP, 0, 1000);
  const maxConcurrent = pluginNumberSetting("image", "max_concurrent_per_group", IMAGE_MAX_CONCURRENT_PER_GROUP, 1, 100);
  if (state.queue.length >= queueMax) {
    sendImageText(msg, "画图队列已满，稍后再试。");
    return;
  }

  state.queue.push({ msg, prompt });
  log("image queued", isPrivate ? "private" : "group", targetID, "msg", msg.message_id, "active", state.active, "depth", state.queue.length);
  if (state.active >= maxConcurrent) {
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

function imagePluginHealth() {
  return {
    ok: fs.existsSync(IMAGE_SCRIPT),
    detail: IMAGE_SCRIPT,
    queues: [...imageStates.entries()].map(([key, state]) => ({
      key,
      active: state.active,
      queued: state.queue.length,
    })),
  };
}

function pumpImageQueue(key) {
  const state = getImageState(key);
  const maxConcurrent = pluginNumberSetting("image", "max_concurrent_per_group", IMAGE_MAX_CONCURRENT_PER_GROUP, 1, 100);
  while (state.active < maxConcurrent && state.queue.length > 0) {
    const credential = acquireImageCredential();
    if (!credential) {
      return;
    }
    const item = state.queue.shift();
    startImageJob(key, item.msg, item.prompt, state, credential);
  }
}

function finishImageJob(key, state, credential) {
  state.active = Math.max(0, state.active - 1);
  releaseImageCredential(credential);
  pumpImageQueue(key);
  pumpAllImageQueues();
}

function startImageJob(key, msg, prompt, state, credential) {
  const isPrivate = msg.message_type === "private";
  const targetID = Number(isPrivate ? msg.user_id : msg.group_id);
  const workspace = isPrivate ? workspaceForPrivateUser(targetID) : workspaceForGroup(targetID);
  state.active += 1;
  log("image start", isPrivate ? "private" : "group", targetID, "msg", msg.message_id, "active", state.active, "queued", state.queue.length, "slot", credential.id);

  const child = execFile(process.execPath, [IMAGE_SCRIPT, "--workspace", workspace, "--prompt", prompt], {
    cwd: workspace,
    timeout: Number(process.env.ONEBOT_IMAGE_TIMEOUT_MS || 600000),
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 8,
    env: {
      ...process.env,
      OPENAI_IMAGE_API_KEY: credential.apiKey,
      OPENAI_BASE_URL: credential.baseUrl || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || "",
      OPENAI_API_BASE: credential.baseUrl || process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL || "",
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
      finishImageJob(key, state, credential);
      return;
    }

    let result;
    try {
      result = JSON.parse(String(stdout || "{}"));
    } catch {
      sendImageText(msg, "画图失败：生成脚本没有返回有效结果。");
      recordError("image", "invalid generate-image result", { scope: isPrivate ? "private" : "group", target: String(targetID) });
      finishImageJob(key, state, credential);
      return;
    }

    if (!result.imagePath || !fs.existsSync(result.imagePath)) {
      sendImageText(msg, "画图失败：图片文件没有生成。");
      recordError("image", "image file missing", { scope: isPrivate ? "private" : "group", target: String(targetID) });
      finishImageJob(key, state, credential);
      return;
    }

    sendImageResult(msg, result.imagePath, imageResultText(result));
    log("image complete", isPrivate ? "private" : "group", targetID, path.basename(result.imagePath));
    finishImageJob(key, state, credential);
  });

  child.on("error", (err) => {
    sendImageText(msg, `画图启动失败：${err.message}`);
    log("image spawn failed", isPrivate ? "private" : "group", targetID, err.message);
    recordError("image-spawn", err.message, { scope: isPrivate ? "private" : "group", target: String(targetID) });
    finishImageJob(key, state, credential);
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
  const originalOutgoingText = outgoingText(copy);
  copy = maybeCreateAtArtifacts(copy, sourcePort);
  maybeUploadOutgoingFiles(copy, sourcePort, [originalOutgoingText, outgoingText(copy)].filter(Boolean).join("\n"));
  const renderedOutgoingText = outgoingText(copy);
  const renderCandidateText = originalOutgoingText && originalOutgoingText !== renderedOutgoingText
    ? `${originalOutgoingText}\n${renderedOutgoingText || ""}`.trim()
    : (renderedOutgoingText || originalOutgoingText);

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
  copy = maybeRenderOutgoingAsImage(copy, renderCandidateText);
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
  return next;
}

function maybeUploadOutgoingFiles(obj, sourcePort, text) {
  if (!OUTGOING_FILE_UPLOAD_ENABLED) {
    return obj;
  }
  if (!isOutgoingMessageAction(obj) && !isOutgoingPrivateMessageAction(obj)) {
    return obj;
  }
  const target = outgoingRenderTarget(obj);
  if (!isAllowedOutgoingFileTarget(target)) {
    return obj;
  }
  const workspace = target.type === "private" ? workspaceForPrivateUser(target.id) : workspaceForGroup(target.id);
  const projectRoot = path.dirname(WORKSPACE_ROOT);
  const candidates = [
    ...collectOutgoingFileUploadCandidates(text, workspace, projectRoot),
    ...collectFileOutboxUploads(target, workspace, projectRoot)
  ].slice(0, OUTGOING_FILE_UPLOAD_MAX_FILES);

  const queuedOutboxes = new Set();
  for (const candidate of candidates) {
    const uploaded = uploadChatFile(target, candidate.path, candidate.name, {
      source: candidate.source,
      outboxPath: candidate.outboxPath,
      taskID: candidate.taskID,
      taskType: candidate.taskType,
      relativePath: candidate.relativePath
    });
    if (uploaded && candidate.outboxPath && !queuedOutboxes.has(candidate.outboxPath)) {
      markFileOutboxQueued(candidate.outboxPath);
      queuedOutboxes.add(candidate.outboxPath);
    }
  }
  return obj;
}

function drainFileOutboxes() {
  if (!OUTGOING_FILE_UPLOAD_ENABLED) {
    return 0;
  }
  if (!upstream || upstream.readyState !== WebSocket.OPEN || !upstreamReady) {
    return 0;
  }
  const projectRoot = path.dirname(WORKSPACE_ROOT);
  let uploadedCount = 0;
  for (const target of outboxDrainTargets()) {
    const workspace = target.type === "private" ? workspaceForPrivateUser(target.id) : workspaceForGroup(target.id);
    const queuedOutboxes = new Set();
    for (const candidate of collectFileOutboxUploads(target, workspace, projectRoot)) {
      const uploaded = uploadChatFile(target, candidate.path, candidate.name, {
        source: candidate.source || "outbox-drain",
        outboxPath: candidate.outboxPath,
        taskID: candidate.taskID,
        taskType: candidate.taskType,
        relativePath: candidate.relativePath
      });
      if (uploaded) {
        uploadedCount += 1;
      }
      if (uploaded && candidate.outboxPath && !queuedOutboxes.has(candidate.outboxPath)) {
        markFileOutboxQueued(candidate.outboxPath);
        queuedOutboxes.add(candidate.outboxPath);
      }
    }
  }
  if (uploadedCount > 0) {
    log("file outbox drained", uploadedCount);
  }
  return uploadedCount;
}

function outboxDrainTargets() {
  return [
    ...ALLOWED_PRIVATE_USERS.map((id) => ({ type: "private", id: Number(id) })),
    ...ALLOWED_GROUPS.map((id) => ({ type: "group", id: Number(id) }))
  ];
}

function isAllowedOutgoingFileTarget(target) {
  if (!target) {
    return false;
  }
  if (target.type === "group") {
    return ALLOWED_GROUPS.includes(Number(target.id));
  }
  if (target.type === "private") {
    return ALLOWED_PRIVATE_USERS.includes(Number(target.id));
  }
  return false;
}

function collectOutgoingFileUploadCandidates(text, workspace, projectRoot = path.dirname(WORKSPACE_ROOT)) {
  if (!shouldUploadMentionedFiles(text)) {
    return [];
  }
  const seen = new Set();
  const candidates = [];
  for (const rawPathToken of extractPathTokens(text)) {
    const candidate = fileUploadCandidateFromPath(rawPathToken, workspace, projectRoot, "reply-text");
    if (!candidate || seen.has(candidate.path)) {
      continue;
    }
    if (isVivadoNonImageUploadCandidate(candidate.path, workspace)) {
      log("skip outgoing file upload", "vivado-non-image", candidate.path);
      continue;
    }
    seen.add(candidate.path);
    candidates.push(candidate);
    if (candidates.length >= OUTGOING_FILE_UPLOAD_MAX_FILES) {
      break;
    }
  }
  return candidates;
}

function isVivadoNonImageUploadCandidate(filePath, workspace) {
  const relative = path.relative(path.resolve(workspace), path.resolve(filePath)).replace(/\\/g, "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  return /^local_files\/vivado\//i.test(relative) && !isChatImageFile(relative);
}

function shouldUploadMentionedFiles(text) {
  const s = String(text || "");
  if (!s.trim()) {
    return false;
  }
  if (!/(改好|改完|修改|修好|已改|已修|更新|生成|保存|写入|产物|文件在|改后的|最新版|回传|传回|发回|发给|上传|发送)/i.test(s)) {
    return false;
  }
  return /(?:[A-Za-z]:\\|\/|local_files[\/\\]|\.cc-connect[\/\\]|groups[\/\\]|users[\/\\])/.test(s);
}

function extractPathTokens(text) {
  const source = String(text || "");
  const tokens = [];
  const patterns = [
    /[A-Za-z]:\\[^\s"'<>]+/g,
    /(?:^|[\s(（:：])((?:\/)[^\s"'<>]+)/g,
    /(?:^|[\s(（:：])((?:\.{1,2}[\/\\])?(?:local_files|groups|users|\.cc-connect)[\/\\][^\s"'<>]+)/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      tokens.push(stripOutgoingPathToken(match[1] || match[0]));
    }
  }
  return tokens.filter(Boolean);
}

function stripOutgoingPathToken(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/^[`"'“”‘’「」『』【】(<（]+/g, "");
  s = s.replace(/[`"'“”‘’「」『』【】)>）\]}，。；;：:、,.!?！？]+$/g, "");
  return s;
}

function collectFileOutboxUploads(target, workspace, projectRoot = path.dirname(WORKSPACE_ROOT)) {
  const dirs = target.type === "private"
    ? ["private-file-outbox", "file-outbox"]
    : ["group-file-outbox", "file-outbox"];
  const results = [];
  const seen = new Set();
  for (const dirName of dirs) {
    const dir = path.join(RUNTIME_DIR, dirName);
    if (!fs.existsSync(dir)) {
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
        .map((entry) => {
          const file = path.join(dir, entry.name);
          return { file, mtimeMs: fs.statSync(file).mtimeMs };
        })
        .sort((a, b) => a.mtimeMs - b.mtimeMs)
        .slice(0, 50);
    } catch (err) {
      log("file outbox read failed", dirName, err.message);
      recordError("file-outbox", err.message, { detail: dirName });
      continue;
    }
    for (const entry of entries) {
      for (const candidate of fileOutboxCandidates(entry.file, target, workspace, projectRoot, dirName)) {
        if (seen.has(candidate.path)) {
          continue;
        }
        seen.add(candidate.path);
        results.push(candidate);
        if (results.length >= OUTGOING_FILE_UPLOAD_MAX_FILES) {
          return results;
        }
      }
    }
  }
  return results;
}

function fileOutboxCandidates(outboxPath, target, workspace, projectRoot, dirName) {
  let item;
  try {
    item = JSON.parse(fs.readFileSync(outboxPath, "utf8"));
  } catch (err) {
    log("file outbox parse failed", path.basename(outboxPath), err.message);
    recordError("file-outbox-parse", err.message, { detail: path.basename(outboxPath) });
    return [];
  }
  const rows = Array.isArray(item.files) ? item.files : [item];
  const candidates = [];
  for (const row of rows) {
    const merged = row && row !== item ? { ...item, ...row } : row;
    if (!outboxMatchesTarget(merged, target, dirName)) {
      continue;
    }
    const rawPath = outboxFilePath(merged);
    const candidate = fileUploadCandidateFromPath(rawPath, workspace, projectRoot, "outbox");
    if (!candidate) {
      continue;
    }
    candidate.name = safeName(merged.name || merged.file_name || candidate.name);
    candidate.outboxPath = outboxPath;
    candidate.taskID = merged.task_id || item.task_id || "";
    candidate.taskType = merged.task_type || item.task_type || "";
    candidate.relativePath = path.relative(workspace, candidate.path).replace(/\\/g, "/");
    candidates.push(candidate);
  }
  return candidates;
}

function outboxFilePath(item) {
  if (!item) {
    return "";
  }
  for (const field of ["path", "file_path", "local_path", "absolute_path", "output", "out_path"]) {
    if (typeof item[field] === "string" && item[field]) {
      return item[field];
    }
  }
  if (typeof item.file === "string") {
    return item.file;
  }
  if (item.file && typeof item.file === "object") {
    return item.file.path || item.file.file_path || item.file.local_path || item.file.absolute_path || item.file.file || "";
  }
  return "";
}

function outboxMatchesTarget(item, target, dirName) {
  if (!item || !target) {
    return false;
  }
  const scope = String(item.scope || item.type || "").toLowerCase();
  if (scope && ![target.type, "file", "upload", "file_upload"].includes(scope) && !scope.includes(target.type)) {
    return false;
  }
  const groupID = item.group_id || item.groupID || item.group;
  const userID = item.user_id || item.userID || item.user || item.qq;
  if (target.type === "group") {
    if (userID && !groupID) {
      return false;
    }
    if (groupID && Number(groupID) !== Number(target.id)) {
      return false;
    }
    return dirName !== "private-file-outbox";
  }
  if (target.type === "private") {
    if (groupID) {
      return false;
    }
    if (userID && Number(userID) !== Number(target.id)) {
      return false;
    }
    return dirName !== "group-file-outbox";
  }
  return false;
}

function fileUploadCandidateFromPath(rawPath, workspace, projectRoot, source) {
  const resolved = resolveOutgoingFilePath(rawPath, workspace, projectRoot);
  if (!resolved) {
    return null;
  }
  const pathCheck = validateOutgoingFilePath(resolved, workspace);
  if (!pathCheck.ok) {
    if (pathCheck.reason !== "missing") {
      log("skip outgoing file upload", pathCheck.reason, resolved);
    }
    return null;
  }
  return {
    path: pathCheck.path,
    name: path.basename(pathCheck.path),
    source
  };
}

function resolveOutgoingFilePath(rawPath, workspace, projectRoot = path.dirname(WORKSPACE_ROOT)) {
  const pathText = stripOutgoingPathToken(rawPath);
  if (!pathText || /^https?:\/\//i.test(pathText) || pathText.startsWith("//")) {
    return null;
  }
  const normalized = pathText.replace(/\//g, path.sep).replace(/\\/g, path.sep);
  const direct = path.isAbsolute(normalized) ? normalized : path.join(workspace, normalized);
  if (path.isAbsolute(normalized)) {
    return path.resolve(direct);
  }
  if (/^(?:local_files)(?:[\\/]|$)/i.test(pathText)) {
    return path.resolve(workspace, normalized);
  }
  if (/^(?:groups|users)(?:[\\/]|$)/i.test(pathText)) {
    return path.resolve(projectRoot, normalized);
  }
  if (/^(?:\.cc-connect)(?:[\\/]|$)/i.test(pathText)) {
    return path.resolve(projectRoot, normalized);
  }
  return path.resolve(workspace, normalized);
}

function validateOutgoingFilePath(filePath, workspace) {
  const resolved = path.resolve(filePath);
  const localFilesRoot = path.resolve(workspace, "local_files");
  if (!isPathInside(resolved, localFilesRoot)) {
    return { ok: false, reason: "outside-local-files", path: resolved };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, reason: "missing", path: resolved };
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    return { ok: false, reason: "not-file", path: resolved };
  }
  if (stat.size > OUTGOING_FILE_UPLOAD_MAX_BYTES) {
    return { ok: false, reason: "too-large", path: resolved };
  }
  return { ok: true, path: resolved, stat };
}

function isPathInside(targetPath, rootPath) {
  const rel = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function uploadChatFile(target, filePath, fileName, meta = {}) {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  const key = `${target.type}:${target.id}:${resolved}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  pruneRecentOutgoingFileUploads();
  if (recentOutgoingFileUploads.has(key)) {
    return false;
  }
  recentOutgoingFileUploads.set(key, Date.now());
  const name = safeName(fileName || path.basename(resolved));
  const echo = `__upload_file_${target.type}_${target.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const workspace = target.type === "private" ? workspaceForPrivateUser(target.id) : workspaceForGroup(target.id);
  const relativePath = meta.relativePath || path.relative(workspace, resolved).replace(/\\/g, "/");
  if (isChatImageFile(resolved)) {
    pendingFileUploads.set(echo, {
      target,
      file: resolved,
      name,
      source: meta.source || "",
      outboxPath: meta.outboxPath || "",
      taskID: meta.taskID || "",
      taskType: meta.taskType || "",
      relativePath,
      ts: Date.now()
    });
    sendChatImageFile(target, resolved, echo);
    log("send outgoing image", target.type, target.id, name, meta.source || "");
    appendLine(path.join(workspace, "local_files", "INDEX.md"), `- ${new Date().toISOString()} 已回传图片: ${relativePath}`);
    return true;
  }
  const action = target.type === "private" ? "upload_private_file" : "upload_group_file";
  const params = target.type === "private"
    ? { user_id: Number(target.id), file: resolved, name }
    : { group_id: Number(target.id), file: resolved, name };
  pendingFileUploads.set(echo, {
    target,
    file: resolved,
    name,
    source: meta.source || "",
    outboxPath: meta.outboxPath || "",
    taskID: meta.taskID || "",
    taskType: meta.taskType || "",
    relativePath,
    ts: Date.now()
  });
  sendUpstream({ action, params, echo });
  log("upload outgoing file", target.type, target.id, name, meta.source || "");

  appendLine(path.join(workspace, "local_files", "INDEX.md"), `- ${new Date().toISOString()} 已回传: ${relativePath}`);
  return true;
}

function isChatImageFile(filePath) {
  return /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(String(filePath || ""));
}

function sendChatImageFile(target, filePath, echo) {
  const imageData = fs.readFileSync(path.resolve(filePath)).toString("base64");
  const message = [{ type: "image", data: { file: `base64://${imageData}` } }];
  const action = target.type === "private" ? "send_private_msg" : "send_group_msg";
  const params = target.type === "private"
    ? { user_id: Number(target.id), message }
    : { group_id: Number(target.id), message };
  sendUpstream({ action, params, echo });
}

function pruneRecentOutgoingFileUploads() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, ts] of recentOutgoingFileUploads.entries()) {
    if (ts < cutoff) {
      recentOutgoingFileUploads.delete(key);
    }
  }
}

function handleOutgoingFileUploadResponse(resp) {
  const info = pendingFileUploads.get(resp.echo);
  pendingFileUploads.delete(resp.echo);
  if (!info) {
    return;
  }
  if (responseOK(resp)) {
    log("outgoing file upload ok", info.target.type, info.target.id, info.name);
    recordTaskArtifactUploadResult({ info, status: "passed", detail: responseMessageID(resp) ? `message_id:${responseMessageID(resp)}` : "" });
    return;
  }
  const detail = responseErrorText(resp);
  log("outgoing file upload failed", info.target.type, info.target.id, info.name, resp.retcode || "", detail);
  recordError("file-upload", detail, { scope: info.target.type, target: String(info.target.id), detail: info.name });
  recordTaskArtifactUploadResult({ info, status: "failed", detail });
}

function recordTaskArtifactUploadResult({ info, status, detail = "", workspace: workspaceOverride = "" }) {
  if (!info || !info.taskID) {
    return null;
  }
  const workspace = workspaceOverride || (info.target && info.target.type === "private"
    ? workspaceForPrivateUser(info.target.id)
    : workspaceForGroup(info.target && info.target.id));
  const receipt = readTaskReceipt({ workspace, id: info.taskID });
  if (!receipt) {
    return null;
  }
  const checks = Array.isArray(receipt.checks) ? receipt.checks.slice() : [];
  checks.push({
    name: "file_upload",
    status,
    path: info.relativePath || path.basename(info.file || info.name || ""),
    target: info.target ? `${info.target.type}:${info.target.id}` : "",
    detail: String(detail || "").slice(0, 200),
  });
  const result = receipt.result && typeof receipt.result === "object" ? { ...receipt.result } : {};
  result.upload_status = status;
  if (detail) result.upload_detail = String(detail).slice(0, 200);
  const written = writeTaskReceipt({
    workspace,
    id: info.taskID,
    receipt: {
      ...receipt,
      result,
      checks,
    },
  });
  return written && written.receipt || null;
}

function markFileOutboxQueued(outboxPath) {
  try {
    const queuedDir = path.join(path.dirname(outboxPath), ".queued");
    ensureDir(queuedDir);
    fs.renameSync(outboxPath, path.join(queuedDir, path.basename(outboxPath)));
  } catch (err) {
    log("file outbox mark queued failed", path.basename(outboxPath), err.message);
    recordError("file-outbox-queued", err.message, { detail: path.basename(outboxPath) });
  }
}

function maybeRenderOutgoingAsImage(obj, originalText, options = {}) {
  if (!isOutgoingMessageAction(obj) && !isOutgoingPrivateMessageAction(obj)) {
    return obj;
  }
  const target = outgoingRenderTarget(obj);
  if (!target) {
    return obj;
  }
  if (target.type === "group" && !ALLOWED_GROUPS.includes(target.id)) {
    return obj;
  }
  if (target.type === "private" && !ALLOWED_PRIVATE_USERS.includes(target.id)) {
    return obj;
  }

  const normalizedText = outgoingText(obj);
  const renderText = normalizedText || originalText;
  if (!shouldRenderAsImage(originalText) && !shouldRenderAsImage(normalizedText)) {
    return obj;
  }

  const renderImage = options.renderImage || renderAnswerImageForTarget;
  const images = normalizeRenderedImagePaths(renderImage(target, renderText));
  if (images.length === 0) {
    return obj;
  }
  const imageSegments = images.map(imageSegmentForLocalPath).filter(Boolean);
  if (imageSegments.length === 0) {
    return obj;
  }
  log("render outgoing as image", target.type, target.id, "chars", String(renderText || "").length, "files", images.map((image) => path.basename(image)).join(","));
  return withOutgoingSegments(obj, [
    { type: "text", data: { text: "答案已渲染成图片，便于查看公式和排版：" } },
    ...imageSegments
  ]);
}

function normalizeRenderedImagePaths(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).map(String);
  }
  return value ? [String(value)] : [];
}

function imageSegmentForLocalPath(imagePath) {
  try {
    const resolved = path.resolve(imagePath);
    const imageData = fs.readFileSync(resolved).toString("base64");
    return { type: "image", data: { file: `base64://${imageData}` } };
  } catch (err) {
    log("render image read failed", err.message);
    recordError("render-read", err.message, { detail: String(imagePath || "") });
    return null;
  }
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

function outgoingRenderTarget(obj) {
  if (!obj || !obj.params) {
    return null;
  }
  if (isOutgoingPrivateMessageAction(obj)) {
    const userID = outgoingUserID(obj);
    return userID ? { type: "private", id: userID } : null;
  }
  if (isOutgoingMessageAction(obj)) {
    const groupID = outgoingGroupID(obj);
    if (groupID) {
      return { type: "group", id: groupID };
    }
    const userID = outgoingUserID(obj);
    if (obj.action === "send_msg" && userID) {
      return { type: "private", id: userID };
    }
  }
  return null;
}

function shouldSilenceOutgoing(obj) {
  if (!isOutgoingMessageAction(obj) && !isOutgoingPrivateMessageAction(obj)) {
    return false;
  }
  const text = outgoingText(obj).replace(/\s+/g, " ").trim();
  if (SILENT_REPLY_SENTINELS.includes(normalizeSilentReplyText(text))) {
    return true;
  }
  return SILENCED_OUTGOING_PATTERNS.some((pattern) => text.includes(pattern));
}

function normalizeSilentReplyText(text) {
  let s = String(text || "").replace(/\s+/g, " ").trim();
  s = s.replace(/^[`"'“”‘’「」『』【】]+|[`"'“”‘’「」『』【】]+$/g, "").trim();
  return s;
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
  if (s.length > RENDER_TEXT_LIMIT) {
    return true;
  }
  if (/```[\s\S]*?```|^\s{4,}\S/m.test(s)) {
    return true;
  }
  if (/(\$\$?|\\\[|\\\]|\\\(|\\\)|\\frac|\\sum|\\int|\\sqrt|\\begin\{|[∑√∫≤≥≈≠∞]|[a-zA-Z]\^\{?[-+\w]+\}?|[a-zA-Z]_\{?[-+\w]+\}?)/.test(s)) {
    return true;
  }
  if (looksLikeCodeAnswer(s) || looksLikeMultilineDerivation(s)) {
    return true;
  }
  return false;
}

function looksLikeCodeAnswer(text) {
  const codeLinePattern = /^\s*(?:const|let|var|function|class|def|import|from|for|while|if|else|return|try|catch|public|private|#include)\b|[{};]\s*$/;
  return String(text || "").split(/\r?\n/).filter((line) => codeLinePattern.test(line)).length >= 2;
}

function looksLikeMultilineDerivation(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) {
    return false;
  }
  const mathLines = lines.filter((line) => (
    /(?:=|≈|≤|≥|->|⇒|∴|因为|所以|代入|化简|可得)/.test(line) &&
    /(?:[A-Za-z]\w*|[\d])/.test(line)
  ));
  return mathLines.length >= 2;
}

function renderAnswerImage(groupID, text) {
  return renderAnswerImageForTarget({ type: "group", id: Number(groupID) }, text);
}

function renderAnswerImageForTarget(target, text) {
  try {
    const workspace = target.type === "private"
      ? workspaceForPrivateUser(target.id)
      : workspaceForGroup(target.id);
    const dir = path.join(workspace, "local_files", "rendered");
    ensureDir(dir);
    const slug = timestampSlug();
    const textPath = path.join(dir, `answer-${slug}.txt`);
    const imagePath = path.join(dir, `answer-${slug}.png`);
    fs.writeFileSync(textPath, renderForQQ(stripWorkspacePath(text)), "utf8");
    const imagePaths = normalizeRenderedImagePaths(renderCardImage(textPath, imagePath));
    const label = target.type === "private" ? "渲染私聊答案图片" : "渲染答案图片";
    appendLine(path.join(workspace, "local_files", "INDEX.md"), `- ${new Date().toISOString()} ${label}: ${imagePaths.map((image) => `rendered/${path.basename(image)}`).join(", ")}`);
    return imagePaths;
  } catch (err) {
    log("render image failed", err.message);
    recordError("render", err.message);
    return null;
  }
}

function renderCardImage(textPath, imagePath) {
  if (process.platform === "win32" && commandExists("powershell.exe")) {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", RENDER_SCRIPT,
      "-TextPath", textPath,
      "-OutPath", imagePath
    ], { timeout: 30000, windowsHide: true });
    return renderedPagePaths(imagePath);
  }
  if (commandExists(process.env.ONEBOT_IMAGEMAGICK_CONVERT || "convert")) {
    execFileSync(process.execPath, [
      RENDER_IMAGEMAGICK_SCRIPT,
      "--text", textPath,
      "--out", imagePath
    ], { timeout: 30000, windowsHide: true });
    return renderedPagePaths(imagePath);
  }
  throw new Error("no answer-image renderer available: install ImageMagick convert or provide powershell.exe");
}

function renderedPagePaths(imagePath) {
  const parsed = path.parse(imagePath);
  const paths = [imagePath];
  for (let index = 2; index <= 50; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext || ".png"}`);
    if (!fs.existsSync(candidate)) {
      break;
    }
    paths.push(candidate);
  }
  return paths;
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
    .replace(/[ \t]*[·•]\s*C:\\chatbot-qq\\groups\\sandbox-\d+[,，]?/gi, "");
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
    .replace(/\*([^*\n]+)\*/g, "$1")
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
    const userID = outgoingUserID(tracked);
    pendingBotReplies.set(echo, {
      scope: "private",
      userID,
      port: sourcePort,
      ts: Date.now(),
      text: outgoingText(tracked),
      triggerMsg: activeTriggerMessages.get(triggerKey(sourcePort, userID)) || null
    });
    pendingEchoPorts.set(echo, sourcePort);
    trackPendingOutbound(tracked, sourcePort, "private");
    return tracked;
  }
  if (!ALLOWED_GROUPS.includes(groupID)) {
    return obj;
  }

  const echo = typeof obj.echo === "string" && obj.echo ? obj.echo : `__botreply_${groupID}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tracked = obj.echo === echo ? obj : { ...obj, echo };
  pendingBotReplies.set(echo, {
    scope: "group",
    groupID,
    port: sourcePort,
    ts: Date.now(),
    text: outgoingText(tracked),
    triggerMsg: activeTriggerMessages.get(triggerKey(sourcePort, groupID)) || null
  });
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
    if (info.scope === "private") {
      rememberPrivateBotReply(info.userID, messageID, info.port);
    } else {
      rememberBotReply(info.groupID, messageID, info.port);
    }
    recordBotReply(info, messageID);
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

function rememberPrivateBotReply(userID, messageID, port) {
  recentBotReplies.push({
    scope: "private",
    scopeID: String(userID || ""),
    userID: String(userID || ""),
    messageID: String(messageID || ""),
    port,
    ts: Date.now()
  });
  trimRecentBotReplies();
  log("remember private bot reply", "user", userID, "msg", messageID, "port", port);
}

function recordBotReply(info, messageID) {
  const scope = info.scope === "private" ? "private" : "group";
  const workspace = scope === "private" ? workspaceForPrivateUser(info.userID) : workspaceForGroup(info.groupID);
  const record = {
    time: new Date().toISOString(),
    message_id: String(messageID || ""),
    user_id: "bot",
    sender: { nickname: "bot" },
    text: String(info.text || ""),
    raw_message: String(info.text || ""),
    bot: true
  };
  if (scope === "group") {
    record.group_id = String(info.groupID || "");
  }
  appendLine(path.join(workspace, "memory", `chat-${todayLocal()}.jsonl`), JSON.stringify(record));
  recentBotReplies.push({
    scope,
    scopeID: scope === "private" ? String(info.userID || "") : String(info.groupID || ""),
    userID: String(info.userID || ""),
    messageID: String(messageID || ""),
    text: String(info.text || ""),
    port: info.port,
    triggerMsg: info.triggerMsg || null,
    ts: Date.now()
  });
  trimRecentBotReplies();
  updateTaskRequestFromBotReply({
    workspace,
    triggerMsg: info.triggerMsg,
    text: info.text,
  });
}

function updateTaskRequestFromBotReply({ workspace, triggerMsg, text, runtimeDir = RUNTIME_DIR }) {
  if (!workspace || !triggerMsg || !triggerMsg.message_id) {
    return null;
  }
  const tasks = findTaskRequestsByMessage({ workspace, messageID: triggerMsg.message_id })
    .filter((item) => ["delegated", "running"].includes(String(item.status || "")));
  if (tasks.length === 0) {
    return null;
  }
  const task = tasks[tasks.length - 1];
  const receipt = readTaskReceipt({ workspace, id: task.id });
  if (receipt && receipt.status) {
    updateTaskRequest({
      workspace,
      id: task.id,
      status: receipt.status === "done" || receipt.status === "failed" ? receipt.status : "done",
      result: receipt.result || null,
      error: receipt.error || "",
    });
    return { task, status: receipt.status, source: "receipt" };
  }
  const inferred = inferTaskReplyStatus(text);
  if (!inferred) {
    return null;
  }
  const artifactCheck = taskReplyArtifacts({ workspace, task, text, inferred });
  const finalStatus = artifactCheck.status || inferred.status;
  const uploadOutbox = finalStatus === "done"
    ? enqueueTaskArtifactUploads({ workspace, task, artifacts: artifactCheck.artifacts, runtimeDir })
    : null;
  const generated = writeTaskReceipt({
    workspace,
    id: task.id,
    receipt: {
      status: finalStatus,
      result: {
        ok: finalStatus === "done",
        summary: String(text || "").replace(/\s+/g, " ").trim().slice(0, 240),
        reason: artifactCheck.reason || "",
      },
      artifacts: artifactCheck.artifacts,
      checks: [
        { name: "agent_reply", status: inferred.status === "done" ? "passed" : "failed" },
        ...artifactCheck.checks,
        ...(uploadOutbox && uploadOutbox.check ? [uploadOutbox.check] : []),
      ],
    },
  });
  if (finalStatus === "done") {
    archiveAcademicTaskResult({
      workspace,
      task,
      text,
      artifacts: artifactCheck.artifacts,
      status: finalStatus,
    });
  }
  updateTaskRequest({
    workspace,
    id: task.id,
    status: finalStatus,
    result: generated && generated.receipt && generated.receipt.result || null,
    error: finalStatus === "failed" ? artifactCheck.reason || "" : "",
  });
  return { task, status: finalStatus, source: "reply" };
}

function enqueueTaskArtifactUploads({ workspace, task, artifacts = [], runtimeDir = RUNTIME_DIR }) {
  if (!task || !["file_modify_and_return", "script_create_and_run", "vivado_simulation"].includes(String(task.task_type || ""))) {
    return null;
  }
  const rows = taskArtifactOutboxRows({ workspace, task, artifacts });
  if (rows.length === 0) {
    return null;
  }
  const scope = String(task.scope || "") === "group" ? "group" : "private";
  const dirName = scope === "group" ? "group-file-outbox" : "private-file-outbox";
  const dir = path.join(runtimeDir, dirName);
  ensureDir(dir);
  const file = path.join(dir, `${safeName(task.id)}.json`);
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    source: "task_artifact",
    task_id: task.id,
    task_type: task.task_type,
    created_at: new Date().toISOString(),
    files: rows,
  }, null, 2)}\n`, "utf8");
  return {
    path: file,
    relative_path: path.relative(runtimeDir, file).replace(/\\/g, "/"),
    rows,
    check: { name: "file_outbox", status: "queued", detail: path.relative(runtimeDir, file).replace(/\\/g, "/") },
  };
}

function taskArtifactOutboxRows({ workspace, task, artifacts = [] }) {
  const rows = [];
  const scope = String(task && task.scope || "") === "group" ? "group" : "private";
  for (const artifact of artifacts || []) {
    if (typeof artifact !== "string" || !artifact.startsWith("local_files/")) {
      continue;
    }
    const checked = validateTaskArtifactPath({
      workspace,
      rawPath: artifact,
      requireModified: task.task_type === "file_modify_and_return",
      requireGenerated: task.task_type === "script_create_and_run",
    });
    if (!checked.ok) {
      continue;
    }
    if (task.task_type === "vivado_simulation" && !isChatImageFile(checked.relative_path)) {
      continue;
    }
    const row = {
      type: scope,
      path: checked.relative_path,
      name: path.basename(checked.relative_path),
      task_id: task.id,
      task_type: task.task_type,
    };
    if (scope === "group") {
      row.group_id = String(task.scope_id || "");
    } else {
      row.user_id = String(task.user_id || task.scope_id || "");
    }
    rows.push(row);
  }
  return rows;
}

function inferTaskReplyStatus(text) {
  const value = String(text || "");
  if (!value.trim()) return null;
  if (/失败|错误|无法|不能|报错|未完成/.test(value)) {
    return { status: "failed", artifacts: [] };
  }
  if (/还缺|需要你|请(?:上传|提供|确认|指定)|待确认|是否/.test(value)) {
    return null;
  }
  const artifacts = [...value.matchAll(/(?:^|[\s，。；:：])((?:local_files|memory\/task-results)\/[^\s，。；"'<>]+)/g)]
    .map((match) => match[1])
    .slice(0, 8);
  if (artifacts.length > 0 || /已(?:完成|创建|修改|保存|部署|更新)|完成了|改好了|保存到/.test(value)) {
    return { status: "done", artifacts };
  }
  return null;
}

function taskReplyArtifacts({ workspace, task, text, inferred }) {
  const mentioned = extractTaskArtifactPaths(text);
  if (task && task.task_type === "file_modify_and_return") {
    if (mentioned.length === 0 && inferred.status === "done") {
      return {
        status: "failed",
        reason: "missing_modified_file_path",
        artifacts: [],
        checks: [{ name: "artifact_path", status: "failed" }],
      };
    }
    const valid = [];
    const failed = [];
    for (const item of mentioned) {
      const checked = validateTaskArtifactPath({ workspace, rawPath: item, requireModified: true });
      if (checked.ok) {
        valid.push(checked.relative_path);
      } else {
        failed.push({ path: item, reason: checked.reason });
      }
    }
    if (valid.length === 0 && mentioned.length > 0) {
      return {
        status: "failed",
        reason: failed[0] && failed[0].reason || "invalid_artifact",
        artifacts: mentioned,
        checks: [{ name: "artifact_file", status: "failed" }],
      };
    }
    return {
      status: inferred.status,
      artifacts: valid,
      checks: valid.length ? [{ name: "artifact_file", status: "passed" }] : [],
    };
  }
  if (task && task.task_type === "script_create_and_run") {
    if (mentioned.length === 0 && inferred.status === "done") {
      return {
        status: "failed",
        reason: "missing_generated_script_path",
        artifacts: [],
        checks: [{ name: "artifact_path", status: "failed" }],
      };
    }
    const valid = [];
    const checkRows = [];
    const failed = [];
    for (const item of mentioned) {
      const checked = validateTaskArtifactPath({ workspace, rawPath: item, requireGenerated: true });
      if (checked.ok) {
        valid.push(checked.relative_path);
        const checks = runScriptTaskChecks({
          workspace,
          filePath: checked.path,
          checks: task.spec && task.spec.checks || ["syntax"],
        });
        checkRows.push(...checks.checks);
        if (!checks.ok) {
          failed.push({ path: item, reason: checks.reason || "script_check_failed" });
        }
      } else {
        failed.push({ path: item, reason: checked.reason });
      }
    }
    if (valid.length === 0 && mentioned.length > 0) {
      return {
        status: "failed",
        reason: failed[0] && failed[0].reason || "invalid_script_artifact",
        artifacts: mentioned,
        checks: [{ name: "script_artifact_file", status: "failed" }],
      };
    }
    if (failed.length > 0) {
      return {
        status: "failed",
        reason: failed[0].reason || "script_check_failed",
        artifacts: valid,
        checks: [
          { name: "script_artifact_file", status: "passed" },
          ...checkRows,
        ],
      };
    }
    return {
      status: inferred.status,
      artifacts: valid,
      checks: valid.length ? [{ name: "script_artifact_file", status: "passed" }, ...checkRows] : [],
    };
  }
  return {
    status: inferred.status,
    artifacts: inferred.artifacts || mentioned,
    checks: [],
  };
}

function extractTaskArtifactPaths(text) {
  const value = String(text || "");
  return [...value.matchAll(/(?:^|[\s，。；:：])((?:local_files|memory\/task-results)\/[^\s，。；"'<>]+)/g)]
    .map((match) => stripOutgoingPathToken(match[1]))
    .filter(Boolean)
    .slice(0, 8);
}

function validateTaskArtifactPath({ workspace, rawPath, requireModified = false, requireGenerated = false }) {
  const clean = stripOutgoingPathToken(rawPath).replace(/\\/g, "/");
  if (requireModified && !clean.startsWith("local_files/modified/")) {
    return { ok: false, reason: "artifact_must_be_local_files_modified", relative_path: clean };
  }
  if (requireGenerated && !clean.startsWith("local_files/generated/")) {
    return { ok: false, reason: "artifact_must_be_local_files_generated", relative_path: clean };
  }
  const resolved = resolveOutgoingFilePath(clean, workspace);
  if (!resolved) {
    return { ok: false, reason: "invalid_artifact_path", relative_path: clean };
  }
  const checked = validateOutgoingFilePath(resolved, workspace);
  if (!checked.ok) {
    return { ok: false, reason: checked.reason, relative_path: clean };
  }
  return {
    ok: true,
    path: checked.path,
    relative_path: path.relative(workspace, checked.path).replace(/\\/g, "/"),
  };
}

function trimRecentBotReplies() {
  const cutoff = Date.now() - FEEDBACK_WINDOW_SECONDS * 1000;
  while (recentBotReplies.length > 0 && (recentBotReplies[0].ts < cutoff || recentBotReplies.length > 200)) {
    recentBotReplies.shift();
  }
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

function continuityStatus(msg) {
  const scope = msg.message_type === "private" ? "private" : "group";
  const scopeID = msg.message_type === "private" ? msg.user_id : msg.group_id;
  const snap = activitySnapshot({ scope, scopeID, thresholdMinutes: CONTINUITY_GAP_MINUTES });
  return [
    "会话连续性：",
    `开关：${CONTINUITY_ENABLED ? "启用" : "关闭"}`,
    `范围：${scope}:${scopeID}`,
    `最后活跃：${snap.lastActivity || "暂无"}`,
    `间隙：${snap.hasGap ? `${snap.gapMinutes} 分钟` : "未达到阈值"}`,
    `恢复上下文：${CONTINUITY_ENABLED && snap.hasGap ? `待注入；下一条正文会消费；将取最近 ${CONTINUITY_MESSAGE_LIMIT} 条` : "不会注入"}`,
    `阈值：${CONTINUITY_GAP_MINUTES} 分钟`,
    `恢复消息数：${CONTINUITY_MESSAGE_LIMIT}`
  ].join("\n");
}

function moodStatus(msg) {
  const workspace = msg.message_type === "private" ? workspaceForPrivateUser(msg.user_id) : workspaceForGroup(msg.group_id);
  if (msg.message_type === "private") {
    const mood = readMoodState(workspace);
    if (!mood) return `暂无情绪状态。\n开关：${MOOD_ENABLED ? "启用" : "关闭"}\n历史窗口：${MOOD_HISTORY_LIMIT} 条`;
    return [
      "情绪状态：",
      `开关：${MOOD_ENABLED ? "启用" : "关闭"}`,
      `mood：${mood.mood}`,
      `置信度：${mood.confidence}`,
      `信号：${(mood.signals || []).join("，") || "暂无"}`,
      `历史窗口：${MOOD_HISTORY_LIMIT} 条`,
      `更新时间：${mood.updated_at || ""}`
    ].join("\n");
  }
  const energy = readGroupEnergyState(workspace);
  if (!energy) return `暂无群聊能量状态。\n开关：${MOOD_ENABLED ? "启用" : "关闭"}\n窗口：${Math.round(ENERGY_WINDOW_MS / 60000)} 分钟`;
  const ageSeconds = energy.updated_at ? Math.max(0, Math.floor((Date.now() - new Date(energy.updated_at).getTime()) / 1000)) : 0;
  return [
    "群聊能量：",
    `开关：${MOOD_ENABLED ? "启用" : "关闭"}`,
    `level：${energy.level}`,
    `消息数：${energy.message_count}`,
    `参与者：${energy.participant_count}`,
    `窗口：${Math.round((energy.window_ms || ENERGY_WINDOW_MS) / 60000)} 分钟`,
    "阈值：high=消息>6 且参与者>2；medium=消息>=3 或参与者>1",
    `数据年龄：${ageSeconds} 秒`,
    `行为影响：${energy.level === "high" ? "上下文会建议少打断，只接明确问题" : "无额外高能量约束"}`,
    `更新时间：${energy.updated_at || ""}`
  ].join("\n");
}

function feedbackStatus(msg, body = "") {
  const workspace = msg.message_type === "private" ? workspaceForPrivateUser(msg.user_id) : workspaceForGroup(msg.group_id);
  const pending = feedbackPendingSummary(msg);
  if (/最近|recent/i.test(String(body || ""))) {
    const { formatFeedbackHistory } = require("./lib/feedback-detector");
    return [
      feedbackFeatureSummary(pending),
      formatFeedbackHistory(readSignals({ workspace, limit: 8 }))
    ].join("\n");
  }
  const { formatFeedbackStats } = require("./lib/feedback-detector");
  return [
    feedbackFeatureSummary(pending),
    formatFeedbackStats(feedbackStats({ workspace }))
  ].join("\n");
}

function feedbackFeatureSummary(pending) {
  return [
    "反馈检测：",
    `开关：${FEEDBACK_ENABLED ? "启用" : "关闭"}`,
    `窗口：${FEEDBACK_WINDOW_SECONDS} 秒`,
    `待观察 bot 回复：${pending.count}`,
    `最近回复：${pending.latest || "暂无"}`
  ].join("\n");
}

function feedbackPendingSummary(msg) {
  trimRecentBotReplies();
  const scope = msg.message_type === "private" ? "private" : "group";
  const scopeID = String(scope === "private" ? msg.user_id : msg.group_id);
  const items = recentBotReplies.filter((reply) => reply.scope === scope && reply.scopeID === scopeID);
  const latest = items.at(-1);
  return {
    count: items.length,
    latest: latest ? `${Math.max(0, Math.floor((Date.now() - latest.ts) / 1000))} 秒前 msg ${latest.messageID || "?"}` : ""
  };
}

function proactiveStatus(msg) {
  if (msg.message_type !== "group") return "主动参与只对群聊生效。";
  const quietUntil = quietUntilByGroup.get(Number(msg.group_id)) || 0;
  const quietRemainingMs = Math.max(0, quietUntil - Date.now());
  const snap = proactivitySnapshot({
    groupID: msg.group_id,
    defaultLevel: PROACTIVE_LEVEL,
    levels: proactiveLevelByGroup,
    cooldownMs: PROACTIVE_COOLDOWN_MS
  });
  return formatProactivityStatus(snap, {
    enabled: PROACTIVE_ENABLED,
    quiet: isGroupQuiet(msg.group_id),
    quietUntil: quietRemainingMs ? quietUntil : 0,
    quietRemainingMs,
    checkinHours: PROACTIVE_CHECKIN_HOURS,
    checkinIntervalMs: PROACTIVE_CHECKIN_INTERVAL_MS,
    recentEvaluations: proactiveEvaluationsByGroup.get(String(msg.group_id)) || []
  });
}

function setProactivityLevelForGroup(groupID, level) {
  return setProactivityLevel({ groupID, level, levels: proactiveLevelByGroup });
}

function runPrivateCheckins() {
  if (!PROACTIVE_ENABLED || PROACTIVE_LEVEL === "off") {
    return;
  }
  for (const userID of ALLOWED_PRIVATE_USERS) {
    const workspace = workspaceForPrivateUser(userID);
    const snap = activitySnapshot({ scope: "private", scopeID: userID, thresholdMinutes: 1 });
    const lastSent = privateCheckinAtByUser.get(Number(userID)) || 0;
    if (Date.now() - lastSent < PROACTIVE_CHECKIN_HOURS * 3600000) {
      continue;
    }
    const result = evaluatePrivateCheckin({
      workspace,
      userID,
      lastActivity: snap.lastActivity,
      hours: PROACTIVE_CHECKIN_HOURS
    });
    if (!result.shouldCheckin) {
      continue;
    }
    privateCheckinAtByUser.set(Number(userID), Date.now());
    sendPrivateText(userID, 0, formatPrivateCheckinMessage(result));
    log("private proactive checkin", userID, result.reason);
  }
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
  if (path.extname(file).toLowerCase() === ".jsonl") {
    appendJSONL(file, line);
    return;
  }
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
  if (CONTINUITY_ENABLED) {
    trackActivity({ scope: "group", scopeID: msg.group_id, userID: msg.user_id, timestamp: record.time, gapMinutes: CONTINUITY_GAP_MINUTES });
  }
  if (MOOD_ENABLED) {
    safeRuntime(() => updateGroupEnergy({ workspace, groupID: msg.group_id, windowMs: ENERGY_WINDOW_MS }), "group-energy");
  }
  if (FEEDBACK_ENABLED) {
    safeRuntime(() => maybeRecordFeedback(workspace, msg), "feedback");
  }
  touchMemberProfile(workspace, msg);
  messagesSinceLastTidy += 1;
  if (messagesSinceLastTidy >= Number(process.env.CHATBOT_QQ_MEMORY_TIDY_INTERVAL_MSGS || 100)) {
    try {
      const result = deterministicTidy({ workspace });
      messagesSinceLastTidy = 0;
      lastTidyTime = Date.now();
      if (result.skipped > 0) {
        console.log(`[memory-tidy] L0 completed: deduped=${result.deduped} expired=${result.expired} skipped=${result.skipped}`);
      }
    } catch (err) {
      console.error("[memory-tidy] L0 error:", err.message);
    }
  }
}

function taskAgentOptions() {
  return {
    runtimeDir: RUNTIME_DIR,
    timezone: TASK_AGENT_TIMEZONE,
    today: todayLocal(),
  };
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
  if (CONTINUITY_ENABLED) {
    trackActivity({ scope: "private", scopeID: msg.user_id, userID: msg.user_id, timestamp: record.time, gapMinutes: CONTINUITY_GAP_MINUTES });
  }
  if (MOOD_ENABLED) {
    safeRuntime(() => updatePrivateMood({
      workspace,
      userID: msg.user_id,
      text: record.text,
      historyLimit: MOOD_HISTORY_LIMIT,
      messageID: msg.message_id
    }), "private-mood");
  }
  if (FEEDBACK_ENABLED) {
    safeRuntime(() => maybeRecordFeedback(workspace, msg), "feedback");
  }
  touchPrivateProfile(workspace, msg);
}

function safeRuntime(fn, label) {
  try {
    return fn();
  } catch (err) {
    log("runtime hook error", label, err.message);
    recordError("runtime-hook", err.message, { detail: label });
    return null;
  }
}

function maybeRecordFeedback(workspace, msg) {
  trimRecentBotReplies();
  const scope = msg.message_type === "private" ? "private" : "group";
  const scopeID = String(scope === "private" ? msg.user_id : msg.group_id);
  const item = recentBotReplies.slice().reverse().find((reply) =>
    reply.scope === scope && reply.scopeID === scopeID && Date.now() - reply.ts <= FEEDBACK_WINDOW_SECONDS * 1000
  );
  if (!item) {
    return null;
  }
  const signal = detectFeedbackSignal({ triggerMsg: item.triggerMsg, replyMsgID: item.messageID, feedbackMsg: msg });
  if (!signal) {
    return null;
  }
  signal.gap_seconds = Math.max(0, Math.floor((Date.now() - item.ts) / 1000));
  const saved = recordFeedbackSignal({ workspace, signal });
  if (saved) {
    log("feedback", saved.scope, saved.scope_id, saved.signal_type, saved.confidence);
  }
  return saved;
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
  dispatchToPortWhenReady(route.port, synthetic);
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
    if (!isPdfFileData(seg.data)) {
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

function isPdfFileData(data) {
  const name = String((data && (data.name || data.file_name || data.file || data.path || data.url)) || "");
  return name.toLowerCase().endsWith(".pdf");
}

function requestPrivateFileDownload(msg, data) {
  const fileID = data && (data.id || data.file_id);
  if (!fileID) {
    return false;
  }
  const echo = `__file_private_${msg.user_id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  log("private file download requested", msg.user_id, data.name || data.file_name || "file");
  return true;
}

function retryPendingPrivatePdfDownloads() {
  if (!upstream || upstream.readyState !== WebSocket.OPEN || !upstreamReady) {
    return 0;
  }
  let requested = 0;
  for (const userID of ALLOWED_PRIVATE_USERS) {
    const workspace = workspaceForPrivateUser(userID);
    const eventsPath = path.join(workspace, "memory", `file-events-${todayLocal()}.jsonl`);
    if (!fs.existsSync(eventsPath)) {
      continue;
    }
    const lines = fs.readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-30);
    for (const line of lines) {
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      if (!item || item.type !== "private_pdf_pending" || !item.file || !isPdfFileData(item.file)) {
        continue;
      }
      const fileID = item.file.id || item.file.file_id;
      if (!fileID) {
        continue;
      }
      const name = safeName(item.file.name || item.file.file_name || item.file.file || `${fileID}.pdf`);
      const target = path.join(workspace, "local_files", "pdfs", name);
      if (fs.existsSync(target)) {
        continue;
      }
      const retryKey = `${userID}:${fileID}`;
      if (pendingPrivatePdfRetryKeys.has(retryKey)) {
        continue;
      }
      pendingPrivatePdfRetryKeys.add(retryKey);
      if (requestPrivateFileDownload({ user_id: userID, message_id: item.message_id || "" }, item.file)) {
        requested += 1;
      }
    }
  }
  if (requested > 0) {
    log("pending private pdf retry requested", requested);
  }
  return requested;
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
    const localSource = resolveReadableFilePath(source);
    if (localSource) {
      fs.copyFileSync(localSource, target);
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
      return [];
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

function handleGroupIncrease(msg) {
  if (!PROACTIVE_ENABLED || isGroupQuiet(msg.group_id)) {
    return;
  }
  const level = proactiveLevelByGroup.get(Number(msg.group_id)) || PROACTIVE_LEVEL;
  if (!["normal", "high"].includes(level)) {
    return;
  }
  const userID = msg.user_id || msg.operator_id || "";
  const text = userID ? `欢迎新成员 ${userID}。` : "欢迎新成员。";
  sendGroupText(msg.group_id, 0, text);
}

function runDueRotas(now = new Date()) {
  for (const groupID of ALLOWED_GROUPS) {
    try {
      const workspace = workspaceForGroup(groupID);
      for (const item of dueRotas(workspace, now)) {
        sendGroupMessage(groupID, 0, item.message || item.text);
        log("rota sent", "group", groupID, "id", item.rota.id);
      }
    } catch (err) {
      log("rota check failed", "group", groupID, err.message);
      recordError("rota", err.message, { scope: "group", target: String(groupID) });
    }
  }
}

function runDueReminders(now = new Date()) {
  for (const groupID of ALLOWED_GROUPS) {
    try {
      const workspace = workspaceForGroup(groupID);
      for (const item of dueReminders(workspace, now)) {
        sendGroupMessage(groupID, 0, item.message || item.text);
        log("reminder sent", "group", groupID, "id", item.reminder.id);
      }
    } catch (err) {
      log("reminder check failed", "group", groupID, err.message);
      recordError("reminder", err.message, { scope: "group", target: String(groupID) });
    }
  }
  for (const userID of ALLOWED_PRIVATE_USERS) {
    try {
      const workspace = workspaceForPrivateUser(userID);
      for (const item of dueReminders(workspace, now)) {
        sendPrivateText(userID, 0, item.text);
        log("reminder sent", "private", userID, "id", item.reminder.id);
      }
    } catch (err) {
      log("reminder check failed", "private", userID, err.message);
      recordError("reminder", err.message, { scope: "private", target: String(userID) });
    }
  }
}

function runDueCourses(now = new Date()) {
  for (const groupID of ALLOWED_GROUPS) {
    try {
      const workspace = workspaceForGroup(groupID);
      for (const item of dueCourseNotifications(workspace, now)) {
        sendGroupMessage(groupID, 0, item.message || item.text);
        log("course reminder sent", "group", groupID, "id", item.schedule.id, "kind", item.event.kind);
      }
    } catch (err) {
      log("course reminder check failed", "group", groupID, err.message);
      recordError("course-reminder", err.message, { scope: "group", target: String(groupID) });
    }
  }
  for (const userID of ALLOWED_PRIVATE_USERS) {
    try {
      const workspace = workspaceForPrivateUser(userID);
      for (const item of dueCourseNotifications(workspace, now)) {
        sendPrivateText(userID, 0, item.text);
        log("course reminder sent", "private", userID, "id", item.schedule.id, "kind", item.event.kind);
      }
    } catch (err) {
      log("course reminder check failed", "private", userID, err.message);
      recordError("course-reminder", err.message, { scope: "private", target: String(userID) });
    }
  }
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
      dispatchToPortWhenReady(route.port, synthetic);
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
    extraRequiredPorts: [VIVADO_TASK_PORT].filter(Boolean),
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
      projectRoot: path.dirname(WORKSPACE_ROOT),
      workspaceRoot: WORKSPACE_ROOT,
      workspaceForGroup,
      allowedGroups: ALLOWED_GROUPS,
      defaultListenMode: LISTEN_TRIGGER_MODE,
      dreamEnabled: DREAM_COMMAND_ENABLED,
      imageEnabled: IMAGE_COMMAND_ENABLED,
      imageScript: IMAGE_SCRIPT,
      renderScript: RENDER_SCRIPT,
      renderImageMagickScript: RENDER_IMAGEMAGICK_SCRIPT,
      taskTimezone: TASK_AGENT_TIMEZONE,
      plugins: pluginManager.snapshot()
    }),
    log
  });
}

function reloadRuntime() {
  listenModeByGroup.clear();
  quietUntilByGroup.clear();
  proactiveLevelByGroup.clear();
  loadProxyState({
    file: PROXY_STATE_FILE,
    listenModes: listenModeByGroup,
    quietUntil: quietUntilByGroup,
    proactiveLevels: proactiveLevelByGroup,
    atOnlyGroups: AT_ONLY_GROUPS,
    log
  });
  pluginManager.reload();
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
  setInterval(drainFileOutboxes, OUTGOING_FILE_OUTBOX_SCAN_INTERVAL_MS).unref();
  setInterval(runPrivateCheckins, PROACTIVE_CHECKIN_INTERVAL_MS).unref();
  setInterval(runDueRotas, ROTA_CHECK_INTERVAL_MS).unref();
  setInterval(() => {
    runPluginSchedule("reminder_due", new Date()).catch((err) => recordError("plugin", err.message, { scope: "system", target: "schedule", detail: "reminder_due" }));
  }, REMINDER_CHECK_INTERVAL_MS).unref();
  setInterval(runDueCourses, COURSE_CHECK_INTERVAL_MS).unref();
}

module.exports = {
  shouldRenderAsImage,
  maybeRenderOutgoingAsImage,
  outgoingRenderTarget,
  renderForQQ,
  enrichMessageForAgent,
  promptInjectionGuardForMessage,
  composeEnrichedContext,
  taskAgentContextForMessage,
  feedbackContextSignalsForMessage,
  profileContextsForMessage,
  groupEnergyContextForMessage,
  shouldSkipGroupEnergyContext,
  isExplicitQaRequest,
  isReplyToKnownBotMessage,
  messageText,
  imageSourcesForMessage,
  normalizeVisualMessage,
  normalizeVisualSegments,
  shouldDispatchListenMessage,
  shouldSilenceAtOnlyGroupMessage,
  recentGroupFilesContextForMessage,
  naturalTaskRouteForMessage,
  heavyTaskPortForMessage,
  workspaceForGroup,
  workspaceForPrivateUser,
  executionWorkspaceForPrivateUser,
  explainRouteScope,
  parseImageCredentials,
  controlCommandPayload,
  shouldAdminPokeAck,
  adminPokePayload,
  shouldSilenceOutgoing,
  isChatImageFile,
  shouldUploadMentionedFiles,
  collectOutgoingFileUploadCandidates,
  fileOutboxCandidates,
  drainFileOutboxes,
  outboxMatchesTarget,
  resolveOutgoingFilePath,
  validateOutgoingFilePath,
  rememberActiveTriggerMessage,
  trackOutgoingAPI,
  handleBotReplyResponse,
  updateTaskRequestFromBotReply,
  enqueueTaskArtifactUploads,
  taskArtifactOutboxRows,
  recordTaskArtifactUploadResult,
  extractTaskArtifactPaths,
  validateTaskArtifactPath,
  recordGroupMessage,
  isRotaIntent,
  tryHandleRotaFollowup,
  tryHandleAcademicSearch,
  tryHandleNaturalTask,
  tryHandleTaskContinueCommand,
  taskContinueRequestForMessage,
  parseTaskContinueCommand,
  awaitingNaturalTaskContinuation,
  runDueRotas,
  runDueReminders,
  runDueCourses,
  isDreamCommand,
  isImageCommand,
  imagePromptFromMessage,
  pluginManager,
  isPdfFileData,
  retryPendingPrivatePdfDownloads,
  recentBotReplies,
  WORKSPACE_ROOT,
  ADMIN_ROOT_USERS,
  ADMIN_POKE_ACK_USERS
};
