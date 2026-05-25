const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function jsonlShardMaxBytes() {
  return Math.max(1, Number(process.env.CHATBOT_QQ_JSONL_SHARD_MAX_BYTES || DEFAULT_MAX_BYTES));
}

function appendJSONL(file, line, options = {}) {
  const text = String(line || "");
  const target = nextShardPath(file, Buffer.byteLength(`${text}\n`, "utf8"), options);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${text}\n`, "utf8");
  return target;
}

function appendJSONObject(file, item, options = {}) {
  return appendJSONL(file, JSON.stringify(item), options);
}

function nextShardPath(file, nextBytes = 0, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes || jsonlShardMaxBytes()));
  const shards = listJSONLShards(file);
  if (shards.length === 0) {
    return file;
  }
  const current = shards[shards.length - 1];
  try {
    const stat = fs.statSync(current);
    if (stat.size + Number(nextBytes || 0) <= maxBytes) {
      return current;
    }
  } catch {
    return current;
  }
  return shardPath(file, shardIndex(current, file) + 1);
}

function listJSONLShards(file) {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  if (!fs.existsSync(dir)) return [];
  const pattern = new RegExp(`^${escapeRegex(stem)}(?:-(\\d{3}))?${escapeRegex(ext)}$`);
  return fs.readdirSync(dir)
    .map((name) => {
      const match = name.match(pattern);
      if (!match) return null;
      return {
        index: match[1] ? Number(match[1]) : 0,
        file: path.join(dir, name)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.file);
}

function readJSONLShards(file) {
  const out = [];
  for (const shard of listJSONLShards(file)) {
    if (!fs.existsSync(shard)) continue;
    const lines = fs.readFileSync(shard, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        out.push(null);
      }
    }
  }
  return out.filter(Boolean);
}

function readJSONLShardLines(file) {
  const out = [];
  for (const shard of listJSONLShards(file)) {
    if (!fs.existsSync(shard)) continue;
    for (const line of fs.readFileSync(shard, "utf8").split(/\r?\n/).filter(Boolean)) {
      out.push({ file: shard, line });
    }
  }
  return out;
}

function shardPath(file, index) {
  if (index <= 0) return file;
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  return path.join(path.dirname(file), `${stem}-${String(index).padStart(3, "0")}${ext}`);
}

function shardIndex(file, baseFile) {
  const ext = path.extname(baseFile);
  const stem = path.basename(baseFile, ext);
  const name = path.basename(file);
  const match = name.match(new RegExp(`^${escapeRegex(stem)}-(\\d{3})${escapeRegex(ext)}$`));
  return match ? Number(match[1]) : 0;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  appendJSONL,
  appendJSONObject,
  jsonlShardMaxBytes,
  listJSONLShards,
  nextShardPath,
  readJSONLShardLines,
  readJSONLShards
};
