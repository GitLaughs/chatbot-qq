# chatbot-qq v0.2.20｜Public privacy scrub and plugin release

This release refreshes the public QQ adapter package for NapCat / OneBot + onebot-group-proxy + cc-connect, with sanitized examples, current plugin-platform notes, and beginner install guidance.

中文关键词：QQ 群机器人、Linux 部署、NapCat、OneBot、cc-connect、systemd、完整性检查、权限审计。

## Highlights

- Redacts real QQ user IDs, group IDs, local Windows paths, and startup-wrapper paths from public examples and docs.
- Updates README and beginner install commands to match the public `GitLaughs/chatbot-qq` repository format.
- Includes plugin manager and plugin-scoped configuration updates for new QQ bot features.
- Keeps NapCat / OneBot + onebot-group-proxy + cc-connect as the primary implementation path.
- Updates publish validation so the release is checked for secrets, local config, runtime logs, private memory, and path leakage.

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
