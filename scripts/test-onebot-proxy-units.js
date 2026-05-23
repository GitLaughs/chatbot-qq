const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHealthSnapshot, createMetricsText } = require("./lib/proxy-health");
const { createProxyCommands } = require("./lib/proxy-commands");
const { createProxyFiles } = require("./lib/proxy-files");

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
testAtOnlyModeCommandCannotEnableAll();
testGroupUploadRequestsDownload();
testGroupFileDownloadArchivesText().then(() => {
  console.log("onebot proxy unit checks ok");
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
