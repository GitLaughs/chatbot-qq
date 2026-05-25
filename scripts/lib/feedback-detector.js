const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { looksSensitive, redactSecrets } = require("./sensitive-redaction");
const { appendJSONObject, readJSONLShardLines } = require("./jsonl-shards");

function detectFeedbackSignal({ triggerMsg = null, replyMsgID = "", feedbackMsg }) {
  const text = messageText(feedbackMsg);
  const direct = isDirectFeedback({ replyMsgID, feedbackMsg });
  const signal = explicitSignal(text, { direct, scope: feedbackMsg && feedbackMsg.message_type });
  const base = {
    version: 1,
    id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    scope: feedbackMsg && feedbackMsg.message_type === "private" ? "private" : "group",
    scope_id: String((feedbackMsg && (feedbackMsg.group_id || feedbackMsg.user_id)) || ""),
    trigger_message_id: String((triggerMsg && triggerMsg.message_id) || ""),
    reply_message_id: String(replyMsgID || ""),
    feedback_message_id: String((feedbackMsg && feedbackMsg.message_id) || ""),
    feedback_user_id: feedbackUserID(feedbackMsg),
    direct,
    evidence: redactSecrets(text).slice(0, 160),
    time: new Date().toISOString()
  };
  if (signal) {
    return withFingerprint({ ...base, ...signal });
  }
  const triggerText = messageText(triggerMsg);
  if (triggerText && hasActionableIntent(triggerText) && canUseImplicitFeedback({ triggerMsg, feedbackMsg, direct }) && isMeaningfulImplicitFeedbackText(text)) {
    const overlap = bigramOverlap(triggerText, text);
    if (overlap >= 0.6) {
      return withFingerprint({ ...base, signal_type: "repeat_question", confidence: 0.8 });
    }
    const shiftConfidence = topicShiftConfidence({ triggerMsg, feedbackMsg, direct, text });
    if (shiftConfidence && hasActionableIntent(text) && keywordOverlap(triggerText, text) < 0.2) {
      return withFingerprint({ ...base, signal_type: "topic_shift", confidence: shiftConfidence });
    }
  }
  return null;
}

function recordFeedbackSignal({ workspace, signal }) {
  if (!workspace || !signal) return null;
  const file = feedbackFile(workspace);
  const fingerprint = signal.fingerprint || feedbackFingerprint(signal);
  const existing = readSignals({ workspace, limit: 500, includeAll: true });
  if (existing.some((item) => item.fingerprint === fingerprint)) {
    return null;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { ...signal, fingerprint };
  appendJSONObject(file, row);
  return row;
}

function feedbackStats({ workspace }) {
  const rows = readSignals({ workspace, limit: 1000, includeAll: true });
  const byType = {};
  for (const row of rows) {
    byType[row.signal_type || "unknown"] = (byType[row.signal_type || "unknown"] || 0) + 1;
  }
  return { total: rows.length, byType, latest: rows.at(-1) || null };
}

function readSignals({ workspace, limit = 10, includeAll = false }) {
  const file = feedbackFile(workspace);
  const rows = [];
  for (const { line } of readJSONLShardLines(file)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // ignore bad rows
    }
  }
  if (includeAll) {
    return rows;
  }
  return rows.slice(-Math.max(1, Number(limit) || 10));
}

function formatFeedbackStats(stats) {
  const counts = Object.entries((stats && stats.byType) || {})
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key}:${count}`)
    .join("，") || "暂无";
  return [
    "反馈统计：",
    `总数：${(stats && stats.total) || 0}`,
    `分类：${counts}`,
    `最近：${stats && stats.latest ? `${stats.latest.signal_type} ${shortTime(stats.latest.time)}` : "暂无"}`
  ].join("\n");
}

function formatFeedbackHistory(signals) {
  if (!signals || signals.length === 0) {
    return "最近没有反馈信号。";
  }
  return [
    "最近反馈：",
    ...signals.slice(-8).reverse().map((item) => {
      const direct = item.direct === false ? "indirect" : "direct";
      const confidence = Number(item.confidence || 0).toFixed(2);
      const gap = item.gap_seconds !== undefined ? ` gap=${item.gap_seconds}s` : "";
      const reply = item.reply_message_id ? ` reply=${item.reply_message_id}` : "";
      return `- [${item.signal_type}] ${shortTime(item.time)} ${direct} confidence=${confidence}${gap}${reply} ${compact(item.evidence, 80)}`;
    })
  ].join("\n").slice(0, 1600);
}

function formatFeedbackContext(signals) {
  const recent = (signals || []).slice(-5);
  const positive = recent.filter((item) => item.signal_type === "positive").length;
  const negative = recent.filter((item) => item.signal_type === "negative").length;
  if (!positive && !negative) return "";
  const hint = negative > positive
    ? "最近负反馈较多，回答前先确认理解，少跳步骤。"
    : "最近正反馈较多，可沿用当前简洁风格。";
  return `【近期反馈】positive:${positive} negative:${negative}。${hint}`;
}

function explicitSignal(text, options = {}) {
  const body = explicitSignalText(text);
  const trimmed = body.trim();
  const direct = Boolean(options.direct);
  const isPrivate = options.scope === "private";
  const weakScope = !direct && !isPrivate;
  if (/还是不行|没解决|但是不行|但不行/i.test(body)) {
    return { signal_type: "negative", confidence: 0.9 };
  }
  if (/没收到|没有收到|未收到|收不到/i.test(body)) {
    return weakScope ? null : { signal_type: "negative", confidence: 0.9 };
  }
  if (/不懂|没明白/i.test(body)) {
    return weakScope ? null : { signal_type: "negative", confidence: 0.7 };
  }
  if (/谢谢.*(可以了|好了|能用了|跑通了)|可以了|好了|能用了|跑通了/i.test(body)) {
    return { signal_type: "positive", confidence: 0.9 };
  }
  if (/不对|错了|没用|不行/i.test(body)) {
    return weakScope ? null : { signal_type: "negative", confidence: 0.9 };
  }
  const ackOnlyPositive = /^(ok|收到|谢谢|谢了|感谢|thanks|thank you|3q)(啦|了|哈|啊|呀|哦|噢|呢|哇|喔)?[。！!.\s~～]*$/i.test(body.trim());
  if (ackOnlyPositive && weakScope) {
    return null;
  }
  if (isPositiveQuestion(trimmed)) {
    return null;
  }
  if (weakScope && !completionPositivePattern().test(body)) {
    return null;
  }
  if (/谢谢|感谢|thanks|👍|🙏|\bok\b|收到/i.test(body) || completionPositivePattern().test(body)) {
    return { signal_type: "positive", confidence: 0.9 };
  }
  return null;
}

function isDirectFeedback({ replyMsgID = "", feedbackMsg }) {
  if (!feedbackMsg || feedbackMsg.message_type === "private") {
    return true;
  }
  const replyID = replyTargetIDFromMessage(feedbackMsg);
  if (replyID && String(replyID) === String(replyMsgID || "")) {
    return true;
  }
  return isAtSelf(feedbackMsg);
}

function replyTargetIDFromMessage(msg) {
  const segments = Array.isArray(msg && msg.message) ? msg.message : [];
  for (const seg of segments) {
    if (seg && seg.type === "reply" && seg.data) {
      const id = seg.data.id || seg.data.message_id;
      if (id !== undefined && id !== null) return String(id);
    }
  }
  if (msg && msg.reply && (msg.reply.message_id || msg.reply.id)) {
    return String(msg.reply.message_id || msg.reply.id);
  }
  const raw = String((msg && msg.raw_message) || "");
  const match = raw.match(/\[CQ:reply,[^\]]*(?:id|message_id)=([^,\]]+)/i);
  if (match) {
    return String(match[1] || "");
  }
  return "";
}

function withFingerprint(signal) {
  return { ...signal, fingerprint: feedbackFingerprint(signal) };
}

function feedbackFingerprint(signal) {
  return crypto.createHash("sha1").update([
    signal.scope,
    signal.scope_id,
    signal.reply_message_id,
    signal.feedback_user_id || signal.feedback_user || "",
    signal.signal_type,
    stableEvidence(signal.evidence)
  ].join("|")).digest("hex").slice(0, 16);
}

function feedbackFile(workspace) {
  return path.join(workspace || "", "memory", "feedback-signals.jsonl");
}

function messageText(msg) {
  if (!msg) return "";
  if (typeof msg.raw_message === "string" && msg.raw_message) return visibleText(msg.raw_message);
  if (typeof msg.message === "string") return visibleText(msg.message);
  if (Array.isArray(msg.message)) {
    return msg.message.map((seg) => {
      if (!seg || !seg.data) return "";
      if (seg.type === "text") return String(seg.data.text || "");
      if (seg.type === "mface" && seg.data.summary) return String(seg.data.summary || "");
      return "";
    }).join(" ");
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

function feedbackUserID(msg) {
  return String((msg && msg.user_id) || "");
}

function canUseImplicitFeedback({ triggerMsg = null, feedbackMsg = null, direct = false }) {
  if (direct || !feedbackMsg || feedbackMsg.message_type === "private") {
    return true;
  }
  const triggerUser = feedbackUserID(triggerMsg);
  const feedbackUser = feedbackUserID(feedbackMsg);
  return Boolean(triggerUser && feedbackUser && triggerUser === feedbackUser);
}

function canUseTopicShiftFeedback({ triggerMsg = null, feedbackMsg = null, direct = false, text = "" }) {
  return Boolean(topicShiftConfidence({ triggerMsg, feedbackMsg, direct, text }));
}

function hasActionableIntent(value) {
  const text = visibleText(value);
  return /报错|错误|异常|问题|怎么|如何|怎么办|为什么|修复|调试|解释|帮我|帮忙|看一下|看看|能否|能不能|可以.*吗|不懂|没明白|什么意思/i.test(text);
}

function compact(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const max = Math.max(20, Number(limit) || 80);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function bigramOverlap(a, b) {
  const left = bigrams(normalize(a));
  const right = bigrams(normalize(b));
  if (left.size === 0 || right.size === 0) return 0;
  let hit = 0;
  for (const item of left) {
    if (right.has(item)) hit += 1;
  }
  return hit / Math.max(left.size, right.size);
}

function keywordOverlap(a, b) {
  const left = new Set(keywords(a));
  const right = new Set(keywords(b));
  if (left.size === 0 || right.size === 0) return 0;
  let hit = 0;
  for (const item of left) {
    if (right.has(item)) hit += 1;
  }
  return hit / Math.max(left.size, right.size);
}

function bigrams(text) {
  const out = new Set();
  for (let i = 0; i < text.length - 1; i += 1) {
    out.add(text.slice(i, i + 2));
  }
  return out;
}

function keywords(value) {
  const text = String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ")
    .replace(/[?&][a-z0-9_.-]+=[^\s&]+/gi, " ")
    .toLowerCase();
  return (text.match(/[\u4e00-\u9fa5]{2,}|[a-z0-9_+-]{3,}/g) || [])
    .filter((item) => isUsefulKeyword(item));
}

function isMeaningfulImplicitFeedbackText(value) {
  const text = visibleText(value);
  const normalized = normalize(text);
  if (!normalized || normalized.length < 4) return false;
  if (isCommandLikeText(text)) return false;
  if (/^\[(图片|文件)\]$/i.test(text)) return false;
  if (/^(嗯+|啊+|哈+|哈哈+|好的?|行|可以|ok|收到|表情|图片)$/i.test(normalized)) return false;
  return keywords(text).length > 0;
}

function isPositiveQuestion(value) {
  const text = String(value || "").replace(/\s+/g, "");
  if (!text) return false;
  return /(收到了?|解决了?|搞定了?|明白了?|懂了?)(吗|嘛|没|没有|么|没有啊)[?？]?$|有没有(收到|解决|搞定|明白|懂)|[?？]$/i.test(text);
}

function explicitSignalText(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ")
    .replace(/\b(?:access[_-]?token|api[_-]?key|apikey|token|secret|cookie|authorization)\s*[:=]\s*\S+/gi, " ")
    .replace(/\bsk-[a-z0-9_-]{8,}/gi, " ")
    .replace(/\s+/g, " ");
}

function completionPositivePattern() {
  return /解决了|搞定了|明白了|懂了|可以了|好了|能用了|跑通了/i;
}

function isAtSelf(msg) {
  const selfID = msg && msg.self_id !== undefined && msg.self_id !== null ? String(msg.self_id) : "";
  if (!selfID) return false;
  const segments = Array.isArray(msg && msg.message) ? msg.message : [];
  for (const seg of segments) {
    if (seg && seg.type === "at" && seg.data && String(seg.data.qq || "") === selfID) {
      return true;
    }
  }
  const raw = String((msg && msg.raw_message) || "");
  return new RegExp(`\\[CQ:at,[^\\]]*qq=${escapeRegExp(selfID)}(?:,|\\])`, "i").test(raw);
}

function topicShiftConfidence({ triggerMsg = null, feedbackMsg = null, direct = false, text = "" }) {
  if (direct || !feedbackMsg || feedbackMsg.message_type === "private") {
    return 0.6;
  }
  if (!canUseImplicitFeedback({ triggerMsg, feedbackMsg, direct }) || !hasTopicShiftTransition(text)) {
    return 0;
  }
  return 0.5;
}

function hasTopicShiftTransition(value) {
  return /^(那|另外|换个|还有|继续问|再问|顺便|对了)|\b(also|another|by the way)\b/i.test(visibleText(value));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCommandLikeText(value) {
  return /^[/／][\w\u4e00-\u9fa5-]+(?:\s|$)/i.test(String(value || "").trim());
}

function isUsefulKeyword(value) {
  const item = String(value || "").toLowerCase().trim();
  if (!item || looksSensitive(item)) return false;
  if (/^(token|secret|cookie|authorization|api_key|apikey|access_token|http|https|com|www)$/.test(item)) return false;
  if (/^\d+$/.test(item)) return false;
  return true;
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function stableEvidence(value) {
  return crypto.createHash("sha1").update(normalize(value).slice(0, 80)).digest("hex").slice(0, 12);
}

function shortTime(value) {
  return String(value || "").replace("T", " ").slice(0, 16) || "?";
}

module.exports = {
  detectFeedbackSignal,
  recordFeedbackSignal,
  feedbackStats,
  readSignals,
  formatFeedbackStats,
  formatFeedbackHistory,
  formatFeedbackContext,
  bigramOverlap,
  keywordOverlap,
  isDirectFeedback,
  replyTargetIDFromMessage,
  visibleText,
  isPositiveQuestion,
  isMeaningfulImplicitFeedbackText,
  canUseImplicitFeedback,
  canUseTopicShiftFeedback,
  hasActionableIntent
};
