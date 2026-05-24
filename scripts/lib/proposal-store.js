const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { looksSensitive, redactSecrets } = require("./sensitive-redaction");

const VALID_STATUSES = new Set(["open", "accepted", "skipped", "done"]);
const VALID_LINK_KINDS = new Set(["command", "test", "file", "error", "proposal"]);

function proposalFile(workspace) {
  return path.join(workspace, "memory", "proposals.jsonl");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function addProposal({ workspace, scope, scopeID = "", userID = "", title = "", body = "", sourceMessageID = "" }) {
  const cleanTitle = normalizeText(title).slice(0, 80);
  const cleanBody = normalizeText(body).slice(0, 500);
  if (!workspace || !cleanTitle) {
    return null;
  }
  const proposalFingerprint = fingerprint(`${cleanTitle}\n${cleanBody}`);
  const duplicate = findProposalByFingerprint(workspace, proposalFingerprint);
  if (duplicate) {
    return { duplicate: true, existing: duplicate };
  }
  const item = {
    version: 1,
    type: "add",
    id: proposalID(),
    created_at: new Date().toISOString(),
    scope: normalizeScope(scope),
    scope_id: String(scopeID || ""),
    created_by: String(userID || ""),
    title: cleanTitle,
    body: cleanBody,
    fingerprint: proposalFingerprint,
    source_message_id: String(sourceMessageID || "")
  };
  ensureDir(path.dirname(proposalFile(workspace)));
  fs.appendFileSync(proposalFile(workspace), `${JSON.stringify(item)}\n`, "utf8");
  return item;
}

function listProposals({ workspace, status = "open", limit = 10 }) {
  const state = loadProposalState(workspace);
  const wantedStatus = String(status || "open").toLowerCase();
  return [...state.items.values()]
    .filter((item) => wantedStatus === "all" || item.status === wantedStatus)
    .slice(-Math.max(1, Number(limit) || 10))
    .reverse();
}

function searchProposals({ workspace, query = "", limit = 10 }) {
  const terms = searchTerms(query);
  const items = [...loadProposalState(workspace).items.values()];
  const rows = terms.length === 0 ? items : items.filter((item) => terms.every((term) => proposalHaystack(item).includes(term)));
  return rows.slice(-Math.max(1, Number(limit) || 10)).reverse();
}

function exportProposals({ workspace, mode = "open", limit = 10 }) {
  const state = loadProposalState(workspace);
  const rows = [...state.items.values()];
  const stats = proposalStatsFromItems(rows, state);
  const wantedMode = String(mode || "open").toLowerCase();
  const count = Math.max(1, Math.min(20, Number(limit) || 10));
  if (wantedMode === "all") {
    const recent = rows.slice(-count).reverse();
    return { mode: "all", stats, items: recent, remaining: Math.max(0, rows.length - recent.length) };
  }
  const open = rows.filter((item) => item.status === "open");
  const picked = open.slice(-count).reverse();
  return { mode: "open", stats, items: picked, remaining: Math.max(0, open.length - picked.length) };
}

function listLandableProposals({ workspace, landedIDs = new Set(), limit = 10 }) {
  const state = loadProposalState(workspace);
  const count = Math.max(1, Math.min(20, Number(limit) || 10));
  const landed = landedIDs instanceof Set ? landedIDs : new Set(landedIDs || []);
  return [...state.items.values()]
    .filter((item) => item.status === "accepted" && !landed.has(item.id))
    .filter((item) => checkProposalItem(item).blockers.length === 0)
    .slice(-count)
    .reverse();
}

function getProposal({ workspace, selector }) {
  const state = loadProposalState(workspace);
  return selectProposal(state.items, selector);
}

function checkProposal({ workspace, selector }) {
  const item = getProposal({ workspace, selector });
  if (!item) {
    return { item: null, conclusion: "missing", blockers: [], warnings: [] };
  }
  return checkProposalItem(item);
}

function pickProposalForRound({ workspace }) {
  const state = loadProposalState(workspace);
  const items = [...state.items.values()];
  const accepted = items.filter((item) => item.status === "accepted").reverse();
  const open = items.filter((item) => item.status === "open").reverse();
  for (const item of [...accepted, ...open]) {
    const check = checkProposalItem(item);
    if (check.blockers.length === 0) {
      return {
        item,
        check,
        reason: item.status === "accepted" ? "已 accepted，未 done，预检未发现阻断项" : "open 待处理，预检未发现阻断项"
      };
    }
  }
  return { item: null, check: null, reason: "没有找到适合本轮的提案" };
}

function checkProposalItem(item) {
  const linkText = (item.links || []).map((link) => link.value || "").join("\n");
  const text = `${item.title}\n${item.body}\n${linkText}`.toLowerCase();
  const blockers = [];
  const warnings = [];
  addRuleHit(blockers, text, /(官方\s*qq\s*bot|qq\s*官方\s*bot|official\s+qq\s+bot|qqbot\s+official)/i, "涉及切换官方 QQ Bot 主线，偏离当前 NapCat/OneBot 架构");
  addRuleHit(blockers, text, /(token|cookie|secret|authorization|api[_-]?key|sk-[a-z0-9_-]{8,})/i, "涉及 secrets/tokens/cookies，不能本轮直接做");
  addRuleHit(blockers, text, /(跨群|跨私聊|其他群|所有群|全局搜索|cross[- ]?group|cross[- ]?private)/i, "涉及跨群/跨私聊或全局读取");
  addRuleHit(blockers, text, /(向量库|embedding|embeddings|vector database|向量索引)/i, "涉及向量库或 embedding，超出当前低成本边界");
  addRuleHit(blockers, text, /(daemon|常驻|后台常驻|watcher|监听所有|每条消息|每消息|per-message)/i, "涉及后台常驻或每消息处理");
  addRuleHit(blockers, text, /(本地大模型|local llm|ollama|llama\.cpp|vllm)/i, "涉及本地 LLM daemon 或重模型运行");
  addRuleHit(blockers, text, /(自动部署|自动重启|重启|递归|self[- ]?deploy|auto[- ]?deploy|restart)/i, "涉及自动部署/重启/递归执行");
  addRuleHit(blockers, text, /(扩大管理员|提权|sudo|root 权限|所有文件|任意目录)/i, "涉及权限扩大或过宽文件访问");
  addRuleHit(warnings, text, /(无测试|不用测试|跳过测试|skip tests?)/i, "提案倾向跳过测试，需要人工审查");
  const conclusion = blockers.length > 0 ? "不建议本轮" : warnings.length > 0 ? "需要人工审查" : "适合本轮";
  return { item, conclusion, blockers, warnings };
}

function updateProposalStatus({ workspace, selector, status, userID = "", reason = "" }) {
  const next = String(status || "").toLowerCase();
  if (!VALID_STATUSES.has(next) || next === "open") {
    return { updated: 0, item: null };
  }
  const state = loadProposalState(workspace);
  const item = selectProposal(state.items, selector);
  if (!item) {
    return { updated: 0, item: null };
  }
  const event = {
    version: 1,
    type: "status",
    id: item.id,
    status: next,
    time: new Date().toISOString(),
    by: String(userID || ""),
    reason: normalizeText(reason).slice(0, 180)
  };
  ensureDir(path.dirname(proposalFile(workspace)));
  fs.appendFileSync(proposalFile(workspace), `${JSON.stringify(event)}\n`, "utf8");
  return { updated: 1, item: { ...item, status: next, status_at: event.time, status_by: event.by, status_reason: event.reason } };
}

function addProposalLink({ workspace, selector, kind, value, userID = "" }) {
  const normalizedKind = normalizeLinkKind(kind);
  const cleanValue = normalizeText(value).slice(0, 160);
  if (!normalizedKind || !cleanValue) {
    return { added: 0, reason: "invalid", item: null };
  }
  if (containsSensitive(cleanValue)) {
    return { added: 0, reason: "sensitive", item: null };
  }
  const state = loadProposalState(workspace);
  const item = selectProposal(state.items, selector);
  if (!item) {
    return { added: 0, reason: "missing", item: null };
  }
  const links = item.links || [];
  if (links.some((link) => link.kind === normalizedKind && link.value === cleanValue)) {
    return { added: 0, reason: "duplicate", item };
  }
  const event = {
    version: 1,
    type: "link",
    id: item.id,
    kind: normalizedKind,
    value: cleanValue,
    time: new Date().toISOString(),
    by: String(userID || "")
  };
  ensureDir(path.dirname(proposalFile(workspace)));
  fs.appendFileSync(proposalFile(workspace), `${JSON.stringify(event)}\n`, "utf8");
  const nextItem = { ...item, links: [...links, { kind: normalizedKind, value: cleanValue, time: event.time, by: event.by }] };
  return { added: 1, reason: "ok", item: nextItem };
}

function proposalStats({ workspace }) {
  const state = loadProposalState(workspace);
  return proposalStatsFromItems([...state.items.values()], state);
}

function formatProposals(items, title = "建议箱") {
  const rows = items || [];
  if (rows.length === 0) {
    return "暂无建议。";
  }
  return [
    `${title}：`,
    ...rows.map((item, index) => `- ${index + 1}. ${shortID(item.id)} [${item.status}] ${redactSensitive(item.title)} (${shortTime(item.created_at)})`)
  ].join("\n").slice(0, 1600);
}

function formatProposal(item) {
  if (!item) {
    return "没有找到这条建议。";
  }
  return [
    "建议详情：",
    `ID：${shortID(item.id)}`,
    `状态：${item.status}`,
    `标题：${redactSensitive(item.title)}`,
    `正文：${redactSensitive(item.body) || "无"}`,
    `创建：${shortTime(item.created_at)} by ${redactSensitive(item.created_by) || "-"}`,
    item.status_at ? `更新：${shortTime(item.status_at)} by ${redactSensitive(item.status_by) || "-"}${item.status_reason ? `，原因：${redactSensitive(item.status_reason)}` : ""}` : "",
    formatProposalLinks(item)
  ].filter(Boolean).join("\n").slice(0, 1600);
}

function formatDuplicateProposal(item) {
  if (!item) {
    return "已有相同提案。";
  }
  return `已有相同提案：${shortID(item.id)} [${item.status || "open"}] ${redactSensitive(item.title)}。用 /建议箱 show ${shortID(item.id)} 查看。`;
}

function formatProposalStats(stats) {
  return [
    "建议箱状态：",
    `总数：${stats.total}`,
    `open：${stats.byStatus.open || 0}`,
    `accepted：${stats.byStatus.accepted || 0}`,
    `skipped：${stats.byStatus.skipped || 0}`,
    `done：${stats.byStatus.done || 0}`,
    `坏行：${stats.bad_lines || 0}`,
    `最近更新：${shortTime(stats.latest) || "暂无"}`
  ].join("\n");
}

function formatProposalExport(report) {
  const stats = (report && report.stats) || { byStatus: {} };
  const items = (report && report.items) || [];
  const lines = [
    "当前 workspace 提案摘要：",
    `状态统计：open ${stats.byStatus.open || 0} / accepted ${stats.byStatus.accepted || 0} / done ${stats.byStatus.done || 0} / skipped ${stats.byStatus.skipped || 0}`
  ];
  if (items.length === 0) {
    lines.push(report && report.mode === "all" ? "最近提案：暂无" : "待处理：暂无");
    return lines.join("\n");
  }
  lines.push(report && report.mode === "all" ? "最近提案：" : "待处理：");
  for (const item of items) {
    lines.push(`- ${shortID(item.id)} [${item.status}] ${redactSensitive(item.title)}`);
    if (item.body) {
      lines.push(`  理由：${redactSensitive(item.body).slice(0, 120)}`);
    }
    if (item.status === "open") {
      lines.push(`  建议命令：/提案 accept ${shortID(item.id)} 或 /提案 skip ${shortID(item.id)} 原因`);
    }
  }
  if (report && report.remaining > 0) {
    lines.push(`还有 ${report.remaining} 条未显示。`);
  }
  return lines.join("\n").slice(0, 1800);
}

function formatLandableProposals(items) {
  const rows = items || [];
  if (rows.length === 0) {
    return "暂无待落地提案。";
  }
  return [
    "待落地提案：",
    ...rows.map((item, index) => `- ${index + 1}. ${shortID(item.id)} ${redactSensitive(item.title)} (${shortTime(item.created_at)})`),
    "用法：/建议箱 落地 ID"
  ].join("\n").slice(0, 1600);
}

function formatProposalCheck(result) {
  if (!result || !result.item) {
    return "没有找到这条建议。";
  }
  const item = result.item;
  const lines = [
    `提案预检：${shortID(item.id)}`,
    `标题：${redactSensitive(item.title)}`,
    `结论：${result.conclusion}`,
    "风险："
  ];
  if (result.blockers.length === 0 && result.warnings.length === 0) {
    lines.push("- 未发现越界关键词");
    lines.push("- 未发现后台常驻任务");
    lines.push("- 未发现权限扩大或跨 workspace 读取");
  } else {
    for (const blocker of result.blockers) {
      lines.push(`- 阻断：${blocker}`);
    }
    for (const warning of result.warnings) {
      lines.push(`- 提醒：${warning}`);
    }
  }
  lines.push("建议测试：");
  lines.push("- 当前 workspace 隔离");
  lines.push("- 命令无参/非法 ID");
  lines.push("- 输出脱敏");
  return lines.join("\n").slice(0, 1600);
}

function formatRoundProposal(result) {
  if (!result || !result.item) {
    return "本轮建议：暂无适合本轮的提案。";
  }
  const item = result.item;
  return [
    "本轮建议：",
    `ID：${shortID(item.id)} [${item.status}]`,
    `标题：${redactSensitive(item.title)}`,
    `选择理由：${result.reason}`,
    "边界：仅当前 workspace；不涉及后台常驻/跨群/权限扩大",
    `下一步：实现并测试后 /提案 done ${shortID(item.id)}；不做则 /提案 skip ${shortID(item.id)} 原因`
  ].join("\n").slice(0, 1600);
}

function formatProposalLinkResult(result) {
  if (!result || result.reason === "missing") return "没有找到这条建议。";
  if (result.reason === "sensitive") return "关联内容包含敏感字段，已拒绝保存。";
  if (result.reason === "invalid") return "用法：/提案 关联 ID 命令|测试|文件|错误|提案 内容";
  if (result.reason === "duplicate") return "这条关联已存在。";
  return `已添加关联：${formatOneLink((result.item.links || []).at(-1))}`;
}

function formatProposalLinksCommand(item) {
  if (!item) return "没有找到这条建议。";
  const links = item.links || [];
  if (links.length === 0) {
    return `提案关联：${shortID(item.id)}\n暂无关联。`;
  }
  return [
    `提案关联：${shortID(item.id)} ${redactSensitive(item.title)}`,
    ...links.map((link, index) => `- ${index + 1}. ${formatOneLink(link)}`)
  ].join("\n").slice(0, 1600);
}

function loadProposalState(workspace) {
  const state = { items: new Map(), bad_lines: 0, latest: "" };
  for (const row of readJSONLinesWithBadCount(proposalFile(workspace))) {
    if (!row.ok) {
      state.bad_lines += 1;
      continue;
    }
    const item = row.value;
    if (!item || !item.id) continue;
    if (item.type === "status") {
      const existing = state.items.get(item.id);
      const next = String(item.status || "").toLowerCase();
      if (existing && VALID_STATUSES.has(next)) {
        existing.status = next;
        existing.status_at = String(item.time || "");
        existing.status_by = String(item.by || "");
        existing.status_reason = normalizeText(item.reason || "");
      }
      state.latest = maxTime(state.latest, item.time);
      continue;
    }
    if (item.type === "link") {
      const existing = state.items.get(item.id);
      const linkKind = normalizeLinkKind(item.kind);
      const linkValue = normalizeText(item.value || "").slice(0, 160);
      if (existing && linkKind && linkValue && !containsSensitive(linkValue)) {
        const links = existing.links || [];
        if (!links.some((link) => link.kind === linkKind && link.value === linkValue)) {
          links.push({
            kind: linkKind,
            value: linkValue,
            time: String(item.time || ""),
            by: String(item.by || "")
          });
          existing.links = links;
        }
      }
      state.latest = maxTime(state.latest, item.time);
      continue;
    }
    if (item.type && item.type !== "add") continue;
    state.items.set(String(item.id), {
      version: item.version || 1,
      type: "add",
      id: String(item.id),
      created_at: String(item.created_at || ""),
      scope: normalizeScope(item.scope),
      scope_id: String(item.scope_id || ""),
      created_by: String(item.created_by || ""),
      title: normalizeText(item.title || ""),
      body: normalizeText(item.body || ""),
      fingerprint: String(item.fingerprint || ""),
      source_message_id: String(item.source_message_id || ""),
      status: "open",
      status_at: "",
      status_by: "",
      status_reason: "",
      links: []
    });
    state.latest = maxTime(state.latest, item.created_at);
  }
  return state;
}

function readJSONLinesWithBadCount(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return { ok: true, value: JSON.parse(line) };
      } catch {
        return { ok: false, value: null };
      }
    });
}

function selectProposal(items, selector) {
  const raw = String(selector || "").trim().toLowerCase();
  if (!raw) return null;
  const rows = [...items.values()];
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= rows.length) {
    return rows[n - 1];
  }
  return rows.find((item) => item.id.toLowerCase() === raw || shortID(item.id).toLowerCase() === raw) || null;
}

function findProposalByFingerprint(workspace, value) {
  if (!value) {
    return null;
  }
  const rows = [...loadProposalState(workspace).items.values()];
  return rows.find((item) => item.fingerprint === value) || null;
}

function proposalStatsFromItems(items, state = {}) {
  const byStatus = { open: 0, accepted: 0, skipped: 0, done: 0 };
  for (const item of items || []) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
  }
  return {
    total: (items || []).length,
    bad_lines: state.bad_lines || 0,
    latest: state.latest || "",
    byStatus
  };
}

function addRuleHit(out, text, pattern, message) {
  if (pattern.test(text)) {
    out.push(message);
  }
}

function formatProposalLinks(item) {
  const links = (item && item.links) || [];
  if (links.length === 0) return "";
  return ["关联：", ...links.slice(-8).map((link) => `- ${formatOneLink(link)}`)].join("\n");
}

function formatOneLink(link) {
  if (!link) return "-";
  return `[${link.kind}] ${redactSensitive(link.value)}${link.time ? ` (${shortTime(link.time)})` : ""}`;
}

function normalizeLinkKind(value) {
  const raw = String(value || "").trim().toLowerCase();
  const aliases = new Map([
    ["命令", "command"], ["command", "command"], ["cmd", "command"],
    ["测试", "test"], ["test", "test"], ["tests", "test"],
    ["文件", "file"], ["file", "file"], ["path", "file"],
    ["错误", "error"], ["error", "error"], ["err", "error"],
    ["提案", "proposal"], ["proposal", "proposal"]
  ]);
  const kind = aliases.get(raw);
  return VALID_LINK_KINDS.has(kind) ? kind : "";
}

function containsSensitive(value) {
  return looksSensitive(value);
}

function normalizeScope(scope) {
  return ["group", "private"].includes(scope) ? scope : "group";
}

function normalizeText(text) {
  return String(text || "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function proposalHaystack(item) {
  return [
    item.id,
    shortID(item.id),
    item.title,
    item.body,
    item.status,
    item.created_by,
    item.status_reason
  ].join("\n").toLowerCase();
}

function searchTerms(query) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function proposalID() {
  return `prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function shortID(id) {
  return String(id || "").replace(/^prop_/, "").slice(-6) || "-";
}

function shortTime(value) {
  return String(value || "").replace("T", " ").slice(0, 16);
}

function redactSensitive(value) {
  return redactSecrets(value);
}

function fingerprint(value) {
  return crypto.createHash("sha1").update(String(value || "").toLowerCase()).digest("hex").slice(0, 16);
}

function maxTime(a, b) {
  return String(a || "") > String(b || "") ? String(a || "") : String(b || "");
}

module.exports = {
  addProposal,
  addProposalLink,
  checkProposal,
  exportProposals,
  listLandableProposals,
  formatDuplicateProposal,
  formatProposal,
  formatProposalCheck,
  formatProposalExport,
  formatLandableProposals,
  formatProposalLinkResult,
  formatProposalLinksCommand,
  formatRoundProposal,
  formatProposals,
  formatProposalStats,
  getProposal,
  listProposals,
  pickProposalForRound,
  proposalStats,
  searchProposals,
  updateProposalStatus
};
