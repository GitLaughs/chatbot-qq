"use strict";

const fs = require("fs");
const path = require("path");
const { appendJSONObject, readJSONLShardLines } = require("./jsonl-shards");

function taskRequestFile(workspace) {
  return path.join(workspace || "", "memory", "task-requests.jsonl");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function createTaskRequest({ workspace, scope = "", scopeID = "", userID = "", messageID = "", taskType = "", confidence = 0, text = "", spec = null, status = "new" }) {
  if (!workspace || !taskType) {
    return null;
  }
  const existing = findTaskRequestByMessage({ workspace, messageID, taskType });
  if (existing) {
    return existing;
  }
  const id = taskID();
  const item = {
    version: 1,
    type: "task_request",
    id,
    status,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    receipt_path: taskReceiptPath(id),
    scope: normalizeScope(scope),
    scope_id: String(scopeID || ""),
    user_id: String(userID || ""),
    message_id: String(messageID || ""),
    task_type: String(taskType || ""),
    confidence: Number(confidence) || 0,
    text: clean(text, 500),
    spec: spec && typeof spec === "object" ? spec : null,
  };
  appendTaskEvent(workspace, item);
  return item;
}

function updateTaskRequest({ workspace, id, status, result = null, error = "", spec = null }) {
  if (!workspace || !id || !status) {
    return null;
  }
  const event = {
    version: 1,
    type: "task_update",
    id: String(id),
    status: String(status),
    updated_at: new Date().toISOString(),
  };
  if (result) event.result = result;
  if (error) event.error = clean(error, 500);
  if (spec && typeof spec === "object") event.spec = spec;
  appendTaskEvent(workspace, event);
  return event;
}

function writeTaskReceipt({ workspace, id, receipt }) {
  if (!workspace || !id || !receipt || typeof receipt !== "object") {
    return null;
  }
  const relative = taskReceiptPath(id);
  const file = path.join(workspace, relative);
  ensureDir(path.dirname(file));
  const body = {
    version: 1,
    task_id: String(id),
    updated_at: new Date().toISOString(),
    ...receipt,
  };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return { path: relative, receipt: body };
}

function readTaskReceipt({ workspace, id }) {
  if (!workspace || !id) return null;
  const file = path.join(workspace, taskReceiptPath(id));
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function findTaskRequestByID({ workspace, id }) {
  const wanted = String(id || "").trim();
  if (!wanted) return null;
  const tasks = listTaskRequests({ workspace, limit: 200 });
  return tasks.find((item) => String(item.id || "") === wanted)
    || tasks.find((item) => String(item.id || "").endsWith(wanted))
    || null;
}

function findTaskRequestByMessage({ workspace, messageID = "", taskType = "" }) {
  const wantedMessage = String(messageID || "");
  const wantedType = String(taskType || "");
  if (!wantedMessage || !wantedType) return null;
  return listTaskRequests({ workspace, includeUpdates: false })
    .reverse()
    .find((item) => String(item.message_id || "") === wantedMessage && String(item.task_type || "") === wantedType) || null;
}

function findTaskRequestsByMessage({ workspace, messageID = "" }) {
  const wantedMessage = String(messageID || "");
  if (!wantedMessage) return [];
  return listTaskRequests({ workspace, limit: 200 })
    .filter((item) => String(item.message_id || "") === wantedMessage);
}

function findAwaitingInputTask({ workspace, scope = "", scopeID = "", userID = "" }) {
  const wantedScope = normalizeScope(scope);
  const wantedScopeID = String(scopeID || "");
  const wantedUserID = String(userID || "");
  return listTaskRequests({ workspace, limit: 100 })
    .reverse()
    .find((item) => String(item.status || "") === "awaiting_input"
      && (!wantedScope || String(item.scope || "") === wantedScope)
      && (!wantedScopeID || String(item.scope_id || "") === wantedScopeID)
      && (!wantedUserID || String(item.user_id || "") === wantedUserID)) || null;
}

function listTaskRequests({ workspace, includeUpdates = false, limit = 50 }) {
  const rows = readTaskEvents(workspace);
  if (includeUpdates) return rows.slice(-Math.max(1, Number(limit) || 50));
  const byID = new Map();
  for (const row of rows) {
    if (!row || !row.id) continue;
    if (row.type === "task_request") {
      byID.set(row.id, { ...row });
      continue;
    }
    if (row.type === "task_update" && byID.has(row.id)) {
      const current = byID.get(row.id);
      byID.set(row.id, { ...current, status: row.status || current.status, updated_at: row.updated_at || current.updated_at, result: row.result || current.result, error: row.error || current.error, spec: row.spec || current.spec });
    }
  }
  return [...byID.values()].slice(-Math.max(1, Number(limit) || 50));
}

function taskReceiptPath(taskIDValue) {
  return `memory/task-results/${safeName(taskIDValue)}.json`;
}

function formatTaskRequests(tasks, options = {}) {
  const list = (tasks || []).filter(Boolean);
  if (list.length === 0) {
    return "最近没有自然语言任务。";
  }
  const lines = ["最近自然语言任务："];
  for (const item of list.slice(-Math.max(1, Number(options.limit) || 8)).reverse()) {
    lines.push(`- ${shortTaskID(item.id)} ${statusLabel(item.status)} ${item.task_type || "task"} ${shortTime(item.updated_at || item.created_at)} ${clean(item.text || "", 54)}`);
  }
  lines.push("查看详情：/任务 task_id");
  return lines.join("\n").slice(0, 1600);
}

function formatTaskRequestDetail(task, receipt = null) {
  if (!task) return "没有找到这个任务。";
  const lines = [
    "任务详情：",
    `ID：${task.id}`,
    `状态：${statusLabel(task.status)}`,
    `类型：${task.task_type || "-"}`,
    `范围：${task.scope || "-"}:${task.scope_id || ""}`,
    `创建：${shortTime(task.created_at)}`,
    `更新：${shortTime(task.updated_at)}`,
    `receipt：${task.receipt_path || taskReceiptPath(task.id)}`,
  ];
  if (task.error) lines.push(`错误：${clean(task.error, 160)}`);
  if (task.result) lines.push(`结果：${clean(JSON.stringify(task.result), 240)}`);
  if (receipt) {
    lines.push(`receipt状态：${receipt.status || "-"}`);
    if (receipt.result) {
      lines.push(`receipt结果：${clean(JSON.stringify(receipt.result), 240)}`);
      if (receipt.result.upload_status) {
        lines.push(`上传：${receipt.result.upload_status}${receipt.result.upload_detail ? ` ${clean(receipt.result.upload_detail, 120)}` : ""}`);
      }
    }
    if (Array.isArray(receipt.artifacts) && receipt.artifacts.length) {
      lines.push(`产物：${artifactLabels(receipt.artifacts).join("，") || "-"}`);
    }
    if (Array.isArray(receipt.checks) && receipt.checks.length) {
      lines.push(`检查：${receipt.checks.map((item) => typeof item === "string" ? item : `${item.name || "check"}:${item.status || ""}`).slice(0, 5).join("，")}`);
      const uploads = receipt.checks
        .filter((item) => item && typeof item === "object" && item.name === "file_upload")
        .map((item) => `${item.path || item.target || "file"}:${item.status || ""}`)
        .filter(Boolean)
        .slice(0, 5);
      if (uploads.length) {
        lines.push(`上传记录：${uploads.join("，")}`);
      }
    }
  }
  lines.push(`原文：${clean(task.text || "", 260) || "-"}`);
  return lines.join("\n").slice(0, 1800);
}

function artifactLabels(artifacts) {
  return (artifacts || [])
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const label = item.path || item.relative_path || item.name || "";
      const status = item.status || item.upload_status || "";
      return status ? `${label}:${status}` : label;
    })
    .filter(Boolean)
    .slice(0, 5);
}

function appendTaskEvent(workspace, event) {
  const file = taskRequestFile(workspace);
  ensureDir(path.dirname(file));
  ensureDir(path.join(workspace || "", "memory", "task-results"));
  appendJSONObject(file, event);
}

function readTaskEvents(workspace) {
  const file = taskRequestFile(workspace);
  const out = [];
  for (const { line } of readJSONLShardLines(file)) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // Ignore malformed task rows.
    }
  }
  return out;
}

function normalizeScope(scope) {
  return ["group", "private"].includes(scope) ? scope : "";
}

function taskID() {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeName(value) {
  return String(value || "task").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 120);
}

function clean(value, limit) {
  return String(value || "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(20, Number(limit) || 240));
}

function shortTaskID(id) {
  const value = String(id || "");
  return value.length > 14 ? value.slice(-14) : value || "-";
}

function statusLabel(status) {
  const value = String(status || "new");
  const labels = {
    new: "新建",
    delegated: "已委托",
    running: "执行中",
    awaiting_input: "待补充",
    awaiting_confirmation: "待确认",
    approved: "已确认",
    cancelled: "已取消",
    done: "完成",
    failed: "失败",
  };
  return labels[value] || value;
}

function shortTime(value) {
  return String(value || "").replace("T", " ").slice(0, 16) || "-";
}

module.exports = {
  createTaskRequest,
  findAwaitingInputTask,
  findTaskRequestByMessage,
  findTaskRequestByID,
  formatTaskRequestDetail,
  formatTaskRequests,
  findTaskRequestsByMessage,
  listTaskRequests,
  readTaskReceipt,
  taskReceiptPath,
  taskRequestFile,
  updateTaskRequest,
  writeTaskReceipt,
};
