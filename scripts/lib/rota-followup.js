"use strict";

const fs = require("fs");
const path = require("path");
const { parseTaskWithModel } = require("../task-agent");
const { createRotaFromSpec, formatRotaCreated, validateRotaSpec } = require("./rota-scheduler");

const PENDING_FILE = "pending-rota-task.json";
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function pendingRotaFile(workspace) {
  return path.join(workspace, "memory", PENDING_FILE);
}

function startPendingRotaTask(workspace, parseResult, context = {}, options = {}) {
  const spec = parseResult && parseResult.spec ? parseResult.spec : {};
  const missing = prioritizedMissing(parseResult && parseResult.missing);
  const pending = {
    version: 1,
    task_type: "weekly_rota",
    scope: "group",
    group_id: String(context.groupID || ""),
    user_id: String(context.userID || ""),
    original_text: String(context.sourceText || spec.source_text || ""),
    spec,
    missing,
    asked_field: missing[0] || "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + Number(options.ttlMs || DEFAULT_TTL_MS)).toISOString(),
  };
  writePending(workspace, pending);
  return {
    ok: true,
    pending,
    reply: questionForField(pending.asked_field),
  };
}

function continuePendingRotaTask(workspace, text, context = {}, options = {}) {
  const pending = readPending(workspace);
  if (!pending || !pendingMatches(pending, context) || isExpired(pending)) {
    if (pending && isExpired(pending)) clearPendingRotaTask(workspace);
    return { handled: false };
  }

  const merged = mergeRotaSpec(pending.spec, parseSupplement(pending, text, context, options));
  const checked = validateRotaSpec({
    ...merged,
    group_id: context.groupID,
    created_by: context.userID,
    source_text: [pending.original_text, text].filter(Boolean).join("\n补充："),
  });
  if (!checked.ok) {
    const missing = prioritizedMissing(checked.missing);
    const next = {
      ...pending,
      spec: merged,
      missing,
      asked_field: missing[0] || pending.asked_field,
      updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + Number(options.ttlMs || DEFAULT_TTL_MS)).toISOString(),
    };
    writePending(workspace, next);
    return {
      handled: true,
      ok: false,
      reason: checked.missing.length ? "missing_fields" : "invalid_spec",
      reply: checked.missing.length
        ? questionForField(next.asked_field)
        : invalidQuestion(checked.errors),
      pending: next,
      errors: checked.errors,
    };
  }

  const created = createRotaFromSpec(workspace, checked.rota, {
    groupID: context.groupID,
    userID: context.userID,
    sourceText: [pending.original_text, text].filter(Boolean).join("\n补充："),
  });
  clearPendingRotaTask(workspace);
  if (created.ok) {
    return {
      handled: true,
      ok: true,
      item: created.item,
      reply: formatRotaCreated(created.item),
    };
  }
  if (created.reason === "duplicate") {
    return {
      handled: true,
      ok: false,
      reason: "duplicate",
      reply: ["已有相同时间和任务顺序的群轮值提醒，暂不重复创建。", created.preview || ""].filter(Boolean).join("\n"),
    };
  }
  return {
    handled: true,
    ok: false,
    reason: created.reason || "create_failed",
    reply: "创建失败：成员、任务、星期或时间不完整。",
  };
}

function clearPendingRotaTask(workspace) {
  fs.rmSync(pendingRotaFile(workspace), { force: true });
}

function readPending(workspace) {
  try {
    return JSON.parse(fs.readFileSync(pendingRotaFile(workspace), "utf8"));
  } catch {
    return null;
  }
}

function writePending(workspace, pending) {
  const file = pendingRotaFile(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(pending, null, 2) + "\n", "utf8");
}

function pendingMatches(pending, context) {
  return String(pending.task_type || "") === "weekly_rota"
    && String(pending.group_id || "") === String(context.groupID || "")
    && String(pending.user_id || "") === String(context.userID || "");
}

function isExpired(pending) {
  const expires = new Date(pending.expires_at || 0).getTime();
  return !Number.isFinite(expires) || expires <= Date.now();
}

function parseSupplement(pending, text, context, options = {}) {
  const combined = [
    pending.original_text,
    text,
  ].filter(Boolean).join("\n补充：");
  const parsed = parseTaskWithModel(combined, "weekly_rota", {
    ...context,
    modelParser: options.modelParser,
    fixtures: options.fixtures,
  });
  return parsed.ok ? parsed.spec : {};
}

function mergeRotaSpec(base = {}, patch = {}) {
  const merged = { ...base };
  for (const field of ["task_type", "title", "day_of_week", "time", "timezone", "group_id", "created_by", "start_date", "source_text"]) {
    if (hasValue(patch[field])) merged[field] = patch[field];
  }
  if (Array.isArray(patch.tasks) && patch.tasks.length) {
    merged.tasks = patch.tasks;
  }
  if (patch.current_assignments && typeof patch.current_assignments === "object" && Object.keys(patch.current_assignments).length) {
    merged.current_assignments = {
      ...(base.current_assignments && typeof base.current_assignments === "object" ? base.current_assignments : {}),
      ...patch.current_assignments,
    };
  }
  if (patch.rotation && typeof patch.rotation === "object") {
    merged.rotation = { ...(base.rotation || {}), ...patch.rotation };
  }
  if (patch.notify && typeof patch.notify === "object") {
    merged.notify = { ...(base.notify || {}), ...patch.notify };
  }
  return merged;
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function prioritizedMissing(missing = []) {
  const order = ["current_assignments", "tasks", "time", "day_of_week"];
  const set = new Set([].concat(missing || []).filter(Boolean));
  return order.filter((field) => set.has(field));
}

function questionForField(field) {
  const questions = {
    current_assignments: "我已经识别到这是“每周值日提醒”，还缺本周每个人对应的任务。请按“QQ号 任务”发给我，例如：1234500001 洗手台，1234500006 拖地。",
    tasks: "我已经识别到这是“每周值日提醒”，还缺值日顺序。请发轮换顺序，例如：洗手台、拖地、厕所、轮休。",
    time: "我已经识别到这是“每周值日提醒”，还缺提醒时间。你要每周几几点发？",
    day_of_week: "我已经识别到这是“每周值日提醒”，还缺每周几提醒。你要周几发？",
  };
  return questions[field] || "我已经识别到这是“每周值日提醒”，但还缺必要字段。请补充。";
}

function invalidQuestion(errors = []) {
  const first = errors[0];
  return first ? `值日提醒解析到了，但字段不合法：${first.field} ${first.message}。请重新补充这一项。` : "值日提醒解析到了，但字段不合法。请重新补充。";
}

module.exports = {
  clearPendingRotaTask,
  continuePendingRotaTask,
  mergeRotaSpec,
  pendingRotaFile,
  questionForField,
  startPendingRotaTask,
};
