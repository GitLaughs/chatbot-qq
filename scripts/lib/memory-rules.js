const crypto = require("crypto");
const { looksSensitive, redactSecrets } = require("./sensitive-redaction");

const KIND_RULES = [
  ["todo", /待办|todo|要做|记得|提醒|deadline|截止|明天|今晚/iu],
  ["preference", /偏好|喜欢|不喜欢|默认|短答|详细|语气|风格|称呼/iu],
  ["boundary", /边界|不要|别|禁止|禁忌|不许|不要再/iu],
  ["project", /项目|计划|方案|进度|里程碑|发布|部署/iu],
  ["joke", /梗|笑话|外号|段子|调侃/iu],
  ["fact", /事实|是|正在|准备|来自|属于|目前|现在/iu]
];

const TAG_RULES = [
  ["study", /学习|作业|考试|课程|题目|公式|推导|论文|pdf/iu],
  ["code", /代码|脚本|bug|报错|错误|python|node|go|cmd|powershell|部署/iu],
  ["style", /短答|详细|语气|风格|先给结论|步骤/iu],
  ["file", /文件|pdf|docx|xlsx|pptx|图片|上传|归档/iu],
  ["admin", /管理员|运维|status|reload|routes|tail|日志|服务/iu],
  ["boundary", /边界|不要|别|禁止|禁忌|不许|不要再/iu],
  ["todo", /待办|todo|提醒|记得|明天|今晚|截止|deadline|完成/iu]
];

const KIND_LABELS = {
  todo: "待办/提醒",
  preference: "偏好/回复方式",
  project: "项目/计划/进度",
  boundary: "边界/禁忌",
  joke: "梗/外号/调侃",
  fact: "事实/状态",
  note: "普通备注"
};

const TAG_LABELS = {
  study: "学习/文档",
  code: "代码/部署/错误",
  style: "回复风格",
  file: "文件/附件",
  admin: "管理/运维",
  boundary: "边界/禁忌",
  todo: "待办"
};

function classifyMemory(text) {
  const normalized = normalizeMemoryText(text);
  for (const [kind, pattern] of KIND_RULES) {
    if (pattern.test(normalized)) {
      return kind;
    }
  }
  return "note";
}

function tagMemory(text) {
  const normalized = normalizeMemoryText(text);
  return TAG_RULES
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([tag]) => tag);
}

function normalizeMemoryText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[，。；;]+$/g, "")
    .trim();
}

function memoryFingerprint({ scope, scopeID, subject, text }) {
  const raw = [
    scope || "",
    scopeID || "",
    subject || "",
    normalizeMemoryText(text).toLowerCase()
  ].join("\n");
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

function memoryCandidatesFromSamples(samples, options = {}) {
  const limit = Math.max(1, Number(options.limit || 6));
  const seen = new Set();
  const candidates = [];
  for (const sample of samples || []) {
    const user = String(sample.user || sample.user_id || "unknown");
    const text = normalizeMemoryText(sample.text || "");
    if (!isCandidateText(text)) {
      continue;
    }
    const kind = classifyMemory(text);
    if (kind === "note") {
      continue;
    }
    const key = `${user}\n${kind}\n${text.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({
      user,
      time: String(sample.time || ""),
      kind,
      tags: tagMemory(text),
      text
    });
    if (candidates.length >= limit) {
      break;
    }
  }
  return candidates;
}

function inspectMemoryRule(text) {
  const normalized = normalizeMemoryText(text);
  const blockers = candidateBlockers(normalized);
  return {
    normalized,
    eligible: blockers.length === 0,
    blockers,
    kind: blockers.length === 0 ? classifyMemory(normalized) : "note",
    tags: blockers.length === 0 ? tagMemory(normalized) : []
  };
}

function formatMemoryRuleInspection(result) {
  const item = result || inspectMemoryRule("");
  const lines = [
    "记忆预检：",
    `结果：${item.eligible && item.kind !== "note" ? "适合进入候选记忆" : "不建议自动候选"}`,
    `分类：${item.kind || "note"} (${KIND_LABELS[item.kind] || "未知"})`,
    `标签：${(item.tags || []).join(",") || "-"}`
  ];
  if (item.blockers && item.blockers.length > 0) {
    lines.push(`拦截原因：${item.blockers.join("；")}`);
  }
  if (item.normalized) {
    lines.push(`归一化：${redactSensitive(item.normalized).slice(0, 160)}`);
  }
  return lines.join("\n");
}

function formatMemoryRuleGuide() {
  return [
    "记忆规则（确定性）：",
    `分类：${Object.entries(KIND_LABELS).filter(([kind]) => kind !== "note").map(([kind, label]) => `${kind}=${label}`).join("；")}`,
    `标签：${Object.entries(TAG_LABELS).map(([tag, label]) => `${tag}=${label}`).join("；")}`,
    "候选条件：长度 6-180；不是命令/status/help；不是图片或表情占位；不含 token/cookie/secret/api_key/sk-*。",
    "入口：/记忆 预检 文本；/总结今天 只保存候选，不自动写入确认记忆。"
  ].join("\n");
}

function formatMemoryCandidates(candidates) {
  if (!candidates || candidates.length === 0) {
    return ["- 暂无"];
  }
  return candidates.map((item) => {
    const time = item.time ? ` ${item.time.replace("T", " ").slice(0, 16)}` : "";
    return `- [${item.kind}]${time} ${item.user}: ${item.text.slice(0, 90)}`;
  });
}

function isCandidateText(text) {
  return candidateBlockers(text).length === 0;
}

function candidateBlockers(text) {
  if (!text || text.length < 6 || text.length > 180) {
    return ["长度需在 6-180 字之间"];
  }
  if (/^\/|^\s*(help|status)$/i.test(text)) {
    return ["命令或状态词不进入候选"];
  }
  if (/^\[图片\]|\[表情包|^\[QQ表情/.test(text)) {
    return ["图片/表情占位不进入候选"];
  }
  if (looksSensitive(text)) {
    return ["疑似包含密钥或令牌"];
  }
  return [];
}

function redactSensitive(value) {
  return redactSecrets(value);
}

function importanceScore(memory) {
  const kindWeights = {
    boundary: 9,
    preference: 7,
    project: 6,
    todo: 5,
    fact: 4,
    joke: 3,
    note: 2
  };
  let score = kindWeights[memory && memory.kind] || 5;

  if (memory && memory.confidence && memory.confidence < 0.7) score -= 1;
  if (memory && memory.source && memory.source.type === "explicit") score += 1;

  const tags = (memory && memory.tags) || [];
  if (tags.includes("boundary")) score = Math.max(score, 8);
  if (tags.includes("style")) score = Math.max(score, 6);

  return Math.max(1, Math.min(10, score));
}

function relevanceScore(memory, query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return 0;
  const haystack = [
    (memory && memory.text) || "",
    (memory && memory.kind) || "",
    (memory && memory.scope) || "",
    (memory && memory.subject) || "",
    ...((memory && memory.tags) || [])
  ].join("\n").toLowerCase();

  let score = 0;
  if (haystack.includes(q)) score += 10;

  const queryTerms = [];
  const chineseChars = [...new Set((q.match(/[\u4e00-\u9fa5]/g) || []))];
  if (chineseChars.length > 0) {
    queryTerms.push(...chineseChars);
  }
  queryTerms.push(...(q.match(/[a-z0-9_+-]{2,}/g) || []));
  if (queryTerms.length > 0) {
    const matched = queryTerms.filter((term) => haystack.includes(term));
    score += (matched.length / queryTerms.length) * 5;
  }

  const queryTags = tagMemory(q);
  const commonTags = queryTags.filter((t) => ((memory && memory.tags) || []).includes(t));
  score += commonTags.length * 3;

  const queryKind = classifyMemory(q);
  if (memory && queryKind === memory.kind && queryKind !== "note") score += 2;

  if (memory && memory.subject && q.includes(String(memory.subject).toLowerCase())) score += 4;

  return score;
}

module.exports = {
  classifyMemory,
  tagMemory,
  normalizeMemoryText,
  memoryFingerprint,
  memoryCandidatesFromSamples,
  formatMemoryCandidates,
  inspectMemoryRule,
  formatMemoryRuleInspection,
  formatMemoryRuleGuide,
  importanceScore,
  relevanceScore
};
