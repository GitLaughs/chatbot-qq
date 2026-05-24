#!/usr/bin/env node

const assert = require("assert");
const {
  inspectMemoryRule,
  memoryCandidatesFromSamples
} = require("./lib/memory-rules");

const inspectionCanaries = [
  {
    name: "preference-style",
    text: "以后回答默认短答，先给结论",
    eligible: true,
    kind: "preference",
    tags: ["style"],
    blockers: []
  },
  {
    name: "todo-code",
    text: "明天记得修复 QQ bot 报错并补 npm test",
    eligible: true,
    kind: "todo",
    tags: ["code", "todo"],
    blockers: []
  },
  {
    name: "boundary",
    text: "不要把普通聊天记忆写到项目根目录",
    eligible: true,
    kind: "boundary",
    tags: ["boundary"],
    blockers: []
  },
  {
    name: "project-code",
    text: "项目计划是先做确定性脚本再部署测试",
    eligible: true,
    kind: "project",
    tags: ["code"],
    blockers: []
  },
  {
    name: "secret-token",
    text: "默认短答 token=secret-value",
    eligible: false,
    kind: "note",
    tags: [],
    blockers: ["疑似包含密钥或令牌"]
  },
  {
    name: "command",
    text: "/status",
    eligible: false,
    kind: "note",
    tags: [],
    blockers: ["命令或状态词不进入候选"]
  },
  {
    name: "image-placeholder",
    text: "[图片] 默认短答",
    eligible: false,
    kind: "note",
    tags: [],
    blockers: ["图片/表情占位不进入候选"]
  },
  {
    name: "too-short",
    text: "短答",
    eligible: false,
    kind: "note",
    tags: [],
    blockers: ["长度需在 6-180 字之间"]
  }
];

const sampleCanaries = [
  {
    user: "Alice",
    text: "以后回答默认短答，先给结论",
    time: "2026-05-24T01:00:00.000Z"
  },
  {
    user: "Alice",
    text: "以后回答默认短答，先给结论",
    time: "2026-05-24T01:01:00.000Z"
  },
  {
    user: "Bob",
    text: "明天记得修复 QQ bot 报错并补 npm test",
    time: "2026-05-24T01:02:00.000Z"
  },
  {
    user: "Carol",
    text: "token=secret-value 默认短答",
    time: "2026-05-24T01:03:00.000Z"
  },
  {
    user: "Dave",
    text: "/status",
    time: "2026-05-24T01:04:00.000Z"
  },
  {
    user: "Eve",
    text: "普通闲聊没有明确规则",
    time: "2026-05-24T01:05:00.000Z"
  },
  {
    user: "Frank",
    text: "不要把普通聊天记忆写到项目根目录",
    time: "2026-05-24T01:06:00.000Z"
  }
];

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.json && options.table) {
    throw new Error("--json and --table are mutually exclusive");
  }
  const rows = [
    ...inspectionCanaries.map(checkInspectionCanary),
    ...checkCandidateCanaries()
  ];
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, checked: rows.length, rows }, null, 2)}\n`);
    return;
  }
  if (options.table) {
    process.stdout.write(`${formatTable(rows)}\n`);
    return;
  }
  process.stdout.write(`OK memory rule canaries passed. checked=${rows.length}\n`);
}

function checkInspectionCanary(canary) {
  const actual = inspectMemoryRule(canary.text);
  assert.strictEqual(actual.eligible, canary.eligible, `${canary.name} eligible mismatch`);
  assert.strictEqual(actual.kind, canary.kind, `${canary.name} kind mismatch`);
  assert.deepStrictEqual(actual.tags, canary.tags, `${canary.name} tags mismatch`);
  assert.deepStrictEqual(actual.blockers, canary.blockers, `${canary.name} blockers mismatch`);
  assert.strictEqual(actual.normalized, canary.text, `${canary.name} normalized mismatch`);
  return {
    name: canary.name,
    type: "inspect",
    result: actual.eligible ? actual.kind : "blocked",
    tags: actual.tags.join(",") || "-",
    note: actual.blockers.join(";") || "-"
  };
}

function checkCandidateCanaries() {
  const candidates = memoryCandidatesFromSamples(sampleCanaries, { limit: 10 });
  assert.strictEqual(candidates.length, 3, "candidate count should skip duplicate, secret, command, and note");
  assert.deepStrictEqual(candidates.map((item) => item.user), ["Alice", "Bob", "Frank"]);
  assert.deepStrictEqual(candidates.map((item) => item.kind), ["preference", "todo", "boundary"]);
  assert.ok(candidates[0].tags.includes("style"), "preference candidate should keep style tag");
  assert.ok(candidates[1].tags.includes("code"), "todo candidate should keep code tag");
  assert.ok(candidates[1].tags.includes("todo"), "todo candidate should keep todo tag");
  assert.ok(candidates[2].tags.includes("boundary"), "boundary candidate should keep boundary tag");
  assert.doesNotMatch(JSON.stringify(candidates), /secret-value|\/status|普通闲聊/);

  const limited = memoryCandidatesFromSamples(sampleCanaries, { limit: 2 });
  assert.strictEqual(limited.length, 2, "candidate limit should be honored");
  assert.deepStrictEqual(limited.map((item) => item.user), ["Alice", "Bob"]);

  return [
    {
      name: "candidate-filter-dedupe",
      type: "candidates",
      result: candidates.map((item) => `${item.user}:${item.kind}`).join(","),
      tags: candidates.flatMap((item) => item.tags).join(",") || "-",
      note: "skips duplicate, secret, command, and note samples"
    },
    {
      name: "candidate-limit",
      type: "candidates",
      result: String(limited.length),
      tags: "-",
      note: "honors deterministic limit"
    }
  ];
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
  const headers = ["name", "type", "result", "tags", "note"];
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
    "Usage: node scripts/check-memory-rule-canaries.js [--table|--json]",
    "",
    "Checks deterministic memory-rule examples without reading private memory files."
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR memory rule canaries failed: ${error.message}\n`);
  process.exit(1);
}
