# chatbot-qq

QQ group routing for Codex through `cc-connect`.

[中文安装教程](docs/install.zh-CN.md) · [Linux 中文安装](docs/install-linux.zh-CN.md) · [NapCat 设置](docs/napcat-setup.md)

Keywords: QQ bot, QQ group bot, Codex group chat, NapCat, OneBot v11, cc-connect, group routing, instant acknowledgement, image command, QQ 群机器人, QQ 群聊 Codex, NapCat 机器人, OneBot, 群聊工作区。

`chatbot-qq` turns a QQ group into a practical Codex workspace:

- NapCat logs in to QQ and exposes a local OneBot v11 WebSocket endpoint;
- `onebot-group-proxy` splits allowed group, @ mention, and private routes;
- cc-connect native `qq` platform projects handle the routed messages;
- a lightweight listen route can observe allowed group messages with selective trigger rules;
- an @ route handles explicit bot-directed tasks with a stronger model;
- private user routing can use an isolated workspace;
- `/dream` and `做梦` provide bounded workspace maintenance;
- `/画图`, `/生图`, `/img`, `画图`, and `生图` provide image generation when provider keys are configured;
- plugin-scoped features live under `plugins/<id>/` and are managed by `scripts/lib/plugin-manager.js`;
- long replies and formula-heavy replies can be rendered to PNG before sending;
- Linux service, health, cleanup, and integrity-check timers keep the deployment inspectable.

This repository contains scripts, templates, and public deployment notes. It does not contain app secrets, access tokens, cookies, provider keys, NapCat local config, private logs, chat exports, or private memory files.

## Why This Exists

Most QQ chat-bot setups choose between two weak defaults:

- listen only when mentioned, which misses useful files and group context;
- listen to every message without routing, which wastes tokens and interrupts normal chat.

This project keeps the current NapCat / OneBot + onebot-group-proxy + cc-connect route as the primary path:

| Route | Model | Trigger | Job |
|---|---|---|---|
| Listen route | `gpt-5.4-mini` by default | allowed group messages with selective trigger rules | classify, stay quiet, handle light work, organize workspace context |
| @ route | `gpt-5.4` by default | explicit @ / directed tasks | handle complex tasks directly |
| Private route | `gpt-5.4` by default; admin `100000001` stays `gpt-5.5` | allowed private user messages | handle isolated private work |

Official QQ Bot code and docs remain fallback or historical reference only.

## Architecture

```mermaid
flowchart LR
    A[QQ group] --> B[NapCat login]
    B --> C[OneBot v11 WebSocket]
    C --> D[onebot-group-proxy]
    D --> E[listen port: group context]
    D --> F[@ port: directed tasks]
    D --> G[private port: private user]
    E --> H[cc-connect qq mini project]
    F --> I[cc-connect qq deep project]
    G --> J[private workspace]
    H --> K[groups/sandbox-<group-id>]
    I --> K
    K --> L[AGENTS.md + KNOWLEDGE.md + local_files + memory]
```

## Features

- NapCat / OneBot v11 bridge for QQ through cc-connect native `qq` platform.
- OneBot proxy routes group listen, @ mention, and private traffic to separate local ports.
- Low-restriction defaults for known groups and users, with selective trigger rules to avoid random chatter.
- Separate mini and deep cc-connect projects with independent session behavior.
- Optional private-user route with an isolated workspace.
- Static `/dream` / `做梦` workspace maintenance command.
- Group recurring rota reminders such as weekly duty rotation, created from chat with `/提醒 ...` or explicit @ requests.
- Platform-layer image generation commands through `scripts/generate-image.js`.
- Plugin platform with manifest validation, scoped config, admin commands, capability gates, and plugin-local tests.
- MathJax/SVG renderer for long answers and formula-heavy QQ replies.
- Health endpoint, outgoing send retry settings, and redacted diagnostics.
- Linux installer for `/opt/chatbot-qq`, `/root/.cc-connect-qq/config.toml`, and `/etc/chatbot-qq.env`.
- systemd units for `onebot-group-proxy` and `cc-connect-qq`.
- Optional Linux timers for integrity checks, runtime cleanup, and provider failover.
- Backup, restore, deployment, and health-check helper scripts.
- Private-data audit rules and publish-scope checks.
- GitHub-ready metadata: CI, changelog, release notes, notices, and security policy.

## Requirements

- Windows 10/11 or Linux with bash/systemd
- PowerShell 5.1 or PowerShell 7 for Windows installs
- Node.js 20 or newer and npm
- `cc-connect` installed globally
- NapCat logged in to QQ
- OneBot v11 WebSocket exposed locally, normally `ws://127.0.0.1:3001`
- Optional ImageMagick, librsvg2-bin, and Noto CJK fonts for PNG rendering

Install `cc-connect`:

```powershell
npm install -g cc-connect
cc-connect --version
```

## NapCat / OneBot

Start NapCat, log in to QQ, and enable OneBot v11 WebSocket.

Default local endpoint:

```text
ws://127.0.0.1:3001
```

The QQ route uses NapCat / OneBot as the active implementation path. See [docs/napcat-setup.md](docs/napcat-setup.md) for setup notes. See [docs/qqbot-auth-and-setup.md](docs/qqbot-auth-and-setup.md) only if you explicitly need the official QQ Bot fallback path.

## Quick Start

Clone this repository, then run on Windows:

```powershell
git clone https://github.com/GitLaughs/chatbot-qq.git C:\chatbot-qq
cd C:\chatbot-qq
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -NoStart
```

Start the OneBot proxy:

```powershell
$env:ONEBOT_ALLOWED_GROUPS="123456789"
$env:ONEBOT_PROXY_PORTS="3002,3003"
node .\scripts\onebot-group-proxy.js
```

Start cc-connect:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-cc-connect-napcat.ps1
```

Run on Linux:

```bash
git clone https://github.com/GitLaughs/chatbot-qq.git /opt/chatbot-qq
cd /opt/chatbot-qq
bash ./scripts/install-linux.sh --install-services
systemctl start onebot-group-proxy cc-connect-qq
```

The installer asks for:

- QQ group ID to allow;
- optional private QQ user ID;
- optional local port overrides when passed as command-line arguments.

The installer writes:

- Windows: `configs\cc-connect.napcat.local.toml`
- Linux: `/root/.cc-connect-qq/config.toml` and `/etc/chatbot-qq.env`
- `groups\sandbox-<group-id>\AGENTS.md`
- `groups\sandbox-<group-id>\KNOWLEDGE.md`
- `groups\sandbox-<group-id>\local_files\INDEX.md`
- local workspace folders for memory and imported files

## Non-Interactive Install

For repeatable Windows deployment:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 `
  -GroupId "123456789" `
  -PrivateUserId "123456789" `
  -ListenPort 3002 `
  -AtPort 3003 `
  -PrivatePort 3006 `
  -NoStart
```

Use `-NoNpmInstall` if dependencies are already installed.

Linux non-interactive install:

```bash
bash ./scripts/install-linux.sh \
  --group-id "123456789" \
  --private-user-id "123456789" \
  --listen-port 3002 \
  --at-port 3003 \
  --private-port 3006 \
  --health-port 3010 \
  --install-services
```

Use `--no-npm` if dependencies are already installed. Use `--no-maintenance` if you only want the runtime services without cleanup and integrity-check timers.

Optional provider failover timer:

```bash
bash ./scripts/install-linux.sh --install-services --enable-provider-failover --no-npm
```

Enable provider failover only after matching providers exist in `config.toml`.

## Plugins

New bot features should be packaged as plugins when practical. Built-in examples include:

- `plugins/dream`: bounded workspace maintenance triggers.
- `plugins/image`: image generation trigger handling.
- `plugins/reminder`: recurring reminder hooks.

Create a plugin scaffold:

```powershell
npm run create:plugin -- my-plugin
```

Copy `configs/plugins.example.json` to `configs/plugins.json` for shared non-secret defaults, or write machine-specific overrides to `.cc-connect/plugins.local.json`. Local plugin config can enable/disable plugins, scope groups or private users, and tune settings without adding more top-level `ONEBOT_*` globals.

Useful checks:

```powershell
npm run test:plugins
npm run plugin:check
```

See [docs/plugin-platform.md](docs/plugin-platform.md) for manifest fields, hook contracts, permissions, admin commands, and testing rules.

## OpenToken Subscription Monitor

Use `scripts/monitor-opentoken-subscriptions.js` to read otokapi.com purchase plans and send a chat alert when a configured price or ratio field is below the threshold. It only calls the read-only payment plans endpoint and does not call payment or order APIs. If no token is configured, the script can reuse the local Chrome/Edge `otokapi.com` login token for this read-only check.

```powershell
$env:LARK_CHAT_ID = "oc_xxx"
npm run monitor:opentoken-subscriptions -- --list-only
npm run monitor:opentoken-subscriptions -- --dry-run --threshold 10
npm run monitor:opentoken-subscriptions -- --watch --threshold 0.05
```

See [docs/opentoken-subscription-monitor.md](docs/opentoken-subscription-monitor.md) for webhook, loop, and scheduled-task usage.

## Expected Chat Behavior

Normal group message:

1. NapCat receives the QQ event;
2. `onebot-group-proxy` accepts it only for allowed groups;
3. the listen route applies selective trigger rules;
4. casual chat stays quiet;
5. actionable work can enter the group workspace.

Directed group task:

1. user sends an explicit @ or bot-directed request;
2. the @ route sends it to the deep project;
3. long answers can be rendered as QQ images when rendering is configured;
4. related replies continue in the same workspace context.

Private task:

1. an allowed private user sends a message;
2. the private route uses its own local workspace;
3. group context and private context stay separate.

Static commands:

- `/dream` and `做梦`: run bounded workspace maintenance.
- `/画图`, `/生图`, `/img`, `画图`, and `生图`: call image generation when provider keys are configured.
- `/提醒 每周日晚上7点 A、B、C、D 分别干拖地、厕所、洗手台、轮休`: create a weekly group rota reminder. The proxy checks due reminders itself and sends them to the group.

Background profile updater:

- `chatbot-qq-profile-update.timer` runs every 3 hours on Linux deployments.
- It invokes `scripts/update-user-profiles.sh --all` with `gpt-5.5` and medium reasoning.
- It silently reads recent group/private `memory/chat-*.jsonl` records and updates only local group/member/private profile files.
- Workspaces are skipped when no chat record is newer than the latest successful profile update.

Image generation needs an OpenAI-compatible image API key in the service environment, for example:

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=replace-me
ONEBOT_IMAGE_API_MODE=auto
ONEBOT_IMAGE_IMAGES_MODEL=gpt-image-1
```

For cc-switch OpenToken rotation, sync keys with `scripts/sync-server-keys-from-ccswitch.ps1`.
It writes up to four healthy OpenToken keys into `OPENAI_IMAGE_API_KEYS`, and the OneBot proxy leases one key per image job.

## Verify

After installing and logging in through NapCat:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-cc-connect-napcat.ps1
cc-connect sessions list
```

For server checks:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\get-chatbot-qq-health-report.ps1
```

Expected:

- NapCat exposes OneBot v11 on `127.0.0.1:3001`;
- `onebot-group-proxy` exposes the configured local ports;
- cc-connect starts with the generated QQ config;
- allowed group messages reach the group workspace;
- @ tasks reach the deep route;
- private messages route only for allowed private users;
- private-data audit finds no committed secrets or local runtime files.

## Project Layout

```text
.
  cmd/
    qqbot-adapter/
  internal/
    adapter/
    config/
    qqbot/
  configs/
    cc-connect.napcat.example.toml
    cc-connect.napcat.server.example.toml
    plugins.example.json
    private-data-audit-rules.json
  deploy/
    linux/
  docs/
    install.zh-CN.md
    install-linux.zh-CN.md
    napcat-setup.md
    qqbot-integration-plan.md
    server-deploy.md
  groups/
    default/
  plugins/
    dream/
    image/
    reminder/
  scripts/
    install.ps1
    install-linux.sh
    onebot-group-proxy.js
    generate-image.js
    render-qq-card-imagemagick.js
    provider-failover.py
    test.ps1
  .github/
    workflows/ci.yml
```

## Documentation

- [中文安装教程](docs/install.zh-CN.md)
- [Linux 中文安装教程](docs/install-linux.zh-CN.md)
- [NapCat setup](docs/napcat-setup.md)
- [Server deploy](docs/server-deploy.md)
- [Plugin platform](docs/plugin-platform.md)
- [QQ bot integration plan](docs/qqbot-integration-plan.md)
- [Official QQ Bot fallback setup](docs/qqbot-auth-and-setup.md)
- [Daily group product plan](docs/daily-group-product-plan.md)
- [Self-iteration memory plan](docs/self-iteration-memory-plan.md)
- [Optimization report 2026-05-23](docs/optimization-report-2026-05-23.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Security

Never commit app secrets, access tokens, cookies, provider keys, NapCat local config, private logs, chat exports, or private memory files.

QQ numbers and group IDs are routing metadata for this self-use bot, but generated configs and runtime workspaces still belong in ignored local files. The repository `.gitignore` excludes generated local config, logs, databases, runtime folders, NapCat local files, QR codes, and private workspace files.

## Status

Preview. The active implementation path is NapCat / OneBot v11 + onebot-group-proxy + cc-connect. Official QQ Bot material is fallback or historical reference unless explicitly requested.

## Acknowledgements

This project is built as a QQ deployment layer around
[cc-connect](https://github.com/chenhg5/cc-connect), an MIT-licensed open-source
bridge for connecting local AI coding agents to messaging platforms. `cc-connect`
provides the platform bridge, session management, hooks, and stream behavior that
this repository configures for QQ through NapCat / OneBot.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [NOTICE](NOTICE) for
license boundaries and attribution.

## License

MIT. See [LICENSE](LICENSE).
