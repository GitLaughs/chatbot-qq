"use strict";

function classifyTask(message, options = {}) {
  const text = String(message || "").trim();
  if (looksLikeVivadoSimulation(text)) {
    return { kind: "task", task_type: "vivado_simulation", confidence: 0.82, route: "delegate_vivado_skill_agent" };
  }
  if (looksLikeGeneratedDocument(text)) {
    return { kind: "chat", confidence: 0.82, route: "delegate_document_generation" };
  }
  if (looksLikeWeeklyRota(text, options)) {
    return { kind: "task", task_type: "weekly_rota", confidence: 0.86, route: "model_parse_then_script_execute" };
  }
  if (looksLikeCourseSchedule(text, options)) {
    return { kind: "task", task_type: "course_schedule", confidence: 0.78, route: "model_parse_then_script_execute" };
  }
  if (looksLikeScheduledReminder(text)) {
    return { kind: "task", task_type: "scheduled_reminder", confidence: 0.72, route: "model_parse_then_script_execute" };
  }
  if (looksLikeAcademicAssist(text)) {
    return { kind: "task", task_type: "academic_assist", confidence: 0.74, route: "model_parse_then_script_execute" };
  }
  if (/改|修改|修一下|编辑|润色|替换|发回来|回传/u.test(text) && /文件|脚本|ps1|\.js|\.py|\.md/iu.test(text)) {
    return { kind: "task", task_type: "file_modify_and_return", confidence: 0.74, route: "model_parse_then_script_execute" };
  }
  if (/写|新建|创建|生成/u.test(text) && /脚本|script|python|powershell|ps1|\.py|\.ps1/iu.test(text)) {
    return { kind: "task", task_type: "script_create_and_run", confidence: 0.68, route: "model_parse_then_script_execute" };
  }
  if (/部署|重启|restart|reload|上线/u.test(text) && /服务|bot|qq|代理|配置/u.test(text)) {
    return { kind: "task", task_type: "deploy_or_restart", confidence: 0.66, route: "model_parse_then_script_execute" };
  }
  return { kind: "chat", confidence: 0, route: "normal_chat" };
}

function looksLikeScheduledReminder(text) {
  if (!text) return false;
  const explicitReminder = /每天|每日|每晚|定时|提醒我|叫我|通知我|别忘|记得/u.test(text) && /提醒|检查|别忘|通知|记得/u.test(text);
  if (explicitReminder) return true;
  const hasTime = /(?:周|星期)[日天一二三四五六0-7].{0,12}\d{1,2}\s*(?::|：|点半|点)\s*\d{0,2}|(?:上午|早上|中午|下午|晚上|晚)?\s*\d{1,2}\s*(?::|：|点半|点)\s*\d{0,2}/u.test(text);
  const hasDeadlineCue = /ddl|DDL|截止|deadline|考试|测验|交(?:作业|报告|实验|论文)?|提交|到期/u.test(text);
  const hasLeadCue = /提前\s*\d+\s*(?:天|小时|分钟|分)/u.test(text);
  return hasTime && hasDeadlineCue && (hasLeadCue || /(?:周|星期)[日天一二三四五六0-7]/u.test(text));
}

function looksLikeVivadoSimulation(text) {
  if (!text) return false;
  if (/(实验报告|报告指导|报告助手|实验要求|数据表)/u.test(text) && !/vivado|xsim|xvlog|xelab|verilog|systemverilog|testbench|tb[_\-\w]*/iu.test(text)) {
    return false;
  }
  if (/(已有\s*netlist|netlist|\.cir\b|\.sp\b|\.asc\b)/i.test(text) && !/vivado|xsim|xvlog|xelab|verilog|systemverilog|testbench|tb[_\-\w]*/iu.test(text)) {
    return false;
  }
  const tool = /vivado|xsim|xvlog|xelab|verilog|systemverilog|仿真|波形|testbench|tb[_\-\w]*/iu.test(text);
  const action = /跑|运行|执行|仿真|simulate|simulation|编译|综合|生成|导出|回传|上传|检查|验证|波形|vcd|wdb|png/iu.test(text);
  const artifact = /源码|代码|波形|vcd|wdb|png|日志|log|报告|local_files|回传|上传|文件/iu.test(text);
  return tool && action && artifact;
}

function looksLikeGeneratedDocument(text) {
  if (!text) return false;
  const wantsCreate = /生成|创建|新建|撰写|写一[个份篇]?|设计|整理/u.test(text);
  const docTarget = /Markdown|markdown|md\b|报告|文档|方案|计划|清单|runbook|巡检/u.test(text);
  const saveTarget = /local_files|保存到|保存成|文件名|\.md\b/iu.test(text);
  const explicitModify = /修改|修一下|编辑|润色|替换|回传/u.test(text);
  return wantsCreate && docTarget && saveTarget && !explicitModify;
}

function looksLikeWeeklyRota(text, options = {}) {
  if (!text) return false;
  const hasSchedule = /每周|每星期|周[日天一二三四五六]|星期[日天一二三四五六]/u.test(text);
  const hasRota = /值日|轮值|轮班|轮休|顺序|本周|这周/u.test(text);
  const hasAction = options.commandIntent || /提醒|通知|@|艾特|对应人/u.test(text);
  return hasSchedule && hasRota && hasAction;
}

function looksLikeCourseSchedule(text, options = {}) {
  if (!text) return false;
  const hasCourseWord = /课程表|课表|课程提醒|今天课程|上课提醒|课前提醒/u.test(text);
  const hasCourseRows = /(?:周|星期)[日天一二三四五六0-7].{0,20}\d{1,2}[:：点]\d{1,2}/u.test(text);
  const hasImportAction = options.commandIntent || /导入|记录|保存|提醒|推送|@|艾特/u.test(text);
  return (hasCourseWord && hasImportAction) || (hasCourseWord && hasCourseRows);
}

function looksLikeAcademicAssist(text) {
  if (!text) return false;
  const academicCue = /题目|解析|证明|计算|公式|验算|代码验证|代码验算|高数|线代|线性代数|矩阵|行列式|实验报告|报告助手|实验要求|数据表|电路参数|指标|调参|参数优化|netlist|\.cir\b|\.sp\b|\.asc\b/iu.test(text);
  const actionCue = /帮|给|做|看|分析|整理|提取|指导|验算|验证|检查|调|优化|跑|仿真|怎么写|怎么做/iu.test(text);
  return academicCue && actionCue;
}

module.exports = {
  classifyTask,
  looksLikeAcademicAssist,
  looksLikeCourseSchedule,
  looksLikeScheduledReminder,
  looksLikeVivadoSimulation,
  looksLikeGeneratedDocument,
  looksLikeWeeklyRota,
};
