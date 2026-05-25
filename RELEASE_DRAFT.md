# chatbot-qq v0.2.19｜Task agent and beginner install refresh

This release publishes the current NapCat / OneBot + onebot-group-proxy + cc-connect update with public examples sanitized for GitHub.

中文关键词：QQ 群机器人、NapCat、OneBot、cc-connect、自然语言任务、文件产物、Linux 新手安装、证据包、画像更新。

## Highlights

- Adds the natural-language task agent surface: reminders, weekly rota, file modification, script generation, deploy/restart confirmation, task receipts, and upload outbox tracking.
- Improves `/help` with grouped message-box-friendly output and keyword search.
- Adds compact evidence packets and JSONL sharding for profile updates and dream reviews.
- Updates the beginner Linux installer and example env with task-agent, artifact executor, deploy confirmation, profile update, and evidence-packet settings.
- Keeps public configs and docs on placeholder QQ IDs and generic install paths instead of local runtime details.

## Required Runtime

The primary route remains NapCat / OneBot v11 + onebot-group-proxy + cc-connect. Linux service installs expect systemd, Node.js, npm, cc-connect, and a local NapCat OneBot v11 WebSocket endpoint. Long replies and formula-heavy replies still need ImageMagick plus a CJK font.

## Verify

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test.ps1
git diff --check
node scripts/audit-private-data.js --scope Publish
```

Expected:

- Go tests, Node syntax checks, OneBot proxy unit checks, task canaries, and private-data audit checks pass.
- Linux shell checks run when a usable Bash exists; otherwise the Windows wrapper skips them.
- Publish audit passes with only allowed example/runtime findings.

## Attribution

This project is a QQ deployment/configuration layer around
[cc-connect](https://github.com/chenhg5/cc-connect), which is MIT licensed.
See `NOTICE` and `THIRD_PARTY_NOTICES.md`.
