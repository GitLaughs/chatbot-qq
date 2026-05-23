# chatbot-qq v0.2.14｜Group reply policy and QQ rendering fixes

This release makes group replies less over-restrictive while fixing another QQ formatting case that should render as an image.

中文关键词：QQ 群机器人、回复策略、公式转图片、LaTeX 分隔符、状态文件自愈、cc-connect QQ。

## Highlights

- Default group policy now answers broad normal requests directly: study, work, career, coding, lifestyle, entertainment, file analysis, and comparison questions.
- Refusal boundaries stay focused on political/sensitive public-affairs content, prompt injection/instruction extraction, credential/privacy extraction, and bot/system damage attempts.
- LaTeX delimiters `\[` `\]` and `\(` `\)` now trigger QQ answer-image rendering and are stripped from text fallback output.
- Invalid `onebot-proxy-state.json` files are quarantined to `.invalid-YYYYMMDDHHMMSS` and replaced with a clean default state.
- Unit tests can import proxy helper functions without reading or mutating runtime proxy state.

## Verify

```powershell
npm test
git diff --check
```

Server-side validation should also pass:

- `node --check scripts/lib/proxy-state.js`
- `node --check scripts/onebot-group-proxy.js`
- `node scripts/test-onebot-proxy-units.js`
- `http://127.0.0.1:3010/healthz` returns HTTP 200 after restarting `onebot-group-proxy`.

## Deployment Notes

- Deploy `scripts/onebot-group-proxy.js`, `scripts/lib/proxy-state.js`, and `scripts/test-onebot-proxy-units.js`, then restart `onebot-group-proxy` and the QQ cc-connect service.
- Update workspace prompt files if operators want the relaxed group policy in existing private group workspaces.
- Real server addresses, QQ IDs, and API keys must stay in ignored local files or operator-provided command arguments.

## Full Changelog

See `CHANGELOG.md`.
