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
    "执行边界：只读写当前聊天 workspace；不要读取或写入 secrets/env/cookies/token/私有日志；不要删除、移动、覆盖、改权限或修改当前 workspace 外的任何文件；部署或重启必须先请求管理员确认；信息不足时只问一个最关键短问题。",
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
  if (route.task_type === "vivado_simulation") {
    lines.push(...vivadoTaskLines({ parsed, workspace }));
  }
  if (route.task_type === "academic_assist") {
    lines.push(...academicAssistTaskLines({ parsed, workspace }));
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
    "- 不要写入 secrets/env/cookies/token，不要读取其他 workspace；不要删除、移动、覆盖、改权限或修改当前 workspace 外的任何文件。",
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

function vivadoTaskLines({ parsed = null, workspace = "" }) {
  const spec = parsed && parsed.spec || {};
  const lines = [
    "Vivado 仿真任务规则：",
    workspace ? `- 当前聊天 workspace 绝对路径：${path.resolve(workspace)}。所有回传产物必须写到这个目录下的 local_files/vivado/<task_id-or-topic>/，不要写到仓库根目录的 local_files。` : "",
    "- 使用本机 Vivado/xsim；优先批处理命令，不要打开 GUI，除非用户明确要求交互查看。",
    "- 不要删除、移动、覆盖、改权限或修改当前聊天 workspace 外的任何文件；清理临时文件也只能限于本任务输出目录。",
    "- 必须先读取并遵循本地 Codex skill：<CODEX_HOME>\\skills\\vivado-sim-runner\\SKILL.md。按该流程先定位 testbench/top/source，再 xvlog/xelab/xsim，最后查 ERROR/CRITICAL WARNING/$finish。",
    "- 输出统一放到当前聊天 workspace 的 local_files/vivado/<task_id-or-topic>/，至少包含 run-summary.md 和关键日志；有波形则保存 VCD/WDB，能渲染就加 PNG。",
    "- 如果用户要求源码或完整产物，必须额外生成一个 zip 包，例如 source-package.zip 或 vivado-artifacts.zip，包含源码、testbench、关键日志和必要脚本；回复必须列出 PNG 和 zip 的 local_files/vivado/... 路径。",
    "- 回复必须包含 local_files/vivado/... 下的相对路径；代理会据此自动回传文件。源码修改或整理后的源码也放在该目录或 local_files/modified/。",
    "- 若任务实际项目在用户授权的本机 HDL 工程目录，只能按授权范围读取；回传到当前聊天 workspace 的 local_files/，不要把无关工程文件整包上传。",
    "- 失败也要给可诊断产物：xvlog.log、xelab.log、xsim.log 或 vivado_sim.log，以及下一步修复建议。"
  ].filter(Boolean);
  if (spec.goal) lines.push(`目标：${spec.goal}`);
  if (spec.workspace_hint) lines.push(`工程提示：${spec.workspace_hint}`);
  if (spec.top_module) lines.push(`top：${spec.top_module}`);
  if (spec.testbench) lines.push(`testbench：${spec.testbench}`);
  if (Array.isArray(spec.sources) && spec.sources.length) lines.push(`用户提到的源码/工程：${spec.sources.join("、")}`);
  if (Array.isArray(spec.outputs) && spec.outputs.length) lines.push(`期望产物：${spec.outputs.join("、")}`);
  const files = safeRecentFiles(workspace, 5).filter((item) => /\.(v|sv|xpr|tcl|xdc|zip)$/i.test(String(item.relative_path || item.name || "")));
  if (files.length) {
    lines.push("当前聊天最近 Vivado/HDL 文件候选：");
    for (const item of files) {
      lines.push(`- ${item.name || path.basename(item.relative_path || "")}: ${item.relative_path}`);
    }
  }
  return lines;
}

function fileTaskLines({ workspace, prepared = null }) {
  const files = safeRecentFiles(workspace, 5);
  const lines = [
    "文件任务规则：",
    "- 输入文件只能来自当前 workspace 的 local_files/ 或 received_files/，优先使用用户消息中给出的路径；如果用户说“这个文件/刚才的文件”，优先使用最近归档文件。",
    "- 输出必须保存到 local_files/modified/ 下，文件名保留原扩展名并加 -modified 或语义化后缀。",
    "- 不要删除、移动、覆盖、改权限或修改当前 workspace 外的任何文件。",
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

function academicAssistTaskLines({ parsed = null, workspace = "" }) {
  const spec = parsed && parsed.spec || {};
  const lines = [
    "学术助手任务规则：",
    workspace ? `- 当前聊天 workspace 绝对路径：${path.resolve(workspace)}。归档产物必须写到 local_files/academic/。` : "",
    "- 自动区分题目解析、指标调参、已有 netlist、实验报告指导、数学/线代验算。",
    "- 数学/线代题优先用代码或数值复核中间结果；实验报告优先提取题目、公式、电路参数、波形和数据表结论。",
    "- 仿真或 netlist 类最终只回传波形图、测量值和关键结论；不要主动回传源文件。",
    "- 不要读取 secrets/env/cookies/token，不要修改当前 workspace 外文件。",
  ].filter(Boolean);
  if (spec.category) lines.push(`分类：${spec.category}`);
  if (spec.course) lines.push(`课程：${spec.course}`);
  if (spec.topic) lines.push(`主题：${spec.topic}`);
  if (spec.expected_output) lines.push(`期望输出：${spec.expected_output}`);
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
  academicAssistTaskLines,
  fileTaskLines,
  preparedFileTaskParse,
  preparedScriptTaskParse,
  scriptTaskLines,
  vivadoTaskLines,
};
