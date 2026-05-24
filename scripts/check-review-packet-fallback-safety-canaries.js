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

const GROUP_ID = 1107099585;
const ADMIN_USER = 1602858215;
const NORMAL_USER = 2138730775;
const RAW_SECRET = "fallback-secret-value";

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.json && options.table) {
    throw new Error("--json and --table are mutually exclusive");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-packet-fallback-safety-"));
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
    process.stdout.write(`OK review packet fallback safety canaries passed. checked=${rows.length}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runCanaries(root) {
  const replies = [];
  const groupWorkspace = path.join(root, "groups", `sandbox-${GROUP_ID}`);
  const adminWorkspace = path.join(root, "users", String(ADMIN_USER));
  seedBlockedTodoSafeCandidate(groupWorkspace);
  seedBlockedTodoAndCandidate(adminWorkspace);

  const commands = createProxyCommands(baseDeps({ root, replies, groupWorkspace, adminWorkspace }));
  const rows = [];
  rows.push(checkCommand({
    commands,
    replies,
    name: "safe-candidate-fallback",
    msg: groupMsg("/审查包"),
    mustMatch: [
      /本轮焦点：候选 \[project\] FALLBACK_SAFE_CANDIDATE/,
      /候选：\[project\].*FALLBACK_SAFE_CANDIDATE/,
      /待办：暂无/,
      /提案：暂无/,
      /本轮建议：暂无适合本轮的提案/
    ],
    mustNotMatch: blockedPatterns()
  }));
  rows.push(checkCommand({
    commands,
    replies,
    name: "no-safe-fallback",
    msg: privateMsg(ADMIN_USER, "/审查包"),
    mustMatch: [
      /范围：private:1602858215/,
      /本轮焦点：暂无/,
      /候选：暂无/,
      /待办：暂无/,
      /提案：暂无/,
      /本轮建议：暂无适合本轮的提案/
    ],
    mustNotMatch: blockedPatterns()
  }));
  return rows;
}

function seedBlockedTodoSafeCandidate(workspace) {
  fs.mkdirSync(workspace, { recursive: true });
  seedBlockedProposals({ workspace, scope: "group", scopeID: String(GROUP_ID), userID: String(NORMAL_USER) });
  seedBlockedTodos({ workspace, scope: "group", scopeID: String(GROUP_ID), userID: String(NORMAL_USER) });
  savePendingCandidates({
    workspace,
    scope: "group",
    scopeID: String(GROUP_ID),
    candidates: [
      { user: String(NORMAL_USER), user_id: String(NORMAL_USER), kind: "project", tags: ["focus"], text: "BLOCKED_CANDIDATE_TOKEN token=fallback-secret-value" },
      { user: String(NORMAL_USER), user_id: String(NORMAL_USER), kind: "project", tags: ["focus"], text: "BLOCKED_CANDIDATE_EMBEDDING 引入 embedding 向量库" },
      { user: String(NORMAL_USER), user_id: String(NORMAL_USER), kind: "project", tags: ["focus"], text: "FALLBACK_SAFE_CANDIDATE 当前 workspace 加一个轻量测试" }
    ]
  });
}

function seedBlockedTodoAndCandidate(workspace) {
  fs.mkdirSync(workspace, { recursive: true });
  seedBlockedProposals({ workspace, scope: "private", scopeID: String(ADMIN_USER), userID: String(ADMIN_USER) });
  seedBlockedTodos({ workspace, scope: "private", scopeID: String(ADMIN_USER), userID: String(ADMIN_USER) });
  savePendingCandidates({
    workspace,
    scope: "private",
    scopeID: String(ADMIN_USER),
    candidates: [
      { user: String(ADMIN_USER), user_id: String(ADMIN_USER), kind: "project", tags: ["focus"], text: "BLOCKED_CANDIDATE_AUTO_DEPLOY 自动部署并重启" },
      { user: String(ADMIN_USER), user_id: String(ADMIN_USER), kind: "project", tags: ["focus"], text: "BLOCKED_CANDIDATE_OFFICIAL 官方 QQ Bot 迁移" }
    ]
  });
}

function seedBlockedTodos({ workspace, scope, scopeID, userID }) {
  addTodo({ workspace, scope, scopeID, userID, text: "BLOCKED_TODO_OFFICIAL 切换官方 QQ Bot" });
  addTodo({ workspace, scope, scopeID, userID, text: "BLOCKED_TODO_EMBEDDING 引入 embedding 向量库" });
  addTodo({ workspace, scope, scopeID, userID, text: `BLOCKED_TODO_TOKEN token=${RAW_SECRET}` });
  addTodo({ workspace, scope, scopeID, userID, text: "BLOCKED_TODO_AUTO_DEPLOY 自动部署并重启" });
}

function seedBlockedProposals({ workspace, scope, scopeID, userID }) {
  addProposal({ workspace, scope, scopeID, userID, title: "BLOCKED_PROPOSAL_OFFICIAL", body: "切换官方 QQ Bot" });
  addProposal({ workspace, scope, scopeID, userID, title: "BLOCKED_PROPOSAL_EMBEDDING", body: "引入 embedding 向量库" });
  addProposal({ workspace, scope, scopeID, userID, title: "BLOCKED_PROPOSAL_AUTO_DEPLOY", body: "自动部署并重启" });
  addProposal({ workspace, scope, scopeID, userID, title: `BLOCKED_PROPOSAL_TOKEN token=${RAW_SECRET}`, body: "secret" });
}

function blockedPatterns() {
  return [
    /BLOCKED_(TODO|CANDIDATE|PROPOSAL)/,
    /OFFICIAL/,
    /EMBEDDING/,
    /AUTO_DEPLOY/,
    /TOKEN/,
    new RegExp(RAW_SECRET)
  ];
}

function baseDeps({ root, replies, groupWorkspace, adminWorkspace }) {
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
    workspaceForGroup: () => groupWorkspace,
    workspaceForPrivateUser: (userID) => Number(userID) === ADMIN_USER ? adminWorkspace : path.join(root, "users", String(userID)),
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
  assert.ok(reply.length <= 2000, `${name} review packet should stay compact`);
  return { name, reply: reply.slice(0, 160).replace(/\s+/g, " ") };
}

function groupMsg(rawMessage) {
  return { message_type: "group", group_id: GROUP_ID, user_id: NORMAL_USER, message_id: Date.now(), raw_message: rawMessage };
}

function privateMsg(userID, rawMessage) {
  return { message_type: "private", user_id: userID, message_id: Date.now(), raw_message: rawMessage };
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
    "Usage: node scripts/check-review-packet-fallback-safety-canaries.js [--table|--json]",
    "",
    "Checks /审查包 skips unsafe todo/candidate fallback items when no safe proposal exists."
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR review packet fallback safety canaries failed: ${error.message}\n`);
  process.exit(1);
}
