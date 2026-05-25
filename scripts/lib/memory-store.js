const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { classifyMemory, memoryFingerprint, normalizeMemoryText, tagMemory } = require("./memory-rules");
const { looksSensitive: sharedLooksSensitive, redactSecrets } = require("./sensitive-redaction");
const { appendJSONObject, readJSONLShards } = require("./jsonl-shards");

const VALID_KINDS = new Set(["fact", "preference", "todo", "project", "joke", "boundary", "note"]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function memoryFile(workspace) {
  return path.join(workspace, "memory", "memories.jsonl");
}

function deleteFile(workspace) {
  return path.join(workspace, "memory", "memory-deletes.jsonl");
}

function pendingCandidateFile(workspace) {
  return path.join(workspace, "memory", "pending-memory-candidates.jsonl");
}

function pendingSnapshotFile(workspace) {
  return path.join(workspace, "memory", "pending-memory-snapshots.jsonl");
}

function addMemory({ workspace, scope, scopeID = "", subject, text, kind = "note", source = "explicit", sourceMessageID = "", tags = [], confidence = 1 }) {
  const clean = normalizeMemoryText(text);
  if (!workspace || !clean) {
    return null;
  }
  const normalizedScope = normalizeScope(scope);
  const fingerprint = memoryFingerprint({ scope: normalizedScope, scopeID, subject, text: clean });
  if (hasActiveFingerprint(workspace, fingerprint)) {
    return null;
  }
  const inferredKind = VALID_KINDS.has(kind) && kind !== "note" ? kind : classifyMemory(clean);
  const item = {
    version: 1,
    id: memoryID(),
    created_at: new Date().toISOString(),
    scope: normalizedScope,
    scope_id: String(scopeID || subject || ""),
    subject_type: subjectTypeForScope(scope),
    subject_id: String(subject || ""),
    subject: String(subject || ""),
    kind: inferredKind,
    text: clean,
    source: {
      type: source,
      platform: "qq"
    },
    confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : 1,
    source_message_id: String(sourceMessageID || ""),
    tags: [...new Set([...(Array.isArray(tags) ? tags : []), ...tagMemory(clean)].map(String).filter(Boolean))],
    fingerprint,
    deleted: false
  };
  ensureDir(path.dirname(memoryFile(workspace)));
  appendJSONObject(memoryFile(workspace), item);
  return item;
}

function searchMemories({ workspace, query = "", subject = "", scope = "", limit = 10 }) {
  const q = String(query || "").trim().toLowerCase();
  const wantedSubject = String(subject || "");
  const wantedScope = String(scope || "");
  const deleted = deletedIDs(workspace);
  const rows = readJSONLines(memoryFile(workspace))
    .filter((item) => item && !item.deleted && !deleted.has(item.id))
    .filter((item) => !wantedSubject || String(item.subject) === wantedSubject)
    .filter((item) => !wantedScope || String(item.scope) === wantedScope)
    .filter((item) => !q || memoryHaystack(item).includes(q));
  return rows.slice(-Math.max(1, limit)).reverse();
}

function searchMemoryEvidence({ workspace, query = "", subject = "", scope = "", limit = 8 }) {
  const q = String(query || "").trim().toLowerCase();
  const memoryItems = searchMemories({ workspace, query, subject, scope, limit });
  const candidateItems = readPendingCandidates({ workspace })
    .filter((item) => !q || memoryHaystack(item).includes(q))
    .slice(-Math.max(1, Math.min(10, Number(limit) || 8)))
    .reverse();
  return {
    memories: memoryItems,
    candidates: candidateItems
  };
}

function softDeleteMemories({ workspace, query, subject = "", scope = "" }) {
  const matches = searchMemories({ workspace, query, subject, scope, limit: 100 });
  if (matches.length === 0) {
    return 0;
  }
  ensureDir(path.dirname(deleteFile(workspace)));
  const now = new Date().toISOString();
  for (const item of matches) {
    appendJSONObject(deleteFile(workspace), {
      version: 1,
      time: now,
      deleted_at: now,
      deleted_by: "proxy-command",
      delete_keyword: String(query || ""),
      id: item.id,
      query: String(query || ""),
      subject: String(subject || ""),
      scope: String(scope || "")
    });
  }
  return matches.length;
}

function formatMemories(items) {
  if (!items || items.length === 0) {
    return "没找到结构化记忆。";
  }
  return [
    "结构化记忆：",
    ...items.map((item) => `- [${item.kind || "note"}] ${item.text} (${item.scope || "?"}:${item.subject || item.subject_id || "?"}, ${shortTime(item.created_at || item.time)})`)
  ].join("\n").slice(0, 1600);
}

function formatRecentMemories(items) {
  if (!items || items.length === 0) {
    return "当前会话还没有 active 记忆。";
  }
  return [
    "最近记忆：",
    ...items.map((item, index) => `${index + 1}. [${shortTime(item.created_at || item.time)}] [${item.kind || "note"}] ${redactSensitive(item.text)} (${item.scope || "?"}:${item.subject || item.subject_id || "?"})`)
  ].join("\n").slice(0, 1600);
}

function formatMemoryEvidence(evidence) {
  const memories = (evidence && evidence.memories) || [];
  const candidates = (evidence && evidence.candidates) || [];
  if (memories.length === 0 && candidates.length === 0) {
    return "没找到可解释的记忆证据。";
  }
  const lines = ["记忆证据："];
  lines.push("已确认记忆：");
  if (memories.length === 0) {
    lines.push("- 暂无");
  }
  for (const item of memories.slice(0, 6)) {
    lines.push(`- [memory/${item.kind || "note"}] ${shortEvidenceText(item.text)}`);
    lines.push(`  scope=${item.scope || "?"}:${item.scope_id || ""} subject=${item.subject_id || item.subject || ""} time=${shortTime(item.created_at || item.time) || "?"}`);
    lines.push(`  source=${sourceText(item)} tags=${(item.tags || []).slice(0, 5).join(",") || "-"}`);
  }
  lines.push("候选记忆（待确认）：");
  if (candidates.length === 0) {
    lines.push("- 暂无");
  }
  for (const item of candidates.slice(0, 4)) {
    lines.push(`- [candidate/${item.kind || "note"}] ${shortEvidenceText(item.text)}`);
    lines.push(`  scope=${item.scope || "?"}:${item.scope_id || ""} subject=${item.subject_id || item.user || ""} time=${shortTime(item.source_time || item.created_at) || "?"}`);
    lines.push(`  source=pending-candidate tags=${(item.tags || []).slice(0, 5).join(",") || "-"}`);
  }
  return lines.join("\n").slice(0, 1600);
}

function memoryStats({ workspace }) {
  const rows = readJSONLines(memoryFile(workspace));
  const deleted = deletedIDs(workspace);
  const active = rows.filter((item) => item && !item.deleted && !deleted.has(item.id));
  const byKind = {};
  for (const item of active) {
    const kind = item.kind || "note";
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  const latest = active.map((item) => item.created_at || item.time || "").filter(Boolean).sort().at(-1) || "";
  return {
    total: rows.length,
    active: active.length,
    deleted: deleted.size,
    latest,
    byKind
  };
}

function formatMemoryStats(stats) {
  const kinds = Object.entries(stats.byKind || {})
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind}:${count}`)
    .join("，") || "暂无";
  return [
    "记忆状态：",
    `总数：${stats.total}`,
    `有效：${stats.active}`,
    `软删：${stats.deleted}`,
    `分类：${kinds}`,
    `最近更新：${shortTime(stats.latest) || "暂无"}`
  ].join("\n");
}

function savePendingCandidates({ workspace, scope, scopeID = "", candidates = [] }) {
  if (!workspace || !Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }
  ensureDir(path.dirname(pendingCandidateFile(workspace)));
  const existing = readPendingCandidates({ workspace, includeApplied: true, includeSkipped: true });
  const activeKeys = new Set(existing.filter((item) => !item.applied_at && !item.skipped_at).map((item) => item.fingerprint || item.text));
  const saved = [];
  for (const candidate of candidates) {
    const text = normalizeMemoryText(candidate.text || "");
    const subject = String(candidate.user_id || candidate.user || "");
    const fingerprint = memoryFingerprint({ scope, scopeID, subject, text });
    if (!text || activeKeys.has(fingerprint)) {
      continue;
    }
    activeKeys.add(fingerprint);
    const item = {
      version: 1,
      id: `cand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      created_at: new Date().toISOString(),
      scope: normalizeScope(scope),
      scope_id: String(scopeID || ""),
      subject_id: subject,
      user: String(candidate.user || subject || "unknown"),
      kind: candidate.kind || classifyMemory(text),
      tags: Array.isArray(candidate.tags) ? candidate.tags : tagMemory(text),
      text,
      source_time: String(candidate.time || ""),
      fingerprint,
      applied_at: "",
      applied_by: ""
    };
    fs.appendFileSync(pendingCandidateFile(workspace), `${JSON.stringify(item)}\n`, "utf8");
    saved.push(item);
  }
  return saved;
}

function readPendingCandidates({ workspace, includeApplied = false, includeSkipped = false }) {
  return readJSONLines(pendingCandidateFile(workspace))
    .filter((item) => item && (includeApplied || !item.applied_at) && (includeSkipped || !item.skipped_at));
}

function searchPendingCandidates({ workspace, query = "", limit = 10 }) {
  const terms = searchTerms(query);
  const active = readPendingCandidates({ workspace });
  if (terms.length === 0) {
    return active.slice(-Math.max(1, Number(limit) || 10)).map((item, index) => ({ item, index: active.length - Math.min(active.length, Math.max(1, Number(limit) || 10)) + index + 1 }));
  }
  return active
    .map((item, index) => ({ item, index: index + 1 }))
    .filter(({ item }) => {
      const haystack = pendingCandidateHaystack(item);
      return terms.every((term) => haystack.includes(term));
    })
    .slice(-Math.max(1, Number(limit) || 10));
}

function formatPendingCandidates(items) {
  const active = (items || []).filter((item) => !item.applied_at && !item.skipped_at);
  if (active.length === 0) {
    return "暂无候选记忆。";
  }
  return [
    "候选记忆：",
    ...active.slice(-10).map((item, index) => `- ${index + 1}. [${item.kind || "note"}] ${item.user || item.subject_id}: ${item.text.slice(0, 90)}`)
  ].join("\n").slice(0, 1600);
}

function formatPendingCandidateSearch(results) {
  if (!results || results.length === 0) {
    return "没有匹配的待处理候选记忆。";
  }
  return [
    "候选记忆：",
    ...results.map(({ item, index }) => `- ${index}. [${item.kind || "note"}] ${item.user || item.subject_id}: ${String(item.text || "").slice(0, 90)}`)
  ].join("\n").slice(0, 1600);
}

function pendingCandidateHealth({ workspace, limit = 5 }) {
  const active = readPendingCandidates({ workspace });
  const byKind = {};
  const byTag = {};
  const fingerprints = new Map();
  const anomalies = [];
  for (const item of active) {
    const kind = item.kind || "note";
    byKind[kind] = (byKind[kind] || 0) + 1;
    for (const tag of item.tags || []) {
      byTag[tag] = (byTag[tag] || 0) + 1;
    }
    if (item.fingerprint) {
      fingerprints.set(item.fingerprint, (fingerprints.get(item.fingerprint) || 0) + 1);
    }
    const flags = pendingCandidateFlags(item);
    if (flags.length > 0) {
      anomalies.push({ item, flags });
    }
  }
  const duplicateFingerprints = [...fingerprints.values()].filter((count) => count > 1).length;
  const oldest = active
    .slice()
    .sort((a, b) => String(a.created_at || a.source_time || "").localeCompare(String(b.created_at || b.source_time || "")))
    .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)));
  return {
    active: active.length,
    byKind,
    byTag,
    duplicateFingerprints,
    anomalies,
    oldest
  };
}

function pendingCandidateTriage({ workspace, limit = 8 }) {
  const active = readPendingCandidates({ workspace });
  const fingerprintCounts = candidateFingerprintCounts(active);
  const buckets = {
    apply: [],
    skip: [],
    rewrite: []
  };
  active.forEach((item, index) => {
    const flags = pendingCandidateFlags(item);
    if (item.fingerprint && fingerprintCounts.get(item.fingerprint) > 1) {
      flags.push("重复");
    }
    const entry = { index: index + 1, item, flags };
    if (shouldSkipCandidate(item, flags)) {
      buckets.skip.push(entry);
    } else if (canApplyPendingCandidate(item)) {
      buckets.apply.push(entry);
    } else {
      buckets.rewrite.push(entry);
    }
  });
  const max = Math.max(1, Math.min(20, Number(limit) || 8));
  return {
    total: active.length,
    apply: buckets.apply.slice(0, max),
    skip: buckets.skip.slice(0, max),
    rewrite: buckets.rewrite.slice(0, max)
  };
}

function pendingCandidateSnapshot({ workspace, limit = 12, save = true }) {
  const active = readPendingCandidates({ workspace });
  const max = Math.max(1, Math.min(30, Number(limit) || 12));
  const report = {
    snapshot: pendingCandidateSnapshotHash(active),
    time: new Date().toISOString(),
    active: active.length,
    entries: active.map(snapshotEntry),
    items: active.slice(0, max).map((item, index) => ({
      index: index + 1,
      id: item.id || "",
      item
    }))
  };
  if (save) {
    savePendingSnapshot({ workspace, report });
  }
  return report;
}

function comparePendingCandidateSnapshot({ workspace, snapshot = "" }) {
  const current = pendingCandidateSnapshot({ workspace, limit: 1, save: false });
  const expected = String(snapshot || "").trim().toLowerCase();
  return {
    expected,
    current: current.snapshot,
    active: current.active,
    unchanged: Boolean(expected) && expected === current.snapshot
  };
}

function diffPendingCandidateSnapshot({ workspace, snapshot = "", limit = 5 }) {
  const expected = String(snapshot || "").trim().toLowerCase();
  const saved = findPendingSnapshot({ workspace, snapshot: expected });
  const current = pendingCandidateSnapshot({ workspace, limit: 1, save: false });
  if (!expected || !saved) {
    return { expected, current: current.snapshot, active: current.active, found: false, added: [], removed: [], modified: [] };
  }
  const currentEntries = current.entries || [];
  const oldByID = new Map((saved.entries || []).map((entry) => [entry.id, entry]));
  const currentByID = new Map(currentEntries.map((entry) => [entry.id, entry]));
  const added = currentEntries.filter((entry) => !oldByID.has(entry.id));
  const removed = (saved.entries || []).filter((entry) => !currentByID.has(entry.id));
  const modified = currentEntries.filter((entry) => oldByID.has(entry.id) && oldByID.get(entry.id).signature !== entry.signature);
  const max = Math.max(1, Math.min(10, Number(limit) || 5));
  return {
    expected,
    current: current.snapshot,
    active: current.active,
    found: true,
    added: added.slice(0, max),
    removed: removed.slice(0, max),
    modified: modified.slice(0, max),
    counts: { added: added.length, removed: removed.length, modified: modified.length }
  };
}

function latestPendingCandidateSnapshot({ workspace }) {
  const rows = readJSONLines(pendingSnapshotFile(workspace));
  return rows.length ? rows[rows.length - 1] : null;
}

function formatPendingCandidateSnapshotCompare(result) {
  const item = result || { expected: "", current: "", active: 0, unchanged: false };
  if (!item.expected) {
    return "用法：/候选记忆 对比 snapshot_sha";
  }
  return [
    "候选记忆快照对比：",
    `结果：${item.unchanged ? "未变化" : "已变化"}`,
    `expected: ${item.expected}`,
    `current: ${item.current}`,
    `待处理：${item.active}`
  ].join("\n");
}

function formatPendingCandidateSnapshotDiff(result) {
  const diff = result || { expected: "", current: "", active: 0, found: false, added: [], removed: [], modified: [], counts: {} };
  if (!diff.expected) {
    return "用法：/候选记忆 差异 snapshot_sha";
  }
  if (!diff.found) {
    return [
      "候选记忆快照差异：",
      "结果：找不到旧快照",
      `expected: ${diff.expected}`,
      `current: ${diff.current}`,
      `待处理：${diff.active}`,
      "提示：先用 /候选记忆 快照 生成可对比快照。"
    ].join("\n");
  }
  return [
    "候选记忆快照差异：",
    `expected: ${diff.expected}`,
    `current: ${diff.current}`,
    `待处理：${diff.active}`,
    `新增：${(diff.counts && diff.counts.added) || 0}`,
    ...formatSnapshotEntries(diff.added),
    `移除：${(diff.counts && diff.counts.removed) || 0}`,
    ...formatSnapshotEntries(diff.removed),
    `可能修改：${(diff.counts && diff.counts.modified) || 0}`,
    ...formatSnapshotEntries(diff.modified)
  ].join("\n").slice(0, 1800);
}

function formatPendingCandidateSnapshot(report) {
  const snapshot = report || { snapshot: "empty", time: "", active: 0, items: [] };
  const lines = [
    "候选记忆快照：",
    `snapshot: ${snapshot.snapshot}`,
    `生成时间：${shortTime(snapshot.time) || "?"}`,
    `待处理：${snapshot.active}`,
    "items:"
  ];
  if (!snapshot.items || snapshot.items.length === 0) {
    lines.push("- 暂无");
  } else {
    for (const entry of snapshot.items) {
      const item = entry.item || {};
      lines.push(`${entry.index}. id=${shortID(entry.id)} kind=${item.kind || "note"} user=${item.user || item.subject_id || "?"} text=${shortEvidenceText(item.text)}`);
    }
  }
  lines.push("用法：/处理候选记忆 应用:1,2 跳过:3");
  return lines.join("\n").slice(0, 1800);
}

function formatPendingCandidateTriage(report) {
  const triage = report || { total: 0, apply: [], skip: [], rewrite: [] };
  const lines = [
    "候选记忆分拣：",
    `待处理：${triage.total}`,
    "推荐应用：",
    ...formatTriageItems(triage.apply),
    "建议跳过：",
    ...formatTriageItems(triage.skip),
    "需人工改写：",
    ...formatTriageItems(triage.rewrite),
    "命令草案："
  ];
  const applyIndexes = triage.apply.map((entry) => entry.index);
  const skipIndexes = triage.skip.map((entry) => entry.index);
  lines.push(applyIndexes.length || skipIndexes.length
    ? `/处理候选记忆 应用:${applyIndexes.join(",") || "-"} 跳过:${skipIndexes.join(",") || "-"}`
    : "/处理候选记忆 应用:- 跳过:-");
  return lines.join("\n").slice(0, 1800);
}

function formatPendingCandidateHealth(report) {
  const health = report || { active: 0, byKind: {}, byTag: {}, duplicateFingerprints: 0, anomalies: [], oldest: [] };
  const lines = [
    "候选记忆体检：",
    `待处理：${health.active}`,
    `分类：${formatCounts(health.byKind)}`,
    `标签：${formatCounts(health.byTag)}`,
    `异常：${health.anomalies.length} 条${health.duplicateFingerprints ? `，重复 fingerprint ${health.duplicateFingerprints} 组` : ""}`,
    "最早待处理："
  ];
  if (!health.oldest || health.oldest.length === 0) {
    lines.push("- 暂无");
  } else {
    for (const item of health.oldest) {
      lines.push(`- [${shortTime(item.created_at || item.source_time) || "?"}] [${item.kind || "note"}] ${item.user || item.subject_id || "?"}: ${shortEvidenceText(item.text)}`);
    }
  }
  lines.push("异常明细：");
  if (!health.anomalies || health.anomalies.length === 0) {
    lines.push("- 暂无");
  } else {
    for (const { item, flags } of health.anomalies.slice(0, 6)) {
      lines.push(`- [${item.kind || "note"}] ${item.user || item.subject_id || "?"}: ${flags.join("，")}；${shortEvidenceText(item.text)}`);
    }
  }
  lines.push(`建议：${pendingCandidateHealthAdvice(health)}`);
  return lines.join("\n").slice(0, 1800);
}

function formatPendingCandidateRejectionSummary(rejectedReasons) {
  const counts = {};
  for (const reason of rejectedReasons || []) {
    for (const blocker of reason.blockers || []) {
      counts[blocker] = (counts[blocker] || 0) + 1;
    }
  }
  return formatCounts(counts);
}

function applyPendingCandidates({ workspace, selector, appliedBy = "", scopeID = "" }) {
  const all = readPendingCandidates({ workspace, includeApplied: true, includeSkipped: true });
  const active = all.filter((item) => !item.applied_at && !item.skipped_at);
  const indexes = selectCandidateIndexes(selector, active.length);
  if (indexes.length === 0) {
    return { applied: 0, items: [], rejected: 0, rejectedItems: [], rejectedReasons: [] };
  }
  const now = new Date().toISOString();
  const appliedItems = [];
  const rejectedItems = [];
  const rejectedReasons = [];
  for (const index of indexes) {
    const item = active[index];
    if (!item) continue;
    const blockers = pendingCandidateApplyBlockers(item);
    if (blockers.length > 0) {
      rejectedItems.push(item);
      rejectedReasons.push({ index: index + 1, id: item.id || "", kind: item.kind || "note", blockers });
      continue;
    }
    const memory = addMemoryFromCandidate({ workspace, item, scopeID });
    if (memory || hasActiveFingerprint(workspace, item.fingerprint)) {
      item.applied_at = now;
      item.applied_by = String(appliedBy || "");
      appliedItems.push(item);
    }
  }
  if (appliedItems.length > 0) {
    const activeApplied = new Map(appliedItems.map((item) => [item.id, item]));
    const rewritten = all.map((item) => activeApplied.get(item.id) || item);
    fs.writeFileSync(pendingCandidateFile(workspace), `${rewritten.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  }
  return { applied: appliedItems.length, items: appliedItems, rejected: rejectedItems.length, rejectedItems, rejectedReasons };
}

function processPendingCandidatesBatch({ workspace, applySelector = "", skipSelector = "", actedBy = "", scopeID = "" }) {
  const all = readPendingCandidates({ workspace, includeApplied: true, includeSkipped: true });
  const active = all.filter((item) => !item.applied_at && !item.skipped_at);
  const applyIndexes = selectCandidateIndexes(applySelector, active.length);
  const skipIndexes = selectCandidateIndexes(skipSelector, active.length);
  const applyIDs = new Set(applyIndexes.map((index) => active[index] && active[index].id).filter(Boolean));
  const skipIDs = new Set(skipIndexes.map((index) => active[index] && active[index].id).filter(Boolean));
  for (const id of applyIDs) {
    skipIDs.delete(id);
  }
  if (applyIDs.size === 0 && skipIDs.size === 0) {
    return { applied: 0, skipped: 0, rejected: 0, appliedItems: [], skippedItems: [], rejectedItems: [], rejectedReasons: [] };
  }
  const now = new Date().toISOString();
  const appliedItems = [];
  const skippedItems = [];
  const rejectedItems = [];
  const rejectedReasons = [];
  const rewritten = all.map((item) => {
    if (!item || item.applied_at || item.skipped_at) {
      return item;
    }
    if (applyIDs.has(item.id)) {
      const blockers = pendingCandidateApplyBlockers(item);
      if (blockers.length > 0) {
        rejectedItems.push(item);
        const index = active.findIndex((activeItem) => activeItem && activeItem.id === item.id);
        rejectedReasons.push({ index: index >= 0 ? index + 1 : 0, id: item.id || "", kind: item.kind || "note", blockers });
        return item;
      }
      const memory = addMemoryFromCandidate({ workspace, item, scopeID });
      if (memory || hasActiveFingerprint(workspace, item.fingerprint)) {
        const next = { ...item, applied_at: now, applied_by: String(actedBy || "") };
        appliedItems.push(next);
        return next;
      }
      return item;
    }
    if (skipIDs.has(item.id)) {
      const next = { ...item, skipped_at: now, skipped_by: String(actedBy || "") };
      skippedItems.push(next);
      return next;
    }
    return item;
  });
  if (appliedItems.length > 0 || skippedItems.length > 0) {
    fs.writeFileSync(pendingCandidateFile(workspace), `${rewritten.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  }
  return { applied: appliedItems.length, skipped: skippedItems.length, rejected: rejectedItems.length, appliedItems, skippedItems, rejectedItems, rejectedReasons };
}

function formatPendingCandidateBatchResult(result) {
  const applied = result && result.applied ? result.applied : 0;
  const skipped = result && result.skipped ? result.skipped : 0;
  const rejected = result && result.rejected ? result.rejected : 0;
  if (!applied && !skipped && !rejected) {
    return "没有可处理的候选。";
  }
  const suffix = rejected ? `，拒绝 ${rejected} 条：${formatPendingCandidateRejectionSummary(result.rejectedReasons)}` : "";
  return `已处理候选记忆：应用 ${applied} 条，跳过 ${skipped} 条${suffix}。`;
}

function formatPendingCandidateApplyResult(result) {
  const applied = result && result.applied ? result.applied : 0;
  const rejected = result && result.rejected ? result.rejected : 0;
  if (applied > 0) {
    const suffix = rejected ? `，拒绝 ${rejected} 条：${formatPendingCandidateRejectionSummary(result.rejectedReasons)}` : "";
    return `已应用 ${applied} 条候选记忆${suffix}。`;
  }
  if (rejected > 0) {
    return `没有可应用的候选。拒绝 ${rejected} 条：${formatPendingCandidateRejectionSummary(result.rejectedReasons)}。`;
  }
  return "没有可应用的候选。";
}

function applyPendingCandidatesWith({ workspace, selector, appliedBy = "", filter = () => true, applyItem }) {
  const all = readPendingCandidates({ workspace, includeApplied: true, includeSkipped: true });
  const active = all.filter((item) => !item.applied_at && !item.skipped_at && filter(item));
  const indexes = selectCandidateIndexes(selector, active.length);
  if (indexes.length === 0) {
    return { applied: 0, items: [] };
  }
  const now = new Date().toISOString();
  const appliedItems = [];
  for (const index of indexes) {
    const item = active[index];
    if (!item) continue;
    const ok = applyItem ? applyItem(item) : true;
    if (ok) {
      item.applied_at = now;
      item.applied_by = String(appliedBy || "");
      appliedItems.push(item);
    }
  }
  if (appliedItems.length > 0) {
    const activeApplied = new Map(appliedItems.map((item) => [item.id, item]));
    const rewritten = all.map((item) => activeApplied.get(item.id) || item);
    fs.writeFileSync(pendingCandidateFile(workspace), `${rewritten.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  }
  return { applied: appliedItems.length, items: appliedItems };
}

function skipPendingCandidates({ workspace, selector, skippedBy = "" }) {
  const all = readPendingCandidates({ workspace, includeApplied: true, includeSkipped: true });
  const active = all.filter((item) => !item.applied_at && !item.skipped_at);
  const indexes = selectCandidateIndexes(selector, active.length);
  if (indexes.length === 0) {
    return { skipped: 0, items: [] };
  }
  const now = new Date().toISOString();
  const skippedItems = [];
  for (const index of indexes) {
    const item = active[index];
    if (!item) continue;
    item.skipped_at = now;
    item.skipped_by = String(skippedBy || "");
    skippedItems.push(item);
  }
  if (skippedItems.length > 0) {
    const skipped = new Map(skippedItems.map((item) => [item.id, item]));
    const rewritten = all.map((item) => skipped.get(item.id) || item);
    fs.writeFileSync(pendingCandidateFile(workspace), `${rewritten.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  }
  return { skipped: skippedItems.length, items: skippedItems };
}

function pendingCandidateStats({ workspace }) {
  const all = readPendingCandidates({ workspace, includeApplied: true, includeSkipped: true });
  const stats = { total: all.length, active: 0, applied: 0, skipped: 0 };
  for (const item of all) {
    if (item.applied_at) stats.applied += 1;
    else if (item.skipped_at) stats.skipped += 1;
    else stats.active += 1;
  }
  return stats;
}

function formatPendingCandidateStats(stats) {
  return [
    "候选记忆状态：",
    `总数：${stats.total}`,
    `待处理：${stats.active}`,
    `已应用：${stats.applied}`,
    `已跳过：${stats.skipped}`
  ].join("\n");
}

function inferKind(text) {
  return classifyMemory(text);
}

function readJSONLines(file) {
  return readJSONLShards(file);
}

function deletedIDs(workspace) {
  return new Set(readJSONLines(deleteFile(workspace)).map((item) => item.id).filter(Boolean));
}

function hasActiveFingerprint(workspace, fingerprint) {
  if (!fingerprint) {
    return false;
  }
  const deleted = deletedIDs(workspace);
  return readJSONLines(memoryFile(workspace)).some((item) =>
    item && item.fingerprint === fingerprint && !item.deleted && !deleted.has(item.id)
  );
}

function selectCandidateIndexes(selector, length) {
  const raw = String(selector || "").trim().toLowerCase();
  if (!raw) return [];
  if (raw === "all" || raw === "全部") {
    return Array.from({ length }, (_, index) => index);
  }
  return raw.split(/[,\s，、]+/)
    .map((part) => Number(part))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= length)
    .map((n) => n - 1);
}

function memoryHaystack(item) {
  return [
    item.text,
    item.kind,
    item.scope,
    item.subject,
    ...(item.tags || [])
  ].join("\n").toLowerCase();
}

function pendingCandidateHaystack(item) {
  return [
    item.text,
    item.kind,
    item.user,
    item.subject_id,
    ...(item.tags || [])
  ].join("\n").toLowerCase();
}

function pendingCandidateFlags(item) {
  const flags = [];
  const text = String((item && item.text) || "");
  if (!text.trim()) {
    flags.push("空文本");
  }
  if (text.length > 180) {
    flags.push("过长");
  }
  if (looksSensitive(text)) {
    flags.push("疑似敏感");
  }
  if (/^\/|^\s*(help|status)$/i.test(text)) {
    flags.push("命令残留");
  }
  if (/^\[图片\]|\[表情包|^\[QQ表情/.test(text)) {
    flags.push("图片/表情占位");
  }
  if (!item.tags || item.tags.length === 0) {
    flags.push("空标签");
  }
  if (!item.kind || item.kind === "note") {
    flags.push("低分类置信度");
  }
  return flags;
}

function addMemoryFromCandidate({ workspace, item, scopeID = "" }) {
  if (!canApplyPendingCandidate(item)) {
    return null;
  }
  return addMemory({
    workspace,
    scope: item.scope,
    scopeID: item.scope_id || scopeID,
    subject: item.subject_id || item.scope_id || "",
    kind: item.kind,
    text: item.text,
    source: "candidate",
    tags: item.tags || [],
    confidence: 0.8
  });
}

function canApplyPendingCandidate(item) {
  return pendingCandidateApplyBlockers(item).length === 0;
}

function pendingCandidateApplyBlockers(item) {
  const candidate = item || {};
  const hardFlags = new Set(["空文本", "疑似敏感", "命令残留", "图片/表情占位", "低分类置信度"]);
  const blockers = pendingCandidateFlags(candidate).filter((flag) => hardFlags.has(flag));
  const kind = candidate.kind || "note";
  if (!["preference", "boundary", "project"].includes(kind) && !blockers.includes("低分类置信度")) {
    blockers.push(kind === "todo" ? "todo需走待办或改写" : "分类不适合长期记忆");
  }
  return blockers;
}

function savePendingSnapshot({ workspace, report }) {
  if (!workspace || !report || !report.snapshot) return;
  ensureDir(path.dirname(pendingSnapshotFile(workspace)));
  appendJSONObject(pendingSnapshotFile(workspace), {
    version: 1,
    snapshot: report.snapshot,
    time: report.time,
    active: report.active,
    entries: report.entries || []
  });
}

function findPendingSnapshot({ workspace, snapshot }) {
  const wanted = String(snapshot || "").trim().toLowerCase();
  if (!wanted) return null;
  return readJSONLines(pendingSnapshotFile(workspace)).reverse().find((item) => String(item.snapshot || "").toLowerCase() === wanted) || null;
}

function snapshotEntry(item) {
  const text = String((item && item.text) || "");
  const entry = {
    id: String((item && item.id) || ""),
    fingerprint: String((item && item.fingerprint) || ""),
    kind: String((item && item.kind) || "note"),
    user: String((item && (item.user || item.subject_id)) || "?"),
    text: shortEvidenceText(text)
  };
  entry.signature = stableHash([
    entry.id,
    entry.fingerprint,
    entry.kind,
    entry.user,
    text
  ].join("|"));
  return entry;
}

function formatSnapshotEntries(items) {
  if (!items || items.length === 0) return ["- 暂无"];
  return items.map((entry) => `- id=${shortID(entry.id)} kind=${entry.kind || "note"} user=${entry.user || "?"} text=${shortEvidenceText(entry.text)}`);
}

function candidateFingerprintCounts(items) {
  const counts = new Map();
  for (const item of items || []) {
    if (item && item.fingerprint) {
      counts.set(item.fingerprint, (counts.get(item.fingerprint) || 0) + 1);
    }
  }
  return counts;
}

function shouldSkipCandidate(item, flags) {
  return flags.some((flag) => ["空文本", "疑似敏感", "命令残留", "图片/表情占位"].includes(flag));
}

function pendingCandidateHealthAdvice(health) {
  if (!health || health.active === 0) {
    return "暂无待处理候选。";
  }
  if (health.anomalies && health.anomalies.some(({ flags }) => flags.includes("疑似敏感"))) {
    return "先跳过或人工改写疑似敏感候选，再应用 preference/boundary/project。";
  }
  if ((health.byKind && (health.byKind.preference || health.byKind.boundary)) || 0) {
    return "优先应用 preference/boundary，它们最能减少后续模型反复询问。";
  }
  if (health.duplicateFingerprints) {
    return "先处理重复候选，避免同一事实被反复确认。";
  }
  return "按最早待处理顺序人工确认，保持候选队列短。";
}

function formatCounts(counts) {
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length ? entries.map(([key, count]) => `${key}:${count}`).join("，") : "暂无";
}

function formatTriageItems(items) {
  if (!items || items.length === 0) {
    return ["- 暂无"];
  }
  return items.map(({ index, item, flags }) => {
    const suffix = formatTriageFlags(item, flags);
    return `- ${index}. [${item.kind || "note"}] ${item.user || item.subject_id || "?"}: ${shortEvidenceText(item.text)}${suffix}`;
  });
}

function formatTriageFlags(item, flags) {
  const allFlags = Array.isArray(flags) ? flags : [];
  const blockers = pendingCandidateApplyBlockers(item);
  if (allFlags.length === 0 && blockers.length === 0) {
    return "";
  }
  const blockerSet = new Set(blockers);
  const hard = blockers.slice();
  const hints = allFlags.filter((flag) => !blockerSet.has(flag));
  const parts = [];
  if (hard.length > 0) {
    parts.push(`阻断: ${hard.join("，")}`);
  }
  if (hints.length > 0) {
    parts.push(`提示: ${hints.join("，")}`);
  }
  return parts.length ? ` (${parts.join("；")})` : "";
}

function looksSensitive(value) {
  return sharedLooksSensitive(value);
}

function searchTerms(query) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function sourceText(item) {
  const source = item && item.source && typeof item.source === "object" ? item.source : {};
  const type = source.type || item.source || "unknown";
  const message = item.source_message_id ? ` message=${item.source_message_id}` : "";
  const platform = source.platform ? ` platform=${source.platform}` : "";
  return `${type}${platform}${message}`;
}

function redactSensitive(value) {
  return redactSecrets(value);
}

function shortEvidenceText(value) {
  const text = redactSensitive(value).replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function normalizeScope(scope) {
  return ["group", "member", "private"].includes(scope) ? scope : "group";
}

function subjectTypeForScope(scope) {
  if (scope === "member") return "member";
  if (scope === "private") return "private_user";
  return "group";
}

function memoryID() {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function shortID(value) {
  const text = String(value || "");
  if (!text) return "-";
  return text.length > 18 ? `${text.slice(0, 18)}...` : text;
}

function stableHash(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

function pendingCandidateSnapshotHash(active) {
  const source = (active || []).map((item) => [
    item.id || "",
    item.fingerprint || "",
    item.created_at || "",
    item.source_time || "",
    item.kind || "",
    item.text || ""
  ].join("|")).join("\n");
  return stableHash(source || "empty");
}

function shortTime(value) {
  return String(value || "").replace("T", " ").slice(0, 16);
}

module.exports = {
  addMemory,
  searchMemories,
  searchMemoryEvidence,
  softDeleteMemories,
  formatMemories,
  formatRecentMemories,
  formatMemoryEvidence,
  memoryStats,
  formatMemoryStats,
  savePendingCandidates,
  readPendingCandidates,
  searchPendingCandidates,
  formatPendingCandidates,
  formatPendingCandidateSearch,
  pendingCandidateSnapshot,
  formatPendingCandidateSnapshot,
  comparePendingCandidateSnapshot,
  formatPendingCandidateSnapshotCompare,
  diffPendingCandidateSnapshot,
  formatPendingCandidateSnapshotDiff,
  latestPendingCandidateSnapshot,
  pendingCandidateHealth,
  formatPendingCandidateHealth,
  pendingCandidateTriage,
  formatPendingCandidateTriage,
  processPendingCandidatesBatch,
  formatPendingCandidateBatchResult,
  formatPendingCandidateApplyResult,
  applyPendingCandidates,
  applyPendingCandidatesWith,
  skipPendingCandidates,
  pendingCandidateStats,
  formatPendingCandidateStats,
  inferKind,
  canApplyPendingCandidate,
  pendingCandidateApplyBlockers,
  pendingCandidateFlags
};
