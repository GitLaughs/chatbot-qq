"use strict";

function classifyTask(message, options = {}) {
  const text = String(message || "").trim();
  if (looksLikeWeeklyRota(text, options)) {
    return { kind: "task", task_type: "weekly_rota", confidence: 0.86, route: "model_parse_then_script_execute" };
  }
  if (/每天|每日|每晚|定时|提醒我|叫我/u.test(text) && /提醒|检查|别忘/u.test(text)) {
    return { kind: "task", task_type: "scheduled_reminder", confidence: 0.72, route: "model_parse_then_script_execute" };
  }
  if (/帮我|改|修改|发回来|回传/u.test(text) && /文件|脚本|ps1|\.js|\.py|\.md/iu.test(text)) {
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

function looksLikeWeeklyRota(text, options = {}) {
  if (!text) return false;
  const hasSchedule = /每周|每星期|周[日天一二三四五六]|星期[日天一二三四五六]/u.test(text);
  const hasRota = /值日|轮值|轮班|轮休|顺序|本周|这周/u.test(text);
  const hasAction = options.commandIntent || /提醒|通知|@|艾特|对应人/u.test(text);
  return hasSchedule && hasRota && hasAction;
}

module.exports = {
  classifyTask,
  looksLikeWeeklyRota,
};
