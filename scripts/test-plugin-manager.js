const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { createPluginManager, validateManifest, validateSettings } = require("./lib/plugin-manager");
const { createCapabilitySnapshot, formatCapabilitySummary } = require("./lib/capabilities");
const { createProxyCommands } = require("./lib/proxy-commands");

function testDefaultsAndSettings() {
  const manager = createPluginManager({
    plugins: [
      { id: "image", enabled: true, settings: { triggers: ["/img"], queue_max_per_group: 2 } },
    ],
  });

  assert.strictEqual(manager.enabled("image"), true);
  assert.deepStrictEqual(manager.settings("image"), { triggers: ["/img"], queue_max_per_group: 2 });
  assert.strictEqual(manager.enabled("missing"), false);
}

function testConfigOverrideAndScopes() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-manager-"));
  const config = path.join(temp, "plugins.json");
  try {
    fs.writeFileSync(config, JSON.stringify({
      plugins: {
        image: {
          enabled: true,
          settings: { triggers: ["/draw"] },
          groups: { allow: ["123456789"], deny: ["234567890"] },
          private_users: { deny: ["42"] },
        },
        dream: { enabled: false },
      },
    }), "utf8");

    const manager = createPluginManager({
      configFiles: [config],
      plugins: [
        { id: "image", enabled: true, settings: { triggers: ["/img"], queue_max_per_group: 2 } },
        { id: "dream", enabled: true },
      ],
    });

    assert.strictEqual(manager.enabled("image", { groupID: 123456789 }), true);
    assert.strictEqual(manager.enabled("image", { groupID: 234567890 }), false);
    assert.strictEqual(manager.enabled("image", { userID: 42 }), false);
    assert.strictEqual(manager.enabled("dream", { groupID: 123456789 }), false);
    assert.deepStrictEqual(manager.settings("image"), { triggers: ["/draw"], queue_max_per_group: 2 });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testReload() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-reload-"));
  const config = path.join(temp, "plugins.json");
  try {
    fs.writeFileSync(config, JSON.stringify({ plugins: { image: { enabled: true } } }), "utf8");
    const manager = createPluginManager({
      configFiles: [config],
      plugins: [{ id: "image", enabled: true }],
    });
    assert.strictEqual(manager.enabled("image"), true);

    fs.writeFileSync(config, JSON.stringify({ plugins: { image: { enabled: false } } }), "utf8");
    manager.reload();
    assert.strictEqual(manager.enabled("image"), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testPluginRequireCacheReloadsModuleCode() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-cache-reload-"));
  const pluginDir = path.join(temp, "plugins", "hot");
  try {
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({
      id: "hot",
      title: "Hot",
      version: "1.0.0",
      api_version: "1",
      min_host_version: "0.0.0",
      default_enabled: true,
      hooks: ["onMessage"],
    }), "utf8");
    fs.writeFileSync(path.join(pluginDir, "index.js"), "module.exports = { onMessage: () => ({ handled: true, value: 1 }) };\n", "utf8");
    const manager = createPluginManager({ pluginDirs: [path.join(temp, "plugins")] });
    assert.strictEqual(manager.firstHandled("onMessage", {}).result.value, 1);

    fs.writeFileSync(path.join(pluginDir, "index.js"), "module.exports = { onMessage: () => ({ handled: true, value: 2 }) };\n", "utf8");
    manager.reload();
    assert.strictEqual(manager.firstHandled("onMessage", {}).result.value, 2);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testPermissionedApiInjection() {
  const calls = [];
  const manager = createPluginManager({
    plugins: [
      {
        id: "limited",
        title: "Limited",
        version: "1.0.0",
        enabled: true,
        permissions: ["send_message"],
        module: {
          onMessage: (ctx) => {
            assert.strictEqual(ctx.handlers, undefined);
            assert.strictEqual(ctx.api.runCommand, undefined);
            ctx.api.sendMessage("msg", "ok");
            return { handled: true, api: Object.keys(ctx.api).sort() };
          },
        },
        hooks: ["onMessage"],
      },
      {
        id: "exec",
        title: "Exec",
        version: "1.0.0",
        enabled: false,
        permissions: ["exec_command"],
        module: {
          onMessage: (ctx) => ({ handled: true, value: ctx.api.runCommand("ping") }),
        },
        hooks: ["onMessage"],
      },
    ],
  });
  const limited = manager.firstHandled("onMessage", {
    api: {
      sendMessage: (...args) => calls.push(["sendMessage", ...args]),
      runCommand: () => "pong",
      health: () => ({ ok: true }),
    },
  });
  assert.deepStrictEqual(limited.result.api, ["health", "sendMessage"]);
  assert.deepStrictEqual(calls, [["sendMessage", "msg", "ok"]]);
}

function testManifestPermissionsSurviveCompatibilityDefaults() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-permission-merge-"));
  const pluginDir = path.join(temp, "plugins", "hot");
  try {
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({
      id: "hot",
      title: "Hot",
      version: "1.0.0",
      api_version: "1",
      min_host_version: "0.0.0",
      default_enabled: false,
      permissions: ["exec_command"],
      hooks: ["onMessage"],
      default_settings: { trigger: "/old" },
      settings_schema: {
        type: "object",
        properties: { trigger: { type: "string" } },
        additionalProperties: false,
      },
    }), "utf8");
    fs.writeFileSync(path.join(pluginDir, "index.js"), [
      "module.exports = {",
      "  onMessage: (ctx) => ({ handled: true, value: ctx.api.runCommand('ping'), trigger: ctx.settings.trigger })",
      "};",
    ].join("\n"), "utf8");
    const manager = createPluginManager({
      pluginDirs: [path.join(temp, "plugins")],
      plugins: [{ id: "hot", enabled: true, settings: { trigger: "/new" } }],
    });
    const item = manager.snapshot().plugins.find((row) => row.id === "hot");
    assert.strictEqual(item.api_version, "1");
    assert.strictEqual(item.min_host_version, "0.0.0");
    assert.deepStrictEqual(item.permissions, ["exec_command"]);
    assert.strictEqual(item.settings.trigger, "/new");
    const handled = manager.firstHandled("onMessage", { api: { runCommand: () => "pong" } });
    assert.strictEqual(handled.result.value, "pong");
    assert.strictEqual(handled.result.trigger, "/new");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testManifestValidationAndPluginDirHooks() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-dir-"));
  const pluginDir = path.join(temp, "plugins", "echo");
  try {
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({
      id: "echo",
      title: "Echo",
      version: "1.0.0",
      api_version: "1",
      min_host_version: "0.0.0",
      default_enabled: true,
      scope: "both",
      hooks: ["onMessage"],
      default_settings: { prefix: "/echo" },
      settings_schema: {
        type: "object",
        properties: { prefix: { type: "string" } },
      },
    }), "utf8");
    fs.writeFileSync(path.join(pluginDir, "index.js"), [
      "function onMessage(ctx) {",
      "  if (!ctx.text.startsWith(ctx.settings.prefix)) return { handled: false };",
      "  ctx.replies.push(ctx.text.slice(ctx.settings.prefix.length).trim());",
      "  return { handled: true };",
      "}",
      "module.exports = { onMessage };",
    ].join("\n"), "utf8");

    const manager = createPluginManager({ pluginDirs: [path.join(temp, "plugins")] });
    const replies = [];
    const handled = manager.firstHandled("onMessage", {
      text: "/echo ok",
      userID: 1,
      replies,
    });
    assert.strictEqual(handled.plugin, "echo");
    assert.strictEqual(handled.result.handled, true);
    assert.deepStrictEqual(replies, ["ok"]);
    assert.strictEqual(manager.snapshot().plugins.find((item) => item.id === "echo").source.replace(/\\/g, "/").endsWith("plugins/echo"), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  assert.deepStrictEqual(validateManifest({ id: "bad" }), ["missing title", "missing version", "missing api_version", "missing min_host_version"]);
  assert.deepStrictEqual(validateManifest({ id: "bad", title: "Bad", version: "1.0.0", api_version: "9", min_host_version: "0.0.0" }), ["unsupported api_version 9"]);
  assert.deepStrictEqual(validateManifest({ id: "bad", title: "Bad", version: "1.0.0", api_version: "1", min_host_version: "99.0.0" }, { hostVersion: "1.0.0" }), ["requires host >= 99.0.0"]);
  assert.deepStrictEqual(validateSettings({ count: "x" }, { properties: { count: { type: "integer" } } }), ["count expected integer"]);
  assert.deepStrictEqual(validateSettings(
    { triggers: ["/ok", 1], mode: "bad mode", extra: true },
    {
      type: "object",
      properties: {
        triggers: { type: "array", items: { type: "string" } },
        mode: { type: "string", pattern: "^[a-z]+$" },
      },
      additionalProperties: false,
    }
  ), ["triggers[1] expected string", "mode must match pattern", "extra not allowed"]);
}

function testLocalConfigSettersPersist() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-local-"));
  const local = path.join(temp, "plugins.local.json");
  try {
    const manager = createPluginManager({
      localConfigFile: local,
      configFiles: [local],
      plugins: [{ id: "image", title: "Image", version: "1.0.0", enabled: true, settings: { triggers: ["/img"] } }],
    });
    manager.setEnabled("image", false);
    manager.setSetting("image", "triggers", "/draw,/paint");
    const saved = JSON.parse(fs.readFileSync(local, "utf8"));
    assert.strictEqual(saved.plugins.image.enabled, false);
    assert.deepStrictEqual(saved.plugins.image.settings.triggers, ["/draw", "/paint"]);
    assert.strictEqual(manager.enabled("image"), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testSetSettingRejectsInvalidSchemaValues() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-local-invalid-"));
  const local = path.join(temp, "plugins.local.json");
  try {
    const manager = createPluginManager({
      localConfigFile: local,
      configFiles: [local],
      plugins: [{
        id: "image",
        title: "Image",
        version: "1.0.0",
        enabled: true,
        settings: { triggers: ["/img"], mode: "fast" },
        settings_schema: {
          type: "object",
          properties: {
            triggers: { type: "array", items: { type: "string" } },
            mode: { type: "string", pattern: "^[a-z]+$" },
          },
          additionalProperties: false,
        },
      }],
    });
    assert.throws(() => manager.setSetting("image", "triggers", "[1]"), /invalid settings: triggers\[0\] expected string/);
    assert.throws(() => manager.setSetting("image", "unknown", "1"), /invalid settings: unknown not allowed/);
    assert.strictEqual(fs.existsSync(local), false);
    manager.setSetting("image", "triggers", "[\"/draw\"]");
    const saved = JSON.parse(fs.readFileSync(local, "utf8"));
    assert.deepStrictEqual(saved.plugins.image.settings.triggers, ["/draw"]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testScopedEnableDisablePersist() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-local-scope-"));
  const local = path.join(temp, "plugins.local.json");
  try {
    const manager = createPluginManager({
      localConfigFile: local,
      configFiles: [local],
      plugins: [{ id: "image", title: "Image", version: "1.0.0", enabled: true }],
    });
    manager.setScopedEnabled("image", "group", "123456789", false);
    assert.strictEqual(manager.enabled("image", { groupID: 123456789 }), false);
    manager.setScopedEnabled("image", "private", "100000002", true);
    assert.strictEqual(manager.enabled("image", { userID: 100000002 }), true);
    const saved = JSON.parse(fs.readFileSync(local, "utf8"));
    assert.deepStrictEqual(saved.plugins.image.groups, { allow: [], deny: ["123456789"] });
    assert.deepStrictEqual(saved.plugins.image.private_users, { allow: ["100000002"], deny: [] });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testHealthCheckHookUpdatesSnapshot() {
  const manager = createPluginManager({
    plugins: [{
      id: "healthful",
      title: "Healthful",
      version: "1.0.0",
      api_version: "1",
      min_host_version: "0.0.0",
      enabled: true,
      hooks: ["onHealthCheck"],
      module: {
        onHealthCheck: () => ({ ok: true, detail: "ready" }),
      },
    }],
  });
  const rows = manager.checkHealth("healthful");
  assert.deepStrictEqual(rows, [{ plugin: "healthful", result: { ok: true, detail: "ready" } }]);
  assert.strictEqual(manager.snapshot().plugins[0].health.detail, "ready");
}

async function testAsyncHookTimeoutAndCircuitBreaker() {
  const logs = [];
  const manager = createPluginManager({
    hookTimeoutMs: 100,
    maxConsecutiveFailures: 2,
    log: (...args) => logs.push(args.join(" ")),
    plugins: [{
      id: "slow",
      title: "Slow",
      version: "1.0.0",
      api_version: "1",
      min_host_version: "0.0.0",
      enabled: true,
      hooks: ["onMessage"],
      module: {
        onMessage: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { handled: true };
        },
      },
    }],
  });
  const first = await manager.firstHandledAsync("onMessage", {});
  assert.strictEqual(first.plugin, "slow");
  assert.match(first.result.error, /timed out/);
  const second = await manager.firstHandledAsync("onMessage", {});
  assert.strictEqual(second.plugin, "slow");
  assert.strictEqual(manager.snapshot().plugins[0].health.status, "circuit_open");
  const third = await manager.firstHandledAsync("onMessage", {});
  assert.strictEqual(third, null);
  assert.ok(logs.some((line) => line.includes("plugin circuit opened slow")));
}

function testLifecycleHooksAndReloadRollback() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-lifecycle-"));
  const pluginDir = path.join(temp, "plugins", "life");
  const marker = path.join(temp, "events.json");
  const config = path.join(temp, "plugins.local.json");
  try {
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({
      id: "life",
      title: "Life",
      version: "1.0.0",
      api_version: "1",
      min_host_version: "0.0.0",
      default_enabled: true,
      hooks: ["onMessage"],
      default_settings: { mode: "a" },
      settings_schema: {
        type: "object",
        properties: { mode: { type: "string" } },
        additionalProperties: false,
      },
    }), "utf8");
    fs.writeFileSync(path.join(pluginDir, "index.js"), [
      "const fs = require('fs');",
      `const marker = ${JSON.stringify(marker)};`,
      "function read() { try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return []; } }",
      "function write(event) { const rows = read(); rows.push(event); fs.writeFileSync(marker, JSON.stringify(rows)); }",
      "module.exports = {",
      "  onLoad: () => write('load'),",
      "  onUnload: () => write('unload'),",
      "  onConfigChange: () => write('config'),",
      "  onMessage: () => ({ handled: false })",
      "};",
    ].join("\n"), "utf8");
    const manager = createPluginManager({ pluginDirs: [path.join(temp, "plugins")], configFiles: [config], localConfigFile: config });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(marker, "utf8")), ["load"]);
    manager.setSetting("life", "mode", "b");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(marker, "utf8")), ["load", "config"]);
    manager.setEnabled("life", false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(marker, "utf8")), ["load", "config", "unload"]);

    fs.writeFileSync(path.join(pluginDir, "index.js"), "module.exports = { onLoad: () => { throw new Error('boom'); }, onMessage: () => ({ handled: false }) };\n", "utf8");
    assert.throws(() => manager.setEnabled("life", true), /boom/);
    assert.strictEqual(manager.enabled("life"), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testCapabilitySummaryIncludesPlugins() {
  const snapshot = createCapabilitySnapshot({
    upstreamReady: () => true,
    clients: new Map([[3002, {}]]),
    projectRoot: process.cwd(),
    workspaceRoot: process.cwd(),
    workspaceForGroup: () => process.cwd(),
    allowedGroups: [123456789],
    defaultListenMode: "selective",
    dreamEnabled: true,
    imageEnabled: true,
    imageScript: path.join(process.cwd(), "scripts", "generate-image.js"),
    renderScript: path.join(process.cwd(), "scripts", "render-qq-card.ps1"),
    taskTimezone: "Asia/Shanghai",
    plugins: {
      plugins: [
        { id: "image", enabled: true },
        { id: "dream", enabled: false },
      ],
    },
  });

  const text = formatCapabilitySummary(snapshot).join("\n");
  assert.match(text, /插件：启用 image；关闭 dream/);
}

function testProxyUsesPluginConfigForImageCommand() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-proxy-"));
  const config = path.join(temp, "plugins.json");
  const localConfig = path.join(temp, "plugins.local.json");
  const script = [
    "const assert = require('assert');",
    "const proxy = require('./scripts/onebot-group-proxy');",
    "const msg = { post_type: 'message', message_type: 'group', group_id: 123456789, user_id: 1, raw_message: '/画图 cat', message: [{ type: 'text', data: { text: '/画图 cat' } }] };",
    "assert.strictEqual(proxy.isImageCommand(msg), false);",
  ].join("\n");
  try {
    fs.writeFileSync(config, JSON.stringify({ plugins: { image: { enabled: false } } }), "utf8");
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, ONEBOT_PLUGIN_CONFIG: config, ONEBOT_PLUGIN_LOCAL_CONFIG: localConfig, ONEBOT_RUNTIME_DIR: path.join(temp, "runtime") },
      encoding: "utf8",
      windowsHide: true,
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testProxyUsesPluginTriggerOverride() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-proxy-trigger-"));
  const config = path.join(temp, "plugins.json");
  const localConfig = path.join(temp, "plugins.local.json");
  const script = [
    "const assert = require('assert');",
    "const proxy = require('./scripts/onebot-group-proxy');",
    "const msg = { post_type: 'message', message_type: 'private', user_id: 100000002, raw_message: '/draw cat', message: [{ type: 'text', data: { text: '/draw cat' } }] };",
    "assert.strictEqual(proxy.imagePromptFromMessage(msg), 'cat');",
  ].join("\n");
  try {
    fs.writeFileSync(config, JSON.stringify({ plugins: { image: { enabled: true, settings: { triggers: ["/draw"] } } } }), "utf8");
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, ONEBOT_PLUGIN_CONFIG: config, ONEBOT_PLUGIN_LOCAL_CONFIG: localConfig, ONEBOT_RUNTIME_DIR: path.join(temp, "runtime") },
      encoding: "utf8",
      windowsHide: true,
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testAdminPluginsCommandListsAndReloads() {
  const replies = [];
  let reloaded = false;
  const commands = createProxyCommands({
    messageText: (msg) => String(msg.raw_message || ""),
    sendPrivateText: (userID, messageID, text) => replies.push(text),
    sendGroupText: () => {},
    adminRootUsers: [100000002],
    adminUsers: [100000002],
    pluginSnapshot: () => ({ plugins: [{ id: "image", enabled: true, settings: { triggers: ["/img"] } }] }),
    reloadPlugins: () => {
      reloaded = true;
      return { plugins: [{ id: "image", enabled: false, settings: {} }] };
    },
  });

  commands.handleProxyCommand({
    message_type: "private",
    user_id: 100000002,
    message_id: 1,
    raw_message: "/admin plugins",
  });
  assert.match(replies.at(-1), /image: 启用/);

  commands.handleProxyCommand({
    message_type: "private",
    user_id: 100000002,
    message_id: 2,
    raw_message: "/admin plugins reload",
  });
  assert.strictEqual(reloaded, true);
  assert.match(replies.at(-1), /插件配置已重载/);
  assert.match(replies.at(-1), /image: 关闭/);
}

function testAdminPluginMutations() {
  const replies = [];
  const calls = [];
  const snapshotPlugin = {
    id: "image",
    enabled: true,
    title: "画图",
    version: "1.0.0",
    api_version: "1",
    min_host_version: "0.2.18",
    settings: { triggers: ["/img"] },
    groups: { allow: ["*"], deny: [] },
    private_users: null,
    health: { status: "ok", consecutive_failures: 0, error_count: 0 },
  };
  const commands = createProxyCommands({
    messageText: (msg) => String(msg.raw_message || ""),
    sendPrivateText: (userID, messageID, text) => replies.push(text),
    sendGroupText: () => {},
    adminRootUsers: [100000002],
    adminUsers: [100000002],
    pluginSnapshot: () => ({ plugins: [snapshotPlugin] }),
    enablePlugin: (id) => {
      calls.push(["enable", id]);
      return { id, enabled: true, title: "画图", version: "1.0.0", settings: {} };
    },
    disablePlugin: (id) => {
      calls.push(["disable", id]);
      return { id, enabled: false, title: "画图", version: "1.0.0", settings: {} };
    },
    setPluginSetting: (id, key, value) => {
      calls.push(["set", id, key, value]);
      return { id, enabled: true, title: "画图", version: "1.0.0", settings: { [key]: value } };
    },
    setPluginScopedEnabled: (id, kind, scopeID, value) => {
      calls.push(["scope", id, kind, scopeID, value]);
      return { ...snapshotPlugin, groups: { allow: value ? [scopeID] : [], deny: value ? [] : [scopeID] } };
    },
    checkPluginHealth: (id) => {
      calls.push(["health", id]);
      return { plugins: [{ ...snapshotPlugin, health: { status: "ok", consecutive_failures: 0, error_count: 0, detail: "ready" } }] };
    },
    testPlugin: (id) => {
      calls.push(["test", id]);
      return "plugin checks ok (1 plugins)";
    },
  });

  commands.handleProxyCommand({ message_type: "private", user_id: 100000002, message_id: 3, raw_message: "/admin plugins show image" });
  assert.match(replies.at(-1), /版本：1\.0\.0/);
  commands.handleProxyCommand({ message_type: "private", user_id: 100000002, message_id: 31, raw_message: "/admin plugins health image" });
  assert.match(replies.at(-1), /image: ok/);
  commands.handleProxyCommand({ message_type: "private", user_id: 100000002, message_id: 32, raw_message: "/admin plugins errors image" });
  assert.match(replies.at(-1), /image: 无/);
  commands.handleProxyCommand({ message_type: "private", user_id: 100000002, message_id: 33, raw_message: "/admin plugins config image" });
  assert.match(replies.at(-1), /settings=/);
  commands.handleProxyCommand({ message_type: "private", user_id: 100000002, message_id: 36, raw_message: "/admin plugins test image" });
  assert.match(replies.at(-1), /plugin checks ok/);
  commands.handleProxyCommand({ message_type: "private", user_id: 100000002, message_id: 34, raw_message: "/admin plugins disable image group 123456789" });
  commands.handleProxyCommand({ message_type: "private", user_id: 100000002, message_id: 35, raw_message: "/admin plugins enable image private 100000002" });
  commands.handleProxyCommand({ message_type: "private", user_id: 100000002, message_id: 4, raw_message: "/admin plugins disable image" });
  commands.handleProxyCommand({ message_type: "private", user_id: 100000002, message_id: 5, raw_message: "/admin plugins enable image" });
  commands.handleProxyCommand({ message_type: "private", user_id: 100000002, message_id: 6, raw_message: "/admin plugins set image triggers /draw,/paint" });
  assert.deepStrictEqual(calls, [
    ["health", "image"],
    ["test", "image"],
    ["scope", "image", "group", "123456789", false],
    ["scope", "image", "private", "100000002", true],
    ["disable", "image"],
    ["enable", "image"],
    ["set", "image", "triggers", "/draw,/paint"],
  ]);
}

async function main() {
  testDefaultsAndSettings();
  testConfigOverrideAndScopes();
  testReload();
  testPluginRequireCacheReloadsModuleCode();
  testPermissionedApiInjection();
  testManifestPermissionsSurviveCompatibilityDefaults();
  testManifestValidationAndPluginDirHooks();
  testLocalConfigSettersPersist();
  testSetSettingRejectsInvalidSchemaValues();
  testScopedEnableDisablePersist();
  testHealthCheckHookUpdatesSnapshot();
  await testAsyncHookTimeoutAndCircuitBreaker();
  testLifecycleHooksAndReloadRollback();
  testCapabilitySummaryIncludesPlugins();
  testProxyUsesPluginConfigForImageCommand();
  testProxyUsesPluginTriggerOverride();
  testAdminPluginsCommandListsAndReloads();
  testAdminPluginMutations();
  console.log("plugin manager checks ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
