# chatbot-qq v0.2.15｜cc-connect QQ service startup hardening

This release removes the noisy systemd startup warning from the QQ cc-connect service and makes port waiting easier to validate.

中文关键词：QQ 群机器人、systemd、Linux 防御、服务启动、OneBot 端口等待、cc-connect QQ。

## Highlights

- Adds `deploy/linux/wait-onebot-ports.sh` for waiting on configured OneBot proxy ports before starting `cc-connect`.
- Changes `cc-connect-qq.service` to call that script instead of embedding Bash arrays directly in `ExecStartPre`.
- Fixes repeated `ports[@]` systemd environment-variable warnings during service startup.
- Adds release-test shell syntax checks when a usable Bash is available.
- Keeps Windows release tests from failing on the built-in WSL launcher when no usable Linux environment exists.

## Verify

```powershell
npm test
git diff --check
```

Server-side validation:

- `bash -n /opt/chatbot-qq/deploy/linux/wait-onebot-ports.sh`
- `systemd-analyze verify /etc/systemd/system/cc-connect-qq.service`
- Restart `cc-connect-qq.service` and confirm recent logs no longer include `ports[@]`.
- `http://127.0.0.1:3010/healthz` returns HTTP 200.

## Deployment Notes

- Deploy `deploy/linux/wait-onebot-ports.sh` and `deploy/linux/cc-connect-qq.service`.
- Run `chmod 755 /opt/chatbot-qq/deploy/linux/wait-onebot-ports.sh`, `systemctl daemon-reload`, then restart `cc-connect-qq.service`.
- Real server addresses, QQ IDs, and API keys must stay in ignored local files or operator-provided command arguments.

## Full Changelog

See `CHANGELOG.md`.
