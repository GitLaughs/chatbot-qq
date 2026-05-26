const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { createPluginManager, validateManifest, validateSettings } = require("./lib/plugin-manager");

const root = path.join(__dirname, "..");
const pluginsRoot = path.join(root, "plugins");
const onlyID = cliValue("--id") || cliValue("-p") || "";
const requiredContractFields = [
  "id",
  "title",
  "version",
  "api_version",
  "min_host_version",
  "homepage",
  "repository",
  "keywords",
  "license",
  "config_schema",
];

function main() {
  const manifests = pluginManifests();
  assert.ok(manifests.length > 0, "no plugins found");
  for (const item of manifests) {
    lintManifest(item);
    lintConfigSchema(item);
  }
  runManagerSmoke(manifests);
  runLocalPluginTests(manifests);
  console.log(`plugin checks ok (${manifests.length} plugins)`);
}

function pluginManifests() {
  if (!fs.existsSync(pluginsRoot)) {
    return [];
  }
  const items = fs.readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(pluginsRoot, entry.name);
      const manifestPath = path.join(dir, "plugin.json");
      if (!fs.existsSync(manifestPath)) {
        throw new Error(`missing plugin.json: ${path.relative(root, dir)}`);
      }
      return {
        id: entry.name,
        dir,
        manifestPath,
        manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
      };
    });
  return onlyID ? items.filter((item) => item.id === onlyID) : items;
}

function lintManifest(item) {
  const { manifest } = item;
  const errors = validateManifest(manifest);
  assert.deepStrictEqual(errors, [], `${item.id} manifest invalid: ${errors.join("; ")}`);
  for (const field of requiredContractFields) {
    assert.ok(hasValue(manifest[field]), `${item.id} missing ${field}`);
  }
  assert.strictEqual(manifest.id, item.id, `${item.id} id must match directory`);
  assert.ok(Array.isArray(manifest.keywords), `${item.id} keywords must be an array`);
  assert.ok(manifest.keywords.length > 0, `${item.id} keywords required`);
  assert.ok(manifest.permissions && typeof manifest.permissions === "object", `${item.id} permissions object required`);
  assert.ok(Array.isArray(manifest.permissions.required), `${item.id} permissions.required required`);
  assert.ok(Array.isArray(manifest.permissions.optional), `${item.id} permissions.optional required`);
  assert.ok(Array.isArray(manifest.hooks), `${item.id} hooks must be an array`);
  assert.ok(fs.existsSync(path.join(item.dir, manifest.main || "index.js")), `${item.id} main module missing`);
}

function lintConfigSchema(item) {
  const schema = item.manifest.config_schema;
  assert.ok(schema && schema.type === "object", `${item.id} config_schema.type must be object`);
  assert.strictEqual(schema.additionalProperties, false, `${item.id} config_schema.additionalProperties must be false`);
  const defaults = item.manifest.default_settings || {};
  const errors = validateSettings(defaults, schema);
  assert.deepStrictEqual(errors, [], `${item.id} default_settings invalid: ${errors.join("; ")}`);
}

function runManagerSmoke() {
  const manager = createPluginManager({ pluginDirs: [pluginsRoot] });
  const snapshot = manager.snapshot();
  for (const item of pluginManifests()) {
    const row = snapshot.plugins.find((plugin) => plugin.id === item.id);
    assert.ok(row, `${item.id} missing from plugin manager snapshot`);
    assert.deepStrictEqual(row.errors || [], [], `${item.id} manager errors: ${(row.errors || []).join("; ")}`);
  }
}

function runLocalPluginTests(manifests) {
  for (const item of manifests) {
    const testsDir = path.join(item.dir, "tests");
    assert.ok(fs.existsSync(testsDir), `${item.id} missing tests directory`);
    const tests = fs.readdirSync(testsDir)
      .filter((name) => /\.test\.js$/i.test(name))
      .map((name) => path.join(testsDir, name));
    assert.ok(tests.length > 0, `${item.id} has no *.test.js files`);
    for (const file of tests) {
      const result = spawnSync(process.execPath, [file], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.strictEqual(result.status, 0, `${path.relative(root, file)} failed\n${result.stdout}\n${result.stderr}`);
    }
  }
}

function hasValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function cliValue(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) {
    return String(process.argv[index + 1] || "").trim();
  }
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => String(arg).startsWith(prefix));
  return match ? String(match).slice(prefix.length).trim() : "";
}

main();
