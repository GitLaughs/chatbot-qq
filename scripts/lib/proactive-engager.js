const fs = require("fs");
const path = require("path");
const { looksSensitive } = require("./sensitive-redaction");
const { readJSONLShardLines } = require("./jsonl-shards");

const lastEngagementByGroup = new Map();

function evaluateGroupEngagement({ workspace, groupID, msg, level = "normal", cooldownMs = 900000 }) {
  const normalizedLevel = normalizeLevel(level);
  if (normalizedLevel === "off") {
    return { shouldEngage: false, reason: "off", confidence: 0 };
  }
  const cooldown = normalizedCooldownMs(cooldownMs);
  const key = String(groupID || "");
  const last = lastEngagementByGroup.get(key) || 0;
  if (Date.now() - last < cooldown) {
    return { shouldEngage: false, reason: "cooldown", confidence: 0 };
  }
  const text = messageText(msg);
  if (isCommandLikeText(text)) {
    return { shouldEngage: false, reason: "command", confidence: 0 };
  }
  if (!isActionableGroupText(text)) {
    return { shouldEngage: false, reason: "low_information", confidence: 0 };
  }
  if (normalizedLevel !== "high" && !hasEngagementIntent(msg, text)) {
    return { shouldEngage: false, reason: "no_intent", confidence: 0 };
  }
  const overlap = keywordOverlap(text, workspaceKeywords(workspace));
  const threshold = normalizedLevel === "high" ? 2 : 3;
  const minConfidence = normalizedLevel === "low" ? 0.8 : normalizedLevel === "high" ? 0.5 : 0.65;
  const confidence = Math.min(0.95, overlap.length / 4);
  if (overlap.length >= threshold && confidence >= minConfidence) {
    lastEngagementByGroup.set(key, Date.now());
    return {
      shouldEngage: true,
      reason: "knowledge_match",
      confidence,
      topic: overlap.slice(0, 5).join("、")
    };
  }
  return { shouldEngage: false, reason: "no_match", confidence };
}

function evaluatePrivateCheckin({ workspace, userID, lastActivity, hours = 4 }) {
  if (!lastActivity) {
    return { shouldCheckin: false, reason: "missing_activity" };
  }
  const last = Number(new Date(lastActivity).getTime());
  if (!Number.isFinite(last) || last <= 0) {
    return { shouldCheckin: false, reason: "invalid_activity" };
  }
  if (Date.now() - last < Number(hours || 4) * 3600000) {
    return { shouldCheckin: false, reason: "recent" };
  }
  const openItems = readOpenTodoItems({ workspace, userID, limit: 100 });
  if (openItems.length === 0) {
    return { shouldCheckin: false, reason: "no_open_item" };
  }
  return {
    shouldCheckin: true,
    reason: "open_item_idle",
    userID: String(userID || ""),
    openCount: openItems.length,
    item: todoTitle(openItems.at(-1))
  };
}

function buildProactiveContext({ reason, topic }) {
  if (!reason) return "";
  return `【主动参与上下文】触发原因：${reason}${topic ? `；相关关键词：${topic}` : ""}。回复要短，先说明为什么插话。`;
}

function formatPrivateCheckinMessage(result) {
  const count = Math.max(0, Number(result && result.openCount) || 0);
  const item = safeCheckinItem((result && result.item) || "");
  const label = item ? `「${item}」` : "其中一个事项";
  if (count > 1 && item) {
    return `你这边还有 ${count} 个未完成事项，最近一个是${label}。方便的话回我一句当前进展；不急。`;
  }
  if (item) {
    return `你这边还有一个未完成事项：${label}。方便的话回我一句当前进展；不急。`;
  }
  if (count > 1) {
    return `你这边还有 ${count} 个未完成事项，其中一个事项可能需要继续处理。方便的话回我一句当前进展；不急。`;
  }
  return "你这边还有未完成事项。方便的话回我一句当前进展；不急。";
}

function setProactivityLevel({ groupID, level, levels }) {
  const next = normalizeLevel(level);
  if (!next) return null;
  levels.set(Number(groupID), next);
  return next;
}

function proactivitySnapshot({ groupID, defaultLevel = "normal", levels = new Map(), cooldownMs = 900000 }) {
  const key = String(groupID || "");
  const last = lastEngagementByGroup.get(key) || 0;
  const remaining = last ? Math.max(0, normalizedCooldownMs(cooldownMs) - (Date.now() - last)) : 0;
  const normalizedDefault = normalizeLevel(defaultLevel) || "normal";
  const overrideLevel = levels.has(Number(groupID)) ? levels.get(Number(groupID)) : "";
  return {
    groupID: key,
    defaultLevel: normalizedDefault,
    overrideLevel,
    level: overrideLevel || normalizedDefault,
    cooldownRemainingMs: remaining,
    lastEngagement: last ? new Date(last).toISOString() : ""
  };
}

function formatProactivityStatus(snapshot, options = {}) {
  const snap = snapshot || {};
  const enabled = options.enabled !== false;
  const quietRemainingMs = Math.max(0, Number(options.quietRemainingMs || 0));
  const quietUntil = options.quietUntil ? new Date(options.quietUntil).toISOString() : "";
  const quiet = Boolean(options.quiet) || quietRemainingMs > 0;
  const cooldownSeconds = Math.ceil((snap.cooldownRemainingMs || 0) / 1000);
  const defaultLevel = snap.defaultLevel || options.defaultLevel || "normal";
  const overrideLevel = snap.overrideLevel || "";
  const effectiveLevel = snap.level || overrideLevel || defaultLevel;
  const checkinEnabled = enabled && defaultLevel !== "off";
  const checkinMinutes = Math.round((options.checkinIntervalMs || 1800000) / 60000);
  const quietDetail = quiet
    ? `开启${quietRemainingMs ? `，剩余 ${Math.ceil(quietRemainingMs / 1000)} 秒` : ""}${quietUntil ? `，到期 ${quietUntil}` : ""}`
    : "关闭";
  let currentState = "可评估";
  if (!enabled) {
    currentState = "不会插话：全局关闭";
  } else if (effectiveLevel === "off") {
    currentState = "不会插话：级别 off";
  } else if (quiet) {
    currentState = `不会插话：静默${quietRemainingMs ? `剩余 ${Math.ceil(quietRemainingMs / 1000)} 秒` : "开启"}`;
  } else if (cooldownSeconds > 0) {
    currentState = `不会插话：冷却剩余 ${cooldownSeconds} 秒`;
  }
  const lines = [
    "主动参与：",
    `当前状态：${currentState}`,
    `全局开关：${enabled ? "启用" : "关闭"}`,
    `默认级别：${defaultLevel}`,
    `本群覆盖级别：${overrideLevel || "未设置"}`,
    `本群生效级别：${effectiveLevel}`,
    `静默：${quietDetail}`,
    `冷却剩余：${cooldownSeconds} 秒`,
    `上次触发：${snap.lastEngagement || "暂无"}`,
    "触发门槛：off=关闭；low=overlap>=3 且 confidence>=0.8；normal=求助/提问 且 overlap>=3；high=overlap>=2，均受冷却限制。",
    `私聊签到：${checkinEnabled ? `启用，空闲 ${options.checkinHours || 4} 小时且有未完成事项；检查间隔约 ${checkinMinutes} 分钟` : `关闭（${enabled ? "默认级别为 off" : "全局开关关闭"}）`}`
  ];
  const recentEvaluations = Array.isArray(options.recentEvaluations) ? options.recentEvaluations.slice(-5) : [];
  if (recentEvaluations.length > 0) {
    lines.push("最近评估：");
    for (const item of recentEvaluations.slice().reverse()) {
      const age = item && item.time ? Math.max(0, Math.floor((Date.now() - new Date(item.time).getTime()) / 1000)) : 0;
      lines.push(`- ${item.outcome || "skip"} ${item.reason || "unknown"} confidence=${Number(item.confidence || 0).toFixed(2)}${item.topic ? ` topic=${item.topic}` : ""}${age ? ` ${age} 秒前` : ""}`);
    }
  }
  if (quiet) {
    lines.push("当前群处于安静状态，主动插话会跳过。");
  }
  return lines.join("\n");
}

function keywordOverlap(text, keywords) {
  const lower = stripNoiseForOverlap(visibleText(text)).toLowerCase();
  const seen = new Set();
  for (const keyword of keywords || []) {
    const item = String(keyword || "").toLowerCase().trim();
    if (isUsefulKeyword(item) && keywordMatches(lower, item)) {
      seen.add(item);
    }
  }
  return [...seen];
}

function workspaceKeywords(workspace) {
  const chunks = [
    readText(path.join(workspace || "", "KNOWLEDGE.md")),
    readText(path.join(workspace || "", "GROUP_PROFILE.md")),
    readRecentMemoryText(workspace)
  ].join("\n");
  const seen = new Set();
  const keywords = [];
  for (const raw of chunks.match(/[\u4e00-\u9fa5]{2,}|[a-z0-9_+./:@-]{3,}/gi) || []) {
    for (const item of expandKeyword(raw)) {
      if (!isUsefulKeyword(item) || seen.has(item)) {
        continue;
      }
      seen.add(item);
      keywords.push(item);
    }
  }
  return keywords.slice(-300);
}

function readRecentMemoryText(workspace) {
  const file = path.join(workspace || "", "memory", "memories.jsonl");
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-30).join("\n");
}

function readText(file) {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

function messageText(msg) {
  if (!msg) return "";
  if (typeof msg.raw_message === "string") return visibleText(msg.raw_message);
  if (typeof msg.message === "string") return visibleText(msg.message);
  if (Array.isArray(msg.message)) {
    return msg.message.map((seg) => seg && seg.type === "text" && seg.data ? String(seg.data.text || "") : "").join(" ");
  }
  return "";
}

function visibleText(value) {
  return String(value || "")
    .replace(/\[CQ:reply[^\]]*\]/gi, "")
    .replace(/\[CQ:image[^\]]*\]/gi, "[图片]")
    .replace(/\[CQ:file[^\]]*\]/gi, "[文件]")
    .replace(/\[CQ:mface[^\]]*summary=([^,\]]+)[^\]]*\]/gi, "$1")
    .replace(/\[CQ:[^\]]+\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isActionableGroupText(value) {
  const text = visibleText(value);
  const normalized = text.replace(/\s+/g, "");
  if (isCommandLikeText(text)) return false;
  if (normalized.length < 4) return false;
  if (/^\[(图片|文件)\]$/i.test(text)) return false;
  if (/^(嗯+|啊+|哈+|哈哈+|好的?|行|可以|ok|收到|谢谢|谢了|感谢|表情|图片)$/i.test(normalized)) return false;
  return true;
}

function isCommandLikeText(value) {
  const text = visibleText(value).trim();
  return /^[/／][\w\u4e00-\u9fa5-]+(?:\s|$)/i.test(text);
}

function hasEngagementIntent(msg, textValue = "") {
  const raw = String((msg && (msg.raw_message || msg.message)) || "");
  const text = visibleText(textValue || raw);
  if (/\[CQ:at,[^\]]+\]/i.test(raw) || /@\S+/.test(raw)) return true;
  return /[?？]|怎么|如何|为什么|能不能|可以帮|帮我|帮忙|报错|不对|不行|有人知道|谁知道|求助|请教|看看|解释一下|什么原因|失败|异常|连不上|启动不了|跑不起来|卡住|超时|timeout|failed|exception/i.test(text);
}

function stripNoiseForOverlap(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ")
    .replace(/[?&][a-z0-9_.-]+=[^\s&]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keywordMatches(text, keyword) {
  if (/^[a-z0-9_+-]+$/i.test(keyword)) {
    const escaped = escapeRegExp(keyword);
    return new RegExp(`(^|[^a-z0-9_+-])${escaped}($|[^a-z0-9_+-])`, "i").test(text);
  }
  return text.includes(keyword);
}

function expandKeyword(value) {
  const item = String(value || "").toLowerCase().trim();
  if (!/^[\u4e00-\u9fa5]{5,12}$/.test(item)) {
    return [item];
  }
  const out = [item];
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index <= item.length - size; index += 1) {
      out.push(item.slice(index, index + size));
    }
  }
  return out;
}

function normalizedCooldownMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 900000;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUsefulKeyword(value) {
  const item = String(value || "").toLowerCase().trim();
  if (item.length < 2 || STOP_WORDS.has(item)) return false;
  if (looksSensitive(item)) return false;
  if (/^https?:\/\//i.test(item) || /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(item)) return false;
  if (/^\d+$/.test(item)) return false;
  if (/^(id|ts|kind|text|time|user|group|status|version|memory|message|sender|nickname|raw_message|message_id|user_id|group_id|token|secret|cookie|authorization|api_key|apikey|access_token)$/.test(item)) return false;
  if (/^[\u4e00-\u9fa5]{2}$/.test(item) && SOFT_STOP_WORDS.has(item)) return false;
  return true;
}

function readOpenTodoItems({ workspace, userID, limit = 100 }) {
  const file = path.join(workspace || "", "memory", "todos.jsonl");
  const rows = [];
  for (const { line } of readJSONLShardLines(file).slice(-Math.max(1, Number(limit) || 100))) {
    try {
      const item = JSON.parse(line);
      if (isOpenTodoForUser(item, userID)) {
        rows.push(item);
      }
    } catch {
      // Ignore malformed todo rows.
    }
  }
  return rows;
}

function isOpenTodoForUser(item, userID) {
  if (!item || typeof item !== "object") return false;
  const status = String(item.status || "").toLowerCase();
  if (["done", "closed", "cancelled", "canceled"].includes(status)) return false;
  const doneAt = item.done_at !== undefined ? String(item.done_at || "") : "";
  const open = status === "open" || (item.done_at !== undefined && doneAt === "");
  if (!open) return false;
  const owner = item.userID ?? item.user_id ?? item.user ?? item.assignee ?? item.owner;
  if (owner === undefined || owner === null || owner === "") return true;
  return String(owner) === String(userID || "");
}

function todoTitle(item) {
  return String((item && (item.text || item.title || item.content || item.id)) || "").slice(0, 80);
}

function safeCheckinItem(value) {
  let text = visibleText(value)
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "")
    .replace(/\b[a-f0-9]{24,}\b/gi, "")
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || looksSensitive(text)) {
    return "";
  }
  return compact(text, 32);
}

function compact(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const max = Math.max(12, Number(limit) || 48);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function normalizeLevel(value) {
  const text = String(value || "").trim().toLowerCase();
  const aliases = new Map([
    ["off", "off"], ["关", "off"], ["关闭", "off"],
    ["low", "low"], ["低", "low"],
    ["normal", "normal"], ["默认", "normal"], ["中", "normal"],
    ["high", "high"], ["高", "high"]
  ]);
  return aliases.get(text) || "";
}

function resetProactiveState() {
  lastEngagementByGroup.clear();
}

const STOP_WORDS = new Set(["the", "and", "with", "this", "that", "一个", "这个", "那个", "就是", "可以", "我们", "你们", "他们", "今天", "默认", "记录"]);
const SOFT_STOP_WORDS = new Set(["项目", "功能", "问题", "代码", "测试", "消息", "用户", "群聊", "助手", "事情", "东西", "情况"]);

module.exports = {
  evaluateGroupEngagement,
  evaluatePrivateCheckin,
  buildProactiveContext,
  formatPrivateCheckinMessage,
  setProactivityLevel,
  proactivitySnapshot,
  formatProactivityStatus,
  keywordOverlap,
  workspaceKeywords,
  visibleText,
  isCommandLikeText,
  isActionableGroupText,
  hasEngagementIntent,
  readOpenTodoItems,
  safeCheckinItem,
  resetProactiveState
};
