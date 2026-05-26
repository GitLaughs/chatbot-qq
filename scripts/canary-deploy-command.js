"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createProxyCommands } = require("./lib/proxy-commands");
const { createTaskRequest, listTaskRequests, readTaskReceipt } = require("./lib/task-request-store");

function deps({ replies, workspace, deployScript, healthScript }) {
  return {
    messageText: (msg) => msg.raw_message || "",
    sendPrivateText: (_userID, _messageID, text) => replies.push(text),
    sendGroupText: (_groupID, _messageID, text) => replies.push(text),
    healthSnapshot: () => ({ ok: true, upstream: { ready: true }, pending: { upstream_queue: 0, outbound: 0 } }),
    imageStateKey: () => "group:234567890",
    imageStates: new Map(),
    effectiveListenMode: () => "mention",
    defaultListenMode: "selective",
    atOnlyGroups: [],
    isGroupQuiet: () => false,
    adminUsers: [100000001],
    adminRootUsers: [100000001],
    allowedGroups: [234567890],
    allowedPrivateUsers: [],
    workspaceForGroup: () => workspace,
    workspaceForPrivateUser: () => workspace,
    executionWorkspaceForPrivateUser: () => workspace,
    projectRoot: workspace,
    ensureGroupProfile: () => {},
    ensurePrivateProfile: () => {},
    appendLine: () => {},
    memberProfilePath: () => "",
    removeLinesContaining: () => 0,
    todayLocal: () => "2026-05-25",
    quietUntilByGroup: new Map(),
    persistProxyState: () => {},
    pending: [],
    pendingOutbound: new Map(),
    pendingFileDownloads: new Map(),
    listenStates: new Map(),
    botReplyRoutes: new Map(),
    listenModeByGroup: new Map(),
    maskSensitive: (value) => value,
    groupRoutes: new Map(),
    privateRoutes: new Map(),
    adminLogFiles: {},
    capabilitySnapshot: () => null,
    proactiveLevelByGroup: new Map(),
    taskDeployCommand: { file: process.execPath, args: ["-e", deployScript] },
    taskDeployHealthCommand: healthScript ? { file: process.execPath, args: ["-e", healthScript] } : "",
    taskDeployTimeoutMs: 5000,
    taskDeployHealthTimeoutMs: 5000,
  };
}

function confirmMsg(task) {
  return {
    post_type: "message",
    message_type: "group",
    group_id: 234567890,
    user_id: 100000001,
    message_id: 1,
    raw_message: `/任务 确认 ${task.id}`,
  };
}

function makeDeployTask(workspace, messageID) {
  return createTaskRequest({
    workspace,
    scope: "group",
    scopeID: 234567890,
    userID: 100000001,
    messageID,
    taskType: "deploy_or_restart",
    text: "重启 qq bot 服务",
    spec: {
      task_type: "deploy_or_restart",
      action: "restart",
      target: "qq-bot",
      reason: "配置更新后需要重启生效",
      requires_confirmation: true,
    },
    status: "awaiting_confirmation",
  });
}

function testConfirmedDeployRunsCommandAndHealthCheck() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-command-ok-"));
  const replies = [];
  try {
    const task = makeDeployTask(workspace, 1);
    const deployScript = [
      "let input='';",
      "process.stdin.on('data', c => input += c);",
      "process.stdin.on('end', () => {",
      "  const req = JSON.parse(input);",
      "  if (req.role !== 'deploy_or_restart_executor' || req.spec.action !== 'restart') process.exit(2);",
      "  process.stdout.write('deploy ok');",
      "});",
    ].join("");
    const healthScript = [
      "let input='';",
      "process.stdin.on('data', c => input += c);",
      "process.stdin.on('end', () => {",
      "  const req = JSON.parse(input);",
      "  if (req.role !== 'deploy_or_restart_health_check') process.exit(3);",
      "  process.stdout.write('health ok');",
      "});",
    ].join("");
    const commands = createProxyCommands(deps({ replies, workspace, deployScript, healthScript }));
    commands.handleProxyCommand(confirmMsg(task));
    assert.match(replies.at(-1), /已确认并执行任务/);
    assert.match(replies.at(-1), /deploy ok/);
    assert.match(replies.at(-1), /health ok/);
    const updated = listTaskRequests({ workspace }).find((item) => item.id === task.id);
    assert.strictEqual(updated.status, "done");
    const receipt = readTaskReceipt({ workspace, id: task.id });
    assert.strictEqual(receipt.status, "done");
    assert.ok(receipt.checks.some((item) => item.name === "deploy_command" && item.status === "passed"));
    assert.ok(receipt.checks.some((item) => item.name === "health_check" && item.status === "passed"));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function testConfirmedDeployFailureIsRecorded() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-command-fail-"));
  const replies = [];
  try {
    const task = makeDeployTask(workspace, 2);
    const deployScript = "process.stderr.write('deploy failed'); process.exit(7);";
    const commands = createProxyCommands(deps({ replies, workspace, deployScript, healthScript: "" }));
    commands.handleProxyCommand(confirmMsg(task));
    assert.match(replies.at(-1), /已确认但执行失败/);
    assert.match(replies.at(-1), /deploy failed/);
    const updated = listTaskRequests({ workspace }).find((item) => item.id === task.id);
    assert.strictEqual(updated.status, "failed");
    const receipt = readTaskReceipt({ workspace, id: task.id });
    assert.strictEqual(receipt.status, "failed");
    assert.ok(receipt.checks.some((item) => item.name === "deploy_command" && item.status === "failed"));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

testConfirmedDeployRunsCommandAndHealthCheck();
testConfirmedDeployFailureIsRecorded();
console.log("deploy command canaries ok");
