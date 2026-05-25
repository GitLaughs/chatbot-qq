#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createProxyCommands } = require("./lib/proxy-commands");
const { savePendingCandidates } = require("./lib/memory-store");
const { addProposal, updateProposalStatus } = require("./lib/proposal-store");
const { addTodo } = require("./lib/todo-store");
const { maskSensitive } = require("./lib/sensitive-redaction");

const GROUP_ID = 9876500001;
const ADMIN_USER = 1234500001;
const NORMAL_USER = 1234500002;
const RAW_SECRET = "focus-secret-value";

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.json && options.table) {
    throw new Error("--json and --table are mutually exclusive");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-packet-focus-"));
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
    process.stdout.write(`OK review packet focus canaries passed. checked=${rows.length}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runCanaries(root) {
  const replies = [];
  const groupWorkspace = path.join(root, "groups", `sandbox-${GROUP_ID}`);
  const adminWorkspace = path.join(root, "users", String(ADMIN_USER));
  seedProposalPriorityWorkspace(groupWorkspace);
  seedFallbackWorkspace(adminWorkspace);

  const commands = createProxyCommands(baseDeps({ root, replies, groupWorkspace, adminWorkspace }));
  const rows = [];
  rows.push(checkCommand({
    commands,
    replies,
    name: "accepted-proposal-focus",
    msg: groupMsg("/审查包"),
    mustMatch: [
      /本轮焦点：提案 .* \[accepted\] FOCUS_ACCEPTED_SAFE/,
      /本轮建议/,
      /标题：FOCUS_ACCEPTED_SAFE/,
      /提案：\[accepted\] FOCUS_ACCEPTED_SAFE/
    ],
    mustNotMatch: [
      /FOCUS_OPEN_SAFE/,
      /OFFICIAL_QQ_BOT_DECOY/,
      /EMBEDDING_DECOY/,
      /AUTO_DEPLOY_DECOY/,
      /TOKEN_DECOY/,
      new RegExp(RAW_SECRET)
    ]
  }));
  rows.push(checkCommand({
    commands,
    replies,
    name: "todo-fallback-focus",
    msg: privateMsg(ADMIN_USER, "/审查包"),
    mustMatch: [
      /范围：private:1234500001/,
      /本轮焦点：待办 .* FOCUS_TODO_FALLBACK/,
      /候选：\[project\].*FOCUS_CANDIDATE_FALLBACK/,
      /待办：FOCUS_TODO_FALLBACK/,
      /提案：暂无/,
      /本轮建议：暂无适合本轮的提案/
    ],
    mustNotMatch: [
      /OFFICIAL_QQ_BOT_DECOY/,
      /EMBEDDING_DECOY/,
      /AUTO_DEPLOY_DECOY/,
      /TOKEN_DECOY/,
      new RegExp(RAW_SECRET)
    ]
  }));
  return rows;
}

function seedProposalPriorityWorkspace(workspace) {
  fs.mkdirSync(workspace, { recursive: true });
  savePendingCandidates({
    workspace,
    scope: "group",
    scopeID: String(GROUP_ID),
    candidates: [{ user: String(NORMAL_USER), user_id: String(NORMAL_USER), kind: "project", tags: ["focus"], text: "FOCUS_GROUP_CANDIDATE 低优先级候选" }]
  });
  addTodo({ workspace, scope: "group", scopeID: String(GROUP_ID), userID: String(NORMAL_USER), text: "FOCUS_GROUP_TODO 低优先级待办" });
  const accepted = addProposal({
    workspace,
    scope: "group",
    scopeID: String(GROUP_ID),
    userID: String(NORMAL_USER),
    title: "FOCUS_ACCEPTED_SAFE",
    body: "accepted safe proposal should win"
  });
  addProposal({
    workspace,
    scope: "group",
    scopeID: String(GROUP_ID),
    userID: String(NORMAL_USER),
    title: "FOCUS_OPEN_SAFE",
    body: "open safe proposal should lose to accepted safe"
  });
  seedBlockedProposals({ workspace, scope: "group", scopeID: String(GROUP_ID), userID: String(NORMAL_USER) });
  updateProposalStatus({ workspace, selector: accepted.id, status: "accepted", userID: String(NORMAL_USER), reason: "canary" });
}

function seedFallbackWorkspace(workspace) {
  fs.mkdirSync(workspace, { recursive: true });
  savePendingCandidates({
    workspace,
    scope: "private",
    scopeID: String(ADMIN_USER),
    candidates: [{ user: String(ADMIN_USER), user_id: String(ADMIN_USER), kind: "project", tags: ["focus"], text: "FOCUS_CANDIDATE_FALLBACK 候选低于待办" }]
  });
  addTodo({ workspace, scope: "private", scopeID: String(ADMIN_USER), userID: String(ADMIN_USER), text: "FOCUS_TODO_FALLBACK 当前待办焦点" });
  seedBlockedProposals({ workspace, scope: "private", scopeID: String(ADMIN_USER), userID: String(ADMIN_USER) });
}

function seedBlockedProposals({ workspace, scope, scopeID, userID }) {
  addProposal({
    workspace,
    scope,
    scopeID,
    userID,
    title: "OFFICIAL_QQ_BOT_DECOY",
    body: "切换官方 QQ Bot"
  });
  addProposal({
    workspace,
    scope,
    scopeID,
    userID,
    title: "EMBEDDING_DECOY",
    body: "引入 embedding 向量库"
  });
  addProposal({
    workspace,
    scope,
    scopeID,
    userID,
    title: "AUTO_DEPLOY_DECOY",
    body: "自动部署并重启"
  });
  addProposal({
    workspace,
    scope,
    scopeID,
    userID,
    title: `TOKEN_DECOY token=${RAW_SECRET}`,
    body: "secrets must never become focus"
  });
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
    "Usage: node scripts/check-review-packet-focus-canaries.js [--table|--json]",
    "",
    "Checks /审查包 chooses one deterministic safe focus for model review."
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR review packet focus canaries failed: ${error.message}\n`);
  process.exit(1);
}
