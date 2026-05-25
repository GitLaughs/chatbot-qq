#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { memoryCandidatesFromSamples } = require("./lib/memory-rules");
const {
  applyPendingCandidates,
  comparePendingCandidateSnapshot,
  formatPendingCandidateTriage,
  latestPendingCandidateSnapshot,
  pendingCandidateHealth,
  pendingCandidateSnapshot,
  pendingCandidateStats,
  pendingCandidateTriage,
  processPendingCandidatesBatch,
  readPendingCandidates,
  savePendingCandidates,
  searchMemories
} = require("./lib/memory-store");

const samples = [
  { user: "Alice", user_id: "1", text: "以后回答默认短答，先给结论", time: "2026-05-24T09:00:00.000Z" },
  { user: "Alice", user_id: "1", text: "以后回答默认短答，先给结论", time: "2026-05-24T09:01:00.000Z" },
  { user: "Bob", user_id: "2", text: "明天记得整理 QQ bot 的待办", time: "2026-05-24T09:02:00.000Z" },
  { user: "Carol", user_id: "3", text: "不要把普通聊天记忆写到项目根目录", time: "2026-05-24T09:03:00.000Z" },
  { user: "Dave", user_id: "4", text: "项目计划是先做确定性脚本再部署测试", time: "2026-05-24T09:04:00.000Z" },
  { user: "Eve", user_id: "5", text: "token=secret-value 默认短答", time: "2026-05-24T09:05:00.000Z" },
  { user: "Frank", user_id: "6", text: "/status", time: "2026-05-24T09:06:00.000Z" },
  { user: "Grace", user_id: "7", text: "[图片] 默认短答", time: "2026-05-24T09:07:00.000Z" },
  { user: "Heidi", user_id: "8", text: "普通闲聊没有明确规则", time: "2026-05-24T09:08:00.000Z" }
];

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.json && options.table) {
    throw new Error("--json and --table are mutually exclusive");
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pending-memory-lifecycle-"));
  try {
    const rows = runLifecycle(temp);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, checked: rows.length, rows }, null, 2)}\n`);
      return;
    }
    if (options.table) {
      process.stdout.write(`${formatTable(rows)}\n`);
      return;
    }
    process.stdout.write(`OK pending memory lifecycle canaries passed. checked=${rows.length}\n`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function runLifecycle(workspace) {
  const rows = [];
  const candidates = memoryCandidatesFromSamples(samples, { limit: 10 });
  assert.deepStrictEqual(candidates.map((item) => `${item.user}:${item.kind}`), [
    "Alice:preference",
    "Bob:todo",
    "Carol:boundary",
    "Dave:project"
  ]);
  assert.doesNotMatch(JSON.stringify(candidates), /secret-value|\/status|\[图片\]|普通闲聊/);
  rows.push(record("generate", "candidate-kinds", candidates.map((item) => item.kind).join(","), "filtered risky and note samples"));

  const saved = savePendingCandidates({ workspace, scope: "group", scopeID: "123456789", candidates });
  assert.strictEqual(saved.length, 4);
  const savedAgain = savePendingCandidates({ workspace, scope: "group", scopeID: "123456789", candidates });
  assert.strictEqual(savedAgain.length, 0);
  assert.strictEqual(readPendingCandidates({ workspace }).length, 4);
  rows.push(record("save", "dedupe", "4 active", "duplicate save writes no new candidates"));

  rows.push(...checkApplySafetyLock(candidates));

  appendManualPendingCandidate(workspace, {
    id: "manual_secret",
    kind: "preference",
    tags: ["style"],
    text: "token=secret-value 默认短答",
    user: "Mallory",
    subject_id: "9"
  });
  appendManualPendingCandidate(workspace, {
    id: "manual_command",
    kind: "note",
    tags: [],
    text: "/status",
    user: "Ops",
    subject_id: "10"
  });

  const health = pendingCandidateHealth({ workspace, limit: 10 });
  assert.strictEqual(health.active, 6);
  assert.strictEqual(health.byKind.preference, 2);
  assert.strictEqual(health.byKind.todo, 1);
  assert.strictEqual(health.byKind.boundary, 1);
  assert.strictEqual(health.byKind.project, 1);
  assert.ok(health.anomalies.some(({ item, flags }) => item.id === "manual_secret" && flags.includes("疑似敏感")));
  assert.ok(health.anomalies.some(({ item, flags }) => item.id === "manual_command" && flags.includes("命令残留")));
  rows.push(record("health", "flags", `${health.active} active`, "manual risky residue is visible"));

  const triage = pendingCandidateTriage({ workspace, limit: 10 });
  assert.deepStrictEqual(triage.apply.map((entry) => entry.item.kind), ["preference", "boundary", "project"]);
  assert.deepStrictEqual(triage.skip.map((entry) => entry.item.id), ["manual_secret", "manual_command"]);
  assert.deepStrictEqual(triage.rewrite.map((entry) => entry.item.kind), ["todo"]);
  const triageText = formatPendingCandidateTriage(triage);
  assert.match(triageText, /2\. \[todo\].*阻断: todo需走待办或改写/);
  assert.match(triageText, /6\. \[note\].*阻断: 命令残留，低分类置信度/);
  rows.push(record("triage", "apply-skip-rewrite", "3/2/1", "todo is pending but not auto-apply advice"));

  const snapshot = pendingCandidateSnapshot({ workspace, limit: 10, save: true });
  assert.strictEqual(snapshot.active, 6);
  assert.ok(snapshot.snapshot);
  assert.strictEqual(latestPendingCandidateSnapshot({ workspace }).snapshot, snapshot.snapshot);
  assert.strictEqual(comparePendingCandidateSnapshot({ workspace, snapshot: snapshot.snapshot }).unchanged, true);
  rows.push(record("snapshot", "stable-before-action", snapshot.snapshot.slice(0, 12), "saved snapshot compares unchanged"));

  const applySelector = triage.apply.map((entry) => entry.index).join(",");
  const skipSelector = triage.skip.map((entry) => entry.index).join(",");
  const batch = processPendingCandidatesBatch({
    workspace,
    applySelector,
    skipSelector,
    actedBy: "canary",
    scopeID: "123456789"
  });
  assert.strictEqual(batch.applied, 3);
  assert.strictEqual(batch.skipped, 2);
  const stats = pendingCandidateStats({ workspace });
  assert.deepStrictEqual(stats, { total: 6, active: 1, applied: 3, skipped: 2 });
  const memories = searchMemories({ workspace, query: "", limit: 10 });
  assert.deepStrictEqual(memories.map((item) => item.kind).sort(), ["boundary", "preference", "project"]);
  assert.doesNotMatch(JSON.stringify(memories), /secret-value|\/status|明天记得/);
  assert.strictEqual(comparePendingCandidateSnapshot({ workspace, snapshot: snapshot.snapshot }).unchanged, false);
  rows.push(record("batch", "apply-and-skip", "applied=3 skipped=2 active=1", "only preference/boundary/project became memories"));

  return rows;
}

function checkApplySafetyLock(candidates) {
  const rows = [];
  const applyAllWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "pending-memory-apply-all-"));
  const riskWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "pending-memory-risk-"));
  const hintWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "pending-memory-hint-"));
  const hintTriageWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "pending-memory-hint-triage-"));
  try {
    savePendingCandidates({ workspace: applyAllWorkspace, scope: "group", scopeID: "123456789", candidates });
    const unsafeApply = applyPendingCandidates({
      workspace: applyAllWorkspace,
      selector: "all",
      appliedBy: "canary-unsafe",
      scopeID: "123456789"
    });
    assert.strictEqual(unsafeApply.applied, 3);
    assert.strictEqual(unsafeApply.rejected, 1);
    assert.deepStrictEqual(unsafeApply.items.map((item) => item.kind).sort(), ["boundary", "preference", "project"]);
    assert.deepStrictEqual(unsafeApply.rejectedItems.map((item) => item.kind), ["todo"]);
    assert.strictEqual(readPendingCandidates({ workspace: applyAllWorkspace }).length, 1);
    const safeMemories = searchMemories({ workspace: applyAllWorkspace, query: "", limit: 10 });
    assert.deepStrictEqual(safeMemories.map((item) => item.kind).sort(), ["boundary", "preference", "project"]);
    assert.doesNotMatch(JSON.stringify(safeMemories), /明天记得/);
    rows.push(record("safety-lock", "apply-all", "applied=3 rejected=1", "todo stays active even when selector is all"));

    appendManualPendingCandidate(riskWorkspace, {
      id: "manual_secret",
      kind: "preference",
      tags: ["style"],
      text: "token=secret-value 默认短答",
      user: "Mallory",
      subject_id: "9"
    });
    appendManualPendingCandidate(riskWorkspace, {
      id: "manual_command",
      kind: "note",
      tags: [],
      text: "/status",
      user: "Ops",
      subject_id: "10"
    });
    const riskyApply = applyPendingCandidates({
      workspace: riskWorkspace,
      selector: "all",
      appliedBy: "canary-risk",
      scopeID: "123456789"
    });
    assert.strictEqual(riskyApply.applied, 0);
    assert.strictEqual(riskyApply.rejected, 2);
    assert.strictEqual(searchMemories({ workspace: riskWorkspace, query: "", limit: 10 }).length, 0);
    assert.strictEqual(readPendingCandidates({ workspace: riskWorkspace }).length, 2);
    rows.push(record("safety-lock", "reject-risky", "rejected=2", "secret and command cannot be applied"));

    appendManualPendingCandidate(hintWorkspace, {
      id: "manual_empty_tag_preference",
      kind: "preference",
      tags: [],
      text: "以后默认用中文",
      user: "Alice",
      subject_id: "1"
    });
    const hintApply = applyPendingCandidates({
      workspace: hintWorkspace,
      selector: "all",
      appliedBy: "canary-hint",
      scopeID: "123456789"
    });
    assert.strictEqual(hintApply.applied, 1);
    assert.strictEqual(hintApply.rejected, 0);
    assert.strictEqual(searchMemories({ workspace: hintWorkspace, query: "中文", limit: 10 }).length, 1);
    rows.push(record("safety-lock", "empty-tag-hint", "applied=1", "empty tag is a warning, not a hard blocker"));

    const triageAfterEmptyTag = pendingCandidateTriage({ workspace: hintWorkspace, limit: 10 });
    assert.strictEqual(triageAfterEmptyTag.rewrite.length, 0);

    appendManualPendingCandidate(hintWorkspace, {
      id: "manual_long_project",
      kind: "project",
      tags: ["code"],
      text: `项目计划是${"继续用确定性规则减少模型重复判断，".repeat(12)}`,
      user: "Planner",
      subject_id: "2"
    });
    const longApply = applyPendingCandidates({
      workspace: hintWorkspace,
      selector: "all",
      appliedBy: "canary-long",
      scopeID: "123456789"
    });
    assert.strictEqual(longApply.applied, 1);
    assert.strictEqual(longApply.rejected, 0);
    assert.strictEqual(searchMemories({ workspace: hintWorkspace, query: "确定性规则", limit: 10 }).length, 1);
    rows.push(record("safety-lock", "long-project-hint", "applied=1", "long text is a warning, not a hard blocker"));

    appendManualPendingCandidate(hintTriageWorkspace, {
      id: "manual_empty_tag_preference",
      kind: "preference",
      tags: [],
      text: "以后默认用中文",
      user: "Alice",
      subject_id: "1"
    });
    appendManualPendingCandidate(hintTriageWorkspace, {
      id: "manual_long_project",
      kind: "project",
      tags: ["code"],
      text: `项目计划是${"继续用确定性规则减少模型重复判断，".repeat(12)}`,
      user: "Planner",
      subject_id: "2"
    });
    const hintTriage = pendingCandidateTriage({ workspace: hintTriageWorkspace, limit: 10 });
    assert.deepStrictEqual(hintTriage.apply.map((entry) => entry.index), [1, 2]);
    assert.strictEqual(hintTriage.rewrite.length, 0);
    const hintTriageText = formatPendingCandidateTriage(hintTriage);
    assert.match(hintTriageText, /1\. \[preference\].*提示: 空标签/);
    assert.match(hintTriageText, /2\. \[project\].*提示: 过长/);
    assert.doesNotMatch(hintTriageText, /阻断: 空标签|阻断: 过长/);
    rows.push(record("triage", "hint-apply", "apply=1,2", "empty tag and long text stay in apply bucket with hints"));
  } finally {
    fs.rmSync(applyAllWorkspace, { recursive: true, force: true });
    fs.rmSync(riskWorkspace, { recursive: true, force: true });
    fs.rmSync(hintWorkspace, { recursive: true, force: true });
    fs.rmSync(hintTriageWorkspace, { recursive: true, force: true });
  }
  return rows;
}

function appendManualPendingCandidate(workspace, item) {
  const file = path.join(workspace, "memory", "pending-memory-candidates.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({
    version: 1,
    created_at: "2026-05-24T09:10:00.000Z",
    scope: "group",
    scope_id: "123456789",
    fingerprint: item.id,
    applied_at: "",
    applied_by: "",
    skipped_at: "",
    skipped_by: "",
    ...item
  })}\n`, "utf8");
}

function record(type, name, result, note) {
  return { type, name, result, note };
}

function parseArgs(argv) {
  const options = {
    json: false,
    table: false
  };
  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--table") {
      options.table = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function formatTable(rows) {
  const headers = ["type", "name", "result", "note"];
  const widths = headers.map((header) => Math.max(header.length, ...rows.map((row) => String(row[header]).length)));
  const line = (values) => values.map((value, index) => String(value).padEnd(widths[index])).join("  ");
  return [
    line(headers),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map((row) => line(headers.map((header) => row[header])))
  ].join("\n");
}

function printHelp() {
  process.stdout.write([
    "Usage: node scripts/check-pending-memory-lifecycle-canaries.js [--table|--json]",
    "",
    "Checks pending memory candidate lifecycle in a temporary workspace only."
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR pending memory lifecycle canaries failed: ${error.message}\n`);
  process.exit(1);
}
