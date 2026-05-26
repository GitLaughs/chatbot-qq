const fs = require("fs");
const path = require("path");
const { appendJSONObject, readJSONLShards } = require("./jsonl-shards");

const KIND_LABELS = {
  simulation: "仿真",
  report: "报告",
  problem: "题目解析",
  tuning: "指标调参",
  netlist: "netlist",
  unknown: "归档",
};

function academicArchiveFile(workspace) {
  return path.join(workspace || "", "memory", "academic-archive.jsonl");
}

function archiveAcademicTaskResult({ workspace, task = {}, text = "", artifacts = [], status = "done" }) {
  if (!workspace || status !== "done") {
    return null;
  }
  const classified = classifyAcademicWork({
    text: [task.text, text, JSON.stringify(task.spec || {})].filter(Boolean).join("\n"),
    artifacts,
    taskType: task.task_type || "",
  });
  if (!classified.is_academic && !artifacts.length) {
    return null;
  }
  const item = {
    version: 1,
    id: archiveID(),
    time: new Date().toISOString(),
    scope: String(task.scope || ""),
    scope_id: String(task.scope_id || ""),
    user_id: String(task.user_id || ""),
    message_id: String(task.message_id || ""),
    task_id: String(task.id || ""),
    task_type: String(task.task_type || ""),
    status,
    course: classified.course,
    date: classified.date || todayKey(),
    kind: classified.kind,
    topic: classified.topic,
    query_terms: classified.query_terms,
    artifacts: normalizeArtifacts(artifacts),
    summary: cleanSummary(text),
  };
  fs.mkdirSync(path.dirname(academicArchiveFile(workspace)), { recursive: true });
  appendJSONObject(academicArchiveFile(workspace), item);
  return item;
}

function addAcademicArchiveEntry({ workspace, item = {} }) {
  if (!workspace) return null;
  const classified = classifyAcademicWork({
    text: [item.text, item.summary, item.topic, item.course, (item.artifacts || []).join("\n")].filter(Boolean).join("\n"),
    artifacts: item.artifacts || [],
    taskType: item.task_type || "",
  });
  const row = {
    version: 1,
    id: item.id || archiveID(),
    time: item.time || new Date().toISOString(),
    scope: String(item.scope || ""),
    scope_id: String(item.scope_id || ""),
    user_id: String(item.user_id || ""),
    message_id: String(item.message_id || ""),
    task_id: String(item.task_id || ""),
    task_type: String(item.task_type || ""),
    status: String(item.status || "done"),
    course: String(item.course || classified.course || ""),
    date: String(item.date || classified.date || todayKey()),
    kind: String(item.kind || classified.kind || "unknown"),
    topic: String(item.topic || classified.topic || ""),
    query_terms: unique([...(item.query_terms || []), ...classified.query_terms]),
    artifacts: normalizeArtifacts(item.artifacts || []),
    summary: cleanSummary(item.summary || item.text || ""),
  };
  fs.mkdirSync(path.dirname(academicArchiveFile(workspace)), { recursive: true });
  appendJSONObject(academicArchiveFile(workspace), row);
  return row;
}

function searchAcademicArchive({ workspace, query = "", limit = 5 }) {
  const q = String(query || "").trim();
  const terms = extractQueryTerms(q);
  const wantedKind = kindFromText(q);
  const rows = readAcademicArchive(workspace);
  return rows
    .map((item) => ({ item, score: scoreArchiveItem(item, terms, wantedKind, q) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || String(b.item.time || "").localeCompare(String(a.item.time || "")))
    .slice(0, Math.max(1, Number(limit) || 5))
    .map((row) => row.item);
}

function readAcademicArchive(workspace) {
  const file = academicArchiveFile(workspace);
  if (!fs.existsSync(file) && !fs.existsSync(path.dirname(file))) {
    return [];
  }
  return readJSONLShards(file).filter(Boolean);
}

function formatAcademicArchiveMatches(items, query = "") {
  const list = (items || []).filter(Boolean);
  if (list.length === 0) {
    return "没找到匹配归档。";
  }
  const first = list[0];
  const title = query ? `找到上次 ${cleanInline(query, 24)}：` : "找到相关归档：";
  const lines = [title];
  for (const item of list.slice(0, 3)) {
    const label = [
      item.course || "",
      item.date || shortDate(item.time),
      KIND_LABELS[item.kind] || item.kind || "归档",
      item.topic || "",
    ].filter(Boolean).join(" / ");
    lines.push(`- ${label || "归档记录"}`);
    if (item.summary) {
      lines.push(`  关键结果：${cleanInline(item.summary, 120)}`);
    }
    const artifacts = preferredArtifacts(item.artifacts || []);
    for (const artifact of artifacts.slice(0, 4)) {
      lines.push(`  ${artifact}`);
    }
  }
  if (list.length > 1 && first && query) {
    lines.push(`共 ${list.length} 条，已按相关性和时间排序。`);
  }
  return lines.join("\n").slice(0, 1600);
}

function looksLikeAcademicSearch(text) {
  const value = String(text || "").trim();
  if (!value || value.startsWith("/")) return false;
  if (!/(找一下|找找|查一下|搜一下|定位|上次|之前|最近|上回)/.test(value)) return false;
  return /(仿真|波形|报告|实验|题目|解析|证明|计算|公式|调参|指标|netlist|FIFO|fifo|Vivado|HSPICE|LTspice|xsim)/.test(value);
}

function classifyAcademicWork({ text = "", artifacts = [], taskType = "" } = {}) {
  const value = [text, taskType, ...(artifacts || [])].join("\n");
  const kind = kindFromText(value) || kindFromTaskType(taskType) || "unknown";
  const course = courseFromText(value);
  const topic = topicFromText(value);
  const queryTerms = unique([
    ...extractQueryTerms(value),
    course,
    topic,
    kind,
  ].filter(Boolean)).slice(0, 16);
  return {
    is_academic: kind !== "unknown" || Boolean(course) || Boolean(topic),
    course,
    date: dateFromText(value),
    kind,
    topic,
    query_terms: queryTerms,
  };
}

function kindFromTaskType(taskType) {
  const type = String(taskType || "");
  if (type === "vivado_simulation") return "simulation";
  return "";
}

function kindFromText(text) {
  const value = String(text || "");
  if (/(已有\s*netlist|netlist|\.cir\b|\.sp\b|\.asc\b)/i.test(value)) return "netlist";
  if (/(指标|调参|参数|优化|增益|带宽|相位裕度|裕量|tuning)/i.test(value)) return "tuning";
  if (/(仿真|simulation|vivado|xsim|hspice|ltspice|波形|vcd|wdb|waveform|fifo)/i.test(value)) return "simulation";
  if (/(报告|实验报告|docx|pdf|markdown|\bmd\b)/i.test(value)) return "report";
  if (/(题目|解析|证明|计算|公式|高数|线代|线性代数|矩阵|微积分)/i.test(value)) return "problem";
  return "";
}

function courseFromText(text) {
  const value = String(text || "");
  const rules = [
    ["数字系统", /(数字系统|数电|FIFO|fifo|Vivado|xsim|verilog|systemverilog)/i],
    ["模电", /(模电|模拟电子|HSPICE|LTspice|\.cir\b|\.sp\b|运放|滤波器)/i],
    ["线代", /(线代|线性代数|矩阵|行列式|特征值|向量空间)/i],
    ["高数", /(高数|微积分|极限|导数|积分|级数)/i],
    ["大学物理", /(大学物理|物理实验|示波器|光栅|牛顿环)/i],
    ["英语", /(英语|听力|阅读|作文|翻译)/i],
  ];
  const hit = rules.find(([, pattern]) => pattern.test(value));
  return hit ? hit[0] : "";
}

function topicFromText(text) {
  const value = String(text || "");
  const rules = [
    ["FIFO", /\bFIFO\b/i],
    ["状态机", /(状态机|FSM)/i],
    ["计数器", /(计数器|counter)/i],
    ["滤波器", /(滤波器|filter)/i],
    ["运放", /(运放|op-?amp)/i],
    ["矩阵", /(矩阵|matrix)/i],
  ];
  const hit = rules.find(([, pattern]) => pattern.test(value));
  if (hit) return hit[0];
  const named = String(value).match(/(?:题目|实验|报告|仿真|解析)[:：\s]+([A-Za-z0-9_\-\u4e00-\u9fa5]{2,24})/);
  return named ? named[1] : "";
}

function dateFromText(text) {
  const match = String(text || "").match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function scoreArchiveItem(item, terms, wantedKind, rawQuery) {
  const haystack = archiveHaystack(item);
  const usefulTerms = (terms || []).filter((term) => !["上次", "之前", "最近", "找一下", "查一下", "搜一下", "定位"].includes(term));
  let score = 0;
  for (const term of usefulTerms) {
    if (haystack.includes(String(term).toLowerCase())) {
      score += 3;
    } else if (!["仿真", "报告", "题目", "解析", "调参", "指标"].includes(term)) {
      return 0;
    }
  }
  if (wantedKind && item.kind === wantedKind) score += 8;
  if (wantedKind && item.kind !== wantedKind && usefulTerms.length <= 1) return 0;
  if (/上次|最近|上回/.test(rawQuery)) score += 1;
  return score || (usefulTerms.length === 0 ? 1 : 0);
}

function archiveHaystack(item) {
  return [
    item.course,
    item.date,
    item.kind,
    item.topic,
    item.summary,
    item.task_type,
    ...(item.query_terms || []),
    ...(item.artifacts || []),
  ].join("\n").toLowerCase();
}

function extractQueryTerms(text) {
  const value = String(text || "");
  const out = [];
  const lower = value.toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9_+\-.]{2,}/g)) {
    out.push(match[0]);
  }
  const known = ["FIFO", "仿真", "波形", "报告", "实验报告", "题目", "解析", "证明", "计算", "公式", "调参", "指标", "netlist", "数电", "数字系统", "模电", "线代", "线性代数", "高数", "矩阵", "Vivado", "HSPICE", "LTspice", "xsim"];
  for (const term of known) {
    if (value.includes(term) || lower.includes(term.toLowerCase())) {
      out.push(term.toLowerCase());
    }
  }
  return unique(out.map((item) => item.trim()).filter(Boolean));
}

function normalizeArtifacts(artifacts) {
  return unique((artifacts || [])
    .map((item) => typeof item === "string" ? item : item && (item.path || item.relative_path || item.name) || "")
    .map((item) => String(item || "").replace(/\\/g, "/").trim())
    .filter(Boolean))
    .slice(0, 12);
}

function preferredArtifacts(artifacts) {
  const list = normalizeArtifacts(artifacts);
  const images = list.filter((item) => /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(item));
  const results = list.filter((item) => /\.(?:json|txt|md|csv)$/i.test(item) || /result|summary|receipt|结果|报告/i.test(item));
  const other = list.filter((item) => !images.includes(item) && !results.includes(item));
  return unique([...images, ...results, ...other]);
}

function cleanSummary(text) {
  return cleanInline(String(text || "").replace(/\b(?:local_files|memory\/task-results)\/[^\s，。；"'<>]+/g, ""), 240);
}

function cleanInline(text, limit = 120) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(12, Number(limit) || 120));
}

function shortDate(value) {
  const text = String(value || "");
  return text.slice(0, 10);
}

function unique(items) {
  return [...new Set((items || []).map((item) => String(item || "")).filter(Boolean))];
}

function archiveID() {
  return `acad_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  addAcademicArchiveEntry,
  archiveAcademicTaskResult,
  classifyAcademicWork,
  formatAcademicArchiveMatches,
  looksLikeAcademicSearch,
  readAcademicArchive,
  searchAcademicArchive,
};
