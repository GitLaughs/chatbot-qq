# chatbot QQ

QQ bot workspace for cc-connect.

Current target: QQ through NapCat / OneBot v11 into cc-connect native `qq` platform. Official QQ Bot material remains fallback or historical reference, not the active implementation direction.

## Layout

- `cmd/qqbot-adapter` - runnable adapter entrypoint
- `internal/qqbot` - QQ official API and gateway client
- `internal/adapter` - normalized message model and webhook forwarder
- `configs/cc-connect.napcat.example.toml` - cc-connect NapCat / OneBot config template
- `configs/cc-connect.qqbot.example.toml` - cc-connect QQ Bot config template
- `configs/qqbot.example.toml` - custom Go adapter config template
- `groups/default` - default QQ bot workspace
- `groups/sandbox-1107099585` - QQ sandbox group workspace
- `groups/*/scripts/dream.*` - `/dream` / `做梦` local workspace maintenance command, backed by `gpt-5.5`
- `scripts/generate-image.js` - `/画图` / `/生图` / `/img` image generation helper for QQ groups
- `scripts` - local start and health-check scripts
- `docs/qqbot-integration-plan.md` - phased integration plan
- `docs/napcat-setup.md` - NapCat / OneBot setup guide
- `docs/qqbot-auth-and-setup.md` - official QQ Bot fallback guide
- `docs/server-deploy.md` - Linux server deployment notes and conflict checklist
- `deploy/linux` - isolated systemd/env templates for the Linux NapCat route

## Quick Start

```powershell
cd E:\CHATBOT-QQ
Copy-Item configs\cc-connect.napcat.example.toml configs\cc-connect.napcat.local.toml
.\scripts\start-cc-connect-napcat.ps1
```

Start NapCat first, log in with QQ, and enable OneBot v11 WebSocket at `ws://127.0.0.1:3001`. Current sandbox group is `1107099585`.

## Server Deploy

For Linux deployment, read `docs/server-deploy.md` first. The active server route is NapCat / OneBot with `onebot-group-proxy`. Install the Node dependency with `npm install --omit=dev` and do not deploy the bundled Windows NapCat package under `tools/`.

Current server plan uses NapCat / OneBot with separate services:

```powershell
.\scripts\deploy-napcat-server.ps1 -InstallServices
.\scripts\check-napcat-server.ps1
```

The deployment uses `/opt/chatbot-qq`, `/root/.cc-connect-qq/config.toml`, `onebot-group-proxy.service`, and `cc-connect-qq.service`. It does not modify the existing Feishu `cc-connect.service`.
