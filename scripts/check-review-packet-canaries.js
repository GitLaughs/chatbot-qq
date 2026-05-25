#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createProxyCommands } = require("./lib/proxy-commands");
const { addFileIndex } = require("./lib/file-index");
const { addMemory, savePendingCandidates } = require("./lib/memory-store");
const { addProposal } = require("./lib/proposal-store");
const { appendRecentError } = require("./lib/recent-errors");
const { addTodo } = require("./lib/todo-store");
const { maskSensitive } = require("./lib/sensitive-redaction");

const GROUP_ID = 9876500001;
const ADMIN_USER = 1234500001;
const NORMAL_USER = 1234500002;
const RAW_SECRET = "server-secret-value";
const PROVIDER_SECRET = "provider-secret-value";
const OPENAI_SECRET = "openai-secret-value";

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.json && options.table) {
    throw new Error("--json and --table are mutually exclusive");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-packet-canaries-"));
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
    process.stdout.write(`OK review packet canaries passed. checked=${rows.length}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runCanaries(root) {
  const replies = [];
  const groupWorkspace = path.join(root, "groups", `sandbox-${GROUP_ID}`);
  const adminWorkspace = path.join(root, "users", String(ADMIN_USER));
  const normalWorkspace = path.join(root, "users", String(NORMAL_USER));
  seedWorkspace(groupWorkspace, { scope: "group", scopeID: String(GROUP_ID), userID: String(NORMAL_USER), name: "group" });
  seedWorkspace(adminWorkspace, { scope: "private", scopeID: String(ADMIN_USER), userID: String(ADMIN_USER), name: "admin-private" });
  seedWorkspace(normalWorkspace, { scope: "private", scopeID: String(NORMAL_USER), userID: String(NORMAL_USER), name: "normal-private" });
  seedRootDecoy(root);

  const commands = createProxyCommands(baseDeps({
    root,
    replies,
    groupWorkspace,
    adminWorkspace,
    normalWorkspace,
    recentErrorFile: path.join(root, "memory", "recent-errors.jsonl")
  }));

  const rows = [];
  rows.push(checkCommand({
    commands,
    replies,
    name: "group-review-packet",
    msg: groupMsg("/审查包"),
    mustMatch: [
      /子 agent 审查包/,
      /NapCat\/OneBot \+ onebot-group-proxy \+ cc-connect/,
      /低成本确定性优先/,
      /范围：group:9876500001/,
      /记忆：active 1/,
      /候选记忆：active 2/,
      /待办：open 1/,
      /提案：open 2/,
      /文件索引：total 1/,
      /本轮建议/,
      /低成本确定性下一步/,
      /来源提示/,
      /候选：\[project\]/,
      /待办：group 下一轮补一个不跑模型的 canary/,
      /提案：\[open\] 低成本确定性下一步：审查包上下文 canary/,
      /错误：\[token=\*\*\*/,
      /只提一个低成本、确定性、当前 workspace scoped 的下一步/,
      /入口：\/工作区 体检；\/候选记忆 分拣；\/候选记忆 快照；\/建议箱 本轮/
    ],
    mustNotMatch: [
      new RegExp(RAW_SECRET),
      new RegExp(PROVIDER_SECRET),
      new RegExp(OPENAI_SECRET),
      /root-only-memory/,
      /users\\?\/1234500001/,
      /项目根目录/
    ],
    maxLength: 2000
  }));
  rows.push(checkCommand({
    commands,
    replies,
    name: "group-round-proposal",
    msg: groupMsg("/建议箱 本轮"),
    mustMatch: [
      /本轮建议/,
      /低成本确定性下一步/,
      /边界：仅当前 workspace；不涉及后台常驻\/跨群\/权限扩大/
    ],
    mustNotMatch: [new RegExp(RAW_SECRET), /切换官方 QQ Bot/],
    maxLength: 1600
  }));
  rows.push(checkCommand({
    commands,
    replies,
    name: "group-proposal-export-redacted",
    msg: groupMsg("/提案 导出 all"),
    mustMatch: [/当前 workspace 提案摘要/, /token=\*\*\*/, /provider_api_key=\*\*\*/, /OPENAI_API_KEY=\*\*\*/, /低成本确定性下一步/],
    mustNotMatch: [new RegExp(RAW_SECRET), new RegExp(PROVIDER_SECRET), new RegExp(OPENAI_SECRET), /sk-[a-z0-9_-]{8,}/i],
    maxLength: 1800
  }));
  rows.push(checkCommand({
    commands,
    replies,
    name: "admin-review-packet-user-scoped",
    msg: privateMsg(ADMIN_USER, "/审查包"),
    mustMatch: [
      /子 agent 审查包/,
      /范围：private:1234500001/,
      /记忆：active 1/,
      /候选记忆：active 2/,
      /提案：open 2/,
      /来源提示/,
      /待办：admin-private 下一轮补一个不跑模型的 canary/
    ],
    mustNotMatch: [
      new RegExp(RAW_SECRET),
      new RegExp(PROVIDER_SECRET),
      new RegExp(OPENAI_SECRET),
      /root-only-memory/,
      /root-decoy/,
      /范围：private:root/
    ],
    maxLength: 2000
  }));
  rows.push(checkCommand({
    commands,
    replies,
    name: "normal-private-review-packet",
    msg: privateMsg(NORMAL_USER, "/审查包"),
    mustMatch: [/范围：private:1234500002/, /记忆：active 1/, /文件索引：total 1/, /来源提示/, /待办：normal-private 下一轮补一个不跑模型的 canary/],
    mustNotMatch: [/1234500001/, /root-only-memory/, new RegExp(RAW_SECRET), new RegExp(PROVIDER_SECRET), new RegExp(OPENAI_SECRET)],
    maxLength: 2000
  }));

  assert.strictEqual(fs.existsSync(path.join(root, "memory", "memories.jsonl")), true, "root decoy should exist for isolation canary");
  assert.strictEqual(fs.existsSync(path.join(adminWorkspace, "memory", "memories.jsonl")), true, "admin user memory should exist");
  return rows;
}

function seedWorkspace(workspace, { scope, scopeID, userID, name }) {
  fs.mkdirSync(workspace, { recursive: true });
  addMemory({
    workspace,
    scope,
    scopeID,
    subject: scope === "private" ? userID : scopeID,
    kind: "preference",
    text: `${name} 默认短答，先给结论`,
    sourceMessageID: `${name}-memory`
  });
  savePendingCandidates({
    workspace,
    scope,
    scopeID,
    candidates: [
      { user: userID, user_id: userID, kind: "preference", tags: ["style"], text: `${name} 回复保留上下文摘要` },
      { user: userID, user_id: userID, kind: "project", tags: ["iteration"], text: `${name} 每轮结束让子 agent 审查一个低成本点子` }
    ]
  });
  addTodo({
    workspace,
    scope,
    scopeID,
    userID,
    text: `${name} 下一轮补一个不跑模型的 canary`
  });
  addProposal({
    workspace,
    scope,
    scopeID,
    userID,
    title: "低成本确定性下一步：审查包上下文 canary",
    body: "用固定脚本输出当前 workspace 的记忆、候选、提案、待办、文件和错误摘要，模型只审查一个下一步。"
  });
  addProposal({
    workspace,
    scope,
    scopeID,
    userID,
    title: `敏感字段脱敏检查 token=${RAW_SECRET}`,
    body: `导出时必须隐藏 provider_api_key=${PROVIDER_SECRET}; OPENAI_API_KEY=${OPENAI_SECRET}; sk-${RAW_SECRET.replace(/-/g, "")}`
  });
  addFileIndex({
    workspace,
    scope,
    scopeID,
    userID,
    name: `${name}-notes.txt`,
    relativePath: `local_files/archive/${name}-notes.txt`,
    size: 128,
    parser: "text",
    extractedPath: `local_files/extracted/${name}-notes.txt`
  });
}

function seedRootDecoy(root) {
  addMemory({
    workspace: root,
    scope: "private",
    scopeID: "root",
    subject: "root",
    kind: "project",
    text: `root-only-memory token=${RAW_SECRET}`,
    sourceMessageID: "root-decoy"
  });
  appendRecentError({
    file: path.join(root, "memory", "recent-errors.jsonl"),
    event: {
      kind: `token=${RAW_SECRET}`,
      scope: "group",
      target: String(GROUP_ID),
      message: `provider_api_key=${PROVIDER_SECRET} should be redacted`
    },
    maskSensitive
  });
}

function baseDeps({ root, replies, groupWorkspace, adminWorkspace, normalWorkspace, recentErrorFile }) {
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
    workspaceForPrivateUser: (userID) => Number(userID) === ADMIN_USER ? adminWorkspace : normalWorkspace,
    executionWorkspaceForPrivateUser: (userID) => Number(userID) === ADMIN_USER ? root : normalWorkspace,
    projectRoot: root,
    ensureGroupProfile: () => {},
    ensurePrivateProfile: () => {},
    appendLine: () => {},
    memberProfilePath: () => path.join(groupWorkspace, "members", "member.md"),
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

function checkCommand({ commands, replies, name, msg, mustMatch = [], mustNotMatch = [], maxLength }) {
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
  if (maxLength) {
    assert.ok(reply.length <= maxLength, `${name} should stay within ${maxLength} chars, got ${reply.length}`);
  }
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
    "Usage: node scripts/check-review-packet-canaries.js [--table|--json]",
    "",
    "Checks /审查包 and proposal exports provide bounded, redacted, workspace-scoped review context."
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR review packet canaries failed: ${error.message}\n`);
  process.exit(1);
}
