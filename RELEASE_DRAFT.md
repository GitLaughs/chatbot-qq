# chatbot-qq v0.2.13｜Linux answer-image rendering

This release fixes formula-heavy and long QQ group replies on Linux by adding a non-Windows PNG renderer.

中文关键词：QQ 群机器人、公式转图片、长文转图片、Linux 渲染、ImageMagick、cc-connect QQ。

## Highlights

- Adds `scripts/render-qq-card-imagemagick.js` for Linux PNG rendering.
- `onebot-group-proxy` now uses the existing PowerShell renderer on Windows and ImageMagick `convert` on Linux.
- Formula-heavy replies and replies longer than the existing threshold still enter the automatic image path.
- Server deployment docs and env examples now include ImageMagick and Noto CJK font requirements.
- The release was validated with a generated PNG containing Chinese text, long text, and formula syntax.

## Verify

```powershell
$env:GOPROXY="https://goproxy.cn,direct"
npm test
git diff --check
```

Expected:

- `node --check scripts/render-qq-card-imagemagick.js` passes.
- On Linux, `convert` plus a CJK font can generate a non-empty PNG from Chinese text and formula syntax.
- The proxy health endpoint remains healthy after restarting `onebot-group-proxy`.

## Deployment Notes

- Ubuntu/Debian deployments should install `imagemagick` and `fonts-noto-cjk`.
- Deploy by updating `scripts/onebot-group-proxy.js` and `scripts/render-qq-card-imagemagick.js`, then restarting `onebot-group-proxy`.
- Real server addresses, QQ IDs, and API keys must stay in ignored local files or operator-provided command arguments.

## Full Changelog

See `CHANGELOG.md`.
