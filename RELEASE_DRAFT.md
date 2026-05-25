# chatbot-qq v0.2.21｜Privacy-clean public sync

This release syncs the current private QQ adapter workspace into the public package after removing ignored local config, runtime memory, dependency folders, and other private leftovers from the publish workspace.

中文关键词：QQ 群机器人、Linux 部署、NapCat、OneBot、cc-connect、systemd、完整性检查、权限审计。

## Highlights

- Redacts real QQ user IDs, group IDs, local Windows paths, and startup-wrapper paths from public examples and docs.
- Updates README and the Windows beginner guide with plugin configuration, plugin checks, and publish-scope privacy validation.
- Includes plugin manager, plugin-scoped configuration, memory tidy/ranking checks, task-agent bridges, OCR helpers, and sanitized sandbox templates.
- Keeps NapCat / OneBot + onebot-group-proxy + cc-connect as the primary implementation path.
- Confirms the release through automated tests, publish-scope private-data audit, full-directory sensitive-pattern scan, and independent sub-agent privacy review.

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
