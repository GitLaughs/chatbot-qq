# chatbot-qq

[![CI](https://github.com/GitLaughs/chatbot-qq/actions/workflows/ci.yml/badge.svg)](https://github.com/GitLaughs/chatbot-qq/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/GitLaughs/chatbot-qq)](https://github.com/GitLaughs/chatbot-qq/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

QQ bot workspace for cc-connect through NapCat / OneBot v11, with official QQ Bot APIs kept as the preferred long-term path.

[中文安装教程](docs/install.zh-CN.md) · [Linux 中文安装](docs/install-linux.zh-CN.md) · [NapCat 设置](docs/napcat-setup.md) · [官方 QQ Bot 备用方案](docs/qqbot-auth-and-setup.md)

Keywords: QQ bot, QQ group bot, cc-connect, Codex QQ bot, NapCat, OneBot v11, QQ official bot API, group workspace, private chat routing, image generation, QQ机器人, QQ群机器人, QQ 群聊 Codex, NapCat 机器人, OneBot 机器人, cc-connect QQ, 群聊工作区, 私聊路由, 做梦, 画图。

`chatbot-qq` packages the QQ side of a cc-connect bot deployment:

- NapCat / OneBot v11 bridge into cc-connect native `qq` platform.
- Group listen and @ routes for light monitoring plus deeper direct tasks.
- Optional private chat route for allowlisted users.
- `/dream` workspace maintenance and `/画图` image generation helpers.
- Linux systemd deployment templates isolated from Feishu or other cc-connect services.
- Official QQ Bot Go adapter kept isolated as a fallback experiment.

This repository contains scripts and templates only. It does not contain app secrets, QQ openids, group IDs, chat logs, QR codes, NapCat runtime data, or generated local configs.

## Why This Exists

QQ bot deployment is split between two worlds:

| Path | Best Use | Status |
|---|---|---|
| QQ official bot API | long-term production route | preferred when gateway access works |
| NapCat / OneBot v11 | practical local/server bridge | current working route |

This repo keeps those paths separate so a working NapCat deployment does not block a future official QQ Bot adapter.

## Layout

- `cmd/qqbot-adapter` - runnable adapter entrypoint
- `internal/qqbot` - QQ official API and gateway client
- `internal/adapter` - normalized message model and webhook forwarder
- `configs/cc-connect.napcat.example.toml` - cc-connect NapCat / OneBot config template
- `configs/cc-connect.qqbot.example.toml` - cc-connect QQ Bot config template
- `configs/qqbot.example.toml` - custom Go adapter config template
- `groups/default` - default QQ bot workspace
- `groups/sandbox-<group-id>` - local QQ sandbox group workspaces, ignored by git
- `groups/*/scripts/dream.*` - `/dream` / `做梦` local workspace maintenance command, backed by `gpt-5.5`
- `scripts/generate-image.js` - `/画图` / `/生图` / `/img` image generation helper for QQ groups
- `scripts` - local start and health-check scripts
- `docs/qqbot-integration-plan.md` - phased integration plan
- `docs/napcat-setup.md` - NapCat / OneBot setup guide
- `docs/qqbot-auth-and-setup.md` - official QQ Bot fallback guide
- `docs/server-deploy.md` - Linux server deployment notes and conflict checklist
- `deploy/linux` - isolated systemd/env templates for the Linux NapCat route

## Requirements

- Windows 10/11 with PowerShell 5.1+ or Linux with bash/systemd
- Node.js 20+ and npm
- `cc-connect` installed and available on `PATH`
- NapCat exposing OneBot v11 WebSocket at `ws://127.0.0.1:3001`
- A QQ account/bot allowed to join the target group

Install cc-connect:

```powershell
npm install -g cc-connect
cc-connect --version
```

## Quick Start

```powershell
git clone https://github.com/GitLaughs/chatbot-qq.git
cd chatbot-qq
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Linux:

```bash
git clone https://github.com/GitLaughs/chatbot-qq.git
cd chatbot-qq
bash ./scripts/install-linux.sh
```

Start NapCat first, log in with QQ, and enable OneBot v11 WebSocket at `ws://127.0.0.1:3001`. Put real group IDs, private user IDs, tokens, and provider keys only in ignored local config or server env files.

## Server Deploy

For Linux deployment, read `docs/install-linux.zh-CN.md` and `docs/server-deploy.md` first. Prefer the official QQ Bot path when available. If using NapCat on Linux, install the Node dependency with `npm install --omit=dev` and do not deploy any bundled Windows NapCat package under `tools/`.

Current server plan uses NapCat / OneBot with separate services:

```powershell
.\scripts\deploy-napcat-server.ps1 -InstallServices
.\scripts\check-napcat-server.ps1
```

The deployment uses `/opt/chatbot-qq`, `/root/.cc-connect-qq/config.toml`, `onebot-group-proxy.service`, and `cc-connect-qq.service`. It does not modify the existing Feishu `cc-connect.service`.
