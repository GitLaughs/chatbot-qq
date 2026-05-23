# chatbot-qq v0.2.10｜self-refreshing health reports

This release makes daily operations health reports actively refresh server-side defenses before reporting status.

中文关键词：QQ 机器人防护、Linux 完整性检查、权限审计自动修复、健康报告、cc-connect QQ。

## Highlights

- `scripts/get-chatbot-qq-health-report.ps1` now triggers a fresh Linux integrity check before reading `/var/lib/chatbot-qq-integrity/status.json`.
- The same report now runs the permission audit with `--fix` before reading `/var/lib/chatbot-qq-integrity/permissions.json`.
- Refresh results are included in the JSON report under `refresh.integrity` and `refresh.permissions`.
- The report fails if either refresh command fails, preventing stale green reports.

## Verify

```bash
systemctl start chatbot-qq-integrity-check.service
/opt/chatbot-qq/deploy/linux/chatbot-qq-permission-audit.sh --fix
```

```powershell
.\scripts\get-chatbot-qq-health-report.ps1
$env:GOPROXY="https://goproxy.cn,direct"
npm test
git diff --check
```

Expected:

- `refresh.integrity.ok` and `refresh.permissions.ok` are both `true`.
- Integrity and permission status report `state: "ok"`.
- The operations report remains healthy only when service, backup, metrics, integrity, permission, and refresh checks all pass.

## Deployment Notes

- This release is especially relevant for daily scheduled reports, because each report validates current server state instead of trusting the last timer output.
- Real server addresses, QQ IDs, and API keys must stay in ignored local files or operator-provided command arguments.

## Full Changelog

See `CHANGELOG.md`.
