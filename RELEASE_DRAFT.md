# chatbot-qq v0.2.18｜Cloud Linux server install refresh

This release brings the publish notes and beginner Linux installer in line with the current cloud-server deployment path for NapCat / OneBot + onebot-group-proxy + cc-connect.

中文关键词：QQ 群机器人、Linux 部署、NapCat、OneBot、cc-connect、systemd、完整性检查、权限审计。

## Highlights

- Updates the beginner Linux installer to write the current server env defaults for health checks, retry behavior, image rendering, command switches, and retention policy.
- Installs the Linux maintenance timers for code integrity checks and runtime cleanup when `--install-services` is used.
- Runs the Linux permission audit repair during service installation and refreshes the integrity baseline after intentional updates.
- Documents the optional provider-failover timer as an advanced path that should only be enabled after matching providers exist in `config.toml`.
- Refreshes the Linux install guide so first-time deploys and server updates use the same current flow.

## Required Runtime

This release packages deployment templates and helper scripts for the NapCat / OneBot + onebot-group-proxy + cc-connect route. The bundled Linux service and timer units require a systemd host with Node.js, npm, cc-connect, and a local OneBot v11 WebSocket endpoint from NapCat. Image rendering for long replies and formula-heavy replies requires ImageMagick and a CJK font such as Noto CJK on the host.

## Verify

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test.ps1
git diff --check
```

Expected:

- Go tests, Node syntax checks, OneBot proxy unit checks, and private-data audit checks pass.
- Linux install checks run when a usable bash exists; otherwise they are skipped by the Windows test wrapper.
- The private-data audit passes for the publish scope, with only allowed example/runtime findings.

## Attribution

This project is a QQ deployment/configuration layer around
[cc-connect](https://github.com/chenhg5/cc-connect), which is MIT licensed.
See `NOTICE` and `THIRD_PARTY_NOTICES.md`.
