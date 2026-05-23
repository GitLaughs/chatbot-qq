# chatbot-qq v0.2.8｜integrity status reporting

This release makes Linux code integrity checks visible to automation instead of only writing log lines.

中文关键词：QQ 机器人防护、代码完整性、SHA256 manifest、status.json、运维报告、cc-connect QQ。

## Highlights

- Writes `/var/lib/chatbot-qq-integrity/status.json` after integrity initialization, successful verification, or drift detection.
- Includes integrity status in the operations health report.
- Fails the operations report when integrity status is missing or reports drift.
- Shows integrity summary in `scripts/check-napcat-server.ps1`.

## Verify

```bash
systemctl start chatbot-qq-integrity-check.service
cat /var/lib/chatbot-qq-integrity/status.json
```

```powershell
.\scripts\get-chatbot-qq-health-report.ps1
$env:GOPROXY="https://goproxy.cn,direct"
npm test
git diff --check
```

Expected:

- Integrity status reports `"ok": true` and state `ok` after a verification run.
- The operations report contains `"ok": true` only when service health, backup health, and integrity status are all healthy.

## Deployment Notes

- Rebuild the manifest after intentional deployment by deleting `/var/lib/chatbot-qq-integrity/sha256sums.txt` and running the integrity check once.
- Treat `state: "drift"` as a production incident unless it follows an intentional deployment.

## Full Changelog

See `CHANGELOG.md`.
