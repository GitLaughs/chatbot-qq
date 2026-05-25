#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createProxyCommands } = require("./lib/proxy-commands");
const { addFileIndex } = require("./lib/file-index");

const GROUP_ID = 9876500001;
const ADMIN_USER = 1234500001;
const NORMAL_USER = 1234500002;

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.json && options.table) {
    throw new Error("--json and --table are mutually exclusive");
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "low-restriction-commands-"));
  const oldEnv = captureEnv(["OPENCLAW_COMMAND_SCRIPT", "OPENCLAW_COMMAND_ROOT", "OPENCLAW_COMMAND_PYTHON"]);
  try {
    const rows = runCanaries(temp);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, checked: rows.length, rows }, null, 2)}\n`);
      return;
    }
    if (options.table) {
      process.stdout.write(`${formatTable(rows)}\n`);
      return;
    }
    process.stdout.write(`OK low-restriction command canaries passed. checked=${rows.length}\n`);
  } finally {
    restoreEnv(oldEnv);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function runCanaries(root) {
  const replies = [];
  const groupWorkspace = path.join(root, "groups", `sandbox-${GROUP_ID}`);
  const adminWorkspace = path.join(root, "users", String(ADMIN_USER));
  const normalWorkspace = path.join(root, "users", String(NORMAL_USER));
  fs.mkdirSync(groupWorkspace, { recursive: true });
  fs.mkdirSync(adminWorkspace, { recursive: true });
  fs.mkdirSync(normalWorkspace, { recursive: true });
  addFileIndex({
    workspace: groupWorkspace,
    scope: "group",
    scopeID: String(GROUP_ID),
    name: "overview.txt",
    relativePath: "local_files/archive/overview.txt",
    size: 12,
    parser: "text"
  });
  addFileIndex({
    workspace: normalWorkspace,
    scope: "private",
    scopeID: String(NORMAL_USER),
    name: "private-note.txt",
    relativePath: "local_files/archive/private-note.txt",
    size: 8,
    parser: "text"
  });

  const sharedScript = path.join(root, "capture-shared-command.js");
  fs.writeFileSync(sharedScript, "process.stdout.write(JSON.stringify(process.argv.slice(2)));", "utf8");
  process.env.OPENCLAW_COMMAND_SCRIPT = sharedScript;
  process.env.OPENCLAW_COMMAND_ROOT = root;
  process.env.OPENCLAW_COMMAND_PYTHON = process.execPath;

  const commands = createProxyCommands({
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
    maskSensitive: (value) => String(value).replace(/token=\S+/ig, "token=***"),
    groupRoutes: new Map(),
    privateRoutes: new Map(),
    adminLogFiles: {},
    capabilitySnapshot: () => ({
      checks: {
        onebot_upstream: { ok: true },
        image_generation: { ok: true },
        pdf_parse: { ok: true }
      }
    })
  });

  const rows = [];
  rows.push(checkReply({
    commands,
    replies,
    name: "group-status",
    msg: groupMsg("/status"),
    mustMatch: [/QQ 代理：正常/, /允许群：1 个，私聊：2 个/],
    mustNotMatch: [/没有权限|未知管理员命令/]
  }));
  rows.push(checkReply({
    commands,
    replies,
    name: "private-status-normal-user",
    msg: privateMsg(NORMAL_USER, "/status"),
    mustMatch: [/QQ 代理：正常/, /允许群：1 个，私聊：2 个/],
    mustNotMatch: [/没有权限|管理员工作区/]
  }));
  rows.push(checkReply({
    commands,
    replies,
    name: "group-help-files",
    msg: groupMsg("/help 文件"),
    mustMatch: [/命令搜索：文件/, /\/文件/, /\/找文件 关键词/],
    mustNotMatch: [/\/admin/]
  }));
  rows.push(checkReply({
    commands,
    replies,
    name: "group-local-files",
    msg: groupMsg("/文件"),
    mustMatch: [/文件状态/, /已索引：1/],
    mustNotMatch: [/没有权限/]
  }));
  rows.push(checkReply({
    commands,
    replies,
    name: "private-local-files",
    msg: privateMsg(NORMAL_USER, "/文件"),
    mustMatch: [/文件状态/, /已索引：1/],
    mustNotMatch: [/没有权限|overview\.txt/]
  }));

  const groupShared = checkReply({
    commands,
    replies,
    name: "group-shared-files",
    msg: groupMsg("/files find overview"),
    mustMatch: [/--workspace/],
    mustNotMatch: [/共享索引命令未启用|没有权限/]
  });
  assertSharedArgs(groupShared.reply, ["--root", root, "--workspace", ["groups", `sandbox-${GROUP_ID}`].join("/")], ["/files", "find", "overview"]);
  rows.push(groupShared);

  const privateShared = checkReply({
    commands,
    replies,
    name: "private-shared-memory",
    msg: privateMsg(NORMAL_USER, "/记忆 search 偏好"),
    mustMatch: [/--workspace/],
    mustNotMatch: [/共享索引命令未启用|没有权限/]
  });
  assertSharedArgs(privateShared.reply, ["--root", root, "--workspace", ["users", String(NORMAL_USER)].join("/")], ["/memory", "search", "偏好"]);
  rows.push(privateShared);

  rows.push(checkReply({
    commands,
    replies,
    name: "admin-command-still-protected",
    msg: privateMsg(NORMAL_USER, "/admin status"),
    mustMatch: [/没有权限/],
    mustNotMatch: [/管理员工作区|项目根目录/]
  }));

  return rows;
}

function checkReply({ commands, replies, name, msg, mustMatch = [], mustNotMatch = [] }) {
  assert.strictEqual(commands.isProxyCommand(msg), true, `${name} should be recognized as proxy command`);
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
  return { name, reply: reply.slice(0, 160).replace(/\s+/g, " ") };
}

function assertSharedArgs(reply, prefix, tail) {
  const args = JSON.parse(reply);
  assert.deepStrictEqual(args.slice(0, prefix.length), prefix);
  assert.deepStrictEqual(args.slice(prefix.length), tail);
}

function groupMsg(rawMessage) {
  return { message_type: "group", group_id: GROUP_ID, user_id: NORMAL_USER, message_id: Date.now(), raw_message: rawMessage };
}

function privateMsg(userID, rawMessage) {
  return { message_type: "private", user_id: userID, message_id: Date.now(), raw_message: rawMessage };
}

function captureEnv(names) {
  const captured = {};
  for (const name of names) {
    captured[name] = process.env[name];
  }
  return captured;
}

function restoreEnv(captured) {
  for (const [name, value] of Object.entries(captured)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
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
    "Usage: node scripts/check-low-restriction-command-canaries.js [--table|--json]",
    "",
    "Checks known group/user normal commands are not overblocked, without calling real external services."
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR low-restriction command canaries failed: ${error.message}\n`);
  process.exit(1);
}
