"use strict";

const fs = require("fs");
const path = require("path");

function courseFile(workspace) {
  return path.join(workspace, "memory", "course-schedules.json");
}

function loadCourseSchedules(workspace) {
  try {
    const data = JSON.parse(fs.readFileSync(courseFile(workspace), "utf8"));
    return Array.isArray(data.schedules) ? data.schedules : [];
  } catch {
    return [];
  }
}

function saveCourseSchedules(workspace, schedules) {
  fs.mkdirSync(path.dirname(courseFile(workspace)), { recursive: true });
  fs.writeFileSync(courseFile(workspace), `${JSON.stringify({ version: 1, schedules }, null, 2)}\n`, "utf8");
}

function validateCourseScheduleSpec(spec = {}) {
  const item = normalizeCourseScheduleSpec(spec);
  const missing = [];
  const errors = [];
  if (!item.owner_user_id) missing.push("owner_user_id");
  if (!Array.isArray(item.entries) || item.entries.length === 0) missing.push("entries");
  item.entries.forEach((entry, index) => {
    if (!entry.course) missing.push(`entries.${index}.course`);
    if (!Number.isInteger(entry.day_of_week) || entry.day_of_week < 0 || entry.day_of_week > 6) {
      fieldIssue(entry.day_of_week, `entries.${index}.day_of_week`, "星期必须是 0-6", missing, errors);
    }
    if (!/^\d{2}:\d{2}$/.test(entry.start_time || "")) {
      fieldIssue(entry.start_time, `entries.${index}.start_time`, "开始时间必须是 HH:MM", missing, errors);
    }
    if (entry.end_time && !/^\d{2}:\d{2}$/.test(entry.end_time)) {
      errors.push({ field: `entries.${index}.end_time`, message: "结束时间必须是 HH:MM" });
    }
  });
  return { ok: missing.length === 0 && errors.length === 0, missing: [...new Set(missing)], errors, schedule: item };
}

function createCourseScheduleFromSpec(workspace, spec = {}, options = {}) {
  const checked = validateCourseScheduleSpec({
    ...spec,
    scope: spec.scope || options.scope,
    scope_id: spec.scope_id || options.scopeID,
    owner_user_id: spec.owner_user_id || options.userID,
    created_by: spec.created_by || options.userID,
  });
  if (!checked.ok) {
    return { ok: false, reason: checked.missing.length ? "missing_fields" : "invalid", ...checked };
  }
  const schedules = loadCourseSchedules(workspace);
  const duplicate = findDuplicateSchedule(schedules, checked.schedule);
  if (duplicate) {
    return { ok: false, reason: "duplicate", duplicate, schedule: checked.schedule };
  }
  const item = {
    ...checked.schedule,
    id: checked.schedule.id || courseID(),
    created_at: checked.schedule.created_at || new Date().toISOString(),
    status: "active",
  };
  schedules.push(item);
  saveCourseSchedules(workspace, schedules);
  return { ok: true, item };
}

function dueCourseNotifications(workspace, now = new Date()) {
  const schedules = loadCourseSchedules(workspace);
  const due = [];
  let changed = false;
  const dateKey = localDateKey(now);
  const weekday = now.getDay();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  for (const schedule of schedules) {
    if (schedule.status === "deleted") continue;
    const todayEntries = (schedule.entries || [])
      .filter((entry) => entry.day_of_week === weekday)
      .sort((a, b) => minutesOfDay(a.start_time) - minutesOfDay(b.start_time));
    if (todayEntries.length === 0) continue;

    const morningKey = `${dateKey}:morning:${schedule.owner_user_id}`;
    if (schedule.morning_enabled && !hasSent(schedule, morningKey) && nowMinutes >= minutesOfDay(schedule.morning_time || "07:30")) {
      const event = { kind: "morning", key: morningKey, entries: todayEntries };
      due.push(notificationFromEvent(schedule, event));
      markSent(schedule, morningKey);
      changed = true;
    }

    for (const entry of todayEntries) {
      const lead = Number(entry.reminder_minutes_before || schedule.reminder_minutes_before || 20);
      const start = minutesOfDay(entry.start_time);
      const key = `${dateKey}:course:${entry.id || entryKey(entry)}:${lead}`;
      if (hasSent(schedule, key)) continue;
      if (nowMinutes >= start - lead && nowMinutes < start + 5) {
        const event = { kind: "course_lead", key, entry, lead_minutes: lead };
        due.push(notificationFromEvent(schedule, event));
        markSent(schedule, key);
        changed = true;
      }
    }
  }
  if (changed) saveCourseSchedules(workspace, schedules);
  return due;
}

function normalizeCourseScheduleSpec(spec = {}) {
  const entries = Array.isArray(spec.entries) ? spec.entries : [];
  return {
    version: 1,
    id: spec.id ? String(spec.id) : "",
    type: "course_schedule",
    status: spec.status || "active",
    scope: ["group", "private"].includes(spec.scope) ? spec.scope : "group",
    scope_id: String(spec.scope_id || ""),
    owner_user_id: String(spec.owner_user_id || spec.user_id || ""),
    created_by: String(spec.created_by || ""),
    title: clean(spec.title || "课程表"),
    morning_enabled: spec.morning_enabled !== false,
    morning_time: normalizeTime(spec.morning_time || "07:30"),
    reminder_minutes_before: boundedMinutes(spec.reminder_minutes_before, 20),
    entries: entries.map(normalizeCourseEntry).filter(Boolean).slice(0, 80),
    source_type: clean(spec.source_type || "text"),
    source_images: Array.isArray(spec.source_images) ? spec.source_images.map(clean).filter(Boolean).slice(0, 8) : [],
    source_text: cleanLong(spec.source_text || ""),
    ocr_status: clean(spec.ocr_status || ""),
    ocr_error: clean(spec.ocr_error || ""),
  };
}

function normalizeCourseEntry(entry = {}, index = 0) {
  const start = normalizeTime(entry.start_time || entry.time || "");
  const end = normalizeTime(entry.end_time || "");
  const course = clean(entry.course || entry.name || entry.title || "");
  if (!course && !start && entry.day_of_week === undefined) return null;
  return {
    id: entry.id ? String(entry.id) : `c${index}_${entryKey({ ...entry, start_time: start, course })}`,
    day_of_week: numberOrNull(entry.day_of_week),
    start_time: start,
    end_time: end,
    course,
    location: clean(entry.location || ""),
    teacher: clean(entry.teacher || ""),
    note: clean(entry.note || ""),
    reminder_minutes_before: boundedMinutes(entry.reminder_minutes_before, null),
  };
}

function findDuplicateSchedule(schedules, schedule) {
  const signature = scheduleSignature(schedule);
  return schedules.find((item) => item.status !== "deleted" && scheduleSignature(item) === signature) || null;
}

function scheduleSignature(schedule) {
  return [
    schedule.scope,
    schedule.scope_id,
    schedule.owner_user_id,
    (schedule.entries || []).map((entry) => [entry.day_of_week, entry.start_time, entry.end_time, entry.course, entry.location].join("@")).sort().join("|"),
  ].join("::");
}

function notificationFromEvent(schedule, event) {
  const text = event.kind === "morning"
    ? formatMorningText(schedule, event.entries)
    : formatCourseLeadText(schedule, event.entry, event.lead_minutes);
  return {
    schedule,
    event,
    text,
    message: formatCourseSegments(schedule, text),
  };
}

function formatMorningText(schedule, entries) {
  return [
    "今日课程：",
    ...entries.map((entry) => `- ${entry.start_time}${entry.end_time ? `-${entry.end_time}` : ""} ${entry.course}${entry.location ? ` @${entry.location}` : ""}`),
  ].join("\n");
}

function formatCourseLeadText(schedule, entry, leadMinutes) {
  return `课程提醒（还有 ${leadMinutes} 分钟）：${entry.start_time} ${entry.course}${entry.location ? ` @${entry.location}` : ""}`;
}

function formatCourseScheduleCreated(item) {
  const byDay = new Map();
  for (const entry of item.entries || []) {
    const key = weekdayName(entry.day_of_week);
    byDay.set(key, [...(byDay.get(key) || []), entry]);
  }
  const lines = [
    `已导入课程表：${shortID(item.id)}`,
    `对象：${item.owner_user_id}`,
    `每日推送：${item.morning_enabled ? item.morning_time : "关闭"}`,
    `课前提醒：${item.reminder_minutes_before} 分钟`,
  ];
  for (const [day, entries] of byDay.entries()) {
    lines.push(`${day}: ${entries.map((entry) => `${entry.start_time} ${entry.course}`).join("；")}`);
  }
  return lines.join("\n").slice(0, 1600);
}

function formatCourseSegments(schedule, text) {
  const qq = String(schedule.owner_user_id || "");
  if (/^\d{5,12}$/.test(qq)) {
    return [{ type: "at", data: { qq } }, { type: "text", data: { text: ` ${text}` } }];
  }
  return [{ type: "text", data: { text } }];
}

function hasSent(schedule, key) {
  return Array.isArray(schedule.sent_keys) && schedule.sent_keys.includes(key);
}

function markSent(schedule, key) {
  if (!Array.isArray(schedule.sent_keys)) schedule.sent_keys = [];
  if (!schedule.sent_keys.includes(key)) schedule.sent_keys.push(key);
}

function minutesOfDay(time) {
  const match = String(time || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return 24 * 60 + 1;
  return Number(match[1]) * 60 + Number(match[2]);
}

function normalizeTime(time) {
  const match = String(time || "").match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function boundedMinutes(value, fallback) {
  if (value === null && fallback === null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 24 * 60) return fallback;
  return n;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function fieldIssue(value, field, message, missing, errors) {
  if (value === null || value === undefined || value === "") missing.push(field);
  else errors.push({ field, message });
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function weekdayName(day) {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][Number(day)] || "未知";
}

function entryKey(entry) {
  return clean([entry.day_of_week, entry.start_time, entry.course, entry.location].join("_")).replace(/\W+/g, "_").slice(0, 40) || "course";
}

function courseID() {
  return `course_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function shortID(id) {
  return String(id || "").replace(/^course_/, "").slice(-6) || "-";
}

function clean(text) {
  return String(text || "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function cleanLong(text) {
  return String(text || "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
}

module.exports = {
  courseFile,
  createCourseScheduleFromSpec,
  dueCourseNotifications,
  formatCourseScheduleCreated,
  loadCourseSchedules,
  saveCourseSchedules,
  validateCourseScheduleSpec,
};
