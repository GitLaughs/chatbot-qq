#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createProxyCommands } = require("./lib/proxy-commands");
const { applyPendingCandidates, savePendingCandidates, skipPendingCandidates } = require("./lib/memory-store");
const { addProposal, updateProposalStatus } = require("./lib/proposal-store");
const { addTodo, completeTodos } = require("./lib/todo-store");
const { maskSensitive } = require("./lib/sensitive-redaction");

const GROUP_ID = 123456789;
const ADMIN_USER = 100000001;
const NORMAL_USER = 100000002;

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.json && options.table) {
    throw new Error("--json and --table are mutually exclusive");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-packet-actionable-"));
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
    process.stdout.write(`OK review packet actionable canaries passed. checked=${rows.length}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runCanaries(root) {
  const replies = [];
  const scopes = [
    {
      name: "group-actionable",
      marker: "ACTION_GROUP",
      scope: "group",
      target: String(GROUP_ID),
      workspace: path.join(root, "groups", `sandbox-${GROUP_ID}`),
      msg: groupMsg("/审查包")
    },
    {
      name: "admin-private-actionable",
      marker: "ACTION_ADMIN",
      scope: "private",
      target: String(ADMIN_USER),
      workspace: path.join(root, "users", String(ADMIN_USER)),
      msg: privateMsg(ADMIN_USER, "/审查包")
    }
  ];

  for (const scope of scopes) {
    seedActionableWorkspace(scope);
  }

  const commands = createProxyCommands(baseDeps({ root, replies, scopes }));
  const rows = [];
  for (const scope of scopes) {
    commands.handleProxyCommand(scope.msg);
    const reply = String(replies.at(-1) || "");
    assert.match(reply, new RegExp(`范围：${scope.scope}:${scope.target}`), `${scope.name} scope line`);
    assert.match(reply, /来源提示/, `${scope.name} source heading`);
    assert.match(reply, new RegExp(`候选：\\[project\\].*${scope.marker}_ACTIVE_CANDIDATE`), `${scope.name} active candidate`);
    assert.match(reply, new RegExp(`待办：${scope.marker}_OPEN_TODO`), `${scope.name} open todo`);
    assert.match(reply, new RegExp(`提案：\\[open\\] ${scope.marker}_OPEN_PROPOSAL`), `${scope.name} open proposal`);
    assert.match(reply, /错误：暂无/, `${scope.name} no error source`);
    assert.doesNotMatch(reply, new RegExp(`${scope.marker}_(APPLIED|SKIPPED)_CANDIDATE`), `${scope.name} processed candidates hidden`);
    assert.doesNotMatch(reply, new RegExp(`${scope.marker}_DONE_TODO`), `${scope.name} done todo hidden`);
    assert.doesNotMatch(reply, new RegExp(`${scope.marker}_(SKIPPED|DONE)_PROPOSAL`), `${scope.name} non-open proposals hidden`);
    assert.ok(reply.length <= 2000, `${scope.name} review packet should stay compact`);
    rows.push({ name: scope.name, reply: reply.slice(0, 160).replace(/\s+/g, " ") });
  }
  return rows;
}

function seedActionableWorkspace({ workspace, scope, target, marker }) {
  fs.mkdirSync(workspace, { recursive: true });
  savePendingCandidates({
    workspace,
    scope,
    scopeID: target,
    candidates: [
      { user: target, user_id: target, kind: "project", tags: ["iteration"], text: `${marker}_APPLIED_CANDIDATE 已应用候选不应再进审查包来源` },
      { user: target, user_id: target, kind: "project", tags: ["iteration"], text: `${marker}_SKIPPED_CANDIDATE 已跳过候选不应再进审查包来源` },
      { user: target, user_id: target, kind: "project", tags: ["iteration"], text: `${marker}_ACTIVE_CANDIDATE 当前可行动候选` }
    ]
  });
  applyPendingCandidates({ workspace, selector: "1", appliedBy: "canary", scopeID: target });
  skipPendingCandidates({ workspace, selector: "1", skippedBy: "canary" });

  addTodo({ workspace, scope, scopeID: target, userID: target, text: `${marker}_DONE_TODO 已完成待办不应再进审查包来源` });
  addTodo({ workspace, scope, scopeID: target, userID: target, text: `${marker}_OPEN_TODO 当前可行动待办` });
  completeTodos({ workspace, selector: "1", doneBy: "canary" });

  const skipped = addProposal({
    workspace,
    scope,
    scopeID: target,
    userID: target,
    title: `${marker}_SKIPPED_PROPOSAL 已跳过提案不应再进审查包来源`,
    body: "decoy"
  });
  const done = addProposal({
    workspace,
    scope,
    scopeID: target,
    userID: target,
    title: `${marker}_DONE_PROPOSAL 已完成提案不应再进审查包来源`,
    body: "decoy"
  });
  addProposal({
    workspace,
    scope,
    scopeID: target,
    userID: target,
    title: `${marker}_OPEN_PROPOSAL 当前可行动提案`,
    body: "actionable"
  });
  updateProposalStatus({ workspace, selector: skipped.id, status: "skipped", userID: target, reason: "canary" });
  updateProposalStatus({ workspace, selector: done.id, status: "done", userID: target, reason: "canary" });
}

function baseDeps({ root, replies, scopes }) {
  const byGroup = new Map(scopes.filter((item) => item.scope === "group").map((item) => [Number(item.target), item.workspace]));
  const byUser = new Map(scopes.filter((item) => item.scope === "private").map((item) => [Number(item.target), item.workspace]));
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
    workspaceForGroup: (groupID) => byGroup.get(Number(groupID)),
    workspaceForPrivateUser: (userID) => byUser.get(Number(userID)),
    executionWorkspaceForPrivateUser: (userID) => Number(userID) === ADMIN_USER ? root : byUser.get(Number(userID)),
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
    "Usage: node scripts/check-review-packet-actionable-canaries.js [--table|--json]",
    "",
    "Checks /审查包 source snippets show active/open items only, not already processed decoys."
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR review packet actionable canaries failed: ${error.message}\n`);
  process.exit(1);
}
