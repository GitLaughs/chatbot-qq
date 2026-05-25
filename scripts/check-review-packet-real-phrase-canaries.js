#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createProxyCommands } = require("./lib/proxy-commands");
const { savePendingCandidates } = require("./lib/memory-store");
const { addProposal } = require("./lib/proposal-store");
const { addTodo } = require("./lib/todo-store");
const { maskSensitive } = require("./lib/sensitive-redaction");

const GROUP_ID = 9876500001;
const ADMIN_USER = 1234500001;
const NORMAL_USER = 1234500002;
const RAW_SECRET = "real-phrase-secret-value";

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.json && options.table) {
    throw new Error("--json and --table are mutually exclusive");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-packet-real-phrase-"));
  try {
    const rows = runCanaries(root);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, checked: rows.length, rows }, null, 2)}\n`);
      return;
    }
    if (options.table) {
      process.stdout.write(`${formatTable(rows)}\n`);
      return;
    }
    process.stdout.write(`OK review packet real phrase canaries passed. checked=${rows.length}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runCanaries(root) {
  const replies = [];
  const workspace = path.join(root, "groups", `sandbox-${GROUP_ID}`);
  seedWorkspace(workspace);
  const commands = createProxyCommands(baseDeps({ root, replies, workspace }));
  const rows = [];

  rows.push(checkCommand({
    commands,
    replies,
    name: "review-packet-hides-real-risk-phrases",
    msg: groupMsg("/审查包"),
    mustMatch: [
      /本轮焦点：待办 .* 安全待办：补一个审查包真实短语测试/,
      /候选：\[project\].*安全候选：为审查包增加一个轻量确定性测试/,
      /待办：安全待办：补一个审查包真实短语测试/,
      /提案：暂无/,
      /本轮建议：暂无适合本轮的提案/
    ],
    mustNotMatch: reviewPacketForbiddenPatterns()
  }));

  rows.push(checkCommand({
    commands,
    replies,
    name: "normal-todo-keeps-real-risk-phrases",
    msg: groupMsg("/待办"),
    mustMatch: [
      /待办：/,
      /切换官方 QQ Bot/,
      /跨群搜索/,
      /自动部署并重启/,
      /token=\*\*\*/,
      /安全待办：补一个审查包真实短语测试/
    ],
    mustNotMatch: [new RegExp(RAW_SECRET)]
  }));

  rows.push(checkCommand({
    commands,
    replies,
    name: "normal-pending-memory-keeps-real-risk-phrases",
    msg: groupMsg("/候选记忆"),
    mustMatch: [
      /候选记忆：/,
      /切换官方 QQ Bot/,
      /引入 embedding 向量库/,
      /自动部署并重启/,
      /token=\*\*\*/,
      /安全候选：为审查包增加一个轻量确定性测试/
    ],
    mustNotMatch: [new RegExp(RAW_SECRET)]
  }));

  rows.push(checkCommand({
    commands,
    replies,
    name: "pending-memory-token-search-is-redacted",
    msg: groupMsg("/候选记忆 token"),
    mustMatch: [
      /候选记忆：/,
      /token=\*\*\*/
    ],
    mustNotMatch: [new RegExp(RAW_SECRET)]
  }));

  rows.push(checkCommand({
    commands,
    replies,
    name: "pending-memory-risk-search-keeps-phrase",
    msg: groupMsg("/候选记忆 自动部署"),
    mustMatch: [
      /候选记忆：/,
      /自动部署并重启服务/
    ],
    mustNotMatch: [new RegExp(RAW_SECRET)]
  }));

  rows.push(checkCommand({
    commands,
    replies,
    name: "normal-proposal-export-keeps-redacted-real-risk-phrases",
    msg: groupMsg("/提案 导出 all"),
    mustMatch: [
      /当前 workspace 提案摘要/,
      /切换官方 QQ Bot/,
      /引入 embedding 向量库/,
      /自动部署并重启/,
      /token=\*\*\*/
    ],
    mustNotMatch: [new RegExp(RAW_SECRET)]
  }));

  return rows;
}

function seedWorkspace(workspace) {
  fs.mkdirSync(workspace, { recursive: true });
  savePendingCandidates({
    workspace,
    scope: "group",
    scopeID: String(GROUP_ID),
    candidates: [
      { user: String(NORMAL_USER), user_id: String(NORMAL_USER), kind: "project", tags: ["risk"], text: "切换官方 QQ Bot，迁移当前架构" },
      { user: String(NORMAL_USER), user_id: String(NORMAL_USER), kind: "project", tags: ["risk"], text: "引入 embedding 向量库做长期记忆检索" },
      { user: String(NORMAL_USER), user_id: String(NORMAL_USER), kind: "project", tags: ["risk"], text: "自动部署并重启服务" },
      { user: String(NORMAL_USER), user_id: String(NORMAL_USER), kind: "project", tags: ["risk"], text: `记录 token=${RAW_SECRET}` },
      { user: String(NORMAL_USER), user_id: String(NORMAL_USER), kind: "project", tags: ["safe"], text: "安全候选：为审查包增加一个轻量确定性测试" }
    ]
  });
  addTodo({ workspace, scope: "group", scopeID: String(GROUP_ID), userID: String(NORMAL_USER), text: "切换官方 QQ Bot" });
  addTodo({ workspace, scope: "group", scopeID: String(GROUP_ID), userID: String(NORMAL_USER), text: "跨群搜索所有聊天记录" });
  addTodo({ workspace, scope: "group", scopeID: String(GROUP_ID), userID: String(NORMAL_USER), text: "自动部署并重启" });
  addTodo({ workspace, scope: "group", scopeID: String(GROUP_ID), userID: String(NORMAL_USER), text: `记录 token=${RAW_SECRET}` });
  addTodo({ workspace, scope: "group", scopeID: String(GROUP_ID), userID: String(NORMAL_USER), text: "安全待办：补一个审查包真实短语测试" });
  addProposal({ workspace, scope: "group", scopeID: String(GROUP_ID), userID: String(NORMAL_USER), title: "切换官方 QQ Bot", body: "decoy" });
  addProposal({ workspace, scope: "group", scopeID: String(GROUP_ID), userID: String(NORMAL_USER), title: "引入 embedding 向量库", body: "decoy" });
  addProposal({ workspace, scope: "group", scopeID: String(GROUP_ID), userID: String(NORMAL_USER), title: "自动部署并重启", body: "decoy" });
  addProposal({ workspace, scope: "group", scopeID: String(GROUP_ID), userID: String(NORMAL_USER), title: `记录 token=${RAW_SECRET}`, body: "decoy" });
}

function reviewPacketForbiddenPatterns() {
  return [
    /切换官方 QQ Bot/,
    /引入 embedding 向量库/,
    /自动部署并重启/,
    /跨群搜索/,
    /所有聊天记录/,
    /token=/,
    new RegExp(RAW_SECRET)
  ];
}

function baseDeps({ root, replies, workspace }) {
  return {
    messageText: (msg) => msg.raw_message || "",
    sendPrivateText: (_userID, _messageID, text) => replies.push(text),
    sendGroupText: (_groupID, _messageID, text) => replies.push(text),
    healthSnapshot: () => ({ ok: true, upstream: { ready: true }, pending: { upstream_queue: 0, outbound: 0 } }),
    imageStateKey: (msg) => `${msg.message_type}:${msg.group_id || msg.user_id}`,
    imageStates: new Map(),
    effectiveListenMode: () => "selective",
    defaultListenMode: "selective",
    atOnlyGroups: [],
    isGroupQuiet: () => false,
    adminUsers: [ADMIN_USER],
    adminRootUsers: [ADMIN_USER],
    allowedGroups: [GROUP_ID],
    allowedPrivateUsers: [ADMIN_USER, NORMAL_USER],
    workspaceForGroup: () => workspace,
    workspaceForPrivateUser: (userID) => path.join(root, "users", String(userID)),
    executionWorkspaceForPrivateUser: (userID) => Number(userID) === ADMIN_USER ? root : path.join(root, "users", String(userID)),
    projectRoot: root,
    ensureGroupProfile: () => {},
    ensurePrivateProfile: () => {},
    appendLine: () => {},
    memberProfilePath: () => "",
    removeLinesContaining: () => 0,
    todayLocal: () => "2026-05-24",
    quietUntilByGroup: new Map(),
    persistProxyState: () => {},
    pending: [],
    pendingOutbound: new Map(),
    pendingFileDownloads: new Map(),
    listenStates: new Map(),
    botReplyRoutes: new Map(),
    listenModeByGroup: new Map(),
    maskSensitive,
    groupRoutes: new Map(),
    privateRoutes: new Map(),
    adminLogFiles: {},
    recentErrorFile: path.join(root, "memory", "recent-errors.jsonl"),
    capabilitySnapshot: () => null
  };
}

function checkCommand({ commands, replies, name, msg, mustMatch = [], mustNotMatch = [] }) {
  assert.strictEqual(commands.isProxyCommand(msg), true, `${name} should be recognized`);
  const before = replies.length;
  commands.handleProxyCommand(msg);
  assert.strictEqual(replies.length, before + 1, `${name} should produce one reply`);
  const reply = String(replies.at(-1) || "");
  for (const pattern of mustMatch) {
    assert.match(reply, pattern, `${name} expected ${pattern}`);
  }
  for (const pattern of mustNotMatch) {
    assert.doesNotMatch(reply, pattern, `${name} must not contain ${pattern}`);
  }
  assert.ok(reply.length <= 2000, `${name} reply should stay compact`);
  return { name, reply: reply.slice(0, 160).replace(/\s+/g, " ") };
}

function groupMsg(rawMessage) {
  return { message_type: "group", group_id: GROUP_ID, user_id: NORMAL_USER, message_id: Date.now(), raw_message: rawMessage };
}

function parseArgs(argv) {
  const options = { json: false, table: false };
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
  const headers = ["name", "reply"];
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
    "Usage: node scripts/check-review-packet-real-phrase-canaries.js [--table|--json]",
    "",
    "Checks /审查包 hides real unsafe phrases while normal todo/candidate/proposal commands remain low-restriction."
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR review packet real phrase canaries failed: ${error.message}\n`);
  process.exit(1);
}
