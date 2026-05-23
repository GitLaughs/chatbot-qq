const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHealthSnapshot, createMetricsText } = require("./lib/proxy-health");
const { createProxyCommands } = require("./lib/proxy-commands");
const { createProxyFiles } = require("./lib/proxy-files");
const { loadProxyState } = require("./lib/proxy-state");
const { shouldRenderAsImage, renderForQQ, enrichMessageForAgent, messageText, normalizeVisualSegments } = require("./onebot-group-proxy");

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

function testMetricsTextIncludesOperationalCounters() {
  const text = createMetricsText({
    ok: true,
    upstream: { ready: true },
    ports: { 3002: true, 3005: true },
    required_ports: [3002, 3005],
    pending: { upstream_queue: 2, file_downloads: 1 },
    files: { group_uploads: 3, parse_failed: 1 },
    listen: { "17***04": { busy: false, queued: 0 } },
    image_jobs: { "group:17***04": { active: 1, queued: 2 } }
  });

  assert.match(text, /chatbot_qq_up 1/);
  assert.match(text, /chatbot_qq_port_connected\{port="3002"\} 1/);
  assert.match(text, /chatbot_qq_pending_file_downloads 1/);
  assert.match(text, /chatbot_qq_files_group_uploads 3/);
  assert.match(text, /chatbot_qq_files_parse_failed 1/);
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
    group_id: 100000001,
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
    group_id: 100000001,
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
    group_id: 100000001,
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
      imageStateKey: () => "group:100000002",
      imageStates: new Map(),
      effectiveListenMode: () => "mention",
      defaultListenMode: "selective",
      atOnlyGroups: [100000002],
      isGroupQuiet: () => false,
      adminUsers: [],
      allowedGroups: [100000002],
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
    const msg = { message_type: "group", group_id: 100000002, user_id: 1, message_id: 2, raw_message: "/画像" };

    assert.strictEqual(commands.isProxyCommand(msg), true);
    commands.handleProxyCommand(msg);
    assert.match(replies[0], /当前画像/);
    assert.match(replies[0], /默认短答/);
    assert.match(replies[0], /步骤化说明/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
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
      group_id: 100000002,
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
      groupID: 100000002,
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
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${line}\n`, "utf8");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(value) {
  return String(value || "unknown").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 80);
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
testProfileContextPreservesImageSegment();
testMfaceIsNormalizedToImageWhenUrlExists();
testQuotedImageIsForwardedWhenUserRepliesToImage();
testRawCQImageAndStickerAreNormalized();
testInvalidProxyStateIsQuarantinedAndReset();
testAtOnlyModeCommandCannotEnableAll();
testProfileCommandShowsGroupAndMemberFacts();
testGroupUploadRequestsDownload();
testGroupFileDownloadArchivesText().then(() => {
  console.log("onebot proxy unit checks ok");
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
