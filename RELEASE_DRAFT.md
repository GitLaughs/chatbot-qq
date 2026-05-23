# chatbot-qq v0.2.1｜beginner installers and checksum fix

Packages beginner installation flows and public-facing repository polish for the QQ cc-connect adapter workspace, with Go module checksums included for CI.

中文关键词：QQ 机器人、cc-connect QQ、NapCat、OneBot v11、QQ群机器人、QQ Bot、双路由、群聊工作区、做梦、画图、Linux 部署。

## Highlights

- Adds a Windows beginner installer for generating local cc-connect QQ config and workspace folders.
- Adds a Linux beginner installer for `/root/.cc-connect-qq`, `/etc/chatbot-qq.env`, and isolated systemd services.
- Adds Chinese Windows and Linux installation guides.
- Refreshes README with badges, keywords, requirements, quick start, and clearer architecture context.
- Adds GitHub release config, issue templates, PR template, and repository metadata guidance.
- Sanitizes public examples so real group IDs, private user IDs, and placeholder keys stay out of the release.
- Adds `go.sum` so Go validation runs cleanly on GitHub Actions.

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

Expected:

- Node syntax checks pass.
- PowerShell parser checks pass.
- Sensitive local-data scan passes.
- Go tests run when Go is installed locally; CI installs Go before running the same test script.

## Attribution

This project is a deployment/configuration layer around
[cc-connect](https://github.com/chenhg5/cc-connect), which is MIT licensed.
NapCat / OneBot support is adapter-side integration and should be treated as
separate from QQ official bot APIs.

## Full Changelog

See `CHANGELOG.md`.
