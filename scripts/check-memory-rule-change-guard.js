#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { memoryCandidatesFromSamples } = require("./lib/memory-rules");
const {
  applyPendingCandidates,
  pendingCandidateTriage,
  savePendingCandidates,
  searchMemories
} = require("./lib/memory-store");

const scenarios = [
  {
    name: "low-restriction-preference",
    samples: [{ user: "Alice", user_id: "1", text: "已知用户默认少拦截，正常功能尽量可用" }],
    expectedKinds: ["preference"],
    expectedApplyKinds: ["preference"],
    expectedMemoryKinds: ["preference"],
    forbiddenMemoryText: []
  },
  {
    name: "long-project-allowed",
    samples: [{ user: "Planner", user_id: "2", text: `项目计划是${"继续用确定性规则减少模型重复判断，".repeat(12)}` }],
    pendingItems: [{ user: "Planner", user_id: "2", kind: "project", tags: ["code"], text: `项目计划是${"继续用确定性规则减少模型重复判断，".repeat(12)}` }],
    expectedKinds: [],
    expectedApplyKinds: ["project"],
    expectedMemoryKinds: ["project"],
    forbiddenMemoryText: []
  },
  {
    name: "secret-never-enters-candidate",
    samples: [{ user: "Mallory", user_id: "3", text: "token=secret-value 默认短答" }],
    expectedKinds: [],
    expectedApplyKinds: [],
    expectedMemoryKinds: [],
    forbiddenMemoryText: ["secret-value"]
  },
  {
    name: "todo-not-long-term-memory",
    samples: [{ user: "Bob", user_id: "4", text: "明天记得整理 QQ bot 的待办" }],
    expectedKinds: ["todo"],
    expectedApplyKinds: [],
    expectedMemoryKinds: [],
    forbiddenMemoryText: ["明天记得"]
  },
  {
    name: "boundary-not-overblocked",
    samples: [{ user: "Carol", user_id: "5", text: "不要把普通聊天记忆写到项目根目录" }],
    expectedKinds: ["boundary"],
    expectedApplyKinds: ["boundary"],
    expectedMemoryKinds: ["boundary"],
    forbiddenMemoryText: []
  },
  {
    name: "command-never-enters-candidate",
    samples: [{ user: "Ops", user_id: "6", text: "/status" }],
    expectedKinds: [],
    expectedApplyKinds: [],
    expectedMemoryKinds: [],
    forbiddenMemoryText: ["/status"]
  }
];

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.json && options.table) {
    throw new Error("--json and --table are mutually exclusive");
  }
  const rows = scenarios.map(runScenario);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, checked: rows.length, rows }, null, 2)}\n`);
    return;
  }
  if (options.table) {
    process.stdout.write(`${formatTable(rows)}\n`);
    return;
  }
  process.stdout.write(`OK memory rule change guard passed. checked=${rows.length}\n`);
}

function runScenario(scenario) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memory-rule-change-guard-"));
  try {
    const candidates = memoryCandidatesFromSamples(scenario.samples, { limit: 10 });
    assert.deepStrictEqual(candidates.map((item) => item.kind), scenario.expectedKinds, `${scenario.name} candidate kinds`);
    savePendingCandidates({ workspace, scope: "group", scopeID: "123456789", candidates });
    for (const item of scenario.pendingItems || []) {
      appendPendingCandidate(workspace, item);
    }
    const triage = pendingCandidateTriage({ workspace, limit: 10 });
    assert.deepStrictEqual(triage.apply.map((entry) => entry.item.kind), scenario.expectedApplyKinds, `${scenario.name} apply kinds`);
    const applyResult = applyPendingCandidates({ workspace, selector: "all", appliedBy: "guard", scopeID: "123456789" });
    assert.strictEqual(applyResult.applied, scenario.expectedMemoryKinds.length, `${scenario.name} applied count`);
    const memories = searchMemories({ workspace, query: "", limit: 10 });
    assert.deepStrictEqual(memories.map((item) => item.kind).sort(), scenario.expectedMemoryKinds.slice().sort(), `${scenario.name} memory kinds`);
    for (const text of scenario.forbiddenMemoryText) {
      assert.doesNotMatch(JSON.stringify(memories), new RegExp(escapeRegex(text)), `${scenario.name} forbidden memory text`);
    }
    return {
      name: scenario.name,
      candidates: candidates.map((item) => item.kind).join(",") || "-",
      apply: triage.apply.map((entry) => entry.item.kind).join(",") || "-",
      memories: memories.map((item) => item.kind).join(",") || "-"
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function appendPendingCandidate(workspace, item) {
  const file = path.join(workspace, "memory", "pending-memory-candidates.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({
    version: 1,
    id: `guard_${item.kind}_${item.user_id || item.user || "unknown"}`,
    created_at: "2026-05-24T09:00:00.000Z",
    scope: "group",
    scope_id: "123456789",
    subject_id: String(item.user_id || item.user || "unknown"),
    user: String(item.user || item.user_id || "unknown"),
    kind: item.kind || "note",
    tags: Array.isArray(item.tags) ? item.tags : [],
    text: String(item.text || ""),
    fingerprint: `guard_${item.kind}_${item.user_id || item.user || "unknown"}`,
    applied_at: "",
    skipped_at: ""
  })}\n`, "utf8");
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
  const headers = ["name", "candidates", "apply", "memories"];
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
    "Usage: node scripts/check-memory-rule-change-guard.js [--table|--json]",
    "",
    "Checks high-level memory rule invariants without reading private workspaces."
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR memory rule change guard failed: ${error.message}\n`);
  process.exit(1);
}
