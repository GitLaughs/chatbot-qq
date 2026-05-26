"use strict";

const fs = require("fs");
const path = require("path");
const { addProposal, proposalStats } = require("./proposal-store");
const { memoryStats, pendingCandidateHealth, pendingCandidateStats } = require("./memory-store");

const GAP_TEMPLATES = {
  course_screenshot_ocr: {
    title: "接入课表截图 OCR 解析",
    body: "当前课表截图导入已能登记待补充任务，但仍需要用户手动发 OCR 后的课程文字。建议接入低频、按需触发的图片 OCR/视觉解析，把课表截图转成 course_schedule entries，并继续限制在当前聊天 workspace。",
  },
  math_verification_parser: {
    title: "增强数学题代码验算解析",
    body: "当前数学/线代验算只支持 JSON 矩阵格式。建议增加安全的表达式解析和更多线代运算支持，例如矩阵乘法、行列式、特征值、方程组验算，并把生成脚本限制在 local_files/academic/。",
  },
  academic_report_extraction: {
    title: "增强实验报告助手的公式和参数抽取",
    body: "当前实验报告助手会生成结构化指导和归档，但公式、电路参数、波形数据表仍主要靠文本启发式。建议增加对上传 PDF/图片/数据表的按需抽取，并输出可追溯的报告骨架。",
  },
  memory_triage_backlog: {
    title: "清理候选记忆积压",
    body: "当前 workspace 存在较多待处理候选记忆。建议定期运行 /候选记忆 分拣 和 /处理候选记忆，只确认高价值、可复用、非敏感的长期记忆。",
  },
  memory_sensitive_review: {
    title: "审查候选记忆敏感项",
    body: "候选记忆体检发现疑似敏感或异常项。建议先运行 /候选记忆 体检，再跳过敏感候选，避免把 token/cookie/私有日志写入长期记忆。",
  },
  proposal_land_backlog: {
    title: "落地已采纳自迭代提案",
    body: "当前 workspace 存在 accepted 但未落地的提案。建议运行 /建议箱 待落地，把通过预检的提案转成待办并逐项实现。",
  },
  memory_evidence_packet: {
    title: "启用长期记忆证据包",
    body: "当前 workspace 已有聊天记录，但还没有 profile/dream 证据包。建议先运行画像更新或 dream 证据包生成器，把原始聊天压缩成带 source-map 的 compact evidence，再交给模型做反思和长期记忆维护。",
  },
};

function addCapabilityGapProposal({ workspace, scope = "", scopeID = "", userID = "", sourceMessageID = "", gap = "", evidence = "" }) {
  const template = GAP_TEMPLATES[gap];
  if (!workspace || !template) {
    return null;
  }
  const body = [template.body, evidence ? `证据：${compact(evidence, 180)}` : ""].filter(Boolean).join("\n");
  return addProposal({
    workspace,
    scope,
    scopeID,
    userID,
    sourceMessageID,
    title: `自动提案：${template.title}`,
    body,
  });
}

function workspaceGrowthReport({ workspace }) {
  const mem = memoryStats({ workspace });
  const pending = pendingCandidateStats({ workspace });
  const health = pendingCandidateHealth({ workspace });
  const proposals = proposalStats({ workspace });
  const evidence = evidencePacketStats({ workspace });
  const suggestions = growthSuggestions({ mem, pending, health, proposals, evidence });
  return {
    memory: mem,
    pending,
    health,
    proposals,
    evidence,
    suggestions,
  };
}

function seedGrowthProposals({ workspace, scope = "", scopeID = "", userID = "", sourceMessageID = "" }) {
  const report = workspaceGrowthReport({ workspace });
  const seeded = [];
  for (const suggestion of report.suggestions) {
    if (!suggestion.gap) continue;
    const added = addCapabilityGapProposal({
      workspace,
      scope,
      scopeID,
      userID,
      sourceMessageID,
      gap: suggestion.gap,
      evidence: suggestion.evidence,
    });
    if (added) seeded.push(added);
  }
  return { report, seeded };
}

function growthSuggestions({ mem, pending, health, proposals, evidence }) {
  const out = [];
  const active = Number(pending && pending.active || 0);
  const sensitive = (health && health.anomalies || []).filter(({ flags }) => (flags || []).some((flag) => /敏感|异常|过长|过短/.test(flag))).length;
  if (Number(evidence && evidence.chat_files || 0) > 0 && Number(evidence && evidence.total || 0) === 0) {
    out.push({
      gap: "memory_evidence_packet",
      title: "长期记忆缺少证据包",
      evidence: `chat_files=${evidence.chat_files}, evidence_packets=0`,
      command: "node scripts/build-profile-update-packet.js --workspace <当前workspace>",
    });
  }
  if (active >= 10) {
    out.push({
      gap: "memory_triage_backlog",
      title: "候选记忆积压",
      evidence: `active=${active}`,
      command: "/候选记忆 分拣",
    });
  }
  if (sensitive > 0 || Number(health && health.duplicateFingerprints || 0) > 0) {
    out.push({
      gap: "memory_sensitive_review",
      title: "候选记忆需要体检",
      evidence: `sensitive_or_anomaly=${sensitive}, duplicate=${health && health.duplicateFingerprints || 0}`,
      command: "/候选记忆 体检",
    });
  }
  if (Number(proposals && proposals.byStatus && proposals.byStatus.accepted || 0) > 0) {
    out.push({
      gap: "proposal_land_backlog",
      title: "有已采纳提案待落地",
      evidence: `accepted=${proposals.byStatus.accepted || 0}`,
      command: "/建议箱 待落地",
    });
  }
  if (out.length === 0) {
    out.push({
      gap: "",
      title: "暂无需要自动建提案的记忆/提案问题",
      evidence: `active_mem=${mem && mem.active || 0}, pending=${active}`,
      command: "/工作区 体检",
    });
  }
  return out;
}

function formatGrowthReport(result) {
  const report = result && result.report ? result.report : result;
  const seeded = result && Array.isArray(result.seeded) ? result.seeded : [];
  const mem = report && report.memory || { active: 0, total: 0, deleted: 0 };
  const pending = report && report.pending || { active: 0, applied: 0, skipped: 0 };
  const proposals = report && report.proposals || { byStatus: {} };
  const evidence = report && report.evidence || { profile: 0, dream: 0, chat_files: 0, latest: "" };
  const suggestions = report && report.suggestions || [];
  const lines = [
    "成长性体检：",
    `记忆：active ${mem.active || 0} / total ${mem.total || 0} / deleted ${mem.deleted || 0}`,
    `候选记忆：active ${pending.active || 0} / applied ${pending.applied || 0} / skipped ${pending.skipped || 0}`,
    `提案：open ${proposals.byStatus && proposals.byStatus.open || 0} / accepted ${proposals.byStatus && proposals.byStatus.accepted || 0} / done ${proposals.byStatus && proposals.byStatus.done || 0}`,
    `证据包：profile ${evidence.profile || 0} / dream ${evidence.dream || 0}，chat ${evidence.chat_files || 0}，最近 ${evidence.latest ? shortDate(evidence.latest) : "暂无"}`,
    "建议：",
  ];
  for (const item of suggestions.slice(0, 5)) {
    lines.push(`- ${item.title}${item.command ? `；建议命令：${item.command}` : ""}`);
  }
  if (seeded.length > 0) {
    const created = seeded.filter((item) => item && !item.duplicate).length;
    const duplicate = seeded.filter((item) => item && item.duplicate).length;
    lines.push(`自动提案：新增 ${created}，重复 ${duplicate}`);
  }
  lines.push("边界：只按当前 workspace 的候选记忆和提案做低频体检；不建立全局向量库，不做每消息 LLM 总结，不自动部署或重启。");
  return lines.join("\n").slice(0, 1600);
}

function compact(value, limit = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, Math.max(20, Number(limit) || 160));
}

function evidencePacketStats({ workspace }) {
  const memoryDir = path.join(workspace || "", "memory");
  const profile = listEvidenceFiles(path.join(memoryDir, "profile-updates"));
  const dream = listEvidenceFiles(path.join(memoryDir, "dreams"));
  const chatFiles = listFiles(memoryDir, /^chat-\d{4}-\d{2}-\d{2}(?:-\d{3})?\.jsonl$/);
  const latest = [...profile, ...dream].map((item) => item.mtime).sort().at(-1) || "";
  return {
    profile: profile.length,
    dream: dream.length,
    total: profile.length + dream.length,
    chat_files: chatFiles.length,
    latest,
  };
}

function listEvidenceFiles(dir) {
  return listFiles(dir, /-evidence\.md$/);
}

function listFiles(dir, pattern) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => pattern.test(name))
      .map((name) => {
        const file = path.join(dir, name);
        return { file, mtime: fs.statSync(file).mtime.toISOString() };
      });
  } catch {
    return [];
  }
}

function shortDate(value) {
  return String(value || "").replace("T", " ").slice(0, 16);
}

module.exports = {
  addCapabilityGapProposal,
  evidencePacketStats,
  formatGrowthReport,
  seedGrowthProposals,
  workspaceGrowthReport,
};
