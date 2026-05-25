"use strict";

const { spawnSync } = require("child_process");

const WEEKDAY = new Map([
  ["日", 0], ["天", 0], ["0", 0], ["7", 0],
  ["一", 1], ["1", 1],
  ["二", 2], ["2", 2],
  ["三", 3], ["3", 3],
  ["四", 4], ["4", 4],
  ["五", 5], ["5", 5],
  ["六", 6], ["6", 6],
]);

const TASK_SCHEMAS = {
  weekly_rota: {
    required: ["task_type", "day_of_week", "time", "tasks", "current_assignments"],
    fields: {
      task_type: { type: "string", enum: ["weekly_rota"] },
      day_of_week: { type: "number", min: 0, max: 6 },
      time: { type: "string", pattern: /^([01]\d|2[0-3]):[0-5]\d$/ },
      tasks: { type: "array", minItems: 2 },
      current_assignments: { type: "object", minKeys: 2 },
      "rotation.direction": { type: "string", enum: ["next_task", "previous_task"], optional: true },
      "rotation.shift_per_run": { type: "number", min: 1, optional: true },
      "notify.mention_assignees": { type: "boolean", optional: true },
    },
  },
  scheduled_reminder: {
    required: ["task_type", "schedule.type", "schedule.time", "message"],
    fields: {
      task_type: { type: "string", enum: ["scheduled_reminder"] },
      "schedule.type": { type: "string", enum: ["daily", "weekly", "once"] },
      "schedule.time": { type: "string", pattern: /^([01]\d|2[0-3]):[0-5]\d$/ },
      "schedule.day_of_week": { type: "number", min: 0, max: 6, optional: true, nullable: true },
      "schedule.timezone": { type: "string", optional: true },
      message: { type: "string" },
      "notify.mention_user": { type: "string", pattern: /^\d+$/, optional: true, nullable: true },
    },
  },
  file_modify_and_return: {
    required: ["task_type", "source_file", "instructions", "output_path", "checks"],
    fields: {
      task_type: { type: "string", enum: ["file_modify_and_return"] },
      source_file: { type: "string" },
      instructions: { type: "string" },
      output_path: { type: "string" },
      checks: { type: "array" },
    },
  },
  script_create_and_run: {
    required: ["task_type", "title", "description", "language", "output_path", "run_after_create", "checks"],
    fields: {
      task_type: { type: "string", enum: ["script_create_and_run"] },
      title: { type: "string" },
      description: { type: "string" },
      language: { type: "string", enum: ["python", "powershell", "javascript", "bash"] },
      output_path: { type: "string" },
      run_after_create: { type: "boolean" },
      checks: { type: "array" },
    },
  },
  deploy_or_restart: {
    required: ["task_type", "action", "target", "reason", "requires_confirmation"],
    fields: {
      task_type: { type: "string", enum: ["deploy_or_restart"] },
      action: { type: "string", enum: ["deploy", "restart", "reload"] },
      target: { type: "string" },
      reason: { type: "string" },
      requires_confirmation: { type: "boolean" },
    },
  },
};

function parseTaskWithModel(message, taskType, options = {}) {
  if (typeof options.modelParser === "function") {
    const request = buildTaskParseRequest(message, taskType, options);
    return normalizeModelResult(options.modelParser(request), taskType);
  }
  const fixture = options.fixtures && options.fixtures[taskType];
  if (fixture) {
    return normalizeModelResult(fixture, taskType);
  }
  const commandParser = parseTaskWithCommand(message, taskType, options);
  if (commandParser) {
    return commandParser;
  }
  if (taskType === "weekly_rota") {
    return normalizeModelResult(parseWeeklyRotaHeuristic(message, options), taskType);
  }
  if (taskType === "scheduled_reminder") {
    return normalizeModelResult(parseScheduledReminderHeuristic(message, options), taskType);
  }
  if (taskType === "file_modify_and_return") {
    return normalizeModelResult(parseFileModifyHeuristic(message), taskType);
  }
  if (taskType === "script_create_and_run") {
    return normalizeModelResult(parseScriptCreateHeuristic(message), taskType);
  }
  if (taskType === "deploy_or_restart") {
    return normalizeModelResult(parseDeployHeuristic(message), taskType);
  }
  return { ok: false, error: "unsupported_task_type", task_type: taskType };
}

function parseTaskWithCommand(message, taskType, options = {}) {
  const command = normalizeCommand(options.modelParserCommand || process.env.QQ_TASK_MODEL_PARSER_COMMAND || "");
  if (!command) {
    return null;
  }
  const request = buildTaskParseRequest(message, taskType, options);
  const result = spawnSync(command.file, command.args, {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    timeout: Math.max(1000, Number(options.modelParserTimeoutMs || process.env.QQ_TASK_MODEL_PARSER_TIMEOUT_MS || 8000) || 8000),
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    return { ok: false, error: result.error.code === "ETIMEDOUT" ? "model_timeout" : "model_command_failed", task_type: taskType, detail: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, error: "model_command_failed", task_type: taskType, detail: clean(result.stderr || result.stdout || `exit ${result.status}`) };
  }
  return normalizeModelResult(result.stdout, taskType);
}

function normalizeCommand(value) {
  if (Array.isArray(value) && value.length > 0) {
    return { file: String(value[0]), args: value.slice(1).map(String) };
  }
  if (value && typeof value === "object" && value.file) {
    return { file: String(value.file), args: Array.isArray(value.args) ? value.args.map(String) : [] };
  }
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return normalizeCommand(parsed);
  } catch {
    return { file: text, args: [] };
  }
}

function buildTaskParseRequest(message, taskType, options = {}) {
  const schema = TASK_SCHEMAS[taskType] || null;
  const context = compactContext({
    scope: options.scope,
    scopeID: options.scopeID,
    groupID: options.groupID,
    userID: options.userID,
    timezone: options.timezone || "Asia/Shanghai",
    today: options.today || options.startDate,
  });
  return {
    version: 1,
    role: "task_structure_parser",
    task_type: taskType,
    message: String(message || ""),
    context,
    schema: schema ? schemaForPrompt(schema) : null,
    prompt: buildTaskParsePrompt({ message, taskType, schema, context }),
  };
}

function buildTaskParsePrompt({ message, taskType, schema, context = {} }) {
  return [
    "你是一个 QQ bot 自然语言任务结构化解析器。",
    "只把用户目标解析成 JSON，不要解释、不要执行、不要写代码。",
    "缺失字段用 null，不要猜测；QQ 号必须保留为纯数字字符串；时间使用 HH:MM；星期用 0-6（0=周日）。",
    `任务类型：${taskType}`,
    `上下文：${JSON.stringify(context)}`,
    "schema：",
    JSON.stringify(schemaForPrompt(schema), null, 2),
    "用户消息：",
    "---",
    String(message || ""),
    "---",
    "只输出一个 JSON object。"
  ].join("\n");
}

function schemaForPrompt(schema) {
  if (!schema) return null;
  const fields = {};
  for (const [field, rules] of Object.entries(schema.fields || {})) {
    fields[field] = {
      type: rules.type,
      required: (schema.required || []).includes(field),
    };
    if (Array.isArray(rules.enum)) fields[field].enum = rules.enum;
    if (rules.pattern) fields[field].pattern = String(rules.pattern).replace(/^\/|\/[a-z]*$/gi, "");
    if (rules.min !== undefined) fields[field].min = rules.min;
    if (rules.max !== undefined) fields[field].max = rules.max;
    if (rules.minItems !== undefined) fields[field].minItems = rules.minItems;
    if (rules.minKeys !== undefined) fields[field].minKeys = rules.minKeys;
    if (rules.optional) fields[field].optional = true;
    if (rules.nullable) fields[field].nullable = true;
  }
  return {
    required: schema.required || [],
    fields,
  };
}

function compactContext(context) {
  const out = {};
  for (const [key, value] of Object.entries(context || {})) {
    if (value !== undefined && value !== null && value !== "") {
      out[key] = String(value);
    }
  }
  return out;
}

function normalizeModelResult(value, taskType) {
  let spec = unwrapModelPayload(value);
  if (typeof value === "string") {
    spec = parseJSONPayload(value);
    if (!spec) {
      return { ok: false, error: "parse_failed", task_type: taskType };
    }
  }
  if (spec && typeof spec === "object" && spec.ok === true && spec.spec && typeof spec.spec === "object") {
    spec = spec.spec;
  }
  if (!spec || typeof spec !== "object") {
    return { ok: false, error: "parse_failed", task_type: taskType };
  }
  const normalized = { ...spec, task_type: spec.task_type || taskType };
  const checked = validateTaskSpec(normalized, taskType);
  if (checked.errors.length > 0) {
    return {
      ok: false,
      error: "schema_invalid",
      task_type: taskType,
      spec: normalized,
      missing: checked.missing,
      errors: checked.errors,
    };
  }
  return { ok: true, spec: normalized, missing: checked.missing };
}

function unwrapModelPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  if (typeof value.content === "string") return parseJSONPayload(value.content) || value.content;
  if (typeof value.text === "string") return parseJSONPayload(value.text) || value.text;
  if (typeof value.output_text === "string") return parseJSONPayload(value.output_text) || value.output_text;
  return value;
}

function parseJSONPayload(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [
    text,
    fenced && fenced[1],
    extractJSONObject(text),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function extractJSONObject(text) {
  const value = String(text || "");
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end > start ? value.slice(start, end + 1) : "";
}

function validateTaskSpec(spec, taskType) {
  const schema = TASK_SCHEMAS[taskType];
  if (!schema || !spec || typeof spec !== "object") {
    return {
      ok: false,
      missing: [],
      errors: [{ field: "task_type", message: "unsupported_task_type" }],
    };
  }
  const missing = [];
  const errors = [];
  for (const field of schema.required || []) {
    if (isMissing(getPath(spec, field))) {
      missing.push(field);
    }
  }
  for (const [field, rules] of Object.entries(schema.fields || {})) {
    const value = getPath(spec, field);
    if ((rules.optional || rules.nullable) && (value === undefined || value === null || value === "")) {
      continue;
    }
    if (isMissing(value)) {
      continue;
    }
    const typeError = validateType(value, rules);
    if (typeError) {
      errors.push({ field, message: typeError });
      continue;
    }
    if (Array.isArray(rules.enum) && !rules.enum.includes(value)) {
      errors.push({ field, message: `expected_one_of:${rules.enum.join("|")}` });
    }
    if (rules.pattern && typeof value === "string" && !rules.pattern.test(value)) {
      errors.push({ field, message: "pattern_mismatch" });
    }
    if (typeof rules.min === "number" && typeof value === "number" && value < rules.min) {
      errors.push({ field, message: `min:${rules.min}` });
    }
    if (typeof rules.max === "number" && typeof value === "number" && value > rules.max) {
      errors.push({ field, message: `max:${rules.max}` });
    }
    if (typeof rules.minItems === "number" && Array.isArray(value) && value.length < rules.minItems) {
      if ((schema.required || []).includes(field)) pushUnique(missing, field);
      else errors.push({ field, message: `min_items:${rules.minItems}` });
    }
    if (typeof rules.minKeys === "number" && isPlainObject(value) && Object.keys(value).length < rules.minKeys) {
      if ((schema.required || []).includes(field)) pushUnique(missing, field);
      else errors.push({ field, message: `min_keys:${rules.minKeys}` });
    }
  }
  return {
    ok: missing.length === 0 && errors.length === 0,
    missing: [...new Set(missing)],
    errors,
  };
}

function validateType(value, rules) {
  if (!rules || !rules.type) return "";
  if (rules.type === "array") return Array.isArray(value) ? "" : "expected_array";
  if (rules.type === "object") return isPlainObject(value) ? "" : "expected_object";
  if (rules.type === "number") return typeof value === "number" && Number.isFinite(value) ? "" : "expected_number";
  if (rules.type === "boolean") return typeof value === "boolean" ? "" : "expected_boolean";
  if (rules.type === "string") return typeof value === "string" ? "" : "expected_string";
  return "";
}

function getPath(obj, dotted) {
  return String(dotted || "").split(".").reduce((current, part) => current && typeof current === "object" ? current[part] : undefined, obj);
}

function isMissing(value) {
  return value === null
    || value === undefined
    || value === ""
    || (Array.isArray(value) && value.length === 0)
    || (isPlainObject(value) && Object.keys(value).length === 0);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function parseWeeklyRotaHeuristic(message, options = {}) {
  const text = stripAt(String(message || ""));
  const orderedTasks = parseOrderedTasks(text);
  const assignments = parseCurrentAssignments(text, orderedTasks);
  const tasks = orderedTasks.length ? orderedTasks : parseAssignmentTaskOrder(text);
  return {
    task_type: "weekly_rota",
    title: text.includes("值日") ? "值日提醒" : "轮值提醒",
    day_of_week: parseWeekday(text),
    time: parseTime(text) || null,
    timezone: "Asia/Shanghai",
    tasks,
    current_assignments: assignments,
    rotation: {
      direction: "next_task",
      shift_per_run: /下一个|往下|顺到|轮换|同理/.test(text) ? 1 : 1,
    },
    notify: {
      mention_assignees: /@|艾特|对应人/.test(text),
    },
    group_id: options.groupID !== undefined ? String(options.groupID) : undefined,
    created_by: options.userID !== undefined ? String(options.userID) : undefined,
    start_date: options.startDate,
    source_text: text,
  };
}

function parseScheduledReminderHeuristic(message, options = {}) {
  const text = stripAt(String(message || ""));
  const weeklyDay = parseWeekday(text);
  const scheduleType = weeklyDay === null && /每天|每日|每晚|天天/u.test(text) ? "daily" : (weeklyDay !== null ? "weekly" : "daily");
  const reminderMessage = cleanReminderMessage(text);
  return {
    task_type: "scheduled_reminder",
    title: titleFromReminder(reminderMessage),
    schedule: {
      type: scheduleType,
      time: parseTime(text) || null,
      timezone: "Asia/Shanghai",
      day_of_week: weeklyDay,
    },
    message: reminderMessage,
    notify: {
      mention_user: options.userID !== undefined ? String(options.userID) : null,
    },
    source_text: text,
  };
}

function cleanReminderMessage(text) {
  const cleaned = String(text || "")
    .replace(/^(?:请|麻烦)?(?:每天|每日|每晚|天天|每周[日天一二三四五六0-7]?|周[日天一二三四五六0-7]|星期[日天一二三四五六0-7])?/u, "")
    .replace(/(?:上午|早上|中午|下午|晚上|晚)?\s*\d{1,2}(?::|：|点半|点)\s*\d{0,2}\s*分?/gu, "")
    .replace(/^(?:提醒我|提醒|叫我|通知我|通知|记得|别忘了?|要我)\s*/u, "")
    .replace(/^(?:我)?(?:检查|查看|处理|做)?\s*/u, "")
    .replace(/[，,。；;：: ]+$/u, "")
    .trim();
  return cleaned || "提醒";
}

function titleFromReminder(message) {
  const short = clean(message).slice(0, 24);
  return short ? `${short}提醒` : "定时提醒";
}

function parseFileModifyHeuristic(message) {
  const text = stripAt(String(message || ""));
  const source = firstPathLike(text) || null;
  return {
    task_type: "file_modify_and_return",
    source_file: source,
    instructions: text,
    output_path: source ? `local_files/modified/${source.split(/[\\/]/).pop().replace(/(\.[^.]+)?$/, "-modified$1")}` : null,
    checks: ["syntax"],
  };
}

function parseScriptCreateHeuristic(message) {
  const text = stripAt(String(message || ""));
  const language = /powershell|ps1/i.test(text) ? "powershell" : (/python|py/i.test(text) ? "python" : null);
  return {
    task_type: "script_create_and_run",
    title: clean(text).slice(0, 40) || null,
    description: clean(text) || null,
    language,
    output_path: language === "powershell" ? "local_files/generated/generated-task.ps1" : (language === "python" ? "local_files/generated/generated-task.py" : null),
    run_after_create: /运行|执行|跑一下|run/i.test(text),
    checks: ["syntax", "dry_run"],
  };
}

function parseDeployHeuristic(message) {
  const text = stripAt(String(message || ""));
  return {
    task_type: "deploy_or_restart",
    action: /重启|restart|reload/i.test(text) ? "restart" : "deploy",
    target: /qq|bot|代理/i.test(text) ? "qq-bot" : null,
    reason: clean(text) || null,
    requires_confirmation: true,
  };
}

function firstPathLike(text) {
  const match = String(text || "").match(/(?:[A-Za-z]:\\[^\s"'<>]+|(?:received_files|local_files|\.\/|\.\\)[^\s"'<>]+)/);
  return match ? match[0] : "";
}

function parseOrderedTasks(text) {
  const match = text.match(/(?:整体)?(?:的)?(?:值日|轮值)?顺序\s*(?:是|为)?\s*[:：]?\s*([^。；;\n]+)/u);
  if (!match) return [];
  return splitList(match[1].replace(/本周.*$/u, "").replace(/这周.*$/u, ""));
}

function parseCurrentAssignments(text, tasks) {
  const result = {};
  if (tasks.length) {
    const taskPattern = tasks.map(escapeRegExp).join("|");
    const memberTask = new RegExp(`(\\d{5,12})\\s*(?:=|：|:)?\\s*(?:负责|做|干|值日)?\\s*(${taskPattern})`, "gu");
    let match;
    while ((match = memberTask.exec(text)) !== null) {
      result[match[1]] = match[2];
    }
    const taskMember = new RegExp(`(${taskPattern})\\s*(?:=|：|:)?\\s*(\\d{5,12})`, "gu");
    while ((match = taskMember.exec(text)) !== null) {
      result[match[2]] = match[1];
    }
  }
  const generic = /(\d{5,12})\s*(?:=|：|:)?\s*(?:负责|做|干|值日)?\s*([\p{L}_-][\p{L}\p{N}_-]{0,19})/gu;
  let match;
  while ((match = generic.exec(text)) !== null) {
    const member = clean(match[1]);
    const task = clean(match[2]);
    if (member && task && !/^(每周|本周|这周|今天|现在|当前)$/.test(task)) {
      result[member] = task;
    }
  }
  return result;
}

function parseAssignmentTaskOrder(text) {
  const tasks = [];
  const seen = new Set();
  const generic = /(\d{5,12})\s*(?:=|：|:)?\s*(?:负责|做|干|值日)?\s*([\p{L}_-][\p{L}\p{N}_-]{0,19})/gu;
  let match;
  while ((match = generic.exec(text)) !== null) {
    const task = clean(match[2]);
    if (!task || /^(每周|本周|这周|今天|现在|当前)$/.test(task) || seen.has(task)) continue;
    seen.add(task);
    tasks.push(task);
  }
  return tasks.slice(0, 20);
}

function parseWeekday(text) {
  const match = text.match(/(?:每周|每星期|周|星期)([日天一二三四五六0-7])/u);
  return match && WEEKDAY.has(match[1]) ? WEEKDAY.get(match[1]) : null;
}

function parseTime(text) {
  const re = /(上午|早上|中午|下午|晚上|晚)?\s*(\d{1,2})\s*(?::|：|点半|点)\s*(\d{1,2})?\s*分?/gu;
  for (const match of text.matchAll(re)) {
    let hour = Number(match[2]);
    const minute = match[0].includes("点半") ? 30 : Number(match[3] || 0);
    const period = match[1] || "";
    if ((period.includes("下午") || period.includes("晚上") || period === "晚") && hour < 12) hour += 12;
    if (period.includes("中午") && hour < 11) hour += 12;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
  }
  return "";
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

function stripAt(text) {
  return text
    .replace(/\[CQ:at,[^\]]+\]/g, " ")
    .replace(/@\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(text) {
  return String(text || "")
    .replace(/^[：:]+/u, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  TASK_SCHEMAS,
  buildTaskParsePrompt,
  buildTaskParseRequest,
  normalizeModelResult,
  parseTaskWithModel,
  parseTaskWithCommand,
  parseWeeklyRotaHeuristic,
  schemaForPrompt,
  validateTaskSpec,
};

if (require.main === module) {
  const taskType = process.argv[2] || "weekly_rota";
  const message = process.argv.slice(3).join(" ");
  process.stdout.write(`${JSON.stringify(parseTaskWithModel(message, taskType), null, 2)}\n`);
}
