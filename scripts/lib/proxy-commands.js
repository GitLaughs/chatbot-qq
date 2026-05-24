const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { formatCapabilitySummary } = require("./capabilities");
const { fileStats, formatFileList, formatFileStats, readFileIndex, recentFiles, searchFiles } = require("./file-index");
const { formatMemoryCandidates, formatMemoryRuleGuide, formatMemoryRuleInspection, inspectMemoryRule, memoryCandidatesFromSamples } = require("./memory-rules");
const { formatPolicyDrift, scanPolicyDrift } = require("./policy-drift");
const { addMemory, applyPendingCandidates, applyPendingCandidatesWith, comparePendingCandidateSnapshot, diffPendingCandidateSnapshot, formatMemories, formatMemoryEvidence, formatMemoryStats, formatPendingCandidates, formatPendingCandidateApplyResult, formatPendingCandidateBatchResult, formatPendingCandidateHealth, formatPendingCandidateSearch, formatPendingCandidateSnapshot, formatPendingCandidateSnapshotCompare, formatPendingCandidateSnapshotDiff, formatPendingCandidateStats, formatPendingCandidateTriage, formatRecentMemories, inferKind, latestPendingCandidateSnapshot, memoryStats, pendingCandidateHealth, pendingCandidateSnapshot, pendingCandidateStats, pendingCandidateTriage, processPendingCandidatesBatch, readPendingCandidates, savePendingCandidates, searchMemories, searchMemoryEvidence, searchPendingCandidates, skipPendingCandidates, softDeleteMemories } = require("./memory-store");
const { addProposal, addProposalLink, checkProposal, exportProposals, formatDuplicateProposal, formatLandableProposals, formatProposal, formatProposalCheck, formatProposalExport, formatProposalLinkResult, formatProposalLinksCommand, formatProposals, formatProposalStats, formatRoundProposal, getProposal, listLandableProposals, listProposals, pickProposalForRound, proposalStats, searchProposals, updateProposalStatus } = require("./proposal-store");
const { formatRecentErrors, readRecentErrors, recentErrorStats } = require("./recent-errors");
const { redactSecrets } = require("./sensitive-redaction");
const { addTodo, completeTodos, findTodoBySourceProposal, formatDoneTodos, formatTodoSearch, formatTodos, formatTodoStats, listDoneTodos, listTodos, searchTodos, sourceProposalIDs, todoStats } = require("./todo-store");

let sharedCommandActive = 0;

const COMMAND_NAMES = [
  "/help", "help", "帮助", "/命令", "命令",
  "/概览", "概览", "/工作区", "工作区",
  "/审查包", "审查包",
  "/口径巡检", "口径巡检",
  "/status", "状态",
  "/files", "files",
  "/文件", "文件",
  "/记住", "记住",
  "/memory", "memory", "/记忆", "记忆",
  "/证据", "证据", "/为什么这么说", "为什么这么说",
  "/画像", "画像", "/我的偏好", "我的偏好",
  "/忘记", "忘记",
  "/总结今天", "总结今天", "/今日总结", "今日总结",
  "/建议箱", "建议箱", "/提案", "提案",
  "/待办", "待办",
  "/候选记忆", "候选记忆",
  "/处理候选记忆", "处理候选记忆",
  "/应用候选记忆", "应用候选记忆",
  "/跳过候选记忆", "跳过候选记忆",
  "/最近文件", "最近文件",
  "/找文件", "找文件",
  "/安静", "安静",
  "/恢复", "恢复",
  "/队列", "队列",
  "/模式", "模式",
  "/admin", "/管理", "管理",
  "/最近错误", "最近错误"
];

const HELP_ENTRIES = [
  { scope: "all", title: "/help [关键词]", detail: "查看功能；带关键词时搜索命令", tags: ["帮助", "命令", "help"] },
  { scope: "all", title: "/概览", detail: "查看当前群/私聊 workspace 概览；/工作区 体检", tags: ["概览", "工作区", "状态", "体检"] },
  { scope: "all", title: "/审查包", detail: "生成当前 workspace 子 agent 审查上下文包", tags: ["审查", "agent", "迭代", "上下文"] },
  { scope: "all", title: "/口径巡检", detail: "扫描文档和审计脚本中的架构/隐私边界漂移", tags: ["口径", "巡检", "文档", "边界"] },
  { scope: "all", title: "/status", detail: "查看连接、队列、触发模式", tags: ["状态", "连接", "队列", "模式"] },
  { scope: "all", title: "/status index", detail: "查看共享索引状态", tags: ["状态", "索引", "共享"] },
  { scope: "all", title: "/files find 关键词", detail: "查共享文件索引", tags: ["文件", "共享", "索引"] },
  { scope: "all", title: "/文件", detail: "查看当前群/私聊本地文件索引状态", tags: ["文件", "状态", "索引"] },
  { scope: "all", title: "/记住 内容", detail: "写入当前用户/群画像", tags: ["记忆", "画像", "偏好"] },
  { scope: "all", title: "/记忆 关键词", detail: "搜索结构化记忆；/记忆 最近 查看最近记忆", tags: ["记忆", "搜索", "最近"] },
  { scope: "all", title: "/证据 关键词", detail: "查看记忆来源和候选依据", tags: ["记忆", "证据", "为什么"] },
  { scope: "all", title: "/画像", detail: "查看当前群/个人画像", tags: ["画像", "记忆", "偏好"] },
  { scope: "all", title: "/忘记 关键词", detail: "删除画像中匹配的记录", tags: ["记忆", "删除"] },
  { scope: "all", title: "/总结今天", detail: "汇总今天聊天并生成候选记忆", tags: ["总结", "候选", "记忆"] },
  { scope: "all", title: "/建议箱", detail: "列自迭代提案；/建议箱 add 标题 | 正文；/提案 导出 [数量|all]", tags: ["建议", "提案", "迭代", "backlog", "导出"] },
  { scope: "all", title: "/待办", detail: "列待办；/待办 已完成 [数量]；/待办 搜索 关键词；/待办 add 内容；/待办 done 序号|id", tags: ["待办", "todo", "搜索", "已完成"] },
  { scope: "all", title: "/待办 候选", detail: "列待办候选；/待办 应用候选 序号|all", tags: ["待办", "候选"] },
  { scope: "all", title: "/候选记忆 [关键词]", detail: "查看或筛选待确认记忆；/候选记忆 快照；/候选记忆 对比 sha；/候选记忆 差异 sha；/候选记忆 体检；/候选记忆 分拣", tags: ["候选", "记忆", "搜索", "快照", "对比", "差异", "体检", "分拣"] },
  { scope: "all", title: "/处理候选记忆 应用:1,2 跳过:3", detail: "按同一快照批量应用/跳过候选记忆", tags: ["候选", "记忆", "批处理", "应用", "跳过"] },
  { scope: "all", title: "/应用候选记忆 序号|all", detail: "确认写入候选记忆", tags: ["候选", "记忆", "应用"] },
  { scope: "all", title: "/跳过候选记忆 序号|all", detail: "跳过候选记忆", tags: ["候选", "记忆", "跳过"] },
  { scope: "all", title: "/最近文件", detail: "列当前群/私聊最近归档文件", tags: ["文件", "最近", "归档"] },
  { scope: "all", title: "/找文件 关键词", detail: "查本群/私聊文件索引", tags: ["文件", "搜索", "索引"] },
  { scope: "group", title: "/安静 30分钟", detail: "暂停群内主动回复", tags: ["群", "静默", "模式"] },
  { scope: "group", title: "/恢复", detail: "恢复群内主动回复", tags: ["群", "静默", "恢复"] },
  { scope: "all", title: "/队列", detail: "查看等待发送、画图、监听队列", tags: ["队列", "画图", "监听"] },
  { scope: "group", title: "/模式 selective|mention|all|off", detail: "切换本群触发模式", tags: ["群", "模式", "触发"] },
  { scope: "all", title: "/最近错误", detail: "查看代理最近错误", tags: ["错误", "日志", "报错"] },
  { scope: "all", title: "/画图 prompt", detail: "生成图片", tags: ["画图", "图片"] },
  { scope: "private", title: "/admin", detail: "管理员控制台", tags: ["管理员", "admin", "控制台"] },
  { scope: "group", title: "/dream 或 做梦", detail: "整理群记忆", tags: ["dream", "做梦", "记忆", "群"] }
];

function createProxyCommands(deps) {
  function commandBody(msg, names) {
    const text = deps.messageText(msg).trim();
    for (const name of names) {
      if (text === name) {
        return "";
      }
      if (text.startsWith(`${name} `)) {
        return text.slice(name.length).trim();
      }
      if ((name === "记住" || name === "忘记" || name === "找文件" || name === "安静" || name === "模式") && text.startsWith(name) && text.length > name.length) {
        return text.slice(name.length).trim();
      }
    }
    return null;
  }

  function isProxyCommand(msg) {
    return commandBody(msg, COMMAND_NAMES) !== null;
  }

  function handleProxyCommand(msg) {
    const isPrivate = msg.message_type === "private";
    const reply = (text) => {
      if (isPrivate) {
        deps.sendPrivateText(msg.user_id, msg.message_id, text);
      } else {
        deps.sendGroupText(msg.group_id, msg.message_id, text);
      }
    };
    const help = commandBody(msg, ["/help", "help", "帮助", "/命令", "命令"]);
    if (help !== null) return reply(proxyHelpText(isPrivate, help));
    const overview = commandBody(msg, ["/概览", "概览", "/工作区", "工作区"]);
    if (overview !== null) return reply(workspaceCommand(msg, overview));
    const reviewPacket = commandBody(msg, ["/审查包", "审查包"]);
    if (reviewPacket !== null) return reply(workspaceReviewPacket(msg, reviewPacket));
    const policyDrift = commandBody(msg, ["/口径巡检", "口径巡检"]);
    if (policyDrift !== null) return reply(policyDriftCommand(policyDrift));
    const status = commandBody(msg, ["/status", "状态"]);
    if (status !== null) return reply(status.trim().toLowerCase() === "index" ? sharedCommand(msg, ["/status", "index"]) : proxyStatusText(msg));
    const files = commandBody(msg, ["/files", "files"]);
    if (files !== null) return reply(sharedFilesCommand(msg, files));
    const localFiles = commandBody(msg, ["/文件", "文件"]);
    if (localFiles !== null) return reply(localFileCommand(msg, localFiles));
    const remember = commandBody(msg, ["/记住", "记住"]);
    if (remember !== null) return reply(rememberFact(msg, remember));
    const memory = commandBody(msg, ["/memory", "memory", "/记忆", "记忆"]);
    if (memory !== null) return reply(searchMemoryCommand(msg, memory));
    const evidence = commandBody(msg, ["/证据", "证据", "/为什么这么说", "为什么这么说"]);
    if (evidence !== null) return reply(memoryEvidenceCommand(msg, evidence));
    const profile = commandBody(msg, ["/画像", "画像", "/我的偏好", "我的偏好"]);
    if (profile !== null) return reply(showProfile(msg, profile));
    const forget = commandBody(msg, ["/忘记", "忘记"]);
    if (forget !== null) return reply(forgetFact(msg, forget));
    const summary = commandBody(msg, ["/总结今天", "总结今天", "/今日总结", "今日总结"]);
    if (summary !== null) return reply(todaySummary(msg));
    const proposal = commandBody(msg, ["/建议箱", "建议箱", "/提案", "提案"]);
    if (proposal !== null) return reply(proposalCommand(msg, proposal));
    const todo = commandBody(msg, ["/待办", "待办"]);
    if (todo !== null) return reply(todoCommand(msg, todo));
    const pendingMemory = commandBody(msg, ["/候选记忆", "候选记忆"]);
    if (pendingMemory !== null) return reply(showPendingMemoryCandidates(msg));
    const processMemory = commandBody(msg, ["/处理候选记忆", "处理候选记忆"]);
    if (processMemory !== null) return reply(processPendingMemoryCandidates(msg, processMemory));
    const applyMemory = commandBody(msg, ["/应用候选记忆", "应用候选记忆"]);
    if (applyMemory !== null) return reply(applyPendingMemoryCandidates(msg, applyMemory));
    const skipMemory = commandBody(msg, ["/跳过候选记忆", "跳过候选记忆"]);
    if (skipMemory !== null) return reply(skipPendingMemoryCandidates(msg, skipMemory));
    const recentFile = commandBody(msg, ["/最近文件", "最近文件"]);
    if (recentFile !== null) return reply(recentFilesCommand(msg));
    const findFile = commandBody(msg, ["/找文件", "找文件"]);
    if (findFile !== null) return reply(findFiles(msg, findFile));
    const quiet = commandBody(msg, ["/安静", "安静"]);
    if (quiet !== null) return reply(setQuiet(msg, quiet));
    const resume = commandBody(msg, ["/恢复", "恢复"]);
    if (resume !== null) return reply(resumeGroup(msg));
    const queue = commandBody(msg, ["/队列", "队列"]);
    if (queue !== null) return reply(queueStatus(msg));
    const mode = commandBody(msg, ["/模式", "模式"]);
    if (mode !== null) return reply(setMode(msg, mode));
    const admin = commandBody(msg, ["/admin", "/管理", "管理"]);
    if (admin !== null) return reply(adminCommand(msg, admin));
    const errors = commandBody(msg, ["/最近错误", "最近错误"]);
    if (errors !== null) return reply(recentErrors());
  }

  function proxyHelpText(isPrivate, query = "") {
    const visible = HELP_ENTRIES.filter((entry) => entry.scope === "all" || (isPrivate ? entry.scope === "private" : entry.scope === "group"));
    const q = String(query || "").trim().toLowerCase();
    const matches = q ? visible.filter((entry) => helpHaystack(entry).includes(q)) : visible;
    if (q && matches.length === 0) {
      return `没有找到相关命令：${query}`;
    }
    const picked = q ? matches.slice(0, 10) : defaultHelpEntries(visible, isPrivate);
    const head = q ? `命令搜索：${query}` : "可用命令：";
    const tail = q ? [] : ["提示：用 /help 关键词 或 /命令 关键词 搜索，例如 /help 待办。"];
    return [
      head,
      ...picked.map((entry) => `${entry.title}：${entry.detail}`),
      ...tail
    ].join("\n").slice(0, 1600);
  }

  function proxyStatusText(msg) {
    const snap = deps.healthSnapshot();
    const key = deps.imageStateKey(msg);
    const img = deps.imageStates.get(key) || { active: 0, queue: [] };
    return [
      `QQ 代理：${snap.ok ? "正常" : "异常"}`,
      `OneBot：${snap.upstream.ready ? "已连接" : "未连接"}`,
      `待发送：${snap.pending.upstream_queue}，待回执：${snap.pending.outbound}`,
      `画图：运行 ${img.active}，排队 ${img.queue.length}`,
      `触发模式：${msg.message_type === "group" ? deps.effectiveListenMode(msg.group_id) : deps.defaultListenMode}`,
      `@-only：${msg.message_type === "group" && deps.atOnlyGroups.includes(Number(msg.group_id)) ? "是" : "否"}`,
      `静默：${msg.message_type === "group" && deps.isGroupQuiet(msg.group_id) ? "开启" : "关闭"}`,
      `管理员白名单：${deps.adminUsers.length ? `${deps.adminUsers.length} 人` : "未启用"}`,
      `允许群：${deps.allowedGroups.length} 个，私聊：${deps.allowedPrivateUsers.length} 个`,
      ...formatCapabilitySummary(deps.capabilitySnapshot && deps.capabilitySnapshot()),
      `结构化错误：${deps.recentErrorFile || "未配置"}`
    ].join("\n");
  }

  function workspaceCommand(msg, body) {
    const text = String(body || "").trim();
    if (/^(体检|health|audit|checkup)$/i.test(text)) {
      return workspaceHealth(msg);
    }
    if (text) {
      return "用法：/工作区 或 /工作区 体检";
    }
    return workspaceOverview(msg);
  }

  function workspaceOverview(msg) {
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const mem = memoryStats({ workspace });
    const pending = pendingCandidateStats({ workspace });
    const todos = todoStats({ workspace });
    const proposals = proposalStats({ workspace });
    const todoCandidates = readPendingCandidates({ workspace }).filter(isTodoCandidate).length;
    const indexedFiles = readFileIndex(workspace);
    const files = recentFiles({ workspace, limit: 3 });
    const kinds = Object.entries(mem.byKind || {})
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => `${kind}:${count}`)
      .join("，") || "暂无";
    const latestFiles = files.length ? files.map((item) => item.name || path.basename(item.relative_path || "")).join("，") : "暂无";
    return deps.maskSensitive([
      "当前概览：",
      `范围：${msg.message_type === "group" ? `群 ${msg.group_id}` : `私聊 ${msg.user_id}`}`,
      `记忆：有效 ${mem.active} / 总 ${mem.total}，软删 ${mem.deleted}，分类 ${kinds}`,
      `候选记忆：待处理 ${pending.active}，已应用 ${pending.applied}，已跳过 ${pending.skipped}`,
      `建议箱：open ${proposals.byStatus.open || 0}，accepted ${proposals.byStatus.accepted || 0}，done ${proposals.byStatus.done || 0}`,
      `待办：未完成 ${todos.active}，已完成 ${todos.done}，候选 ${todoCandidates}，坏行 ${todos.bad_lines || 0}`,
      `文件：已索引 ${indexedFiles.length}，最新 ${files.length} 个：${latestFiles}`,
      `入口：/记忆 关键词，/候选记忆，/建议箱，/待办，/最近文件，/证据 关键词${msg.message_type === "group" ? "，/dream" : ""}`
    ].join("\n").slice(0, 1600));
  }

  function workspaceHealth(msg) {
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const pending = pendingCandidateStats({ workspace });
    const pendingHealth = pendingCandidateHealth({ workspace });
    const sensitiveCandidates = (pendingHealth.anomalies || []).filter(({ flags }) => (flags || []).includes("疑似敏感")).length;
    const todos = todoStats({ workspace });
    const proposals = proposalStats({ workspace });
    const files = fileStats({ workspace });
    const latestSnapshot = latestPendingCandidateSnapshot({ workspace });
    const errorScope = msg.message_type === "group" ? "group" : "private";
    const errorTarget = msg.message_type === "group" ? String(msg.group_id) : String(msg.user_id || "");
    const errors = recentErrorStats({ file: deps.recentErrorFile, scope: errorScope, target: errorTarget, limit: 200 });
    const openProposals = proposals.byStatus.open || 0;
    const acceptedProposals = proposals.byStatus.accepted || 0;
    return deps.maskSensitive([
      "工作区体检：",
      `范围：${msg.message_type === "group" ? `群 ${msg.group_id}` : `私聊 ${msg.user_id}`}`,
      `候选记忆：active ${pending.active} / applied ${pending.applied} / skipped ${pending.skipped}，疑似敏感 ${sensitiveCandidates}，重复 ${pendingHealth.duplicateFingerprints || 0}`,
      `待办：open ${todos.active} / done ${todos.done}，坏行 ${todos.bad_lines || 0}`,
      `提案：open ${openProposals} / accepted ${acceptedProposals} / done ${proposals.byStatus.done || 0} / skipped ${proposals.byStatus.skipped || 0}`,
      `文件索引：${files.total} 条，坏行 ${files.bad_lines || 0}，已提取 ${files.extracted || 0}`,
      `最近快照：${latestSnapshot ? `${latestSnapshot.snapshot} (${shortTime(latestSnapshot.time)}，active ${latestSnapshot.active})` : "暂无"}`,
      `最近错误：当前 ${errors.current}，全局 ${errors.global}`,
      `下一步：/候选记忆 快照，/候选记忆 分拣，/建议箱 本轮`
    ].join("\n").slice(0, 1600));
  }

  function workspaceReviewPacket(msg, body) {
    if (String(body || "").trim()) {
      return "用法：/审查包";
    }
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const mem = memoryStats({ workspace });
    const pending = pendingCandidateStats({ workspace });
    const pendingHealth = pendingCandidateHealth({ workspace });
    const sensitiveCandidates = (pendingHealth.anomalies || []).filter(({ flags }) => (flags || []).includes("疑似敏感")).length;
    const todos = todoStats({ workspace });
    const proposals = proposalStats({ workspace });
    const roundPick = pickProposalForRound({ workspace });
    const roundFocus = reviewPacketFocus({ workspace, roundPick });
    const roundProposal = formatRoundProposal(roundPick);
    const files = fileStats({ workspace });
    const latestSnapshot = latestPendingCandidateSnapshot({ workspace });
    const errorScope = msg.message_type === "group" ? "group" : "private";
    const errorTarget = msg.message_type === "group" ? String(msg.group_id) : String(msg.user_id || "");
    const errors = recentErrorStats({ file: deps.recentErrorFile, scope: errorScope, target: errorTarget, limit: 200 });
    const evidenceLines = reviewPacketEvidence({
      workspace,
      errorFile: deps.recentErrorFile,
      errorScope,
      errorTarget,
      roundPick,
      maskSensitive: deps.maskSensitive
    });
    return sanitizeSummaryText([
      "子 agent 审查包：",
      "边界：NapCat/OneBot + onebot-group-proxy + cc-connect + 本地 groups/users workspace；不切官方 QQ Bot。",
      "边界：面向认识的人和群，QQ号/群号不是敏感；secrets/tokens/cookies 是敏感。",
      "边界：低成本确定性优先；不要常驻向量库、每消息 LLM 总结、自动递归自部署、本地 LLM daemon。",
      `范围：${msg.message_type === "group" ? `group:${msg.group_id}` : `private:${msg.user_id}`}`,
      `记忆：active ${mem.active} / total ${mem.total} / deleted ${mem.deleted}`,
      `候选记忆：active ${pending.active} / applied ${pending.applied} / skipped ${pending.skipped} / sensitive ${sensitiveCandidates} / duplicate ${pendingHealth.duplicateFingerprints || 0}`,
      `待办：open ${todos.active} / done ${todos.done}`,
      `提案：open ${proposals.byStatus.open || 0} / accepted ${proposals.byStatus.accepted || 0} / done ${proposals.byStatus.done || 0} / skipped ${proposals.byStatus.skipped || 0}`,
      roundFocus,
      ...evidenceLines,
      roundProposal,
      `文件索引：total ${files.total} / extracted ${files.extracted || 0} / bad ${files.bad_lines || 0}`,
      `快照：${latestSnapshot ? `${latestSnapshot.snapshot} active ${latestSnapshot.active}` : "none"}`,
      `错误：current ${errors.current} / global ${errors.global} / kinds ${formatCounts(errors.byKind)}`,
      "审查任务：只提一个低成本、确定性、当前 workspace scoped 的下一步；说明是否值得做；不要建议已完成项或重架构。",
      "入口：/工作区 体检；/候选记忆 分拣；/候选记忆 快照；/建议箱 本轮"
    ].join("\n").slice(0, 2000));
  }

  function policyDriftCommand(body) {
    if (String(body || "").trim()) {
      return "用法：/口径巡检";
    }
    const root = path.resolve(__dirname, "..", "..");
    return formatPolicyDrift(scanPolicyDrift({ root, limit: 12 }));
  }

  function rememberFact(msg, body) {
    const fact = String(body || "").trim();
    if (!fact) return "用法：/记住 这个群默认短答，先给结论";
    const now = new Date().toISOString();
    if (msg.message_type === "group") {
      const workspace = deps.workspaceForGroup(msg.group_id);
      deps.ensureGroupProfile(workspace, msg.group_id);
      addMemory({
        workspace,
        scope: "group",
        scopeID: String(msg.group_id),
        subject: String(msg.group_id),
        kind: inferKind(fact),
        text: fact,
        sourceMessageID: msg.message_id || ""
      });
      addMemory({
        workspace,
        scope: "member",
        scopeID: String(msg.group_id),
        subject: String(msg.user_id || ""),
        kind: inferKind(fact),
        text: fact,
        sourceMessageID: msg.message_id || ""
      });
      deps.appendLine(path.join(workspace, "GROUP_PROFILE.md"), `- ${now} 群偏好/事实: ${fact}`);
      deps.appendLine(deps.memberProfilePath(msg, workspace), `- ${now} 用户补充: ${fact}`);
      return "已记住，后续会按这个偏好处理。";
    }
    const workspace = deps.workspaceForPrivateUser(msg.user_id);
    deps.ensurePrivateProfile(workspace, msg);
    addMemory({
      workspace,
      scope: "private",
      scopeID: String(msg.user_id || ""),
      subject: String(msg.user_id || ""),
      kind: inferKind(fact),
      text: fact,
      sourceMessageID: msg.message_id || ""
    });
    deps.appendLine(path.join(workspace, "PROFILE.md"), `- ${now} 用户补充: ${fact}`);
    return "已记住。";
  }

  function searchMemoryCommand(msg, body) {
    const query = String(body || "").trim();
    if (/^(状态|stats|status)$/i.test(query)) {
      const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
      return formatMemoryStats(memoryStats({ workspace }));
    }
    if (/^(规则|rules|rule)$/i.test(query)) {
      return formatMemoryRuleGuide();
    }
    const inspectMatch = query.match(/^(预检|check|inspect)\s+([\s\S]+)$/i);
    if (/^(预检|check|inspect)$/i.test(query)) {
      return "用法：/记忆 预检 文本";
    }
    if (inspectMatch) {
      return deps.maskSensitive(formatMemoryRuleInspection(inspectMemoryRule(inspectMatch[2])));
    }
    const recentMatch = query.match(/^(最近|latest|recent)(?:\s+(\d+))?$/i);
    if (/^(最近|latest|recent)\s+\S+/i.test(query) && !recentMatch) {
      return "用法：/记忆 最近 [数量]，数量范围 1-10。";
    }
    if (recentMatch) {
      const limit = recentMatch[2] ? Number(recentMatch[2]) : 5;
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
        return "用法：/记忆 最近 [数量]，数量范围 1-10。";
      }
      const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
      const subject = msg.message_type === "private" ? String(msg.user_id || "") : "";
      return deps.maskSensitive(formatRecentMemories(searchMemories({ workspace, subject, limit })));
    }
    if (!query) return "用法：/记忆 关键词";
    if (/^(search|find|查|找)\s+/i.test(query)) {
      return sharedCommand(msg, ["/memory", ...query.split(/\s+/)]);
    }
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const subject = msg.message_type === "private" ? String(msg.user_id || "") : "";
    return formatMemories(searchMemories({ workspace, query, subject, limit: 10 }));
  }

  function memoryEvidenceCommand(msg, body) {
    const query = String(body || "").trim();
    if (!query) return "用法：/证据 关键词";
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const subject = msg.message_type === "private" ? String(msg.user_id || "") : "";
    return deps.maskSensitive(formatMemoryEvidence(searchMemoryEvidence({ workspace, query, subject, limit: 8 })));
  }

  function proposalCommand(msg, body) {
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const scope = msg.message_type === "group" ? "group" : "private";
    const scopeID = msg.message_type === "group" ? String(msg.group_id) : String(msg.user_id || "");
    const text = String(body || "").trim();
    if (!text || /^(list|列表|ls)$/i.test(text)) {
      return deps.maskSensitive(formatProposals(listProposals({ workspace, status: "open", limit: 10 })));
    }
    if (/^(状态|stats|status)$/i.test(text)) {
      return formatProposalStats(proposalStats({ workspace }));
    }
    if (/^(本轮|round|next)$/i.test(text)) {
      return deps.maskSensitive(formatRoundProposal(pickProposalForRound({ workspace })));
    }
    if (/^(待落地|landable|todoable)$/i.test(text)) {
      return deps.maskSensitive(formatLandableProposals(listLandableProposals({ workspace, landedIDs: sourceProposalIDs({ workspace }), limit: 10 })));
    }
    const checkMatch = text.match(/^(check|预检)\s+(.+)$/i);
    if (/^(check|预检)$/i.test(text)) {
      return "用法：/提案 check ID";
    }
    if (checkMatch) {
      return deps.maskSensitive(formatProposalCheck(checkProposal({ workspace, selector: checkMatch[2] })));
    }
    const linkMatch = text.match(/^(关联|link)\s+(\S+)(?:\s+(\S+)\s+(.+))?$/i);
    if (/^(关联|link)$/i.test(text)) {
      return "用法：/提案 关联 ID 命令|测试|文件|错误|提案 内容";
    }
    if (linkMatch) {
      if (!linkMatch[3]) {
        return deps.maskSensitive(formatProposalLinksCommand(getProposal({ workspace, selector: linkMatch[2] })));
      }
      return deps.maskSensitive(formatProposalLinkResult(addProposalLink({
        workspace,
        selector: linkMatch[2],
        kind: linkMatch[3],
        value: linkMatch[4] || "",
        userID: String(msg.user_id || "")
      })));
    }
    const exportMatch = text.match(/^(导出|export)(?:\s+(\S+))?$/i);
    if (/^(导出|export)\s+\S+\s+\S+/i.test(text)) {
      return "用法：/提案 导出 [数量|all]，数量范围 1-20。";
    }
    if (exportMatch) {
      const arg = String(exportMatch[2] || "").trim().toLowerCase();
      if (arg && arg !== "all") {
        const limit = Number(arg);
        if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
          return "用法：/提案 导出 [数量|all]，数量范围 1-20。";
        }
        return deps.maskSensitive(formatProposalExport(exportProposals({ workspace, mode: "open", limit })));
      }
      return deps.maskSensitive(formatProposalExport(exportProposals({ workspace, mode: arg === "all" ? "all" : "open", limit: 10 })));
    }
    const landMatch = text.match(/^(落地|land)\s+(\S+)$/i);
    if (/^(落地|land)$/i.test(text)) {
      return "用法：/建议箱 落地 ID";
    }
    if (landMatch) {
      return deps.maskSensitive(landProposalToTodo({
        workspace,
        selector: landMatch[2],
        scope,
        scopeID,
        userID: String(msg.user_id || "")
      }));
    }
    const addMatch = text.match(/^(add|新增|添加)\s+(.+)$/i);
    if (/^(add|新增|添加)$/i.test(text)) {
      return "用法：/建议箱 add 标题 | 正文";
    }
    if (addMatch) {
      const parsed = parseProposalInput(addMatch[2]);
      const item = addProposal({
        workspace,
        scope,
        scopeID,
        userID: String(msg.user_id || ""),
        title: parsed.title,
        body: parsed.body,
        sourceMessageID: msg.message_id || ""
      });
      if (!item) return "建议标题为空。";
      if (item.duplicate) return deps.maskSensitive(formatDuplicateProposal(item.existing));
      return `已加入建议箱：${deps.maskSensitive(item.title)}`;
    }
    const searchMatch = text.match(/^(search|find|搜索)\s+(.+)$/i);
    if (/^(search|find|搜索)$/i.test(text)) {
      return "用法：/建议箱 search 关键词";
    }
    if (searchMatch) {
      return deps.maskSensitive(formatProposals(searchProposals({ workspace, query: searchMatch[2], limit: 10 }), "建议搜索"));
    }
    const showMatch = text.match(/^(show|详情|查看)\s+(.+)$/i);
    if (/^(show|详情|查看)$/i.test(text)) {
      return "用法：/建议箱 show ID";
    }
    if (showMatch) {
      return deps.maskSensitive(formatProposal(getProposal({ workspace, selector: showMatch[2] })));
    }
    const statusMatch = text.match(/^(accept|采纳|accepted|skip|跳过|skipped|done|完成)\s+(\S+)(?:\s+(.+))?$/i);
    if (/^(accept|采纳|accepted|skip|跳过|skipped|done|完成)$/i.test(text)) {
      return "用法：/建议箱 accept|skip|done ID [原因]";
    }
    if (statusMatch) {
      const next = proposalStatusAlias(statusMatch[1]);
      const result = updateProposalStatus({
        workspace,
        selector: statusMatch[2],
        status: next,
        userID: String(msg.user_id || ""),
        reason: statusMatch[3] || ""
      });
      return result.updated > 0 ? `建议已标记为 ${next}。` : "没有找到这条建议。";
    }
    return "用法：/建议箱 add 标题 | 正文；/建议箱 list；/建议箱 search 关键词；/建议箱 show ID；/建议箱 accept|skip|done ID；/建议箱 落地 ID";
  }

  function landProposalToTodo({ workspace, selector, scope, scopeID, userID }) {
    const item = getProposal({ workspace, selector });
    if (!item) {
      return "没有找到这条建议。";
    }
    if (item.status !== "accepted") {
      return `只有 accepted 提案可以落地为待办。当前状态：${item.status}`;
    }
    const check = checkProposal({ workspace, selector: item.id });
    if (check.blockers.length > 0) {
      return [
        "提案预检未通过，不能落地为待办：",
        ...check.blockers.map((blocker) => `- ${blocker}`)
      ].join("\n").slice(0, 1200);
    }
    const existing = findTodoBySourceProposal({ workspace, proposalID: item.id });
    if (existing) {
      return `这条建议已落地为待办：${shortID(existing.id)}。`;
    }
    const todo = addTodo({
      workspace,
      scope,
      scopeID,
      userID,
      text: `提案落地：${item.title}`,
      sourceProposal: item
    });
    if (!todo) {
      return "落地失败：待办内容为空。";
    }
    updateProposalStatus({
      workspace,
      selector: item.id,
      status: "done",
      userID,
      reason: `landed-to-todo:${todo.id}`
    });
    return `已落地为待办：${shortID(todo.id)}，提案已标记 done。`;
  }

  function parseProposalInput(text) {
    const parts = String(text || "").split(/\s+\|\s+|\s*[|｜]\s*/);
    const title = (parts.shift() || "").trim();
    return { title, body: parts.join(" | ").trim() };
  }

  function proposalStatusAlias(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "accept" || raw === "accepted" || raw === "采纳") return "accepted";
    if (raw === "skip" || raw === "skipped" || raw === "跳过") return "skipped";
    if (raw === "done" || raw === "完成") return "done";
    return "";
  }

  function todoCommand(msg, body) {
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const scope = msg.message_type === "group" ? "group" : "private";
    const scopeID = msg.message_type === "group" ? String(msg.group_id) : String(msg.user_id || "");
    const text = String(body || "").trim();
    if (!text || /^(list|列表|ls)$/i.test(text)) {
      return deps.maskSensitive(formatTodos(listTodos({ workspace, limit: 10 })));
    }
    if (/^(状态|stats|status)$/i.test(text)) {
      return formatTodoStats(todoStats({ workspace }));
    }
    const doneListMatch = text.match(/^(已完成|done-list|completed)(?:\s+(\S+))?$/i);
    if (/^(已完成|done-list|completed)\s+\S+\s+\S+/i.test(text)) {
      return "用法：/待办 已完成 [数量]，数量范围 1-20。";
    }
    if (doneListMatch) {
      const limit = doneListMatch[2] ? Number(doneListMatch[2]) : 5;
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
        return "用法：/待办 已完成 [数量]，数量范围 1-20。";
      }
      return deps.maskSensitive(formatDoneTodos(listDoneTodos({ workspace, limit })));
    }
    const searchMatch = text.match(/^(搜索|search|find)\s+(.+)$/i);
    if (/^(搜索|search|find)$/i.test(text)) {
      return "用法：/待办 搜索 关键词";
    }
    if (searchMatch) {
      return deps.maskSensitive(formatTodoSearch(searchTodos({ workspace, query: searchMatch[2], limit: 10 })));
    }
    if (/^(候选|candidates?)$/i.test(text)) {
      return deps.maskSensitive(formatTodoCandidates(readTodoCandidates(workspace)));
    }
    const applyCandidateMatch = text.match(/^(应用候选|apply-candidate|apply-candidates?)\s+(.+)$/i);
    if (/^(应用候选|apply-candidate|apply-candidates?)$/i.test(text)) {
      return "用法：/待办 应用候选 序号|all";
    }
    if (applyCandidateMatch) {
      const result = applyPendingCandidatesWith({
        workspace,
        selector: applyCandidateMatch[2],
        appliedBy: String(msg.user_id || ""),
        filter: isTodoCandidate,
        applyItem: (candidate) => Boolean(addTodo({
          workspace,
          scope,
          scopeID,
          userID: String(msg.user_id || ""),
          text: candidate.text,
          sourceCandidate: candidate
        }))
      });
      return result.applied > 0 ? `已从候选添加 ${result.applied} 条待办。` : "没有找到可应用的待办候选。";
    }
    const doneMatch = text.match(/^(done|完成|finish)\s+(.+)$/i);
    if (/^(done|完成|finish)$/i.test(text)) {
      return "用法：/待办 done 序号|id";
    }
    if (doneMatch) {
      const result = completeTodos({ workspace, selector: doneMatch[2], doneBy: String(msg.user_id || "") });
      return result.done > 0 ? `已完成 ${result.done} 条待办。` : "没有找到可完成的待办。";
    }
    const addMatch = text.match(/^(add|新增|添加)\s+(.+)$/i);
    const content = addMatch ? addMatch[2] : text;
    if (/^(add|新增|添加)$/i.test(text) || !content.trim()) {
      return "用法：/待办 add 内容";
    }
    const item = addTodo({
      workspace,
      scope,
      scopeID,
      userID: String(msg.user_id || ""),
      text: content,
      sourceMessageID: msg.message_id || ""
    });
    return item ? `已添加待办：${deps.maskSensitive(item.text)}` : "待办内容为空。";
  }

  function readTodoCandidates(workspace) {
    return readPendingCandidates({ workspace })
      .filter(isTodoCandidate)
      .slice(-10);
  }

  function isTodoCandidate(item) {
    return item && !item.applied_at && !item.skipped_at && String(item.kind || "").toLowerCase() === "todo";
  }

  function formatTodoCandidates(items) {
    const active = items || [];
    if (active.length === 0) {
      return "暂无可应用的待办候选。";
    }
    return [
      "待办候选：",
      ...active.map((item, index) => `- ${index + 1}. ${item.user || item.subject_id || "unknown"}: ${String(item.text || "").slice(0, 100)}`)
    ].join("\n").slice(0, 1600);
  }

  function defaultHelpEntries(visible, isPrivate) {
    const wanted = [
      "/help [关键词]",
      "/概览",
      "/status",
      "/记住 内容",
      "/记忆 关键词",
      "/证据 关键词",
      "/建议箱",
      "/待办",
      "/待办 候选",
      "/文件",
      "/最近文件",
      "/找文件 关键词",
      "/最近错误",
      isPrivate ? "/admin" : "/dream 或 做梦"
    ];
    const byTitle = new Map(visible.map((entry) => [entry.title, entry]));
    return wanted.map((title) => byTitle.get(title)).filter(Boolean);
  }

  function sharedFilesCommand(msg, body) {
    const text = String(body || "").trim();
    if (!text) return sharedCommand(msg, ["/files"]);
    return sharedCommand(msg, ["/files", ...text.split(/\s+/)]);
  }

  function localFileCommand(msg, body) {
    const text = String(body || "").trim();
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    if (!text || /^(状态|status)$/i.test(text)) {
      return deps.maskSensitive(formatFileStats(fileStats({ workspace })));
    }
    if (/^(最近|recent)$/i.test(text)) {
      return formatFileList(recentFiles({ workspace, limit: 8 }), "最近文件");
    }
    return "用法：/文件 或 /文件 状态。查找文件用 /找文件 关键词。";
  }

  function sharedCommand(msg, words) {
    const script = process.env.OPENCLAW_COMMAND_SCRIPT || "";
    if (!script) {
      return "共享索引命令未启用：需要设置 OPENCLAW_COMMAND_SCRIPT。";
    }
    const maxConcurrent = Math.max(1, Number(process.env.OPENCLAW_COMMAND_MAX_CONCURRENT || 1));
    if (sharedCommandActive >= maxConcurrent) {
      return "共享索引正在处理其他请求，请稍后再试。";
    }
    const root = process.env.OPENCLAW_COMMAND_ROOT || deps.projectRoot || process.cwd();
    const workspace = msg.message_type === "group"
      ? workspaceNameForPath(deps.workspaceForGroup(msg.group_id))
      : workspaceNameForPath(deps.workspaceForPrivateUser(msg.user_id));
    const args = [script, "--root", root];
    if (workspace) {
      args.push("--workspace", workspace);
    }
    args.push(...words);
    sharedCommandActive += 1;
    try {
      const proc = spawnSync(process.env.OPENCLAW_COMMAND_PYTHON || "python3", args, {
        encoding: "utf8",
        timeout: Number(process.env.OPENCLAW_COMMAND_TIMEOUT_MS || 8000),
        maxBuffer: Number(process.env.OPENCLAW_COMMAND_MAX_BUFFER || 1024 * 1024)
      });
      if (proc.error) return `共享索引命令失败：${proc.error.message}`;
      const output = String(proc.stdout || "").trim();
      const err = String(proc.stderr || "").trim();
      if (proc.status !== 0 && !output) {
        return `共享索引命令失败：${err || `exit ${proc.status}`}`;
      }
      return (output || err || "共享索引命令无输出").slice(0, 1800);
    } finally {
      sharedCommandActive -= 1;
    }
  }

  function showProfile(msg, body) {
    const keyword = String(body || "").trim().toLowerCase();
    if (msg.message_type === "group") {
      const workspace = deps.workspaceForGroup(msg.group_id);
      const groupLines = readProfileLines(path.join(workspace, "GROUP_PROFILE.md"), keyword, 8);
      const memberLines = readProfileLines(deps.memberProfilePath(msg, workspace), keyword, 8);
      return [
        "当前画像：",
        "群偏好/事实：",
        ...(groupLines.length ? groupLines : ["- 暂无"]),
        "你的偏好/补充：",
        ...(memberLines.length ? memberLines : ["- 暂无"]),
        "提示：用 /记住 内容 补充；用 /忘记 关键词 删除。"
      ].join("\n").slice(0, 1600);
    }

    const workspace = deps.workspaceForPrivateUser(msg.user_id);
    const lines = readProfileLines(path.join(workspace, "PROFILE.md"), keyword, 12);
    return [
      "当前个人画像：",
      ...(lines.length ? lines : ["- 暂无"]),
      "提示：用 /记住 内容 补充；用 /忘记 关键词 删除。"
    ].join("\n").slice(0, 1400);
  }

  function forgetFact(msg, body) {
    const keyword = String(body || "").trim();
    if (!keyword) return "用法：/忘记 关键词";
    const files = [];
    if (msg.message_type === "group") {
      const workspace = deps.workspaceForGroup(msg.group_id);
      files.push(path.join(workspace, "GROUP_PROFILE.md"));
      files.push(deps.memberProfilePath(msg, workspace));
    } else {
      files.push(path.join(deps.workspaceForPrivateUser(msg.user_id), "PROFILE.md"));
    }
    let removed = 0;
    if (msg.message_type === "group") {
      const workspace = deps.workspaceForGroup(msg.group_id);
      removed += softDeleteMemories({ workspace, query: keyword });
    } else {
      const workspace = deps.workspaceForPrivateUser(msg.user_id);
      removed += softDeleteMemories({ workspace, query: keyword, subject: String(msg.user_id || ""), scope: "private" });
    }
    for (const file of files) {
      removed += deps.removeLinesContaining(file, keyword);
    }
    return removed > 0 ? `已删除 ${removed} 条匹配记录。` : "没找到匹配记录。";
  }

  function todaySummary(msg) {
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const file = path.join(workspace, "memory", `chat-${deps.todayLocal()}.jsonl`);
    if (!fs.existsSync(file)) return "今天还没有可总结的聊天记录。";
    const rows = readJSONLines(file).slice(-300);
    if (rows.length === 0) return "今天聊天记录为空。";
    const byUser = new Map();
    const samples = [];
    for (const row of rows) {
      const user = String((row.sender && (row.sender.card || row.sender.nickname)) || row.user_id || "unknown");
      byUser.set(user, (byUser.get(user) || 0) + 1);
      const text = String(row.text || "").trim();
      if (text && !text.startsWith("/status") && !text.startsWith("/help")) {
        samples.push({ user, text: sanitizeSummaryText(text), time: row.time || "" });
      }
    }
    const active = [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([user, count]) => `${user} ${count}`).join("，");
    const keywords = topKeywords(samples.map((item) => item.text).join("\n")).slice(0, 8).join("、") || "暂无";
    const recent = samples.slice(-6).map((item) => `- ${item.user}: ${item.text.slice(0, 80)}`);
    const decisions = pickLines(samples, /(决定|结论|就这样|采用|确认|同意|final|方案)/i, 4);
    const todos = pickLines(samples, /(todo|待办|要做|需要|记得|明天|今晚|deadline|截止|帮我|修|改|查)/i, 5);
    const issues = pickLines(samples, /(报错|错误|失败|问题|卡住|不行|timeout|failed|error|bug)/i, 5);
    const files = pickLines(samples, /(文件|pdf|docx|xlsx|图片|上传|归档|代码|脚本|\.py|\.md|\.pdf)/i, 5);
    const memoryCandidates = memoryCandidatesFromSamples(samples.slice().reverse(), { limit: 6 });
    savePendingCandidates({
      workspace,
      scope: msg.message_type === "group" ? "group" : "private",
      scopeID: msg.message_type === "group" ? String(msg.group_id) : String(msg.user_id || ""),
      candidates: memoryCandidates
    });
    return [
      `今日记录 ${rows.length} 条。`,
      `活跃成员：${active || "暂无"}`,
      `高频主题：${keywords}`,
      "待办/请求：",
      ...(todos.length ? todos : ["- 暂无"]),
      "问题/风险：",
      ...(issues.length ? issues : ["- 暂无"]),
      "文件/产物：",
      ...(files.length ? files : ["- 暂无"]),
      "决策/结论：",
      ...(decisions.length ? decisions : ["- 暂无"]),
      "候选可沉淀记忆（未自动写入）：",
      ...formatMemoryCandidates(memoryCandidates),
      "最近片段：",
      ...recent
    ].join("\n").slice(0, 1800);
  }

  function showPendingMemoryCandidates(msg) {
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const body = commandBody(msg, ["/候选记忆", "候选记忆"]);
    if (/^(状态|stats|status)$/i.test(String(body || "").trim())) {
      return formatPendingCandidateStats(pendingCandidateStats({ workspace }));
    }
    if (/^(快照|snapshot)$/i.test(String(body || "").trim())) {
      return deps.maskSensitive(formatPendingCandidateSnapshot(pendingCandidateSnapshot({ workspace })));
    }
    const compareMatch = String(body || "").trim().match(/^(对比|compare)\s+(\S+)$/i);
    if (/^(对比|compare)$/i.test(String(body || "").trim())) {
      return "用法：/候选记忆 对比 snapshot_sha";
    }
    if (compareMatch) {
      return formatPendingCandidateSnapshotCompare(comparePendingCandidateSnapshot({ workspace, snapshot: compareMatch[2] }));
    }
    const diffMatch = String(body || "").trim().match(/^(差异|diff)\s+(\S+)$/i);
    if (/^(差异|diff)$/i.test(String(body || "").trim())) {
      return "用法：/候选记忆 差异 snapshot_sha";
    }
    if (diffMatch) {
      return deps.maskSensitive(formatPendingCandidateSnapshotDiff(diffPendingCandidateSnapshot({ workspace, snapshot: diffMatch[2] })));
    }
    if (/^(体检|health|checkup|audit)$/i.test(String(body || "").trim())) {
      return deps.maskSensitive(formatPendingCandidateHealth(pendingCandidateHealth({ workspace })));
    }
    if (/^(分拣|triage|sort)$/i.test(String(body || "").trim())) {
      return deps.maskSensitive(formatPendingCandidateTriage(pendingCandidateTriage({ workspace })));
    }
    const query = String(body || "").trim();
    return deps.maskSensitive(query
      ? formatPendingCandidateSearch(searchPendingCandidates({ workspace, query }))
      : formatPendingCandidates(readPendingCandidates({ workspace })));
  }

  function applyPendingMemoryCandidates(msg, body) {
    const selector = String(body || "").trim();
    if (!selector) return "用法：/应用候选记忆 序号|all";
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const result = applyPendingCandidates({
      workspace,
      selector,
      appliedBy: String(msg.user_id || ""),
      scopeID: msg.message_type === "group" ? String(msg.group_id) : String(msg.user_id || "")
    });
    return formatPendingCandidateApplyResult(result);
  }

  function processPendingMemoryCandidates(msg, body) {
    const text = String(body || "").trim();
    const applySelector = selectorAfterLabel(text, ["应用", "apply"]);
    const skipSelector = selectorAfterLabel(text, ["跳过", "skip"]);
    if (!applySelector && !skipSelector) {
      return "用法：/处理候选记忆 应用:1,2 跳过:3,4";
    }
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const result = processPendingCandidatesBatch({
      workspace,
      applySelector,
      skipSelector,
      actedBy: String(msg.user_id || ""),
      scopeID: msg.message_type === "group" ? String(msg.group_id) : String(msg.user_id || "")
    });
    return formatPendingCandidateBatchResult(result);
  }

  function skipPendingMemoryCandidates(msg, body) {
    const selector = String(body || "").trim();
    if (!selector) return "用法：/跳过候选记忆 序号|all";
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const result = skipPendingCandidates({
      workspace,
      selector,
      skippedBy: String(msg.user_id || "")
    });
    return result.skipped > 0 ? `已跳过 ${result.skipped} 条候选记忆。` : "没有可跳过的候选。";
  }

  function findFiles(msg, query) {
    const keyword = String(query || "").trim().toLowerCase();
    if (!keyword) return "用法：/找文件 关键词";
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const indexed = searchFiles({ workspace, query: keyword, limit: 8 });
    if (indexed.length > 0) {
      return formatFileList(indexed, "找到这些文件");
    }
    const candidates = [];
    collectFileIndexMatches(workspace, keyword, candidates);
    collectArchiveSummaryMatches(workspace, keyword, candidates);
    if (candidates.length === 0) return "没找到匹配文件。";
    return ["找到这些文件：", ...candidates.slice(0, 8).map((item) => `- ${item}`)].join("\n").slice(0, 1400);
  }

  function recentFilesCommand(msg) {
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    return formatFileList(recentFiles({ workspace, limit: 8 }), "最近文件");
  }

  function setQuiet(msg, body) {
    if (msg.message_type !== "group") return "静默只对群聊生效。";
    if (!canAdmin(msg)) return "没有权限。";
    const minutes = parseDurationMinutes(body || "30分钟");
    const until = Date.now() + minutes * 60 * 1000;
    deps.quietUntilByGroup.set(Number(msg.group_id), until);
    deps.persistProxyState();
    return `已安静 ${minutes} 分钟。期间只响应 @、回复和命令。`;
  }

  function resumeGroup(msg) {
    if (msg.message_type !== "group") return "恢复只对群聊生效。";
    if (!canAdmin(msg)) return "没有权限。";
    deps.quietUntilByGroup.delete(Number(msg.group_id));
    deps.persistProxyState();
    return "已恢复群内主动回复。";
  }

  function queueStatus(msg) {
    const imageKey = deps.imageStateKey(msg);
    const img = deps.imageStates.get(imageKey) || { active: 0, queue: [] };
    let listen = { busy: false, queue: [] };
    if (msg.message_type === "group") {
      listen = deps.listenStates.get(Number(msg.group_id)) || listen;
    }
    return [
      `上游待发：${deps.pending.length}`,
      `待回执：${deps.pendingOutbound.size}`,
      `文件下载：${deps.pendingFileDownloads.size}`,
      `画图：运行 ${img.active}，排队 ${img.queue.length}`,
      `监听：${listen.busy ? "处理中" : "空闲"}，缓冲 ${listen.queue.length}`,
      `回复路由缓存：${deps.botReplyRoutes.size}`
    ].join("\n");
  }

  function setMode(msg, body) {
    if (msg.message_type !== "group") return "模式只对群聊生效。";
    if (!canAdmin(msg)) return "没有权限。";
    const requested = String(body || "").trim().toLowerCase();
    if (!requested) {
      return `当前模式：${deps.effectiveListenMode(msg.group_id)}。可选：selective、mention、all、off。`;
    }
    const aliases = new Map([
      ["选择", "selective"], ["选择性", "selective"], ["selective", "selective"],
      ["mention", "mention"], ["at", "mention"], ["只at", "mention"],
      ["all", "all"], ["全部", "all"], ["off", "off"], ["关闭", "off"]
    ]);
    const mode = aliases.get(requested);
    if (!mode) return "模式无效。可选：selective、mention、all、off。";
    if (deps.atOnlyGroups.includes(Number(msg.group_id)) && mode !== "mention" && mode !== "off") {
      return "这个群已锁定为 @ 触发，只能设为 mention 或 off。";
    }
    const workspace = deps.workspaceForGroup(msg.group_id);
    deps.ensureGroupProfile(workspace, msg.group_id);
    deps.listenModeByGroup.set(Number(msg.group_id), mode);
    deps.appendLine(path.join(workspace, "GROUP_PROFILE.md"), `- ${new Date().toISOString()} 触发模式: ${mode}`);
    deps.persistProxyState();
    return `已切换本群触发模式：${mode}`;
  }

  function adminCommand(msg, body) {
    if (msg.message_type !== "private" || !isAdminRoot(msg.user_id)) {
      return "没有权限。";
    }
    const text = String(body || "").trim();
    if (!text || /^help|帮助$/i.test(text)) {
      return [
        "管理员命令：",
        "/admin status：查看根目录、允许列表、管理员列表、队列",
        "/admin capabilities：查看能力快照",
        "/admin errors：查看结构化错误",
        "/admin routes：查看路由",
        "/admin workspace：查看执行目录和记忆目录",
        "/admin tail <onebot|ccconnect>：查看脱敏日志尾部",
        "/admin reload：重载 proxy state 和能力快照",
        "/admin mode <群号> selective|mention|all|off：切群触发模式",
        "群内管理员：/安静、/恢复、/模式"
      ].join("\n");
    }
    if (/^status$/i.test(text)) {
      const snap = deps.healthSnapshot();
      return [
        "管理员状态：",
        `项目根目录：${deps.projectRoot || "未配置"}`,
        `允许群：${deps.allowedGroups.join(",") || "无"}`,
        `允许私聊：${deps.allowedPrivateUsers.join(",") || "无"}`,
        `管理员：${deps.adminUsers.join(",") || "无"}`,
        `root 管理员：${(deps.adminRootUsers || []).join(",") || "无"}`,
        `上游队列：${snap.pending.upstream_queue}，待回执：${snap.pending.outbound}，文件下载：${snap.pending.file_downloads}`
      ].join("\n");
    }
    if (/^capabilities|能力$/i.test(text)) {
      return formatCapabilitySummary(deps.capabilitySnapshot && deps.capabilitySnapshot()).join("\n");
    }
    if (/^routes|路由$/i.test(text)) {
      const groupRoutes = deps.groupRoutes ? [...deps.groupRoutes.entries()].map(([groupID, route]) => `${groupID}:${route.listenPort || ""}:${route.atPort}`).join(",") : "";
      const privateRoutes = deps.privateRoutes ? [...deps.privateRoutes.entries()].map(([userID, route]) => `${userID}:${route.port}`).join(",") : "";
      return [
        "路由：",
        `允许群：${deps.allowedGroups.join(",") || "无"}`,
        `允许私聊：${deps.allowedPrivateUsers.join(",") || "无"}`,
        `群路由：${groupRoutes || "默认"}`,
        `私聊路由：${privateRoutes || "默认"}`,
        `管理员：${deps.adminUsers.join(",") || "无"}`,
        `root 管理员：${(deps.adminRootUsers || []).join(",") || "无"}`
      ].join("\n");
    }
    if (/^errors|错误$/i.test(text)) {
      return recentErrors();
    }
    if (/^workspace|root|根目录|工作区$/i.test(text)) {
      return [
        "管理员工作区：",
        `记忆目录：${deps.workspaceForPrivateUser(msg.user_id)}`,
        `执行目录：${deps.executionWorkspaceForPrivateUser ? deps.executionWorkspaceForPrivateUser(msg.user_id) : deps.workspaceForPrivateUser(msg.user_id)}`,
        `项目根目录：${deps.projectRoot || "未配置"}`,
        "该用户的 cc-connect 项目应配置 work_dir 为项目根目录。"
      ].join("\n");
    }
    if (/^reload|重载$/i.test(text)) {
      if (!deps.reloadRuntime) return "未配置 reloadRuntime。";
      const result = deps.reloadRuntime();
      return result || "已重载。";
    }
    const tailMatch = text.match(/^tail\s+(\S+)(?:\s+(\d+))?$/i) || text.match(/^日志\s+(\S+)(?:\s+(\d+))?$/);
    if (tailMatch) {
      return adminTail(tailMatch[1], tailMatch[2]);
    }
    const modeMatch = text.match(/^mode\s+(\d+)\s+(\S+)$/i) || text.match(/^模式\s+(\d+)\s+(\S+)$/);
    if (modeMatch) {
      const groupID = Number(modeMatch[1]);
      const mode = modeAlias(modeMatch[2]);
      if (!deps.allowedGroups.includes(groupID)) return "群不在允许列表。";
      if (!mode) return "模式无效。可选：selective、mention、all、off。";
      if (deps.atOnlyGroups.includes(groupID) && mode !== "mention" && mode !== "off") {
        return "这个群已锁定为 @ 触发，只能设为 mention 或 off。";
      }
      deps.listenModeByGroup.set(groupID, mode);
      const workspace = deps.workspaceForGroup(groupID);
      deps.ensureGroupProfile(workspace, groupID);
      deps.appendLine(path.join(workspace, "GROUP_PROFILE.md"), `- ${new Date().toISOString()} 管理员私聊设置触发模式: ${mode}`);
      deps.persistProxyState();
      return `已切换群 ${groupID} 触发模式：${mode}`;
    }
    return "未知管理员命令。用 /admin 查看。";
  }

  function adminTail(name, countText) {
    const key = String(name || "").toLowerCase();
    const file = deps.adminLogFiles && deps.adminLogFiles[key];
    if (!file) return "日志名无效。可选：onebot、ccconnect。";
    const count = Math.max(5, Math.min(80, Number(countText || 30) || 30));
    if (!fs.existsSync(file)) return `日志不存在：${key}`;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-count).map((line) => deps.maskSensitive(line));
    return [`${key} 日志尾部：`, ...lines].join("\n").slice(0, 1800);
  }

  function canAdmin(msg) {
    return deps.adminUsers.length === 0 || deps.adminUsers.includes(Number(msg.user_id));
  }

  function isAdminRoot(userID) {
    return (deps.adminRootUsers || []).includes(Number(userID));
  }

  function modeAlias(value) {
    const aliases = new Map([
      ["选择", "selective"], ["选择性", "selective"], ["selective", "selective"],
      ["mention", "mention"], ["at", "mention"], ["只at", "mention"],
      ["all", "all"], ["全部", "all"], ["off", "off"], ["关闭", "off"]
    ]);
    return aliases.get(String(value || "").trim().toLowerCase());
  }

  function recentErrors() {
    if (deps.recentErrorFile) {
      const errors = readRecentErrors({
        file: deps.recentErrorFile,
        limit: 10,
        maskSensitive: deps.maskSensitive
      });
      if (errors.length > 0) {
        return formatRecentErrors(errors);
      }
    }
    const file = process.env.ONEBOT_PROXY_LOG || "/var/log/onebot-group-proxy.log";
    const localFallback = path.join(__dirname, "..", "..", "onebot-group-proxy.log");
    const source = fs.existsSync(file) ? file : localFallback;
    if (!fs.existsSync(source)) return "没有找到代理日志。";
    const lines = fs.readFileSync(source, "utf8")
      .split(/\r?\n/)
      .filter((line) => /error|failed|timeout|失败|错误/i.test(line))
      .slice(-8)
      .map((line) => deps.maskSensitive(line));
    return lines.length === 0 ? "最近没有明显错误。" : ["最近错误：", ...lines].join("\n").slice(0, 1400);
  }

  return { isProxyCommand, handleProxyCommand };
}

function collectFileIndexMatches(workspace, keyword, out) {
  const index = path.join(workspace, "local_files", "INDEX.md");
  if (!fs.existsSync(index)) return;
  for (const line of fs.readFileSync(index, "utf8").split(/\r?\n/)) {
    if (line.toLowerCase().includes(keyword)) {
      out.push(line.replace(/^\s*[-*]\s*/, "").trim());
    }
  }
}

function helpHaystack(entry) {
  return [
    entry.title,
    entry.detail,
    ...(entry.tags || [])
  ].join("\n").toLowerCase();
}

function readProfileLines(file, keyword, max) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .filter((line) => !keyword || line.toLowerCase().includes(keyword))
    .slice(-max);
}

function collectArchiveSummaryMatches(workspace, keyword, out) {
  const root = path.join(workspace, "local_files");
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0 && out.length < 20) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name === "summary.md") {
        const text = fs.readFileSync(full, "utf8");
        if (text.toLowerCase().includes(keyword)) {
          out.push(path.relative(workspace, full).replace(/\\/g, "/"));
        }
      }
    }
  }
}

function readJSONLines(file) {
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function topKeywords(text) {
  const stop = new Set(["这个", "那个", "就是", "一下", "可以", "什么", "怎么", "一个", "我们", "你们", "他们", "今天", "然后", "因为", "所以"]);
  const counts = new Map();
  for (const token of String(text || "").toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z0-9_+-]{3,}/g) || []) {
    if (stop.has(token) || /^\d+$/.test(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word);
}

function pickLines(samples, pattern, max) {
  const seen = new Set();
  const picked = [];
  for (const item of samples.slice().reverse()) {
    const text = String(item.text || "").replace(/\s+/g, " ").trim();
    if (!text || !pattern.test(text)) continue;
    const line = `- ${item.user}: ${text.slice(0, 90)}`;
    if (!seen.has(line)) {
      seen.add(line);
      picked.push(line);
    }
    if (picked.length >= max) break;
  }
  return picked.reverse();
}

function sanitizeSummaryText(text) {
  return redactSecrets(text);
}

function reviewPacketEvidence({ workspace, errorFile, errorScope, errorTarget, roundPick, maskSensitive = (value) => value }) {
  const pending = pickSafeReviewCandidate(workspace);
  const todo = pickSafeReviewTodo(workspace);
  const proposal = roundPick && roundPick.item ? roundPick.item : null;
  const error = readRecentErrors({ file: errorFile, limit: 50, maskSensitive })
    .reverse()
    .find((item) => String(item.scope || "") === String(errorScope || "") && String(item.target || "") === String(errorTarget || ""));
  const lines = ["来源提示："];
  lines.push(pending
    ? `- 候选：${compactOneLine(`[${pending.kind || "note"}] ${pending.user || pending.subject_id || "-"} ${pending.text || ""}`, 96)}`
    : "- 候选：暂无");
  lines.push(todo
    ? `- 待办：${compactOneLine(todo.text || "", 96)}`
    : "- 待办：暂无");
  lines.push(proposal
    ? `- 提案：${compactOneLine(`[${proposal.status || "open"}] ${proposal.title || ""}`, 96)}`
    : "- 提案：暂无");
  lines.push(error
    ? `- 错误：${compactOneLine(`[${error.kind || "unknown"}] ${error.message || error.detail || ""}`, 96)}`
    : "- 错误：暂无");
  return lines;
}

function reviewPacketFocus({ workspace, roundPick }) {
  if (roundPick && roundPick.item) {
    const item = roundPick.item;
    return compactOneLine(`本轮焦点：提案 ${shortID(item.id)} [${item.status || "open"}] ${item.title || ""}`, 120);
  }
  const todo = pickSafeReviewTodo(workspace);
  if (todo) {
    return compactOneLine(`本轮焦点：待办 ${shortID(todo.id)} ${todo.text || ""}`, 120);
  }
  const candidate = pickSafeReviewCandidate(workspace);
  if (candidate) {
    return compactOneLine(`本轮焦点：候选 [${candidate.kind || "note"}] ${candidate.text || ""}`, 120);
  }
  return "本轮焦点：暂无";
}

function pickSafeReviewTodo(workspace) {
  return listTodos({ workspace, limit: 20 }).find((item) => isSafeReviewText(item && item.text)) || null;
}

function pickSafeReviewCandidate(workspace) {
  return readPendingCandidates({ workspace })
    .slice()
    .reverse()
    .find((item) => isSafeReviewText(item && item.text)) || null;
}

function isSafeReviewText(value) {
  return reviewTextBlockers(value).length === 0;
}

function reviewTextBlockers(value) {
  const text = String(value || "").toLowerCase();
  const blockers = [];
  addReviewRuleHit(blockers, text, /(官方\s*qq\s*bot|qq\s*官方\s*bot|official\s+qq\s+bot|qqbot\s+official)/i, "official-qq-bot");
  addReviewRuleHit(blockers, text, /(token|cookie|secret|authorization|api[_-]?key|sk-[a-z0-9_-]{8,})/i, "secret");
  addReviewRuleHit(blockers, text, /(跨群|跨私聊|其他群|所有群|全局搜索|cross[- ]?group|cross[- ]?private)/i, "cross-workspace");
  addReviewRuleHit(blockers, text, /(向量库|embedding|embeddings|vector database|向量索引)/i, "embedding");
  addReviewRuleHit(blockers, text, /(daemon|常驻|后台常驻|watcher|监听所有|每条消息|每消息|per-message)/i, "daemon");
  addReviewRuleHit(blockers, text, /(本地大模型|local llm|ollama|llama\.cpp|vllm)/i, "local-llm");
  addReviewRuleHit(blockers, text, /(自动部署|自动重启|重启|递归|self[- ]?deploy|auto[- ]?deploy|restart)/i, "auto-deploy");
  addReviewRuleHit(blockers, text, /(扩大管理员|提权|sudo|root 权限|所有文件|任意目录)/i, "privilege");
  return blockers;
}

function addReviewRuleHit(out, text, pattern, label) {
  if (pattern.test(text)) {
    out.push(label);
  }
}

function compactOneLine(value, limit) {
  const text = redactSecrets(String(value || "")).replace(/\s+/g, " ").trim();
  const max = Math.max(12, Number(limit) || 80);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function parseDurationMinutes(text) {
  const s = String(text || "").trim();
  const match = s.match(/(\d+)\s*(分钟|分|小时|时|h|m)?/i);
  if (!match) return 30;
  const n = Math.max(1, Math.min(24 * 60, Number(match[1]) || 30));
  const unit = match[2] || "分钟";
  return /小时|时|h/i.test(unit) ? n * 60 : n;
}

function selectorAfterLabel(text, labels) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?:^|\\s)(?:${escaped})\\s*[:：]\\s*([^\\s]+)`, "i");
  const match = String(text || "").match(pattern);
  if (!match) return "";
  const value = String(match[1] || "").trim();
  return value === "-" ? "" : value;
}

function shortTime(value) {
  return String(value || "").replace("T", " ").slice(0, 16);
}

function formatCounts(counts) {
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length ? entries.map(([key, count]) => `${key}:${count}`).join(",") : "-";
}

function shortID(id) {
  return String(id || "").replace(/^(todo|prop)_/, "").slice(-6) || "-";
}

function workspaceNameForPath(workspace) {
  const normalized = path.normalize(String(workspace || ""));
  const parts = normalized.split(path.sep).filter(Boolean);
  if (parts.length >= 2 && parts[parts.length - 2] === "groups") {
    return `groups/${parts[parts.length - 1]}`;
  }
  if (parts.length >= 2 && parts[parts.length - 2] === "users") {
    return `users/${parts[parts.length - 1]}`;
  }
  return parts[parts.length - 1] || null;
}

module.exports = { createProxyCommands };
