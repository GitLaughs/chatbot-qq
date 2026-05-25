const fs = require("fs");
const path = require("path");

function analyzeMessageMood(text, recentMessages = []) {
  const body = String(text || "");
  const recent = Array.isArray(recentMessages) ? recentMessages : [];
  const texts = [...recent.map((row) => row.text || ""), body].filter(Boolean);
  const averageLength = texts.length ? texts.reduce((sum, item) => sum + String(item).length, 0) / texts.length : body.length;
  const bodyLength = body.length;
  const signals = [];
  let mood = "neutral";
  let confidence = 0.4;

  if (isUrgentMessage(body) || repeatedRecently(body, recent)) {
    mood = "urgent";
    confidence = 0.85;
    signals.push("urgent-pattern");
  } else if (/不懂|没懂|没明白|什么意思|看不懂/i.test(body)) {
    mood = "confused";
    confidence = isBareConfusion(body) ? 0.6 : 0.8;
    signals.push("confused-pattern");
  } else if (bodyLength < 20 && /不对|错了|没用|不行|烦|无语/i.test(body)) {
    mood = "frustrated";
    confidence = 0.75;
    signals.push("frustrated-short");
  } else if (/为什么|怎么|原理|是什么|讲讲/i.test(body) && bodyLength > 30) {
    mood = "curious";
    confidence = 0.7;
    signals.push("curious-question");
  } else if (isExcitedMessage(body) || bodyLength > 100) {
    mood = "excited";
    confidence = 0.7;
    signals.push("excited-pattern");
  }

  return { mood, confidence, signals, averageLength: Math.round(averageLength) };
}

function updatePrivateMood({ workspace, userID, text, historyLimit = 10, messageID = "" }) {
  const recent = readRecentChatRows(workspace, historyLimit + 5)
    .filter((row) => !row.bot && String(row.user_id || "") === String(userID || ""))
    .filter((row) => !messageID || String(row.message_id || "") !== String(messageID))
    .slice(-Math.max(1, Number(historyLimit) || 10));
  const mood = analyzeMessageMood(text, recent);
  const state = {
    version: 1,
    updated_at: new Date().toISOString(),
    scope: "private",
    user_id: String(userID || ""),
    ...mood
  };
  writeJSON(stateFile(workspace, "mood-state.json"), state);
  return state;
}

function updateGroupEnergy({ workspace, groupID, windowMs = 300000 }) {
  const now = Date.now();
  const rows = readRecentChatRows(workspace, 200)
    .filter((row) => !row.bot && String(row.user_id || "") !== "bot")
    .filter((row) => !groupID || !row.group_id || String(row.group_id) === String(groupID))
    .filter((row) => !isCommandLike(row.text || row.raw_message || ""))
    .filter((row) => {
      const ts = new Date(row.time || 0).getTime();
      const delta = now - ts;
      return Number.isFinite(ts) && delta >= 0 && delta <= Number(windowMs || 300000);
    });
  const participants = new Set(rows.map((row) => String(row.user_id || "")).filter(Boolean));
  let level = "low";
  if (rows.length > 6 && participants.size > 2) {
    level = "high";
  } else if (rows.length >= 3 || participants.size > 1) {
    level = "medium";
  }
  const state = {
    version: 1,
    updated_at: new Date().toISOString(),
    scope: "group",
    group_id: String(groupID || ""),
    level,
    message_count: rows.length,
    participant_count: participants.size,
    window_ms: Number(windowMs || 300000)
  };
  writeJSON(stateFile(workspace, "group-energy-state.json"), state);
  return state;
}

function isUrgentMessage(text) {
  const body = String(text || "");
  if (/(急|加急|尽快|快点|快些)/i.test(body)) {
    return true;
  }
  const action = "(处理|修|看|回|发|改|帮|救|查|弄|解决|回复|确认|排查|给|做)";
  return new RegExp(`(马上|立刻|赶紧).{0,8}${action}|${action}.{0,8}(马上|立刻|赶紧)`, "i").test(body);
}

function isBareConfusion(text) {
  return /^(不懂|没懂)$/i.test(String(text || "").trim());
}

function isExcitedMessage(text) {
  const body = String(text || "");
  return /！|!|太好了|厉害|666|牛/i.test(body) || /哈{4,}/i.test(body);
}

function isCommandLike(text) {
  const body = String(text || "").trim().toLowerCase();
  if (!body) return false;
  if (/^\/\S+/.test(body)) return true;
  return /^(状态|status|help|帮助|心情|mood|反馈|主动)(\s|$)/i.test(body);
}

function formatMoodContext(mood) {
  if (!mood || !mood.mood || mood.mood === "neutral") {
    return "";
  }
  const advice = {
    frustrated: "语气温和，先确认问题，给出清晰步骤。",
    curious: "可以多解释原理，但先给结论。",
    excited: "保持轻快，别泼冷水，顺手推进下一步。",
    confused: "降低抽象度，用例子和分步说明。",
    urgent: "先给可执行方案，减少铺垫。"
  }[mood.mood] || "保持简洁。";
  return `【用户情绪状态：${mood.mood}, 置信度 ${Number(mood.confidence || 0).toFixed(1)}】\n建议：${advice}`;
}

function formatGroupEnergyContext(energy) {
  if (!energy || energy.level !== "high") {
    return "";
  }
  const minutes = Math.max(1, Math.round(Number(energy.window_ms || 300000) / 60000));
  return `【群聊能量：high】近 ${minutes} 分钟 ${energy.message_count || 0} 条消息、${energy.participant_count || 0} 人参与。建议短句、少打断、只接明确问题。`;
}

function readMoodState(workspace) {
  return readJSON(stateFile(workspace, "mood-state.json"));
}

function readGroupEnergyState(workspace) {
  return readJSON(stateFile(workspace, "group-energy-state.json"));
}

function readRecentChatRows(workspace, limit) {
  const dir = path.join(workspace || "", "memory");
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((name) => /^chat-\d{4}-\d{2}-\d{2}(?:-\d{3})?\.jsonl$/.test(name))
    .sort()
    .slice(-2);
  const rows = [];
  for (const name of files) {
    for (const line of fs.readFileSync(path.join(dir, name), "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // ignore bad chat rows
      }
    }
  }
  return rows.slice(-Math.max(1, Number(limit) || 10));
}

function repeatedRecently(text, rows) {
  const normalized = normalize(text);
  if (!normalized) return false;
  const now = Date.now();
  return rows.some((row) => {
    const ts = new Date(row.time || 0).getTime();
    const delta = now - ts;
    return Number.isFinite(ts) && delta >= 0 && delta <= 30000 && normalize(row.text) === normalized;
  });
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function stateFile(workspace, name) {
  return path.join(workspace || "", "memory", name);
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function readJSON(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  analyzeMessageMood,
  updatePrivateMood,
  updateGroupEnergy,
  formatMoodContext,
  formatGroupEnergyContext,
  readMoodState,
  readGroupEnergyState
};
