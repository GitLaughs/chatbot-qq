"use strict";

const { parseTaskWithModel } = require("../task-agent");
const { createRotaFromSpec, parseRotaRequest, validateRotaSpec } = require("./rota-scheduler");
const { looksLikeWeeklyRota } = require("./task-intent-router");

function tryParseRotaWithFallback(text, context = {}, options = {}) {
  const parsed = parseRotaRequest(text, context);
  if (parsed) {
    return { ok: true, source: "regex", rota: parsed };
  }
  if (!looksLikeWeeklyRota(text, context)) {
    return { ok: false, reason: "not_rota_task" };
  }
  const modelResult = parseTaskWithModel(text, "weekly_rota", {
    ...context,
    modelParser: options.modelParser,
    fixtures: options.fixtures,
  });
  if (!modelResult.ok) {
    return { ok: false, reason: modelResult.error || "model_parse_failed", modelResult };
  }
  const checked = validateRotaSpec({
    ...modelResult.spec,
    group_id: context.groupID,
    created_by: context.userID,
    start_date: context.startDate,
    source_text: text,
  });
  if (!checked.ok) {
    return {
      ok: false,
      reason: checked.missing.length ? "missing_fields" : "invalid_spec",
      missing: checked.missing,
      errors: checked.errors,
      spec: modelResult.spec,
    };
  }
  return { ok: true, source: "model", rota: checked.rota, spec: modelResult.spec };
}

function createRotaFromText(workspace, text, context = {}, options = {}) {
  const parsed = tryParseRotaWithFallback(text, context, options);
  if (!parsed.ok) return parsed;
  const created = createRotaFromSpec(workspace, parsed.rota, {
    groupID: context.groupID,
    userID: context.userID,
    startDate: context.startDate,
    sourceText: text,
  });
  return { ...created, source: parsed.source, parsed };
}

function formatRotaFallbackFailure(result, fallbackText) {
  if (!result || result.reason === "not_rota_task" || result.reason === "model_parse_failed" || result.reason === "parse_failed") {
    return fallbackText;
  }
  if (result.reason === "missing_fields") {
    return `我已经识别到这是“每周值日提醒”，但还缺：${firstMissingLabel(result.missing)}。`;
  }
  if (result.reason === "invalid_spec") {
    const first = (result.errors || [])[0];
    return first ? `值日提醒解析到了，但字段不合法：${first.field} ${first.message}` : fallbackText;
  }
  if (result.reason === "duplicate") {
    return [
      "已有相同时间和任务顺序的群轮值提醒，暂不重复创建。",
      result.preview || "",
    ].filter(Boolean).join("\n");
  }
  return fallbackText;
}

function firstMissingLabel(missing = []) {
  const labels = {
    day_of_week: "每周几",
    time: "提醒时间",
    tasks: "值日顺序",
    current_assignments: "本周每个人对应的任务",
  };
  return labels[missing[0]] || missing[0] || "必要字段";
}

module.exports = {
  createRotaFromText,
  formatRotaFallbackFailure,
  tryParseRotaWithFallback,
};
