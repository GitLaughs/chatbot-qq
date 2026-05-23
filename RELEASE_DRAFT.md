# chatbot-qq v0.2.2｜runtime hardening and @-only group routing

This release hardens the NapCat / OneBot runtime path for the QQ cc-connect adapter and adds regression checks around the production routing rules.

中文关键词：QQ 机器人、cc-connect QQ、NapCat、OneBot v11、QQ群 @ 触发、Linux 防护、自动备份、完整性校验、文件归档。

## Highlights

- Adds reusable proxy modules for commands, health snapshots, and persistent state.
- Keeps an @-only group on its @ proxy only; no passive listen proxy is opened for that group.
- Silences cc-connect idle/session rollover messages before they reach QQ chats.
- Handles group file uploads at the proxy layer so files are archived and indexed before users ask for summaries or extraction.
- Adds outbound retry tracking for OneBot send actions.
- Adds Linux systemd hardening for the QQ proxy and cc-connect QQ services.
- Adds integrity-check and cleanup timers for deployed runtime code and generated artifacts.
- Adds Windows backup, restore, and dry-run restore scripts for server data.
- Adds unit checks and extends the release test script to cover @-only routing behavior.

## Verify

```powershell
$env:GOPROXY="https://goproxy.cn,direct"
npm test
git diff --check
```

Expected:

- Go package checks pass when dependencies are reachable.
- Node syntax checks pass.
- OneBot proxy unit checks pass.
- PowerShell parser checks pass.
- Sensitive local-data scan passes.

## Deployment Notes

- Real QQ group IDs, private user IDs, API keys, and NapCat tokens must stay in ignored local files or `/etc/chatbot-qq.env`.
- Public examples use placeholder IDs only.
- After deploying intentional code changes to Linux, rebuild the integrity baseline before relying on the drift timer.

## Full Changelog

See `CHANGELOG.md`.
