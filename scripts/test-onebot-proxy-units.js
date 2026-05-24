const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHealthSnapshot, createMetricsText } = require("./lib/proxy-health");
const { createProxyCommands } = require("./lib/proxy-commands");
const { createProxyFiles } = require("./lib/proxy-files");
const { loadProxyState } = require("./lib/proxy-state");
const { appendRecentError } = require("./lib/recent-errors");
const { scanPolicyDrift, formatPolicyDrift } = require("./lib/policy-drift");
const { addFileIndex, fileStats, formatFileStats } = require("./lib/file-index");
const { addMemory, savePendingCandidates, softDeleteMemories } = require("./lib/memory-store");
const { looksSensitive: sharedLooksSensitive, maskSensitive: sharedMaskSensitive, redactSecrets } = require("./lib/sensitive-redaction");
const { shouldRenderAsImage, renderForQQ, enrichMessageForAgent, messageText, normalizeVisualSegments, shouldAdminPokeAck, adminPokePayload } = require("./onebot-group-proxy");

function testAtOnlyRequiredPorts() {
  const clients = new Map([[3002, {}], [3003, {}], [3005, {}], [3006, {}]]);
  const snapshot = createHealthSnapshot({
    listenStates: new Map(),
    listenPorts: [3002, 3003, 3005, 3006],
    clients,
    upstreamReady: () => true,
    upstreamState: () => 1,
    upstreamUrl: "ws://127.0.0.1:3001",
    allowedGroups: [1107099585, 171290904],
    allowedPrivateUsers: [2138730775],
    pending: [],
    pendingEchoPorts: new Map(),
    pendingOutbound: new Map(),
    pendingFileDownloads: new Map(),
    botReplyRoutes: new Map(),
    defaultListenMode: "selective",
    listenModeByGroup: new Map(),
    quietUntilByGroup: new Map(),
    imageStates: new Map(),
    atOnlyGroups: [171290904],
    privateRoutes: new Map([[2138730775, { port: 3006 }]]),
    routeForGroup: (groupID) => {
      if (Number(groupID) === 171290904) return { listenPort: null, atPort: 3005 };
      return { listenPort: 3002, atPort: 3003 };
    },
    maskID: (value) => String(value)
  });

  assert.deepStrictEqual(snapshot.required_ports, [3002, 3003, 3005, 3006]);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(snapshot.ports, "3004"), false);
  assert.strictEqual(snapshot.ok, true);
}

function testMetricsTextIncludesOperationalCounters() {
  const text = createMetricsText({
    ok: true,
    upstream: { ready: true },
    ports: { 3002: true, 3005: true },
    required_ports: [3002, 3005],
    pending: { upstream_queue: 2, file_downloads: 1 },
    files: { group_uploads: 3, parse_failed: 1 },
    capabilities: { checks: { dream: { ok: true }, image_generation: { ok: false } } },
    recent_errors: [{ kind: "dream" }],
    listen: { "17***04": { busy: false, queued: 0 } },
    image_jobs: { "group:17***04": { active: 1, queued: 2 } }
  });

  assert.match(text, /chatbot_qq_up 1/);
  assert.match(text, /chatbot_qq_port_connected\{port="3002"\} 1/);
  assert.match(text, /chatbot_qq_pending_file_downloads 1/);
  assert.match(text, /chatbot_qq_files_group_uploads 3/);
  assert.match(text, /chatbot_qq_files_parse_failed 1/);
  assert.match(text, /chatbot_qq_recent_errors 1/);
  assert.match(text, /chatbot_qq_capability_ok\{capability="dream"\} 1/);
  assert.match(text, /chatbot_qq_capability_ok\{capability="image_generation"\} 0/);
}

function testAdminPokeAckUsesNapCatPokeAction() {
  const groupMsg = {
    post_type: "message",
    message_type: "group",
    group_id: 1107099585,
    user_id: 1602858215,
    message_id: 2,
    raw_message: "ping"
  };
  const privateMsg = {
    post_type: "message",
    message_type: "private",
    user_id: 1602858215,
    message_id: 3,
    raw_message: "ping"
  };
  const normalMsg = { ...groupMsg, user_id: 42, message_id: 4 };

  assert.strictEqual(shouldAdminPokeAck(groupMsg), true);
  assert.strictEqual(shouldAdminPokeAck(privateMsg), true);
  assert.strictEqual(shouldAdminPokeAck(normalMsg), false);

  const groupPayload = adminPokePayload(groupMsg);
  assert.strictEqual(groupPayload.action, "send_poke");
  assert.deepStrictEqual(groupPayload.params, { user_id: "1602858215", group_id: "1107099585" });
  assert.match(groupPayload.echo, /^__poke_2_/);

  const privatePayload = adminPokePayload(privateMsg);
  assert.strictEqual(privatePayload.action, "send_poke");
  assert.deepStrictEqual(privatePayload.params, { user_id: "1602858215" });
  assert.match(privatePayload.echo, /^__poke_3_/);
}

function testLatexDisplayDelimitersRenderAsImageAndCleanText() {
  const text = "\\[\n金融/会计/投行就业\n\\]\n\n那上财优势很大。";
  assert.strictEqual(shouldRenderAsImage(text), true);
  const cleaned = renderForQQ(text);
  assert.match(cleaned, /金融\/会计\/投行就业/);
  assert.doesNotMatch(cleaned, /\\\[/);
  assert.doesNotMatch(cleaned, /\\\]/);
}

function testProfileContextPreservesImageSegment() {
  const msg = {
    post_type: "message",
    message_type: "group",
    group_id: 1107099585,
    user_id: 1,
    message_id: 2,
    raw_message: "[CQ:at,qq=3209859433] 评价一下 [CQ:image,file=abc.jpg,url=http://example/image.jpg]",
    message: [
      { type: "at", data: { qq: "3209859433" } },
      { type: "text", data: { text: " 评价一下 " } },
      { type: "image", data: { file: "abc.jpg", url: "http://example/image.jpg" } }
    ]
  };
  const enriched = enrichMessageForAgent(msg);

  assert.ok(enriched.message.some((seg) => seg.type === "image"));
  assert.match(enriched.raw_message, /评价一下/);
  assert.doesNotMatch(messageText(msg), /\[CQ:image/);
  assert.match(messageText(msg), /评价一下 \[图片\]/);
}

function testMfaceIsNormalizedToImageWhenUrlExists() {
  const segments = normalizeVisualSegments([
    { type: "text", data: { text: "看看" } },
    { type: "mface", data: { url: "http://example/sticker.webp", summary: "拍桌" } }
  ]);

  assert.ok(segments.some((seg) => seg.type === "image" && seg.data.file === "http://example/sticker.webp"));
  assert.ok(segments.some((seg) => seg.type === "text" && /表情包:拍桌/.test(seg.data.text)));
}

function testQuotedImageIsForwardedWhenUserRepliesToImage() {
  const msg = {
    post_type: "message",
    message_type: "group",
    group_id: 1107099585,
    user_id: 1,
    message_id: 3,
    raw_message: "[CQ:reply,id=2] 评价一下这个",
    message: [
      { type: "reply", data: { id: "2" } },
      { type: "text", data: { text: "评价一下这个" } }
    ],
    reply: {
      message: [
        { type: "image", data: { url: "http://example/quoted.png" } }
      ]
    }
  };
  const normalized = enrichMessageForAgent(msg);

  assert.ok(normalized.message.some((seg) => seg.type === "image" && seg.data.file === "http://example/quoted.png"));
  assert.match(normalized.raw_message, /引用图片/);
}

function testRawCQImageAndStickerAreNormalized() {
  const msg = {
    post_type: "message",
    message_type: "group",
    group_id: 1107099585,
    user_id: 1,
    message_id: 4,
    raw_message: "看看这个[CQ:image,file=abc.jpg,url=http://example/raw.png][CQ:mface,url=http://example/sticker.webp,summary=点头]",
    message: "看看这个[CQ:image,file=abc.jpg,url=http://example/raw.png][CQ:mface,url=http://example/sticker.webp,summary=点头]"
  };
  const enriched = enrichMessageForAgent(msg);

  assert.ok(enriched.message.some((seg) => seg.type === "image" && seg.data.file === "http://example/raw.png"));
  assert.ok(enriched.message.some((seg) => seg.type === "image" && seg.data.file === "http://example/sticker.webp"));
  assert.match(messageText(msg), /看看这个\[图片\]\[表情包:点头\]/);
  assert.doesNotMatch(messageText(msg), /\[CQ:image/);
}

function testInvalidProxyStateIsQuarantinedAndReset() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-state-"));
  const file = path.join(temp, "onebot-proxy-state.json");
  const logs = [];
  try {
    fs.writeFileSync(file, "{\\ version\\:1}", "utf8");
    const listenModes = new Map();
    const quietUntil = new Map();

    loadProxyState({
      file,
      listenModes,
      quietUntil,
      atOnlyGroups: [],
      log: (...args) => logs.push(args.join(" "))
    });

    const reset = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(reset.version, 1);
    assert.deepStrictEqual(reset.listen_modes, {});
    assert.deepStrictEqual(reset.quiet_until, {});
    assert.ok(fs.readdirSync(temp).some((name) => /^onebot-proxy-state\.json\.invalid-\d{14}$/.test(name)));
    assert.ok(logs.some((line) => line.includes("proxy state reset invalid file")));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testAtOnlyModeCommandCannotEnableAll() {
  const replies = [];
  const deps = {
    messageText: (msg) => msg.raw_message || "",
    sendPrivateText: (_userID, _messageID, text) => replies.push(text),
    sendGroupText: (_groupID, _messageID, text) => replies.push(text),
    healthSnapshot: () => ({ ok: true, upstream: { ready: true }, pending: { upstream_queue: 0, outbound: 0 } }),
    imageStateKey: () => "group:171290904",
    imageStates: new Map(),
    effectiveListenMode: () => "mention",
    defaultListenMode: "selective",
    atOnlyGroups: [171290904],
    isGroupQuiet: () => false,
    adminUsers: [],
    allowedGroups: [171290904],
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
  const msg = { message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/模式 all" };

  assert.strictEqual(commands.isProxyCommand(msg), true);
  commands.handleProxyCommand(msg);
  assert.strictEqual(replies[0], "这个群已锁定为 @ 触发，只能设为 mention 或 off。");
  assert.strictEqual(deps.listenModeByGroup.has(171290904), false);
}

function testProfileCommandShowsGroupAndMemberFacts() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-profile-"));
  try {
    const memberFile = path.join(temp, "members", "1.md");
    appendLine(path.join(temp, "GROUP_PROFILE.md"), "- 2026-05-23 群偏好/事实: 默认短答，先给结论");
    appendLine(memberFile, "- 2026-05-23 用户补充: 喜欢步骤化说明");
    const deps = {
      messageText: (msg) => msg.raw_message || "",
      sendPrivateText: (_userID, _messageID, text) => replies.push(text),
      sendGroupText: (_groupID, _messageID, text) => replies.push(text),
      healthSnapshot: () => ({ ok: true, upstream: { ready: true }, pending: { upstream_queue: 0, outbound: 0 } }),
      imageStateKey: () => "group:171290904",
      imageStates: new Map(),
      effectiveListenMode: () => "mention",
      defaultListenMode: "selective",
      atOnlyGroups: [171290904],
      isGroupQuiet: () => false,
      adminUsers: [],
      allowedGroups: [171290904],
      allowedPrivateUsers: [],
      workspaceForGroup: () => temp,
      workspaceForPrivateUser: () => temp,
      ensureGroupProfile: () => {},
      ensurePrivateProfile: () => {},
      appendLine: () => {},
      memberProfilePath: () => memberFile,
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
    const msg = { message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/画像" };

    assert.strictEqual(commands.isProxyCommand(msg), true);
    commands.handleProxyCommand(msg);
    assert.match(replies[0], /当前画像/);
    assert.match(replies[0], /默认短答/);
    assert.match(replies[0], /步骤化说明/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testStatusShowsCapabilities() {
  const replies = [];
  const deps = baseCommandDeps({
    replies,
    capabilitySnapshot: () => ({
      time: "2026-05-23T15:09:08.000Z",
      checks: {
        onebot_upstream: { ok: true },
        dream: { ok: true },
        image_generation: { ok: false },
        rendering: { ok: true },
        pdf_parse: { ok: true }
      }
    })
  });
  const commands = createProxyCommands(deps);
  commands.handleProxyCommand({ message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/status" });
  assert.match(replies[0], /能力快照/);
  assert.match(replies[0], /dream:可用/);
  assert.match(replies[0], /画图:不可用/);
}

function testHelpIndexFiltersByContextAndKeyword() {
  const groupReplies = [];
  const groupCommands = createProxyCommands(baseCommandDeps({ replies: groupReplies }));
  groupCommands.handleProxyCommand({ message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/help" });
  assert.match(groupReplies.at(-1), /可用命令/);
  assert.match(groupReplies.at(-1), /\/dream 或 做梦/);
  assert.doesNotMatch(groupReplies.at(-1), /\/admin/);
  assert.match(groupReplies.at(-1), /\/help 关键词/);

  groupCommands.handleProxyCommand({ message_type: "group", group_id: 171290904, user_id: 1, message_id: 3, raw_message: "/help 待办" });
  assert.match(groupReplies.at(-1), /命令搜索：待办/);
  assert.match(groupReplies.at(-1), /\/待办/);
  assert.match(groupReplies.at(-1), /\/待办 候选/);
  assert.match(groupReplies.at(-1), /\/待办 应用候选/);

  groupCommands.handleProxyCommand({ message_type: "group", group_id: 171290904, user_id: 1, message_id: 4, raw_message: "/help 管理员" });
  assert.match(groupReplies.at(-1), /没有找到相关命令/);
  assert.doesNotMatch(groupReplies.at(-1), /\/admin/);

  groupCommands.handleProxyCommand({ message_type: "group", group_id: 171290904, user_id: 1, message_id: 5, raw_message: "/help dream" });
  assert.match(groupReplies.at(-1), /\/dream 或 做梦/);

  const privateReplies = [];
  const privateCommands = createProxyCommands(baseCommandDeps({ replies: privateReplies, adminRootUsers: [1602858215], adminUsers: [1602858215] }));
  privateCommands.handleProxyCommand({ message_type: "private", user_id: 1602858215, message_id: 6, raw_message: "/help" });
  assert.match(privateReplies.at(-1), /\/admin/);
  assert.doesNotMatch(privateReplies.at(-1), /\/dream 或 做梦/);

  privateCommands.handleProxyCommand({ message_type: "private", user_id: 1602858215, message_id: 7, raw_message: "/help 管理员" });
  assert.match(privateReplies.at(-1), /\/admin/);

  privateCommands.handleProxyCommand({ message_type: "private", user_id: 1602858215, message_id: 8, raw_message: "/help dream" });
  assert.match(privateReplies.at(-1), /没有找到相关命令/);
  assert.doesNotMatch(privateReplies.at(-1), /\/dream/);

  privateCommands.handleProxyCommand({ message_type: "private", user_id: 1602858215, message_id: 9, raw_message: "/命令 待办" });
  assert.match(privateReplies.at(-1), /命令搜索：待办/);
  assert.match(privateReplies.at(-1), /\/待办/);

  privateCommands.handleProxyCommand({ message_type: "private", user_id: 1602858215, message_id: 10, raw_message: "/help 不存在关键词" });
  assert.strictEqual(privateReplies.at(-1), "没有找到相关命令：不存在关键词");
}

function testRememberSearchAndForgetStructuredMemory() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-memory-"));
  try {
    const memberFile = path.join(temp, "members", "1.md");
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: () => temp,
      memberProfilePath: () => memberFile,
      appendLine
    });
    const commands = createProxyCommands(deps);
    const msg = { message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/记住 默认短答，先给结论" };
    commands.handleProxyCommand(msg);

    const memories = fs.readFileSync(path.join(temp, "memory", "memories.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(memories.length, 2);
    assert.strictEqual(memories[0].version, 1);
    assert.strictEqual(memories[0].scope, "group");
    assert.strictEqual(memories[0].scope_id, "171290904");
    assert.strictEqual(memories[1].scope, "member");
    assert.strictEqual(memories[1].subject_id, "1");
    assert.ok(memories[0].fingerprint);
    assert.ok(memories[0].tags.includes("style"));

    commands.handleProxyCommand({ ...msg, raw_message: "/记忆 短答" });
    assert.match(replies.at(-1), /结构化记忆/);
    assert.match(replies.at(-1), /默认短答/);

    commands.handleProxyCommand({ ...msg, raw_message: "/忘记 短答" });
    assert.match(replies.at(-1), /已删除/);
    commands.handleProxyCommand({ ...msg, raw_message: "/记忆 短答" });
    assert.match(replies.at(-1), /没找到结构化记忆/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testDuplicateRememberIsDeterministicallySkippedAndStatsWork() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-memory-dedupe-"));
  try {
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: () => temp,
      memberProfilePath: () => path.join(temp, "members", "1.md"),
      appendLine
    });
    const commands = createProxyCommands(deps);
    const msg = { message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/记住 默认短答，先给结论" };
    commands.handleProxyCommand(msg);
    commands.handleProxyCommand(msg);
    const rows = fs.readFileSync(path.join(temp, "memory", "memories.jsonl"), "utf8").trim().split(/\r?\n/);
    assert.strictEqual(rows.length, 2);
    commands.handleProxyCommand({ ...msg, raw_message: "/记忆 状态" });
    assert.match(replies.at(-1), /记忆状态/);
    assert.match(replies.at(-1), /有效：2/);
    assert.match(replies.at(-1), /preference:2/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testPrivateMemoryDoesNotSearchOtherWorkspace() {
  const replies = [];
  const privateA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-private-a-"));
  const privateB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-private-b-"));
  try {
    const deps = baseCommandDeps({
      replies,
      workspaceForPrivateUser: (userID) => Number(userID) === 1 ? privateA : privateB,
      appendLine
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "private", user_id: 1, message_id: 2, raw_message: "/记住 我的偏好是详细推导" });
    commands.handleProxyCommand({ message_type: "private", user_id: 2, message_id: 3, raw_message: "/记忆 详细推导" });
    assert.match(replies.at(-1), /没找到结构化记忆/);
  } finally {
    fs.rmSync(privateA, { recursive: true, force: true });
    fs.rmSync(privateB, { recursive: true, force: true });
  }
}

function testRecentMemoriesAreScopedSortedLimitedAndMasked() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-memory-recent-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-memory-recent-b-"));
  try {
    for (let i = 1; i <= 6; i += 1) {
      addMemory({
        workspace: groupA,
        scope: "group",
        scopeID: "1",
        subject: "1",
        kind: "note",
        text: i === 6 ? `第${i}条 token=${"secret-value"}` : `第${i}条`
      });
    }
    addMemory({
      workspace: groupB,
      scope: "group",
      scopeID: "2",
      subject: "2",
      kind: "note",
      text: "其他群记忆"
    });
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: [],
      maskSensitive: (value) => String(value).replace(/token=\S+/ig, "token=***")
    });
    const commands = createProxyCommands(deps);
    const msg = { message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/记忆 最近" };
    commands.handleProxyCommand(msg);
    assert.match(replies.at(-1), /最近记忆/);
    assert.match(replies.at(-1), /1\. .*第6条 token=\*\*\*/);
    assert.doesNotMatch(replies.at(-1), /secret-value/);
    assert.doesNotMatch(replies.at(-1), /第1条|其他群记忆/);
    assert.strictEqual((replies.at(-1).match(/^\d+\. /gm) || []).length, 5);

    commands.handleProxyCommand({ ...msg, raw_message: "/记忆 最近 2" });
    assert.strictEqual((replies.at(-1).match(/^\d+\. /gm) || []).length, 2);
    assert.match(replies.at(-1), /第6条/);
    assert.match(replies.at(-1), /第5条/);
    commands.handleProxyCommand({ ...msg, raw_message: "/记忆 最近 11" });
    assert.strictEqual(replies.at(-1), "用法：/记忆 最近 [数量]，数量范围 1-10。");

    commands.handleProxyCommand({ ...msg, raw_message: "/忘记 第6条" });
    commands.handleProxyCommand({ ...msg, raw_message: "/记忆 最近 1" });
    assert.doesNotMatch(replies.at(-1), /第6条/);
    assert.match(replies.at(-1), /第5条/);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testRecentMemoriesPrivateSubjectIsolationAndEmptyState() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-memory-recent-private-"));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-memory-recent-empty-"));
  try {
    addMemory({
      workspace: temp,
      scope: "private",
      scopeID: "1",
      subject: "1",
      kind: "preference",
      text: "用户1偏好详细解释"
    });
    addMemory({
      workspace: temp,
      scope: "private",
      scopeID: "2",
      subject: "2",
      kind: "preference",
      text: "用户2偏好短答"
    });
    const deps = baseCommandDeps({
      replies,
      workspaceForPrivateUser: (userID) => Number(userID) === 1 ? temp : empty
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "private", user_id: 1, message_id: 2, raw_message: "/记忆 最近" });
    assert.match(replies.at(-1), /用户1偏好详细解释/);
    assert.doesNotMatch(replies.at(-1), /用户2偏好短答/);
    commands.handleProxyCommand({ message_type: "private", user_id: 3, message_id: 3, raw_message: "/记忆 最近" });
    assert.strictEqual(replies.at(-1), "当前会话还没有 active 记忆。");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

function testMemoryEvidenceShowsSourceAndPendingCandidates() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-memory-evidence-"));
  try {
    addMemory({
      workspace: temp,
      scope: "group",
      scopeID: "171290904",
      subject: "171290904",
      kind: "preference",
      text: "默认短答，先给结论",
      source: "explicit",
      sourceMessageID: "msg-1",
      tags: ["style"]
    });
    savePendingCandidates({
      workspace: temp,
      scope: "group",
      scopeID: "171290904",
      candidates: [{ user: "Alice", user_id: "1", kind: "todo", tags: ["todo"], text: "明天记得整理 QQ bot 待办", time: "2026-05-24T09:00:00.000Z" }]
    });
    fs.appendFileSync(path.join(temp, "memory", "memories.jsonl"), "{bad json}\n", "utf8");
    const deps = baseCommandDeps({ replies, workspaceForGroup: () => temp });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/证据 短答" });
    assert.match(replies.at(-1), /记忆证据/);
    assert.match(replies.at(-1), /已确认记忆/);
    assert.match(replies.at(-1), /候选记忆（待确认）/);
    assert.match(replies.at(-1), /\[memory\/preference\]/);
    assert.match(replies.at(-1), /source=explicit platform=qq message=msg-1/);
    assert.match(replies.at(-1), /tags=style/);
    assert.doesNotMatch(replies.at(-1), /^[A-Za-z]:\\/m);

    commands.handleProxyCommand({ message_type: "group", group_id: 171290904, user_id: 1, message_id: 3, raw_message: "/为什么这么说 待办" });
    assert.match(replies.at(-1), /\[candidate\/todo\]/);
    assert.match(replies.at(-1), /source=pending-candidate/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testMemoryRulesAndPreflightAreDeterministicAndMasked() {
  const replies = [];
  const commands = createProxyCommands(baseCommandDeps({ replies }));
  const msg = { message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/记忆 规则" };

  commands.handleProxyCommand(msg);
  assert.match(replies.at(-1), /记忆规则（确定性）/);
  assert.match(replies.at(-1), /preference=偏好/);
  assert.match(replies.at(-1), /\/记忆 预检 文本/);

  commands.handleProxyCommand({ ...msg, raw_message: "/记忆 预检 以后回答默认短答，先给结论" });
  assert.match(replies.at(-1), /记忆预检/);
  assert.match(replies.at(-1), /结果：适合进入候选记忆/);
  assert.match(replies.at(-1), /分类：preference/);
  assert.match(replies.at(-1), /标签：style/);

  commands.handleProxyCommand({ ...msg, raw_message: "/记忆 预检 token=secret-value" });
  assert.match(replies.at(-1), /结果：不建议自动候选/);
  assert.match(replies.at(-1), /疑似包含密钥或令牌/);
  assert.doesNotMatch(replies.at(-1), /secret-value/);

  commands.handleProxyCommand({ ...msg, raw_message: "/记忆 预检" });
  assert.strictEqual(replies.at(-1), "用法：/记忆 预检 文本");
}

function testMemoryEvidenceExcludesDeletedAndPrivateOtherWorkspace() {
  const replies = [];
  const privateA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-evidence-a-"));
  const privateB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-evidence-b-"));
  try {
    addMemory({
      workspace: privateA,
      scope: "private",
      scopeID: "1",
      subject: "1",
      kind: "preference",
      text: `我的 token=${"secret-value"} 偏好是详细推导`,
      sourceMessageID: "secret-msg"
    });
    softDeleteMemories({ workspace: privateA, query: "详细推导", subject: "1", scope: "private" });
    addMemory({
      workspace: privateB,
      scope: "private",
      scopeID: "2",
      subject: "2",
      kind: "preference",
      text: "我的偏好是详细推导",
      sourceMessageID: "other-msg"
    });
    const deps = baseCommandDeps({
      replies,
      workspaceForPrivateUser: (userID) => Number(userID) === 1 ? privateA : privateB,
      maskSensitive: (value) => String(value).replace(/token=\S+/ig, "token=***")
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "private", user_id: 1, message_id: 2, raw_message: "/证据 详细推导" });
    assert.match(replies.at(-1), /没找到可解释的记忆证据/);
    assert.doesNotMatch(replies.at(-1), /secret-value/);
    assert.doesNotMatch(replies.at(-1), /other-msg/);
  } finally {
    fs.rmSync(privateA, { recursive: true, force: true });
    fs.rmSync(privateB, { recursive: true, force: true });
  }
}

function testProposalBoxAddListSearchShowAndStatus() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposals-"));
  try {
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: () => temp,
      maskSensitive: (value) => String(value).replace(/token=\S+/ig, "token=***")
    });
    const commands = createProxyCommands(deps);
    const msg = { message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/建议箱 add 记录 dream 点子 | 把模型审查建议沉淀成 token=secret-value backlog" };

    commands.handleProxyCommand(msg);
    assert.match(replies.at(-1), /已加入建议箱/);
    assert.match(replies.at(-1), /记录 dream 点子/);
    assert.doesNotMatch(replies.at(-1), /secret-value/);

    commands.handleProxyCommand({ ...msg, raw_message: "/建议箱" });
    assert.match(replies.at(-1), /建议箱/);
    assert.match(replies.at(-1), /记录 dream 点子/);

    commands.handleProxyCommand({ ...msg, raw_message: "/建议箱 search backlog" });
    assert.match(replies.at(-1), /建议搜索/);
    assert.match(replies.at(-1), /记录 dream 点子/);

    const proposalID = JSON.parse(fs.readFileSync(path.join(temp, "memory", "proposals.jsonl"), "utf8").trim()).id;
    commands.handleProxyCommand({ ...msg, raw_message: `/建议箱 show ${proposalID}` });
    assert.match(replies.at(-1), /建议详情/);
    assert.match(replies.at(-1), /token=\*\*\*/);
    assert.doesNotMatch(replies.at(-1), /secret-value/);

    commands.handleProxyCommand({ ...msg, raw_message: `/建议箱 accept ${proposalID}` });
    assert.strictEqual(replies.at(-1), "建议已标记为 accepted。");
    commands.handleProxyCommand({ ...msg, raw_message: "/建议箱" });
    assert.strictEqual(replies.at(-1), "暂无建议。");
    commands.handleProxyCommand({ ...msg, raw_message: "/提案 search dream" });
    assert.match(replies.at(-1), /\[accepted\]/);

    commands.handleProxyCommand({ ...msg, raw_message: `/建议箱 done ${proposalID}` });
    assert.strictEqual(replies.at(-1), "建议已标记为 done。");
    const events = fs.readFileSync(path.join(temp, "memory", "proposals.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].type, "add");
    assert.strictEqual(events[1].type, "status");
    assert.strictEqual(events[2].status, "done");

    fs.appendFileSync(path.join(temp, "memory", "proposals.jsonl"), "{bad json}\n", "utf8");
    commands.handleProxyCommand({ ...msg, raw_message: "/建议箱 状态" });
    assert.match(replies.at(-1), /建议箱状态/);
    assert.match(replies.at(-1), /总数：1/);
    assert.match(replies.at(-1), /done：1/);
    assert.match(replies.at(-1), /坏行：1/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testProposalBoxDoesNotCrossWorkspace() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposals-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposals-b-"));
  try {
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/建议箱 add 群A提案 | 只属于 A" });
    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 3, raw_message: "/建议箱 search 群A" });
    assert.strictEqual(replies.at(-1), "暂无建议。");
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 4, raw_message: "/建议箱 search 群A" });
    assert.match(replies.at(-1), /群A提案/);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testProposalBoxDeduplicatesWithinWorkspaceOnly() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-dedupe-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-dedupe-b-"));
  try {
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    });
    const commands = createProxyCommands(deps);
    const addA = { message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/建议箱 add 重复提案 | 归一化 内容" };
    commands.handleProxyCommand(addA);
    assert.match(replies.at(-1), /已加入建议箱/);
    commands.handleProxyCommand({ ...addA, message_id: 3, raw_message: "/建议箱 add 重复提案|归一化   内容" });
    assert.match(replies.at(-1), /已有相同提案/);
    assert.match(replies.at(-1), /\/建议箱 show/);

    let rows = fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(rows.length, 1);

    commands.handleProxyCommand({ ...addA, message_id: 4, raw_message: "/建议箱 add 重复提案 | 不同正文" });
    rows = fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(rows.length, 2);

    commands.handleProxyCommand({ ...addA, message_id: 5, raw_message: `/建议箱 done ${rows[0].id}` });
    assert.match(replies.at(-1), /done/);
    commands.handleProxyCommand({ ...addA, message_id: 6, raw_message: "/建议箱 add 重复提案 | 归一化 内容" });
    assert.match(replies.at(-1), /\[done\]/);
    rows = fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(rows.length, 3);

    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 7, raw_message: "/建议箱 add 重复提案 | 归一化 内容" });
    const groupBRows = fs.readFileSync(path.join(groupB, "memory", "proposals.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(groupBRows.length, 1);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testProposalExportSummarizesCurrentWorkspaceWithoutMutating() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-export-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-export-b-"));
  try {
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: [],
      maskSensitive: (value) => String(value).replace(/token=\S+/ig, "token=***")
    });
    const commands = createProxyCommands(deps);
    for (let i = 1; i <= 3; i += 1) {
      commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: i, raw_message: `/提案 add A提案${i} | 理由${i}${i === 3 ? " token=secret-value" : ""}` });
    }
    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 10, raw_message: "/提案 add B提案 | 不应出现在 A" });
    const proposalRowsBefore = fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const firstID = proposalRowsBefore[0].id;
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 11, raw_message: `/提案 accept ${firstID}` });

    const fileBeforeExport = fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8");
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 12, raw_message: "/提案 导出 2" });
    assert.match(replies.at(-1), /当前 workspace 提案摘要/);
    assert.match(replies.at(-1), /状态统计：open 2 \/ accepted 1/);
    assert.match(replies.at(-1), /A提案3/);
    assert.match(replies.at(-1), /A提案2/);
    assert.doesNotMatch(replies.at(-1), /A提案1/);
    assert.doesNotMatch(replies.at(-1), /B提案/);
    assert.match(replies.at(-1), /token=\*\*\*/);
    assert.doesNotMatch(replies.at(-1), /secret-value/);
    assert.strictEqual(fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8"), fileBeforeExport);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 13, raw_message: "/提案 导出 all" });
    assert.match(replies.at(-1), /最近提案/);
    assert.match(replies.at(-1), /\[accepted\] A提案1/);
    assert.match(replies.at(-1), /\[open\] A提案3/);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 14, raw_message: "/提案 导出 21" });
    assert.strictEqual(replies.at(-1), "用法：/提案 导出 [数量|all]，数量范围 1-20。");
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 15, raw_message: "/提案 导出 abc" });
    assert.strictEqual(replies.at(-1), "用法：/提案 导出 [数量|all]，数量范围 1-20。");
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testProposalCheckPreflightsCurrentWorkspaceOnly() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-check-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-check-b-"));
  try {
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: [],
      maskSensitive: (value) => String(value).replace(/token=\S+/ig, "token=***")
    });
    const commands = createProxyCommands(deps);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/提案 add 小功能 | 当前 workspace 只读查询，补测试" });
    let rows = fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const safeID = rows[0].id;
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 3, raw_message: `/提案 check ${safeID}` });
    assert.match(replies.at(-1), /提案预检/);
    assert.match(replies.at(-1), /结论：适合本轮/);
    assert.match(replies.at(-1), /当前 workspace 隔离/);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 4, raw_message: "/提案 add 高风险 | 读取 token=secret-value，跨群 embedding daemon 自动部署" });
    rows = fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const riskyID = rows[1].id;
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 5, raw_message: `/建议箱 预检 ${riskyID}` });
    assert.match(replies.at(-1), /结论：不建议本轮/);
    assert.match(replies.at(-1), /secrets\/tokens\/cookies/);
    assert.match(replies.at(-1), /跨群/);
    assert.match(replies.at(-1), /embedding/);
    assert.match(replies.at(-1), /后台常驻/);
    assert.doesNotMatch(replies.at(-1), /secret-value/);

    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 6, raw_message: `/提案 check ${safeID}` });
    assert.strictEqual(replies.at(-1), "没有找到这条建议。");
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 7, raw_message: "/提案 check" });
    assert.strictEqual(replies.at(-1), "用法：/提案 check ID");
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testProposalLinksAreWorkspaceScopedDedupedAndMasked() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-links-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-links-b-"));
  try {
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: [],
      maskSensitive: (value) => String(value).replace(/token=\S+/ig, "token=***")
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/提案 add 关联测试 | 记录命令和测试证据" });
    const proposalID = JSON.parse(fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8").trim()).id;

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 3, raw_message: `/提案 关联 ${proposalID} 命令 /记忆 最近` });
    assert.match(replies.at(-1), /已添加关联/);
    assert.match(replies.at(-1), /\[command\] \/记忆 最近/);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 4, raw_message: `/提案 关联 ${proposalID} 测试 npm test` });
    assert.match(replies.at(-1), /\[test\] npm test/);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 5, raw_message: `/提案 关联 ${proposalID} 文件 scripts/lib/proposal-store.js` });
    assert.match(replies.at(-1), /\[file\] scripts\/lib\/proposal-store\.js/);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 6, raw_message: `/提案 关联 ${proposalID} 命令 /记忆 最近` });
    assert.strictEqual(replies.at(-1), "这条关联已存在。");
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 7, raw_message: `/提案 关联 ${proposalID} 错误 token=secret-value` });
    assert.strictEqual(replies.at(-1), "关联内容包含敏感字段，已拒绝保存。");

    const events = fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(events.filter((row) => row.type === "link").length, 3);
    assert.doesNotMatch(JSON.stringify(events), /secret-value/);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 8, raw_message: `/提案 关联 ${proposalID}` });
    assert.match(replies.at(-1), /提案关联/);
    assert.match(replies.at(-1), /\[command\] \/记忆 最近/);
    assert.match(replies.at(-1), /\[test\] npm test/);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 9, raw_message: `/提案 show ${proposalID}` });
    assert.match(replies.at(-1), /关联：/);
    assert.match(replies.at(-1), /\[file\] scripts\/lib\/proposal-store\.js/);

    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 10, raw_message: `/提案 关联 ${proposalID} 命令 /status` });
    assert.strictEqual(replies.at(-1), "没有找到这条建议。");
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 11, raw_message: "/提案 关联 missing 命令 /status" });
    assert.strictEqual(replies.at(-1), "没有找到这条建议。");
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 12, raw_message: `/提案 关联 ${proposalID} 未知 内容` });
    assert.strictEqual(replies.at(-1), "用法：/提案 关联 ID 命令|测试|文件|错误|提案 内容");
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testProposalRoundPicksSafeAcceptedWithoutMutating() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-round-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-round-b-"));
  try {
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: [],
      maskSensitive: (value) => String(value).replace(/token=\S+/ig, "token=***")
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/提案 add open安全 | 当前 workspace 小改动并补测试" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 3, raw_message: "/提案 add accepted安全 | 确定性命令，npm test" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 4, raw_message: "/提案 add 风险项 | 跨群 embedding daemon token=secret-value" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 14, raw_message: "/提案 add 风险每消息总结 | 每条消息都调用 LLM 总结并写入记忆" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 15, raw_message: "/提案 add 风险常驻向量库 | 常驻向量库索引所有聊天记忆" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 16, raw_message: "/提案 add 风险自动部署 | 自动部署并重启生产服务" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 20, raw_message: "/提案 add 风险官方Bot | 改用官方 QQ Bot 主线并迁移架构" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 21, raw_message: "/提案 add 风险每消息LLM | 每消息 LLM 总结所有聊天" });
    let rows = fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const openID = rows[0].id;
    const acceptedID = rows[1].id;
    const riskyID = rows[2].id;
    const perMessageID = rows[3].id;
    const vectorID = rows[4].id;
    const autoDeployID = rows[5].id;
    const officialBotID = rows[6].id;
    const perMessageLlmID = rows[7].id;
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 5, raw_message: `/提案 accept ${acceptedID}` });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 6, raw_message: `/提案 accept ${riskyID}` });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 17, raw_message: `/提案 accept ${perMessageID}` });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 18, raw_message: `/提案 accept ${vectorID}` });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 19, raw_message: `/提案 accept ${autoDeployID}` });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 22, raw_message: `/提案 accept ${officialBotID}` });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 23, raw_message: `/提案 accept ${perMessageLlmID}` });
    const before = fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8");

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 7, raw_message: "/提案 本轮" });
    assert.match(replies.at(-1), /本轮建议/);
    assert.match(replies.at(-1), /\[accepted\]/);
    assert.match(replies.at(-1), /accepted安全/);
    assert.doesNotMatch(replies.at(-1), /风险项|风险每消息总结|风险常驻向量库|风险自动部署|风险官方Bot|风险每消息LLM|secret-value|open安全/);
    assert.strictEqual(fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8"), before);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 8, raw_message: `/提案 done ${acceptedID}` });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 9, raw_message: "/建议箱 本轮" });
    assert.match(replies.at(-1), /open安全/);
    assert.doesNotMatch(replies.at(-1), /accepted安全|风险项|风险每消息总结|风险常驻向量库|风险自动部署|风险官方Bot|风险每消息LLM/);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 10, raw_message: `/提案 skip ${openID} 不做` });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 11, raw_message: "/提案 本轮" });
    assert.strictEqual(replies.at(-1), "本轮建议：暂无适合本轮的提案。");

    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 12, raw_message: "/提案 add B提案 | 当前 workspace" });
    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 13, raw_message: "/提案 本轮" });
    assert.match(replies.at(-1), /B提案/);
    assert.doesNotMatch(replies.at(-1), /open安全|accepted安全/);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testProposalLandCreatesTodoOnceAndMarksDone() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-land-"));
  try {
    const commands = createProxyCommands(baseCommandDeps({ replies, workspaceForGroup: () => temp }));
    const msg = { message_type: "group", group_id: 1, user_id: 9, message_id: 2, raw_message: "/提案 add 落地提案 | 做成待办" };
    commands.handleProxyCommand(msg);
    const proposalID = JSON.parse(fs.readFileSync(path.join(temp, "memory", "proposals.jsonl"), "utf8").trim()).id;

    commands.handleProxyCommand({ ...msg, message_id: 3, raw_message: `/建议箱 落地 ${proposalID}` });
    assert.match(replies.at(-1), /只有 accepted 提案可以落地为待办/);

    commands.handleProxyCommand({ ...msg, message_id: 4, raw_message: `/提案 accept ${proposalID}` });
    commands.handleProxyCommand({ ...msg, message_id: 5, raw_message: `/建议箱 落地 ${proposalID}` });
    assert.match(replies.at(-1), /已落地为待办/);
    assert.match(replies.at(-1), /提案已标记 done/);

    const todos = fs.readFileSync(path.join(temp, "memory", "todos.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(todos.length, 1);
    assert.strictEqual(todos[0].type, "add");
    assert.strictEqual(todos[0].source_proposal_id, proposalID);
    assert.strictEqual(todos[0].source_proposal_title, "落地提案");
    assert.match(todos[0].text, /提案落地：落地提案/);

    const proposalRows = fs.readFileSync(path.join(temp, "memory", "proposals.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(proposalRows.some((row) => row.type === "status" && row.id === proposalID && row.status === "done" && /landed-to-todo:todo_/.test(row.reason)));

    commands.handleProxyCommand({ ...msg, message_id: 6, raw_message: `/建议箱 落地 ${proposalID}` });
    assert.match(replies.at(-1), /只有 accepted 提案可以落地为待办|已落地为待办/);
    const todosAfter = fs.readFileSync(path.join(temp, "memory", "todos.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(todosAfter.length, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testProposalLandDoesNotCrossWorkspace() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-land-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-land-b-"));
  try {
    const commands = createProxyCommands(baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    }));
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 2, raw_message: "/提案 add A提案 | A only" });
    const proposalID = JSON.parse(fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8").trim()).id;
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 3, raw_message: `/提案 accept ${proposalID}` });
    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 9, message_id: 4, raw_message: `/建议箱 落地 ${proposalID}` });
    assert.strictEqual(replies.at(-1), "没有找到这条建议。");
    assert.strictEqual(fs.existsSync(path.join(groupB, "memory", "todos.jsonl")), false);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 5, raw_message: `/建议箱 落地 ${proposalID}` });
    assert.match(replies.at(-1), /已落地为待办/);
    assert.ok(fs.existsSync(path.join(groupA, "memory", "todos.jsonl")));
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testProposalLandableListsAcceptedNotYetTodo() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-landable-"));
  try {
    const commands = createProxyCommands(baseCommandDeps({ replies, workspaceForGroup: () => temp }));
    const msg = { message_type: "group", group_id: 1, user_id: 9, message_id: 2, raw_message: "/提案 add 可落地A | A" };
    commands.handleProxyCommand(msg);
    commands.handleProxyCommand({ ...msg, message_id: 3, raw_message: "/提案 add 可落地B | B" });
    commands.handleProxyCommand({ ...msg, message_id: 4, raw_message: "/提案 add 仍open | C" });
    const proposals = fs.readFileSync(path.join(temp, "memory", "proposals.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse).filter((row) => row.type === "add");
    const aID = proposals[0].id;
    const bID = proposals[1].id;
    commands.handleProxyCommand({ ...msg, message_id: 5, raw_message: `/提案 accept ${aID}` });
    commands.handleProxyCommand({ ...msg, message_id: 6, raw_message: `/提案 accept ${bID}` });

    commands.handleProxyCommand({ ...msg, message_id: 7, raw_message: "/建议箱 待落地" });
    assert.match(replies.at(-1), /待落地提案/);
    assert.match(replies.at(-1), /可落地A/);
    assert.match(replies.at(-1), /可落地B/);
    assert.doesNotMatch(replies.at(-1), /仍open/);

    commands.handleProxyCommand({ ...msg, message_id: 8, raw_message: `/建议箱 落地 ${aID}` });
    commands.handleProxyCommand({ ...msg, message_id: 9, raw_message: "/建议箱 待落地" });
    assert.doesNotMatch(replies.at(-1), /可落地A/);
    assert.match(replies.at(-1), /可落地B/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testProposalExecutionGateBlocksRiskyAcceptedProposals() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-execution-gate-"));
  try {
    const commands = createProxyCommands(baseCommandDeps({ replies, workspaceForGroup: () => temp }));
    const msg = { message_type: "group", group_id: 1, user_id: 9, message_id: 2, raw_message: "/提案 add 安全落地 | 当前 workspace 小测试" };
    const riskyInputs = [
      "/提案 add 风险官方Bot | 改用官方 QQ Bot 主线并迁移架构",
      "/提案 add 风险每消息LLM | 每消息 LLM 总结所有聊天",
      "/提案 add 风险常驻向量库 | 常驻向量库索引所有聊天记忆",
      "/提案 add 风险自动部署 | 自动部署并重启生产服务"
    ];
    commands.handleProxyCommand(msg);
    for (let i = 0; i < riskyInputs.length; i += 1) {
      commands.handleProxyCommand({ ...msg, message_id: 3 + i, raw_message: riskyInputs[i] });
    }
    const proposals = fs.readFileSync(path.join(temp, "memory", "proposals.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse).filter((row) => row.type === "add");
    const safeID = proposals[0].id;
    const riskyIDs = proposals.slice(1).map((item) => item.id);
    for (const id of [safeID, ...riskyIDs]) {
      commands.handleProxyCommand({ ...msg, message_id: 10, raw_message: `/提案 accept ${id}` });
    }

    commands.handleProxyCommand({ ...msg, message_id: 20, raw_message: "/建议箱 待落地" });
    assert.match(replies.at(-1), /待落地提案/);
    assert.match(replies.at(-1), /安全落地/);
    assert.doesNotMatch(replies.at(-1), /风险官方Bot|风险每消息LLM|风险常驻向量库|风险自动部署/);

    commands.handleProxyCommand({ ...msg, message_id: 21, raw_message: `/建议箱 落地 ${riskyIDs[0]}` });
    assert.match(replies.at(-1), /提案预检未通过/);
    assert.match(replies.at(-1), /官方 QQ Bot/);
    assert.strictEqual(fs.existsSync(path.join(temp, "memory", "todos.jsonl")), false);

    commands.handleProxyCommand({ ...msg, message_id: 22, raw_message: `/建议箱 落地 ${riskyIDs[1]}` });
    assert.match(replies.at(-1), /提案预检未通过/);
    assert.match(replies.at(-1), /每消息处理/);
    assert.strictEqual(fs.existsSync(path.join(temp, "memory", "todos.jsonl")), false);

    commands.handleProxyCommand({ ...msg, message_id: 23, raw_message: `/建议箱 落地 ${safeID}` });
    assert.match(replies.at(-1), /已落地为待办/);
    const todos = fs.readFileSync(path.join(temp, "memory", "todos.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(todos.length, 1);
    assert.strictEqual(todos[0].source_proposal_id, safeID);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testProposalExecutionGateChecksRiskyLinks() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-link-gate-"));
  try {
    const commands = createProxyCommands(baseCommandDeps({ replies, workspaceForGroup: () => temp }));
    const msg = { message_type: "group", group_id: 1, user_id: 9, message_id: 2, raw_message: "/提案 add 链接风险 | 当前 workspace 小测试" };
    commands.handleProxyCommand(msg);
    commands.handleProxyCommand({ ...msg, message_id: 3, raw_message: "/提案 add 安全执行 | 当前 workspace 安全落地" });
    const proposals = fs.readFileSync(path.join(temp, "memory", "proposals.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse).filter((row) => row.type === "add");
    const riskyID = proposals[0].id;
    const safeID = proposals[1].id;
    commands.handleProxyCommand({ ...msg, message_id: 4, raw_message: `/提案 accept ${riskyID}` });
    commands.handleProxyCommand({ ...msg, message_id: 5, raw_message: `/提案 accept ${safeID}` });
    commands.handleProxyCommand({ ...msg, message_id: 6, raw_message: `/提案 关联 ${riskyID} 命令 重启 onebot-group-proxy` });
    assert.match(replies.at(-1), /已添加关联/);

    commands.handleProxyCommand({ ...msg, message_id: 7, raw_message: `/提案 check ${riskyID}` });
    assert.match(replies.at(-1), /结论：不建议本轮/);
    assert.match(replies.at(-1), /重启/);

    commands.handleProxyCommand({ ...msg, message_id: 8, raw_message: "/提案 本轮" });
    assert.match(replies.at(-1), /安全执行/);
    assert.doesNotMatch(replies.at(-1), /链接风险/);

    commands.handleProxyCommand({ ...msg, message_id: 9, raw_message: "/建议箱 待落地" });
    assert.match(replies.at(-1), /安全执行/);
    assert.doesNotMatch(replies.at(-1), /链接风险/);

    commands.handleProxyCommand({ ...msg, message_id: 10, raw_message: `/建议箱 落地 ${riskyID}` });
    assert.match(replies.at(-1), /提案预检未通过/);
    assert.match(replies.at(-1), /重启/);
    assert.strictEqual(fs.existsSync(path.join(temp, "memory", "todos.jsonl")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testProposalLandableDoesNotCrossWorkspace() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-landable-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-proposal-landable-b-"));
  try {
    const commands = createProxyCommands(baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    }));
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 2, raw_message: "/提案 add A待落地 | A" });
    const aID = JSON.parse(fs.readFileSync(path.join(groupA, "memory", "proposals.jsonl"), "utf8").trim()).id;
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 3, raw_message: `/提案 accept ${aID}` });
    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 9, message_id: 4, raw_message: "/建议箱 待落地" });
    assert.strictEqual(replies.at(-1), "暂无待落地提案。");
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 5, raw_message: "/建议箱 待落地" });
    assert.match(replies.at(-1), /A待落地/);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testTodoCommandAddListDoneAndStats() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-todo-"));
  try {
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: () => temp,
      maskSensitive: (value) => String(value).replace(/token=\S+/ig, "token=***")
    });
    const commands = createProxyCommands(deps);
    const msg = { message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/待办 add 整理 token=secret-value 日志" };
    commands.handleProxyCommand(msg);
    assert.match(replies.at(-1), /已添加待办/);
    assert.match(replies.at(-1), /token=\*\*\*/);
    assert.doesNotMatch(replies.at(-1), /secret-value/);

    commands.handleProxyCommand({ ...msg, raw_message: "/待办" });
    assert.match(replies.at(-1), /待办/);
    assert.match(replies.at(-1), /整理 token=\*\*\* 日志/);

    const rows = fs.readFileSync(path.join(temp, "memory", "todos.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(rows[0].type, "add");
    assert.strictEqual(rows[0].scope, "group");
    assert.strictEqual(rows[0].scope_id, "171290904");
    assert.strictEqual(rows[0].created_by, "1");

    commands.handleProxyCommand({ ...msg, raw_message: "/待办 done 1" });
    assert.match(replies.at(-1), /已完成 1 条待办/);
    const events = fs.readFileSync(path.join(temp, "memory", "todos.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(events[1].type, "done");
    assert.strictEqual(events[1].done_by, "1");

    fs.appendFileSync(path.join(temp, "memory", "todos.jsonl"), "{bad json}\n", "utf8");
    commands.handleProxyCommand({ ...msg, raw_message: "/待办 状态" });
    assert.match(replies.at(-1), /待办状态/);
    assert.match(replies.at(-1), /总数：1/);
    assert.match(replies.at(-1), /未完成：0/);
    assert.match(replies.at(-1), /已完成：1/);
    assert.match(replies.at(-1), /坏行：1/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testTodoCommandWorkspaceIsolationAndDoneByID() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-todo-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-todo-b-"));
  try {
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/待办 群A事项" });
    const todoID = JSON.parse(fs.readFileSync(path.join(groupA, "memory", "todos.jsonl"), "utf8").trim()).id;
    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 3, raw_message: "/待办" });
    assert.match(replies.at(-1), /暂无待办/);
    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 4, raw_message: `/待办 done ${todoID}` });
    assert.match(replies.at(-1), /没有找到可完成的待办/);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 2, message_id: 5, raw_message: `/待办 done ${todoID}` });
    assert.match(replies.at(-1), /已完成 1 条待办/);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testTodoDoneListSortedLimitedMaskedAndScoped() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-todo-done-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-todo-done-b-"));
  try {
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: [],
      maskSensitive: (value) => String(value).replace(/token=\S+/ig, "token=***")
    });
    const commands = createProxyCommands(deps);
    for (let i = 1; i <= 6; i += 1) {
      commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: i, raw_message: `/待办 add A${i}${i === 6 ? " token=secret-value" : ""}` });
    }
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 20, raw_message: "/待办 add A未完成" });
    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 30, raw_message: "/待办 add B1" });

    const groupAFile = path.join(groupA, "memory", "todos.jsonl");
    const groupBFile = path.join(groupB, "memory", "todos.jsonl");
    const groupAAdds = fs.readFileSync(groupAFile, "utf8").trim().split(/\r?\n/).map(JSON.parse).filter((row) => row.type === "add");
    const groupBAdd = JSON.parse(fs.readFileSync(groupBFile, "utf8").trim());
    for (let i = 0; i < 6; i += 1) {
      fs.appendFileSync(groupAFile, `${JSON.stringify({
        version: 1,
        type: "done",
        id: groupAAdds[i].id,
        done_at: `2026-05-24T10:0${i}:00.000Z`,
        done_by: "1"
      })}\n`, "utf8");
    }
    fs.appendFileSync(groupBFile, `${JSON.stringify({
      version: 1,
      type: "done",
      id: groupBAdd.id,
      done_at: "2026-05-24T11:00:00.000Z",
      done_by: "1"
    })}\n{bad json}\n`, "utf8");

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 40, raw_message: "/待办 已完成" });
    assert.match(replies.at(-1), /已完成待办/);
    assert.match(replies.at(-1), /1\. .*A6 token=\*\*\*/);
    assert.match(replies.at(-1), /5\. .*A2/);
    assert.doesNotMatch(replies.at(-1), /A1/);
    assert.doesNotMatch(replies.at(-1), /A未完成/);
    assert.doesNotMatch(replies.at(-1), /secret-value/);
    assert.doesNotMatch(replies.at(-1), /B1/);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 41, raw_message: "/待办 已完成 2" });
    assert.match(replies.at(-1), /1\. .*A6/);
    assert.match(replies.at(-1), /2\. .*A5/);
    assert.doesNotMatch(replies.at(-1), /A4/);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 42, raw_message: "/待办 已完成 21" });
    assert.strictEqual(replies.at(-1), "用法：/待办 已完成 [数量]，数量范围 1-20。");
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 43, raw_message: "/待办 已完成 abc" });
    assert.strictEqual(replies.at(-1), "用法：/待办 已完成 [数量]，数量范围 1-20。");

    const emptyReplies = [];
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-todo-done-empty-"));
    try {
      const emptyCommands = createProxyCommands(baseCommandDeps({ replies: emptyReplies, workspaceForPrivateUser: () => empty }));
      emptyCommands.handleProxyCommand({ message_type: "private", user_id: 1, message_id: 50, raw_message: "/待办 已完成" });
      assert.strictEqual(emptyReplies.at(-1), "暂无已完成待办。");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testTodoSearchKeepsGlobalActiveIndexesAndExplicitAddSemantics() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-todo-search-"));
  try {
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: () => temp,
      maskSensitive: (value) => String(value).replace(/token=\S+/ig, "token=***")
    });
    const commands = createProxyCommands(deps);
    const msg = { message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/待办 add 第一项" };
    commands.handleProxyCommand(msg);
    commands.handleProxyCommand({ ...msg, raw_message: "/待办 add 实验 报告 token=secret-value" });
    commands.handleProxyCommand({ ...msg, raw_message: "/待办 add 实验 数据" });

    commands.handleProxyCommand({ ...msg, raw_message: "/待办 搜索 实验 报告" });
    assert.match(replies.at(-1), /待办/);
    assert.match(replies.at(-1), /2\. .*实验 报告 token=\*\*\*/);
    assert.doesNotMatch(replies.at(-1), /1\. .*实验 报告/);
    assert.doesNotMatch(replies.at(-1), /secret-value/);

    commands.handleProxyCommand({ ...msg, raw_message: "/待办 done 2" });
    assert.match(replies.at(-1), /已完成 1 条待办/);
    commands.handleProxyCommand({ ...msg, raw_message: "/待办 搜索 实验 报告" });
    assert.strictEqual(replies.at(-1), "未找到匹配的未完成待办。");

    commands.handleProxyCommand({ ...msg, raw_message: "/待办 搜索 实验" });
    assert.match(replies.at(-1), /2\. .*实验 数据/);
    commands.handleProxyCommand({ ...msg, raw_message: "/待办 裸关键词仍然添加" });
    assert.match(replies.at(-1), /已添加待办/);
    commands.handleProxyCommand({ ...msg, raw_message: "/待办 搜索 裸关键词" });
    assert.match(replies.at(-1), /3\. .*裸关键词仍然添加/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testTodoSearchDoesNotCrossWorkspace() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-todo-search-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-todo-search-b-"));
  try {
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/待办 add 群A实验" });
    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 3, raw_message: "/待办 add 群B实验" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 4, raw_message: "/待办 搜索 群B" });
    assert.strictEqual(replies.at(-1), "未找到匹配的未完成待办。");
    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 5, raw_message: "/待办 搜索 群B" });
    assert.match(replies.at(-1), /群B实验/);
    assert.doesNotMatch(replies.at(-1), /群A实验/);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testTodoCandidatesUseFilteredIndexesAndDoNotWriteMemories() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-todo-candidates-"));
  try {
    savePendingCandidates({
      workspace: temp,
      scope: "group",
      scopeID: "171290904",
      candidates: [
        { user: "Alice", user_id: "1", kind: "preference", tags: ["style"], text: "以后回答默认短答", time: "2026-05-24T09:00:00.000Z" },
        { user: "Bob", user_id: "2", kind: "todo", tags: ["todo"], text: "明天记得整理 QQ bot 待办", time: "2026-05-24T09:01:00.000Z" }
      ]
    });
    const deps = baseCommandDeps({ replies, workspaceForGroup: () => temp });
    const commands = createProxyCommands(deps);
    const msg = { message_type: "group", group_id: 171290904, user_id: 9, message_id: 2, raw_message: "/待办 候选" };
    commands.handleProxyCommand(msg);
    assert.match(replies.at(-1), /待办候选/);
    assert.doesNotMatch(replies.at(-1), /默认短答/);
    assert.match(replies.at(-1), /1\. Bob: 明天记得整理 QQ bot 待办/);

    commands.handleProxyCommand({ ...msg, raw_message: "/待办 应用候选 1" });
    assert.match(replies.at(-1), /已从候选添加 1 条待办/);
    const todoRows = fs.readFileSync(path.join(temp, "memory", "todos.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(todoRows.length, 1);
    assert.strictEqual(todoRows[0].type, "add");
    assert.strictEqual(todoRows[0].created_by, "9");
    assert.strictEqual(todoRows[0].source_user_id, "2");
    assert.ok(todoRows[0].source_candidate_id);
    assert.strictEqual(fs.existsSync(path.join(temp, "memory", "memories.jsonl")), false);

    const pendingRows = fs.readFileSync(path.join(temp, "memory", "pending-memory-candidates.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const todoCandidate = pendingRows.find((row) => row.kind === "todo");
    assert.ok(todoCandidate.applied_at);
    assert.strictEqual(todoCandidate.applied_by, "9");

    commands.handleProxyCommand({ ...msg, raw_message: "/待办 应用候选 1" });
    assert.match(replies.at(-1), /没有找到可应用的待办候选/);
    const todoRowsAfter = fs.readFileSync(path.join(temp, "memory", "todos.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(todoRowsAfter.length, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testTodoCandidateApplyAllDoesNotAffectOtherWorkspace() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-todo-cand-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-todo-cand-b-"));
  try {
    for (const root of [groupA, groupB]) {
      savePendingCandidates({
        workspace: root,
        scope: "group",
        scopeID: "1",
        candidates: [{ user: "Bob", user_id: "2", kind: "todo", tags: ["todo"], text: "整理群待办", time: "2026-05-24T09:01:00.000Z" }]
      });
    }
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/待办 应用候选 all" });
    assert.match(replies.at(-1), /已从候选添加 1 条待办/);
    assert.ok(fs.existsSync(path.join(groupA, "memory", "todos.jsonl")));
    assert.strictEqual(fs.existsSync(path.join(groupB, "memory", "todos.jsonl")), false);
    const bPending = fs.readFileSync(path.join(groupB, "memory", "pending-memory-candidates.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(bPending[0].applied_at, "");
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testWorkspaceOverviewSummarizesCurrentWorkspaceOnly() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-overview-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-overview-b-"));
  try {
    addMemory({
      workspace: groupA,
      scope: "group",
      scopeID: "1",
      subject: "1",
      kind: "preference",
      text: "默认短答，先给结论"
    });
    savePendingCandidates({
      workspace: groupA,
      scope: "group",
      scopeID: "1",
      candidates: [{ user: "Bob", user_id: "2", kind: "todo", tags: ["todo"], text: "整理群A待办", time: "2026-05-24T09:00:00.000Z" }]
    });
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1602858215, message_id: 2, raw_message: "/待办 群A待办事项" });
    addFileIndex({
      workspace: groupA,
      scope: "group",
      scopeID: "1",
      name: "overview.txt",
      relativePath: "local_files/archive/2026-05-24/overview.txt",
      size: 12,
      parser: "text"
    });
    ensureDir(path.join(groupA, "memory"));
    fs.writeFileSync(path.join(groupA, "memory", "chat-2026-05-24.jsonl"), JSON.stringify({ text: "SHOULD_NOT_APPEAR_IN_OVERVIEW" }) + "\n", "utf8");
    fs.appendFileSync(path.join(groupA, "memory", "todos.jsonl"), "{bad json}\n", "utf8");

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1602858215, message_id: 3, raw_message: "/概览" });
    assert.match(replies.at(-1), /当前概览/);
    assert.match(replies.at(-1), /范围：群 1/);
    assert.match(replies.at(-1), /记忆：有效 1 \/ 总 1/);
    assert.match(replies.at(-1), /候选记忆：待处理 1/);
    assert.match(replies.at(-1), /待办：未完成 1，已完成 0，候选 1，坏行 1/);
    assert.match(replies.at(-1), /文件：已索引 1，最新 1 个：overview\.txt/);
    assert.match(replies.at(-1), /\/dream/);
    assert.doesNotMatch(replies.at(-1), /SHOULD_NOT_APPEAR_IN_OVERVIEW/);
    assert.doesNotMatch(replies.at(-1), /admin|root|允许群|[A-Za-z]:\\/i);

    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1602858215, message_id: 4, raw_message: "/概览" });
    assert.match(replies.at(-1), /范围：群 2/);
    assert.match(replies.at(-1), /记忆：有效 0 \/ 总 0/);
    assert.match(replies.at(-1), /文件：已索引 0，最新 0 个：暂无/);
    assert.doesNotMatch(replies.at(-1), /overview\.txt|群A待办事项/);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testPrivateWorkspaceOverviewIsStableOnEmptyWorkspace() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-overview-private-"));
  try {
    const deps = baseCommandDeps({ replies, workspaceForPrivateUser: () => temp });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "private", user_id: 1602858215, message_id: 2, raw_message: "/工作区" });
    assert.match(replies.at(-1), /当前概览/);
    assert.match(replies.at(-1), /范围：私聊 1602858215/);
    assert.match(replies.at(-1), /记忆：有效 0 \/ 总 0/);
    assert.match(replies.at(-1), /文件：已索引 0，最新 0 个：暂无/);
    assert.doesNotMatch(replies.at(-1), /\/dream/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testWorkspaceHealthSummarizesCurrentWorkspaceOnly() {
  const replies = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-workspace-health-"));
  const groupA = path.join(root, "groups", "1");
  const groupB = path.join(root, "groups", "2");
  const recentErrorFile = path.join(root, "recent-errors.jsonl");
  try {
    savePendingCandidates({
      workspace: groupA,
      scope: "group",
      scopeID: "1",
      candidates: [
        { user: "Alice", user_id: "1", kind: "preference", tags: ["style"], text: "A 群默认短答", time: "2026-05-24T09:00:00.000Z" },
        { user: "Eve", user_id: "2", kind: "note", tags: [], text: "Bearer very-secret-value", time: "2026-05-24T09:01:00.000Z" }
      ]
    });
    savePendingCandidates({
      workspace: groupB,
      scope: "group",
      scopeID: "2",
      candidates: [{ user: "Bob", user_id: "3", kind: "preference", tags: ["style"], text: "B 群默认详细", time: "2026-05-24T09:00:00.000Z" }]
    });
    const pendingFile = path.join(groupA, "memory", "pending-memory-candidates.jsonl");
    const first = JSON.parse(fs.readFileSync(pendingFile, "utf8").trim().split(/\r?\n/)[0]);
    fs.appendFileSync(pendingFile, `${JSON.stringify({ ...first, id: "manual_duplicate", created_at: "2026-05-24T09:02:00.000Z" })}\n`, "utf8");

    addFileIndex({ workspace: groupA, name: "a.txt", relativePath: "local_files/a.txt", size: 12, parser: "text", extractedPath: "local_files/a.txt.txt" });
    addFileIndex({ workspace: groupB, name: "b.txt", relativePath: "local_files/b.txt", size: 12, parser: "text" });
    appendRecentError({ file: recentErrorFile, event: { kind: "test", scope: "group", target: "1", message: "token=secret-value" }, maskSensitive: (value) => value.replace(/secret-value/g, "***") });
    appendRecentError({ file: recentErrorFile, event: { kind: "test", scope: "group", target: "2", message: "other group" }, maskSensitive: (value) => value });
    appendRecentError({ file: recentErrorFile, event: { kind: "legacy", message: "global old error" }, maskSensitive: (value) => value });

    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: [],
      recentErrorFile
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 2, raw_message: "/建议箱 add A提案 | 当前 workspace" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 3, raw_message: "/待办 add A待办" });
    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 9, message_id: 4, raw_message: "/建议箱 add B提案 | 不应出现在 A" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 5, raw_message: "/候选记忆 快照" });
    const pendingBefore = fs.readFileSync(pendingFile, "utf8");

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 6, raw_message: "/工作区 体检" });
    assert.match(replies.at(-1), /工作区体检/);
    assert.match(replies.at(-1), /范围：群 1/);
    assert.match(replies.at(-1), /候选记忆：active 3/);
    assert.match(replies.at(-1), /疑似敏感 1/);
    assert.match(replies.at(-1), /重复 1/);
    assert.match(replies.at(-1), /待办：open 1/);
    assert.match(replies.at(-1), /提案：open 1/);
    assert.match(replies.at(-1), /文件索引：1 条/);
    assert.match(replies.at(-1), /最近快照：[a-f0-9]{40}/);
    assert.match(replies.at(-1), /最近错误：当前 1，全局 1/);
    assert.doesNotMatch(replies.at(-1), /B 群默认详细|B提案|secret-value/);
    assert.strictEqual(fs.readFileSync(pendingFile, "utf8"), pendingBefore);

    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 9, message_id: 7, raw_message: "/工作区 health" });
    assert.match(replies.at(-1), /范围：群 2/);
    assert.match(replies.at(-1), /候选记忆：active 1/);
    assert.match(replies.at(-1), /最近错误：当前 1，全局 1/);
    assert.doesNotMatch(replies.at(-1), /A待办|A提案|A 群默认短答/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testWorkspaceReviewPacketIsScopedAndCompact() {
  const replies = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-review-packet-"));
  const groupA = path.join(root, "groups", "1");
  const groupB = path.join(root, "groups", "2");
  const recentErrorFile = path.join(root, "recent-errors.jsonl");
  try {
    savePendingCandidates({
      workspace: groupA,
      scope: "group",
      scopeID: "1",
      candidates: [{ user: "Alice", user_id: "1", kind: "preference", tags: ["style"], text: "A 群默认短答 token=secret-value", time: "2026-05-24T09:00:00.000Z" }]
    });
    savePendingCandidates({
      workspace: groupB,
      scope: "group",
      scopeID: "2",
      candidates: [{ user: "Bob", user_id: "2", kind: "preference", tags: ["style"], text: "B 群默认详细", time: "2026-05-24T09:00:00.000Z" }]
    });
    addFileIndex({ workspace: groupA, name: "a.txt", relativePath: "local_files/a.txt", size: 12, parser: "text" });
    appendRecentError({ file: recentErrorFile, event: { kind: "dream", scope: "group", target: "1", message: "token=secret-value" }, maskSensitive: (value) => value });
    appendRecentError({ file: recentErrorFile, event: { kind: "image", scope: "group", target: "2", message: "other group" }, maskSensitive: (value) => value });
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: [],
      recentErrorFile
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 2, raw_message: "/建议箱 add A安全候选 | 不展开正文" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 3, raw_message: "/待办 add A待办" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 4, raw_message: "/候选记忆 快照" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 5, raw_message: "/审查包" });
    assert.match(replies.at(-1), /子 agent 审查包/);
    assert.match(replies.at(-1), /NapCat\/OneBot/);
    assert.match(replies.at(-1), /不切官方 QQ Bot/);
    assert.match(replies.at(-1), /不要.*自部署/);
    assert.match(replies.at(-1), /不要常驻向量库/);
    assert.match(replies.at(-1), /每消息 LLM 总结/);
    assert.match(replies.at(-1), /不要.*本地 LLM daemon/);
    assert.match(replies.at(-1), /范围：group:1/);
    assert.match(replies.at(-1), /候选记忆：active 1/);
    assert.match(replies.at(-1), /提案：open 1/);
    assert.match(replies.at(-1), /本轮建议/);
    assert.match(replies.at(-1), /A安全候选/);
    assert.match(replies.at(-1), /待办：open 1/);
    assert.match(replies.at(-1), /来源提示/);
    assert.match(replies.at(-1), /候选：暂无/);
    assert.match(replies.at(-1), /待办：A待办/);
    assert.match(replies.at(-1), /提案：\[open\] A安全候选/);
    assert.match(replies.at(-1), /错误：\[dream\] token=\*\*\*/);
    assert.match(replies.at(-1), /文件索引：total 1/);
    assert.match(replies.at(-1), /错误：current 1 \/ global 0 \/ kinds dream:1/);
    assert.match(replies.at(-1), /审查任务：只提一个低成本/);
    assert.match(replies.at(-1), /确定性、当前 workspace scoped/);
    assert.match(replies.at(-1), /说明是否值得做/);
    assert.match(replies.at(-1), /不要建议已完成项或重架构/);
    assert.doesNotMatch(replies.at(-1), /secret-value|B 群默认详细|不展开正文|other group/);

    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 9, message_id: 6, raw_message: "/审查包" });
    assert.match(replies.at(-1), /范围：group:2/);
    assert.match(replies.at(-1), /候选记忆：active 1/);
    assert.match(replies.at(-1), /错误：current 1 \/ global 0 \/ kinds image:1/);
    assert.doesNotMatch(replies.at(-1), /dream:1|group:1|A安全候选/);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 7, raw_message: "/审查包 foo" });
    assert.strictEqual(replies.at(-1), "用法：/审查包");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testWorkspaceReviewPacketPreservesRouteIDsAndMasksSecrets() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-review-packet-ids-"));
  const recentErrorFile = path.join(temp, "recent-errors.jsonl");
  try {
    appendRecentError({ file: recentErrorFile, event: { kind: "Bearer bearer-secret-value", scope: "group", target: "1107099585", message: "token=secret-value" }, maskSensitive: (value) => value });
    appendRecentError({ file: recentErrorFile, event: { kind: "token 是 natural-secret-value", scope: "group", target: "1107099585", message: "token=secret-value" }, maskSensitive: (value) => value });
    appendRecentError({ file: recentErrorFile, event: { kind: "authorization: header-secret-value", scope: "group", target: "1107099585", message: "normal auth header" }, maskSensitive: (value) => value });
    appendRecentError({ file: recentErrorFile, event: { kind: "token=\"quoted secret value\"", scope: "group", target: "1107099585", message: "quoted token" }, maskSensitive: (value) => value });
    appendRecentError({ file: recentErrorFile, event: { kind: "token=\"unterminated quoted secret value", scope: "group", target: "1107099585", message: "unterminated quoted token" }, maskSensitive: (value) => value });
    appendRecentError({ file: recentErrorFile, event: { kind: "authorization: 'Bearer quoted-secret-value'", scope: "group", target: "1107099585", message: "quoted auth header" }, maskSensitive: (value) => value });
    appendRecentError({ file: recentErrorFile, event: { kind: "authorization='unterminated quoted auth value", scope: "group", target: "1107099585", message: "unterminated quoted auth header" }, maskSensitive: (value) => value });
    appendRecentError({ file: recentErrorFile, event: { kind: "cookie: \"a=b;c=d\"", scope: "group", target: "1107099585", message: "quoted cookie" }, maskSensitive: (value) => value });
    appendRecentError({ file: recentErrorFile, event: { kind: "route 1107099585", scope: "group", target: "1107099585", message: "normal route metadata" }, maskSensitive: (value) => value });
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: () => temp,
      allowedGroups: [1107099585],
      atOnlyGroups: [],
      recentErrorFile,
      maskSensitive: (value) => String(value)
        .replace(/\b\d{6,12}\b/g, (id) => `${id.slice(0, 2)}***${id.slice(-2)}`)
        .replace(/token=\S+/ig, "token=***")
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({
      message_type: "group",
      group_id: 1107099585,
      user_id: 1602858215,
      message_id: 2,
      raw_message: "/建议箱 add 路由候选 | 当前 workspace 小测试"
    });
    commands.handleProxyCommand({
      message_type: "group",
      group_id: 1107099585,
      user_id: 1602858215,
      message_id: 3,
      raw_message: "/审查包"
    });

    assert.match(replies.at(-1), /范围：group:1107099585/);
    assert.doesNotMatch(replies.at(-1), /11\*\*\*85/);
    assert.match(replies.at(-1), /路由候选/);
    assert.match(replies.at(-1), /Bearer \*\*\*:1/);
    assert.match(replies.at(-1), /token 是 \*\*\*:1/);
    assert.match(replies.at(-1), /authorization=\*\*\*:1/);
    assert.match(replies.at(-1), /token=\*\*\*:1/);
    assert.match(replies.at(-1), /cookie=\*\*\*:1/);
    assert.match(replies.at(-1), /route 1107099585:1/);
    assert.doesNotMatch(replies.at(-1), /secret-value|natural-secret-value|bearer-secret-value|header-secret-value|quoted secret value|unterminated quoted secret value|quoted-secret-value|unterminated quoted auth value|a=b;c=d/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testPolicyDriftScannerFindsBoundaryDrift() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "policy-drift-"));
  try {
    ensureDir(path.join(root, "docs"));
    ensureDir(path.join(root, "groups", "sandbox"));
    ensureDir(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "AGENTS.md"), [
      "Prefer QQ official bot APIs first.",
      "QQ numbers and group IDs are routing metadata, not secrets."
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(root, "docs", "server-deploy.md"), "Official QQ Bot: easiest to deploy on Linux.\n", "utf8");
    fs.writeFileSync(path.join(root, "groups", "sandbox", "AGENTS.md"), "Treat QQ numbers, user IDs, group IDs, cookies, tokens, and private chat content as sensitive.\n", "utf8");
    fs.writeFileSync(path.join(root, "scripts", "audit-private-data.ps1"), "@{ name = \"numeric qq id\"; regex = \"x\" }\n", "utf8");
    const report = scanPolicyDrift({ root });
    assert.strictEqual(report.ok, false);
    assert.ok(report.findings.some((item) => item.rule === "official-primary"));
    assert.ok(report.findings.some((item) => item.rule === "qq-id-secret"));
    assert.ok(report.findings.some((item) => item.rule === "numeric-qq-id-blocker"));
    assert.doesNotMatch(formatPolicyDrift(report), /routing metadata, not secrets/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testPolicyDriftScannerAllowsCurrentBoundaryLanguage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "policy-clean-"));
  try {
    ensureDir(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Treat official QQ Bot code/docs as fallback or historical reference only.\nQQ numbers and group IDs are routing metadata, not secrets by themselves.\n", "utf8");
    fs.writeFileSync(path.join(root, "docs", "dream-review-template.md"), "Do not switch the project toward official QQ Bot APIs.\nDo not add always-on vector databases or local LLM daemons.\nThe model must not automatically:\n- Edit secrets.\n- Enable cross-group search by default.\n- Restart production without tests.\n- Run heavy always-on embeddings, local models, or per-message summarization.\n", "utf8");
    const report = scanPolicyDrift({ root });
    assert.strictEqual(report.ok, true);
    assert.match(formatPolicyDrift(report), /未发现漂移/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testPolicyDriftCommandWorks() {
  const replies = [];
  const commands = createProxyCommands(baseCommandDeps({ replies }));
  commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 2, raw_message: "/口径巡检" });
  assert.match(replies.at(-1), /口径巡检/);
  assert.match(replies.at(-1), /检查文件/);
  commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 3, raw_message: "/口径巡检 foo" });
  assert.strictEqual(replies.at(-1), "用法：/口径巡检");
}

function testTodaySummaryShowsMemoryCandidatesWithoutSecrets() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-summary-candidates-"));
  try {
    const memoryDir = path.join(temp, "memory");
    ensureDir(memoryDir);
    const rows = [
      { time: "2026-05-24T09:00:00.000Z", user_id: "1", sender: { nickname: "Alice" }, text: "以后回答默认短答，先给结论" },
      { time: "2026-05-24T09:01:00.000Z", user_id: "1", sender: { nickname: "Alice" }, text: "以后回答默认短答，先给结论" },
      { time: "2026-05-24T09:02:00.000Z", user_id: "2", sender: { nickname: "Bob" }, text: "明天记得整理 QQ bot 的待办" },
      { time: "2026-05-24T09:03:00.000Z", user_id: "3", sender: { nickname: "Eve" }, text: `OPENAI_API_KEY=${"sk-"}real-secret` },
      { time: "2026-05-24T09:04:00.000Z", user_id: "4", sender: { nickname: "C" }, text: "不要自动跨群搜索记忆" }
    ];
    fs.writeFileSync(path.join(memoryDir, "chat-2026-05-24.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: () => temp,
      todayLocal: () => "2026-05-24"
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/总结今天" });
    assert.match(replies[0], /候选可沉淀记忆（未自动写入）/);
    assert.match(replies[0], /\[preference\].*Alice/);
    assert.match(replies[0], /\[todo\].*Bob/);
    assert.match(replies[0], /\[boundary\].*C/);
    assert.doesNotMatch(replies[0], /sk-real-secret/);
    const candidateSection = replies[0].split("候选可沉淀记忆（未自动写入）：")[1].split("最近片段：")[0];
    assert.strictEqual((candidateSection.match(/默认短答/g) || []).length, 1);
    const pendingPath = path.join(temp, "memory", "pending-memory-candidates.jsonl");
    assert.ok(fs.existsSync(pendingPath));
    const pendingRows = fs.readFileSync(pendingPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(pendingRows.length >= 3);
    assert.ok(pendingRows.every((row) => row.scope === "group" && row.scope_id === "171290904"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testPendingMemoryCanBeListedAndAppliedOnce() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-memory-"));
  try {
    const memoryDir = path.join(temp, "memory");
    ensureDir(memoryDir);
    fs.writeFileSync(path.join(memoryDir, "chat-2026-05-24.jsonl"), [
      JSON.stringify({ time: "2026-05-24T09:00:00.000Z", user_id: "1", sender: { nickname: "Alice" }, text: "以后回答默认短答，先给结论" })
    ].join("\n") + "\n", "utf8");
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: () => temp,
      todayLocal: () => "2026-05-24"
    });
    const commands = createProxyCommands(deps);
    const msg = { message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/总结今天" };
    commands.handleProxyCommand(msg);
    commands.handleProxyCommand({ ...msg, raw_message: "/候选记忆" });
    assert.match(replies.at(-1), /候选记忆/);
    assert.match(replies.at(-1), /默认短答/);
    commands.handleProxyCommand({ ...msg, raw_message: "/应用候选记忆 1" });
    assert.match(replies.at(-1), /已应用 1 条候选记忆/);
    commands.handleProxyCommand({ ...msg, raw_message: "/应用候选记忆 1" });
    assert.match(replies.at(-1), /没有可应用的候选/);
    const memories = fs.readFileSync(path.join(memoryDir, "memories.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(memories.length, 1);
    assert.strictEqual(memories[0].source.type, "candidate");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testPendingMemoryCanBeSkippedAndStatsWork() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-memory-skip-"));
  try {
    const memoryDir = path.join(temp, "memory");
    ensureDir(memoryDir);
    fs.writeFileSync(path.join(memoryDir, "chat-2026-05-24.jsonl"), [
      JSON.stringify({ time: "2026-05-24T09:00:00.000Z", user_id: "1", sender: { nickname: "Alice" }, text: "以后回答默认短答，先给结论" }),
      JSON.stringify({ time: "2026-05-24T09:01:00.000Z", user_id: "2", sender: { nickname: "Bob" }, text: "明天记得整理 QQ bot 的待办" })
    ].join("\n") + "\n", "utf8");
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: () => temp,
      todayLocal: () => "2026-05-24"
    });
    const commands = createProxyCommands(deps);
    const msg = { message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/总结今天" };
    commands.handleProxyCommand(msg);
    commands.handleProxyCommand({ ...msg, raw_message: "/跳过候选记忆 1" });
    assert.match(replies.at(-1), /已跳过 1 条候选记忆/);
    commands.handleProxyCommand({ ...msg, raw_message: "/候选记忆" });
    assert.match(replies.at(-1), /默认短答/);
    assert.doesNotMatch(replies.at(-1), /QQ bot 的待办/);
    commands.handleProxyCommand({ ...msg, raw_message: "/候选记忆 状态" });
    assert.match(replies.at(-1), /候选记忆状态/);
    assert.match(replies.at(-1), /已跳过：1/);
    const all = fs.readFileSync(path.join(memoryDir, "pending-memory-candidates.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(all.some((row) => row.skipped_at && row.skipped_by === "1"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testPendingMemoryHealthSummarizesAnomaliesAndStaysScoped() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-health-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-health-b-"));
  try {
    savePendingCandidates({
      workspace: groupA,
      scope: "group",
      scopeID: "1",
      candidates: [
        { user: "Alice", user_id: "1", kind: "preference", tags: ["style"], text: "以后回答默认短答，先给结论", time: "2026-05-24T09:00:00.000Z" },
        { user: "Bob", user_id: "2", kind: "boundary", tags: ["admin"], text: "不要自动跨群搜索记忆", time: "2026-05-24T09:01:00.000Z" }
      ]
    });
    savePendingCandidates({
      workspace: groupB,
      scope: "group",
      scopeID: "2",
      candidates: [{ user: "Mallory", user_id: "9", kind: "todo", tags: ["todo"], text: "B 群不应出现在 A 体检", time: "2026-05-24T09:00:00.000Z" }]
    });
    const file = path.join(groupA, "memory", "pending-memory-candidates.jsonl");
    const first = JSON.parse(fs.readFileSync(file, "utf8").trim().split(/\r?\n/)[0]);
    fs.appendFileSync(file, `${JSON.stringify({ ...first, id: "manual_duplicate", created_at: "2026-05-24T09:02:00.000Z" })}\n`, "utf8");
    fs.appendFileSync(file, `${JSON.stringify({
      version: 1,
      id: "manual_secret",
      created_at: "2026-05-24T09:03:00.000Z",
      scope: "group",
      scope_id: "1",
      subject_id: "3",
      user: "Eve",
      kind: "note",
      tags: [],
      text: "我的 token 是 very-secret-value",
      fingerprint: "manual-secret"
    })}\n`, "utf8");

    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/候选记忆 体检" });
    assert.match(replies.at(-1), /候选记忆体检/);
    assert.match(replies.at(-1), /待处理：4/);
    assert.match(replies.at(-1), /preference:2/);
    assert.match(replies.at(-1), /boundary:1/);
    assert.match(replies.at(-1), /重复 fingerprint 1 组/);
    assert.match(replies.at(-1), /疑似敏感/);
    assert.match(replies.at(-1), /低分类置信度/);
    assert.doesNotMatch(replies.at(-1), /very-secret-value|B 群不应/);

    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 3, raw_message: "/候选记忆 health" });
    assert.match(replies.at(-1), /待处理：1/);
    assert.match(replies.at(-1), /B 群不应出现在 A 体检/);
    assert.doesNotMatch(replies.at(-1), /Alice|very-secret/);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testPendingMemoryTriageSuggestsCommandsWithoutWriting() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-triage-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-triage-b-"));
  try {
    savePendingCandidates({
      workspace: groupA,
      scope: "group",
      scopeID: "1",
      candidates: [
        { user: "Alice", user_id: "1", kind: "preference", tags: ["style"], text: "以后回答默认短答，先给结论", time: "2026-05-24T09:00:00.000Z" },
        { user: "Bob", user_id: "2", kind: "boundary", tags: ["admin"], text: "不要自动跨群搜索记忆", time: "2026-05-24T09:01:00.000Z" },
        { user: "Carol", user_id: "3", kind: "note", tags: [], text: "这个信息可能有用但需要人工改写", time: "2026-05-24T09:02:00.000Z" }
      ]
    });
    savePendingCandidates({
      workspace: groupB,
      scope: "group",
      scopeID: "2",
      candidates: [{ user: "Other", user_id: "8", kind: "preference", tags: ["style"], text: "B 群候选不应进入 A 分拣", time: "2026-05-24T09:00:00.000Z" }]
    });
    const file = path.join(groupA, "memory", "pending-memory-candidates.jsonl");
    const first = JSON.parse(fs.readFileSync(file, "utf8").trim().split(/\r?\n/)[0]);
    fs.appendFileSync(file, `${JSON.stringify({ ...first, id: "manual_duplicate", created_at: "2026-05-24T09:03:00.000Z" })}\n`, "utf8");
    fs.appendFileSync(file, `${JSON.stringify({
      version: 1,
      id: "manual_secret",
      created_at: "2026-05-24T09:04:00.000Z",
      scope: "group",
      scope_id: "1",
      subject_id: "4",
      user: "Eve",
      kind: "note",
      tags: [],
      text: "Bearer very-secret-value",
      fingerprint: "manual-secret"
    })}\n`, "utf8");
    const before = fs.readFileSync(file, "utf8");

    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/候选记忆 分拣" });
    assert.match(replies.at(-1), /候选记忆分拣/);
    assert.match(replies.at(-1), /推荐应用/);
    assert.match(replies.at(-1), /2\. \[boundary\] Bob/);
    assert.match(replies.at(-1), /建议跳过/);
    assert.match(replies.at(-1), /疑似敏感/);
    assert.match(replies.at(-1), /需人工改写/);
    assert.match(replies.at(-1), /1\. \[preference\] Alice.*提示: 重复/);
    assert.match(replies.at(-1), /3\. \[note\] Carol.*阻断: 低分类置信度；提示: 空标签/);
    assert.match(replies.at(-1), /5\. \[note\] Eve.*阻断: 疑似敏感，低分类置信度；提示: 空标签/);
    assert.match(replies.at(-1), /3\. \[note\] Carol.*阻断: 低分类置信度/);
    assert.match(replies.at(-1), /\/处理候选记忆 应用:1,2,4 跳过:5/);
    assert.doesNotMatch(replies.at(-1), /very-secret-value|B 群候选/);
    assert.strictEqual(fs.readFileSync(file, "utf8"), before);

    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 3, raw_message: "/候选记忆 triage" });
    assert.match(replies.at(-1), /B 群候选不应进入 A 分拣/);
    assert.doesNotMatch(replies.at(-1), /Alice|very-secret/);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testPendingMemorySnapshotShowsStableIDsAndStaysScoped() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-snapshot-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-snapshot-b-"));
  try {
    savePendingCandidates({
      workspace: groupA,
      scope: "group",
      scopeID: "1",
      candidates: [
        { user: "Alice", user_id: "1", kind: "preference", tags: ["style"], text: "以后回答默认短答，先给结论", time: "2026-05-24T09:00:00.000Z" },
        { user: "Eve", user_id: "2", kind: "note", tags: [], text: "Bearer very-secret-value", time: "2026-05-24T09:01:00.000Z" }
      ]
    });
    savePendingCandidates({
      workspace: groupB,
      scope: "group",
      scopeID: "2",
      candidates: [{ user: "Bob", user_id: "3", kind: "preference", tags: ["style"], text: "B 群默认详细", time: "2026-05-24T09:00:00.000Z" }]
    });
    const fileA = path.join(groupA, "memory", "pending-memory-candidates.jsonl");
    const rowsA = fs.readFileSync(fileA, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const before = fs.readFileSync(fileA, "utf8");
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    });
    const commands = createProxyCommands(deps);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/候选记忆 快照" });
    assert.match(replies.at(-1), /候选记忆快照/);
    assert.match(replies.at(-1), /snapshot: [a-f0-9]{40}/);
    assert.match(replies.at(-1), /待处理：2/);
    assert.match(replies.at(-1), new RegExp(`1\\. id=${rowsA[0].id.slice(0, 18)}`));
    assert.match(replies.at(-1), /kind=preference user=Alice/);
    assert.match(replies.at(-1), /Bearer \*\*\*/);
    assert.doesNotMatch(replies.at(-1), /very-secret-value|B 群默认详细/);
    assert.strictEqual(fs.readFileSync(fileA, "utf8"), before);

    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 3, raw_message: "/候选记忆 snapshot" });
    assert.match(replies.at(-1), /B 群默认详细/);
    assert.doesNotMatch(replies.at(-1), /Alice|very-secret/);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testPendingMemorySnapshotCompareDetectsChangesAndStaysScoped() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-compare-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-compare-b-"));
  try {
    savePendingCandidates({
      workspace: groupA,
      scope: "group",
      scopeID: "1",
      candidates: [{ user: "Alice", user_id: "1", kind: "preference", tags: ["style"], text: "A 群默认短答", time: "2026-05-24T09:00:00.000Z" }]
    });
    savePendingCandidates({
      workspace: groupB,
      scope: "group",
      scopeID: "2",
      candidates: [{ user: "Bob", user_id: "2", kind: "preference", tags: ["style"], text: "B 群默认详细", time: "2026-05-24T09:00:00.000Z" }]
    });
    const fileA = path.join(groupA, "memory", "pending-memory-candidates.jsonl");
    const before = fs.readFileSync(fileA, "utf8");
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    });
    const commands = createProxyCommands(deps);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/候选记忆 快照" });
    const snapshot = replies.at(-1).match(/snapshot: ([a-f0-9]{40})/)[1];
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 3, raw_message: `/候选记忆 对比 ${snapshot}` });
    assert.match(replies.at(-1), /候选记忆快照对比/);
    assert.match(replies.at(-1), /结果：未变化/);
    assert.match(replies.at(-1), /待处理：1/);
    assert.strictEqual(fs.readFileSync(fileA, "utf8"), before);

    savePendingCandidates({
      workspace: groupA,
      scope: "group",
      scopeID: "1",
      candidates: [{ user: "Carol", user_id: "3", kind: "boundary", tags: ["admin"], text: "不要跨群处理候选", time: "2026-05-24T09:01:00.000Z" }]
    });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 4, raw_message: `/候选记忆 compare ${snapshot}` });
    assert.match(replies.at(-1), /结果：已变化/);
    assert.match(replies.at(-1), /待处理：2/);
    assert.match(replies.at(-1), new RegExp(`expected: ${snapshot}`));

    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 5, raw_message: `/候选记忆 对比 ${snapshot}` });
    assert.match(replies.at(-1), /结果：已变化/);
    assert.match(replies.at(-1), /待处理：1/);
    assert.doesNotMatch(replies.at(-1), /A 群默认短答|不要跨群/);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 6, raw_message: "/候选记忆 对比" });
    assert.strictEqual(replies.at(-1), "用法：/候选记忆 对比 snapshot_sha");
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testPendingMemorySnapshotDiffUsesCachedSnapshot() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-diff-"));
  try {
    savePendingCandidates({
      workspace: temp,
      scope: "group",
      scopeID: "1",
      candidates: [
        { user: "Alice", user_id: "1", kind: "preference", tags: ["style"], text: "A 群默认短答", time: "2026-05-24T09:00:00.000Z" },
        { user: "Bob", user_id: "2", kind: "boundary", tags: ["admin"], text: "不要跨群处理候选", time: "2026-05-24T09:01:00.000Z" }
      ]
    });
    const commands = createProxyCommands(baseCommandDeps({ replies, workspaceForGroup: () => temp }));
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/候选记忆 快照" });
    const snapshot = replies.at(-1).match(/snapshot: ([a-f0-9]{40})/)[1];
    const file = path.join(temp, "memory", "pending-memory-candidates.jsonl");
    const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    rows[0].text = "A 群默认详细";
    rows[1].skipped_at = "2026-05-24T09:02:00.000Z";
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    savePendingCandidates({
      workspace: temp,
      scope: "group",
      scopeID: "1",
      candidates: [{ user: "Carol", user_id: "3", kind: "project", tags: ["code"], text: "新增项目候选", time: "2026-05-24T09:03:00.000Z" }]
    });

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 3, raw_message: `/候选记忆 差异 ${snapshot}` });
    assert.match(replies.at(-1), /候选记忆快照差异/);
    assert.match(replies.at(-1), /新增：1/);
    assert.match(replies.at(-1), /新增项目候选/);
    assert.match(replies.at(-1), /移除：1/);
    assert.match(replies.at(-1), /不要跨群处理候选/);
    assert.match(replies.at(-1), /可能修改：1/);
    assert.match(replies.at(-1), /A 群默认详细/);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 4, raw_message: "/候选记忆 差异 deadbeef" });
    assert.match(replies.at(-1), /结果：找不到旧快照/);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 5, raw_message: "/候选记忆 差异" });
    assert.strictEqual(replies.at(-1), "用法：/候选记忆 差异 snapshot_sha");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testPendingMemorySnapshotDiffDoesNotCrossWorkspace() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-diff-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-diff-b-"));
  try {
    savePendingCandidates({
      workspace: groupA,
      scope: "group",
      scopeID: "1",
      candidates: [{ user: "Alice", user_id: "1", kind: "preference", tags: ["style"], text: "A 群默认短答", time: "2026-05-24T09:00:00.000Z" }]
    });
    savePendingCandidates({
      workspace: groupB,
      scope: "group",
      scopeID: "2",
      candidates: [{ user: "Bob", user_id: "2", kind: "preference", tags: ["style"], text: "B 群默认详细", time: "2026-05-24T09:00:00.000Z" }]
    });
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/候选记忆 快照" });
    const snapshot = replies.at(-1).match(/snapshot: ([a-f0-9]{40})/)[1];
    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 3, raw_message: `/候选记忆 差异 ${snapshot}` });
    assert.match(replies.at(-1), /结果：找不到旧快照/);
    assert.doesNotMatch(replies.at(-1), /A 群默认短答/);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testProcessPendingMemoryBatchUsesSingleSnapshot() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-batch-"));
  try {
    savePendingCandidates({
      workspace: temp,
      scope: "group",
      scopeID: "1",
      candidates: [
        { user: "A", user_id: "1", kind: "preference", tags: ["style"], text: "以后回答默认短答，先给结论", time: "2026-05-24T09:00:00.000Z" },
        { user: "B", user_id: "2", kind: "boundary", tags: ["admin"], text: "不要自动跨群搜索记忆", time: "2026-05-24T09:01:00.000Z" },
        { user: "C", user_id: "3", kind: "project", tags: ["code"], text: "项目目前使用 onebot proxy", time: "2026-05-24T09:02:00.000Z" },
        { user: "D", user_id: "4", kind: "todo", tags: ["todo"], text: "明天整理待办候选", time: "2026-05-24T09:03:00.000Z" },
        { user: "E", user_id: "5", kind: "note", tags: [], text: "Bearer very-secret-value", time: "2026-05-24T09:04:00.000Z" }
      ]
    });
    const file = path.join(temp, "memory", "pending-memory-candidates.jsonl");
    const beforeRows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const commands = createProxyCommands(baseCommandDeps({ replies, workspaceForGroup: () => temp }));
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 2, raw_message: "/处理候选记忆 应用:2 跳过:5" });
    assert.strictEqual(replies.at(-1), "已处理候选记忆：应用 1 条，跳过 1 条。");

    const afterRows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(afterRows.find((row) => row.id === beforeRows[1].id && row.applied_at && row.applied_by === "9"));
    assert.ok(afterRows.find((row) => row.id === beforeRows[4].id && row.skipped_at && row.skipped_by === "9"));
    assert.ok(afterRows.find((row) => row.id === beforeRows[3].id && !row.applied_at && !row.skipped_at));
    const memories = fs.readFileSync(path.join(temp, "memory", "memories.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(memories.length, 1);
    assert.match(memories[0].text, /不要自动跨群搜索记忆/);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 3, raw_message: "/处理候选记忆 应用:1 跳过:1" });
    assert.match(replies.at(-1), /应用 1 条，跳过 0 条/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testProcessPendingMemoryBatchDoesNotCrossWorkspace() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-batch-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-batch-b-"));
  try {
    savePendingCandidates({
      workspace: groupA,
      scope: "group",
      scopeID: "1",
      candidates: [{ user: "Alice", user_id: "1", kind: "preference", tags: ["style"], text: "A 群默认短答", time: "2026-05-24T09:00:00.000Z" }]
    });
    savePendingCandidates({
      workspace: groupB,
      scope: "group",
      scopeID: "2",
      candidates: [{ user: "Bob", user_id: "2", kind: "preference", tags: ["style"], text: "B 群默认详细", time: "2026-05-24T09:00:00.000Z" }]
    });
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 9, message_id: 2, raw_message: "/处理候选记忆 应用:1" });
    assert.match(replies.at(-1), /应用 1 条，跳过 0 条/);
    assert.match(fs.readFileSync(path.join(groupA, "memory", "memories.jsonl"), "utf8"), /A 群默认短答/);
    assert.strictEqual(fs.existsSync(path.join(groupB, "memory", "memories.jsonl")), false);
    const bRows = fs.readFileSync(path.join(groupB, "memory", "pending-memory-candidates.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(!bRows[0].applied_at && !bRows[0].skipped_at);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testPendingMemorySearchPreservesGlobalActiveIndexes() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-search-"));
  try {
    const memoryDir = path.join(temp, "memory");
    ensureDir(memoryDir);
    fs.writeFileSync(path.join(memoryDir, "chat-2026-05-24.jsonl"), [
      JSON.stringify({ time: "2026-05-24T09:00:00.000Z", user_id: "1", sender: { nickname: "Alice" }, text: "以后回答默认短答，先给结论" }),
      JSON.stringify({ time: "2026-05-24T09:01:00.000Z", user_id: "2", sender: { nickname: "Bob" }, text: "明天记得整理 QQ bot 的待办" }),
      JSON.stringify({ time: "2026-05-24T09:02:00.000Z", user_id: "3", sender: { nickname: "C" }, text: "不要自动跨群搜索记忆" })
    ].join("\n") + "\n", "utf8");
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: () => temp,
      todayLocal: () => "2026-05-24"
    });
    const commands = createProxyCommands(deps);
    const msg = { message_type: "group", group_id: 171290904, user_id: 9, message_id: 2, raw_message: "/总结今天" };
    commands.handleProxyCommand(msg);

    commands.handleProxyCommand({ ...msg, raw_message: "/候选记忆 Bob todo" });
    assert.match(replies.at(-1), /候选记忆/);
    assert.match(replies.at(-1), /2\. \[todo\] Bob/);
    assert.doesNotMatch(replies.at(-1), /1\. \[todo\]/);

    commands.handleProxyCommand({ ...msg, raw_message: "/应用候选记忆 2" });
    assert.match(replies.at(-1), /没有可应用的候选/);
    assert.match(replies.at(-1), /todo需走待办或改写:1/);
    assert.strictEqual(fs.existsSync(path.join(memoryDir, "memories.jsonl")), false);

    commands.handleProxyCommand({ ...msg, raw_message: "/候选记忆 Bob todo" });
    assert.match(replies.at(-1), /2\. \[todo\] Bob/);
    commands.handleProxyCommand({ ...msg, raw_message: "/候选记忆 状态" });
    assert.match(replies.at(-1), /候选记忆状态/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testPendingMemorySearchDoesNotCrossWorkspace() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-search-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-search-b-"));
  try {
    savePendingCandidates({
      workspace: groupA,
      scope: "group",
      scopeID: "1",
      candidates: [{ user: "Alice", user_id: "1", kind: "todo", tags: ["todo"], text: "整理 A 群待办", time: "2026-05-24T09:00:00.000Z" }]
    });
    savePendingCandidates({
      workspace: groupB,
      scope: "group",
      scopeID: "2",
      candidates: [{ user: "Bob", user_id: "2", kind: "todo", tags: ["todo"], text: "整理 B 群待办", time: "2026-05-24T09:00:00.000Z" }]
    });
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/候选记忆 Bob" });
    assert.strictEqual(replies.at(-1), "没有匹配的待处理候选记忆。");
    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 3, raw_message: "/候选记忆 Bob" });
    assert.match(replies.at(-1), /Bob/);
    assert.doesNotMatch(replies.at(-1), /Alice|A 群/);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testSkipAllDoesNotAffectOtherWorkspace() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pending-b-"));
  try {
    for (const root of [groupA, groupB]) {
      ensureDir(path.join(root, "memory"));
      fs.writeFileSync(path.join(root, "memory", "chat-2026-05-24.jsonl"), JSON.stringify({
        time: "2026-05-24T09:00:00.000Z",
        user_id: "1",
        sender: { nickname: "Alice" },
        text: "以后回答默认短答，先给结论"
      }) + "\n", "utf8");
    }
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      todayLocal: () => "2026-05-24"
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/总结今天" });
    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 3, raw_message: "/总结今天" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 4, raw_message: "/跳过候选记忆 all" });
    const a = fs.readFileSync(path.join(groupA, "memory", "pending-memory-candidates.jsonl"), "utf8");
    const b = fs.readFileSync(path.join(groupB, "memory", "pending-memory-candidates.jsonl"), "utf8");
    assert.match(a, /skipped_at/);
    assert.doesNotMatch(b, /skipped_at/);
  } finally {
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testRecentErrorsCommandUsesStructuredFile() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-errors-"));
  try {
    const file = path.join(temp, "recent-errors.jsonl");
    appendRecentError({
      file,
      event: {
        kind: "dream",
        scope: "group",
        target: "1107099585",
        message: "codex exit 1 token=\"quoted secret value\"",
        detail: "authorization='unterminated quoted auth value"
      }
    });
    const deps = baseCommandDeps({
      replies,
      recentErrorFile: file,
      maskSensitive: sharedMaskSensitive
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/最近错误" });
    assert.match(replies[0], /最近错误/);
    assert.match(replies[0], /\[dream\]/);
    assert.match(replies[0], /codex exit 1/);
    assert.match(replies[0], /group 1107099585/);
    assert.match(replies[0], /token=\*\*\*/);
    assert.match(replies[0], /authorization=\*\*\*/);
    assert.doesNotMatch(replies[0], /quoted secret value|unterminated quoted auth value/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testSharedSensitiveRedactionKeepsRouteIDs() {
  const input = [
    "group 1107099585",
    "private 1602858215",
    "token=\"quoted secret value\":1",
    "authorization='unterminated quoted auth value:1",
    "Bearer bearer-secret-value:1",
    "api_key=plain-secret-value",
    "secret 是 natural-secret-value",
    `sk-${"abcdefghijklmnopqrstuvwxyz"}`
  ].join(",");
  const out = redactSecrets(input);
  assert.match(out, /group 1107099585/);
  assert.match(out, /private 1602858215/);
  assert.match(out, /token=\*\*\*:1/);
  assert.match(out, /authorization=\*\*\*:1/);
  assert.match(out, /Bearer \*\*\*:1/);
  assert.match(out, /api_key=\*\*\*/);
  assert.match(out, /secret 是 \*\*\*/);
  assert.match(out, /sk-\*\*\*/);
  assert.doesNotMatch(out, /quoted secret value|unterminated quoted auth value|bearer-secret-value|plain-secret-value|natural-secret-value|abcdefghijklmnopqrstuvwxyz/);

  const accessKey = ["access", "token"].join("_");
  const refreshKey = ["refresh", "token"].join("_");
  const clientSecretKey = ["client", "secret"].join("_");
  const authKey = ["auth", "token"].join("_");
  const botKey = ["bot", "token"].join("_");
  const sessionCookieKey = ["session", "cookie"].join("_");
  const privateKey = ["private", "key"].join("_");
  const objectOut = sharedMaskSensitive({
    group: 1107099585,
    group_id: 1107099585,
    private_user: 1602858215,
    token: "object-token-secret",
    api_key: "object-api-secret",
    [accessKey]: "object-access-secret",
    [refreshKey]: "object-refresh-secret",
    [clientSecretKey]: "object-client-secret",
    [authKey]: "object-auth-secret",
    [botKey]: "object-bot-secret",
    [sessionCookieKey]: "object-session-cookie-secret",
    [privateKey]: "object-private-key-secret",
    password: "object-password-secret",
    authorization: "Bearer object-bearer-secret",
    cookie: "object-cookie-secret",
    secret: "object-generic-secret"
  });
  assert.match(objectOut, /"group":1107099585/);
  assert.match(objectOut, /"group_id":1107099585/);
  assert.match(objectOut, /"private_user":1602858215/);
  assert.match(objectOut, /"token":"\*\*\*"/);
  assert.match(objectOut, /"api_key":"\*\*\*"/);
  assert.match(objectOut, new RegExp(`"${accessKey}":"\\*\\*\\*"`));
  assert.match(objectOut, new RegExp(`"${refreshKey}":"\\*\\*\\*"`));
  assert.match(objectOut, new RegExp(`"${clientSecretKey}":"\\*\\*\\*"`));
  assert.match(objectOut, new RegExp(`"${authKey}":"\\*\\*\\*"`));
  assert.match(objectOut, new RegExp(`"${botKey}":"\\*\\*\\*"`));
  assert.match(objectOut, new RegExp(`"${sessionCookieKey}":"\\*\\*\\*"`));
  assert.match(objectOut, new RegExp(`"${privateKey}":"\\*\\*\\*"`));
  assert.match(objectOut, /"password":"\*\*\*"/);
  assert.match(objectOut, /"authorization":"\*\*\*"/);
  assert.match(objectOut, /"cookie":"\*\*\*"/);
  assert.match(objectOut, /"secret":"\*\*\*"/);
  assert.strictEqual(sharedLooksSensitive({ [accessKey]: "object-access-secret", group: 1107099585 }), true);
  assert.strictEqual(sharedLooksSensitive({ group: 1107099585, message: "route metadata only" }), false);
  assert.doesNotMatch(objectOut, /object-token-secret|object-api-secret|object-access-secret|object-refresh-secret|object-client-secret|object-auth-secret|object-bot-secret|object-session-cookie-secret|object-private-key-secret|object-password-secret|object-bearer-secret|object-cookie-secret|object-generic-secret/);
}

function testSharedRedactionCoversCompositeKeyForms() {
  const keyParts = [
    ["auth", "token"],
    ["bot", "token"],
    ["session", "cookie"],
    ["private", "key"],
    ["client", "secret"],
    ["access", "token"],
    ["refresh", "token"]
  ];
  for (const parts of keyParts) {
    for (const sep of ["_", "-"]) {
      const key = parts.join(sep);
      const raw = `route group_id 1107099585,${key}=plain-hidden-value,${key}:"quoted hidden value",${key} 是 natural-hidden-value`;
      const out = redactSecrets(raw);
      assert.match(out, /group_id 1107099585/);
      assert.match(out, new RegExp(`${key}=\\*\\*\\*`));
      assert.match(out, new RegExp(`${key} 是 \\*\\*\\*`));
      assert.strictEqual(sharedLooksSensitive({ [key]: "object-hidden-value", group_id: 1107099585 }), true);
      const objectOut = sharedMaskSensitive({ [key]: "object-hidden-value", group_id: 1107099585 });
      assert.match(objectOut, /"group_id":1107099585/);
      assert.match(objectOut, new RegExp(`"${key}":"\\*\\*\\*"`));
      assert.doesNotMatch(objectOut, /object-hidden-value/);
      assert.doesNotMatch(out, /plain-hidden-value|quoted hidden value|natural-hidden-value/);
    }
  }
}

function testSharedRedactionCoversNestedObjects() {
  const apiTokenKey = ["api", "token"].join("-");
  const nestedOut = sharedMaskSensitive({
    group_id: 1107099585,
    payload: [
      {
        [apiTokenKey]: "nested-hidden-value",
        group_id: 1107099585
      }
    ]
  });
  assert.match(nestedOut, /"group_id":1107099585/);
  assert.match(nestedOut, new RegExp(`"${apiTokenKey}":"\\*\\*\\*"`));
  assert.strictEqual(sharedLooksSensitive({ payload: [{ [apiTokenKey]: "nested-hidden-value", group_id: 1107099585 }] }), true);
  assert.doesNotMatch(nestedOut, /nested-hidden-value/);
}

function testSharedRedactionCoversProviderEnvKeys() {
  const providerKeys = [
    ["OPENAI", "API", "KEY"],
    ["ANTHROPIC", "API", "KEY"],
    ["DASHSCOPE", "API", "KEY"],
    ["AZURE", "OPENAI", "API", "KEY"],
    ["GOOGLE", "GENERATIVE", "AI", "API", "KEY"]
  ].map((parts) => parts.join("_"));
  for (const key of providerKeys) {
    const objectOut = sharedMaskSensitive({ [key]: "provider-hidden-value", group_id: 1107099585 });
    assert.match(objectOut, /"group_id":1107099585/);
    assert.match(objectOut, new RegExp(`"${key}":"\\*\\*\\*"`));
    assert.strictEqual(sharedLooksSensitive({ [key]: "provider-hidden-value", group_id: 1107099585 }), true);
    assert.doesNotMatch(objectOut, /provider-hidden-value/);

    const rawOut = redactSecrets(`group_id 1107099585 ${key}=provider-hidden-value ${key}="quoted-provider-hidden-value"`);
    assert.match(rawOut, /group_id 1107099585/);
    assert.match(rawOut, new RegExp(`${key}=\\*\\*\\*`));
    assert.doesNotMatch(rawOut, /provider-hidden-value|quoted-provider-hidden-value/);

    const shellOut = redactSecrets(`group_id 1107099585 export ${key}=shell-hidden-value ${key} = spaced-hidden-value ${key}='single-quoted-hidden-value'`);
    assert.match(shellOut, /group_id 1107099585/);
    assert.match(shellOut, new RegExp(`${key}=\\*\\*\\*`));
    assert.doesNotMatch(shellOut, /shell-hidden-value|spaced-hidden-value|single-quoted-hidden-value/);
  }
}

function testSharedRedactionCorpusKeepsRoutesAndMasksSecrets() {
  const providerKey = ["AZURE", "OPENAI", "API", "KEY"].join("_");
  const apiTokenKey = ["api", "token"].join("-");
  const cases = [
    {
      name: "raw env",
      input: `group_id 1107099585 ${providerKey}=corpus-env-hidden`,
      objectInput: { group_id: 1107099585, [providerKey]: "corpus-env-hidden" },
      retained: [/group_id 1107099585/, new RegExp(`${providerKey}=\\*\\*\\*`)],
      objectRetained: [/"group_id":1107099585/, new RegExp(`"${providerKey}":"\\*\\*\\*"`)],
      leaked: /corpus-env-hidden/
    },
    {
      name: "shell export",
      input: `private 1602858215 export ${providerKey}='corpus-shell-hidden'`,
      objectInput: { private_user: 1602858215, [providerKey]: "corpus-shell-hidden" },
      retained: [/private 1602858215/, new RegExp(`${providerKey}=\\*\\*\\*`)],
      objectRetained: [/"private_user":1602858215/, new RegExp(`"${providerKey}":"\\*\\*\\*"`)],
      leaked: /corpus-shell-hidden/
    },
    {
      name: "json object",
      input: JSON.stringify({ group_id: 1107099585, [apiTokenKey]: "corpus-json-hidden" }),
      objectInput: { group_id: 1107099585, [apiTokenKey]: "corpus-json-hidden" },
      retained: [/"group_id":1107099585/, new RegExp(`"${apiTokenKey}":"\\*\\*\\*"`)],
      objectRetained: [/"group_id":1107099585/, new RegExp(`"${apiTokenKey}":"\\*\\*\\*"`)],
      leaked: /corpus-json-hidden/
    },
    {
      name: "natural language",
      input: "group 1107099585 token 是 corpus-natural-hidden",
      objectInput: { group_id: 1107099585, token: "corpus-natural-hidden" },
      retained: [/group 1107099585/, /token 是 \*\*\*/],
      objectRetained: [/"group_id":1107099585/, /"token":"\*\*\*"/],
      leaked: /corpus-natural-hidden/
    }
  ];
  for (const item of cases) {
    const out = redactSecrets(item.input);
    for (const pattern of item.retained) {
      assert.match(out, pattern, item.name);
    }
    assert.doesNotMatch(out, item.leaked, item.name);
    const masked = sharedMaskSensitive(item.objectInput);
    for (const pattern of item.objectRetained) {
      assert.match(masked, pattern, item.name);
    }
    assert.strictEqual(sharedLooksSensitive(item.objectInput), true, item.name);
    assert.doesNotMatch(masked, item.leaked, item.name);
  }
}

function testSharedRedactionRouteOnlyCorpusIsNotSensitive() {
  const cases = [
    {
      name: "group route",
      input: "group_id 1107099585 route listen=3002 at=3003",
      objectInput: { group_id: 1107099585, route: { listen: 3002, at: 3003 } },
      retained: [/1107099585/, /3002/, /3003/]
    },
    {
      name: "admin private route",
      input: "private_user 1602858215 admin root route project_root",
      objectInput: { private_user: 1602858215, admin_route: "project_root", root_enabled: true },
      retained: [/1602858215/, /project_root/]
    },
    {
      name: "known users",
      input: "allowed_private_users 1602858215 2138730775 allowed_groups 1107099585",
      objectInput: { allowed_private_users: [1602858215, 2138730775], allowed_groups: [1107099585] },
      retained: [/1602858215/, /2138730775/, /1107099585/]
    }
  ];
  for (const item of cases) {
    assert.strictEqual(redactSecrets(item.input), item.input, item.name);
    assert.strictEqual(sharedLooksSensitive(item.objectInput), false, item.name);
    const masked = sharedMaskSensitive(item.objectInput);
    assert.strictEqual(masked, JSON.stringify(item.objectInput), item.name);
    for (const pattern of item.retained) {
      assert.match(masked, pattern, item.name);
    }
    assert.doesNotMatch(masked, /\*\*\*/, item.name);
  }
}

function testSharedRedactionCoversMemoryProposalTodoOutputs() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-shared-redaction-"));
  try {
    savePendingCandidates({
      workspace: temp,
      scope: "group",
      scopeID: "1107099585",
      candidates: [{
        user: "Alice",
        user_id: "1",
        kind: "note",
        tags: [],
        text: "route 1107099585 token=\"quoted secret value\"",
        time: "2026-05-24T09:00:00.000Z"
      }]
    });
    const commands = createProxyCommands(baseCommandDeps({
      replies,
      workspaceForGroup: () => temp,
      allowedGroups: [1107099585],
      atOnlyGroups: []
    }));

    commands.handleProxyCommand({ message_type: "group", group_id: 1107099585, user_id: 1, message_id: 2, raw_message: "/候选记忆 分拣" });
    assert.match(replies.at(-1), /route 1107099585 token=\*\*\*/);
    assert.doesNotMatch(replies.at(-1), /quoted secret value/);

    commands.handleProxyCommand({ message_type: "group", group_id: 1107099585, user_id: 1, message_id: 3, raw_message: "/建议箱 add 路由建议 | route 1107099585 Bearer bearer-secret-value" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1107099585, user_id: 1, message_id: 4, raw_message: "/建议箱 导出 all" });
    assert.match(replies.at(-1), /route 1107099585 Bearer \*\*\*/);
    assert.doesNotMatch(replies.at(-1), /bearer-secret-value/);

    commands.handleProxyCommand({ message_type: "group", group_id: 1107099585, user_id: 1, message_id: 5, raw_message: "/待办 add route 1107099585 secret 是 natural-secret-value" });
    commands.handleProxyCommand({ message_type: "group", group_id: 1107099585, user_id: 1, message_id: 6, raw_message: "/待办" });
    assert.match(replies.at(-1), /route 1107099585 secret 是 \*\*\*/);
    assert.doesNotMatch(replies.at(-1), /natural-secret-value/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testRecentFilesCommandUsesStructuredIndex() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-file-index-command-"));
  try {
    addFileIndex({
      workspace: temp,
      scope: "group",
      scopeID: "171290904",
      userID: "1",
      name: "lecture.txt",
      originalName: "lecture.txt",
      relativePath: "local_files/archive/2026-05-23/lecture.txt",
      size: 12,
      parser: "text",
      extractedPath: "local_files/archive/2026-05-23/lecture.txt.archive/extracted.txt"
    });
    const deps = baseCommandDeps({ replies, workspaceForGroup: () => temp });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/最近文件" });
    assert.match(replies[0], /最近文件/);
    assert.match(replies[0], /lecture.txt/);
    assert.match(replies[0], /已提取/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testFileStatsCountsIndexOnlyAndBadLines() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-file-stats-"));
  try {
    addFileIndex({
      workspace: temp,
      scope: "group",
      scopeID: "171290904",
      name: "a.pdf",
      relativePath: "local_files/archive/a.pdf",
      size: 1024,
      parser: "pdf-parse",
      extractedPath: "local_files/archive/a.pdf.archive/extracted.txt"
    });
    addFileIndex({
      workspace: temp,
      scope: "group",
      scopeID: "171290904",
      name: "b.txt",
      relativePath: "local_files/archive/b.txt",
      size: 2048,
      parser: "text",
      status: "parse_failed"
    });
    ensureDir(path.join(temp, "local_files", "archive"));
    fs.writeFileSync(path.join(temp, "local_files", "archive", "secret.txt"), "token=SHOULD_NOT_LEAK", "utf8");
    fs.appendFileSync(path.join(temp, "local_files", "file-index.jsonl"), "{bad token=SHOULD_NOT_LEAK}\n", "utf8");

    const stats = fileStats({ workspace: temp });
    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.bad_lines, 1);
    assert.strictEqual(stats.total_size, 3072);
    assert.strictEqual(stats.extracted, 1);
    assert.strictEqual(stats.byExt[".pdf"], 1);
    assert.strictEqual(stats.byExt[".txt"], 1);
    assert.strictEqual(stats.byParser["pdf-parse"], 1);
    assert.strictEqual(stats.byParser.text, 1);
    assert.strictEqual(stats.byStatus.archived, 1);
    assert.strictEqual(stats.byStatus.parse_failed, 1);
    const text = formatFileStats(stats);
    assert.match(text, /文件状态/);
    assert.match(text, /已索引：2/);
    assert.match(text, /坏行：1/);
    assert.match(text, /总大小：3\.0KB/);
    assert.match(text, /已提取文本：1/);
    assert.doesNotMatch(text, /SHOULD_NOT_LEAK/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testLocalFileStatusCommandUsesCurrentWorkspaceOnly() {
  const replies = [];
  const groupA = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-file-status-a-"));
  const groupB = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-file-status-b-"));
  try {
    addFileIndex({
      workspace: groupA,
      scope: "group",
      scopeID: "1",
      name: "group-a.pdf",
      relativePath: "local_files/archive/group-a.pdf",
      size: 1024,
      parser: "pdf-parse"
    });
    addFileIndex({
      workspace: groupB,
      scope: "group",
      scopeID: "2",
      name: "group-b.txt",
      relativePath: "local_files/archive/group-b.txt",
      size: 512,
      parser: "text"
    });
    let sharedCalled = false;
    const deps = baseCommandDeps({
      replies,
      workspaceForGroup: (groupID) => Number(groupID) === 1 ? groupA : groupB,
      allowedGroups: [1, 2],
      atOnlyGroups: []
    });
    process.env.OPENCLAW_COMMAND_SCRIPT = "__missing_shared_script__";
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 2, raw_message: "/文件" });
    assert.match(replies.at(-1), /文件状态/);
    assert.match(replies.at(-1), /已索引：1/);
    assert.match(replies.at(-1), /group-a\.pdf/);
    assert.doesNotMatch(replies.at(-1), /group-b\.txt/);
    assert.strictEqual(sharedCalled, false);

    commands.handleProxyCommand({ message_type: "group", group_id: 2, user_id: 1, message_id: 3, raw_message: "/文件 状态" });
    assert.match(replies.at(-1), /group-b\.txt/);
    assert.doesNotMatch(replies.at(-1), /group-a\.pdf/);

    commands.handleProxyCommand({ message_type: "group", group_id: 1, user_id: 1, message_id: 4, raw_message: "/help 文件" });
    assert.match(replies.at(-1), /\/文件/);
    assert.match(replies.at(-1), /\/最近文件/);
  } finally {
    delete process.env.OPENCLAW_COMMAND_SCRIPT;
    fs.rmSync(groupA, { recursive: true, force: true });
    fs.rmSync(groupB, { recursive: true, force: true });
  }
}

function testLocalFileStatusEmptyWorkspaceIsStable() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-file-status-empty-"));
  try {
    const deps = baseCommandDeps({ replies, workspaceForPrivateUser: () => temp });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "private", user_id: 1, message_id: 2, raw_message: "/文件 状态" });
    assert.match(replies.at(-1), /文件状态/);
    assert.match(replies.at(-1), /已索引：0/);
    assert.match(replies.at(-1), /坏行：0/);
    assert.match(replies.at(-1), /最新文件：暂无/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testFindFilesPrefersStructuredIndexAndToleratesBadLine() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-file-index-find-"));
  try {
    addFileIndex({
      workspace: temp,
      scope: "group",
      scopeID: "171290904",
      name: "quantum-notes.pdf",
      originalName: "量子笔记.pdf",
      relativePath: "local_files/archive/2026-05-23/quantum-notes.pdf",
      size: 2048,
      parser: "pdf-parse"
    });
    fs.appendFileSync(path.join(temp, "local_files", "file-index.jsonl"), "{bad json}\n", "utf8");
    appendLine(path.join(temp, "local_files", "INDEX.md"), "- legacy quantum file");
    const deps = baseCommandDeps({ replies, workspaceForGroup: () => temp });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/找文件 quantum" });
    assert.match(replies[0], /找到这些文件/);
    assert.match(replies[0], /quantum-notes.pdf/);
    assert.doesNotMatch(replies[0], /legacy quantum file/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testAdminCommandRequiresRootAdmin() {
  const replies = [];
  const deps = baseCommandDeps({ replies, adminRootUsers: [1602858215], adminUsers: [1602858215] });
  const commands = createProxyCommands(deps);
  commands.handleProxyCommand({ message_type: "private", user_id: 1, message_id: 2, raw_message: "/admin status" });
  assert.strictEqual(replies[0], "没有权限。");
}

function testAdminWorkspaceSeparatesMemoryAndExecutionRoot() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-admin-"));
  try {
    const memoryDir = path.join(temp, "users", "1602858215");
    const rootDir = temp;
    const deps = baseCommandDeps({
      replies,
      adminRootUsers: [1602858215],
      adminUsers: [1602858215],
      projectRoot: rootDir,
      workspaceForPrivateUser: () => memoryDir,
      executionWorkspaceForPrivateUser: () => rootDir,
      appendLine
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "private", user_id: 1602858215, message_id: 2, raw_message: "/admin workspace" });
    assert.match(replies[0], /管理员工作区/);
    assert.match(replies[0], /记忆目录/);
    assert.match(replies[0], /执行目录/);
    assert.match(replies[0], /1602858215/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testAdminPrivateRememberUsesUserWorkspaceNotExecutionRoot() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-admin-memory-"));
  try {
    const memoryDir = path.join(temp, "users", "1602858215");
    const rootDir = temp;
    const deps = baseCommandDeps({
      replies,
      adminRootUsers: [1602858215],
      adminUsers: [1602858215],
      projectRoot: rootDir,
      workspaceForPrivateUser: () => memoryDir,
      executionWorkspaceForPrivateUser: () => rootDir,
      appendLine
    });
    const commands = createProxyCommands(deps);
    const msg = {
      message_type: "private",
      user_id: 1602858215,
      message_id: 2,
      raw_message: "/记住 我喜欢普通聊天也保留私聊记忆"
    };

    commands.handleProxyCommand(msg);
    assert.strictEqual(replies.at(-1), "已记住。");

    const userMemoryFile = path.join(memoryDir, "memory", "memories.jsonl");
    const rootMemoryFile = path.join(rootDir, "memory", "memories.jsonl");
    const userProfileFile = path.join(memoryDir, "PROFILE.md");
    const rootProfileFile = path.join(rootDir, "PROFILE.md");
    assert.ok(fs.existsSync(userMemoryFile));
    assert.strictEqual(fs.existsSync(rootMemoryFile), false);
    assert.ok(fs.existsSync(userProfileFile));
    assert.strictEqual(fs.existsSync(rootProfileFile), false);
    const rows = fs.readFileSync(userMemoryFile, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].scope, "private");
    assert.strictEqual(rows[0].scope_id, "1602858215");
    assert.strictEqual(rows[0].subject_id, "1602858215");
    assert.match(fs.readFileSync(userProfileFile, "utf8"), /普通聊天也保留私聊记忆/);

    commands.handleProxyCommand({ ...msg, message_id: 3, raw_message: "/记忆 私聊记忆" });
    assert.match(replies.at(-1), /结构化记忆/);
    assert.match(replies.at(-1), /普通聊天也保留私聊记忆/);
    commands.handleProxyCommand({ ...msg, message_id: 4, raw_message: "/画像 私聊记忆" });
    assert.match(replies.at(-1), /当前个人画像/);
    assert.match(replies.at(-1), /普通聊天也保留私聊记忆/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testAdminPrivateMemorySearchUsesUserWorkspaceForSharedCommand() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-admin-memory-search-"));
  const oldScript = process.env.OPENCLAW_COMMAND_SCRIPT;
  const oldRoot = process.env.OPENCLAW_COMMAND_ROOT;
  const oldPython = process.env.OPENCLAW_COMMAND_PYTHON;
  try {
    const memoryDir = path.join(temp, "users", "1602858215");
    const script = path.join(temp, "capture-shared-command.js");
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));", "utf8");
    process.env.OPENCLAW_COMMAND_SCRIPT = script;
    process.env.OPENCLAW_COMMAND_ROOT = temp;
    process.env.OPENCLAW_COMMAND_PYTHON = process.execPath;
    const deps = baseCommandDeps({
      replies,
      adminRootUsers: [1602858215],
      adminUsers: [1602858215],
      projectRoot: temp,
      workspaceForPrivateUser: () => memoryDir,
      executionWorkspaceForPrivateUser: () => temp
    });
    const commands = createProxyCommands(deps);

    commands.handleProxyCommand({
      message_type: "private",
      user_id: 1602858215,
      message_id: 2,
      raw_message: "/记忆 search 私聊记忆"
    });

    const args = JSON.parse(replies.at(-1));
    const userWorkspaceName = ["users", "1602858215"].join("/");
    assert.deepStrictEqual(args.slice(0, 4), ["--root", temp, "--workspace", userWorkspaceName]);
    assert.deepStrictEqual(args.slice(4), ["/memory", "search", "私聊记忆"]);
  } finally {
    restoreEnv("OPENCLAW_COMMAND_SCRIPT", oldScript);
    restoreEnv("OPENCLAW_COMMAND_ROOT", oldRoot);
    restoreEnv("OPENCLAW_COMMAND_PYTHON", oldPython);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testSharedCommandWorkspaceNameNormalization() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-shared-workspace-"));
  const oldScript = process.env.OPENCLAW_COMMAND_SCRIPT;
  const oldRoot = process.env.OPENCLAW_COMMAND_ROOT;
  const oldPython = process.env.OPENCLAW_COMMAND_PYTHON;
  try {
    const script = path.join(temp, "capture-shared-command.js");
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));", "utf8");
    process.env.OPENCLAW_COMMAND_SCRIPT = script;
    process.env.OPENCLAW_COMMAND_ROOT = temp;
    process.env.OPENCLAW_COMMAND_PYTHON = process.execPath;
    const groupWorkspace = path.join(temp, "groups", "171290904");
    const sandboxGroupWorkspace = path.join(temp, "groups", "sandbox-171290904");
    const privateWorkspace = path.join(temp, "users", "1602858215");
    const customWorkspace = path.join(temp, "custom-private");
    let currentGroupWorkspace = groupWorkspace;
    const deps = baseCommandDeps({
      replies,
      projectRoot: temp,
      workspaceForGroup: () => currentGroupWorkspace,
      workspaceForPrivateUser: (userID) => Number(userID) === 1602858215 ? privateWorkspace : customWorkspace
    });
    const commands = createProxyCommands(deps);

    commands.handleProxyCommand({ message_type: "group", group_id: 171290904, user_id: 1, message_id: 2, raw_message: "/记忆 search 群记忆" });
    let args = JSON.parse(replies.at(-1));
    assert.deepStrictEqual(args.slice(0, 4), ["--root", temp, "--workspace", ["groups", "171290904"].join("/")]);

    currentGroupWorkspace = sandboxGroupWorkspace;
    commands.handleProxyCommand({ message_type: "group", group_id: 171290904, user_id: 1, message_id: 5, raw_message: "/记忆 search 沙盒群记忆" });
    args = JSON.parse(replies.at(-1));
    assert.deepStrictEqual(args.slice(0, 4), ["--root", temp, "--workspace", ["groups", "sandbox-171290904"].join("/")]);

    commands.handleProxyCommand({ message_type: "private", user_id: 1602858215, message_id: 3, raw_message: "/记忆 search 私聊记忆" });
    args = JSON.parse(replies.at(-1));
    assert.deepStrictEqual(args.slice(0, 4), ["--root", temp, "--workspace", ["users", "1602858215"].join("/")]);

    commands.handleProxyCommand({ message_type: "private", user_id: 42, message_id: 4, raw_message: "/记忆 search 自定义目录" });
    args = JSON.parse(replies.at(-1));
    assert.deepStrictEqual(args.slice(0, 4), ["--root", temp, "--workspace", "custom-private"]);
  } finally {
    restoreEnv("OPENCLAW_COMMAND_SCRIPT", oldScript);
    restoreEnv("OPENCLAW_COMMAND_ROOT", oldRoot);
    restoreEnv("OPENCLAW_COMMAND_PYTHON", oldPython);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testAdminModeCanChangeGroupFromPrivateChat() {
  const replies = [];
  const listenModeByGroup = new Map();
  const deps = baseCommandDeps({
    replies,
    adminRootUsers: [1602858215],
    adminUsers: [1602858215],
    allowedGroups: [1107099585],
    atOnlyGroups: [],
    listenModeByGroup,
    workspaceForGroup: () => fs.mkdtempSync(path.join(os.tmpdir(), "proxy-admin-mode-")),
    appendLine
  });
  const commands = createProxyCommands(deps);
  commands.handleProxyCommand({ message_type: "private", user_id: 1602858215, message_id: 2, raw_message: "/admin mode 1107099585 all" });
  assert.strictEqual(listenModeByGroup.get(1107099585), "all");
  assert.match(replies[0], /已切换群 1107099585/);
}

function testAdminRoutesShowPortMaps() {
  const replies = [];
  const deps = baseCommandDeps({
    replies,
    adminRootUsers: [1602858215],
    adminUsers: [1602858215],
    groupRoutes: new Map([[1107099585, { listenPort: 3002, atPort: 3003 }]]),
    privateRoutes: new Map([[1602858215, { port: 3011 }]])
  });
  const commands = createProxyCommands(deps);
  commands.handleProxyCommand({ message_type: "private", user_id: 1602858215, message_id: 2, raw_message: "/admin routes" });
  assert.match(replies[0], /群路由/);
  assert.match(replies[0], /1107099585:3002:3003/);
  assert.match(replies[0], /1602858215:3011/);
}

function testAdminTailReadsOnlyNamedLogsAndMasks() {
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-admin-tail-"));
  try {
    const logFile = path.join(temp, "onebot.log");
    fs.writeFileSync(logFile, `ok\nOPENAI_API_KEY=${"sk-"}real-secret\n`, "utf8");
    const deps = baseCommandDeps({
      replies,
      adminRootUsers: [1602858215],
      adminUsers: [1602858215],
      adminLogFiles: { onebot: logFile },
      maskSensitive: (value) => String(value).replace(/sk-[a-z0-9-]+/gi, "sk-***")
    });
    const commands = createProxyCommands(deps);
    commands.handleProxyCommand({ message_type: "private", user_id: 1602858215, message_id: 2, raw_message: "/admin tail onebot 10" });
    assert.match(replies[0], /onebot 日志尾部/);
    assert.match(replies[0], /sk-\*\*\*/);
    assert.doesNotMatch(replies[0], /sk-real-secret/);
    commands.handleProxyCommand({ message_type: "private", user_id: 1602858215, message_id: 3, raw_message: "/admin tail ..\\/secret" });
    assert.match(replies[1], /日志名无效/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testAdminReloadCallsRuntimeHook() {
  const replies = [];
  let called = false;
  const deps = baseCommandDeps({
    replies,
    adminRootUsers: [1602858215],
    adminUsers: [1602858215],
    reloadRuntime: () => {
      called = true;
      return "reloaded";
    }
  });
  const commands = createProxyCommands(deps);
  commands.handleProxyCommand({ message_type: "private", user_id: 1602858215, message_id: 2, raw_message: "/admin reload" });
  assert.strictEqual(called, true);
  assert.strictEqual(replies[0], "reloaded");
}

function testDreamPromptsKeepSelfIterationBounded() {
  const required = [
    /Do not auto-edit production code\./,
    /Do not apply patches generated by (this|the same) dream pass\./,
    /Do not touch secrets, env files, tokens, cookies/,
    /Do not enable cross-group search by default\./,
    /Do not restart, reload, deploy/,
    /always-on vector databases/,
    /per-message LLM summaries/,
    /recursive review loops/,
    /NapCat\/OneBot[\s\S]*onebot-group-proxy[\s\S]*cc-connect[\s\S]*local groups\/users workspaces/,
    /[Cc]andidate patches/,
    /[Tt]est suggestions/
  ];
  const promptPaths = [
    path.join(__dirname, "..", "groups", "sandbox-1107099585", "scripts", "dream_prompt.md"),
    path.join(__dirname, "..", "groups", "sandbox-171290904", "scripts", "dream_prompt.md"),
    path.join(__dirname, "..", "docs", "dream-review-template.md")
  ];

  for (const promptPath of promptPaths) {
    const text = fs.readFileSync(promptPath, "utf8");
    for (const pattern of required) {
      assert.match(text, pattern, `${promptPath} missing ${pattern}`);
    }
  }
}

function testGroupUploadRequestsDownload() {
  const sent = [];
  const replies = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-files-upload-"));
  try {
    const files = createProxyFiles({
      workspaceForGroup: () => temp,
      appendLine,
      todayLocal: () => "2026-05-23",
      pendingFileDownloads: new Map(),
      sendUpstream: (obj) => sent.push(obj),
      sendGroupText: (_groupID, _messageID, text) => replies.push(text),
      safeName,
      ensureDir,
      extractPdfText: async () => "",
      buildFileSummary: () => "",
      log: () => {}
    });

    files.handleGroupUpload({
      group_id: 171290904,
      user_id: 1,
      message_id: 2,
      file: { id: "file-1", name: "lecture.pdf", size: 12 }
    });

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].action, "get_file");
    assert.strictEqual(sent[0].params.file_id, "file-1");
    assert.strictEqual(replies.length, 1);
    assert.match(replies[0], /正在自动下载归档/);
    assert.strictEqual(files.stats.group_uploads, 1);
    assert.strictEqual(files.stats.download_requests, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function testGroupFileDownloadArchivesText() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-files-archive-"));
  const source = path.join(temp, "source.txt");
  fs.writeFileSync(source, "第一章\n重点内容\n", "utf8");
  const replies = [];
  try {
    const files = createProxyFiles({
      workspaceForGroup: () => temp,
      appendLine,
      todayLocal: () => "2026-05-23",
      pendingFileDownloads: new Map(),
      sendUpstream: () => {},
      sendGroupText: (_groupID, _messageID, text) => replies.push(text),
      safeName,
      ensureDir,
      extractPdfText: async () => "",
      buildFileSummary: (_saved, text) => `# Summary\n\n${text}`,
      log: () => {}
    });

    const archived = files.handleGroupFileDownloadResponse({
      groupID: 171290904,
      fileName: "source.txt",
      messageID: 2,
      fileInfo: { name: "source.txt" }
    }, { data: { path: source } });
    await waitFor(() => replies.length === 1);

    assert.strictEqual(archived, true);
    assert.strictEqual(files.stats.archived, 1);
    assert.strictEqual(files.stats.parse_success, 1);
    assert.match(replies[0], /已提取文本/);
    assert.ok(fs.existsSync(path.join(temp, "local_files", "archive", "2026-05-23", "source.txt.archive", "extracted.txt")));
    const indexRows = fs.readFileSync(path.join(temp, "local_files", "file-index.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(indexRows.length, 1);
    assert.strictEqual(indexRows[0].parser, "text");
    assert.strictEqual(indexRows[0].status, "archived");
    assert.match(indexRows[0].extracted_path, /extracted\.txt$/);
    assert.doesNotMatch(indexRows[0].relative_path, /^[A-Za-z]:\\/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${line}\n`, "utf8");
}

function baseCommandDeps(overrides = {}) {
  const replies = overrides.replies || [];
  return {
    messageText: (msg) => msg.raw_message || "",
    sendPrivateText: (_userID, _messageID, text) => replies.push(text),
    sendGroupText: (_groupID, _messageID, text) => replies.push(text),
    healthSnapshot: () => ({ ok: true, upstream: { ready: true }, pending: { upstream_queue: 0, outbound: 0 } }),
    imageStateKey: () => "group:171290904",
    imageStates: new Map(),
    effectiveListenMode: () => "mention",
    defaultListenMode: "selective",
    atOnlyGroups: overrides.atOnlyGroups || [171290904],
    isGroupQuiet: () => false,
    adminUsers: overrides.adminUsers || [],
    adminRootUsers: overrides.adminRootUsers || [],
    allowedGroups: overrides.allowedGroups || [171290904],
    allowedPrivateUsers: overrides.allowedPrivateUsers || [],
    workspaceForGroup: overrides.workspaceForGroup || (() => process.cwd()),
    workspaceForPrivateUser: overrides.workspaceForPrivateUser || (() => process.cwd()),
    executionWorkspaceForPrivateUser: overrides.executionWorkspaceForPrivateUser || overrides.workspaceForPrivateUser || (() => process.cwd()),
    projectRoot: overrides.projectRoot || process.cwd(),
    ensureGroupProfile: () => {},
    ensurePrivateProfile: () => {},
    appendLine: overrides.appendLine || (() => {}),
    memberProfilePath: overrides.memberProfilePath || (() => ""),
    removeLinesContaining: () => 0,
    todayLocal: overrides.todayLocal || (() => "2026-05-23"),
    quietUntilByGroup: new Map(),
    persistProxyState: () => {},
    pending: [],
    pendingOutbound: new Map(),
    pendingFileDownloads: new Map(),
    listenStates: new Map(),
    botReplyRoutes: new Map(),
    listenModeByGroup: overrides.listenModeByGroup || new Map(),
    maskSensitive: overrides.maskSensitive || ((value) => value),
    groupRoutes: overrides.groupRoutes || new Map(),
    privateRoutes: overrides.privateRoutes || new Map(),
    adminLogFiles: overrides.adminLogFiles || {},
    reloadRuntime: overrides.reloadRuntime,
    recentErrorFile: overrides.recentErrorFile || "",
    capabilitySnapshot: overrides.capabilitySnapshot || (() => null)
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(value) {
  return String(value || "unknown").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 80);
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function waitFor(predicate) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for async file archive");
}

testAtOnlyRequiredPorts();
testMetricsTextIncludesOperationalCounters();
testLatexDisplayDelimitersRenderAsImageAndCleanText();
testAdminPokeAckUsesNapCatPokeAction();
testProfileContextPreservesImageSegment();
testMfaceIsNormalizedToImageWhenUrlExists();
testQuotedImageIsForwardedWhenUserRepliesToImage();
testRawCQImageAndStickerAreNormalized();
testInvalidProxyStateIsQuarantinedAndReset();
testAtOnlyModeCommandCannotEnableAll();
testProfileCommandShowsGroupAndMemberFacts();
testStatusShowsCapabilities();
testHelpIndexFiltersByContextAndKeyword();
testRememberSearchAndForgetStructuredMemory();
testDuplicateRememberIsDeterministicallySkippedAndStatsWork();
testPrivateMemoryDoesNotSearchOtherWorkspace();
testRecentMemoriesAreScopedSortedLimitedAndMasked();
testRecentMemoriesPrivateSubjectIsolationAndEmptyState();
testMemoryEvidenceShowsSourceAndPendingCandidates();
testMemoryRulesAndPreflightAreDeterministicAndMasked();
testMemoryEvidenceExcludesDeletedAndPrivateOtherWorkspace();
testProposalBoxAddListSearchShowAndStatus();
testProposalBoxDoesNotCrossWorkspace();
testProposalBoxDeduplicatesWithinWorkspaceOnly();
testProposalExportSummarizesCurrentWorkspaceWithoutMutating();
testProposalCheckPreflightsCurrentWorkspaceOnly();
testProposalLinksAreWorkspaceScopedDedupedAndMasked();
testProposalRoundPicksSafeAcceptedWithoutMutating();
testProposalLandCreatesTodoOnceAndMarksDone();
testProposalLandDoesNotCrossWorkspace();
testProposalLandableListsAcceptedNotYetTodo();
testProposalExecutionGateBlocksRiskyAcceptedProposals();
testProposalExecutionGateChecksRiskyLinks();
testProposalLandableDoesNotCrossWorkspace();
testTodoCommandAddListDoneAndStats();
testTodoCommandWorkspaceIsolationAndDoneByID();
testTodoDoneListSortedLimitedMaskedAndScoped();
testTodoSearchKeepsGlobalActiveIndexesAndExplicitAddSemantics();
testTodoSearchDoesNotCrossWorkspace();
testTodoCandidatesUseFilteredIndexesAndDoNotWriteMemories();
testTodoCandidateApplyAllDoesNotAffectOtherWorkspace();
testWorkspaceOverviewSummarizesCurrentWorkspaceOnly();
testPrivateWorkspaceOverviewIsStableOnEmptyWorkspace();
testWorkspaceHealthSummarizesCurrentWorkspaceOnly();
testWorkspaceReviewPacketIsScopedAndCompact();
testWorkspaceReviewPacketPreservesRouteIDsAndMasksSecrets();
testPolicyDriftScannerFindsBoundaryDrift();
testPolicyDriftScannerAllowsCurrentBoundaryLanguage();
testPolicyDriftCommandWorks();
testTodaySummaryShowsMemoryCandidatesWithoutSecrets();
testPendingMemoryCanBeListedAndAppliedOnce();
testPendingMemoryCanBeSkippedAndStatsWork();
testPendingMemoryHealthSummarizesAnomaliesAndStaysScoped();
testPendingMemoryTriageSuggestsCommandsWithoutWriting();
testPendingMemorySnapshotShowsStableIDsAndStaysScoped();
testPendingMemorySnapshotCompareDetectsChangesAndStaysScoped();
testPendingMemorySnapshotDiffUsesCachedSnapshot();
testPendingMemorySnapshotDiffDoesNotCrossWorkspace();
testProcessPendingMemoryBatchUsesSingleSnapshot();
testProcessPendingMemoryBatchDoesNotCrossWorkspace();
testPendingMemorySearchPreservesGlobalActiveIndexes();
testPendingMemorySearchDoesNotCrossWorkspace();
testSkipAllDoesNotAffectOtherWorkspace();
testSharedSensitiveRedactionKeepsRouteIDs();
testSharedRedactionCoversCompositeKeyForms();
testSharedRedactionCoversNestedObjects();
testSharedRedactionCoversProviderEnvKeys();
testSharedRedactionCorpusKeepsRoutesAndMasksSecrets();
testSharedRedactionRouteOnlyCorpusIsNotSensitive();
testSharedRedactionCoversMemoryProposalTodoOutputs();
testRecentErrorsCommandUsesStructuredFile();
testRecentFilesCommandUsesStructuredIndex();
testFileStatsCountsIndexOnlyAndBadLines();
testLocalFileStatusCommandUsesCurrentWorkspaceOnly();
testLocalFileStatusEmptyWorkspaceIsStable();
testFindFilesPrefersStructuredIndexAndToleratesBadLine();
testAdminCommandRequiresRootAdmin();
testAdminWorkspaceSeparatesMemoryAndExecutionRoot();
testAdminPrivateRememberUsesUserWorkspaceNotExecutionRoot();
testAdminPrivateMemorySearchUsesUserWorkspaceForSharedCommand();
testSharedCommandWorkspaceNameNormalization();
testAdminModeCanChangeGroupFromPrivateChat();
testAdminRoutesShowPortMaps();
testAdminTailReadsOnlyNamedLogsAndMasks();
testAdminReloadCallsRuntimeHook();
testDreamPromptsKeepSelfIterationBounded();
testGroupUploadRequestsDownload();
testGroupFileDownloadArchivesText().then(() => {
  console.log("onebot proxy unit checks ok");
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
