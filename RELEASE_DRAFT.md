# chatbot-qq v0.2.22｜Windows startup and install guide refresh

This release refreshes the public QQ adapter package with the current Windows helper startup path, the `13110` health port, and clearer beginner install guidance while keeping machine-specific QQ account values configurable.

中文关键词：QQ 群机器人、Linux 部署、NapCat、OneBot、cc-connect、systemd、完整性检查、权限审计。

## Highlights

- Adds a configurable `scripts/run-napcat-local.cmd` helper for Windows NapCat startup.
- Updates README and the Chinese beginner guide with the Windows NapCat/proxy helper flow.
- Moves the public health-port examples and checks from `3010` to `13110`.
- Documents the single-wrapper Windows startup rule without publishing local wrapper paths or private account values.
- Keeps NapCat / OneBot + onebot-group-proxy + cc-connect as the primary implementation path.

## Required Runtime

This release packages deployment templates and helper scripts for the NapCat / OneBot + onebot-group-proxy + cc-connect route. The bundled Linux service and timer units require a systemd host with Node.js, npm, cc-connect, and a local OneBot v11 WebSocket endpoint from NapCat. Image rendering for long replies and formula-heavy replies requires ImageMagick and a CJK font such as Noto CJK on the host.

## Verify

```powershell
npm test
git diff --check
```

Expected:

- Plugin manager checks, plugin tests, OneBot proxy unit checks, memory/review/task canaries, and private-data audit checks pass.
- The private-data audit passes for the publish scope, with only allowed example/runtime findings.

## Attribution

This project is a QQ deployment/configuration layer around
[cc-connect](https://github.com/chenhg5/cc-connect), which is MIT licensed.
See `NOTICE` and `THIRD_PARTY_NOTICES.md`.
