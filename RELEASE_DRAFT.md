# chatbot-qq v0.2.4｜metrics and backup status

This release adds lightweight operational visibility for the QQ proxy and local server backups.

中文关键词：QQ 机器人监控、Prometheus metrics、健康检查、本地自动备份、Linux 清理任务、cc-connect QQ。

## Highlights

- Adds `/metrics` next to `/healthz` and `/readyz` for Prometheus-style counters.
- Exposes upstream readiness, port connectivity, pending queues, file archive counters, listen queues, and image job counters.
- Writes `LATEST.json` after each local server backup with archive path, size, timestamp, server, and SHA256.
- Shows local backup status from `scripts/check-napcat-server.ps1`.
- Limits cleanup log pruning to top-level QQ log files under `/var/log`, avoiding unrelated system log directory permission noise.

## Verify

```powershell
$env:GOPROXY="https://goproxy.cn,direct"
npm test
git diff --check
```

Runtime checks:

```bash
curl -fsS http://127.0.0.1:3010/metrics
curl -fsS http://127.0.0.1:3010/healthz
```

## Deployment Notes

- `/metrics` is bound to the same local health host as `/healthz`; keep it on localhost unless you intentionally front it with an authenticated monitor.
- Backup status is written beside backup archives as `LATEST.json`.
- Real QQ group IDs, private user IDs, API keys, and NapCat tokens must stay in ignored local files or `/etc/chatbot-qq.env`.

## Full Changelog

See `CHANGELOG.md`.
