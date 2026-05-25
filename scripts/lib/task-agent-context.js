"use strict";

const path = require("path");
const { recentFiles } = require("./file-index");
const { prepareFileModifyTask } = require("./file-task-prep");
const { prepareScriptCreateTask } = require("./script-task-prep");

const { taskReceiptPath } = require("./task-request-store");

function buildTaskAgentContext({ text = "", route, parsed, workspace = "", scope = "", scopeID = "", taskRequest = null }) {
  if (!route || route.kind !== "task") return "";
  const lines = [
    "【自然语言任务代理】",
    `task_type: ${route.task_type}`,
    `confidence: ${route.confidence}`,
    `scope: ${scope || "unknown"}:${scopeID || ""}`,
    "用户在描述一个要完成的任务。不要只回复用法或建议；能在当前 workspace 内完成就执行，执行后汇报结果和可验证产物。",
    "执行边界：只读写当前聊天 workspace；不要读取或写入 secrets/env/cookies/token/私有日志；部署或重启必须先请求管理员确认；信息不足时只问一个最关键短问题。",
  ];
  if (taskRequest && taskRequest.id) {
    const receipt = taskRequest.receipt_path || taskReceiptPath(taskRequest.id);
    lines.push(`task_id: ${taskRequest.id}`);
    lines.push(`task_status: ${taskRequest.status || "delegated"}`);
    lines.push(`receipt_path: ${receipt}`);
    lines.push("完成任务后写入 receipt JSON，字段至少包含 status、result、artifacts、checks；随后回复简要结果和可验证路径。");
  }
  if (route.task_type === "file_modify_and_return") {
    lines.push(...fileTaskLines({ workspace, prepared: parsed && parsed.prepared }));
  }
  if (route.task_type === "script_create_and_run") {
    lines.push(...scriptTaskLines({ prepared: parsed && parsed.prepared }));
  }
  lines.push("结构化草案：");
  lines.push(parsed && parsed.ok ? JSON.stringify(parsed.spec, null, 2) : JSON.stringify({ error: parsed && parsed.error || "parse_failed", text: String(text || "").slice(0, 500) }, null, 2));
  return lines.join("\n").slice(0, 2400);
}

function preparedFileTaskParse({ parsed, workspace, text }) {
  if (!parsed || !parsed.ok || !parsed.spec) {
    return parsed;
  }
  if (parsed.spec.task_type === "script_create_and_run") {
    return preparedScriptTaskParse({ parsed, text });
  }
  if (parsed.spec.task_type !== "file_modify_and_return") {
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

function preparedScriptTaskParse({ parsed, text }) {
  if (!parsed || !parsed.ok || !parsed.spec || parsed.spec.task_type !== "script_create_and_run") {
    return parsed;
  }
  const prepared = prepareScriptCreateTask({ spec: parsed.spec, text });
  return {
    ...parsed,
    spec: prepared.spec,
    missing: prepared.ok ? [] : prepared.errors.map((item) => item.field),
    prepared,
  };
}

function scriptTaskLines({ prepared = null }) {
  const lines = [
    "脚本任务规则：",
    "- 只能在当前聊天 workspace 内创建脚本；默认保存到 local_files/generated/。",
    "- 不要写入 secrets/env/cookies/token，不要读取其他 workspace。",
    "- 生成后按 checks 做语法检查；dry_run 只允许无破坏、无外部写入的试运行。",
    "- 回复必须包含生成脚本路径，例如：local_files/generated/task.py；代理会据此记录任务产物。",
  ];
  if (prepared && prepared.ok && prepared.spec) {
    lines.push(`建议语言：${prepared.spec.language}`);
    lines.push(`建议输出：${prepared.spec.output_path}`);
    lines.push(`检查：${(prepared.spec.checks || []).join("、") || "syntax"}`);
  } else if (prepared && prepared.errors && prepared.errors.length) {
    lines.push(`脚本任务仍缺：${prepared.errors.map((item) => item.field).join("、")}`);
  }
  return lines;
}

function fileTaskLines({ workspace, prepared = null }) {
  const files = safeRecentFiles(workspace, 5);
  const lines = [
    "文件任务规则：",
    "- 输入文件只能来自当前 workspace 的 local_files/ 或 received_files/，优先使用用户消息中给出的路径；如果用户说“这个文件/刚才的文件”，优先使用最近归档文件。",
    "- 输出必须保存到 local_files/modified/ 下，文件名保留原扩展名并加 -modified 或语义化后缀。",
    "- 修改后回复必须包含类似“已修改并保存：local_files/modified/xxx”的相对路径；代理会按该路径自动上传回当前聊天。",
    "- 不要覆盖原始归档文件；必要时说明做了哪些检查。",
  ];
  if (prepared && prepared.ok && prepared.spec) {
    lines.push(`已解析输入：${prepared.spec.source_file}`);
    lines.push(`建议输出：${prepared.spec.output_path}`);
  } else if (prepared && prepared.errors && prepared.errors.length) {
    lines.push(`文件任务仍缺：${prepared.errors.map((item) => item.field).join("、")}`);
  }
  if (files.length === 0) {
    lines.push("当前 workspace 最近没有索引文件；如果任务需要文件，先询问用户上传或指定 local_files/ 路径。");
    return lines;
  }
  lines.push("当前 workspace 最近文件候选：");
  for (const item of files) {
    lines.push(`- ${item.name || path.basename(item.relative_path || "")}: ${item.relative_path}${item.extracted_path ? `；提取文本 ${item.extracted_path}` : ""}`);
  }
  return lines;
}

function safeRecentFiles(workspace, limit) {
  try {
    return recentFiles({ workspace, limit }).filter((item) => String(item.relative_path || "").startsWith("local_files/"));
  } catch {
    return [];
  }
}

module.exports = {
  buildTaskAgentContext,
  fileTaskLines,
  preparedFileTaskParse,
  preparedScriptTaskParse,
  scriptTaskLines,
};
