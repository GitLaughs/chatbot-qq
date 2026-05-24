#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  canApplyPendingCandidate,
  formatPendingCandidateTriage,
  pendingCandidateApplyBlockers,
  pendingCandidateFlags,
  pendingCandidateTriage
} = require("./lib/memory-store");

const base = {
  version: 1,
  created_at: "2026-05-24T09:00:00.000Z",
  scope: "group",
  scope_id: "1107099585",
  subject_id: "1",
  user: "User",
  applied_at: "",
  skipped_at: ""
};

const cases = [
  {
    name: "preference-clean",
    item: { kind: "preference", tags: ["style"], text: "以后回答默认短答，先给结论" },
    bucket: "apply",
    canApply: true,
    blockers: [],
    hints: []
  },
  {
    name: "boundary-empty-tag",
    item: { kind: "boundary", tags: [], text: "不要把普通聊天记忆写到项目根目录" },
    bucket: "apply",
    canApply: true,
    blockers: [],
    hints: ["空标签"]
  },
  {
    name: "project-long",
    item: { kind: "project", tags: ["code"], text: `项目计划是${"继续用确定性规则减少模型重复判断，".repeat(12)}` },
    bucket: "apply",
    canApply: true,
    blockers: [],
    hints: ["过长"]
  },
  {
    name: "todo-clean",
    item: { kind: "todo", tags: ["todo"], text: "明天记得整理 QQ bot 的待办" },
    bucket: "rewrite",
    canApply: false,
    blockers: ["todo需走待办或改写"],
    hints: []
  },
  {
    name: "note-low-confidence",
    item: { kind: "note", tags: [], text: "这个信息可能有用但需要人工改写" },
    bucket: "rewrite",
    canApply: false,
    blockers: ["低分类置信度"],
    hints: ["空标签"]
  },
  {
    name: "secret",
    item: { kind: "preference", tags: ["style"], text: "token=secret-value 默认短答" },
    bucket: "skip",
    canApply: false,
    blockers: ["疑似敏感"],
    hints: []
  },
  {
    name: "command",
    item: { kind: "note", tags: [], text: "/status" },
    bucket: "skip",
    canApply: false,
    blockers: ["命令残留", "低分类置信度"],
    hints: ["空标签"]
  },
  {
    name: "image-placeholder",
    item: { kind: "preference", tags: ["style"], text: "[图片] 默认短答" },
    bucket: "skip",
    canApply: false,
    blockers: ["图片/表情占位"],
    hints: []
  },
  {
    name: "empty-text",
    item: { kind: "preference", tags: ["style"], text: "" },
    bucket: "skip",
    canApply: false,
    blockers: ["空文本"],
    hints: []
  }
];

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.json && options.table) {
    throw new Error("--json and --table are mutually exclusive");
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pending-memory-matrix-"));
  try {
    const rows = runMatrix(temp);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, checked: rows.length, rows }, null, 2)}\n`);
      return;
    }
    if (options.table) {
      process.stdout.write(`${formatTable(rows)}\n`);
      return;
    }
    process.stdout.write(`OK pending memory classification matrix passed. checked=${rows.length}\n`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function runMatrix(workspace) {
  const file = path.join(workspace, "memory", "pending-memory-candidates.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const items = cases.map((entry, index) => ({
    ...base,
    id: `matrix_${index + 1}_${entry.name}`,
    fingerprint: `matrix_${index + 1}_${entry.name}`,
    subject_id: String(index + 1),
    user: `User${index + 1}`,
    ...entry.item
  }));
  fs.writeFileSync(file, items.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

  const triage = pendingCandidateTriage({ workspace, limit: 20 });
  const text = formatPendingCandidateTriage(triage);
  const rows = cases.map((entry, index) => {
    const item = items[index];
    const flags = pendingCandidateFlags(item);
    const blockers = pendingCandidateApplyBlockers(item);
    const hints = flags.filter((flag) => !blockers.includes(flag));
    assert.strictEqual(canApplyPendingCandidate(item), entry.canApply, `${entry.name} canApply mismatch`);
    assert.deepStrictEqual(blockers, entry.blockers, `${entry.name} blockers mismatch`);
    assert.deepStrictEqual(hints, entry.hints, `${entry.name} hints mismatch`);
    assertBucket(triage, entry.bucket, index + 1, entry.name);
    assertFormattedReason(text, index + 1, entry);
    return {
      name: entry.name,
      bucket: entry.bucket,
      canApply: String(entry.canApply),
      blockers: blockers.join(",") || "-",
      hints: hints.join(",") || "-"
    };
  });
  assert.match(text, /命令草案：\n\/处理候选记忆 应用:1,2,3 跳过:6,7,8,9/);
  return rows;
}

function assertBucket(triage, bucket, index, name) {
  const list = triage[bucket] || [];
  assert.ok(list.some((entry) => entry.index === index), `${name} should be in ${bucket}`);
  for (const other of ["apply", "skip", "rewrite"].filter((item) => item !== bucket)) {
    assert.ok(!(triage[other] || []).some((entry) => entry.index === index), `${name} should not be in ${other}`);
  }
}

function assertFormattedReason(text, index, entry) {
  const linePattern = new RegExp(`- ${index}\\. \\[[^\\]]+\\].*`);
  const match = text.match(linePattern);
  assert.ok(match, `${entry.name} line missing`);
  const line = match[0];
  if (entry.blockers.length > 0) {
    assert.match(line, new RegExp(`阻断: ${escapeRegex(entry.blockers.join("，"))}`), `${entry.name} blocker text missing`);
  } else {
    assert.doesNotMatch(line, /阻断:/, `${entry.name} should not show blockers`);
  }
  if (entry.hints.length > 0) {
    assert.match(line, new RegExp(`提示: ${escapeRegex(entry.hints.join("，"))}`), `${entry.name} hint text missing`);
  } else {
    assert.doesNotMatch(line, /提示:/, `${entry.name} should not show hints`);
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const headers = ["name", "bucket", "canApply", "blockers", "hints"];
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
    "Usage: node scripts/check-pending-memory-classification-matrix.js [--table|--json]",
    "",
    "Checks pending memory kind/flag classification without reading private workspaces."
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR pending memory classification matrix failed: ${error.message}\n`);
  process.exit(1);
}
