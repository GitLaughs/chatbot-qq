# chatbot-qq v0.2.11｜local health alert markers

This release adds local alert markers for scheduled operations health reports, so failures leave an obvious file-level signal on the operator machine.

中文关键词：QQ 机器人运维告警、健康报告、计划任务、Linux 防护、cc-connect QQ。

## Highlights

- `scripts/get-chatbot-qq-health-report.ps1` now writes alert state under `backup\health-alerts` by default.
- `ALERT.json` is updated on every run with `active`, `time`, `server`, `failures`, and `report`.
- `ACTIVE.txt` exists only when the latest health report is failing.
- Timestamped `chatbot-qq-health-alert-*.txt` files preserve short failure summaries for later inspection.
- Successful reports automatically clear `ACTIVE.txt`.

## Verify

```powershell
.\scripts\get-chatbot-qq-health-report.ps1
(Get-Content -Raw .\backup\health-alerts\ALERT.json | ConvertFrom-Json).active
$env:GOPROXY="https://goproxy.cn,direct"
npm test
git diff --check
```

Expected:

- A healthy run writes `ALERT.json` with `active: false`.
- `ACTIVE.txt` is absent after a healthy run.
- A failing run with `-NoExit` writes `ACTIVE.txt` and a timestamped alert summary.

## Deployment Notes

- This release is especially relevant for unattended Windows scheduled tasks, where operators need a simple persistent signal after a failed run.
- Real server addresses, QQ IDs, and API keys must stay in ignored local files or operator-provided command arguments.

## Full Changelog

See `CHANGELOG.md`.
