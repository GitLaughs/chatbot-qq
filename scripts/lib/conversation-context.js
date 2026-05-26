const fs = require("fs");
const path = require("path");
const { expandRelatedMemories, searchGlobalMemories, searchMemoriesRanked } = require("./memory-store");
const { redactSecrets } = require("./sensitive-redaction");

const lastActivityByScope = new Map();
const lastGapByScope = new Map();
const activitySeqByScope = new Map();

function scopeKey(scope, scopeID) {
  return `${scope}:${String(scopeID || "")}`;
}

function trackActivity({ scope, scopeID, userID = "", timestamp = Date.now(), gapMinutes = 30 }) {
  const key = scopeKey(scope, scopeID);
  const ts = Number(new Date(timestamp).getTime());
  const seq = (activitySeqByScope.get(key) || 0) + 1;
  activitySeqByScope.set(key, seq);
  const previous = lastActivityByScope.get(key);
  if (previous && ts > previous) {
    const gap = Math.floor((ts - previous) / 60000);
    if (gap >= Number(gapMinutes || 30)) {
      lastGapByScope.set(key, { hasGap: true, gapMinutes: gap, previous, current: ts, userID: String(userID || ""), activitySeq: seq });
    } else {
      const stored = lastGapByScope.get(key);
      if (stored && seq - Number(stored.activitySeq || 0) > 2) {
        lastGapByScope.delete(key);
      }
    }
  }
  if (Number.isFinite(ts)) {
    lastActivityByScope.set(key, ts);
  }
  return lastGapByScope.get(key) || { hasGap: false, gapMinutes: 0 };
}

function detectGap({ scope, scopeID, thresholdMinutes = 30, consume = false }) {
  const key = scopeKey(scope, scopeID);
  const stored = lastGapByScope.get(key);
  if (stored && stored.gapMinutes >= Number(thresholdMinutes || 30)) {
    const seq = activitySeqByScope.get(key) || 0;
    if (seq - Number(stored.activitySeq || 0) > 2) {
      lastGapByScope.delete(key);
      return { hasGap: false, gapMinutes: 0 };
    }
    if (consume) {
      lastGapByScope.delete(key);
    }
    return stored;
  }
  return { hasGap: false, gapMinutes: 0 };
}

function buildContinuityContext({ workspace, gapMinutes, messageLimit = 10, excludeMessageID = "", excludeMessageIDs = [] }) {
  const maxRows = Math.max(1, Number(messageLimit) || 10);
  const excluded = new Set([
    String(excludeMessageID || ""),
    ...[].concat(excludeMessageIDs || []).map((id) => String(id || ""))
  ].filter(Boolean));
  const rows = recentChatRows(workspace, Math.max(maxRows * 3, maxRows))
    .filter((row) => !excluded.has(String(row.message_id || "")))
    .map((row) => ({ row, text: contextText(row) }))
    .filter((item) => item.row && item.text && !isContextNoiseRow(item.row, item.text))
    .slice(-maxRows);
  if (!gapMinutes || rows.length === 0) {
    return "";
  }
  return [
    "【会话恢复上下文】",
    `距离上次对话已过 ${Math.floor(Number(gapMinutes))} 分钟。最近对话：`,
    ...rows.map((item) => `[${displayName(item.row)}] ${compact(item.text, 80)} (${shortTime(item.row.time)})`)
  ].join("\n");
}

function buildReplyChainContext({ workspace, msg }) {
  const replyID = replyTargetID(msg);
  if (!replyID) {
    return "";
  }
  const rows = recentChatRows(workspace, 200);
  const chain = replyChainRows(rows, replyID, 3);
  if (chain.length === 0) {
    return "";
  }
  const lines = [
    "【引用链上下文】",
    "用户正在回复这些消息："
  ];
  for (const row of chain) {
    const text = contextText(row);
    if (!text || isContextNoiseRow(row, text)) {
      continue;
    }
    lines.push(`[${displayName(row)} ${shortTime(row.time)}] ${compact(text, 160)}`);
  }
  return lines.length > 2 ? lines.join("\n") : "";
}

function buildMemoryContextForMessage({ workspace, messageText, subject, scope, scopeID }) {
  if (!messageText || messageText.length < 4) return "";

  const enabled = String(process.env.CHATBOT_QQ_MEMORY_INJECT_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) return "";

  const threshold = Number(process.env.CHATBOT_QQ_MEMORY_INJECT_THRESHOLD || 20);
  const limit = Math.max(1, Math.min(10, Number(process.env.CHATBOT_QQ_MEMORY_INJECT_LIMIT || 5)));

  const ranked = searchMemoriesRanked({
    workspace,
    query: expandMemoryQuery(messageText),
    subject: subject || "",
    scope: scope || "",
    limit: limit * 2
  });

  const relevant = ranked.filter((m) => m._score && m._score.total >= threshold).slice(0, limit);
  const globalRelevant = searchGlobalMemories({ query: messageText, limit: 2 });
  if (relevant.length === 0 && globalRelevant.length === 0) return "";

  const lines = ["【相关记忆】"];
  for (const m of relevant) {
    lines.push(`- [${m.kind}] ${compact(m.text, 120)}`);
  }

  const expanded = [];
  const seenIDs = new Set(relevant.map((m) => m.id).filter(Boolean));
  for (const mem of relevant) {
    const related = expandRelatedMemories({ workspace, memory: mem, limit: 2 });
    for (const r of related) {
      if (r.id && !seenIDs.has(r.id)) {
        seenIDs.add(r.id);
        expanded.push(r);
      }
    }
  }

  if (expanded.length > 0) {
    lines.push("关联记忆：");
    for (const r of expanded.slice(0, 3)) {
      lines.push(`  - [${r.kind}] ${compact(r.text, 80)}`);
    }
  }

  if (globalRelevant.length > 0) {
    lines.push("全局知识：");
    for (const g of globalRelevant) {
      lines.push(`  - [${g.kind}] ${compact(g.text, 80)}`);
    }
  }

  return lines.join("\n");
}

function expandMemoryQuery(text) {
  const raw = String(text || "");
  const extra = [];
  if (/吃|喝|饭|菜|餐|外卖|夜宵|口味|辣|甜|咸/.test(raw)) {
    extra.push("喜欢 不喜欢 偏好 口味 吃辣");
  }
  if (/怎么回|语气|风格|短答|详细|称呼/.test(raw)) {
    extra.push("风格 语气 短答 详细 称呼");
  }
  return [raw, ...extra].join(" ").trim();
}

function replyChainMessageIDs({ workspace, msg, maxDepth = 3 }) {
  const replyID = replyTargetID(msg);
  if (!replyID) {
    return [];
  }
  const rows = recentChatRows(workspace, 200);
  return replyChainRows(rows, replyID, maxDepth).map((row) => String(row.message_id || "")).filter(Boolean);
}

function replyChainRows(rows, replyID, maxDepth = 3) {
  const result = [];
  let currentID = String(replyID || "");
  const seen = new Set();
  for (let depth = 0; depth < Math.max(1, Number(maxDepth) || 3); depth += 1) {
    if (!currentID || seen.has(currentID)) break;
    seen.add(currentID);
    const row = rows.slice().reverse().find((item) => String(item.message_id || "") === currentID);
    if (!row) break;
    const text = contextText(row);
    if (!text || isContextNoiseRow(row, text)) {
      const nextID = rowReplyTargetID(row);
      if (nextID && !seen.has(String(nextID))) {
        currentID = String(nextID);
        continue;
      }
      break;
    }
    result.push(row);
    currentID = rowReplyTargetID(row);
  }
  return result;
}

function rowReplyTargetID(row) {
  if (!row) return "";
  return rawReplyTargetID(row.raw_message);
}

function recentChatRows(workspace, limit = 10) {
  const dir = path.join(workspace || "", "memory");
  if (!fs.existsSync(dir)) {
    return [];
  }
  const maxRows = Math.max(1, Number(limit) || 10);
  const files = fs.readdirSync(dir)
    .filter((name) => /^chat-\d{4}-\d{2}-\d{2}(?:-\d{3})?\.jsonl$/.test(name))
    .sort()
    .slice(-3);
  const rows = [];
  let order = 0;
  for (const name of files.reverse()) {
    const file = path.join(dir, name);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-Math.max(maxRows * 3, maxRows));
    for (const line of lines.reverse()) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        rows.push({ row, order: order++ });
      } catch {
        // Ignore corrupt chat rows; context is best effort.
      }
    }
  }
  return rows
    .sort((a, b) => comparableTime(a.row) - comparableTime(b.row) || a.order - b.order)
    .map((item) => item.row)
    .slice(-maxRows);
}

function replyTargetID(msg) {
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
  return rawReplyTargetID(msg && msg.raw_message);
}

function rawReplyTargetID(rawMessage) {
  const raw = String(rawMessage || "");
  const match = raw.match(/\[CQ:reply,[^\]]*(?:id|message_id)=([^,\]]+)/i);
  if (match) return String(match[1] || "");
  return "";
}

function displayName(row) {
  const sender = row && row.sender && typeof row.sender === "object" ? row.sender : {};
  return sender.card || sender.nickname || row.user_id || row.sender_name || "unknown";
}

function sanitizeChatText(value) {
  return redactSecrets(String(value || "")
    .replace(/https?:\/\/\S+/gi, "[链接]")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[邮箱]")
    .replace(/\[CQ:image[^\]]*\]/gi, "[图片]")
    .replace(/\[CQ:file[^\]]*\]/gi, "[文件]")
    .replace(/\[CQ:reply[^\]]*\]/gi, "[回复]")
    .replace(/\[CQ:[^\]]+\]/gi, "[QQ消息段]"));
}

function contextText(row) {
  return sanitizeChatText((row && (row.text || row.raw_message)) || "").replace(/\s+/g, " ").trim();
}

function compact(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const max = Math.max(20, Number(limit) || 80);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function shortTime(value) {
  return String(value || "").replace("T", " ").slice(11, 16) || "?";
}

function isCommandNoise(text) {
  const body = String(text || "").trim().toLowerCase();
  if (!body) return false;
  if (/^[/／]\S+/.test(body)) return true;
  if (/^[/／](status|help|命令|状态|连续|continuity|心情|mood|反馈|feedback|主动|proactive)(\s|$)/i.test(body)) {
    return true;
  }
  return /^(status|help|命令|状态|连续|continuity|心情|mood|反馈|feedback|主动|proactive)(\s|：|:|$)/i.test(body);
}

function isContextNoiseRow(row, text = contextText(row)) {
  const body = String(text || "").trim();
  if (!body) return true;
  if (isCommandNoise(body)) return true;
  if (/^\[(回复|图片|文件|QQ消息段)\]$/i.test(body)) return true;
  const isStatusLine = /^(会话连续性|连续性状态|情绪状态|用户情绪状态|心情状态|群聊能量|反馈统计|最近反馈|主动参与|QQ 代理|队列|最近错误|健康检查|服务状态|系统状态)(：|:)/.test(body);
  if (isStatusLine) return true;
  const sender = row && row.sender && typeof row.sender === "object" ? row.sender : {};
  const senderName = String(sender.card || sender.nickname || row && row.sender_name || "").toLowerCase();
  const isBotRow = Boolean(row && (row.bot || String(row.user_id || "") === "bot" || senderName === "bot"));
  if (isBotRow) {
    return /^(不需要回复awa|答案已渲染成图片，便于查看公式和排版：?)$/.test(body) ||
      body.includes("因空闲超过 30 分钟，已自动切换到新会话") ||
      body.includes("正在结束上一个会话") ||
      body.includes("新会话将自动启动");
  }
  return false;
}

function comparableTime(row) {
  const ts = new Date(row && row.time || 0).getTime();
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
}

function activitySnapshot({ scope, scopeID, thresholdMinutes = 30 }) {
  const key = scopeKey(scope, scopeID);
  const last = lastActivityByScope.get(key) || 0;
  const gap = detectGap({ scope, scopeID, thresholdMinutes });
  return {
    scope,
    scopeID: String(scopeID || ""),
    lastActivity: last ? new Date(last).toISOString() : "",
    hasGap: Boolean(gap.hasGap),
    gapMinutes: gap.gapMinutes || 0
  };
}

function resetConversationState() {
  lastActivityByScope.clear();
  lastGapByScope.clear();
  activitySeqByScope.clear();
}

module.exports = {
  trackActivity,
  detectGap,
  buildContinuityContext,
  buildReplyChainContext,
  buildMemoryContextForMessage,
  replyChainMessageIDs,
  activitySnapshot,
  recentChatRows,
  replyChainRows,
  rowReplyTargetID,
  rawReplyTargetID,
  sanitizeChatText,
  contextText,
  isContextNoiseRow,
  resetConversationState
};
