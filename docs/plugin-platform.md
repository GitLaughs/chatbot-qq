# QQ Bot Plugin Platform

## Layout

Each bot feature that can be isolated should live under `plugins/<id>/`:

- `plugin.json`: manifest, defaults, hooks, permissions, and config schema.
- `index.js`: CommonJS module that exports hook functions.
- `tests/`: required plugin-local tests. Files named `*.test.js` are discovered by `scripts/test-plugins.js`.

Keep NapCat / OneBot routing and cc-connect dispatch in `scripts/onebot-group-proxy.js`; plugins should implement feature behavior, not platform transport.

## Manifest

Required fields:

- `id`
- `title`
- `version`
- `api_version`: current host contract is `1`
- `min_host_version`: minimum supported `chatbot-qq` package version
- `homepage`
- `repository`
- `keywords`
- `license`
- `config_schema`

Supported fields:

- `description`
- `priority`
- `default_enabled`
- `scope`: `group`, `private`, `both`, or `system`
- `permissions`: `{ "required": [], "optional": [] }`
- `hooks`: lifecycle hooks plus runtime hooks
- `default_settings`
- `settings_schema`: compatibility alias for `config_schema`

Runtime hooks:

- `onMessage`
- `onCommand`
- `onOutgoing`
- `onSchedule`
- `health`
- `capabilities`

Lifecycle hooks:

- `onLoad`
- `onUnload`
- `onConfigChange`
- `onInstall`
- `onHealthCheck`

`permissions` gates host API injection. Supported permissions:

- `send_message` -> `ctx.api.sendMessage`
- `exec_command` -> `ctx.api.runCommand`
- `schedule` -> `ctx.api.schedule`
- `read_workspace_file` -> `ctx.api.readWorkspaceFile`
- `write_local_file` -> `ctx.api.writeLocalFile`

`ctx.api.health` is safe and always available when the host provides it. Config schemas support `items`, `additionalProperties`, and string `pattern`; `/admin plugins set` rejects invalid values before writing local config.

Compatibility policy:

- API v1 supports the hooks and permissions listed in this document.
- A plugin with a future `api_version` or too-new `min_host_version` is loaded with manifest errors and fails the plugin gate.
- Deprecations stay documented for one host minor release before removal from API v1.

Hooks may return values directly or return a Promise when the caller uses the async plugin manager API. Runtime hooks are isolated by timeout and consecutive failure counters. After repeated failures the plugin circuit opens and the plugin is skipped until reload or config change resets the process. Plugin health is visible in `pluginManager.snapshot().plugins[].health`.

`reload()` reloads manifests and local config, clears the plugin module's `require` cache, and calls lifecycle hooks. If a load/config lifecycle hook throws, the previous registry and config are restored.

## Configuration

Config precedence:

1. plugin manifest defaults
2. compatibility defaults passed by the host
3. `configs/plugins.json`
4. `.cc-connect/plugins.local.json`

Use local config for machine-specific toggles. Do not commit secrets, provider keys, tokens, cookies, chat exports, or private memory.

## Admin Commands

Root admin private commands:

- `/admin plugins`
- `/admin plugins show <id>`
- `/admin plugins health [id]`
- `/admin plugins errors [id]`
- `/admin plugins config <id>`
- `/admin plugins test <id>`
- `/admin plugins enable <id>`
- `/admin plugins enable <id> group <gid>`
- `/admin plugins enable <id> private <uid>`
- `/admin plugins disable <id>`
- `/admin plugins disable <id> group <gid>`
- `/admin plugins disable <id> private <uid>`
- `/admin plugins set <id> <key> <value>`
- `/admin plugins reload [id]`

`enable`, `disable`, and `set` write `.cc-connect/plugins.local.json`, then reload plugin config.

## Hook Contract

Hooks receive a context object:

- `msg`, `text`, `workspace`, `groupID`, `userID`
- `settings`
- `api`
- `log`, `recordError`, `maskSensitive`

Return one of:

- `{ handled: true }`
- `{ handled: false }`
- `{ block: true, reason, reply }`
- `{ error }`

## Testing

Create a plugin:

```powershell
npm run create:plugin -- <id>
```

The scaffold creates `plugin.json`, `index.js`, `README.md`, and `tests/plugin.test.js`.

Plugin platform tests:

```powershell
npm run test:plugins
```

This runs:

- `scripts/test-plugin-manager.js`: manager contract, schema validation, permission injection, lifecycle, timeout, and admin command checks.
- `scripts/test-plugins.js`: manifest lint, config schema validation, plugin-local tests, and capability smoke checks.

Full plugin quality gate:

```powershell
npm run plugin:check
```

This adds the private-data publish audit to the plugin test suite.

New features should add plugin-specific tests and avoid expanding `scripts/test-onebot-proxy-units.js` unless the proxy transport itself changes.
