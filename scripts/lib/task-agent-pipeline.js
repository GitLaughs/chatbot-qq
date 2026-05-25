"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseTaskWithModel } = require("../task-agent");
const { createReminderFromSpec, formatReminderCreated, validateReminderSpec } = require("./reminder-scheduler");
const { prepareFileModifyTask } = require("./file-task-prep");
const { prepareScriptCreateTask } = require("./script-task-prep");
const { runScriptTaskChecks } = require("./script-task-checker");
const { createRotaFromText, formatRotaFallbackFailure } = require("./rota-task-fallback");
const { classifyTask } = require("./task-intent-router");
const { createTaskRequest, updateTaskRequest, writeTaskReceipt } = require("./task-request-store");

const EXECUTORS = {
  deploy_or_restart: executeDeployOrRestart,
  weekly_rota: executeWeeklyRota,
  scheduled_reminder: executeScheduledReminder,
};

function executeNaturalTask({ text, msg, workspace, context = {}, options = {} }) {
  const route = classifyTask(text, options);
  if (route.kind !== "task" || route.confidence < Number(options.minConfidence || 0.6)) {
    return { handled: false, route };
  }
  const executor = executorForTask(route.task_type, options);
  let parsed = parseTaskWithModel(text, route.task_type, {
    ...context,
    modelParser: options.modelParser,
    modelParserCommand: options.modelParserCommand,
    modelParserTimeoutMs: options.modelParserTimeoutMs,
    fixtures: options.fixtures,
    timezone: options.timezone,
    today: options.today,
    startDate: options.startDate,
  });
  parsed = prepareParsedTask({ parsed, route, workspace, text });
  const taskRequest = createTaskRequest({
    workspace,
    scope: context.scope,
    scopeID: context.scopeID,
    userID: context.userID,
    messageID: msg && msg.message_id,
    taskType: route.task_type,
    confidence: route.confidence,
    text,
    spec: parsed.ok ? parsed.spec : null,
    status: hasMissingFields(parsed) ? "awaiting_input" : (executor ? "running" : "delegated"),
  });
  if (hasMissingFields(parsed)) {
    const question = missingFieldQuestion(route.task_type, parsed.missing);
    writeTaskReceipt({
      workspace,
      id: taskRequest && taskRequest.id,
      receipt: {
        status: "awaiting_input",
        result: {
          ok: false,
          reason: "missing_fields",
          missing: parsed.missing,
        },
        artifacts: [],
        checks: [{ name: "required_fields", status: "waiting" }],
      },
    });
    updateTaskRequest({
      workspace,
      id: taskRequest && taskRequest.id,
      status: "awaiting_input",
      result: { ok: false, reason: "missing_fields", missing: parsed.missing },
      spec: parsed.spec,
    });
    return {
      handled: true,
      ok: false,
      route,
      parsed,
      task_request: taskRequest,
      reason: "missing_fields",
      reply: question,
    };
  }
  if (!executor) {
    updateTaskRequest({
      workspace,
      id: taskRequest && taskRequest.id,
      status: "delegated",
      result: { ok: false, reason: "executor_not_available" },
      spec: parsed.ok ? parsed.spec : null,
    });
    return {
      handled: false,
      ok: false,
      route,
      parsed,
      task_request: taskRequest,
      delegate_to_agent: true,
      reason: "executor_not_available",
    };
  }
  if (!parsed.ok) {
    const receipt = {
      status: "failed",
      result: { reason: parsed.error || "parse_failed" },
      artifacts: [],
      checks: [{ name: "parse", status: "failed" }],
    };
    writeTaskReceipt({ workspace, id: taskRequest && taskRequest.id, receipt });
    updateTaskRequest({
      workspace,
      id: taskRequest && taskRequest.id,
      status: "failed",
      error: parsed.error || "parse_failed",
    });
    return {
      handled: true,
      ok: false,
      route,
      task_request: taskRequest,
      reason: parsed.error || "parse_failed",
      reply: "任务解析失败，请补充更明确的目标、时间、对象或文件路径。",
    };
  }
  try {
    const result = withTaskReplyMetadata(executor({ text, msg, workspace, context, route, parsed, options }), taskRequest);
    const finalResult = attachTaskArtifactOutbox({ workspace, taskRequest, result, options });
    writeTaskReceipt({
      workspace,
      id: taskRequest && taskRequest.id,
      receipt: receiptFromResult(finalResult),
    });
    updateTaskRequest({
      workspace,
      id: taskRequest && taskRequest.id,
      status: finalResult && finalResult.status ? finalResult.status : (finalResult && finalResult.ok ? "done" : "failed"),
      result: summarizeTaskResult(finalResult),
      error: finalResult && finalResult.ok ? "" : (finalResult && (finalResult.reason || finalResult.reply)) || "execution_failed",
      spec: parsed.ok ? parsed.spec : null,
    });
    return { ...finalResult, task_request: taskRequest };
  } catch (err) {
    writeTaskReceipt({
      workspace,
      id: taskRequest && taskRequest.id,
      receipt: {
        status: "failed",
        result: { reason: err && err.message || "execution_exception" },
        artifacts: [],
        checks: [{ name: "execute", status: "failed" }],
      },
    });
    updateTaskRequest({
      workspace,
      id: taskRequest && taskRequest.id,
      status: "failed",
      error: err && err.message || "execution_exception",
    });
    throw err;
  }
}

function hasMissingFields(parsed) {
  return Boolean(parsed && parsed.ok && Array.isArray(parsed.missing) && parsed.missing.length > 0);
}

function missingFieldQuestion(taskType, missing = []) {
  const first = String((missing || [])[0] || "");
  if (taskType === "file_modify_and_return") {
    if (first === "source_file") return "我已经识别到这是文件修改任务，但还缺源文件。请上传文件，或直接发当前 workspace 下的 local_files/ 或 received_files/ 路径。";
    if (first === "instructions") return "我已经识别到这是文件修改任务，但还缺修改要求。你想怎么改？";
    if (first === "output_path") return "我已经识别到这是文件修改任务，但还缺输出位置。默认要保存到 local_files/modified/ 下，可以确认吗？";
  }
  if (taskType === "script_create_and_run") {
    if (first === "language") return "我已经识别到这是创建脚本任务，但还缺脚本语言。要用 Python、PowerShell、JavaScript 还是 Bash？";
    if (first === "description") return "我已经识别到这是创建脚本任务，但还缺脚本要完成的具体目标。你要它做什么？";
    if (first === "output_path") return "我已经识别到这是创建脚本任务，但还缺输出位置。默认保存到 local_files/generated/ 下，可以确认吗？";
  }
  if (taskType === "scheduled_reminder") {
    if (/time/.test(first)) return "我已经识别到这是定时提醒任务，但还缺提醒时间。你要几点提醒？";
    if (/message/.test(first)) return "我已经识别到这是定时提醒任务，但还缺提醒内容。要提醒什么？";
  }
  if (taskType === "deploy_or_restart") {
    if (first === "target") return "我已经识别到这是部署/重启任务，但还缺目标服务。是 qq-bot 还是别的目标？";
  }
  return `我已经识别到这是 ${taskType || "任务"}，但还缺 ${first || "必要字段"}。请补充这一项。`;
}

function prepareParsedTask({ parsed, route, workspace, text }) {
  if (!parsed || !parsed.ok || !parsed.spec || !route) {
    return parsed;
  }
  if (route.task_type === "scheduled_reminder") {
    const checked = validateReminderSpec(parsed.spec);
    return {
      ...parsed,
      missing: checked.ok ? [] : checked.missing,
    };
  }
  if (route.task_type === "script_create_and_run") {
    const prepared = prepareScriptCreateTask({ spec: parsed.spec, text });
    return {
      ...parsed,
      spec: prepared.spec,
      missing: prepared.ok ? [] : prepared.errors.map((item) => item.field),
      prepared,
    };
  }
  if (route.task_type !== "file_modify_and_return") {
    return parsed;
  }
  const prepared = prepareFileModifyTask({ workspace, spec: parsed.spec, text });
  return {
    ...parsed,
    spec: prepared.spec,
    missing: prepared.ok ? [] : prepared.errors.map((item) => item.field),
    prepared,
  };
}

function withTaskReplyMetadata(result, taskRequest) {
  if (!result || !taskRequest || !taskRequest.id || result.task_id) {
    return result;
  }
  const next = { ...result, task_id: taskRequest.id };
  if (result.status === "awaiting_confirmation" && result.reply && !String(result.reply).includes(taskRequest.id)) {
    next.reply = String(result.reply).replace(/task_id/g, taskRequest.id);
  }
  return next;
}

function receiptFromResult(result) {
  const ok = Boolean(result && result.ok);
  const itemID = result && result.item && result.item.id || "";
  const status = result && result.status ? result.status : (ok ? "done" : "failed");
  const artifacts = Array.isArray(result && result.artifacts) ? result.artifacts : (itemID ? [{ type: "record", id: itemID }] : []);
  const checks = Array.isArray(result && result.checks) && result.checks.length
    ? result.checks
    : [{ name: status === "awaiting_confirmation" ? "confirmation_gate" : "execute", status: ok ? "passed" : "failed" }];
  return {
    status,
    result: {
      ok,
      task_type: result && result.task_type || "",
      reason: result && result.reason || "",
      item_id: itemID,
    },
    artifacts,
    checks,
  };
}

function summarizeTaskResult(result) {
  if (!result || typeof result !== "object") return null;
  return {
    ok: Boolean(result.ok),
    task_type: result.task_type || "",
    reason: result.reason || "",
    item_id: result.item && result.item.id || "",
  };
}

function attachTaskArtifactOutbox({ workspace, taskRequest, result, options = {} }) {
  if (!result || !result.ok || !taskRequest || !["file_modify_and_return", "script_create_and_run"].includes(String(taskRequest.task_type || ""))) {
    return result;
  }
  const runtimeDir = options.runtimeDir || process.env.ONEBOT_RUNTIME_DIR || "";
  if (!runtimeDir) {
    return result;
  }
  const outbox = enqueueExecutionArtifactUploads({ workspace, task: taskRequest, artifacts: result.artifacts || [], runtimeDir });
  if (!outbox || !outbox.check) {
    return result;
  }
  return {
    ...result,
    checks: [
      ...(Array.isArray(result.checks) ? result.checks : []),
      outbox.check,
    ],
  };
}

function enqueueExecutionArtifactUploads({ workspace, task, artifacts = [], runtimeDir }) {
  const rows = executionArtifactOutboxRows({ workspace, task, artifacts });
  if (rows.length === 0) {
    return null;
  }
  const scope = String(task.scope || "") === "group" ? "group" : "private";
  const dirName = scope === "group" ? "group-file-outbox" : "private-file-outbox";
  const dir = path.join(runtimeDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeName(task.id)}.json`);
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    source: "task_execution",
    task_id: task.id,
    task_type: task.task_type,
    created_at: new Date().toISOString(),
    files: rows,
  }, null, 2)}\n`, "utf8");
  return {
    path: file,
    rows,
    check: { name: "file_outbox", status: "queued", detail: path.relative(runtimeDir, file).replace(/\\/g, "/") },
  };
}

function executionArtifactOutboxRows({ workspace, task, artifacts = [] }) {
  const rows = [];
  const scope = String(task.scope || "") === "group" ? "group" : "private";
  for (const artifact of artifacts || []) {
    const relative = String(artifact || "").replace(/\\/g, "/");
    if (!relative.startsWith("local_files/")) {
      continue;
    }
    const resolved = path.resolve(workspace, relative.replace(/[\\/]/g, path.sep));
    if (!isPathInside(resolved, path.resolve(workspace, "local_files")) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      continue;
    }
    const row = {
      type: scope,
      path: path.relative(workspace, resolved).replace(/\\/g, "/"),
      name: path.basename(resolved),
      task_id: task.id,
      task_type: task.task_type,
    };
    if (scope === "group") {
      row.group_id = String(task.scope_id || "");
    } else {
      row.user_id = String(task.user_id || task.scope_id || "");
    }
    rows.push(row);
  }
  return rows;
}

function executeWeeklyRota({ text, workspace, context }) {
  if (context.scope !== "group") {
    return {
      handled: true,
      ok: false,
      reason: "scope_not_supported",
      reply: "群轮值提醒只对群聊生效。",
    };
  }
  const result = createRotaFromText(workspace, text, {
    groupID: context.groupID,
    userID: context.userID,
    commandIntent: true,
  });
  if (result.ok) {
    return {
      handled: true,
      ok: true,
      task_type: "weekly_rota",
      item: result.item,
      reply: require("./rota-scheduler").formatRotaCreated(result.item),
    };
  }
  return {
    handled: true,
    ok: false,
    task_type: "weekly_rota",
    reason: result.reason,
    parsed: result,
    reply: formatRotaFallbackFailure(result, "我看到了轮值提醒任务，但还需要更完整的星期、时间、成员和任务。"),
  };
}

function executeScheduledReminder({ text, workspace, context, parsed }) {
  const created = createReminderFromSpec(workspace, {
    ...parsed.spec,
    source_text: text,
  }, {
    scope: context.scope,
    scopeID: context.scopeID,
    userID: context.userID,
  });
  if (created.ok) {
    return {
      handled: true,
      ok: true,
      task_type: "scheduled_reminder",
      item: created.item,
      reply: formatReminderCreated(created.item),
    };
  }
  if (created.reason === "duplicate") {
    return {
      handled: true,
      ok: false,
      task_type: "scheduled_reminder",
      reason: "duplicate",
      reply: "已有相同时间和内容的定时提醒，暂不重复创建。",
    };
  }
  const first = (created.errors || [])[0];
  return {
    handled: true,
    ok: false,
    task_type: "scheduled_reminder",
    reason: created.reason || "invalid",
    reply: first ? `任务解析到了，但字段不合法：${first.field} ${first.message}` : "任务解析到了，但缺少必要字段。",
  };
}

function executeDeployOrRestart({ parsed, route }) {
  const spec = parsed && parsed.spec ? parsed.spec : {};
  return {
    handled: true,
    ok: true,
    status: "awaiting_confirmation",
    task_type: "deploy_or_restart",
    reason: "requires_admin_confirmation",
    reply: [
      "已识别为部署/重启任务，已进入确认门控，尚未执行。",
      `动作：${spec.action || "deploy"}`,
      `目标：${spec.target || "qq-bot"}`,
      `原因：${spec.reason || "未填写"}`,
      "确认执行：/任务 确认 task_id",
      "取消：/任务 取消 task_id",
    ].join("\n"),
    route,
  };
}

function executorForTask(taskType, options = {}) {
  if (taskType === "file_modify_and_return" && fileModifierCommand(options)) {
    return executeFileModifyAndReturn;
  }
  if (taskType === "script_create_and_run" && scriptGeneratorCommand(options)) {
    return executeScriptCreateAndRun;
  }
  return EXECUTORS[taskType] || null;
}

function executeFileModifyAndReturn({ workspace, parsed, options }) {
  const spec = parsed && parsed.spec ? parsed.spec : {};
  const command = fileModifierCommand(options);
  if (!command) {
    return {
      handled: false,
      ok: false,
      delegate_to_agent: true,
      task_type: "file_modify_and_return",
      reason: "file_modifier_not_configured",
    };
  }
  const sourcePath = resolveWorkspacePath(workspace, spec.source_file || "");
  const outputPath = resolveWorkspacePath(workspace, spec.output_path || "");
  const modifiedRoot = path.resolve(workspace, "local_files", "modified");
  if (!sourcePath || !outputPath || !isPathInside(outputPath, modifiedRoot)) {
    return {
      handled: true,
      ok: false,
      task_type: "file_modify_and_return",
      reason: "invalid_file_task_paths",
      reply: "文件任务路径不在允许范围内，已拒绝执行。",
    };
  }
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    return {
      handled: true,
      ok: false,
      task_type: "file_modify_and_return",
      reason: "source_file_missing",
      reply: "源文件不存在，无法修改。",
    };
  }
  const sourceContent = fs.readFileSync(sourcePath, "utf8");
  const generated = runFileModifierCommand({ command, workspace, spec, sourceContent, options });
  if (!generated.ok) {
    return {
      handled: true,
      ok: false,
      task_type: "file_modify_and_return",
      reason: generated.reason,
      checks: [{ name: "file_modify", status: "failed", detail: generated.detail || generated.reason }],
      reply: `文件修改失败：${generated.reason}`,
    };
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generated.content, "utf8");
  const rel = path.relative(workspace, outputPath).replace(/\\/g, "/");
  const checks = runFileArtifactChecks({ workspace, filePath: outputPath, checks: spec.checks || ["syntax"] });
  return {
    handled: true,
    ok: checks.ok,
    task_type: "file_modify_and_return",
    reason: checks.ok ? "" : checks.reason || "file_check_failed",
    artifacts: [rel],
    checks: [
      { name: "file_modify", status: "passed" },
      ...checks.checks,
    ],
    reply: checks.ok
      ? `已修改文件并通过检查：${rel}`
      : `文件已修改但检查失败：${rel}\n${checks.reason || "file_check_failed"}`,
  };
}

function executeScriptCreateAndRun({ workspace, parsed, options }) {
  const spec = parsed && parsed.spec ? parsed.spec : {};
  const command = scriptGeneratorCommand(options);
  if (!command) {
    return {
      handled: false,
      ok: false,
      delegate_to_agent: true,
      task_type: "script_create_and_run",
      reason: "script_generator_not_configured",
    };
  }
  const outputPath = String(spec.output_path || "");
  const resolved = path.resolve(workspace, outputPath.replace(/[\\/]/g, path.sep));
  const generatedRoot = path.resolve(workspace, "local_files", "generated");
  if (!isPathInside(resolved, generatedRoot)) {
    return {
      handled: true,
      ok: false,
      task_type: "script_create_and_run",
      reason: "output_must_be_local_files_generated",
      reply: "脚本输出路径不在 local_files/generated/ 下，已拒绝执行。",
    };
  }
  const generated = runScriptGeneratorCommand({ command, workspace, spec, options });
  if (!generated.ok) {
    return {
      handled: true,
      ok: false,
      task_type: "script_create_and_run",
      reason: generated.reason,
      checks: [{ name: "script_generate", status: "failed", detail: generated.detail || generated.reason }],
      reply: `脚本生成失败：${generated.reason}`,
    };
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, generated.code, "utf8");
  const checks = runScriptTaskChecks({ workspace, filePath: resolved, checks: spec.checks || ["syntax"] });
  const rel = path.relative(workspace, resolved).replace(/\\/g, "/");
  return {
    handled: true,
    ok: checks.ok,
    task_type: "script_create_and_run",
    reason: checks.ok ? "" : checks.reason || "script_check_failed",
    artifacts: [rel],
    checks: [
      { name: "script_generate", status: "passed" },
      ...checks.checks,
    ],
    reply: checks.ok
      ? `已生成脚本并通过检查：${rel}`
      : `脚本已生成但检查失败：${rel}\n${checks.reason || "script_check_failed"}`,
  };
}

function runFileModifierCommand({ command, workspace, spec, sourceContent, options = {} }) {
  const request = {
    version: 1,
    role: "file_modifier",
    spec,
    source: {
      path: spec.source_file,
      content: sourceContent,
    },
    rules: [
      "Only output modified file content or JSON with a content/code field.",
      "Do not read secrets, tokens, cookies, .env files, or other workspaces.",
      "Keep the output compatible with the original file type unless instructed otherwise.",
    ],
  };
  const result = spawnSync(command.file, command.args, {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    cwd: workspace,
    timeout: Math.max(1000, Number(options.fileModifierTimeoutMs || process.env.QQ_TASK_FILE_MODIFIER_TIMEOUT_MS || 10000) || 10000),
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) {
    return { ok: false, reason: result.error.code === "ETIMEDOUT" ? "file_modifier_timeout" : "file_modifier_failed", detail: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, reason: "file_modifier_failed", detail: compact(result.stderr || result.stdout || `exit ${result.status}`) };
  }
  const content = extractGeneratedScript(result.stdout);
  if (!content.trim()) {
    return { ok: false, reason: "empty_modified_file" };
  }
  return { ok: true, content };
}

function runFileArtifactChecks({ workspace, filePath, checks = [] }) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (![".py", ".js", ".ps1", ".sh"].includes(ext)) {
    return {
      ok: true,
      checks: [{ name: "artifact_file", status: "passed" }],
      reason: "",
    };
  }
  return runScriptTaskChecks({ workspace, filePath, checks });
}

function runScriptGeneratorCommand({ command, workspace, spec, options = {} }) {
  const request = {
    version: 1,
    role: "script_generator",
    spec,
    rules: [
      "Only output script content or JSON with a code field.",
      "Do not read secrets, tokens, cookies, .env files, or other workspaces.",
      "The script must be safe for syntax check and optional dry run.",
    ],
  };
  const result = spawnSync(command.file, command.args, {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    cwd: workspace,
    timeout: Math.max(1000, Number(options.scriptGeneratorTimeoutMs || process.env.QQ_TASK_SCRIPT_GENERATOR_TIMEOUT_MS || 10000) || 10000),
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    return { ok: false, reason: result.error.code === "ETIMEDOUT" ? "script_generator_timeout" : "script_generator_failed", detail: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, reason: "script_generator_failed", detail: compact(result.stderr || result.stdout || `exit ${result.status}`) };
  }
  const code = extractGeneratedScript(result.stdout);
  if (!code.trim()) {
    return { ok: false, reason: "empty_script" };
  }
  return { ok: true, code };
}

function extractGeneratedScript(output) {
  const text = String(output || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.code === "string") return parsed.code;
    if (parsed && typeof parsed.content === "string") return parsed.content;
  } catch {
    // Treat plain stdout as script content.
  }
  const fenced = text.match(/```(?:python|py|javascript|js|powershell|ps1|bash|sh)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trimStart() : text;
}

function scriptGeneratorCommand(options = {}) {
  return normalizeCommand(options.scriptGeneratorCommand || process.env.QQ_TASK_SCRIPT_GENERATOR_COMMAND || "");
}

function fileModifierCommand(options = {}) {
  return normalizeCommand(options.fileModifierCommand || process.env.QQ_TASK_FILE_MODIFIER_COMMAND || "");
}

function resolveWorkspacePath(workspace, relativePath) {
  const normalized = String(relativePath || "").replace(/[\\/]/g, path.sep);
  if (!normalized || path.isAbsolute(normalized)) return null;
  const resolved = path.resolve(workspace, normalized);
  const root = path.resolve(workspace);
  return isPathInside(resolved, root) ? resolved : null;
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
    return normalizeCommand(JSON.parse(text));
  } catch {
    return { file: text, args: [] };
  }
}

function isPathInside(targetPath, rootPath) {
  const rel = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function safeName(value) {
  return String(value || "task").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 120);
}

function registeredTaskTypes() {
  return Object.keys(EXECUTORS).sort();
}

module.exports = {
  attachTaskArtifactOutbox,
  enqueueExecutionArtifactUploads,
  executeNaturalTask,
  extractGeneratedScript,
  missingFieldQuestion,
  registeredTaskTypes,
};
