# chatbot-qq v0.1.0｜cc-connect QQ adapter workspace

Packages the initial QQ adapter workspace for cc-connect bots.

中文关键词：QQ 机器人、cc-connect QQ、NapCat、OneBot v11、QQ群机器人、QQ Bot、双路由、群聊工作区、做梦、画图、Linux 部署。

## Highlights

- Adds a NapCat / OneBot v11 route for cc-connect native `qq` platform use.
- Adds per-group listen and @ proxy routing, passive listen gating, and reply routing.
- Adds optional `/dream` group workspace maintenance and `/画图` image generation helpers.
- Keeps official QQ Bot gateway support as a Go adapter fallback experiment.
- Adds isolated Linux service templates so QQ deployment does not overwrite an existing Feishu cc-connect service.
- Adds release validation and public-data cleanup for logs, QR codes, NapCat binaries, backups, sandbox workspaces, member files, and chat memories.

## Install

Windows:

```powershell
Copy-Item configs\cc-connect.napcat.example.toml configs\cc-connect.napcat.local.toml
.\scripts\start-cc-connect-napcat.ps1
```

Linux:

```powershell
.\scripts\deploy-napcat-server.ps1 -InstallServices
```

Set real QQ group IDs and secrets only in ignored local config or `/etc/chatbot-qq.env`.

## Verify

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test.ps1
git diff --check
```

## Attribution

This project is a deployment/configuration layer around
[cc-connect](https://github.com/chenhg5/cc-connect), which is MIT licensed.
NapCat / OneBot support is adapter-side integration and should be treated as
separate from QQ official bot APIs.

## Full Changelog

See `CHANGELOG.md`.
