const fs = require("fs");
const path = require("path");
const { appendJSONObject, readJSONLShardLines } = require("./jsonl-shards");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function indexFile(workspace) {
  return path.join(workspace, "local_files", "file-index.jsonl");
}

function addFileIndex({ workspace, scope = "group", scopeID = "", userID = "", messageID = "", name = "", originalName = "", relativePath = "", size = 0, parser = "none", status = "archived", summaryPath = "", extractedPath = "", tags = [] }) {
  if (!workspace || !relativePath) {
    return null;
  }
  const item = {
    version: 1,
    id: fileID(),
    time: new Date().toISOString(),
    scope,
    scope_id: String(scopeID || ""),
    user_id: String(userID || ""),
    message_id: String(messageID || ""),
    name: String(name || path.basename(relativePath)),
    original_name: String(originalName || name || path.basename(relativePath)),
    relative_path: String(relativePath),
    size: Number(size) || 0,
    ext: path.extname(String(name || relativePath)).toLowerCase(),
    parser: parser || "none",
    status,
    summary_path: String(summaryPath || ""),
    extracted_path: String(extractedPath || ""),
    tags: [...new Set([...(Array.isArray(tags) ? tags : []), path.extname(String(name || relativePath)).toLowerCase(), parser].map(String).filter(Boolean))]
  };
  ensureDir(path.dirname(indexFile(workspace)));
  appendJSONObject(indexFile(workspace), item);
  return item;
}

function recentFiles({ workspace, limit = 8 }) {
  return readFileIndex(workspace).slice(-Math.max(1, limit)).reverse();
}

function fileStats({ workspace }) {
  const parsed = readFileIndexWithBadCount(workspace);
  const rows = parsed.items;
  const byExt = {};
  const byParser = {};
  const byStatus = {};
  let totalSize = 0;
  let extracted = 0;
  let latest = "";
  for (const item of rows) {
    const ext = item.ext || path.extname(String(item.name || item.relative_path || "")).toLowerCase() || "none";
    const parser = item.parser || "none";
    const status = item.status || "archived";
    byExt[ext] = (byExt[ext] || 0) + 1;
    byParser[parser] = (byParser[parser] || 0) + 1;
    byStatus[status] = (byStatus[status] || 0) + 1;
    totalSize += Number(item.size) || 0;
    if (item.extracted_path) extracted += 1;
    latest = String(latest || "") > String(item.time || "") ? latest : String(item.time || "");
  }
  return {
    total: rows.length,
    bad_lines: parsed.bad_lines,
    total_size: totalSize,
    extracted,
    latest,
    latest_files: rows.slice(-3).reverse(),
    byExt,
    byParser,
    byStatus
  };
}

function searchFiles({ workspace, query = "", limit = 8 }) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    return recentFiles({ workspace, limit });
  }
  return readFileIndex(workspace)
    .filter((item) => fileHaystack(item).includes(q))
    .slice(-Math.max(1, limit))
    .reverse();
}

function formatFileList(items, title = "文件") {
  if (!items || items.length === 0) {
    return "没找到匹配文件。";
  }
  return [
    `${title}：`,
    ...items.map((item) => {
      const size = item.size ? ` ${formatBytes(item.size)}` : "";
      const parser = item.parser && item.parser !== "none" ? ` ${item.parser}` : "";
      const status = item.status && item.status !== "archived" ? ` ${item.status}` : "";
      const extracted = item.extracted_path ? " 已提取" : "";
      return `- ${item.name || path.basename(item.relative_path)}${size}${parser}${status}${extracted}\n  ${item.relative_path}`;
    })
  ].join("\n").slice(0, 1600);
}

function readFileIndex(workspace) {
  return readFileIndexWithBadCount(workspace).items;
}

function readFileIndexWithBadCount(workspace) {
  const file = indexFile(workspace);
  if (!fs.existsSync(file)) {
    return { items: [], bad_lines: 0 };
  }
  const out = { items: [], bad_lines: 0 };
  for (const { line } of readJSONLShardLines(file)) {
    try {
      out.items.push(JSON.parse(line));
    } catch {
      out.bad_lines += 1;
    }
  }
  return out;
}

function fileHaystack(item) {
  return [
    item.name,
    item.original_name,
    item.relative_path,
    item.ext,
    item.parser,
    item.summary_path,
    item.extracted_path,
    ...(item.tags || [])
  ].join("\n").toLowerCase();
}

function formatBytes(value) {
  const n = Number(value) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function formatFileStats(stats) {
  const ext = topCounts(stats.byExt);
  const parser = topCounts(stats.byParser);
  const status = topCounts(stats.byStatus);
  const latest = (stats.latest_files || []).map((item) => item.name || path.basename(item.relative_path || "")).join("，") || "暂无";
  return [
    "文件状态：",
    `已索引：${stats.total}`,
    `坏行：${stats.bad_lines || 0}`,
    `总大小：${formatBytes(stats.total_size || 0)}`,
    `已提取文本：${stats.extracted || 0}`,
    `扩展名：${ext || "暂无"}`,
    `解析器：${parser || "暂无"}`,
    `状态：${status || "暂无"}`,
    `最新文件：${latest}`
  ].join("\n").slice(0, 1600);
}

function topCounts(map) {
  return Object.entries(map || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, count]) => `${key || "none"}:${count}`)
    .join("，");
}

function fileID() {
  return `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  addFileIndex,
  fileStats,
  formatFileStats,
  recentFiles,
  searchFiles,
  formatFileList,
  readFileIndex
};
