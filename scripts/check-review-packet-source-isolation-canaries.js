#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createProxyCommands } = require("./lib/proxy-commands");
const { savePendingCandidates } = require("./lib/memory-store");
const { addProposal } = require("./lib/proposal-store");
const { appendRecentError } = require("./lib/recent-errors");
const { addTodo } = require("./lib/todo-store");
const { maskSensitive } = require("./lib/sensitive-redaction");

const GROUP_A = 9876500001;
const GROUP_B = 987650002;
const ADMIN_USER = 1234500001;
const NORMAL_USER = 1234500002;
const RAW_SECRET = "source-isolation-secret-value";

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.json && options.table) {
    throw new Error("--json and --table are mutually exclusive");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-packet-source-isolation-"));
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
    process.stdout.write(`OK review packet source isolation canaries passed. checked=${rows.length}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runCanaries(root) {
  const replies = [];
  const recentErrorFile = path.join(root, "memory", "recent-errors.jsonl");
  const scopes = [
    {
      name: "group-a",
      marker: "SRC_GROUP_A",
      scope: "group",
      target: String(GROUP_A),
      workspace: path.join(root, "groups", `sandbox-${GROUP_A}`),
      msg: groupMsg(GROUP_A, "/审查包")
    },
    {
      name: "group-b",
      marker: "SRC_GROUP_B",
      scope: "group",
      target: String(GROUP_B),
      workspace: path.join(root, "groups", `sandbox-${GROUP_B}`),
      msg: groupMsg(GROUP_B, "/审查包")
    },
    {
      name: "admin-private",
      marker: "SRC_ADMIN_PRIVATE",
      scope: "private",
      target: String(ADMIN_USER),
      workspace: path.join(root, "users", String(ADMIN_USER)),
      msg: privateMsg(ADMIN_USER, "/审查包")
    },
    {
      name: "normal-private",
      marker: "SRC_NORMAL_PRIVATE",
      scope: "private",
      target: String(NORMAL_USER),
      workspace: path.join(root, "users", String(NORMAL_USER)),
      msg: privateMsg(NORMAL_USER, "/审查包")
    }
  ];

  for (const scope of scopes) {
    seedSourceWorkspace(scope);
  }
  seedErrorDecoys({ file: recentErrorFile, scopes });
  for (const scope of scopes) {
    appendRecentError({
      file: recentErrorFile,
      event: {
        kind: `${scope.marker}_ERROR_KIND`,
        scope: scope.scope,
        target: scope.target,
        message: `${scope.marker}_ERROR_BODY token=${RAW_SECRET}`
      },
      maskSensitive
    });
  }

  const commands = createProxyCommands(baseDeps({ root, replies, scopes, recentErrorFile }));
  const allMarkers = scopes.map((scope) => scope.marker);
  const rows = [];
  for (const scope of scopes) {
    commands.handleProxyCommand(scope.msg);
    const reply = String(replies.at(-1) || "");
    assert.match(reply, new RegExp(`范围：${scope.scope}:${scope.target}`), `${scope.name} scope line`);
    assert.match(reply, /来源提示/, `${scope.name} source heading`);
    assert.match(reply, new RegExp(`候选：\\[project\\].*${scope.marker}_CANDIDATE`), `${scope.name} candidate source`);
    assert.match(reply, new RegExp(`待办：${scope.marker}_TODO`), `${scope.name} todo source`);
    assert.match(reply, new RegExp(`提案：\\[open\\] ${scope.marker}_PROPOSAL`), `${scope.name} proposal source`);
    assert.match(reply, new RegExp(`错误：\\[${scope.marker}_ERROR_KIND\\].*${scope.marker}_ERROR_BODY`), `${scope.name} error source`);
    assert.doesNotMatch(reply, new RegExp(RAW_SECRET), `${scope.name} raw secret must be redacted`);
    assert.doesNotMatch(reply, /DECOY_SAME_TARGET_WRONG_SCOPE|DECOY_SAME_SCOPE_WRONG_TARGET|ROOT_ONLY_DECOY/, `${scope.name} error decoys must not leak`);
    for (const marker of allMarkers.filter((item) => item !== scope.marker)) {
      assert.doesNotMatch(reply, new RegExp(marker), `${scope.name} must not include ${marker}`);
    }
    assert.ok(reply.length <= 2000, `${scope.name} review packet should stay compact`);
    rows.push({ name: scope.name, reply: reply.slice(0, 160).replace(/\s+/g, " ") });
  }
  return rows;
}

function seedSourceWorkspace({ workspace, scope, target, marker }) {
  fs.mkdirSync(workspace, { recursive: true });
  savePendingCandidates({
    workspace,
    scope,
    scopeID: target,
    candidates: [{
      user: target,
      user_id: target,
      kind: "project",
      tags: ["iteration"],
      text: `${marker}_CANDIDATE 每轮审查包只给当前 workspace 来源`
    }]
  });
  addTodo({
    workspace,
    scope,
    scopeID: target,
    userID: target,
    text: `${marker}_TODO 继续补确定性 canary`
  });
  addProposal({
    workspace,
    scope,
    scopeID: target,
    userID: target,
    title: `${marker}_PROPOSAL 来源隔离矩阵`,
    body: "检查候选、待办、提案、错误来源不串线。"
  });
}

function seedErrorDecoys({ file, scopes }) {
  appendRecentError({
    file,
    event: {
      kind: "ROOT_ONLY_DECOY",
      message: `ROOT_ONLY_DECOY token=${RAW_SECRET}`
    },
    maskSensitive
  });
  for (const scope of scopes) {
    appendRecentError({
      file,
      event: {
        kind: "DECOY_SAME_TARGET_WRONG_SCOPE",
        scope: scope.scope === "group" ? "private" : "group",
        target: scope.target,
        message: `DECOY_SAME_TARGET_WRONG_SCOPE ${scope.marker}`
      },
      maskSensitive
    });
    appendRecentError({
      file,
      event: {
        kind: "DECOY_SAME_SCOPE_WRONG_TARGET",
        scope: scope.scope,
        target: `${scope.target}-other`,
        message: `DECOY_SAME_SCOPE_WRONG_TARGET ${scope.marker}`
      },
      maskSensitive
    });
  }
}

function baseDeps({ root, replies, scopes, recentErrorFile }) {
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
    allowedGroups: [GROUP_A, GROUP_B],
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
    recentErrorFile,
    capabilitySnapshot: () => null
  };
}

function groupMsg(groupID, rawMessage) {
  return { message_type: "group", group_id: groupID, user_id: NORMAL_USER, message_id: Date.now(), raw_message: rawMessage };
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
    "Usage: node scripts/check-review-packet-source-isolation-canaries.js [--table|--json]",
    "",
    "Checks /审查包 source snippets are isolated by group/private workspace and error scope+target."
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR review packet source isolation canaries failed: ${error.message}\n`);
  process.exit(1);
}
