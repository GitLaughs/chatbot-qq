const fs = require("fs");
const path = require("path");
const { redactSecrets } = require("./sensitive-redaction");

const DEFAULT_MAX_ITEMS_PER_KIND = 8;
const DEFAULT_MAX_TEXT_CHARS = 220;
const DEFAULT_MAX_CHARS = 12000;

const KIND_ORDER = [
  ["preference", "偏好"],
  ["todo", "待办"],
  ["decision", "决策"],
  ["problem", "问题"],
  ["file", "文件"],
  ["topic", "主题"],
  ["recent", "最近"]
];

const KIND_RULES = [
  ["preference", /(记住|以后|默认|我喜欢|我不想|不要|别|优先|偏好|尽量|习惯|风格|短一点|详细一点)/i, "明确偏好"],
  ["todo", /(todo|待办|要做|需要|记得|明天|今晚|deadline|截止|帮我|修|改|查|提醒|部署|验证|测试)/i, "待办请求"],
  ["decision", /(决定|结论|就这样|采用|确认|同意|final|方案|确定|按.*做|路线)/i, "明确确认"],
  ["problem", /(报错|错误|失败|问题|卡住|不行|timeout|failed|error|bug|异常|崩|连不上)/i, "报错或风险"],
  ["file", /(文件|pdf|docx|xlsx|图片|上传|归档|代码|脚本|报告|\.py|\.js|\.md|\.pdf|\.json|\.log)/i, "文件事件"]
];

function chatFilesForLookback({ workspace, lookbackHours = 72, now = Date.now() }) {
  const memoryDir = path.join(workspace || "", "memory");
  if (!fs.existsSync(memoryDir)) return [];
  const cutoff = Number(now) - Math.max(1, Number(lookbackHours) || 72) * 3600 * 1000;
  return fs.readdirSync(memoryDir)
    .filter((name) => /^chat-\d{4}-\d{2}-\d{2}(?:-\d{3})?\.jsonl$/.test(name))
    .map((name) => path.join(memoryDir, name))
    .filter((file) => {
      try {
        return fs.statSync(file).mtimeMs >= cutoff;
      } catch {
        return false;
      }
    })
    .sort();
}

function buildEvidencePacket(options = {}) {
  const workspace = options.workspace || process.cwd();
  const purpose = options.purpose || "profile_update";
  const lookbackHours = Math.max(1, Number(options.lookbackHours) || 72);
  const maxItemsPerKind = Math.max(1, Number(options.maxItemsPerKind) || DEFAULT_MAX_ITEMS_PER_KIND);
  const maxTextChars = Math.max(40, Number(options.maxTextChars) || DEFAULT_MAX_TEXT_CHARS);
  const maxChars = Math.max(1000, Number(options.maxChars) || DEFAULT_MAX_CHARS);
  const files = (options.files && options.files.length ? options.files : chatFilesForLookback({ workspace, lookbackHours }))
    .map((file) => path.resolve(workspace, file));
  const now = options.now || new Date();

  const dropped = {
    empty_or_command: 0,
    cq_noise: 0,
    duplicate: 0,
    bot: 0,
    too_short: 0
  };
  const stats = {
    records_scanned: 0,
    records_after_filter: 0,
    users: new Set(),
    attachments: 0
  };
  const sourceFiles = [];
  const buckets = Object.fromEntries(KIND_ORDER.map(([key]) => [key, []]));
  const recentCandidates = [];
  const seen = new Set();
  const sourceMap = [];

  for (const file of files) {
    const rel = relativePath(workspace, file);
    let scanned = 0;
    let used = 0;
    for (const item of readJSONL(file)) {
      scanned += 1;
      stats.records_scanned += 1;
      const normalized = normalizeChatRecord(item.row, { maxTextChars });
      if (!normalized.ok) {
        dropped[normalized.drop] = (dropped[normalized.drop] || 0) + 1;
        continue;
      }
      if (normalized.hasImage) stats.attachments += 1;
      stats.users.add(normalized.user);
      const dedupeKey = `${normalized.user}\n${normalized.text}`;
      if (seen.has(dedupeKey)) {
        dropped.duplicate += 1;
        continue;
      }
      seen.add(dedupeKey);
      used += 1;
      stats.records_after_filter += 1;

      const base = {
        time: normalized.time,
        user: normalized.user,
        text: normalized.text,
        source: { file: rel, line: item.line, message_id: String(item.row && item.row.message_id || "") }
      };
      let matched = false;
      for (const [kind, pattern, reason] of KIND_RULES) {
        if (pattern.test(normalized.text)) {
          pushLimited(buckets[kind], { ...base, kind, reason }, maxItemsPerKind);
          matched = true;
        }
      }
      if (!matched) {
        recentCandidates.push({ ...base, kind: "recent", reason: normalized.hasImage ? "近上下文含图片" : "近上下文" });
      }
    }
    sourceFiles.push({ path: rel, records_scanned: scanned, records_used: used });
  }

  const recent = recentCandidates.slice(-maxItemsPerKind);
  for (const item of recent) {
    buckets.recent.push(item);
  }
  const topicItems = topTopics(Object.values(buckets).flat().map((item) => item.text), maxItemsPerKind)
    .map((topic) => ({
      kind: "topic",
      time: "-",
      user: "-",
      text: topic.text,
      reason: `出现${topic.count}次`,
      source: null
    }));
  buckets.topic.push(...topicItems);

  const lines = [];
  lines.push("字段顺序：类别 | 时间 | 用户 | 内容 | 原因");
  lines.push(`用途：${compactPlain(purpose, 40)}；范围：${lookbackHours}小时；生成：${formatPacketTime(now)}`);
  lines.push(`统计：扫描${stats.records_scanned}条；保留${stats.records_after_filter}条；用户${stats.users.size}人；文件或图片${stats.attachments}个`);
  lines.push(`丢弃：空命令${dropped.empty_or_command || 0}；CQ噪声${dropped.cq_noise || 0}；重复${dropped.duplicate || 0}；bot${dropped.bot || 0}；过短${dropped.too_short || 0}`);
  lines.push("");

  for (const [kind, label] of KIND_ORDER) {
    for (const item of buckets[kind]) {
      const line = [label, item.time, item.user, item.text, item.reason].map(cleanCell).join(" | ");
      lines.push(line);
      if (item.source) {
        sourceMap.push({
          line: lines.length,
          kind,
          file: item.source.file,
          source_line: item.source.line,
          message_id: item.source.message_id
        });
      }
    }
  }

  let text = lines.join("\n").trimEnd();
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars - 18).trimEnd()}\n...(证据包截断)`;
  }

  return {
    text,
    stats: {
      ...stats,
      users: stats.users.size,
      source_files: sourceFiles,
      dropped
    },
    sourceMap
  };
}

function writeEvidencePacket(options = {}) {
  const packet = buildEvidencePacket(options);
  if (!options.output) return packet;
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${packet.text}\n`, "utf8");
  if (options.sourceMapOutput) {
    fs.writeFileSync(options.sourceMapOutput, `${packet.sourceMap.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  }
  return packet;
}

function normalizeChatRecord(row, options = {}) {
  const maxTextChars = Math.max(40, Number(options.maxTextChars) || DEFAULT_MAX_TEXT_CHARS);
  if (!row || typeof row !== "object") return { ok: false, drop: "empty_or_command" };
  if (row.bot) return { ok: false, drop: "bot" };
  const raw = String(row.text || row.raw_message || "").trim();
  if (!raw) return { ok: false, drop: "empty_or_command" };
  let text = sanitizeMessageText(raw);
  const commandText = text.trim();
  const remember = commandText.match(/^\/?记住\s+(.+)$/i);
  if (remember) {
    text = `记住 ${remember[1].trim()}`;
  } else if (/^\/\S+/.test(commandText) || /^(status|help|画像|我的偏好|今日总结|总结今天|health|metrics)\b/i.test(commandText)) {
    return { ok: false, drop: "empty_or_command" };
  }
  if (!text || text === "[CQ]" || /^[\s~!?.。？！,，、…]+$/.test(text)) {
    return { ok: false, drop: "cq_noise" };
  }
  if (text.length < 2) {
    return { ok: false, drop: "too_short" };
  }
  return {
    ok: true,
    time: formatRecordTime(row.time),
    user: displayName(row),
    text: compactPlain(text, maxTextChars),
    hasImage: Boolean(row.has_image || /\[图片\]|图片/.test(text))
  };
}

function sanitizeMessageText(value) {
  return redactSecrets(String(value || ""))
    .replace(/\[CQ:image[^\]]*\]/gi, "图片")
    .replace(/\[CQ:(mface|bface|marketface)[^\]]*\]/gi, "表情包")
    .replace(/\[CQ:face[^\]]*\]/gi, "表情")
    .replace(/\[CQ:at[^\]]*\]/gi, "at")
    .replace(/\[CQ:[^\]]+\]/gi, "CQ")
    .replace(/https?:\/\/\S+/gi, "链接")
    .replace(/\s+/g, " ")
    .trim();
}

function compactPlain(value, limit) {
  const max = Math.max(20, Number(limit) || 80);
  const text = String(value || "")
    .replace(/[|]/g, " ")
    .replace(/[{}[\]"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

function cleanCell(value) {
  return compactPlain(value, 260) || "-";
}

function displayName(row) {
  const sender = row.sender && typeof row.sender === "object" ? row.sender : {};
  return compactPlain(sender.card || sender.nickname || shortID(row.user_id) || "unknown", 40);
}

function shortID(value) {
  const text = String(value || "");
  if (!text) return "";
  return text.length > 6 ? `...${text.slice(-6)}` : text;
}

function formatRecordTime(value) {
  const date = new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) return "-";
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatPacketTime(value) {
  const date = new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) return "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function pushLimited(bucket, item, limit) {
  bucket.push(item);
  if (bucket.length > limit) {
    bucket.splice(0, bucket.length - limit);
  }
}

function topTopics(texts, limit) {
  const counts = new Map();
  const stop = new Set(["这个", "那个", "就是", "可以", "需要", "我们", "你们", "他们", "一下", "已经", "没有", "不是", "进行", "文件"]);
  for (const text of texts) {
    for (const token of String(text || "").match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fa5]{2,6}/g) || []) {
      const key = token.toLowerCase();
      if (stop.has(key)) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, Number(limit) || DEFAULT_MAX_ITEMS_PER_KIND))
    .map(([text, count]) => ({ text, count }));
}

function readJSONL(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((item) => item.line.trim())
    .map((item) => {
      try {
        return { row: JSON.parse(item.line), line: item.number };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function relativePath(base, file) {
  return path.relative(base || process.cwd(), file).replace(/\\/g, "/");
}

module.exports = {
  KIND_ORDER,
  buildEvidencePacket,
  chatFilesForLookback,
  compactPlain,
  normalizeChatRecord,
  writeEvidencePacket
};
