"use strict";

const fs = require("fs");
const path = require("path");

function reminderFile(workspace) {
  return path.join(workspace, "memory", "reminders.json");
}

function loadReminders(workspace) {
  try {
    const data = JSON.parse(fs.readFileSync(reminderFile(workspace), "utf8"));
    return Array.isArray(data.reminders) ? data.reminders : [];
  } catch {
    return [];
  }
}

function saveReminders(workspace, reminders) {
  fs.mkdirSync(path.dirname(reminderFile(workspace)), { recursive: true });
  fs.writeFileSync(reminderFile(workspace), JSON.stringify({ version: 1, reminders }, null, 2) + "\n", "utf8");
}

function validateReminderSpec(spec = {}) {
  const item = normalizeReminderSpec(spec);
  const errors = [];
  const missing = [];
  if (!["daily", "weekly", "once"].includes(item.schedule.type)) {
    errors.push({ field: "schedule.type", message: "只支持 daily、weekly 或 once" });
  }
  if (!/^\d{2}:\d{2}$/.test(item.schedule.time)) {
    fieldIssue(item.schedule.time, "schedule.time", "时间必须是 HH:MM", missing, errors);
  }
  if (item.schedule.type === "weekly" && (!Number.isInteger(item.schedule.day_of_week) || item.schedule.day_of_week < 0 || item.schedule.day_of_week > 6)) {
    fieldIssue(item.schedule.day_of_week, "schedule.day_of_week", "星期必须是 0-6", missing, errors);
  }
  if (item.schedule.type === "once" && !/^\d{4}-\d{2}-\d{2}$/.test(item.schedule.date || "")) {
    fieldIssue(item.schedule.date, "schedule.date", "日期必须是 YYYY-MM-DD", missing, errors);
  }
  if (!item.message) {
    missing.push("message");
  }
  return { ok: errors.length === 0 && missing.length === 0, errors, missing, reminder: item };
}

function createReminderFromSpec(workspace, spec = {}, options = {}) {
  const checked = validateReminderSpec({
    ...spec,
    scope: spec.scope || options.scope,
    scope_id: spec.scope_id || options.scopeID,
    created_by: spec.created_by || options.userID,
  });
  if (!checked.ok) {
    return { ok: false, reason: checked.missing.length ? "missing_fields" : "invalid", ...checked };
  }
  const duplicate = findDuplicateReminder(workspace, checked.reminder);
  if (duplicate) {
    return { ok: false, reason: "duplicate", duplicate, reminder: checked.reminder };
  }
  const reminders = loadReminders(workspace);
  const item = {
    ...checked.reminder,
    id: checked.reminder.id || reminderID(),
    created_at: checked.reminder.created_at || new Date().toISOString(),
    status: "active",
    last_sent_key: "",
  };
  reminders.push(item);
  saveReminders(workspace, reminders);
  return { ok: true, item };
}

function dueReminders(workspace, now = new Date()) {
  const reminders = loadReminders(workspace);
  const due = [];
  let changed = false;
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const dateKey = localDateKey(now);
  for (const item of reminders) {
    if (item.status === "deleted") continue;
    if (item.schedule.type === "once") {
      const occurrence = onceOccurrence(item, now);
      if (!occurrence) continue;
      for (const event of dueReminderEvents(item, occurrence, now)) {
        due.push({ reminder: item, text: formatReminderMessage(item, event), message: formatReminderSegments(item, event), event });
        markSent(item, event.key);
        changed = true;
      }
      if (hasSent(item, occurrence.finalKey)) {
        item.status = "done";
      }
      continue;
    }
    if (item.schedule.type === "weekly" && Number(item.schedule.day_of_week) !== now.getDay()) continue;
    if (currentTime < item.schedule.time) continue;
    const finalKey = `${dateKey}:due`;
    if (String(item.last_sent_key || "") === dateKey || hasSent(item, finalKey)) continue;
    const event = { kind: "due", key: finalKey };
    due.push({ reminder: item, text: formatReminderMessage(item, event), message: formatReminderSegments(item, event), event });
    item.last_sent_key = dateKey;
    markSent(item, finalKey);
    changed = true;
  }
  if (changed) saveReminders(workspace, reminders);
  return due;
}

function normalizeReminderSpec(spec = {}) {
  const schedule = spec.schedule && typeof spec.schedule === "object" ? spec.schedule : {};
  return {
    version: 1,
    id: spec.id ? String(spec.id) : "",
    type: "scheduled_reminder",
    status: spec.status || "active",
    title: clean(spec.title || "定时提醒"),
    scope: ["group", "private"].includes(spec.scope) ? spec.scope : "private",
    scope_id: String(spec.scope_id || ""),
    created_by: String(spec.created_by || ""),
    schedule: {
      type: String(schedule.type || "daily").toLowerCase(),
      time: normalizeTime(schedule.time || spec.time),
      timezone: schedule.timezone || spec.timezone || "Asia/Shanghai",
      day_of_week: numberOrNull(schedule.day_of_week),
      date: normalizeDate(schedule.date || spec.date),
    },
    message: clean(spec.message || spec.title || ""),
    notify: normalizeNotify(spec.notify),
    source_text: clean(spec.source_text || ""),
  };
}

function findDuplicateReminder(workspace, reminder) {
  return loadReminders(workspace).find((item) => item.status !== "deleted"
    && item.scope === reminder.scope
    && String(item.scope_id || "") === String(reminder.scope_id || "")
    && item.schedule.type === reminder.schedule.type
    && item.schedule.time === reminder.schedule.time
    && String(item.schedule.date || "") === String(reminder.schedule.date || "")
    && Number(item.schedule.day_of_week || 0) === Number(reminder.schedule.day_of_week || 0)
    && item.message === reminder.message) || null;
}

function formatReminderCreated(item) {
  const when = item.schedule.type === "once"
    ? `${item.schedule.date} ${item.schedule.time}`
    : item.schedule.type === "weekly"
    ? `每周${weekdayName(item.schedule.day_of_week)} ${item.schedule.time}`
    : `每天 ${item.schedule.time}`;
  const leads = leadMinutes(item).length ? `\n提前提醒：${leadMinutes(item).map(formatLead).join("、")}` : "";
  return [`已创建定时提醒：${shortID(item.id)}`, `时间：${when}${leads}`, `内容：${item.message}`].join("\n");
}

function formatReminderMessage(item, event = null) {
  const prefix = event && event.kind === "lead" ? `（还有 ${formatLead(event.lead_minutes)}）` : "";
  if (event && event.kind === "due" && item.schedule && item.schedule.type === "once") {
    return `${item.title || "定时提醒"}（到点）：${item.message}`;
  }
  if (prefix) {
    return `${item.title || "定时提醒"}${prefix}：${item.message}`;
  }
  return `${item.title || "定时提醒"}：${item.message}`;
}

function formatReminderSegments(item, event = null) {
  const text = formatReminderMessage(item, event);
  const segments = [{ type: "text", data: { text } }];
  const qq = item.notify && item.notify.mention_user ? String(item.notify.mention_user) : "";
  if (/^\d{5,12}$/.test(qq)) {
    return [{ type: "at", data: { qq } }, { type: "text", data: { text: ` ${text}` } }];
  }
  return segments;
}

function normalizeTime(time) {
  const match = String(time || "").match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function normalizeNotify(value) {
  const notify = value && typeof value === "object" ? { ...value } : {};
  notify.lead_minutes = leadMinutes({ notify });
  return notify;
}

function leadMinutes(item) {
  const values = item && item.notify && Array.isArray(item.notify.lead_minutes) ? item.notify.lead_minutes : [];
  return [...new Set(values.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 60 * 24 * 30))]
    .sort((a, b) => b - a);
}

function onceOccurrence(item, now) {
  const date = item.schedule && item.schedule.date;
  const time = item.schedule && item.schedule.time;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}$/.test(time || "")) {
    return null;
  }
  const dueAt = new Date(`${date}T${time}:00`);
  if (Number.isNaN(dueAt.getTime())) {
    return null;
  }
  const finalKey = `${date}:${time}:due`;
  if (now.getTime() > dueAt.getTime() + 24 * 60 * 60 * 1000 && hasSent(item, finalKey)) {
    return null;
  }
  return { date, time, dueAt, finalKey };
}

function dueReminderEvents(item, occurrence, now) {
  const events = [];
  const nowMs = now.getTime();
  const dueMs = occurrence.dueAt.getTime();
  if (nowMs < dueMs) {
    for (const lead of leadMinutes(item)) {
      const key = `${occurrence.date}:${occurrence.time}:lead:${lead}`;
      if (hasSent(item, key)) continue;
      if (nowMs >= dueMs - lead * 60 * 1000) {
        events.push({ kind: "lead", lead_minutes: lead, key });
      }
    }
    return events;
  }
  if (!hasSent(item, occurrence.finalKey)) {
    events.push({ kind: "due", key: occurrence.finalKey });
  }
  return events;
}

function hasSent(item, key) {
  return Array.isArray(item.sent_keys) && item.sent_keys.includes(key);
}

function markSent(item, key) {
  if (!Array.isArray(item.sent_keys)) {
    item.sent_keys = [];
  }
  if (!item.sent_keys.includes(key)) {
    item.sent_keys.push(key);
  }
}

function formatLead(minutes) {
  const n = Number(minutes);
  if (n % 1440 === 0) return `${n / 1440} 天`;
  if (n % 60 === 0) return `${n / 60} 小时`;
  return `${n} 分钟`;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function fieldIssue(value, field, message, missing, errors) {
  if (value === null || value === undefined || value === "") {
    missing.push(field);
  } else {
    errors.push({ field, message });
  }
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function weekdayName(day) {
  return ["日", "一", "二", "三", "四", "五", "六"][Number(day)] || "?";
}

function reminderID() {
  return `rem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function shortID(id) {
  return String(id || "").replace(/^rem_/, "").slice(-6) || "-";
}

function clean(text) {
  return String(text || "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

module.exports = {
  createReminderFromSpec,
  dueReminders,
  formatReminderCreated,
  formatReminderMessage,
  formatReminderSegments,
  loadReminders,
  reminderFile,
  saveReminders,
  validateReminderSpec,
};
