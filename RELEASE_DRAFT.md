# chatbot-qq v0.2.9｜permission hardening audit

This release tightens deployed Linux file permissions and makes permission drift visible in daily health reports.

中文关键词：QQ 机器人防护、Linux 权限审计、代码保护、配置保护、健康报告、cc-connect QQ。

## Highlights

- Adds `deploy/linux/chatbot-qq-permission-audit.sh`.
- Deployment runs permission repair after extracting archives from Windows.
- Critical code paths are checked for group/other writability.
- `/etc/chatbot-qq.env`, `/root/.cc-connect-qq`, and `/root/.cc-connect-qq/config.toml` are checked for restrictive modes.
- Permission audit status is included in the operations health report and server check summary.

## Verify

```bash
/opt/chatbot-qq/deploy/linux/chatbot-qq-permission-audit.sh --fix
cat /var/lib/chatbot-qq-integrity/permissions.json
```

```powershell
.\scripts\get-chatbot-qq-health-report.ps1
$env:GOPROXY="https://goproxy.cn,direct"
npm test
git diff --check
```

Expected:

- Permission status reports `"ok": true`, `state: "ok"`, and `violation_count: 0`.
- Critical code files are not group/other writable.
- The operations report remains healthy only when service, backup, integrity, and permission checks all pass.

## Deployment Notes

- This release is especially relevant when deploying from Windows archives, which can otherwise leave Linux files too permissive.
- Real server addresses, QQ IDs, and API keys must stay in ignored local files or operator-provided command arguments.

## Full Changelog

See `CHANGELOG.md`.
