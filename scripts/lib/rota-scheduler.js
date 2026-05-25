"use strict";

const fs = require("fs");
const path = require("path");

const WEEKDAY_ALIASES = new Map([
  ["日", 0], ["天", 0], ["0", 0], ["7", 0],
  ["一", 1], ["1", 1],
  ["二", 2], ["2", 2],
  ["三", 3], ["3", 3],
  ["四", 4], ["4", 4],
  ["五", 5], ["5", 5],
  ["六", 6], ["6", 6],
]);

function rotaFile(workspace) {
  return path.join(workspace, "memory", "rotas.json");
}

function loadRotas(workspace) {
  try {
    const data = JSON.parse(fs.readFileSync(rotaFile(workspace), "utf8"));
    return Array.isArray(data.rotas) ? data.rotas : [];
  } catch {
    return [];
  }
}

function saveRotas(workspace, rotas) {
  fs.mkdirSync(path.dirname(rotaFile(workspace)), { recursive: true });
  fs.writeFileSync(rotaFile(workspace), JSON.stringify({ version: 1, rotas }, null, 2) + "\n", "utf8");
}

function addRota(workspace, rota) {
  const rotas = loadRotas(workspace);
  const item = {
    version: 1,
    id: rota.id || rotaID(),
    type: "weekly_rota",
    status: "active",
    title: clean(rota.title || "值日提醒"),
    group_id: String(rota.group_id || ""),
    created_by: String(rota.created_by || ""),
    created_at: rota.created_at || new Date().toISOString(),
    day_of_week: Number(rota.day_of_week),
    time: normalizeTime(rota.time),
    timezone: rota.timezone || "Asia/Shanghai",
    members: uniqueList(rota.members),
    tasks: uniqueList(rota.tasks),
    start_date: rota.start_date || localDateKey(new Date()),
    shift_per_run: Number(rota.shift_per_run || 1),
    last_sent_key: String(rota.last_sent_key || ""),
    source_text: clean(rota.source_text || ""),
  };
  if (!isValidRota(item)) {
    return null;
  }
  rotas.push(item);
  saveRotas(workspace, rotas);
  return item;
}

function validateRotaSpec(spec) {
  const normalized = normalizeRotaSpec(spec);
  const errors = [];
  const missing = [];
  if (!Number.isInteger(normalized.day_of_week) || normalized.day_of_week < 0 || normalized.day_of_week > 6) {
    fieldIssue(normalized.day_of_week, "day_of_week", "星期必须是 0-6，0 表示周日", missing, errors);
  }
  if (!/^\d{2}:\d{2}$/.test(normalized.time)) {
    fieldIssue(normalized.time, "time", "时间必须是 HH:MM", missing, errors);
  }
  if (normalized.tasks.length < 2) {
    fieldIssue(normalized.tasks.length ? normalized.tasks : null, "tasks", "任务至少需要 2 项", missing, errors);
  }
  if (normalized.members.length < 2) {
    fieldIssue(normalized.members.length ? normalized.members : null, "current_assignments", "成员分配至少需要 2 人", missing, errors);
  }
  if (normalized.tasks.length >= 2 && normalized.members.length >= 2 && normalized.tasks.length !== normalized.members.length) {
    errors.push({ field: "current_assignments", message: "成员数量必须和任务数量一致" });
  }
  return {
    ok: errors.length === 0 && missing.length === 0,
    errors,
    missing,
    rota: normalized,
  };
}

function createRotaFromSpec(workspace, spec, options = {}) {
  const checked = validateRotaSpec({
    ...spec,
    group_id: spec && spec.group_id !== undefined ? spec.group_id : options.groupID,
    created_by: spec && spec.created_by !== undefined ? spec.created_by : options.userID,
    start_date: spec && spec.start_date !== undefined ? spec.start_date : options.startDate,
    source_text: spec && spec.source_text !== undefined ? spec.source_text : options.sourceText,
  });
  if (!checked.ok) {
    return { ok: false, reason: checked.missing.length ? "missing_fields" : "invalid", ...checked };
  }
  const duplicate = findDuplicateRota(workspace, checked.rota);
  if (duplicate) {
    return { ok: false, reason: "duplicate", duplicate, rota: checked.rota, preview: previewRota(duplicate) };
  }
  const item = addRota(workspace, checked.rota);
  if (!item) {
    return { ok: false, reason: "invalid", errors: [{ field: "rota", message: "创建失败：成员、任务、星期或时间不完整" }], missing: [], rota: checked.rota };
  }
  return { ok: true, item, preview: previewRota(item) };
}

function findDuplicateRota(workspace, rota) {
  const tasksKey = uniqueList(rota.tasks).join("\u0001");
  return listActiveRotas(workspace).find((item) => (
    Number(item.day_of_week) === Number(rota.day_of_week)
    && normalizeTime(item.time) === normalizeTime(rota.time)
    && uniqueList(item.tasks).join("\u0001") === tasksKey
  )) || null;
}

function normalizeRotaSpec(spec = {}) {
  const assignments = spec.current_assignments && typeof spec.current_assignments === "object" ? spec.current_assignments : null;
  const tasks = uniqueList(spec.tasks || (assignments ? Object.values(assignments) : []));
  const members = assignments && tasks.length
    ? membersFromAssignments(assignments, tasks)
    : uniqueList(spec.members || []);
  const shift = spec.rotation && spec.rotation.shift_per_run !== undefined ? spec.rotation.shift_per_run : spec.shift_per_run;
  return {
    title: clean(spec.title || "值日提醒"),
    group_id: String(spec.group_id || ""),
    created_by: String(spec.created_by || ""),
    day_of_week: numberOrNull(spec.day_of_week),
    time: normalizeTime(spec.time),
    timezone: spec.timezone || "Asia/Shanghai",
    members,
    tasks,
    start_date: spec.start_date || localDateKey(new Date()),
    shift_per_run: Number(shift || 1),
    source_text: clean(spec.source_text || ""),
  };
}

function membersFromAssignments(assignments, tasks) {
  const byTask = new Map();
  for (const [member, task] of Object.entries(assignments || {})) {
    const cleanMember = clean(member);
    const cleanTask = clean(task);
    if (cleanMember && cleanTask && !byTask.has(cleanTask)) {
      byTask.set(cleanTask, cleanMember);
    }
  }
  const ordered = tasks.map((task) => byTask.get(task)).filter(Boolean);
  if (ordered.length === tasks.length) return ordered;
  return tasks
    .map((task) => assignments[task])
    .filter((item) => item !== undefined && item !== null)
    .map((item) => clean(item));
}

function previewRota(spec, dates = []) {
  const rota = normalizeRotaSpec(spec);
  if (!isValidRota(rota)) return "";
  const start = dateOnly(new Date(`${rota.start_date}T00:00:00`));
  const current = dates[0] ? new Date(dates[0]) : start;
  const next = dates[1] ? new Date(dates[1]) : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return [
    `本周：${formatAssignmentPreview(rotaAssignments(rota, current), rota.tasks)}`,
    `下周：${formatAssignmentPreview(rotaAssignments(rota, next), rota.tasks)}`,
  ].join("\n");
}

function formatAssignmentPreview(assignments, taskOrder = []) {
  return assignmentsInTaskOrder(assignments, taskOrder).map((item) => `${item.task}->${item.member}`).join("，");
}

function fieldIssue(value, field, message, missing, errors) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
    missing.push(field);
  } else {
    errors.push({ field, message });
  }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function isValidRota(rota) {
  return Number.isInteger(rota.day_of_week)
    && rota.day_of_week >= 0
    && rota.day_of_week <= 6
    && /^\d{2}:\d{2}$/.test(rota.time)
    && rota.members.length >= 2
    && rota.tasks.length >= 2;
}

function listActiveRotas(workspace) {
  return loadRotas(workspace).filter((item) => item.status !== "deleted");
}

function deleteRota(workspace, selector, actor, isAdmin = false) {
  const rotas = loadRotas(workspace);
  const active = rotas.filter((item) => item.status !== "deleted");
  const item = selectRota(active, selector);
  if (!item) return { deleted: 0, reason: "not-found" };
  if (!isAdmin && String(item.created_by || "") !== String(actor || "")) {
    return { deleted: 0, reason: "forbidden", item };
  }
  item.status = "deleted";
  item.deleted_at = new Date().toISOString();
  item.deleted_by = String(actor || "");
  saveRotas(workspace, rotas);
  return { deleted: 1, item };
}

function selectRota(active, selector) {
  const raw = String(selector || "").trim().toLowerCase();
  if (!raw) return null;
  const index = Number(raw);
  if (Number.isInteger(index) && index >= 1 && index <= active.length) return active[index - 1];
  return active.find((item) => String(item.id || "").toLowerCase() === raw || shortID(item.id).toLowerCase() === raw) || null;
}

function parseRotaRequest(text, options = {}) {
  const raw = stripAt(String(text || ""));
  if (!looksLikeRotaIntent(raw, options)) return null;
  const day = parseWeekday(raw);
  const time = parseTime(raw);
  const tasks = parseTasks(raw);
  const members = parseAssignmentMembers(raw, tasks);
  const fallbackMembers = members.length >= 2 ? members : parseMembers(raw);
  if (day === null || !time || members.length < 2 || tasks.length < 2) {
    if (day === null || !time || fallbackMembers.length < 2 || tasks.length < 2) {
      return null;
    }
  }
  return {
    title: raw.includes("值日") ? "值日提醒" : "轮值提醒",
    group_id: String(options.groupID || ""),
    created_by: String(options.userID || ""),
    day_of_week: day,
    time,
    members: fallbackMembers,
    tasks,
    start_date: options.startDate || localDateKey(options.now || new Date()),
    shift_per_run: 1,
    source_text: raw,
  };
}

function looksLikeRotaIntent(text, options = {}) {
  return /每周|每星期|weekly/i.test(text)
    && (options.commandIntent || /提醒|发送|通知/.test(text))
    && /值日|轮值|轮班|轮休|分别/.test(text);
}

function parseWeekday(text) {
  const match = text.match(/(?:每周|每星期|周|星期)([日天一二三四五六0-7])/);
  if (!match) return null;
  return WEEKDAY_ALIASES.has(match[1]) ? WEEKDAY_ALIASES.get(match[1]) : null;
}

function parseTime(text) {
  const re = /(上午|早上|中午|下午|晚上|晚)?\s*(\d{1,2})(?::|：|点半|点)\s*(\d{1,2})?\s*分?/gu;
  for (const match of text.matchAll(re)) {
    let hour = Number(match[2]);
    let minute = match[0].includes("点半") ? 30 : Number(match[3] || 0);
    const period = match[1] || "";
    if ((period.includes("下午") || period.includes("晚上") || period === "晚") && hour < 12) {
      hour += 12;
    }
    if (period.includes("中午") && hour < 11) {
      hour += 12;
    }
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      continue;
    }
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  return "";
}

function parseMembers(text) {
  const explicit = text.match(/([\p{L}\p{N}_-]+(?:[、,，\s]+[\p{L}\p{N}_-]+){1,})\s*(?:\d+\s*)?个人/u);
  if (explicit) return splitList(explicit[1]);
  const compact = text.match(/\b([A-Za-z]{2,12})\s*\d*\s*个人/);
  if (compact) return compact[1].split("");
  const beforeTasks = text.split(/分别|各自/)[0] || "";
  const normalized = beforeTasks
    .replace(/^.*?(?:点半?|[:：]\d{1,2})\s*/u, "")
    .replace(/^.*?(?:提醒|通知)\s*[，,、]?\s*/u, "")
    .replace(/^.*?(?:让|安排|叫|给)\s*/u, "");
  const candidates = splitList(normalized);
  return candidates.length >= 2 ? candidates : [];
}

function parseTasks(text) {
  const ordered = text.match(/(?:值日)?顺序(?:是|为)?\s*([^。；;\n]+)/u);
  if (ordered) {
    const tasks = splitList(ordered[1]);
    if (tasks.length >= 2) return tasks;
  }
  const match = text.match(/(?:分别(?:干|做|负责)?|任务(?:是|为)?)([^。；;\n]+)/u);
  if (!match) return [];
  const cleaned = match[1]
    .replace(/然后.*$/u, "")
    .replace(/每周.*$/u, "");
  return splitList(cleaned).filter((item) => !/^\d*个?人$/.test(item));
}

function parseAssignmentMembers(text, tasks) {
  const taskList = uniqueList(tasks);
  if (taskList.length < 2) return [];
  const taskPattern = taskList.map(escapeRegExp).join("|");
  const re = new RegExp(`(\\d{5,12})\\s*(?:这周|本周|今天|当前|现在)?\\s*(?:负责|做|干|值日)?\\s*(${taskPattern})`, "gu");
  const byTask = new Map();
  let match;
  while ((match = re.exec(text)) !== null) {
    const member = clean(match[1]);
    const task = clean(match[2]);
    if (member && task && !byTask.has(task)) {
      byTask.set(task, member);
    }
  }
  if (byTask.size < taskList.length) return [];
  return taskList.map((task) => byTask.get(task)).filter(Boolean);
}

function splitList(text) {
  return uniqueList(String(text || "")
    .split(/[、,，;；\s]+/)
    .map((item) => clean(item).replace(/^(和|及|与)/u, ""))
    .filter(Boolean));
}

function uniqueList(items) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const value = clean(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.slice(0, 20);
}

function dueRotas(workspace, now = new Date()) {
  const rotas = loadRotas(workspace);
  const due = [];
  let changed = false;
  const currentDay = now.getDay();
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const sentKey = localDateKey(now);
  for (const rota of rotas) {
    if (rota.status === "deleted") continue;
    if (Number(rota.day_of_week) !== currentDay) continue;
    if (currentTime < normalizeTime(rota.time)) continue;
    if (String(rota.last_sent_key || "") === sentKey) continue;
    due.push({ rota, text: formatRotaMessage(rota, now), message: formatRotaMessageSegments(rota, now) });
    rota.last_sent_key = sentKey;
    changed = true;
  }
  if (changed) saveRotas(workspace, rotas);
  return due;
}

function formatRotaMessage(rota, now = new Date()) {
  const assignments = assignmentsInTaskOrder(rotaAssignments(rota, now), rota.tasks);
  return [
    `${rota.title || "轮值提醒"}（${localDateKey(now)}）`,
    ...assignments.map((item) => `- ${item.member}：${item.task}`),
  ].join("\n");
}

function formatRotaMessageSegments(rota, now = new Date()) {
  const assignments = assignmentsInTaskOrder(rotaAssignments(rota, now), rota.tasks);
  const segments = [{ type: "text", data: { text: `${rota.title || "轮值提醒"}（${localDateKey(now)}）\n` } }];
  assignments.forEach((item, index) => {
    segments.push({ type: "text", data: { text: "- " } });
    if (/^\d{5,12}$/.test(String(item.member || ""))) {
      segments.push({ type: "at", data: { qq: String(item.member) } });
    } else {
      segments.push({ type: "text", data: { text: String(item.member || "") } });
    }
    segments.push({ type: "text", data: { text: `：${item.task}${index === assignments.length - 1 ? "" : "\n"}` } });
  });
  return segments;
}

function rotaAssignments(rota, now = new Date()) {
  const members = uniqueList(rota.members);
  const tasks = uniqueList(rota.tasks);
  const weeks = Math.max(0, Math.floor((dateOnly(now) - dateOnly(new Date(`${rota.start_date}T00:00:00`))) / (7 * 24 * 60 * 60 * 1000)));
  const shift = weeks * Number(rota.shift_per_run || 1);
  return members.map((member, index) => ({
    member,
    task: tasks[(index + shift) % tasks.length],
  }));
}

function assignmentsInTaskOrder(assignments, taskOrder = []) {
  const rows = Array.isArray(assignments) ? assignments.slice() : [];
  const order = uniqueList(taskOrder);
  if (!order.length) {
    return rows;
  }
  const byTask = new Map();
  rows.forEach((item) => {
    if (item && !byTask.has(item.task)) {
      byTask.set(item.task, item);
    }
  });
  const ordered = order.map((task) => byTask.get(task)).filter(Boolean);
  const used = new Set(ordered);
  return ordered.concat(rows.filter((item) => !used.has(item)));
}

function formatRotas(rotas) {
  const active = (rotas || []).filter((item) => item.status !== "deleted");
  if (!active.length) return "暂无群轮值提醒。";
  return [
    "群轮值提醒：",
    ...active.map((item, index) => `${index + 1}. ${shortID(item.id)} ${item.title} 每周${weekdayName(item.day_of_week)} ${normalizeTime(item.time)}：${item.members.join("、")} -> ${item.tasks.join("、")}`)
  ].join("\n").slice(0, 1600);
}

function formatRotaCreated(rota) {
  return [
    `已创建群轮值提醒：${shortID(rota.id)}`,
    `时间：每周${weekdayName(rota.day_of_week)} ${normalizeTime(rota.time)}`,
    `成员：${rota.members.join("、")}`,
    `任务：${rota.tasks.join("、")}`,
    "轮换：每周每人顺到下一个任务",
    previewRota(rota),
  ].join("\n");
}

function normalizeTime(time) {
  const match = String(time || "").match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return "";
  return `${String(Number(match[1])).padStart(2, "0")}:${String(Number(match[2])).padStart(2, "0")}`;
}

function localDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateOnly(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function weekdayName(day) {
  return ["日", "一", "二", "三", "四", "五", "六"][Number(day)] || "?";
}

function shortID(id) {
  return String(id || "").replace(/^rota_/, "").slice(-6) || "-";
}

function rotaID() {
  return `rota_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function stripAt(text) {
  return String(text || "")
    .replace(/\[CQ:at,[^\]]+\]/g, " ")
    .replace(/@\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(text) {
  return String(text || "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  addRota,
  createRotaFromSpec,
  deleteRota,
  dueRotas,
  formatRotaCreated,
  formatRotaMessage,
  formatRotaMessageSegments,
  formatRotas,
  listActiveRotas,
  loadRotas,
  parseRotaRequest,
  previewRota,
  rotaAssignments,
  rotaFile,
  saveRotas,
  shortID,
  validateRotaSpec,
};
