const fs = require("fs");
const path = require("path");
const { redactSecrets } = require("./sensitive-redaction");

function todoFile(workspace) {
  return path.join(workspace, "memory", "todos.jsonl");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function addTodo({ workspace, scope, scopeID = "", userID = "", text, sourceMessageID = "", sourceCandidate = null, sourceProposal = null }) {
  const clean = normalizeText(text);
  if (!workspace || !clean) {
    return null;
  }
  const item = {
    version: 1,
    type: "add",
    id: todoID(),
    created_at: new Date().toISOString(),
    scope: normalizeScope(scope),
    scope_id: String(scopeID || ""),
    created_by: String(userID || ""),
    text: clean,
    source_message_id: String(sourceMessageID || "")
  };
  if (sourceCandidate) {
    item.source_candidate_id = String(sourceCandidate.id || "");
    item.source_candidate_fingerprint = String(sourceCandidate.fingerprint || "");
    item.source_user_id = String(sourceCandidate.subject_id || sourceCandidate.user || "");
    item.source_time = String(sourceCandidate.source_time || "");
  }
  if (sourceProposal) {
    item.source_proposal_id = String(sourceProposal.id || "");
    item.source_proposal_title = normalizeText(sourceProposal.title || "").slice(0, 120);
  }
  ensureDir(path.dirname(todoFile(workspace)));
  fs.appendFileSync(todoFile(workspace), `${JSON.stringify(item)}\n`, "utf8");
  return item;
}

function listTodos({ workspace, includeDone = false, limit = 10 }) {
  const state = loadTodoState(workspace);
  return [...state.items.values()]
    .filter((item) => includeDone || !item.done_at)
    .slice(-Math.max(1, Number(limit) || 10))
    .reverse();
}

function listDoneTodos({ workspace, limit = 5 }) {
  const count = Math.max(1, Math.min(20, Number(limit) || 5));
  const state = loadTodoState(workspace);
  return [...state.items.values()]
    .filter((item) => item.done_at)
    .sort((a, b) => String(b.done_at || "").localeCompare(String(a.done_at || "")))
    .slice(0, count);
}

function searchTodos({ workspace, query = "", limit = 10 }) {
  const terms = searchTerms(query);
  const state = loadTodoState(workspace);
  const active = [...state.items.values()].filter((item) => !item.done_at);
  if (terms.length === 0) {
    const count = Math.max(1, Number(limit) || 10);
    return active.slice(-count).map((item, index) => ({ item, index: active.length - Math.min(active.length, count) + index + 1 })).reverse();
  }
  return active
    .map((item, index) => ({ item, index: index + 1 }))
    .filter(({ item }) => {
      const haystack = todoHaystack(item);
      return terms.every((term) => haystack.includes(term));
    })
    .slice(-Math.max(1, Number(limit) || 10))
    .reverse();
}

function findTodoBySourceProposal({ workspace, proposalID }) {
  const wanted = String(proposalID || "");
  if (!wanted) return null;
  return [...loadTodoState(workspace).items.values()].find((item) => item.source_proposal_id === wanted) || null;
}

function sourceProposalIDs({ workspace }) {
  return new Set([...loadTodoState(workspace).items.values()].map((item) => item.source_proposal_id).filter(Boolean));
}

function completeTodos({ workspace, selector, doneBy = "" }) {
  const state = loadTodoState(workspace);
  const active = [...state.items.values()].filter((item) => !item.done_at);
  const indexes = selectTodoIndexes(selector, active);
  if (indexes.length === 0) {
    return { done: 0, items: [] };
  }
  const now = new Date().toISOString();
  const doneItems = [];
  for (const index of indexes) {
    const item = active[index];
    if (!item) continue;
    const event = {
      version: 1,
      type: "done",
      id: item.id,
      done_at: now,
      done_by: String(doneBy || "")
    };
    fs.appendFileSync(todoFile(workspace), `${JSON.stringify(event)}\n`, "utf8");
    doneItems.push({ ...item, done_at: now, done_by: String(doneBy || "") });
  }
  return { done: doneItems.length, items: doneItems };
}

function todoStats({ workspace }) {
  const state = loadTodoState(workspace);
  const rows = [...state.items.values()];
  const active = rows.filter((item) => !item.done_at).length;
  const done = rows.filter((item) => item.done_at).length;
  const latest = state.latest || "";
  return { total: rows.length, active, done, bad_lines: state.bad_lines, latest };
}

function formatTodos(items) {
  const active = items || [];
  if (active.length === 0) {
    return "暂无待办。";
  }
  return [
    "待办：",
    ...active.map((item, index) => `- ${index + 1}. ${shortID(item.id)} ${redactSensitive(item.text)} (${shortTime(item.created_at)})`)
  ].join("\n").slice(0, 1600);
}

function formatTodoSearch(results) {
  if (!results || results.length === 0) {
    return "未找到匹配的未完成待办。";
  }
  return [
    "待办：",
    ...results.map(({ item, index }) => `- ${index}. ${shortID(item.id)} ${redactSensitive(item.text)} (${shortTime(item.created_at)})`)
  ].join("\n").slice(0, 1600);
}

function formatTodoStats(stats) {
  return [
    "待办状态：",
    `总数：${stats.total}`,
    `未完成：${stats.active}`,
    `已完成：${stats.done}`,
    `坏行：${stats.bad_lines || 0}`,
    `最近创建：${shortTime(stats.latest) || "暂无"}`
  ].join("\n");
}

function formatDoneTodos(items) {
  const done = items || [];
  if (done.length === 0) {
    return "暂无已完成待办。";
  }
  return [
    "已完成待办：",
    ...done.map((item, index) => `- ${index + 1}. ${shortID(item.id)} ${redactSensitive(item.text)} (完成 ${shortTime(item.done_at)}${item.done_by ? `，by ${redactSensitive(item.done_by)}` : ""})`)
  ].join("\n").slice(0, 1600);
}

function loadTodoState(workspace) {
  const state = { items: new Map(), bad_lines: 0, latest: "" };
  for (const row of readJSONLinesWithBadCount(todoFile(workspace))) {
    if (!row.ok) {
      state.bad_lines += 1;
      continue;
    }
    const item = row.value;
    if (!item || !item.id) {
      continue;
    }
    if (item.type === "done") {
      const existing = state.items.get(item.id);
      if (existing && !existing.done_at) {
        existing.done_at = String(item.done_at || "");
        existing.done_by = String(item.done_by || "");
      }
      state.latest = maxTime(state.latest, item.done_at);
      continue;
    }
    if (item.type && item.type !== "add") {
      continue;
    }
    state.items.set(item.id, {
      version: item.version || 1,
      type: "add",
      id: String(item.id),
      created_at: String(item.created_at || ""),
      scope: normalizeScope(item.scope),
      scope_id: String(item.scope_id || ""),
      created_by: String(item.created_by || item.user_id || ""),
      text: normalizeText(item.text || ""),
      source_message_id: String(item.source_message_id || ""),
      source_candidate_id: String(item.source_candidate_id || ""),
      source_candidate_fingerprint: String(item.source_candidate_fingerprint || ""),
      source_proposal_id: String(item.source_proposal_id || ""),
      source_proposal_title: String(item.source_proposal_title || ""),
      source_user_id: String(item.source_user_id || ""),
      source_time: String(item.source_time || ""),
      done_at: "",
      done_by: ""
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

function selectTodoIndexes(selector, active) {
  const raw = String(selector || "").trim().toLowerCase();
  if (!raw) return [];
  if (raw === "all" || raw === "全部") {
    return active.map((_, index) => index);
  }
  const byID = new Map(active.map((item, index) => [String(item.id || "").toLowerCase(), index]));
  return raw.split(/[,\s，、]+/)
    .map((part) => {
      const n = Number(part);
      if (Number.isInteger(n) && n >= 1 && n <= active.length) return n - 1;
      return byID.get(part);
    })
    .filter((index) => Number.isInteger(index) && index >= 0 && index < active.length)
    .filter((index, pos, arr) => arr.indexOf(index) === pos);
}

function normalizeScope(scope) {
  return ["group", "private"].includes(scope) ? scope : "group";
}

function normalizeText(text) {
  return String(text || "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function todoHaystack(item) {
  return [
    item.id,
    item.text,
    item.created_by,
    item.source_user_id,
    item.source_time
  ].join("\n").toLowerCase();
}

function searchTerms(query) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function todoID() {
  return `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function shortID(id) {
  return String(id || "").replace(/^todo_/, "").slice(-6) || "-";
}

function shortTime(value) {
  return String(value || "").replace("T", " ").slice(0, 16);
}

function redactSensitive(value) {
  return redactSecrets(value);
}

function maxTime(a, b) {
  return String(a || "") > String(b || "") ? String(a || "") : String(b || "");
}

module.exports = {
  addTodo,
  completeTodos,
  formatDoneTodos,
  formatTodoSearch,
  formatTodos,
  formatTodoStats,
  listDoneTodos,
  listTodos,
  findTodoBySourceProposal,
  sourceProposalIDs,
  searchTodos,
  todoStats
};
