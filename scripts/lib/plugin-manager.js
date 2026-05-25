const fs = require("fs");
const path = require("path");

const HOST_PLUGIN_API_VERSION = "1";
const HOST_VERSION = readHostVersion();
const DEFAULT_HOOK_TIMEOUT_MS = 5000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const KNOWN_HOOKS = new Set(["onLoad", "onUnload", "onConfigChange", "onInstall", "onHealthCheck", "onMessage", "onCommand", "onOutgoing", "onSchedule", "health", "capabilities"]);
const LIFECYCLE_HOOKS = new Set(["onLoad", "onUnload", "onConfigChange", "onInstall"]);
const REQUIRED_MANIFEST_FIELDS = ["id", "title", "version", "api_version", "min_host_version"];
const PERMISSION_API_KEYS = {
  send_message: ["sendMessage"],
  read_workspace_file: ["readWorkspaceFile"],
  write_local_file: ["writeLocalFile"],
  exec_command: ["runCommand"],
  schedule: ["schedule"],
};
const SAFE_API_KEYS = new Set(["health"]);

function createPluginManager(options = {}) {
  const manager = {
    _defaults: normalizePluginList(options.plugins || []),
    _pluginDirs: (options.pluginDirs || []).filter(Boolean),
    _configFiles: (options.configFiles || []).filter(Boolean),
    _localConfigFile: options.localConfigFile || "",
    _log: options.log || (() => {}),
    _registry: new Map(),
    _config: { plugins: {} },
    _health: new Map(),
    _hostVersion: options.hostVersion || HOST_VERSION,
    _hookTimeoutMs: boundedInt(options.hookTimeoutMs, DEFAULT_HOOK_TIMEOUT_MS, 100, 60000),
    _maxConsecutiveFailures: boundedInt(options.maxConsecutiveFailures, DEFAULT_MAX_CONSECUTIVE_FAILURES, 1, 100),
    reload,
    enabled,
    settings,
    plugin,
    snapshot,
    invoke,
    invokeAsync,
    firstHandled,
    firstHandledAsync,
    healthStatus,
    checkHealth,
    setEnabled,
    setScopedEnabled,
    setSetting,
  };
  manager.reload();
  return manager;
}

function reload() {
  const previousRegistry = this._registry;
  const previousConfig = this._config;
  const previousHealth = new Map(this._health);
  const previousPlugins = collectEffectivePlugins(this);
  let nextRegistry;
  let nextConfig;
  try {
    nextRegistry = loadRegistry({
      defaults: this._defaults,
      pluginDirs: this._pluginDirs,
      log: this._log,
      hostVersion: this._hostVersion,
    });
    nextConfig = readMergedConfig(this._configFiles, this._log);
    validateConfiguredPlugins(nextRegistry, nextConfig, this._log);
    this._registry = nextRegistry;
    this._config = nextConfig;
    applyLifecycleTransitions(this, previousPlugins);
  } catch (err) {
    this._registry = previousRegistry;
    this._config = previousConfig;
    this._health = previousHealth;
    throw err;
  }
  return this.snapshot();
}

function plugin(id) {
  const key = String(id || "").trim();
  const base = this._registry.get(key) || { id: key, title: key, version: "0.0.0", default_enabled: false, settings: {} };
  const override = this._config.plugins[key] || {};
  return mergePlugin(base, override);
}

function enabled(id, context = {}) {
  const item = this.plugin(id);
  if (!item.enabled) {
    return false;
  }
  return scopeAllowed(item, context);
}

function settings(id) {
  return { ...(this.plugin(id).settings || {}) };
}

function snapshot() {
  const ids = new Set([...this._registry.keys(), ...Object.keys(this._config.plugins || {})]);
  return {
    version: 2,
    files: this._configFiles.map((file) => ({
      path: file,
      loaded: Boolean(file && fs.existsSync(file)),
    })),
    plugin_dirs: this._pluginDirs.map((dir) => ({
      path: dir,
      loaded: Boolean(dir && fs.existsSync(dir)),
    })),
    plugins: [...ids].sort().map((id) => {
      const item = this.plugin(id);
      return {
        id,
        title: item.title || id,
        version: item.version || "0.0.0",
        api_version: item.api_version || "",
        min_host_version: item.min_host_version || "",
        description: item.description || "",
        homepage: item.homepage || "",
        repository: item.repository || "",
        keywords: item.keywords || [],
        license: item.license || "",
        enabled: Boolean(item.enabled),
        source: item.source || "config",
        scope: item.scope || "both",
        permissions: item.permissions || [],
        hooks: item.hooks || [],
        groups: item.groups || null,
        private_users: item.private_users || null,
        settings: item.settings || {},
        errors: item.errors || [],
        health: healthStatus(this, id),
      };
    }),
  };
}

function invoke(hook, context = {}) {
  if (!KNOWN_HOOKS.has(hook)) {
    throw new Error(`unknown plugin hook: ${hook}`);
  }
  const results = [];
  for (const item of orderedPlugins(this, context)) {
    const fn = item.module && item.module[hook];
    if (typeof fn !== "function") {
      continue;
    }
    try {
      const result = invokePluginHookSync(this, item, hook, context);
      results.push({ plugin: item.id, result: result || { handled: false } });
    } catch (err) {
      results.push({ plugin: item.id, result: { error: err.message } });
    }
  }
  return results;
}

async function invokeAsync(hook, context = {}) {
  if (!KNOWN_HOOKS.has(hook)) {
    throw new Error(`unknown plugin hook: ${hook}`);
  }
  const results = [];
  for (const item of orderedPlugins(this, context)) {
    const fn = item.module && item.module[hook];
    if (typeof fn !== "function") {
      continue;
    }
    const result = await invokePluginHookAsync(this, item, hook, context);
    results.push({ plugin: item.id, result: result || { handled: false } });
  }
  return results;
}

function firstHandled(hook, context = {}) {
  for (const item of orderedPlugins(this, context)) {
    const fn = item.module && item.module[hook];
    if (typeof fn !== "function") {
      continue;
    }
    try {
      const result = invokePluginHookSync(this, item, hook, context) || { handled: false };
      if (result.block || result.handled) {
        return { plugin: item.id, result };
      }
    } catch (err) {
      return { plugin: item.id, result: { error: err.message } };
    }
  }
  return null;
}

async function firstHandledAsync(hook, context = {}) {
  if (!KNOWN_HOOKS.has(hook)) {
    throw new Error(`unknown plugin hook: ${hook}`);
  }
  for (const item of orderedPlugins(this, context)) {
    const fn = item.module && item.module[hook];
    if (typeof fn !== "function") {
      continue;
    }
    const result = (await invokePluginHookAsync(this, item, hook, context)) || { handled: false };
    if (result.block || result.handled || result.error) {
      return { plugin: item.id, result };
    }
  }
  return null;
}

function healthStatus(manager, id) {
  const state = manager._health.get(String(id)) || {};
  return {
    ok: !state.circuit_open,
    status: state.circuit_open ? "circuit_open" : (state.status || "ok"),
    consecutive_failures: Number(state.consecutive_failures || 0),
    error_count: Number(state.error_count || 0),
    detail: state.detail || "",
    last_check: state.last_check || null,
    last_error: state.last_error || "",
    last_error_at: state.last_error_at || "",
  };
}

function checkHealth(id = "", context = {}) {
  const target = String(id || "").trim();
  const rows = [];
  for (const item of orderedPlugins(this, context)) {
    if (target && item.id !== target) {
      continue;
    }
    const hook = typeof item.module.onHealthCheck === "function" ? "onHealthCheck" : (typeof item.module.health === "function" ? "health" : "");
    if (!hook) {
      rows.push({ plugin: item.id, result: healthStatus(this, item.id) });
      continue;
    }
    try {
      const result = invokePluginHookSync(this, item, hook, context) || { ok: true };
      recordPluginHealthCheck(this, item.id, result);
      rows.push({ plugin: item.id, result });
    } catch (err) {
      rows.push({ plugin: item.id, result: { ok: false, error: err.message } });
    }
  }
  if (target && rows.length === 0) {
    const item = this.plugin(target);
    if (!item || !item.module) {
      throw new Error(`unknown plugin: ${target}`);
    }
  }
  return rows;
}

function setEnabled(id, value) {
  if (!this._registry.has(String(id))) {
    throw new Error(`unknown plugin: ${id}`);
  }
  writeLocalPluginPatch(this, id, { enabled: parseEnabled(value) });
  this.reload();
  return this.plugin(id);
}

function setScopedEnabled(id, kind, scopeID, value) {
  const key = String(id);
  if (!this._registry.has(key)) {
    throw new Error(`unknown plugin: ${id}`);
  }
  const scopeKey = scopeFieldForKind(kind);
  const target = String(scopeID || "").trim();
  if (!target) {
    throw new Error("scope id required");
  }
  const item = this.plugin(key);
  const nextScope = normalizeScope(item[scopeKey]) || { allow: [], deny: [] };
  if (parseEnabled(value)) {
    nextScope.deny = (nextScope.deny || []).filter((row) => row !== target);
    if (!(nextScope.allow || []).includes("*") && !(nextScope.allow || []).includes(target)) {
      nextScope.allow = [...(nextScope.allow || []), target];
    }
  } else {
    nextScope.allow = (nextScope.allow || []).filter((row) => row !== target);
    if (!(nextScope.deny || []).includes(target)) {
      nextScope.deny = [...(nextScope.deny || []), target];
    }
  }
  writeLocalPluginPatch(this, key, { [scopeKey]: nextScope });
  this.reload();
  return this.plugin(key);
}

function scopeFieldForKind(kind) {
  const text = String(kind || "").trim().toLowerCase();
  if (["group", "groups", "群", "群聊"].includes(text)) {
    return "groups";
  }
  if (["private", "user", "users", "私聊", "用户"].includes(text)) {
    return "private_users";
  }
  throw new Error("scope kind must be group or private");
}

function setSetting(id, key, value) {
  if (!this._registry.has(String(id))) {
    throw new Error(`unknown plugin: ${id}`);
  }
  const parsed = parseSettingValue(value);
  const item = this.plugin(id);
  const nextSettings = { ...(item.settings || {}), [key]: parsed };
  const errors = validateSettings(nextSettings, item.settings_schema);
  if (errors.length) {
    throw new Error(`invalid settings: ${errors.join("; ")}`);
  }
  const current = readConfigFile(this._localConfigFile);
  current.plugins = current.plugins || {};
  current.plugins[id] = current.plugins[id] || {};
  current.plugins[id].settings = current.plugins[id].settings || {};
  current.plugins[id].settings[key] = parsed;
  writeConfigFile(this._localConfigFile, current);
  this.reload();
  return this.plugin(id);
}

function collectEffectivePlugins(manager) {
  const ids = new Set([...manager._registry.keys(), ...Object.keys(manager._config.plugins || {})]);
  const out = new Map();
  for (const id of ids) {
    out.set(id, manager.plugin(id));
  }
  return out;
}

function applyLifecycleTransitions(manager, previousPlugins) {
  const currentPlugins = collectEffectivePlugins(manager);
  for (const [id, oldItem] of previousPlugins.entries()) {
    const nextItem = currentPlugins.get(id);
    if (oldItem.enabled && (!nextItem || !nextItem.enabled)) {
      callLifecycleHook(manager, oldItem, "onUnload", { reason: nextItem ? "disabled" : "removed" });
    }
  }
  for (const [id, nextItem] of currentPlugins.entries()) {
    const oldItem = previousPlugins.get(id);
    if (nextItem.enabled && (!oldItem || !oldItem.enabled)) {
      callLifecycleHook(manager, nextItem, "onLoad", { reason: oldItem ? "enabled" : "loaded" });
    } else if (nextItem.enabled && oldItem && oldItem.enabled && JSON.stringify(oldItem.settings || {}) !== JSON.stringify(nextItem.settings || {})) {
      callLifecycleHook(manager, nextItem, "onConfigChange", {
        old_settings: oldItem.settings || {},
        new_settings: nextItem.settings || {},
      });
    }
  }
}

function callLifecycleHook(manager, item, hook, extra = {}) {
  const fn = item.module && item.module[hook];
  if (typeof fn !== "function") {
    return;
  }
  const result = fn(pluginHookContext(item, { ...extra, lifecycle: hook }));
  if (result && typeof result.then === "function") {
    result.catch((err) => recordPluginFailure(manager, item.id, hook, err));
  }
}

function orderedPlugins(manager, context) {
  return manager.snapshot().plugins
    .map((row) => manager.plugin(row.id))
    .filter((item) => item.enabled && scopeAllowed(item, context) && item.module && !isPluginCircuitOpen(manager, item.id))
    .filter((item) => Array.isArray(item.hooks))
    .sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100) || String(a.id).localeCompare(String(b.id)));
}

function loadRegistry({ defaults, pluginDirs, log, hostVersion }) {
  const registry = new Map(defaults);
  for (const root of pluginDirs) {
    if (!root || !fs.existsSync(root)) {
      continue;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(root, entry.name);
      const manifestPath = path.join(dir, "plugin.json");
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const errors = validateManifest(manifest, { hostVersion });
        const plugin = normalizeManifestPlugin(manifest, dir, errors);
        const modulePath = path.join(dir, manifest.main || "index.js");
        if (fs.existsSync(modulePath)) {
          clearPluginRequireCache(dir, modulePath);
          plugin.module = require(modulePath);
          plugin.hooks = normalizeHooks(manifest.hooks || Object.keys(plugin.module).filter((key) => KNOWN_HOOKS.has(key)));
        } else {
          plugin.errors.push(`missing module ${path.relative(dir, modulePath)}`);
        }
        registry.set(plugin.id, mergePlugin(plugin, registry.get(plugin.id) || { id: plugin.id }));
      } catch (err) {
        log("plugin manifest read failed", manifestPath, err.message);
      }
    }
  }
  return registry;
}

function normalizePluginList(items) {
  const out = new Map();
  const list = Array.isArray(items) ? items : Object.entries(items).map(([id, value]) => ({ id, ...value }));
  for (const item of list) {
    if (!item || !item.id) {
      continue;
    }
    const manifest = {
      ...item,
      version: item.version || "0.0.0",
      title: item.title || item.id,
      api_version: item.api_version || HOST_PLUGIN_API_VERSION,
      min_host_version: item.min_host_version || "0.0.0",
    };
    const plugin = normalizeManifestPlugin(manifest, item.dir || "", validateManifest(manifest));
    stripImplicitDefaultFields(plugin, item);
    if (Object.prototype.hasOwnProperty.call(item, "module")) {
      plugin.module = item.module || null;
    } else {
      delete plugin.module;
    }
    out.set(plugin.id, plugin);
  }
  return out;
}

function stripImplicitDefaultFields(plugin, source) {
  const optionalFields = [
    "description",
    "priority",
    "scope",
    "permissions",
    "hooks",
    "settings_schema",
    "api_version",
    "min_host_version",
    "groups",
    "private_users",
  ];
  for (const field of optionalFields) {
    if (!Object.prototype.hasOwnProperty.call(source, field) && !(field === "settings_schema" && Object.prototype.hasOwnProperty.call(source, "config_schema"))) {
      delete plugin[field];
    }
  }
  if (!Object.prototype.hasOwnProperty.call(source, "version")) {
    delete plugin.version;
  }
  if (!Object.prototype.hasOwnProperty.call(source, "settings") && !Object.prototype.hasOwnProperty.call(source, "default_settings")) {
    delete plugin.settings;
  }
  if (!Object.prototype.hasOwnProperty.call(source, "dir")) {
    delete plugin.dir;
    delete plugin.source;
  }
}

function normalizeManifestPlugin(manifest, dir, errors = []) {
  const id = String(manifest.id || "").trim();
  return {
    id,
    title: manifest.title || id,
    version: manifest.version || "0.0.0",
    api_version: String(manifest.api_version || "").trim(),
    min_host_version: String(manifest.min_host_version || "").trim(),
    description: manifest.description || "",
    homepage: manifest.homepage || "",
    repository: manifest.repository || "",
    keywords: Array.isArray(manifest.keywords) ? manifest.keywords.map(String) : normalizePermissions(manifest.keywords),
    license: manifest.license || "",
    source: dir ? path.relative(process.cwd(), dir).replace(/\\/g, "/") : "builtin",
    dir,
    priority: Number(manifest.priority || 100),
    default_enabled: manifest.default_enabled !== undefined ? parseEnabled(manifest.default_enabled) : parseEnabled(manifest.enabled !== false),
    enabled: manifest.enabled,
    scope: manifest.scope || "both",
    permissions: normalizePermissions(manifest.permissions),
    hooks: normalizeHooks(manifest.hooks || []),
    settings: { ...(manifest.default_settings || manifest.settings || {}) },
    settings_schema: manifest.settings_schema || manifest.config_schema || null,
    groups: normalizeScope(manifest.groups),
    private_users: normalizeScope(manifest.private_users),
    errors,
    module: manifest.module || null,
  };
}

function validateManifest(manifest, options = {}) {
  const errors = [];
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!manifest || !manifest[field]) {
      errors.push(`missing ${field}`);
    }
  }
  if (manifest && manifest.api_version && String(manifest.api_version) !== HOST_PLUGIN_API_VERSION) {
    errors.push(`unsupported api_version ${manifest.api_version}`);
  }
  if (manifest && manifest.min_host_version && compareVersions(String(manifest.min_host_version), String(options.hostVersion || HOST_VERSION)) > 0) {
    errors.push(`requires host >= ${manifest.min_host_version}`);
  }
  if (manifest && manifest.hooks) {
    for (const hook of normalizeHooks(manifest.hooks)) {
      if (!KNOWN_HOOKS.has(hook)) {
        errors.push(`unknown hook ${hook}`);
      }
    }
  }
  if (manifest && manifest.repository && typeof manifest.repository !== "string" && typeof manifest.repository.url !== "string") {
    errors.push("repository must be a string or object with url");
  }
  if (manifest && manifest.keywords && !Array.isArray(manifest.keywords) && typeof manifest.keywords !== "string") {
    errors.push("keywords must be an array or comma-separated string");
  }
  return errors;
}

function normalizeHooks(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return list.map((item) => String(item).trim()).filter(Boolean);
}

function readMergedConfig(files, log) {
  const merged = { plugins: {} };
  for (const file of files) {
    if (!file || !fs.existsSync(file)) {
      continue;
    }
    try {
      mergeConfigInto(merged, JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (err) {
      log("plugin config read failed", path.relative(process.cwd(), file), err.message);
    }
  }
  return merged;
}

function mergeConfigInto(target, source) {
  const plugins = normalizePluginConfig(source && source.plugins);
  for (const [id, value] of Object.entries(plugins)) {
    const existing = target.plugins[id] || { id };
    const merged = mergePlugin(existing, value);
    if (!Object.prototype.hasOwnProperty.call(existing, "enabled") && !Object.prototype.hasOwnProperty.call(value, "enabled")) {
      delete merged.enabled;
    }
    target.plugins[id] = merged;
  }
}

function normalizePluginConfig(value) {
  if (Array.isArray(value)) {
    const out = {};
    for (const item of value) {
      if (item && item.id) {
        out[String(item.id)] = item;
      }
    }
    return out;
  }
  return value && typeof value === "object" ? value : {};
}

function mergePlugin(base, override) {
  const out = {
    ...base,
    ...override,
    settings: {
      ...(base.settings || {}),
      ...(override.settings || {}),
    },
    errors: [
      ...(base.errors || []),
      ...(override.errors || []),
    ],
  };
  if (Object.prototype.hasOwnProperty.call(override, "enabled")) {
    out.enabled = parseEnabled(override.enabled);
  } else if (Object.prototype.hasOwnProperty.call(base, "enabled") && base.enabled !== undefined) {
    out.enabled = parseEnabled(base.enabled);
  } else {
    out.enabled = parseEnabled(base.default_enabled);
  }
  out.groups = normalizeScope(override.groups || base.groups);
  out.private_users = normalizeScope(override.private_users || base.private_users);
  out.hooks = normalizeHooks(override.hooks || base.hooks || []);
  out.permissions = normalizePermissions(out.permissions);
  return out;
}

function pluginHookContext(plugin, context = {}) {
  const { api, handlers, ...rest } = context;
  return {
    ...rest,
    plugin: publicPlugin(plugin),
    settings: { ...(plugin.settings || {}) },
    api: permissionedApi(api, plugin.permissions),
  };
}

function invokePluginHookSync(manager, item, hook, context) {
  try {
    const result = item.module[hook](pluginHookContext(item, context));
    if (result && typeof result.then === "function") {
      throw new Error("async hook returned Promise; use async plugin invocation");
    }
    recordPluginSuccess(manager, item.id);
    return result;
  } catch (err) {
    recordPluginFailure(manager, item.id, hook, err);
    throw err;
  }
}

async function invokePluginHookAsync(manager, item, hook, context) {
  try {
    const result = await withTimeout(
      Promise.resolve().then(() => item.module[hook](pluginHookContext(item, context))),
      manager._hookTimeoutMs,
      `${item.id}.${hook} timed out after ${manager._hookTimeoutMs}ms`
    );
    recordPluginSuccess(manager, item.id);
    return result;
  } catch (err) {
    recordPluginFailure(manager, item.id, hook, err);
    return { error: err.message };
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      if (timer.unref) timer.unref();
    }),
  ]);
}

function recordPluginSuccess(manager, id) {
  const current = manager._health.get(String(id)) || {};
  manager._health.set(String(id), {
    ...current,
    status: "ok",
    consecutive_failures: 0,
    circuit_open: false,
  });
}

function recordPluginFailure(manager, id, hook, err) {
  const key = String(id);
  const current = manager._health.get(key) || {};
  const consecutive = Number(current.consecutive_failures || 0) + 1;
  const errorCount = Number(current.error_count || 0) + 1;
  const circuitOpen = consecutive >= manager._maxConsecutiveFailures;
  manager._health.set(key, {
    ...current,
    status: circuitOpen ? "circuit_open" : "degraded",
    consecutive_failures: consecutive,
    error_count: errorCount,
    circuit_open: circuitOpen,
    last_error: err && err.message ? err.message : String(err),
    last_error_at: new Date().toISOString(),
  });
  manager._log("plugin hook failed", key, hook, err && err.message ? err.message : String(err));
  if (circuitOpen) {
    manager._log("plugin circuit opened", key, hook, `failures=${consecutive}`);
  }
}

function recordPluginHealthCheck(manager, id, result) {
  const current = manager._health.get(String(id)) || {};
  manager._health.set(String(id), {
    ...current,
    status: result && result.ok === false ? "degraded" : "ok",
    detail: result && result.detail ? String(result.detail) : "",
    last_check: result || null,
  });
}

function isPluginCircuitOpen(manager, id) {
  const state = manager._health.get(String(id));
  return Boolean(state && state.circuit_open);
}

function publicPlugin(plugin) {
  const { module, ...safe } = plugin || {};
  return safe;
}

function permissionedApi(api, permissions = []) {
  const source = api && typeof api === "object" ? api : {};
  const allowed = new Set(SAFE_API_KEYS);
  for (const permission of normalizePermissions(permissions)) {
    for (const key of PERMISSION_API_KEYS[permission] || []) {
      allowed.add(key);
    }
  }
  const out = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = source[key];
    }
  }
  return out;
}

function normalizePermissions(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "object") {
    return [
      ...normalizePermissions(value.required),
      ...normalizePermissions(value.optional),
    ];
  }
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function validateConfiguredPlugins(registry, config, log) {
  for (const [id, override] of Object.entries(config.plugins || {})) {
    const base = registry.get(id);
    if (!base) {
      log("unknown plugin configured", id);
      continue;
    }
    const errors = validateSettings({ ...(base.settings || {}), ...(override.settings || {}) }, base.settings_schema);
    if (errors.length) {
      base.errors = [...(base.errors || []), ...errors.map((err) => `settings: ${err}`)];
    }
  }
}

function validateSettings(settings, schema) {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  const effective = schema.type ? schema : { ...schema, type: "object" };
  return validateSchemaValue(settings, effective, "settings");
}

function schemaTypeOK(value, spec = {}) {
  const type = spec.type;
  if (!type) {
    return true;
  }
  if (Array.isArray(type)) {
    return type.some((item) => schemaTypeOK(value, { ...spec, type: item }));
  }
  if (type === "array") {
    return Array.isArray(value);
  }
  if (type === "integer") {
    return Number.isInteger(value);
  }
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (type === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (type === "null") {
    return value === null;
  }
  return typeof value === type;
}

function validateSchemaValue(value, schema = {}, pathName = "value") {
  const errors = [];
  if (!schemaTypeOK(value, schema)) {
    errors.push(`${pathName} expected ${formatSchemaType(schema.type)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathName} must be one of ${schema.enum.join(",")}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${pathName} below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${pathName} above maximum`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${pathName} below minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${pathName} above maxLength`);
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push(`${pathName} must match pattern`);
        }
      } catch {
        errors.push(`${pathName} has invalid pattern`);
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateSchemaValue(item, schema.items, `${pathName}[${index}]`));
    });
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${pathName === "settings" ? key : `${pathName}.${key}`} required`);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const childPath = pathName === "settings" ? key : `${pathName}.${key}`;
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(...validateSchemaValue(item, properties[key], childPath));
      } else if (schema.additionalProperties === false) {
        errors.push(`${childPath} not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateSchemaValue(item, schema.additionalProperties, childPath));
      }
    }
  }
  return errors;
}

function formatSchemaType(type) {
  return Array.isArray(type) ? type.join("|") : String(type || "value");
}

function clearPluginRequireCache(dir, modulePath) {
  const root = `${path.resolve(dir)}${path.sep}`;
  const resolvedModule = require.resolve(modulePath);
  for (const key of Object.keys(require.cache)) {
    const resolvedKey = path.resolve(key);
    if (resolvedKey === resolvedModule || resolvedKey.startsWith(root)) {
      delete require.cache[key];
    }
  }
}

function readHostVersion() {
  try {
    const pkgPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function compareVersions(a, b) {
  const left = String(a || "0").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b || "0").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    if ((left[i] || 0) > (right[i] || 0)) return 1;
    if ((left[i] || 0) < (right[i] || 0)) return -1;
  }
  return 0;
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function parseEnabled(value) {
  if (typeof value === "boolean") {
    return value;
  }
  const text = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off", "disabled"].includes(text)) {
    return false;
  }
  if (["1", "true", "yes", "on", "enabled"].includes(text)) {
    return true;
  }
  return Boolean(value);
}

function normalizeScope(value) {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    return { allow: value.map(String), deny: [] };
  }
  if (typeof value === "object") {
    return {
      allow: normalizeIDList(value.allow),
      deny: normalizeIDList(value.deny),
    };
  }
  return { allow: normalizeIDList(value), deny: [] };
}

function normalizeIDList(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list.map((item) => String(item).trim()).filter(Boolean);
}

function scopeAllowed(plugin, context) {
  if (context.groupID !== undefined && context.groupID !== null) {
    return scopeMatches(plugin, "group", context.groupID);
  }
  if (context.userID !== undefined && context.userID !== null) {
    return scopeMatches(plugin, "private", context.userID);
  }
  return true;
}

function scopeMatches(plugin, kind, id) {
  const declared = plugin.scope || "both";
  if (kind === "group" && !["both", "group", "system"].includes(declared)) {
    return false;
  }
  if (kind === "private" && !["both", "private", "system"].includes(declared)) {
    return false;
  }
  const scope = kind === "group" ? plugin.groups : plugin.private_users;
  return matchScope(scope, id);
}

function matchScope(scope, id) {
  if (!scope) {
    return true;
  }
  const value = String(id);
  if ((scope.deny || []).includes(value) || (scope.deny || []).includes("*")) {
    return false;
  }
  const allow = scope.allow || [];
  return allow.length === 0 || allow.includes("*") || allow.includes(value);
}

function writeLocalPluginPatch(manager, id, patch) {
  if (!manager._localConfigFile) {
    throw new Error("local plugin config file not configured");
  }
  const current = readConfigFile(manager._localConfigFile);
  current.plugins = current.plugins || {};
  current.plugins[id] = {
    ...(current.plugins[id] || {}),
    ...patch,
  };
  writeConfigFile(manager._localConfigFile, current);
}

function readConfigFile(file) {
  if (!file || !fs.existsSync(file)) {
    return { plugins: {} };
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeConfigFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseSettingValue(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  try {
    return JSON.parse(text);
  } catch {
    if (/^(true|false)$/i.test(text)) {
      return /^true$/i.test(text);
    }
    if (/^-?\d+(?:\.\d+)?$/.test(text)) {
      return Number(text);
    }
    if (text.includes(",")) {
      return text.split(",").map((item) => item.trim()).filter(Boolean);
    }
    return text;
  }
}

module.exports = {
  createPluginManager,
  HOST_PLUGIN_API_VERSION,
  HOST_VERSION,
  validateManifest,
  validateSettings,
};
