# chatbot-qq v0.2.6｜operations health report

This release adds a single JSON report command for daily operations checks and future alerting.

中文关键词：QQ 机器人巡检、运维报告、JSON 健康检查、metrics、备份状态、cc-connect QQ。

## Highlights

- Adds `scripts/get-chatbot-qq-health-report.ps1`.
- Summarizes server service states, timers, `/healthz`, `/metrics`, recent integrity/cleanup logs, and local backup health.
- Exits non-zero when the report is unhealthy, so it can be used from scheduled tasks or external monitors.
- Documents the report command in server deployment notes.

## Verify

```powershell
.\scripts\get-chatbot-qq-health-report.ps1
$env:GOPROXY="https://goproxy.cn,direct"
npm test
git diff --check
```

Expected:

- The report JSON contains `"ok": true` when server services, proxy health, metrics, and backup status are healthy.
- Go package checks pass when dependencies are reachable.
- Node and PowerShell checks pass.
- Sensitive local-data scan passes.

## Deployment Notes

- The report reads `/metrics` and `/healthz` over localhost on the server.
- Real server addresses, QQ IDs, and API keys must stay in ignored local files or operator-provided command arguments.

## Full Changelog

See `CHANGELOG.md`.
