const assert = require("assert");
const { createHealthSnapshot } = require("./lib/proxy-health");
const { createProxyCommands } = require("./lib/proxy-commands");

function testAtOnlyRequiredPorts() {
  const clients = new Map([[3002, {}], [3003, {}], [3005, {}], [3006, {}]]);
  const snapshot = createHealthSnapshot({
    listenStates: new Map(),
    listenPorts: [3002, 3003, 3005, 3006],
    clients,
    upstreamReady: () => true,
    upstreamState: () => 1,
    upstreamUrl: "ws://127.0.0.1:3001",
    allowedGroups: [100000001, 100000002],
    allowedPrivateUsers: [200000001],
    pending: [],
    pendingEchoPorts: new Map(),
    pendingOutbound: new Map(),
    pendingFileDownloads: new Map(),
    botReplyRoutes: new Map(),
    defaultListenMode: "selective",
    listenModeByGroup: new Map(),
    quietUntilByGroup: new Map(),
    imageStates: new Map(),
    atOnlyGroups: [100000002],
    privateRoutes: new Map([[200000001, { port: 3006 }]]),
    routeForGroup: (groupID) => {
      if (Number(groupID) === 100000002) return { listenPort: null, atPort: 3005 };
      return { listenPort: 3002, atPort: 3003 };
    },
    maskID: (value) => String(value)
  });

  assert.deepStrictEqual(snapshot.required_ports, [3002, 3003, 3005, 3006]);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(snapshot.ports, "3004"), false);
  assert.strictEqual(snapshot.ok, true);
}

function testAtOnlyModeCommandCannotEnableAll() {
  const replies = [];
  const deps = {
    messageText: (msg) => msg.raw_message || "",
    sendPrivateText: (_userID, _messageID, text) => replies.push(text),
    sendGroupText: (_groupID, _messageID, text) => replies.push(text),
    healthSnapshot: () => ({ ok: true, upstream: { ready: true }, pending: { upstream_queue: 0, outbound: 0 } }),
    imageStateKey: () => "group:100000002",
    imageStates: new Map(),
    effectiveListenMode: () => "mention",
    defaultListenMode: "selective",
    atOnlyGroups: [100000002],
    isGroupQuiet: () => false,
    adminUsers: [],
    allowedGroups: [100000002],
    allowedPrivateUsers: [],
    workspaceForGroup: () => process.cwd(),
    workspaceForPrivateUser: () => process.cwd(),
    ensureGroupProfile: () => {},
    ensurePrivateProfile: () => {},
    appendLine: () => {},
    memberProfilePath: () => "",
    removeLinesContaining: () => 0,
    todayLocal: () => "2026-05-23",
    quietUntilByGroup: new Map(),
    persistProxyState: () => {},
    pending: [],
    pendingOutbound: new Map(),
    pendingFileDownloads: new Map(),
    listenStates: new Map(),
    botReplyRoutes: new Map(),
    listenModeByGroup: new Map(),
    maskSensitive: (value) => value
  };
  const commands = createProxyCommands(deps);
  const msg = { message_type: "group", group_id: 100000002, user_id: 1, message_id: 2, raw_message: "/模式 all" };

  assert.strictEqual(commands.isProxyCommand(msg), true);
  commands.handleProxyCommand(msg);
  assert.strictEqual(replies[0], "这个群已锁定为 @ 触发，只能设为 mention 或 off。");
  assert.strictEqual(deps.listenModeByGroup.has(100000002), false);
}

testAtOnlyRequiredPorts();
testAtOnlyModeCommandCannotEnableAll();
console.log("onebot proxy unit checks ok");
