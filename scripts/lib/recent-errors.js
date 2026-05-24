const fs = require("fs");
const path = require("path");

const MAX_ERROR_FILE_BYTES = 512 * 1024;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendRecentError({ file, event, maskSensitive = (value) => value }) {
  if (!file || !event) {
    return;
  }
  try {
    ensureDir(path.dirname(file));
    const item = {
      time: new Date().toISOString(),
      kind: "unknown",
      message: "",
      ...event
    };
    fs.appendFileSync(file, `${JSON.stringify(item)}\n`, "utf8");
    trimLargeJSONL(file);
  } catch (err) {
    console.log(new Date().toISOString(), "recent error write failed", maskSensitive(err.message));
  }
}

function readRecentErrors({ file, limit = 8, maskSensitive = (value) => value }) {
  if (!file || !fs.existsSync(file)) {
    return [];
  }
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, limit))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { time: "", kind: "invalid", message: line };
        }
      })
      .map((item) => ({
        ...item,
        message: maskSensitive(String(item.message || "")),
        detail: maskSensitive(String(item.detail || ""))
      }));
  } catch (err) {
    return [{ time: new Date().toISOString(), kind: "recent-errors", message: `读取错误失败：${err.message}` }];
  }
}

function recentErrorStats({ file, scope = "", target = "", limit = 200 }) {
  const rows = readRawRecentErrors({ file, limit });
  const wantedScope = String(scope || "");
  const wantedTarget = String(target || "");
  let current = 0;
  let global = 0;
  const byKind = {};
  for (const item of rows) {
    const itemScope = String(item.scope || "");
    const itemTarget = String(item.target || "");
    if (!itemScope && !itemTarget) {
      global += 1;
    } else if (itemScope === wantedScope && itemTarget === wantedTarget) {
      current += 1;
      const kind = String(item.kind || "unknown");
      byKind[kind] = (byKind[kind] || 0) + 1;
    }
  }
  return { current, global, total: rows.length, byKind };
}

function formatRecentErrors(errors) {
  if (!errors || errors.length === 0) {
    return "最近没有记录到结构化错误。";
  }
  const lines = ["最近错误："];
  for (const item of errors) {
    const time = item.time ? item.time.replace("T", " ").slice(0, 19) : "unknown-time";
    const scope = item.scope ? ` ${item.scope}` : "";
    const target = item.target ? ` ${item.target}` : "";
    const detail = item.detail ? ` | ${item.detail}` : "";
    lines.push(`- ${time} [${item.kind || "unknown"}]${scope}${target}: ${item.message || ""}${detail}`);
  }
  return lines.join("\n").slice(0, 1600);
}

function readRawRecentErrors({ file, limit = 200 }) {
  if (!file || !fs.existsSync(file)) {
    return [];
  }
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, limit))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { time: "", kind: "invalid", message: line };
        }
      });
  } catch {
    return [];
  }
}

function trimLargeJSONL(file) {
  const stat = fs.statSync(file);
  if (stat.size <= MAX_ERROR_FILE_BYTES) {
    return;
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-200);
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

module.exports = {
  appendRecentError,
  readRecentErrors,
  recentErrorStats,
  formatRecentErrors
};
