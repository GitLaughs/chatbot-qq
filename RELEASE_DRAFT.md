# chatbot-qq v0.2.18｜Cloud Linux server install refresh

This release brings the publish notes and beginner Linux installer in line with the current cloud-server deployment path for NapCat / OneBot + onebot-group-proxy + cc-connect.

中文关键词：QQ 群机器人、Linux 部署、NapCat、OneBot、cc-connect、systemd、完整性检查、权限审计。

## Highlights

- Updates the beginner Linux installer to write the current server env defaults for health checks, retry behavior, image rendering, command switches, and retention policy.
- Installs the Linux maintenance timers for code integrity checks and runtime cleanup when `--install-services` is used.
- Runs the Linux permission audit repair during service installation and refreshes the integrity baseline after intentional updates.
- Documents the optional provider-failover timer as an advanced path that should only be enabled after matching providers exist in `config.toml`.
- Refreshes the Linux install guide so first-time deploys and server updates use the same current flow.

## Verify

```powershell
npm test
git diff --check
```

Server-side validation:

- `bash -n scripts/install-linux.sh`
- `bash -n deploy/linux/chatbot-qq-integrity-check.sh`
- `bash -n deploy/linux/chatbot-qq-cleanup.sh`
- `bash ./scripts/install-linux.sh --install-services --no-npm`
- `systemctl daemon-reload`
- `systemctl restart onebot-group-proxy cc-connect-qq`
- `systemctl list-timers 'chatbot-qq-*' --no-pager`
- Confirm `http://127.0.0.1:3010/healthz` returns HTTP 200.

## Deployment Notes

- Deploy `scripts/install-linux.sh`, `docs/install-linux.zh-CN.md`, `deploy/linux/*`, `RELEASE_DRAFT.md`, and `CHANGELOG.md`.
- Run the installer once after pulling this release so service files, permissions, and the integrity baseline match the deployed code.
- Keep API keys, NapCat access tokens, provider keys, real local config, and private logs in ignored server files only.
