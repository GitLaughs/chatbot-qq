# chatbot-qq v0.2.5｜backup health checks

This release makes local server backups directly verifiable instead of only producing archives.

中文关键词：QQ 机器人备份、备份校验、SHA256、Windows 计划任务、本地巡检、cc-connect QQ。

## Highlights

- Adds `scripts/check-backup-status.ps1`.
- Validates latest backup age, archive existence, byte count, SHA256, and scheduled task state.
- Integrates backup health checks into `scripts/check-napcat-server.ps1`.
- Documents the backup check command in server deployment notes.

## Verify

```powershell
.\scripts\check-backup-status.ps1
$env:GOPROXY="https://goproxy.cn,direct"
npm test
git diff --check
```

Expected:

- Backup status reports `OK` when the latest archive is fresh and matches `LATEST.json`.
- Go package checks pass when dependencies are reachable.
- Node and PowerShell checks pass.
- Sensitive local-data scan passes.

## Deployment Notes

- `check-backup-status.ps1` defaults to a 30-hour freshness window, suitable for a daily backup task.
- A task that has not run yet is allowed if the latest manual backup is fresh and valid.
- Real server addresses, QQ IDs, and API keys must stay in ignored local files or operator-provided command arguments.

## Full Changelog

See `CHANGELOG.md`.
