# chatbot-qq v0.2.7｜scheduled health reports

This release turns the operations health report into a daily local artifact and makes the default report safer to share.

中文关键词：QQ 机器人巡检、每日健康报告、Windows 计划任务、脱敏报告、LATEST.json、cc-connect QQ。

## Highlights

- Adds `-InstallScheduledTask` to `scripts/get-chatbot-qq-health-report.ps1`.
- Writes health reports to `backup/health-reports` with a `LATEST.json` pointer.
- Retains health report history with a configurable keep-days window.
- Redacts QQ numeric identifiers from health report output by default.
- Updates the server check script to print a compact latest-health-report summary by default.

## Verify

```powershell
.\scripts\get-chatbot-qq-health-report.ps1 -InstallScheduledTask
.\scripts\get-chatbot-qq-health-report.ps1
$env:GOPROXY="https://goproxy.cn,direct"
npm test
git diff --check
```

Expected:

- The scheduled task `CHATBOT-QQ daily health report` is installed.
- `backup/health-reports/LATEST.json` is created.
- The report JSON contains `"ok": true` when services, proxy health, metrics, and backup status are healthy.
- Sensitive numeric QQ identifiers are redacted unless `-IncludeSensitive` is explicitly used.

## Deployment Notes

- The default scheduled time is 04:00, after the default 03:40 backup task.
- Keep raw sensitive operational data in ignored local files only.

## Full Changelog

See `CHANGELOG.md`.
